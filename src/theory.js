'use strict';

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
  if (NOTE_ALIASES[s] !== undefined) return NOTE_ALIASES[s];
  return null;
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
  if (!SCALES[scaleId]) return null;
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

const SEVENTH_NAME = (triad, seventhInterval) => {
  // seventhInterval = top - bottom
  if (seventhInterval === 11) return triad === 'maj' ? 'maj7' : 'minMaj7';
  if (seventhInterval === 10) return triad === 'maj' ? '7' : triad === 'min' ? 'm7' : 'ø7';
  if (seventhInterval === 9) return triad === 'min' ? '6' : '6';
  return '7';
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
  let name = letter + TRIAD_SUFFIX[triad];
  if (opts.seventh) {
    const sev = notes[3] - notes[0];
    name += SEVENTH_NAME(triad, sev).replace(/^m(?=7)/, triad === 'min' ? 'm' : 'm');
    // normalise : min7 -> m7
    if (SEVENTH_NAME(triad, sev) === 'm7') name = letter + 'm7';
    else if (SEVENTH_NAME(triad, sev) === '7') name = letter + '7';
    else if (SEVENTH_NAME(triad, sev) === 'maj7') name = letter + 'maj7';
  }
  if (opts.ninth) name += 'add9';

  const romanBase = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'][((deg % L) + L) % L];
  let roman = triad === 'min' || triad === 'dim' ? romanBase.toLowerCase() : romanBase;
  if (triad === 'dim') roman += '°';
  if (opts.seventh) roman += '7';

  const pitchClasses = notes.map((n) => ((n % 12) + 12) % 12);
  return { deg, notes, pitchClasses, name, roman, quality: triad };
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
  isConsonantWith,
};
