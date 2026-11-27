'use strict';

const { ui } = require('./language');

/**
 * Théorie musicale : gammes, tonalités, accords.
 * Tout est en degrés d'échelle (0 = tonique) pour rester consonant
 * quelle que soit la gamme choisie.
 */

const SCALES = {
  major:          { degrees: [0, 2, 4, 5, 7, 9, 11], label: 'majeur',              labelEn: 'major' },
  minor:          { degrees: [0, 2, 3, 5, 7, 8, 10], label: 'mineur',              labelEn: 'minor' },
  dorian:         { degrees: [0, 2, 3, 5, 7, 9, 10], label: 'dorien',              labelEn: 'dorian' },
  mixolydian:     { degrees: [0, 2, 4, 5, 7, 9, 10], label: 'mixolydien',          labelEn: 'mixolydian' },
  lydian:         { degrees: [0, 2, 4, 6, 7, 9, 11], label: 'lydien',              labelEn: 'lydian' },
  phrygian:       { degrees: [0, 1, 3, 5, 7, 8, 10], label: 'phrygien',            labelEn: 'phrygian' },
  harmonicMinor:  { degrees: [0, 2, 3, 5, 7, 8, 11], label: 'mineur harmonique',   labelEn: 'harmonic minor' },
};

const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLATS  = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

const NOTE_ALIASES = {
  c: 0, 'c#': 1, db: 1, 'd': 2, 'd#': 3, eb: 3, e: 4, f: 5, 'f#': 6, gb: 6,
  g: 7, 'g#': 8, ab: 8, a: 9, 'a#': 10, bb: 10, b: 11,
  // noms français
  do: 0, 'do#': 1, re: 2, 're#': 3, mi: 4, fa: 5, 'fa#': 6, sol: 7, 'sol#': 8, la: 9, 'la#': 10, si: 11,
};

const MODE_ALIASES = {
  major: 'major', majeur: 'major', maj: 'major', ionien: 'major',
  minor: 'minor', mineur: 'minor', min: 'minor', 'minor natural': 'minor', aeolien: 'minor',
  dorian: 'dorian', dorien: 'dorian',
  mixolydian: 'mixolydian', mixolydien: 'mixolydian',
  lydian: 'lydian', lydien: 'lydian',
  phrygian: 'phrygian', phrygien: 'phrygian',
  harmonicminor: 'harmonicMinor', harmonicminor_: 'harmonicMinor',
  'harmonic minor': 'harmonicMinor', 'mineur harmonique': 'harmonicMinor',
};

/** midi -> fréquence (Hz) */
function midiToFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/** Nom de note (dièses par défaut). */
function midiToName(m, useFlats = false) {
  const pc = ((m % 12) + 12) % 12;
  const oct = Math.floor(m / 12) - 1;
  return (useFlats ? FLATS : SHARPS)[pc] + oct;
}

/** Parse "F#", "Db", "sol", ... -> pitch class (0-11) ou null. */
function parseNote(str) {
  if (!str) return null;
  const s = String(str).trim().toLowerCase();
  return Object.hasOwn(NOTE_ALIASES, s) ? NOTE_ALIASES[s] : null;
}

/**
 * Parse une tonalité : "A minor", "F# dorien", "C majeur", "la mineur", "F"...
 * Retourne { root: 0-11, scaleId } ou null.
 */
function parseKey(str) {
  if (!str) return null;
  const parts = String(str).trim().split(/\s+/);
  const root = parseNote(parts[0]);
  if (root === null) return null;
  let scaleId = 'minor';
  if (parts.length > 1) {
    const norm = parts.slice(1).join(' ').toLowerCase().replace(/[\s-]+/g, ' ').trim();
    scaleId = MODE_ALIASES[norm] || MODE_ALIASES[norm.replace(/\s/g, '')] || null;
    if (!scaleId) return null;
  }
  if (!Object.hasOwn(SCALES, scaleId)) return null;
  return { root, scaleId };
}

/** Degré d'échelle -> demi-tons depuis la tonique (degrés négatifs ou >7 autorisés). */
function degreeSemitone(scale, deg) {
  const L = scale.degrees.length;
  const oct = Math.floor(deg / L);
  const idx = ((deg % L) + L) % L;
  return scale.degrees[idx] + 12 * oct;
}

/** midi d'un degré : keyRootMidi + demi-tons du degré */
function degreeToMidi(keyRootMidi, scale, deg) {
  return keyRootMidi + degreeSemitone(scale, deg);
}

const TRIAD_QUALITY = (a, b) => {
  // a = 1er intervalle, b = 2e (demi-tons)
  if (a === 4 && b === 3) return 'maj';
  if (a === 3 && b === 4) return 'min';
  if (a === 3 && b === 3) return 'dim';
  if (a === 4 && b === 4) return 'aug';
  return 'sus';
};

const TRIAD_SUFFIX = { maj: '', min: 'm', dim: 'dim', aug: 'aug', sus: 'sus' };

/**
 * Construit un accord sur un degré de la gamme.
 * deg peut être négatif ou > 6 (enroule sur les octaves).
 * opts: { seventh: bool, ninth: bool }
 */
function chordFromDegree(keyRootMidi, scale, deg, opts = {}) {
  const L = scale.degrees.length;
  const rootDeg = deg;
  const thirdDeg = deg + 2;
  const fifthDeg = deg + 4;
  const notes = [
    degreeToMidi(keyRootMidi, scale, rootDeg),
    degreeToMidi(keyRootMidi, scale, thirdDeg),
    degreeToMidi(keyRootMidi, scale, fifthDeg),
  ];
  if (opts.seventh) notes.push(degreeToMidi(keyRootMidi, scale, deg + 6));
  if (opts.ninth) notes.push(degreeToMidi(keyRootMidi, scale, deg + 8));

  const a = notes[1] - notes[0];
  const b = notes[2] - notes[1];
  const triad = TRIAD_QUALITY(a, b);

  const pc = ((notes[0] % 12) + 12) % 12;
  const letter = SHARPS[pc];
  let suffix = TRIAD_SUFFIX[triad];
  if (opts.seventh) {
    const sev = notes[3] - notes[0];
    if (triad === 'dim' && sev === 10) suffix = 'ø7';
    else suffix += sev === 11 ? 'maj7' : '7';
  }
  if (opts.ninth) suffix += 'add9';
  const name = letter + suffix;

  const romanBase = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'][((deg % L) + L) % L];
  let roman = triad === 'min' || triad === 'dim' ? romanBase.toLowerCase() : romanBase;
  if (triad === 'dim') roman += '°';
  if (opts.seventh) roman += '7';

  const pitchClasses = notes.map((n) => ((n % 12) + 12) % 12);
  return { deg, notes, pitchClasses, name, roman, quality: triad };
}

const CHORD_INTERVALS = {
  '': [0, 4, 7], m: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8], sus2: [0, 2, 7], sus4: [0, 5, 7],
  '5': [0, 7, 12], '6': [0, 4, 7, 9], m6: [0, 3, 7, 9], add9: [0, 4, 7, 14], madd9: [0, 3, 7, 14],
  '7': [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], mMaj7: [0, 3, 7, 11],
  aug7: [0, 4, 8, 10], augmaj7: [0, 4, 8, 11], sus7: [0, 5, 7, 10], susmaj7: [0, 5, 7, 11],
  dim7: [0, 3, 6, 9], dimMaj7: [0, 3, 6, 11], m7b5: [0, 3, 6, 10], '7sus4': [0, 5, 7, 10],
  '7b9': [0, 4, 7, 10, 13], '7#9': [0, 4, 7, 10, 15], '9': [0, 4, 7, 10, 14],
  maj9: [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14],
  '11': [0, 4, 7, 10, 14, 17], m11: [0, 3, 7, 10, 14, 17], '13': [0, 4, 7, 10, 14, 21],
};

function chordFromSymbol(symbol) {
  const normalized = symbol.trim().replace(/♯/g, '#').replace(/♭/g, 'b');
  const match = /^([A-Ga-g][#b]?)([^/]*)(?:\/([A-Ga-g][#b]?))?$/.exec(normalized);
  if (!match) throw new Error(ui(`Accord invalide : ${symbol}.`, `Invalid chord: ${symbol}.`));
  const aliases = { M7: 'maj7', M9: 'maj9', 'Δ7': 'maj7', 'Δ9': 'maj9', min: 'm', min7: 'm7', min9: 'm9',
    mmaj7: 'mMaj7', dimmaj7: 'dimMaj7', 'º': 'dim', '°': 'dim', '°7': 'dim7', 'ø7': 'm7b5', '+': 'aug', sus: 'sus4' };
  const [, root, type, bass] = match;
  const extraNinth = type.endsWith('add9');
  const baseType = extraNinth ? type.slice(0, -4) : type;
  const suffix = Object.hasOwn(aliases, baseType) ? aliases[baseType] : baseType;
  if (!Object.hasOwn(CHORD_INTERVALS, suffix)) throw new Error(ui(`Accord non reconnu : ${symbol}.`, `Unrecognized chord: ${symbol}.`));
  const rootPc = parseNote(root);
  const intervals = CHORD_INTERVALS[suffix];
  const notes = (extraNinth ? [...new Set([...intervals, 14])] : intervals).map((interval) => 48 + rootPc + interval);
  return { notes, pitchClasses: [...new Set(notes.map((midi) => midi % 12))],
    name: normalized, roman: normalized, bassPc: bass ? parseNote(bass) : rootPc, explicit: true };
}

/** Intervalles de 7e pour choisir des colorations d'accord. */
function isConsonantWith(pitchClass, chordPcs) {
  return chordPcs.includes(pitchClass);
}

module.exports = {
  SCALES,
  SHARPS,
  FLATS,
  midiToFreq,
  midiToName,
  parseNote,
  parseKey,
  degreeSemitone,
  degreeToMidi,
  chordFromDegree,
  chordFromSymbol,
  isConsonantWith,
};
