'use strict';

const { ui } = require('./language');

const fs = require('node:fs');
const { renderEventsInto } = require('./dsp');
const { localRms } = require('./music-analysis');
const { midiToFreq } = require('./theory');
const { noteNumber } = require('./score-notes');
const { hash32 } = require('./rng');
const { PATCH_ROLES, isCustom } = require('./custom-patch');

const REFERENCE = { mel: -23, bass: -23, pad: -29, arp: -27, counter: -29, texture: -32 };
const VELOCITIES = [0.38, 0.72, 0.94];
const SR = 22050;
const db = (amplitude) => 20 * Math.log10(Math.max(amplitude, 1e-9));
const round = (value) => Number(value.toFixed(2));
const clamp = (value, min, max) => Math.min(max, Math.max(value, min));

function probe(sound, role, midi, velocity, seed) {
  const attackTime = sound.patch.layers ? Math.max(...sound.patch.layers.map(({ envelope }) => envelope.attack))
    : sound.patch.modal?.friction?.attack_seconds ?? 0.02;
  const gate = Math.ceil(clamp(attackTime + (role === 'pad' ? 0.8 : 0.56), 0.66, 3.5) * SR);
  const L = new Float32Array(gate + Math.round(0.35 * SR)), R = new Float32Array(L.length);
  const event = { bus: role, inst: sound.id, t: 0, dur: gate / SR, freq: midiToFreq(midi), midi, pan: 0,
    vel: velocity, seedIdx: seed };
  renderEventsInto([event], L, R, SR, 1, 'synth', undefined, 1, { [sound.id]: sound.patch });
  const peak = L.reduce((highest, sample, i) => Math.max(highest, Math.abs(sample), Math.abs(R[i])), 0);
  const step = Math.round(0.01 * SR), windows = [];
  for (let start = 0; start < gate; start += step) {
    windows.push(localRms(L, R, start, Math.min(gate, start + step)) ?? -180);
  }
  const high = Math.max(...windows);
  const attack = windows.findIndex((level) => level > high - 6 && level > -90);
  const reference = localRms(L, R, 0, gate);
  const tail = localRms(L, R, Math.round(0.64 * gate), gate);
  const filter = 1 - Math.exp(-2 * Math.PI * 165 / SR);
  let low = 0, lowPower = 0, fullPower = 0;
  for (let i = 0; i < gate; i++) {
    const mono = 0.5 * (L[i] + R[i]);
    low += filter * (mono - low);
    lowPower += low * low;
    fullPower += mono * mono;
  }
  return { midi, velocity, rmsDbfs: reference, peakDbfs: round(db(peak)),
    attackMs: attack < 0 ? null : attack * 10, heldDb: tail === null || reference === null ? null : round(tail - reference),
    lowBandDb: fullPower > 0 ? round(db(Math.sqrt(lowPower / fullPower))) : null };
}

function calibrateSound(sound, role, pitches, seed) {
  if (!PATCH_ROLES.includes(role)) throw new Error(ui(`Pupitre de calibration inconnu : ${role}.`, `Unknown calibration part: ${role}.`));
  const notes = pitches ?? (role === 'bass' ? [36, 48, 60] : [48, 60, 72]);
  if (!Array.isArray(notes) || notes.length < 3 || notes.length > 6) throw new Error(ui('notes attend 3 à 6 hauteurs pour la calibration.', 'notes requires 3 to 6 pitches for calibration.'));
  const registers = notes.map(noteNumber).sort((a, b) => a - b);
  if (new Set(registers).size !== registers.length) throw new Error(ui('Les hauteurs de calibration doivent être différentes.', 'Calibration pitches must be distinct.'));
  const probes = registers.flatMap((midi) => VELOCITIES.map((velocity) => probe(sound, role, midi, velocity, hash32(seed, midi))));
  const middle = probes.filter(({ velocity }) => velocity === VELOCITIES[1]);
  const points = middle.map(({ midi, rmsDbfs }) => ({
    midi, gain_db: rmsDbfs === null || rmsDbfs < -58 ? 0 : round(clamp((REFERENCE[role] - rmsDbfs) * 0.68, -6, 6)),
  }));
  const suggestions = [];
  if (middle.some((entry) => entry.rmsDbfs === null || entry.rmsDbfs < -50)) {
    suggestions.push(ui('Un registre est très faible. Vérifie la hauteur utile, le filtre et les résonances du patch.',
      'One register is very quiet. Check the patch’s useful pitch range, filter, and resonances.'));
  }
  if (middle.some(({ peakDbfs, rmsDbfs, attackMs }) => rmsDbfs !== null && peakDbfs - rmsDbfs > 22 && attackMs < 25)) {
    suggestions.push(ui('L’attaque dépasse nettement le niveau tenu. Essaie un contact moins fort ou une attaque plus longue.',
      'The attack is much louder than the sustained level. Try a softer contact or a longer attack.'));
  }
  if (['pad', 'counter'].includes(role) && middle.some(({ heldDb }) => heldDb !== null && heldDb < -17)) {
    suggestions.push(ui('Le son s’efface pendant la tenue. Allonge la résonance ou augmente le sustain pour ce pupitre.',
      'The sound fades during the hold. Extend the resonance or increase sustain for this part.'));
  }
  if (role !== 'bass' && middle.some(({ midi, lowBandDb }) => midi >= 60 && lowBandDb !== null && lowBandDb > -3.5)) {
    suggestions.push(ui('Le grave reste dominant sur une note médiane ou aiguë. Essaie de réduire la couche de sous-octave.',
      'The bass still dominates a middle or high note. Try turning down the sub-octave layer.'));
  }
  return { type: 'soundmcp-calibration', version: 1, sound: sound.id, label: sound.label, role, seed, points, probes, suggestions };
}

function loadCalibrations(paths) {
  if (paths === undefined) return [];
  if (!Array.isArray(paths) || paths.length > 16 || paths.some((file) => typeof file !== 'string' || !file.trim())) {
    throw new Error(ui('calibration_paths attend jusqu’à 16 chemins.', 'calibration_paths allows up to 16 paths.'));
  }
  const keys = new Set();
  return paths.map((file) => {
    if (fs.statSync(file).size > 64 * 1024) throw new Error(ui('Calibration trop volumineuse.', 'Calibration file is too large.'));
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const { sound, role, points } = data ?? {};
    const key = `${sound}/${role}`;
    if (data?.type !== 'soundmcp-calibration' || data.version !== 1 || !isCustom(sound) || !PATCH_ROLES.includes(role) ||
        !Array.isArray(points) || points.length < 3 || points.length > 6 || points.some((point, i) =>
          !Number.isInteger(point?.midi) || point.midi < 0 || point.midi > 127 || (i && point.midi <= points[i - 1]?.midi) ||
          !Number.isFinite(point.gain_db) || Math.abs(point.gain_db) > 6) || keys.has(key)) {
      throw new Error(ui(`Calibration SoundMCP invalide ou en double : ${file}.`, `Invalid or duplicate SoundMCP calibration: ${file}.`));
    }
    keys.add(key);
    return { key, points };
  });
}

function gainAt(points, midi) {
  const next = points.findIndex((point) => point.midi >= midi);
  if (next < 1) return (next < 0 ? points.at(-1) : points[0]).gain_db;
  const before = points[next - 1], after = points[next];
  return before.gain_db + (after.gain_db - before.gain_db) * (midi - before.midi) / (after.midi - before.midi);
}

function applyCalibrations(song, calibrations, { requireMatch = true } = {}) {
  if (!calibrations.length) return song;
  const byVoice = new Map(calibrations.map(({ key, points }) => [key, points]));
  const matched = new Set();
  const events = song.events.map((event) => {
    const key = `${event.inst}/${event.bus}`;
    const points = byVoice.get(key);
    if (!points) return event;
    matched.add(key);
    const gainDb = round(gainAt(points, event.midi));
    const oldDb = Number.isFinite(event.calibrationDb) && Math.abs(event.calibrationDb) <= 6 ? event.calibrationDb : 0;
    return { ...event, gain: (event.gain ?? 1) * 10 ** ((gainDb - oldDb) / 20), calibrationDb: gainDb };
  });
  if (requireMatch && matched.size !== byVoice.size) {
    const missing = [...byVoice.keys()].filter((key) => !matched.has(key));
    throw new Error(ui(`Aucune note à calibrer pour ${missing.join(', ')}.`, `No notes to calibrate for ${missing.join(', ')}.`));
  }
  return { ...song, events };
}

module.exports = { calibrateSound, loadCalibrations, applyCalibrations };
