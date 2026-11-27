'use strict';

const { ui } = require('./language');

const { chordFromSymbol, parseKey } = require('./theory');
const { isMeter } = require('./music-clock');
const { readSectionSounds } = require('./section-sounds');
const { THEME_TREATMENTS } = require('./melodic-phrasing');
const PARTS = ['pad', 'bass', 'arp', 'drum', 'mel', 'counter', 'texture'];
const DEFAULT_PARTS = PARTS.filter((part) => part !== 'counter' && part !== 'texture');
const ARTICULATIONS = ['mute', 'slide', 'legato', 'swell', 'staccato', 'pizzicato'];

function readChord(value, label) {
  if (typeof value === 'string') {
    chordFromSymbol(value);
    return value;
  }
  if (Number.isInteger(value) && value >= 1 && value <= 7) return value - 1;
  throw new Error(ui(`${label} : degrés de 1 à 7 ou symboles d’accord attendus.`, `${label}: expected scale degrees from 1 to 7 or chord symbols.`));
}

function readBar(bar, label) {
  if (!Array.isArray(bar)) return readChord(bar, label);
  if (!bar.length || bar.length > 8) throw new Error(ui(`${label} : 1 à 8 accords par mesure attendus.`, `${label}: expected 1 to 8 chords per bar.`));
  let previous = -1;
  return bar.map((change, index) => {
    if (!change || !Number.isFinite(change.beat) || change.beat < 0 || change.beat > 3.75 ||
        (index === 0 && change.beat !== 0) || change.beat - previous < 0.25) {
      throw new Error(ui(
        `${label} : placer le premier accord au temps 0, avec au moins 0.25 temps entre les accords.`,
        `${label}: start the first chord at beat 0 and leave at least 0.25 beats between chords.`,
      ));
    }
    previous = change.beat;
    return { beat: change.beat, chord: readChord(change.chord, label) };
  });
}

function defaultSections(bars, loop, progA, progB) {
  const edges = !loop && bars >= 10 ? (bars >= 24 ? 4 : 2) : 0;
  const core = bars - edges * 2;
  const count = Math.max(1, Math.ceil(core / 8));
  const variants = count === 2 ? ['A', 'A′'] : ['A', 'B', 'A′', 'C', 'A′', 'B'];
  const sections = [];
  if (edges) {
    sections.push({ name: 'intro', bars: edges, prog: progA, energy: 0.55,
      theme: 'A', parts: ['pad', 'arp'] });
  }
  for (let i = 0; i < count; i++) {
    const name = i === count - 1 && count >= 3 ? 'A′' : variants[i % variants.length];
    const contrast = name === 'B' || name === 'C';
    sections.push({
      name, bars: Math.round((i + 1) * core / count) - Math.round(i * core / count),
      theme: name === 'A′' ? 'A' : name, prog: contrast ? progB : progA,
      energy: contrast ? 0.7 : 0.82 + 0.18 * (i + 1) / count, parts: DEFAULT_PARTS,
      variation: name === 'A′' ? 1 : 0, breakdown: contrast,
    });
  }
  if (edges) {
    sections.push({ name: 'outro', bars: edges, prog: progA, energy: 0.6,
      theme: 'A', parts: ['pad', 'bass', 'arp', 'mel'], outro: true });
  }
  return sections;
}

function readArrangement(input, bars, loop, progA, progB) {
  if (input === undefined) return { sections: defaultSections(bars, loop, progA, progB), custom: false };
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(ui('arrangement doit être un objet.', 'arrangement must be an object.'));
  }
  const { sections, motif } = input;
  if (motif !== undefined) validateMotif(motif);
  if (sections === undefined) return { sections: defaultSections(bars, loop, progA, progB), motif, custom: false };
  if (!Array.isArray(sections) || !sections.length || sections.length > 64) {
    throw new Error(ui('arrangement.sections attend 1 à 64 sections.', 'arrangement.sections requires 1 to 64 sections.'));
  }
  return {
    custom: true, motif,
    sections: sections.map((section, index) => {
      const label = `Section ${index + 1}`;
      if (!section || typeof section !== 'object' || Array.isArray(section)) throw new Error(ui(`${label} invalide.`, `Invalid ${label}.`));
      const { name = `Section ${index + 1}`, theme = 'A', bars, progression, parts = DEFAULT_PARTS,
        energy = 0.9, motif: sectionMotif, key: keyName, variation = 0, tempo, meter, theme_treatment } = section;
      if (typeof name !== 'string' || !name.trim() || name.length > 60) throw new Error(ui(`${label} : nom invalide.`, `${label}: invalid name.`));
      if (!['A', 'B', 'C'].includes(theme)) throw new Error(ui(`${label} : thème A, B ou C attendu.`, `${label}: expected theme A, B, or C.`));
      if (!Number.isInteger(bars) || bars < 1 || bars > 64) throw new Error(ui(`${label} : 1 à 64 mesures attendues.`, `${label}: expected 1 to 64 bars.`));
      if (!Number.isFinite(energy) || energy < 0.25 || energy > 1) throw new Error(ui(`${label} : énergie entre 0.25 et 1 attendue.`, `${label}: energy must be between 0.25 and 1.`));
      if (!Array.isArray(parts) || parts.some((part) => !PARTS.includes(part))) throw new Error(ui(`${label} : pupitre inconnu.`, `${label}: unknown part.`));
      const key = keyName === undefined ? undefined : parseKey(keyName);
      if (keyName !== undefined && !key) throw new Error(ui(`${label} : tonalité invalide.`, `${label}: invalid key.`));
      if (meter !== undefined && !isMeter(meter)) throw new Error(ui(`${label} : mesure invalide (ex. [3,4] ou [6,8]).`, `${label}: invalid time signature (for example [3,4] or [6,8]).`));
      if (tempo !== undefined && (!Number.isFinite(tempo) || tempo < 40 || tempo > 220)) throw new Error(ui(`${label} : tempo entre 40 et 220 attendu.`, `${label}: tempo must be between 40 and 220.`));
      if (!Number.isInteger(variation) || variation < 0 || variation > 3) throw new Error(ui(`${label} : variation de 0 à 3 attendue.`, `${label}: variation must be between 0 and 3.`));
      if (theme_treatment !== undefined && !THEME_TREATMENTS.includes(theme_treatment)) {
        throw new Error(ui(`${label} : theme_treatment attend ${THEME_TREATMENTS.join(', ')}.`, `${label}: theme_treatment must be one of ${THEME_TREATMENTS.join(', ')}.`));
      }
      let prog = theme === 'A' ? progA : progB;
      if (progression !== undefined) {
        if (!Array.isArray(progression) || !progression.length || progression.length > 64) {
          throw new Error(ui(`${label} : progression de 1 à 64 mesures attendue.`, `${label}: expected a progression of 1 to 64 bars.`));
        }
        prog = progression.map((bar) => readBar(bar, label));
      }
      if (sectionMotif !== undefined) validateMotif(sectionMotif);
      return { name: name.trim(), bars, theme, prog, parts, energy, motif: sectionMotif, key, variation, tempo, meter, theme_treatment,
        ...readSectionSounds(section, label) };
    }),
  };
}

function validateMotif(motif) {
  if (!Array.isArray(motif) || !motif.length || motif.length > 24) {
    throw new Error(ui('arrangement.motif attend 1 à 24 notes.', 'arrangement.motif requires 1 to 24 notes.'));
  }
  let end = 0;
  for (const note of motif) {
    const absolute = note?.midi !== undefined;
    if (!note || !Number.isFinite(note.beat) || !Number.isFinite(note.duration) ||
        note.beat < 0 || note.beat < end - 1e-9 || note.duration <= 0 || (!absolute && note.duration < 0.0625) || note.beat + note.duration > 8 ||
        (absolute ? note.degree !== undefined || !Number.isInteger(note.midi) || note.midi < 0 || note.midi > 127
          : !Number.isInteger(note.degree) || note.degree < -6 || note.degree > 15) ||
        (note.velocity !== undefined && (!Number.isFinite(note.velocity) || note.velocity < (absolute ? 1 / 127 : 0.05) || note.velocity > 1)) ||
        (note.articulation !== undefined && !ARTICULATIONS.includes(note.articulation))) {
      throw new Error(ui(
        'Le motif attend des notes ordonnées sans chevauchement, sur deux mesures, avec degree ou midi.',
        'Supply ordered, non-overlapping motif notes over two bars, using degree or midi.',
      ));
    }
    end = note.beat + note.duration;
  }
}

module.exports = { PARTS, ARTICULATIONS, readArrangement, validateMotif };
