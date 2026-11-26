'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createSong } = require('../src/composer');
const { renderEventsInto, renderSong, INSTRUMENTS } = require('../src/dsp');
const { renderMidiBuffer } = require('../src/midi');
const { loadBank, loadExtensionBank, loadCinematicBank, renderSamples } = require('../src/sample-bank');
const { arrange, interpretBrief } = require('../src/arranger');
const { readProject, editSong, endingVariations } = require('../src/music-project');
const { chordFromSymbol } = require('../src/theory');
const { callTool } = require('../src/tools');

function sample(inst, vel, take, midi, articulation) {
  const L = new Float32Array(12000), R = new Float32Array(L.length);
  const ev = { inst, vel, pan: 0, articulation, ...(midi === undefined ? { drum: inst, kit: 'acoustic' } : { midi }) };
  assert(renderSamples(L, R, 0, ev, 32000, 0.8, take));
  return L;
}

function checkSampleLegato() {
  const sr = 22050;
  const note = { inst: 'clarinet', bus: 'mel', pan: 0, t: 0.1, dur: 0.34, midi: 59, vel: 0.66 };
  const next = { ...note, t: 0.43, dur: 0.49, midi: 62, vel: 0.72, articulation: 'legato' };
  const render = (notes, legato) => {
    const L = new Float32Array(sr * 2), R = new Float32Array(L.length);
    if (legato) renderEventsInto(notes, L, R, sr, 1, 'studio', undefined, 3);
    else for (const ev of notes) {
      const duration = ev.dur * (ev.articulation === 'staccato' ? 0.57 : 1);
      assert(renderSamples(L, R, Math.round(ev.t * sr), ev, sr, duration, 0));
    }
    return L;
  };
  const pitchLevel = (audio, midi) => {
    const length = Math.round(0.04 * sr), start = Math.round((next.t + 0.065) * sr);
    const angle = 2 * Math.PI * 440 * 2 ** ((midi - 69) / 12) / sr;
    let real = 0, imaginary = 0;
    for (let i = 0; i < length; i++) {
      const value = audio[start + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / length));
      real += value * Math.cos(angle * i);
      imaginary += value * Math.sin(angle * i);
    }
    return Math.hypot(real, imaginary);
  };
  for (const inst of ['clarinet', 'flute', 'cello']) {
    const notes = [{ ...note, inst }, { ...next, inst }];
    const before = render(notes, false), after = render(notes, true);
    const separation = (audio) => pitchLevel(audio, next.midi) / pitchLevel(audio, note.midi);
    assert(separation(after) > 2 * separation(before), inst);
    assert.deepEqual(after.subarray(0, Math.round(next.t * sr)), before.subarray(0, Math.round(next.t * sr)));
  }
  for (const notes of [[note, { ...next, midi: note.midi }], [note, { ...next, t: 0.70 }],
    [{ ...note, dur: 0.57, articulation: 'staccato' }, next], [note, next, { ...next, midi: 64 }],
    [note, { ...next, bus: 'counter' }]]) {
    assert.deepEqual(render(notes, true), render(notes, false));
  }
}

async function main() {
  checkSampleLegato();
  const bank = path.join(__dirname, '..', 'banks', 'studio');
  const manifest = JSON.parse(fs.readFileSync(path.join(bank, 'manifest.json'), 'utf8'));
  const actual = createHash('sha256').update(loadBank().pcm).digest('hex');
  assert.equal(actual, manifest.sha256);
  assert.notDeepEqual(sample('snare', 0.6, 0), sample('snare', 0.6, 1));
  const pianoSoft = sample('piano', 0.29, 0, 60);
  const pianoStrong = sample('piano', 0.84, 0, 60);
  const normalize = (audio) => {
    const peak = audio.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
    return audio.map((v) => v / peak);
  };
  assert.notDeepEqual(normalize(pianoSoft), normalize(pianoStrong));

  const extension = loadExtensionBank();
  assert.equal([...extension.instruments.values()].flat().length, 150);
  assert.deepEqual([...new Set(extension.instruments.get('vibraphone').map(({ velocity }) => velocity))].sort(), [0.29, 0.56, 0.88]);
  assert.notDeepEqual(normalize(sample('vibraphone', 0.29, 0, 60)), normalize(sample('vibraphone', 0.88, 0, 60)));
  const bowed = sample('cello', 0.34, 0, 50, 'legato');
  const pizzicato = sample('cello', 0.34, 0, 50, 'pizzicato');
  assert.notDeepEqual(bowed, pizzicato);
  assert.notDeepEqual(pizzicato, sample('cello', 0.34, 0, 50, 'staccato'));
  assert.notDeepEqual(pizzicato, sample('cello', 0.34, 1, 50, 'pizzicato'));
  const chamberPlan = interpretBrief('Musique chaleureuse, harpe, vibraphone et violoncelles spiccato, sans batterie.');
  const chamber = arrange(chamberPlan, 901, 0, 'Harpe, vibraphone et violoncelles');
  for (const inst of ['harp', 'vibraphone', 'cello']) {
    assert(chamber.events.some((ev) => ev.inst === inst));
    assert.equal(typeof INSTRUMENTS[inst].fn, 'function');
  }
  assert(chamber.events.filter((ev) => ev.inst === 'cello').every((ev) => ev.articulation === 'staccato'));

  const cinematic = loadCinematicBank();
  assert.equal([...cinematic.instruments.values()].flat().length, 98);
  assert.notDeepEqual(sample('trumpet', .80, 0, 70), sample('trumpet', .80, 0, 70, 'staccato'));
  assert.notDeepEqual(sample('timpani', .80, 0, 43), sample('timpani', .80, 0, 47));
  assert.deepEqual(sample('gong', .80, 0, 36), sample('gong', .80, 0, 55));
  assert.notDeepEqual(sample('concert-snare', .86, 0, 48), sample('concert-snare', .86, 1, 48));
  for (const seconds of [.65, 1.40]) {
    const rate = 22050, block = Math.round(rate * .04);
    const L = new Float32Array(Math.round(rate * 2)), R = new Float32Array(L.length);
    assert(renderSamples(L, R, 0, { inst: 'cymbal-swell', vel: .80, pan: 0 }, rate, seconds, 0));
    let strongest = 0, peak = 0;
    for (let start = 0; start + block <= L.length; start += block) {
      let power = 0;
      for (let i = start; i < start + block; i++) power += L[i] ** 2 + R[i] ** 2;
      if (power > peak) { strongest = (start + block / 2) / rate; peak = power; }
    }
    assert(Math.abs(strongest - seconds) < .13);
  }
  const rhythm = createSong({ style: 'epic', key: 'E minor', seed: 3, arrangement: { sections: [
    { name: 'Marche', bars: 1, meter: [7, 8], progression: ['G/B'], orchestral_percussion: 'drive' },
    { name: 'Pause', bars: 1, orchestral_percussion: 'none' },
  ] } });
  const timps = rhythm.events.filter((note) => note.inst === 'timpani');
  assert.deepEqual(timps.map(({ beat }) => Math.round(beat * 7 / 4)), [0, 2, 4]);
  assert.equal(timps[0].midi % 12, 11);
  assert(rhythm.events.every((note) => note.bus !== 'drum'));
  assert(renderMidiBuffer(rhythm).includes(Buffer.from('Timpani')));
  assert(editSong(rhythm, [{ type: 'replace_section', section: 1, replacement: { orchestral_percussion: 'none' } }])
    .events.every((note) => !note.orchestral));
  const mutedRhythm = editSong(rhythm, [{ type: 'mute', section: 1, part: 'texture' },
    { type: 'replace_section', section: 1, replacement: { name: 'Réécriture' } }]);
  assert(mutedRhythm.events.every((note) => !note.orchestral));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soundmcp-studio-'));
  const audition = (await callTool('preview_sounds', { sounds: ['harp', 'vibraphone', 'cello'], seed: 901, output_dir: dir })).structuredContent;
  assert(audition.markers.every(({ integratedLufs }) => Number.isFinite(integratedLufs)));
  assert.equal(fs.readFileSync(audition.path, { encoding: 'ascii' }).slice(0, 4), 'RIFF');
  const sections = [
    { name: 'Départ', bars: 2, progression: [[{ beat: 0, chord: 'Dm9' }, { beat: 2, chord: 'G13' }], 'Cmaj7/E'] },
    { name: 'Pont', bars: 2, key: 'F minor', progression: [4, 1], motif: [{ beat: 0, degree: 1, duration: 2 }] },
    { name: 'Fin', bars: 1, progression: [1], parts: ['mel', 'bass', 'arp'] },
  ];
  const args = { style: 'jazz', title: 'Essai Studio', key: 'C major', tempo: 120, seed: 901, loop: false, arrangement: { sections } };
  const score = createSong({ ...args, sr: 22050 });
  assert.deepEqual(chordFromSymbol('Dm9').pitchClasses, [2, 5, 9, 0, 4]);
  assert.deepEqual(chordFromSymbol('G13').pitchClasses, [7, 11, 2, 5, 9, 4]);
  assert.equal(chordFromSymbol('Cmaj7/E').bassPc, 4);
  const bass = score.events.filter((event) => event.bus === 'bass');
  assert.deepEqual(bass.filter((e) => [0, 2, 4].includes(e.beat)).map((e) => e.midi % 12), [2, 7, 4]);
  assert.equal(score.events.find((e) => e.bus === 'mel' && e.beat === 8).midi % 12, 5);
  assert.equal(score.meta.sections[0].harmony[0][1].beat, 2);
  assert(score.events.some((e) => e.articulation === 'ghost'));
  assert.throws(() => createSong({ ...args, arrangement: { sections: [{ bars: 1, progression: ['Q13'] }] } }), /Accord/);
  assert.throws(() => createSong({ ...args, arrangement: { sections: [{ bars: 1, progression: [[{ beat: 1, chord: 'Dm9' }]] }] } }), /temps 0/);

  const synthesized = renderSong(score);
  const studio = renderSong({ ...score, palette: 'studio' });
  assert.equal(synthesized.samples, studio.samples);
  assert(studio.metrics.stereoCorrelation > 0.3);
  assert.notDeepEqual(synthesized.L, studio.L);
  assert.deepEqual(renderMidiBuffer(score), renderMidiBuffer({ ...score, palette: 'studio' }));

  const packet = (await callTool('create_music', { ...args, output_dir: dir, sampling_rate: 22050, bit_depth: 24,
    save_project: true, format: 'both', editions: ['loop', 'calm', 'intense'], loop_region: { start_bar: 2, bars: 2 } })).structuredContent;
  assert.equal(packet.meta.palette, 'studio');
  assert.deepEqual(packet.editions.map(({ samples, startBar, endBar }) => [samples, startBar, endBar]), Array(3).fill([88200, 2, 3]));
  const loops = packet.files.filter((file) => file.edition && file.format === 'wav');
  assert(loops.every((file) => file.samples === 88200));
  assert(!fs.readFileSync(loops[0].path).equals(fs.readFileSync(loops[1].path)));
  const project = packet.files.find(({ format }) => format === 'project');
  const source = fs.readFileSync(project.path);
  const original = readProject(project.path).song;
  const level = editSong(original, [{ type: 'gain', section: 'Pont', part: 'drum', db: -6 }]);
  for (const [i, before] of original.events.entries()) {
    const after = level.events[i];
    if (before.bus === 'drum' && before.beat >= 8 && before.beat < 16) {
      assert.equal(after.gain, (before.gain ?? 1) * 10 ** (-6 / 20));
    } else assert.equal(before, after);
  }
  const replaced = editSong(original, [{ type: 'replace_section', section: 2, replacement: { progression: ['Gm7b5', 'C7b9'] } }]);
  assert.deepEqual(replaced.meta.sections[1].chords, ['Gm7b5', 'C7b9']);
  assert.deepEqual(replaced.events.filter((e) => e.beat < 8 || e.beat >= 16), original.events.filter((e) => e.beat < 8 || e.beat >= 16));
  const versions = endingVariations(original, 3);
  assert.equal(new Set(versions.map((version) => renderMidiBuffer(version).toString('hex'))).size, 3);
  assert(versions.every((version) => version.totalBeats === original.totalBeats && !version.loop));
  for (const version of versions) assert.deepEqual(version.events.filter((e) => e.beat < 16), original.events.filter((e) => e.beat < 16));
  const edits = (await callTool('edit_music', { project_path: project.path, ending_variants: 3, format: 'midi' })).structuredContent;
  assert.equal(edits.versions.length, 3);
  assert.deepEqual(fs.readFileSync(project.path), source);

  const rock = createSong({ style: 'rock', seed: 9, duration_seconds: 12 });
  assert(rock.events.some((event) => event.inst === 'guitar' && event.articulation === 'mute'));
  for (const [style, technique] of [['rock', 'slide'], ['village', 'legato'], ['epic', 'swell']]) {
    const articulated = createSong({ style, seed: 42, arrangement: { motif: [{ beat: 0, degree: 3, duration: 2, articulation: technique }] } });
    const plain = { ...articulated, events: articulated.events.map((ev) => ({ ...ev, articulation: undefined })) };
    assert.notDeepEqual(renderSong(articulated).L, renderSong(plain).L, technique);
  }
  console.log('Studio : couches et prises, articulations, harmonie, retouches non destructives et éditions alignées vérifiées.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
