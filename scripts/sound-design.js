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
const { callTool } = require('../src/tools');
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

  const { structuredContent: catalog } = await callTool('list_sounds');
  assert.deepEqual(catalog.sounds.map(({ id }) => id), Object.keys(SOUNDS));
  const sounds = Object.keys(SOUNDS).slice(0, 12);
  const { structuredContent: audition } = await callTool('preview_sounds', { sounds, seed: 48, output_dir: dir });
  assert.equal(audition.markers.length, 12);
  assert(audition.markers.every((m) => Number.isFinite(m.integratedLufs)));
  assert(Math.abs(readWavInfo(audition.path).duration - 37.5) < 0.001);
  console.log('Design sonore : catalogue, vrais signaux de guitare, contrastes de section, stem de textures et nuancier vérifiés.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
