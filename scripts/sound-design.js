'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createSong } = require('../src/composer');
const { writeMeasure } = require('../src/score-notes');
const { renderSong, readWavInfo } = require('../src/dsp');
const { renderSamples, loadBank } = require('../src/sample-bank');
const { renderMidiBuffer } = require('../src/midi');
const { SOUNDS, ELECTRIC } = require('../src/texture-voices');
const { TOOLS, callTool } = require('../src/tools');
const { readProject } = require('../src/music-project');
const { interpretBrief } = require('../src/arranger');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soundmcp-sound-design-'));
  const assets = loadBank().instruments.get('electric-guitar');
  assert.equal(assets.length, 32);
  const guitars = ELECTRIC.map((inst) => {
    const L = new Float32Array(12000), R = new Float32Array(L.length);
    const ev = { inst, vel: 0.7, midi: 57, pan: 0, timbre: 0.64 };
    assert.equal(renderSamples(L, R, 0, ev, 22050, 0.5, 0, 2), false);
    assert(renderSamples(L, R, 0, ev, 22050, 0.5, 0, 3));
    return L;
  });
  assert.notDeepEqual(guitars[0], guitars[1]);
  assert.notDeepEqual(guitars[0], guitars[2]);

  const args = { style: 'mystery', key: 'A minor', tempo: 120, seed: 19, loop: false, palette: 'studio', sr: 22050 };
  const sections = [
    { name: 'Sec', bars: 2, parts: ['mel', 'pad'], color: 'radio', instruments: { mel: 'electric-clean', pad: 'granular-pad' },
      textures: [{ sound: 'tape-air', duration: 6, level: 0.35 }] },
    { name: 'Large', bars: 2, parts: ['mel', 'pad', 'bass'], color: 'wide', instruments: { mel: 'glass-keys', pad: 'electric-swell', bass: 'sub-pulse' },
      textures: [{ sound: 'dark-impact', duration: 0.6, level: 0.38 }] },
  ];
  const song = createSong({ ...args, arrangement: { sections } });
  assert.equal(song.bankVersion, 3);
  assert(song.meta.sections.every((s) => s.parts.includes('texture')));
  const mixed = renderSong(song);
  const colorless = { ...song, meta: { ...song.meta, sections: song.meta.sections.map((s) => ({ ...s, color: 'natural' })) } };
  const natural = renderSong(colorless);
  const stereo = (audio) => audio.L.slice(12000, 75000).reduce((total, l, i) => total + (l - audio.R[12000 + i]) ** 2, 0);
  assert(stereo(mixed) < 0.02 * stereo(natural), 'Radio isole peu le centre');
  assert(mixed.metrics.peakDbfs < 0);
  assert.equal(new Set(song.events.filter((e) => e.bus === 'texture').map((e) => e.inst)).size, 2);
  assert(!renderMidiBuffer(song).includes(Buffer.from('tape-air')));
  const edited = writeMeasure(song, { bar: 4, part: 'texture', instrument: 'iron-scrape', notes: [{ beat: 2, duration: 1, timbre: 0.83, pan: -0.48 }] }, 22);
  const event = edited.events.find((e) => e.inst === 'iron-scrape');
  assert.equal(event.timbre, 0.83);
  assert.equal(event.pan, -0.48);
  assert.throws(() => createSong({ ...args, arrangement: { sections: [{ bars: 1, color: 'invalid' }] } }), /couleur/);
  assert.throws(() => createSong({ ...args, arrangement: { sections: [{ bars: 1, textures: [{ sound: 'vocal' }] }] } }), /texture/);

  const { structuredContent: automatic } = await callTool('draft_music', { brief: '24 secondes de design sonore, textures évolutives, guitares claires.',
    style: 'mystery', tempo: 100, seed: 17, variants: 1, output_dir: dir });
  assert.equal(interpretBrief('Clean electric guitar and evolving textures, 28 seconds.').soundDesign, 'evolving');
  assert.deepEqual(automatic.plan.instruments, ['electric-clean']);
  const project = automatic.candidates[0].project_path;
  const source = fs.readFileSync(project);
  const original = readProject(project).song;
  const { structuredContent: retake } = await callTool('edit_music', { project_path: project, format: 'midi', output_dir: dir,
    edits: [{ type: 'replace_section', section: 1, replacement: { color: 'warm', textures: [{ sound: 'iron-scrape', duration: 3 }] } }] });
  const projectAfter = retake.versions[0].files.find((f) => f.format === 'project').path;
  assert.deepEqual(fs.readFileSync(project), source);
  const repaired = readProject(projectAfter).song;
  assert.equal(repaired.meta.sections[0].color, 'warm');
  assert.equal(repaired.meta.sections[0].textures[0].sound, 'iron-scrape');
  const cutoff = rebuilt => rebuilt.meta.sections[0].bars * 4;
  assert.deepEqual(repaired.events.filter((e) => e.beat >= cutoff(repaired)), original.events.filter((e) => e.beat >= cutoff(original)));

  const { structuredContent: catalog } = await callTool('list_catalog', { category: 'sounds' });
  const { structuredContent: oldCatalog } = await callTool('list_sounds');
  assert.deepEqual(oldCatalog.sounds, catalog.items);
  for (const [category, id] of [['music', 'lofi'], ['sfx', 'jump'], ['ambiences', 'rain']]) {
    const { structuredContent: listing } = await callTool('list_catalog', { category });
    assert(listing.items.some((item) => item.id === id));
  }
  const added = ['piano', 'upright', 'strings', 'flute', 'clarinet', 'brass', 'acoustic-guitar'];
  const catalogIds = catalog.items.map(({ id }) => id);
  assert.deepEqual(catalogIds, [...Object.keys(SOUNDS), ...added]);
  assert(catalog.items.filter(({ id }) => added.includes(id)).every(({ source }) => source === 'prise instrumentale'));
  const schema = (name) => TOOLS.find((tool) => tool.name === name).inputSchema;
  assert.equal(TOOLS.length, 18);
  assert(!TOOLS.some(({ name }) => ['preview_sounds', 'compare_builds', 'list_sounds', 'list_styles', 'mix_music'].includes(name)));
  assert.deepEqual(schema('play_sound').properties.sounds.items.anyOf[0].enum, catalogIds);
  assert.deepEqual(schema('play_sound').properties.instrument.enum, catalogIds);
  assert.deepEqual(schema('compare_sounds').properties.sounds.items.properties.instrument.enum, catalogIds);

  const sounds = [...Object.keys(SOUNDS).slice(0, 5), ...added];
  const { structuredContent: audition } = await callTool('play_sound', { sounds, seed: 48, output_dir: dir });
  assert.deepEqual(audition.markers.map(({ sound }) => sound), sounds);
  assert(audition.markers.every((m) => Number.isFinite(m.integratedLufs)));
  assert(Math.abs(readWavInfo(audition.path).duration - 37.5) < 0.001);

  const notes = [{ at: 0.08, pitch: 'B3', duration: 0.49 }, { at: 0.55, pitch: 'D4', duration: 0.45, articulation: 'legato' }];
  const phrase = { notes, seed: 19, output_dir: dir, sampling_rate: 22050, mono: true };
  await assert.rejects(callTool('play_sound', { sounds: ['clarinet'], ...phrase }), /phrase personnalisée/);
  const { structuredContent: clarinet } = await callTool('play_sound', { instrument: 'clarinet', ...phrase });
  assert.equal(clarinet.sound, 'clarinet');
  assert.equal(readWavInfo(clarinet.path).channels, 1);
  assert(Number.isFinite(clarinet.audio.integratedLufs));
  await assert.rejects(callTool('play_sound', { instrument: 'clarinet', patch_path: 'patch.json', ...phrase }), /un seul/);
  const { structuredContent: comparison } = await callTool('compare_sounds', {
    sounds: [{ instrument: 'clarinet' }, { instrument: 'flute' }], ...phrase, blind: true,
  });
  assert.deepEqual(new Set(JSON.parse(fs.readFileSync(comparison.reveal_path, 'utf8')).map(({ id }) => id)), new Set(['clarinet', 'flute']));
  assert(Math.abs(comparison.files[0].integratedLufs - comparison.files[1].integratedLufs) < 0.1);

  const output_dir = path.join(dir, 'managed');
  const manage = async (action, args) => (await callTool('manage_outputs', { action, output_dir, ...args })).structuredContent;
  assert.deepEqual((await manage('list')).files, []);
  assert(!fs.existsSync(output_dir));
  const { structuredContent: effect } = await callTool('create_sfx', { kind: 'coin', seed: 7, output_dir });
  const { file_id, path: output } = effect.managed_outputs.files[0];
  const bytes = fs.readFileSync(output);
  fs.writeFileSync(path.join(output_dir, 'personnel.wav'), bytes);
  assert.deepEqual((await manage('list')).files.map((file) => file.file_id), [file_id]);
  const archived = await manage('archive', { file_id });
  assert(!fs.existsSync(output));
  assert.deepEqual(fs.readFileSync(archived.archive_path), bytes);
  assert.equal((await manage('archive', { file_id })).state, 'archived');
  assert.equal((await manage('list')).files[0].state, 'archived');
  fs.writeFileSync(output, 'Fichier occupant le chemin d’origine');
  await assert.rejects(manage('restore', { file_id }), /autre fichier/);
  assert.equal(fs.readFileSync(output, 'utf8'), 'Fichier occupant le chemin d’origine');
  fs.renameSync(output, path.join(output_dir, 'occupant.wav'));
  await manage('restore', { file_id });
  assert.deepEqual(fs.readFileSync(output), bytes);
  assert.equal((await manage('restore', { file_id })).state, 'active');
  await assert.rejects(manage('archive', { file_id: '../personnel.wav' }), /file_id/);
  console.log('Design sonore : catalogue, vrais signaux de guitare, contrastes de section, stem de textures et nuancier vérifiés.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
