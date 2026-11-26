'use strict';

const { ARTICULATIONS } = require('./arrangement');
const { createPatch, normalizeGesture, readPatch, supportsGesture } = require('./custom-patch');
const { renderSong } = require('./dsp');
const { hash32 } = require('./rng');
const { noteNumber, validExpression } = require('./score-notes');
const { midiToFreq } = require('./theory');

const DIRECTIONS = ['brighter', 'darker', 'shorter', 'longer'];
const DEFAULT_PHRASE = [
  { at: 0.08, pitch: 'C4', duration: 0.44, velocity: 0.55 },
  { at: 0.64, pitch: 'G4', duration: 0.58, velocity: 0.87 },
  { at: 1.42, pitch: 'Eb4', duration: 1.05, velocity: 0.69, expression: [0.9, 1.13] },
];
const clamp = (v, low, high) => Math.min(high, Math.max(low, v));
const within = (v, low, high) => Number.isFinite(v) && v >= low && v <= high;

function loadPatch(source) {
  if (!source || typeof source !== 'object' || (source.patch_path === undefined) === (source.patch === undefined)) {
    throw new Error('Indique un patch ou un patch_path par son.');
  }
  return source.patch_path === undefined ? createPatch(source.title ?? 'Son personnel', source.patch) : readPatch(source.patch_path);
}

function readPhrase(args, seed) {
  const notes = args.notes ?? DEFAULT_PHRASE;
  if (!Array.isArray(notes) || !notes.length || notes.length > 32) throw new Error('notes attend entre 1 et 32 notes.');
  let last = 0;
  const events = notes.map((note, i) => {
    if (!note || typeof note !== 'object') throw new Error(`Note ${i + 1} invalide.`);
    const { at, pitch, duration = 0.55, velocity = 0.72, pan = 0, timbre, articulation, expression } = note;
    if (!within(at, 0, 14) || !within(duration, 0.025, 8) || !within(velocity, 0.05, 1) || !within(pan, -1, 1) ||
        (timbre !== undefined && !within(timbre, 0, 1)) || (articulation !== undefined && !ARTICULATIONS.includes(articulation)) ||
        (expression !== undefined && !validExpression(expression))) throw new Error(`Temps, durée, nuance ou articulation invalide dans la note ${i + 1}.`);
    const midi = noteNumber(pitch);
    last = Math.max(last, at + duration);
    return { t: at, dur: duration, midi, freq: midiToFreq(midi), vel: velocity, pan, timbre, articulation, expression,
      gesture: normalizeGesture(note.gesture), bus: 'mel', seedIdx: hash32(seed, i + 1) };
  });
  const tail = args.tail_seconds ?? 1.45;
  if (!within(tail, 0.12, 6) || last + tail > 24) throw new Error('tail_seconds attend 0.12 à 6 s et le rendu doit tenir en 24 s.');
  return { events, last, tail };
}

function playPhrase(sound, { sr, mono }, phrase) {
  const { events, last, tail } = phrase;
  const gestural = supportsGesture(sound.patch);
  const prepared = events.map((event) => ({ ...event, inst: sound.id, gesture: gestural ? event.gesture : undefined }));
  return renderSong({ sr, mono, bpm: 60, totalBeats: last, bars: 1, events: prepared, loop: false,
    targetSeconds: last + tail, endFade: Math.min(0.12, tail * 0.52), patches: { [sound.id]: sound.patch } });
}

const SUFFIX = { brighter: 'plus brillant', darker: 'plus sombre', shorter: 'plus bref', longer: 'plus long' };

function variantSound(sound, direction, amount) {
  const patch = structuredClone(sound.patch);
  const tonal = direction === 'brighter' || direction === 'darker';
  const power = 2 ** (amount * (direction === 'brighter' || direction === 'longer' ? 1 : -1));
  if (patch.modal) {
    for (const mode of patch.modal.modes) {
      if (tonal) mode.gain = clamp(mode.gain * power ** Math.max(0, Math.log2(mode.ratio)), 0, 1);
      else mode.decay_seconds = clamp(mode.decay_seconds * power, 0.025, 8);
    }
    if (tonal) patch.modal.contact = clamp((patch.modal.contact + 0.08) * power - 0.08, 0, 0.7);
  } else if (patch.waveguide) {
    if (tonal) {
      patch.waveguide.brightness = clamp((patch.waveguide.brightness + 0.15) * power - 0.15, 0, 1);
      patch.waveguide.contact = clamp((patch.waveguide.contact + 0.045) * power - 0.045, 0, 0.7);
    } else patch.waveguide.decay_seconds = clamp(patch.waveguide.decay_seconds * power, 0.12, 8);
  } else if (tonal) {
    patch.filter.frequency = clamp(patch.filter.frequency * power ** 1.6, 30, 18000);
    for (const layer of patch.layers) {
      const upper = Math.max(0, Math.log2(layer.ratio));
      layer.gain = clamp(layer.gain * power ** upper, 0, 1);
      layer.fm.index = clamp(layer.fm.index * power, 0, 7);
    }
  } else {
    for (const { envelope } of patch.layers) {
      envelope.decay = clamp(envelope.decay * power, 0, 8);
      envelope.release = clamp(envelope.release * power, 0.008, 4);
      envelope.sustain = clamp(envelope.sustain ** (1 / power), 0, 1);
    }
  }
  return createPatch(`${sound.label.slice(0, 62)} · ${SUFFIX[direction]}`, patch);
}

module.exports = { DIRECTIONS, loadPatch, readPhrase, playPhrase, variantSound };
