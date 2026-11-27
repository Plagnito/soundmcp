'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { callTool, TOOLS } = require('../src/tools');
const { readMidiMotif } = require('../src/midi-motif');
const { readProject } = require('../src/music-project');
const { musicClock } = require('../src/music-clock');
const { readWave } = require('../src/music-analysis');

const root = path.join(__dirname, '..');
const output = path.join(root, 'tmp');
fs.mkdirSync(output, { recursive: true });
const directory = fs.mkdtempSync(path.join(output, 'production-'));

function vlq(value) {
  const bytes = [value & 127];
  while ((value >>= 7)) bytes.unshift((value & 127) | 128);
  return bytes;
}

function track(events) {
  const bytes = Buffer.from(events.flatMap(([delta, ...data]) => [...vlq(delta), ...data]));
  const header = Buffer.alloc(8);
  header.write('MTrk');
  header.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([header, bytes]);
}

function midiFile(name, tracks, division = 480) {
  const header = Buffer.alloc(14);
  header.write('MThd');
  header.writeUInt32BE(6, 4);
  header.writeUInt16BE(tracks.length > 1 ? 1 : 0, 8);
  header.writeUInt16BE(tracks.length, 10);
  header.writeUInt16BE(division, 12);
  const file = path.join(directory, name);
  fs.writeFileSync(file, Buffer.concat([header, ...tracks]));
  return file;
}

async function checkMidiAndDraft() {
  const end = [0, 0xff, 0x2f, 0];
  const tempo = track([[0, 0xff, 0x51, 3, 0x09, 0x27, 0xc0], [0, 0xff, 0x58, 4, 6, 3, 24, 8], end]);
  const drums = track([[0, 0x99, 35, 100], [100, 35, 0], end]);
  const melody = track([[120, 0x92, 61, 92], [210, 61, 0], [147, 65, 70], [400, 0x82, 65, 0],
    [600, 0x92, 68, 84], [204, 68, 0], end]);
  const file = midiFile('melodie.mid', [tempo, drums, melody]);
  const { motif, source } = readMidiMotif({ path: file });
  assert.deepEqual(source, { track: 3, channel: 3, start_bar: 1, bars: 2, meter: [6, 8], ticks_per_quarter: 480, tempo: 100 });
  assert.deepEqual(motif.map((note) => note.midi), [61, 65, 68]);
  const next = readMidiMotif({ path: file, track: 3, channel: 3, start_bar: 2, bars: 1 });
  assert.deepEqual(next.motif.map((note) => note.midi), [68]);
  assert.throws(() => readMidiMotif({ path: file, track: 2 }), /Aucune note/);
  const poly = track([[0, 0x90, 61, 92], [0, 65, 70], [200, 61, 0], [0, 65, 0], end]);
  assert.throws(() => readMidiMotif({ path: midiFile('accord.mid', [poly]) }), /monophonique/);
  const truncated = path.join(directory, 'tronque.mid');
  fs.writeFileSync(truncated, fs.readFileSync(file).subarray(0, -1));
  assert.throws(() => readMidiMotif({ path: truncated }), /tronqué/);
  assert.throws(() => readMidiMotif({ path: midiFile('smpte.mid', [melody], 0xe728) }), /ticks par noire/);
  assert.deepEqual(readMidiMotif({ path: midiFile('type-0.mid', [melody]) }).motif.map((note) => note.midi), [61, 65, 68]);

  const draft = await callTool('draft_music', {
    brief: '5 secondes de jazz en do majeur, piano et contrebasse',
    midi_motif: { path: file }, variants: 1, seed: 94, palette: 'synth',
    inline_audio: true, output_dir: directory, use_preferences: false,
    instruments: ['cello', 'harp', 'strings'], instrument_roles: { mel: 'cello', arp: 'harp', pad: 'strings' },
  });
  const candidate = draft.structuredContent.candidates[0];
  assert.deepEqual(candidate.midi_source, source);
  const { song } = readProject(candidate.project_path);
  const theme = song.meta.sections.find((section) => section.name === 'Thème');
  assert.equal(theme.bars, 2);
  const onset = (theme.startBar - 1) * 4;
  const written = song.events.filter((event) => event.bus === 'mel' && event.beat >= onset && event.beat < onset + 8);
  for (const [i, note] of motif.entries()) {
    assert.equal(written[i].inst, 'cello');
    assert.equal(written[i].midi, note.midi);
    assert.equal(written[i].beat - onset, note.beat);
    assert.equal(written[i].t - onset, note.beat);
    assert.ok(Math.abs(written[i].dur - note.duration) < 1e-8);
  }
  assert.ok(song.events.some((event) => event.bus === 'pad' && event.inst === 'strings'));
  await assert.rejects(callTool('draft_music', { brief: 'Jazz sans violoncelle', instrument_roles: { mel: 'cello' } }), /exclu/);
  assertAudio(draft, 1);
  fs.renameSync(file, file + '.saved');
  const fallback = await callTool('preview_music', { project_path: candidate.project_path, output_dir: directory });
  assertAudio(fallback, 0);
  console.log('Import MIDI : SMF 0/1, sélection, tempo, 6/8, rythme, hauteur et projet autonome.');
  return candidate.project_path;
}

function assertAudio(response, count) {
  const blocks = response.content.filter((item) => item.type === 'audio');
  assert.equal(blocks.length, count);
  for (const block of blocks) {
    const wav = Buffer.from(block.data, 'base64');
    assert.equal(block.mimeType, 'audio/wav');
    assert.deepEqual(block.annotations.audience, ['user']);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(24), 22050);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.ok(wav.length > 44 && wav.length <= 44 + 2 * 22050 * 8);
  }
}

function mcpRequests(version, requests, language) {
  const initialize = { method: 'initialize',
    params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'tests', version: '1' } } };
  const processResult = spawnSync(process.execPath, [path.join(root, 'src/index.js')], {
    input: [initialize, ...requests].map((request, index) => JSON.stringify({ ...request, id: index + 1, jsonrpc: '2.0' })).join('\n') + '\n',
    env: { ...process.env, SOUNDMCP_LANG: language ?? '' },
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(processResult.status, 0, processResult.stderr);
  return processResult.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line).result);
}

function protocol(version, project_path, language) {
  const [init, listing, comparison] = mcpRequests(version, [
    { method: 'tools/list' },
    { method: 'tools/call', params: { name: 'compare_music_choices',
      arguments: { project_path, criterion: 'accompaniment', inline_audio: true, seed: 11, output_dir: directory } } },
  ], language);
  assert.equal(init.protocolVersion, version);
  assert.equal(listing.tools.length, TOOLS.length);
  assert.ok(!comparison.isError, JSON.stringify(comparison));
  return { comparison, listing };
}

async function checkEnglish(project_path, frenchListing) {
  const [init, { tools }, preview, validation, catalog, englishDraft] = mcpRequests('2025-06-18', [
    { method: 'tools/list' },
    { method: 'tools/call', params: { name: 'preview_music', arguments: { project_path, section: 'Theme', output_dir: directory } } },
    { method: 'tools/call', params: { name: 'finish_music', arguments: { project_path, bit_depth: 8 } } },
    { method: 'tools/call', params: { name: 'list_catalog', arguments: { category: 'sounds' } } },
    { method: 'tools/call', params: { name: 'draft_music', arguments: {
      brief: '10 seconds of jazz with soft piano and upright bass in C major', variants: 1, seed: 7,
      loop: false, use_preferences: false, output_dir: directory,
    } } },
  ], 'en-GB');
  assert.match(init.instructions, /composes instrumental music/);
  const draft = tools.find(({ name }) => name === 'draft_music');
  assert.equal(draft.title, 'Draft instrumental music');
  assert.match(draft.inputSchema.properties.midi_motif.description, /monophonic/);
  assert.match(draft.outputSchema.properties.candidates.description, /Drafts from one brief/);
  const schemaShape = (value) => JSON.stringify(value, (key, field) =>
    typeof field === 'string' && (key === 'title' || key === 'description') ? undefined : field);
  assert.equal(schemaShape(tools), schemaShape(frenchListing.tools));
  assert.equal(validation.isError, true);
  assert.match(validation.content[0].text, /bit_depth must be 16 or 24/);
  assert.equal(catalog.structuredContent.items.find(({ id }) => id === 'flute').label, 'Flute');
  assert.ok(!englishDraft.isError, JSON.stringify(englishDraft));
  assert.match(englishDraft.content[0].text, /1 instrumental draft · jazz/);
  assert.equal(englishDraft.structuredContent.candidates[0].music.key, 'C major');
  assert.ok(!preview.isError, JSON.stringify(preview));
  const original = await callTool('preview_music', { project_path, section: 'Thème', output_dir: directory });
  assert.deepEqual(fs.readFileSync(preview.structuredContent.files[0].path),
    fs.readFileSync(original.structuredContent.files[0].path));

  const englishEnv = { ...process.env, SOUNDMCP_LANG: 'en' };
  const help = spawnSync(process.execPath, [path.join(root, 'src/cli.js'), 'help'], { env: englishEnv, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Commands\n/);
  const invalid = spawnSync(process.execPath, [path.join(root, 'src/cli.js'), 'music', '--no-such-option'],
    { env: englishEnv, encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Unknown option: --no-such-option/);
}

async function checkFamily() {
  const sourceDir = path.join(directory, 'source-effects');
  const targetDir = path.join(directory, 'families');
  const { structuredContent: original } = await callTool('create_sfx', {
    kind: 'footstep', seed: 44, volume: 0.57, attack_ms: 16, output_dir: sourceDir,
  });
  const originalBytes = fs.readFileSync(original.path);
  const args = {
    source_file_id: original.managed_outputs.files[0].file_id, source_output_dir: sourceDir,
    output_dir: targetDir, variants: { count: 6, pitch_spread: 0.7, attack_spread_ms: 8 },
  };
  const { structuredContent: family } = await callTool('create_sfx', args);
  assert.equal(family.managed_outputs.output_dir, targetDir);
  assert.equal(family.managed_outputs.files.length, 6);
  assert.equal(new Set(family.variants.map((take) => take.seed)).size, 6);
  assert.deepEqual(fs.readFileSync(original.path), originalBytes);
  const { structuredContent: repeat } = await callTool('create_sfx', args);
  for (const [i, take] of family.variants.entries()) {
    assert.equal(path.basename(take.path), `0${i + 1}-footstep.wav`);
    assert.ok(Math.abs(take.render_settings.pitch_semitones) <= 0.7);
    assert.ok(Math.abs(take.render_settings.attack_ms - 16) <= 8);
    assert.deepEqual(fs.readFileSync(repeat.variants[i].path), fs.readFileSync(take.path));
  }
  const take = family.variants[2];
  const { structuredContent: replay } = await callTool('create_sfx', {
    source_file_id: family.managed_outputs.files[2].file_id, source_output_dir: targetDir,
  });
  assert.deepEqual(replay.render_settings, take.render_settings);
  assert.deepEqual(fs.readFileSync(replay.path), fs.readFileSync(take.path));
  await assert.rejects(callTool('create_sfx', { ...args, variants: { count: 13 } }), /variants.count/);
  console.log('Effets : 6 prises déterministes, sources intactes et reprise identique par identifiant.');
}

async function checkAdaptive() {
  const sampling_rate = 22050;
  for (const loop of [false, true]) {
    const { structuredContent: source } = await callTool('create_music', {
      style: 'lofi', seed: 81, tempo: 110, key: 'C major', loop, mono: loop, title: `Adaptatif ${loop}`,
      format: 'midi', sampling_rate, save_project: true, palette: 'synth', output_dir: directory,
      arrangement: { sections: [
        { name: 'Introduction', bars: 1, meter: [3, 4], tempo: 92 },
        { name: 'Boucle', bars: 2, meter: [6, 8], tempo: 116 },
        { name: 'Sortie', bars: 1, tempo: 98 },
      ] },
    });
    const args = { project_path: source.project_path, output_dir: directory, stems: false, format: 'wav', sampling_rate,
      adaptive: { loop_region: { start_bar: 2, bars: 2 } }, editions: ['loop'], loop_region: { start_bar: 2, bars: 2 },
      bit_depth: loop ? 16 : 24 };
    const { structuredContent: result } = await callTool('finish_music', args);
    const manifest = JSON.parse(fs.readFileSync(result.adaptive.manifest_path, 'utf8'));
    const clock = musicClock(readProject(source.project_path).song);
    assert.equal(manifest.loop_region.start_sample, Math.round(clock.at(4) * sampling_rate));
    assert.equal(manifest.loop_region.end_sample_exclusive, Math.round(clock.at(12) * sampling_rate));
    assert.equal(manifest.channels, loop ? 1 : 2);
    const wav = {};
    let offset = 0;
    for (const name of ['intro', 'loop', 'outro']) {
      const segment = manifest.segments[name];
      assert.equal(path.basename(segment.file), segment.file);
      assert.equal(segment.start_sample, offset);
      offset = segment.end_sample_exclusive;
      wav[name] = readWave(path.join(path.dirname(result.adaptive.manifest_path), segment.file));
      assert.equal(wav[name].L.length, segment.frames);
    }
    assert.equal(manifest.total_frames, offset);
    for (const channel of ['L', 'R']) {
      assert.equal(wav.intro[channel].at(-1), wav.loop[channel].at(-1));
      assert.equal(wav.loop[channel][0], wav.outro[channel][0]);
    }
    assert.equal(result.files.filter((file) => file.path.endsWith('-loop.wav')).length, 2);
    assert.equal(new Set(result.files.map((file) => file.path)).size, result.files.length);
    await assert.rejects(callTool('finish_music', { ...args, adaptive: { loop_region: { start_bar: 1, bars: 2 } } }), /au moins une mesure/);
    await assert.rejects(callTool('finish_music', { ...args, format: 'midi' }), /nécessite format/);
  }
  console.log('Adaptatif : tempo et mesure variables, raccords PCM exacts, 16/24 bits et éditions indépendantes.');
}

async function checkDevelopment(project_path) {
  const original = fs.readFileSync(project_path);
  const source = readProject(project_path).song;
  const theme = source.meta.sections.find((section) => section.name === 'Thème');
  const region = { start_bar: theme.startBar, bars: 2 };
  const source_excerpt = { project_path, region };
  const options = { brief: 'Calm instrumental development', source_excerpt, duration_seconds: 25,
    variants: 3, seed: 83, output_dir: directory, use_preferences: false };
  const { structuredContent: result } = await callTool('draft_music', options);
  assert.deepEqual(result.source_excerpt, { region, preserve: ['motif', 'instruments', 'harmony'] });
  for (const draft of result.candidates) {
    const song = readProject(draft.project_path).song;
    const developed = song.meta.sections.find(({ name }) => name === 'Thème');
    assert.deepEqual(developed.harmony.slice(0, 2), theme.harmony.slice(0, 2));
    assert.deepEqual(developed.motif.map(({ beat, midi }) => [beat, midi]), theme.motif.map(({ beat, midi }) => [beat, midi]));
    const firstMeasure = (developed.startBar - 1) * 4;
    const lead = song.events.filter((event) => event.bus === 'mel' && event.beat >= firstMeasure && event.beat < firstMeasure + 8);
    assert.deepEqual(lead.map(({ inst, midi }) => [inst, midi]), developed.motif.map(({ midi }) => ['cello', midi]));
  }
  assert.deepEqual(fs.readFileSync(project_path), original);
  await assert.rejects(callTool('draft_music', { ...options, midi_motif: { path: 'unused.mid' } }), /source_excerpt/);
  await assert.rejects(callTool('draft_music', { ...options, source_excerpt: { ...source_excerpt, preserve: ['motif', 'motif'] } }), /preserve/);
  console.log('Développement : motif, timbres et accords repris dans trois projets, source intacte.');
}

async function checkLoopChoices() {
  const { structuredContent: source } = await callTool('create_music', {
    style: 'ambient', key: 'D lydian', seed: 87, format: 'midi', save_project: true, loop: false, output_dir: directory,
    arrangement: { sections: [{ name: 'Main', bars: 10, tempo: 120, meter: [4, 4], progression: ['Dmaj7', 'Bm7'] }] },
  });
  const original = fs.readFileSync(source.project_path);
  const input = { project_path: source.project_path, criterion: 'loop', section: 'Main', max_seconds: 18, output_dir: directory,
    loop_options: { count: 3, min_bars: 3, crossfade_ms: 425 }, inline_audio: true };
  const comparison = await callTool('compare_music_choices', input);
  const { files } = comparison.structuredContent;
  assert.equal(files.length, 3);
  assertAudio(comparison, 3);
  assert.deepEqual(files.map(({ label }) => label), ['A', 'B', 'C']);
  assert.deepEqual(files.map(({ metrics }) => metrics.cost), files.map(({ metrics }) => metrics.cost).sort((a, b) => a - b));
  for (const take of files) {
    const audio = readWave(take.path);
    const middle = audio.L.length / 2;
    assert.equal(middle, Math.round(take.join_seconds * audio.sr));
    for (const channel of [audio.L, audio.R]) assert.deepEqual(channel.subarray(0, middle), channel.subarray(middle));
  }
  const { structuredContent: finished } = await callTool('finish_music', {
    project_path: source.project_path, format: 'wav', stems: false, sampling_rate: 22050, output_dir: directory,
    adaptive: files[0].adaptive,
  });
  const { start_bar, bars } = files[0].adaptive.loop_region;
  assert.equal(finished.adaptive.loop_region.start_bar, start_bar);
  assert.equal(finished.adaptive.loop_region.bars, bars);
  assert.equal(finished.adaptive.crossfade_frames, Math.round(0.425 * 22050));
  assert.deepEqual(fs.readFileSync(source.project_path), original);
  await assert.rejects(callTool('compare_music_choices', { ...input, seed: 2 }), /loop/);
  await assert.rejects(callTool('compare_music_choices', { ...input, section: undefined, region: { start_bar: 2, bars: 1 } }), /région|plage/);
  console.log('Raccords : classement, deux tours identiques, audio MCP et export du raccord choisi.');
}

async function main() {
  const project = await checkMidiAndDraft();
  const modern = protocol('2025-06-18', project);
  assertAudio(modern.comparison, 2);
  assert.ok(modern.listing.tools.find((tool) => tool.name === 'draft_music').inputSchema.properties.inline_audio);
  const legacy = protocol('2025-03-26', project, 'en');
  assertAudio(legacy.comparison, 0);
  assert.equal(legacy.listing.tools.find((tool) => tool.name === 'draft_music').inputSchema.properties.inline_audio, undefined);
  console.log('Préécoutes : WAV MCP mono plafonnés et repli vérifié pour les anciens clients.');
  await checkEnglish(project, modern.listing);
  console.log('Langue : schémas MCP identiques, textes anglais et lecture d’un projet français vérifiés.');
  await checkFamily();
  await checkAdaptive();
  await checkDevelopment(project);
  await checkLoopChoices();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
