'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { renderCustom } = require('../src/custom-synth');
const { normalizePatch, normalizeGesture, importPatches, patchFromBrief } = require('../src/custom-patch');
const { readProject } = require('../src/music-project');
const { callTool } = require('../src/tools');
const { renderEventsInto, renderSong } = require('../src/dsp');
const { musicClock } = require('../src/music-clock');
const { performEvents } = require('../src/performance');
const { localRms } = require('../src/music-analysis');

async function checkFriction(dir) {
  const patch = { modal: { modes: [{ ratio: 1, gain: 0.9, decay_seconds: 0.45 },
    { ratio: 1.034, gain: 0.62, decay_seconds: 0.28, position_node: 2 },
    { ratio: 2.3, gain: 0.35, decay_seconds: 0.32, position_node: 1 }],
  contact: 0.3, friction: { amount: 0.82, roughness: 0.35, motion_hz: 2.1, attack_seconds: 0.036 } } };
  assert(patchFromBrief('métal frotté', 7).modal.friction);
  assert.throws(() => normalizePatch({ modal: { ...patch.modal, friction: { roughness: 1.1 } } }), /roughness/);
  const { structuredContent: sound } = await callTool('design_sound', { title: 'Tôle tenue', patch, seed: 7, output_dir: dir });
  const imported = importPatches([sound.patch_path]);
  assert.deepEqual(imported[sound.id], sound.patch);
  const sr = 22050;
  const event = { inst: sound.id, bus: 'mel', t: 0, dur: 3.2, freq: 349.228, pan: 0, vel: 0.76, seedIdx: 7 };
  const render = (events, modes = sound.patch) => {
    const L = new Float32Array(sr * 4), R = new Float32Array(L.length);
    renderEventsInto(events, L, R, sr, 1, 'synth', undefined, 1, { [sound.id]: modes });
    return L;
  };
  const sustained = render([event]);
  assert.deepEqual(sustained, render([event]));
  assert(sustained.every(Number.isFinite));
  const band = (signal, from, to) => localRms(signal, signal, Math.round(sr * from), Math.round(sr * to)) ?? -Infinity;
  const early = band(sustained, 0.35, 1);
  const late = band(sustained, 2.5, 3.1);
  assert(late > -40 && Math.abs(late - early) < 3);
  assert(late > band(sustained, 3.54, 3.61) + 34);
  assert.equal(band(sustained, 3.68, 3.9), -Infinity);
  assert(late > band(render([event], { modal: { ...sound.patch.modal, friction: undefined } }), 2.5, 3.1) + 34);
  const tied = render([{ ...event, dur: 1.6 }, { ...event, t: 1.6, dur: 1.6,
    freq: 369.994, articulation: 'slide', gesture: { glide_ms: 162 } }]);
  assert(band(tied, 1.55, 1.68) > early - 5);
  assert.throws(() => normalizeGesture({ glide_ms: 6001 }), /6000/);
  const slide = { ...event, t: 0.5, dur: 3.45, freq: 523.251, articulation: 'slide', gesture: normalizeGesture({ glide_ms: 2300 }) };
  const singleMode = { ...sound.patch.modal, modes: sound.patch.modal.modes.slice(0, 1),
    friction: { ...sound.patch.modal.friction, roughness: 0 } };
  const longSlide = render([{ ...event, dur: 0.5 }, slide], { modal: singleMode });
  const halfway = Math.sqrt(event.freq * slide.freq);
  assert(Math.abs(estimatePitch(longSlide, sr, halfway, 1.60, 1.70) - halfway) < 4);
  assert(Math.abs(estimatePitch(longSlide, sr, slide.freq, 3.15, 3.38) - slide.freq) < 0.5);
  const played = (await callTool('play_sound', { patch_path: sound.patch_path, sampling_rate: sr, output_dir: dir,
    notes: [{ at: 0, pitch: 'F4', duration: 1.4 }, { at: 1.4, pitch: 'F#4', duration: 1.65,
      articulation: 'slide', gesture: { glide_ms: 1500 } }],
  })).structuredContent;
  assert.equal(played.audio.invalidFrames + played.audio.clippedFrames, 0);
}

function estimatePitch(signal, sr, expected, from, to) {
  const lag = Math.round(sr / expected);
  const correlation = (delay) => {
    let cross = 0, first = 0, second = 0;
    for (let i = Math.round(from * sr); i < Math.round(to * sr); i++) {
      const a = signal[i], b = signal[i + delay];
      cross += a * b;
      first += a * a;
      second += b * b;
    }
    return cross / Math.sqrt(first * second);
  };
  const left = correlation(lag - 1), middle = correlation(lag), right = correlation(lag + 1);
  return sr / (lag + (left - right) / (2 * (left - 2 * middle + right)));
}

function partial(signal, sr, frequency) {
  let sine = 0, cosine = 0;
  for (let i = Math.round(sr * 0.03); i < Math.round(sr * 0.13); i++) {
    const phase = 2 * Math.PI * frequency * i / sr;
    sine += signal[i] * Math.sin(phase);
    cosine += signal[i] * Math.cos(phase);
  }
  return Math.hypot(sine, cosine);
}

async function checkWaveguide(dir) {
  const { structuredContent: string } = await callTool('design_sound', { title: 'Corde de test', seed: 13, output_dir: dir,
    patch: { waveguide: { brightness: 0.74, stiffness: 0.42, contact: 0.14, decay_seconds: 3.8,
      release_damping: 0, body: { mix: 0 } } },
    gesture: { position: 0.18, hardness: 0.82 },
  });
  assert.equal(string.audio.invalidFrames, 0);
  assert(patchFromBrief('corde pincée douce en nylon', 13).waveguide);
  assert.throws(() => normalizePatch({ waveguide: {}, layers: [{}] }), /layers/);
  const event = { t: 0, dur: 0.44, inst: string.id, bus: 'mel', freq: 220, vel: 0.7, pan: 0, seedIdx: 7 };
  const patches = importPatches([string.patch_path]);
  assert.deepEqual(patches[string.id], string.patch);
  const render = (sr, events) => {
    const L = new Float32Array(Math.round(sr * 1.2)), R = new Float32Array(L.length);
    renderEventsInto(events, L, R, sr, 1, 'synth', undefined, 1, patches);
    return L;
  };
  for (const sr of [22050, 44100, 48000]) {
    for (const freq of [110, 440, 1760]) {
      const signal = render(sr, [{ ...event, freq }]);
      const actual = estimatePitch(signal, sr, freq, 0.16, 0.39);
      assert(Math.abs(1200 * Math.log2(actual / freq)) < 2);
      assert(signal.every(Number.isFinite));
    }
  }
  const sr = 48000;
  const middle = render(sr, [{ ...event, gesture: { position: 0.5, hardness: 0.12 } }]);
  const attack = { ...event, gesture: { position: 0.14, hardness: 0.91 } };
  const bridge = render(sr, [attack]);
  assert.deepEqual(bridge, render(sr, [attack]));
  assert(partial(bridge, sr, 440) / partial(bridge, sr, 220) > 5 * partial(middle, sr, 440) / partial(middle, sr, 220));
  const damped = render(sr, [{ ...attack, gesture: { ...attack.gesture, damping: 0.9 } }]);
  assert(localRms(bridge, bridge, 33600, 52800) > localRms(damped, damped, 33600, 52800) + 25);
  const slide = { ...event, t: 0.43, freq: 277.18263, articulation: 'slide', gesture: { glide_ms: 85 } };
  const tied = render(sr, [attack, slide]);
  assert(Math.abs(estimatePitch(tied, sr, slide.freq, 0.62, 0.82) - slide.freq) < 0.3);
  assert(Math.abs(tied[Math.round(slide.t * sr)] - bridge[Math.round(slide.t * sr)]) < 0.0001);

  const result = (await callTool('vary_sound', { patch_path: string.patch_path, directions: ['shorter'], sampling_rate: 22050,
    notes: [{ at: 0, pitch: 'C4', duration: 0.55, gesture: { position: 0.3 } }], seed: 13, output_dir: dir })).structuredContent;
  const shorter = result.sounds[0];
  assert(shorter.patch.waveguide.decay_seconds < string.patch.waveguide.decay_seconds);
  const generated = (await callTool('create_music', { style: 'ambient', palette: 'synth', tempo: 120, loop: true, seed: 7,
    duration_seconds: 8, patch_paths: [shorter.patch_path], patch_roles: { mel: shorter.id }, save_project: true, format: 'midi', output_dir: dir,
  })).structuredContent.files.find((f) => f.format === 'project').path;
  const revised = (await callTool('edit_music', { project_path: generated, sampling_rate: 22050, output_dir: dir,
    format: 'wav', edits: [{ type: 'write_measure', bar: 2, part: 'mel', instrument: shorter.id,
      notes: [{ beat: 0.4, pitch: 'C4', gesture: { position: 0.13 } }] }],
  })).structuredContent.versions[0];
  const score = readProject(revised.files.find((file) => file.format === 'project').path).song;
  assert(score.events.some((note) => note.inst === shorter.id && note.gesture?.position === 0.13));
}

async function checkModalAndPerformance(dir) {
  const patch = { modal: { modes: [
    { ratio: 1, gain: 0.9, decay_seconds: 2.6 },
    { ratio: 3.11, gain: 0.2, decay_seconds: 0.7, position_node: 2 },
  ], contact: 0.27 } };
  const { structuredContent: glass } = await callTool('design_sound', {
    patch, title: 'Verre', gesture: { position: 0.36, hardness: 0.8 }, seed: 4, output_dir: dir,
  });
  assert.throws(() => normalizePatch({ ...patch, layers: [{}] }), /layers/);
  assert.throws(() => normalizePatch({ modal: { modes: [{ ratio: 33 }] } }), /ratio/);
  assert.equal(glass.audio.invalidFrames, 0);
  assert.deepEqual(importPatches([glass.patch_path])[glass.id], glass.patch);

  const sr = 24000;
  const strike = { inst: glass.id, bus: 'mel', t: 0, dur: 0.38, freq: 440, pan: 0, vel: 0.62, seedIdx: 12 };
  const next = { ...strike, t: 0.38, freq: 554.365, articulation: 'slide', gesture: { glide_ms: 90 } };
  const render = (events) => {
    const L = new Float32Array(sr), R = new Float32Array(sr);
    renderEventsInto(events, L, R, sr, 1, 'synth', undefined, 1, { [glass.id]: glass.patch });
    return L;
  };
  const damped = render([{ ...strike, gesture: { damping: 1 } }]);
  const struck = render([strike]);
  const connected = render([strike, next]);
  assert(localRms(struck, struck, 12000, 18000) > localRms(damped, damped, 12000, 18000) + 20);
  assert.equal(connected[Math.round(next.t * sr)], struck[Math.round(next.t * sr)]);
  assert.notDeepEqual(connected, render([strike, { ...next, articulation: undefined }]));
  const pitchStart = Math.round(0.56 * sr), pitchEnd = Math.round(0.86 * sr);
  let crossings = 0;
  for (let i = pitchStart; i < pitchEnd; i++) if (connected[i] >= 0 && connected[i - 1] < 0) crossings++;
  assert(Math.abs(crossings / 0.3 - next.freq) < 5);

  const generated = (await callTool('create_music', { style: 'ambient', palette: 'synth', tempo: 120, loop: true, seed: 7,
    duration_seconds: 8, patch_paths: [glass.patch_path], patch_roles: { mel: glass.id }, save_project: true, format: 'midi', output_dir: dir,
  })).structuredContent.files.find((f) => f.format === 'project').path;
  const original = fs.readFileSync(generated);
  const edited = (await callTool('edit_music', { project_path: generated, sampling_rate: 22050, format: 'wav', stems: true, output_dir: dir,
    performance: { amount: 0.9, parts: ['mel', 'pad'] }, room: { distance: { mel: 0.1, pad: 0.85 } },
    edits: [{ type: 'write_measure', bar: 2, part: 'mel', instrument: glass.id, notes: [
      { beat: 0.25, pitch: 'A4', duration: 0.8, gesture: { position: 0.27 } },
      { beat: 1.05, pitch: 'C5', duration: 0.7, articulation: 'slide', gesture: { glide_ms: 75 } },
    ] }],
  })).structuredContent.versions[0];
  assert.deepEqual(fs.readFileSync(generated), original);
  assert(edited.files.some((f) => f.stem === 'mel'));
  const revised = edited.files.find((f) => f.format === 'project').path;
  const { song } = readProject(revised);
  const performed = performEvents(song, musicClock(song));
  assert.deepEqual(performed.map((event) => event.midi), song.events.map((event) => event.midi));
  assert(performed.some((event, i) => event.bus === 'mel' && event.t !== song.events[i].t));
  assert(song.events.some((event) => event.gesture?.glide_ms === 75));
  const withRoom = renderSong(song), dryRoom = renderSong({ ...song, room: undefined });
  assert.notDeepEqual(withRoom.L, dryRoom.L);
  const { structuredContent: comparison } = await callTool('preview_music', {
    project_paths: [generated, revised], full: true, blind: true, seed: 12, output_dir: dir,
  });
  assert(comparison.files.every((file) => file.durationSeconds === 8 && file.clippedFrames === 0));
  assert(Math.abs(comparison.files[0].integratedLufs - comparison.files[1].integratedLufs) < 0.1);
  const outputsBeforeError = fs.readdirSync(dir);
  await assert.rejects(callTool('preview_music', {
    project_paths: [generated, path.join(dir, 'missing.soundmcp.json')], output_dir: dir,
  }), /projet 2 impossible/);
  assert.deepEqual(fs.readdirSync(dir), outputsBeforeError);

  const window = { project_path: revised, start_bar: 2, bars: 1, part: 'mel', limit: 1 };
  const inspected = (await callTool('inspect_score', window)).structuredContent;
  assert.equal(inspected.event_count, 2);
  assert.equal(inspected.next_offset, 1);
  assert.equal(inspected.events[0].pitch, 69);
  assert(inspected.measures[0].chords.length > 0);
  const page = (await callTool('inspect_score', { ...window, offset: inspected.next_offset })).structuredContent;
  assert.equal(page.events[0].gesture.glide_ms, 75);
  assert.equal(page.next_offset, null);
  assert.notEqual(page.events[0].played.beat, page.events[0].beat);

  const soundArgs = { patch_path: glass.patch_path, seed: 5, sampling_rate: 22050, output_dir: dir, tail_seconds: 0.6, notes: [
    { at: 0.02, pitch: 'A4', duration: 0.36, gesture: { position: 0.28, hardness: 0.8 } },
    { at: 0.38, pitch: 'C5', duration: 0.55, articulation: 'slide', gesture: { glide_ms: 80 } },
  ] };
  const phrase = (await callTool('play_sound', soundArgs)).structuredContent;
  assert.equal(phrase.audio.durationSeconds, 1.53);
  assert.equal(phrase.audio.invalidFrames, 0);
  const before = fs.readFileSync(glass.patch_path);
  const variants = (await callTool('vary_sound', { ...soundArgs, directions: ['darker', 'longer'] })).structuredContent;
  assert.deepEqual(fs.readFileSync(glass.patch_path), before);
  const [darker, longer] = variants.sounds;
  assert(darker.patch.modal.modes[1].gain < glass.patch.modal.modes[1].gain);
  assert(longer.patch.modal.modes[0].decay_seconds > glass.patch.modal.modes[0].decay_seconds);
  assert.deepEqual(importPatches([longer.patch_path])[longer.id], longer.patch);
  const listening = (await callTool('compare_sounds', { ...soundArgs, patch_path: undefined,
    sounds: [{ patch_path: glass.patch_path }, { patch_path: darker.patch_path },
      { title: 'Oscillateur', patch: { layers: [{ wave: 'triangle' }] } }], blind: true,
  })).structuredContent;
  assert(listening.files.every((file) => file.title === undefined && file.sourceIndex === undefined && file.durationSeconds === 1.53));
  assert(listening.files.every((file) => Math.abs(file.integratedLufs - listening.files[0].integratedLufs) < 0.1));
  assert.equal(JSON.parse(fs.readFileSync(listening.reveal_path, 'utf8')).length, 3);
  await assert.rejects(callTool('play_sound', { ...soundArgs, notes: [{ pitch: 'A4' }] }), /Temps/);
  await assert.rejects(callTool('inspect_score', { ...window, start_bar: 999 }), /mesures/);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soundmcp-custom-'));
  const pure = normalizePatch({ layers: [{ wave: 'sine', gain: 0.8, envelope: { attack: 0.01, decay: 0.1, sustain: 0.8, release: 0.2 } }] });
  const sr = 24000;
  const l = new Float32Array(sr), r = new Float32Array(sr);
  renderCustom(l, r, 0, { freq: 440, vel: 0.7, pan: 0, seedIdx: 5 }, sr, 0.75, pure);
  let crossings = 0;
  for (let i = 6000; i < 18000; i++) if (l[i] >= 0 && l[i - 1] < 0) crossings++;
  assert(Math.abs(crossings * 2 - 440) <= 2);
  assert(l.every(Number.isFinite));
  assert.throws(() => normalizePatch({ layers: [{ wave: 'vocal-sample' }] }), /wave/);
  assert.throws(() => normalizePatch({ layers: [{ gain: 0 }] }), /gain/);
  assert.throws(() => normalizePatch({ layers: [{}], lfos: [{ target: 'gain', depth: 4 }] }), /depth/);
  assert.deepEqual(patchFromBrief('cloche métallique qui descend avec un écho', 3), patchFromBrief('cloche métallique qui descend avec un écho', 3));
  assert.notDeepEqual(patchFromBrief('cloche métallique qui descend avec un écho', 3), patchFromBrief('grave pulsé et sombre', 3));

  const { structuredContent: metallic } = await callTool('design_sound', { brief: 'verre métallique, grain, monte puis écho stéréo', title: 'Tesselle', seed: 19,
    duration_seconds: 3.5, note: 'Bb4', output_dir: dir });
  const { structuredContent: machine } = await callTool('design_sound', { title: 'Mécanisme', seed: 19, output_dir: dir,
    patch: { layers: [{ wave: 'pulse', ratio: 0.5, pulse_width: 0.24, gain: 0.55 }, { wave: 'brown', gain: 0.3 }],
      filter: { type: 'bandpass', frequency: 210, q: 2.2 }, lfos: [{ target: 'gain', wave: 'triangle', rate: 3.3, depth: 0.62 }],
      effects: { drive: 0.35, chorus: 0.26, bits: 9 } } });
  assert.equal(metallic.audio.durationSeconds, 3.5);
  assert(metallic.audio.integratedLufs > -40);
  assert(machine.audio.integratedLufs > -40);
  assert.equal(metallic.audio.clippedFrames, 0);
  const paths = [metallic.patch_path, machine.patch_path];
  const patches = importPatches(paths);
  assert.deepEqual(patches[metallic.id], metallic.patch);
  const { structuredContent: preview } = await callTool('preview_sounds', { sounds: [metallic.id, machine.id], patch_paths: paths, output_dir: dir });
  assert.equal(preview.markers.length, 2);
  assert(preview.markers.every((marker) => Number.isFinite(marker.integratedLufs)));

  const arrangement = { sections: [
    { name: 'Ouverture', bars: 2, parts: ['pad', 'mel'], instruments: { mel: metallic.id } },
    { name: 'Final', bars: 2, parts: ['pad', 'mel', 'bass'], instruments: { bass: machine.id } },
  ] };
  const args = { style: 'ambient', key: 'D minor', tempo: 120, seed: 27, arrangement, save_project: true, format: 'midi', output_dir: dir };
  await assert.rejects(callTool('create_music', args), /Son personnel absent/);
  const generated = (await callTool('create_music', { ...args, patch_paths: paths })).structuredContent;
  const project = generated.files.find((f) => f.format === 'project').path;
  assert(Object.keys(readProject(project).song.patches).length === 2);
  const before = fs.readFileSync(project);
  const retake = (await callTool('edit_music', { project_path: project, format: 'midi', output_dir: dir,
    edits: [{ type: 'replace_section', section: 1, replacement: { color: 'radio' } },
      { type: 'write_measure', bar: 3, part: 'texture', instrument: metallic.id, notes: [{ beat: 0.55, duration: 2, velocity: 0.31 }] }] })).structuredContent;
  assert.deepEqual(before, fs.readFileSync(project));
  const revised = retake.versions[0].files.find((f) => f.format === 'project').path;
  const score = readProject(revised).song;
  assert(score.events.some((event) => event.bus === 'texture' && event.inst === metallic.id));
  assert(score.events.some((event) => event.bus === 'bass' && event.inst === machine.id));
  const result = (await callTool('finish_music', { project_path: revised, stems: true, sampling_rate: 22050, output_dir: dir })).structuredContent;
  assert(result.files.some((f) => f.stem === 'texture'));
  assert(result.audio.peakDbfs < 0);
  const draft = (await callTool('draft_music', { brief: '14 secondes nocturnes', variants: 1, patch_paths: [metallic.patch_path],
    patch_roles: { mel: metallic.id }, output_dir: dir, seed: 10 })).structuredContent;
  assert(draft.candidates[0].music.instruments.includes(metallic.id));
  await checkModalAndPerformance(dir);
  await checkWaveguide(dir);
  await checkFriction(dir);
  console.log('Sons personnels : oscillation et fréquence, patches FR, FM et modulation, import, retouches et nouveau rendu vérifiés.');
  console.log('Jeu expressif : résonance amortie, glissé continu, phrasé, pièce, persistance et comparaison complète vérifiés.');
  console.log('Atelier des sons : jeu d’une phrase, variantes importables, comparaison anonyme et inspection paginée vérifiés.');
  console.log('Cordes pincées : justesse à trois fréquences d’échantillonnage, timbre, amortissement, glissé et réemploi vérifiés.');
  console.log('Frottement modal : excitation soutenue, relâchement, liaison et réimport vérifiés.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
