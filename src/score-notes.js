'use strict';

const { ui } = require('./language');

const { ARTICULATIONS, PARTS } = require('./arrangement');
const { INSTRUMENTS } = require('./dsp');
const { parseNote, midiToFreq, parseKey, SCALES, degreeSemitone } = require('./theory');
const { hash32 } = require('./rng');
const { TEXTURES } = require('./section-sounds');
const { isCustom, normalizeGesture, supportsGesture, GESTURE_PATCH_ERROR } = require('./custom-patch');

const DRUMS = ['kick', 'snare', 'hat', 'ohat', 'clap', 'shaker', 'tom', 'ride', 'crash'];
const DEFAULT_INSTRUMENT = { pad: 'strings', bass: 'upright', arp: 'acoustic-guitar', mel: 'piano', counter: 'clarinet', texture: 'tape-air' };

function noteNumber(note) {
  if (Number.isInteger(note) && note >= 0 && note <= 127) return note;
  const match = typeof note === 'string' && /^([A-Ga-g][#b♭♯]?)(-1|\d)$/.exec(note.trim());
  if (!match) throw new Error(ui(`Note invalide : ${note}. Utilise C4, Bb3 ou un nombre MIDI.`, `Invalid note: ${note}. Use C4, Bb3, or a MIDI number.`));
  const symbol = match[1].replace('♭', 'b').replace('♯', '#');
  // Une altération à la frontière change l’octave, par exemple Cb4 = B3.
  const midi = 12 * (Number(match[2]) + 1) + parseNote(symbol[0]) + ({ '#': 1, b: -1 }[symbol[1]] ?? 0);
  if (midi < 0 || midi > 127) throw new Error(ui(`Note hors de la plage MIDI : ${note}.`, `Note outside the MIDI range: ${note}.`));
  return midi;
}

function validExpression(values) {
  return Array.isArray(values) && values.length === 2 && values.every((value) => Number.isFinite(value) && value >= 0.15 && value <= 1.6);
}

function writeMeasure(song, edit, seed) {
  const { bar, part, notes, instrument } = edit;
  if (!Number.isInteger(bar) || bar < 1 || bar > song.bars || !PARTS.includes(part) || !Array.isArray(notes) || notes.length > 64) {
    throw new Error(ui('write_measure attend une mesure existante, un pupitre et jusqu’à 64 notes.', 'write_measure requires an existing bar, a part, and up to 64 notes.'));
  }
  const first = (bar - 1) * 4;
  const last = first + 4;
  const section = song.meta.sections.find((s) => bar >= s.startBar && bar < s.startBar + s.bars);
  const unit = 4 / (section?.meter?.[0] ?? 4);
  const reference = song.events.find((e) => e.bus === part && (e.beat ?? e.t) >= first && (e.beat ?? e.t) < last)
    ?? song.events.find((e) => e.bus === part);
  const inst = instrument ?? reference?.inst ?? DEFAULT_INSTRUMENT[part];
  const percussion = part === 'drum';
  const custom = isCustom(inst) && Object.hasOwn(song.patches ?? {}, inst);
  if (!percussion && !custom && (!Object.hasOwn(INSTRUMENTS, inst) || (part === 'texture') !== TEXTURES.includes(inst))) {
    throw new Error(ui(`Instrument inconnu ou pupitre incompatible : ${inst}.`, `Unknown instrument or incompatible part: ${inst}.`));
  }
  const key = parseKey(section?.key ?? song.meta.key);
  const scale = SCALES[key.scaleId];
  const make = (note, i) => {
    if (!note || !Number.isFinite(note.beat) || note.beat < 0 || note.beat * unit >= 4) throw new Error(ui('beat doit être à l’intérieur de la mesure.', 'beat must be within the bar.'));
    const { duration = 0.5, velocity = 0.72, articulation, expression, pan = reference?.pan ?? (part === 'counter' ? -0.22 : 0), timbre } = note;
    const gesture = normalizeGesture(note.gesture);
    if (gesture && !supportsGesture(song.patches?.[inst])) throw new Error(GESTURE_PATCH_ERROR);
    if (!percussion && (!Number.isFinite(duration) || duration < 0.025 || duration > 32)) throw new Error(ui('Durée de note invalide.', 'Invalid note duration.'));
    if (!Number.isFinite(velocity) || velocity < 0.05 || velocity > 1 ||
      (articulation !== undefined && ![...ARTICULATIONS, ...(percussion ? ['ghost'] : [])].includes(articulation)) ||
      (expression !== undefined && !validExpression(expression)) || !Number.isFinite(pan) || Math.abs(pan) > 1 ||
      (timbre !== undefined && (!Number.isFinite(timbre) || timbre < 0 || timbre > 1))) throw new Error(ui('Nuance, articulation, panoramique ou timbre invalide.', 'Invalid velocity, articulation, pan, or timbre.'));
    const t = first + note.beat * unit;
    const shared = { t, beat: t, dur: percussion ? 0 : Math.min(duration * unit, song.totalBeats - t),
      vel: velocity, pan, bus: part, ...(timbre === undefined ? {} : { timbre }),
      ...(articulation ? { articulation } : {}), ...(expression ? { expression } : {}), ...(gesture ? { gesture } : {}), take: i };
    if (percussion) {
      if (!DRUMS.includes(note.hit)) throw new Error(ui(`Percussion inconnue : ${note.hit}.`, `Unknown drum hit: ${note.hit}.`));
      return [{ ...shared, inst: note.hit, drum: note.hit, kit: reference?.kit ?? 'acoustic', seedIdx: hash32(seed, i) }];
    }
    let pitches = note.pitches ?? (note.pitch === undefined ? undefined : [note.pitch]);
    if (part === 'texture' && pitches === undefined && note.degree === undefined) pitches = [48 + key.root];
    if (pitches === undefined && Number.isInteger(note.degree) && note.degree >= -13 && note.degree <= 22) {
      const root = (part === 'bass' ? 36 : 60) + key.root;
      pitches = [root + degreeSemitone(scale, note.degree - 1)];
    }
    if (!Array.isArray(pitches) || !pitches.length || pitches.length > 8) throw new Error(ui('Indique pitch, pitches ou degree pour chaque note.', 'Supply pitch, pitches, or degree for each note.'));
    return [...new Set(pitches.map(noteNumber))].map((midi, n) => ({ ...shared, inst, midi,
      ...(instrument ? { bankVersion: 3 } : {}), freq: midiToFreq(midi), seedIdx: hash32(seed, i * 9 + n) }));
  };
  const inserted = notes.flatMap(make);
  const events = song.events.filter((e) => e.bus !== part || (e.beat ?? e.t) < first || (e.beat ?? e.t) >= last).concat(inserted);
  const sections = song.meta.sections.map((s) => s !== section ? s : { ...s, parts: [...new Set([...s.parts, ...(inserted.length ? [part] : [])])] });
  return { ...song, events, meta: { ...song.meta, sections } };
}

module.exports = { DRUMS, noteNumber, validExpression, writeMeasure };
