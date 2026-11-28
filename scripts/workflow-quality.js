'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const repo = path.join(__dirname, '..');
const temp = path.join(repo, 'tmp');
fs.mkdirSync(temp, { recursive: true });
const output_dir = fs.mkdtempSync(path.join(temp, 'workflow-quality-'));
const server = path.join(repo, 'src', 'index.js');
const protocolVersion = '2025-06-18';
const observations = [];

function rpc(method, params = {}, profile = 'studio', language = 'fr', protocol = protocolVersion) {
  const messages = [
    { method: 'initialize', params: { protocolVersion: protocol, capabilities: {}, clientInfo: { name: 'workflow-test', version: '1' } } },
    { method, params },
  ];
  const { stdout, stderr, status } = spawnSync(process.execPath, [server], {
    env: { ...process.env, SOUNDMCP_LANG: language, SOUNDMCP_TOOLSET: profile },
    input: messages.map((message, i) => JSON.stringify({ jsonrpc: '2.0', id: i + 1, ...message })).join('\n') + '\n',
    encoding: 'utf8', maxBuffer: 25 * 1024 * 1024,
  });
  assert.equal(status, 0, stderr);
  const [hello, response] = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(hello.id, 1);
  assert.equal(hello.result.protocolVersion, protocol);
  assert.equal(response.id, 2);
  return response;
}

function call(name, args, profile = 'studio', language = 'fr', save = true) {
  const input = { output_dir, ...args };
  const { result, error } = rpc('tools/call', { name, arguments: input }, profile, language);
  assert(!error && result && !result.isError, JSON.stringify(error ?? result));
  if (save) observations.push({ profile, language, name, input, output: result.structuredContent });
  return result;
}

const data = (name, args, profile, language) => call(name, args, profile, language).structuredContent;
const inventory = (action, args) => data('manage_outputs', { action, ...args });

function checkToolsets() {
  const counts = { full: 18, studio: 18, music: 11, sound: 9, audition: 17, patches: 17, presets: 17, compact: 15 };
  // Treat edits to the assessed default catalog as deliberate changes to its public contract.
  const assessed = {
    fr: 'b7d3968a9a5164475114ff66e53c51a42781a3b4a798d2839846910f8e41981d',
    en: '57f54f8fe324d9ba503342b6511af742d9fd81d570bd18186b00086a05daa5f9',
  };
  for (const language of ['fr', 'en']) {
    for (const [profile, count] of Object.entries(counts)) {
      const { result } = rpc('tools/list', {}, profile, language);
      assert.equal(result.tools.length, count, profile);
      assert.equal(new Set(result.tools.map(({ name }) => name)).size, count);
      if (profile === 'full') {
        assert.equal(createHash('sha256').update(JSON.stringify(result)).digest('hex'), assessed[language],
          `The assessed default ${language} catalog changed. Run TDQS before updating its fingerprint.`);
      }
    }
    const { result } = rpc('tools/list', {}, 'compact', language, '2024-11-05');
    assert(result.tools.every((tool) => !Object.hasOwn(tool, 'outputSchema')));
  }
  assert.equal(data('audition_sound', { mode: 'phrase', instrument: 'clarinet' }, 'compact').sound, 'clarinet');
  const tour = data('audition_sound', { mode: 'catalog', sounds: ['flute', 'clarinet'] }, 'compact');
  assert.deepEqual(tour.markers.map(({ sound }) => sound), ['flute', 'clarinet']);
  const choices = data('audition_sound', { mode: 'comparison', sounds: [{ instrument: 'clarinet' }, { instrument: 'flute' }],
    notes: [{ at: 0, pitch: 'A4', duration: 0.8 }], blind: true, seed: 7 }, 'compact');
  assert.deepEqual(choices.files.map(({ label }) => label), ['A', 'B']);
  assert(fs.existsSync(choices.reveal_path));
  assert.equal(call('play_sound', { instrument: 'clarinet' }, 'compact', 'fr', false).structuredContent.sound, 'clarinet');
  const designed = data('design_timbre', { mode: 'create', brief: 'son doux et bref', seed: 3 }, 'compact');
  const varied = data('design_timbre', { mode: 'vary', patch_path: designed.patch_path, directions: ['brighter'] }, 'compact');
  assert.equal(varied.sounds.length, 1);
  const background = data('render_preset', { mode: 'ambience', kind: 'rain', duration_seconds: 5, seed: 2 }, 'compact', 'en');
  assert.equal(background.durationSeconds, 5);
  assert.equal(background.loop, true);

  const bad = rpc('tools/call', { name: 'audition_sound', arguments: {
    mode: 'catalog', sounds: ['flute'], notes: [{ at: 0, pitch: 'C4' }],
  } }, 'compact', 'en').result;
  assert(bad.isError);
  assert.equal(bad._meta['soundmcp/error'].code, 'INCOMPATIBLE_PARAMETERS');
  assert.match(bad.content[0].text, /Choose the parameters/);
  const missing = rpc('tools/call', { name: 'analyze_music', arguments: { wav_path: path.join(output_dir, 'missing.wav') } }).result;
  assert.equal(missing._meta['soundmcp/error'].code, 'FILE_NOT_FOUND');
}

function checkReplay() {
  const args = { mode: 'effect', kind: 'coin', seed: 22, on_conflict: 'reuse' };
  const first = data('render_preset', args, 'compact');
  const again = data('render_preset', args, 'compact');
  assert.equal(again.path, first.path);
  assert.equal(again.managed_outputs.render_id, first.managed_outputs.render_id);
  const quieter = data('render_preset', { ...args, source_file_id: first.managed_outputs.files[0].file_id, kind: undefined,
    volume: 0.6, on_conflict: 'unique' }, 'compact');
  assert.notEqual(quieter.path, first.path);
  assert.equal(inventory('get', { render_id: quieter.managed_outputs.render_id }).source.render_id, first.managed_outputs.render_id);
  assert(inventory('get', { render_id: first.managed_outputs.render_id }).related_render_ids.includes(quieter.managed_outputs.render_id));
  const take = data('render_preset', { ...args, on_conflict: 'unique' }, 'compact');
  assert.notEqual(take.path, first.path);
  fs.appendFileSync(first.path, Buffer.from([0]));
  const replaced = data('render_preset', args, 'compact');
  assert.notEqual(replaced.managed_outputs.render_id, first.managed_outputs.render_id);
  assert(fs.existsSync(first.path));
}

function checkDelivery() {
  const source = data('create_music', { style: 'lofi', seed: 12, duration_seconds: 24, palette: 'synth',
    format: 'midi', save_project: true, on_conflict: 'reuse' });
  const same = data('create_music', { style: 'lofi', seed: 12, duration_seconds: 24, palette: 'synth',
    format: 'midi', save_project: true, on_conflict: 'reuse' });
  assert.equal(source.managed_outputs.render_id, same.managed_outputs.render_id);
  const score = data('inspect_score', { project_path: source.project_path, start_bar: 2, bars: 1, part: 'mel' });
  assert(score.measures[0].chords.length);
  const edit = data('edit_music', { project_path: source.project_path, edits: [{
    type: 'write_measure', bar: 2, part: 'mel', notes: [{ beat: 0, pitch: 'C4', duration: 1 }, { beat: 1, pitch: 'E4', duration: 1 }],
  }], format: 'midi' });
  assert.notEqual(edit.versions[0].project_path, source.project_path);
  const preview = data('preview_music', { project_path: edit.versions[0].project_path, region: { start_bar: 2, bars: 1 } });
  assert(fs.statSync(preview.files[0].path).size > 44);
  const comparison = data('compare_music_choices', { project_path: source.project_path, criterion: 'loop' });
  const final = call('finish_music', { project_path: source.project_path, adaptive: comparison.files[0].adaptive,
    sampling_rate: 22050, stems: false });
  const { adaptive, managed_outputs, report_path } = final.structuredContent;
  const checked = JSON.parse(fs.readFileSync(adaptive.manifest_path, 'utf8'));
  const render_id = managed_outputs.render_id;
  const initial = inventory('get', { render_id });
  assert.equal(initial.state, 'active');
  assert.equal(initial.source.project_path, source.project_path);
  assert(inventory('get', { render_id: source.managed_outputs.render_id }).related_render_ids.includes(render_id));
  for (const type of ['project', 'midi', 'wav', 'json']) {
    const page = inventory('list', { render_id, file_type: type, limit: 1 });
    assert(page.total >= 1);
    assert.equal(page.files[0].file_type, type);
    if (page.next_offset !== null) assert.notEqual(
      inventory('list', { render_id, file_type: type, limit: 1, offset: page.next_offset }).files[0].file_id, page.files[0].file_id,
    );
  }

  const link = final.content.find((item) => item.type === 'resource_link' && item.name === path.basename(adaptive.manifest_path));
  assert(link);
  assert.equal(rpc('resources/templates/list').result.resourceTemplates.length, 1);
  const resource = () => JSON.parse(rpc('resources/read', { uri: link.uri }).result.contents[0].text);
  assert.deepEqual(resource(), checked);
  const guided = rpc('prompts/get', { name: 'adaptive_loop', arguments: { project_path: source.project_path } }).result;
  assert.match(guided.messages[0].content.text, /compare_music_choices/);
  const blind = rpc('prompts/get', { name: 'blind_timbres', arguments: { instruments: 'clarinet, flute' } }, 'compact', 'en').result;
  assert.match(blind.messages[0].content.text, /audition_sound.+comparison/);
  assert.deepEqual(rpc('prompts/list', {}, 'music').result.prompts.map(({ name }) => name), ['adaptive_loop']);

  // Read the old flat archive layout and finish an interrupted grouped move.
  const manifest = initial.files.find(({ path: file }) => file === adaptive.manifest_path);
  const firstMove = inventory('archive', { file_id: manifest.file_id });
  const library = path.join(output_dir, '.soundmcp-outputs');
  const legacy = path.join(library, 'archive', manifest.file_id.replace(':', '-') + '.json');
  fs.renameSync(firstMove.archive_path, legacy);
  assert.equal(inventory('get', { file_id: manifest.file_id }).current_path, legacy);
  const staleLock = path.join(library, `${render_id}.lock`);
  fs.mkdirSync(staleLock);
  fs.writeFileSync(path.join(staleLock, `2147483647-${randomUUID()}`), '');
  const archived = inventory('archive', { render_id });
  assert.equal(archived.state, 'archived');
  assert(!fs.existsSync(legacy));
  assert(archived.files.every(({ path: original, current_path }) => !fs.existsSync(original) && fs.existsSync(current_path)));
  const archivedManifest = archived.files.find(({ file_id }) => file_id === manifest.file_id);
  for (const segment of Object.values(checked.segments)) {
    assert(fs.existsSync(path.join(path.dirname(archivedManifest.current_path), segment.file)));
  }
  assert.deepEqual(resource(), checked);
  assert.deepEqual(inventory('archive', { render_id }), archived);

  fs.writeFileSync(report_path, 'occupied');
  const conflict = rpc('tools/call', { name: 'manage_outputs', arguments: { action: 'restore', render_id, output_dir } }).result;
  assert.equal(conflict._meta['soundmcp/error'].code, 'DESTINATION_OCCUPIED');
  assert.equal(fs.readFileSync(report_path, 'utf8'), 'occupied');
  assert.deepEqual(inventory('get', { render_id }).files, archived.files);
  fs.unlinkSync(report_path);
  const resumed = archived.files.find(({ file_type }) => file_type === 'wav');
  fs.renameSync(resumed.current_path, resumed.path);
  assert.equal(inventory('get', { render_id }).state, 'partial');
  assert.equal(inventory('restore', { render_id }).state, 'active');
  assert.equal(inventory('restore', { render_id }).state, 'active');
}

checkToolsets();
checkReplay();
checkDelivery();
if (process.env.SOUNDMCP_SCHEMA_OBSERVATIONS) {
  fs.writeFileSync(process.env.SOUNDMCP_SCHEMA_OBSERVATIONS, JSON.stringify(observations) + '\n');
}
console.log('Workflow quality: toolsets, equivalent legacy calls, render reuse, linked resources, archive recovery, and prompts passed.');
