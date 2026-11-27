'use strict';

const { ui } = require('./language');

const { existsSync, readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { join } = require('node:path');
const { ELECTRIC, ORCHESTRAL_TEXTURES } = require('./texture-voices');
const { unpackPcm } = require('./packed-bank');

const GAINS = { piano: 0.52, upright: 0.58, kick: 0.91, snare: 0.65, 'snare-ghost': 0.41,
  hat: 0.35, ohat: 0.42, ride: 0.49, crash: 0.53, tom: 0.59, strings: 0.43, 'strings-pizz': 0.44,
  flute: 0.46, 'flute-staccato': 0.46, clarinet: 0.49, brass: 0.43, 'brass-staccato': 0.43, 'acoustic-guitar': 0.51,
  'electric-guitar': 0.52, harp: 0.49, vibraphone: 0.48, cello: 0.43, 'cello-pizz': 0.43, 'cello-staccato': 0.44,
  trumpet: .43, 'trumpet-staccato': .43, trombone: .46, 'trombone-staccato': .46, tuba: .48,
  timpani: .56, 'timpani-roll': .42, 'concert-bass-drum': .66, 'concert-snare': .46, 'frame-drum': .45,
  gong: .47, 'cymbal-swell': .44, 'orchestral-cymbals': .49 };
const V2_SUSTAINS = ['strings', 'flute', 'clarinet', 'brass'];
const SUSTAINED = new Set([...V2_SUSTAINS, 'cello', 'trumpet', 'trombone', 'tuba', 'timpani-roll']);
const LEGATO_SAMPLE_START = { flute: 0.26, clarinet: 0.22, cello: 0.18 };
const V2_INSTRUMENTS = new Set([...V2_SUSTAINS, 'strings-pizz', 'flute-staccato', 'brass-staccato', 'acoustic-guitar']);
const EXTENSION_INSTRUMENTS = new Set(['harp', 'vibraphone', 'cello', 'cello-pizz', 'cello-staccato']);
const CINEMATIC_INSTRUMENTS = new Set([...ORCHESTRAL_TEXTURES, 'trumpet', 'trumpet-staccato', 'trombone', 'trombone-staccato', 'tuba']);
const UNPITCHED = new Set(ORCHESTRAL_TEXTURES.filter((id) => !id.startsWith('timpani')));
const RELEASE = { piano: 0.33, harp: 0.4, vibraphone: 0.48, 'cello-pizz': 0.23, timpani: .31,
  'timpani-roll': .23, 'concert-bass-drum': .47, 'concert-snare': .15, 'frame-drum': .28,
  gong: 1.03, 'cymbal-swell': .57, 'orchestral-cymbals': .79 };
const ROOT = join(__dirname, '..', 'banks', 'studio');
let bank, extension, cinematic;
const filterCache = new Map();
const PHASES = 64;
const RADIUS = 8;

function antiAlias(step) {
  if (step <= 1.04) return null;
  if (filterCache.has(step)) return filterCache.get(step);
  const cutoff = 0.94 / step;
  const table = Array.from({ length: PHASES }, (_, phase) => {
    const coefficients = Float64Array.from({ length: RADIUS * 2 }, (_, i) => {
      const offset = i - RADIUS + 1 - phase / PHASES;
      const arg = Math.PI * cutoff * offset;
      const sinc = Math.abs(arg) < 1e-9 ? 1 : Math.sin(arg) / arg;
      return sinc * (0.5 + 0.5 * Math.cos(Math.PI * offset / RADIUS));
    });
    const sum = coefficients.reduce((a, b) => a + b, 0);
    return coefficients.map((value) => value / sum);
  });
  if (filterCache.size > 256) filterCache.clear();
  filterCache.set(step, table);
  return table;
}

function readBank(manifestName, pcmName, verify = false) {
  const { samples, rate, sha256 } = JSON.parse(readFileSync(join(ROOT, manifestName), 'utf8'));
  const pcmPath = join(ROOT, pcmName);
  const raw = existsSync(pcmPath);
  const pcm = raw ? readFileSync(pcmPath) : unpackPcm(readFileSync(`${pcmPath}.br`), samples);
  if ((verify || !raw) && createHash('sha256').update(pcm).digest('hex') !== sha256) {
    throw new Error(ui('La banque Studio est incomplète ou altérée.', 'The Studio bank is incomplete or damaged.'));
  }
  const instruments = new Map();
  for (const sample of samples) {
    const limit = sample.offset + sample.frames * sample.channels * 2;
    if (limit > pcm.length) throw new Error(ui('La banque studio est incomplète.', 'The Studio bank is incomplete.'));
    if (!instruments.has(sample.instrument)) instruments.set(sample.instrument, []);
    instruments.get(sample.instrument).push(sample);
  }
  return { pcm, rate, instruments };
}

function loadBank() {
  return bank ??= readBank('manifest.json', 'studio.pcm');
}

function loadExtensionBank() {
  return extension ??= readBank('extension.json', 'extension.pcm', true);
}

function loadCinematicBank() {
  return cinematic ??= readBank('cinematic.json', 'cinematic.pcm', true);
}

function lookup(instruments, inst, pitch, velocity, variant) {
  const candidates = instruments.get(inst);
  if (!candidates) return null;
  let score = Infinity;
  let matching = [];
  for (const sample of candidates) {
    const distance = (pitch === undefined ? 0 : Math.abs(sample.root - pitch) * 1.1) + Math.abs(sample.velocity - velocity);
    if (distance < score) {
      score = distance;
      matching = [sample];
    } else if (distance === score) matching.push(sample);
  }
  return matching[variant % matching.length];
}

function planSampleLegato(notes, sr, bankVersion) {
  const lines = new Map();
  for (const note of notes) {
    const { inst, bus, drum } = note.event;
    if (!Object.hasOwn(LEGATO_SAMPLE_START, inst) || drum) continue;
    const line = `${bus}:${inst}`;
    if (!lines.has(line)) lines.set(line, []);
    lines.get(line).push(note);
  }
  const joins = new Map();
  for (const line of lines.values()) {
    line.sort((a, b) => a.start - b.start);
    let earlierEnd = -Infinity;
    for (let index = 1; index < line.length; index++) {
      const before = line[index - 1], after = line[index];
      const next = line[index + 1];
      const beforeEnd = before.start + before.duration * sr;
      const polyphonic = earlierEnd > after.start || before.start === line[index - 2]?.start || after.start === next?.start;
      earlierEnd = Math.max(earlierEnd, beforeEnd);
      const gap = after.start - beforeEnd;
      const distance = after.start - before.start;
      if (polyphonic || distance <= 0 || gap < -0.065 * sr || gap > 0.045 * sr || after.event.articulation !== 'legato' ||
          before.event.midi === after.event.midi || ['staccato', 'pizzicato'].includes(before.event.articulation)) continue;
      if (V2_INSTRUMENTS.has(after.event.inst) &&
          Math.min(before.event.bankVersion ?? bankVersion, after.event.bankVersion ?? bankVersion) < 2) continue;

      // Préserve les attaques et les relâchements voisins dans les passages rapides.
      const nextStart = next?.start ?? Infinity;
      const frames = Math.floor(Math.min(0.045 * sr, before.duration * sr / 2, after.duration * sr / 2,
        distance / 2, (nextStart - after.start) / 2));
      if (frames < 2) continue;
      joins.set(before, { ...joins.get(before), releaseStart: distance, releaseFrames: frames });
      joins.set(after, { attackFrames: frames });
    }
  }
  return joins;
}

function renderSamples(L, R, start, ev, sr, seconds, takeIndex, bankVersion = 3, legato) {
  let inst = ev.drum === 'snare' && ev.articulation === 'ghost' ? 'snare-ghost' : ev.inst;
  const electric = ELECTRIC.includes(inst) ? inst : null;
  if (electric) {
    if (bankVersion < 3) return false;
    inst = 'electric-guitar';
  }
  if (inst === 'strings' && ev.articulation === 'pizzicato') inst = 'strings-pizz';
  if (inst === 'cello' && ev.articulation === 'pizzicato') inst = 'cello-pizz';
  if (['flute', 'brass', 'cello', 'trumpet', 'trombone'].includes(inst) && ev.articulation === 'staccato') inst += '-staccato';
  if (!Object.hasOwn(GAINS, inst)) return false;
  if (bankVersion < 2 && V2_INSTRUMENTS.has(inst)) return false;
  if (ev.drum && ev.kit !== 'acoustic') return false;
  const { pcm, rate, instruments } = CINEMATIC_INSTRUMENTS.has(inst) ? loadCinematicBank()
    : EXTENSION_INSTRUMENTS.has(inst) ? loadExtensionBank() : loadBank();
  const nominalPitch = UNPITCHED.has(inst) ? undefined : ev.midi;
  const voice = lookup(instruments, inst, nominalPitch, ev.vel, takeIndex);
  if (!voice) return false;
  const pitch = nominalPitch === undefined ? 1 : 2 ** ((nominalPitch - voice.root - (voice.tuning_cents ?? 0) / 100) / 12);
  const step = voice.peakFrame ? voice.peakFrame / (sr * Math.max(.025, seconds)) : rate * pitch / sr;
  const filter = antiAlias(step);
  const stride = voice.channels * 2;
  const piano = inst === 'piano';
  const sustain = SUSTAINED.has(inst) && voice.frames > 1.15 * rate;
  const loopStart = Math.round(0.49 * rate), loopEnd = voice.frames - Math.round(0.13 * rate), overlap = Math.round(0.11 * rate);
  const skip = legato?.attackFrames ? LEGATO_SAMPLE_START[inst] : SUSTAINED.has(inst) && ev.articulation === 'legato' ? 0.032 : 0;
  const startFrame = Math.round(skip * rate);
  const muted = ev.articulation === 'mute' && inst === 'acoustic-guitar';
  const color = ev.timbre ?? 0.5;
  if (muted) seconds = Math.min(seconds, 0.13);
  const release = ev.articulation === 'staccato' || muted ? 0.07 : RELEASE[inst] ?? (sustain ? 0.24 : 0.13);
  const end = legato?.releaseFrames ? legato.releaseStart + legato.releaseFrames : Math.ceil((seconds + release) * sr);
  const frames = Math.min(L.length - start, sustain ? Infinity : Math.floor((voice.frames - startFrame - 1) / step),
    ev.drum ? Infinity : end);
  const pan = (ev.pan + 1) * Math.PI / 4;
  const gain = GAINS[inst] * (ev.gain ?? 1) * ev.vel ** (ev.drum ? 1.1 : 0.87);
  const left = Math.cos(pan) * gain, right = Math.sin(pan) * gain;
  const interpolate = (index, channel, fraction) => {
    const offset = voice.offset + index * stride + channel * 2;
    if (!filter) {
      const a = pcm.readInt16LE(offset);
      return (a + (pcm.readInt16LE(offset + stride) - a) * fraction) / 32768;
    }
    const coefficients = filter[Math.min(PHASES - 1, Math.floor(fraction * PHASES))];
    let sum = 0;
    const first = index - RADIUS + 1;
    const at = voice.offset + first * stride + channel * 2;
    for (let tap = Math.max(0, -first); tap < Math.min(coefficients.length, voice.frames - first); tap++) {
      sum += pcm.readInt16LE(at + tap * stride) * coefficients[tap];
    }
    return sum / 32768;
  };
  const sampleAt = (position, channel) => interpolate(Math.floor(position), channel, position % 1);
  const rateCoef = (hz) => 1 - Math.exp(-2 * Math.PI * Math.min(hz, sr * 0.45) / sr);
  const highpass = rateCoef(120), cabinet = rateCoef(2300 + color * 2600);
  let low = 0, cab1 = 0, cab2 = 0, previous = 0;
  const drive = 3.6 + 8.4 * color;
  let position = startFrame;
  for (let i = 0; i < frames; i++) {
    let l = sampleAt(position, 0);
    let r = voice.channels === 2 ? sampleAt(position, 1) : l;
    if (sustain && position >= loopEnd - overlap) {
      const offset = position - loopEnd + overlap;
      const gain = 0.5 - 0.5 * Math.cos(Math.PI * offset / overlap);
      const nextL = sampleAt(loopStart + offset, 0);
      const nextR = voice.channels === 2 ? sampleAt(loopStart + offset, 1) : nextL;
      l += gain * (nextL - l);
      r += gain * (nextR - r);
    }
    const time = i / sr;
    if (electric === 'electric-drive') {
      low += highpass * (l - low);
      const signal = l - low * 0.96;
      // Dos points de la courbe de saturation par échantillon pour adoucir les aigus du baffle.
      const shape = (Math.tanh(drive * (0.68 * signal + 0.32 * previous)) + Math.tanh(drive * signal)) * 0.45;
      previous = signal;
      cab1 += cabinet * (shape - cab1);
      cab2 += cabinet * (cab1 - cab2);
      l = r = cab2;
    } else if (electric) {
      const delay = rate * (0.007 + 0.0026 * Math.sin(2 * Math.PI * (0.49 + color * 0.51) * time));
      const doubled = sampleAt(Math.max(0, position - delay), 0);
      r = l * 0.8 + doubled * 0.2;
      if (electric === 'electric-swell') {
        const opening = Math.sin(Math.min(1, time / Math.max(0.04, Math.min(seconds * 0.7, 0.75 + color * 0.55))) * Math.PI / 2) ** 2;
        l *= opening;
        r *= opening;
      }
    }
    const progress = Math.min(1, time / Math.max(0.01, seconds));
    const swell = ev.articulation === 'swell' ? 0.54 + 0.46 * Math.sin(progress * Math.PI / 2) : 1;
    const expression = ev.expression ? ev.expression[0] + (ev.expression[1] - ev.expression[0]) * progress : 1;
    let releaseGain = 1;
    if (legato?.releaseFrames) {
      if (i > legato.releaseStart) releaseGain = Math.cos((i - legato.releaseStart) / legato.releaseFrames * Math.PI / 2);
    } else if (!ev.drum) releaseGain = (1 - Math.min(1, Math.max(0, time - seconds) / release)) ** 1.65;
    const envelope = releaseGain * expression * swell;
    const attack = legato?.attackFrames ? Math.sin(Math.min(1, i / legato.attackFrames) * Math.PI / 2)
      : Math.min(1, i / (sr * (startFrame ? 0.013 : 0.0004)));
    // Centre stable sur les prises stéréo, avec une image plus large au piano.
    const blend = piano ? 0.14 : 0.28;
    L[start + i] += (l + blend * (r - l)) * left * envelope * attack;
    R[start + i] += (r + blend * (l - r)) * right * envelope * attack;
    const slide = ev.articulation === 'slide' && (inst === 'acoustic-guitar' || electric) ? 1 - 0.108 * Math.exp(-time / 0.028) : 1;
    position += step * slide;
    if (sustain && position >= loopEnd) position = loopStart + overlap + (position - loopEnd);
  }
  return true;
}

module.exports = { loadBank, loadExtensionBank, loadCinematicBank, planSampleLegato, renderSamples };
