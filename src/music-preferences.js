'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const CHOICES = { accompaniment: 'discreet', breath: 'spaced' };
const PREFERENCES = Object.keys(CHOICES);
const SECONDARY = ['arp', 'pad', 'counter'];
const ACCOMPANIMENT_DB = -3;
const BREATH_RATIO = 0.84;
const ACCOMPANIMENT_GAIN = 10 ** (ACCOMPANIMENT_DB / 20);
const PROFILE = 'soundmcp-preferences';
const COMPARISON = 'soundmcp-choice-comparison';
const beatOf = (event) => event.beat ?? event.t;

function smallJson(file) {
  if (typeof file !== 'string' || !file.trim()) throw new Error('Un chemin de fichier SoundMCP est requis.');
  if (fs.statSync(file).size > 64 * 1024) throw new Error('Fichier de préférences ou de comparaison trop volumineux.');
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function readPreferences(file, optional = false) {
  if (optional && !fs.existsSync(file)) return {};
  const payload = smallJson(file);
  const { choices } = payload ?? {};
  if (payload?.type !== PROFILE || payload.version !== 1 || !choices || typeof choices !== 'object' || Array.isArray(choices) ||
      Object.entries(choices).some(([name, value]) => !Object.hasOwn(CHOICES, name) || !['normal', CHOICES[name]].includes(value))) {
    throw new Error('Fichier de préférences SoundMCP invalide.');
  }
  return choices;
}

function applyPreference(song, name, option, range) {
  if (!Object.hasOwn(CHOICES, name) || !['normal', CHOICES[name]].includes(option)) throw new Error('Choix de préférence inconnu.');
  const active = option !== 'normal';
  const covers = ({ startBar, bars }, event) => {
    const from = (startBar - 1) * 4;
    return beatOf(event) >= from && beatOf(event) < from + bars * 4;
  };
  let changed = false;
  const events = song.events.map((event) => {
    if (range && !covers(range, event)) return event;
    if (name === 'accompaniment' && SECONDARY.includes(event.bus)) {
      const applied = event.preferenceGainDb === ACCOMPANIMENT_DB;
      if (applied === active) return event;
      changed = true;
      if (active) return { ...event, gain: (event.gain ?? 1) * ACCOMPANIMENT_GAIN, preferenceGainDb: ACCOMPANIMENT_DB };
      const { preferenceGainDb, ...clean } = event;
      return { ...clean, gain: (event.gain ?? 1) / ACCOMPANIMENT_GAIN };
    }
    if (name === 'breath' && event.bus === 'mel') {
      const applied = event.preferenceGateRatio === BREATH_RATIO;
      if (applied === active || (active && event.dur < 0.28)) return event;
      changed = true;
      if (active) return { ...event, dur: event.dur * BREATH_RATIO, preferenceGateRatio: BREATH_RATIO };
      const { preferenceGateRatio, ...clean } = event;
      return { ...clean, dur: event.dur / BREATH_RATIO };
    }
    return event;
  });
  if (!changed) return song;
  return { ...song, events, history: [...(song.history ?? []), { action: 'preference', criterion: name, choice: option }].slice(-60) };
}

function withPreferences(song, choices) {
  for (const [name, option] of Object.entries(choices)) song = applyPreference(song, name, option);
  return song;
}

function choiceManifest(criterion, takes) {
  return { type: COMPARISON, version: 1, criterion, takes };
}

function rememberChoice(comparisonFile, selected, profileFile) {
  if (selected !== 'A' && selected !== 'B') throw new Error('chosen attend A ou B.');
  const comparison = smallJson(comparisonFile);
  const { criterion, takes } = comparison ?? {};
  if (comparison?.type !== COMPARISON || comparison.version !== 1 || !Object.hasOwn(CHOICES, criterion) ||
      !Array.isArray(takes) || takes.length !== 2 || !['A', 'B'].every((label) => takes.some((take) => take?.label === label)) ||
      !['normal', CHOICES[criterion]].every((option) => takes.some((take) => take?.option === option))) {
    throw new Error('Fichier de comparaison de préférences invalide.');
  }
  if (typeof profileFile !== 'string' || !profileFile.trim()) throw new Error('Un chemin de préférences est requis.');
  const option = takes.find((take) => take.label === selected).option;
  const target = path.resolve(profileFile);
  if (target === path.resolve(comparisonFile)) throw new Error('Utilise un chemin distinct pour le profil de préférences.');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const lock = `${target}.lock`;
  let handle;
  try {
    handle = fs.openSync(lock, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Ce profil est en cours de mise à jour. Réessaie dans un instant.');
    throw error;
  }
  const temporary = path.join(path.dirname(target), `.${randomUUID()}.json.tmp`);
  try {
    const choices = { ...readPreferences(target, true), [criterion]: option };
    fs.writeFileSync(temporary, `${JSON.stringify({ type: PROFILE, version: 1, choices }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, target);
    return { profile_path: target, criterion, choice: option, choices };
  } finally {
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    } finally {
      fs.closeSync(handle);
      fs.unlinkSync(lock);
    }
  }
}

module.exports = { CHOICES, PREFERENCES, readPreferences, applyPreference, withPreferences, choiceManifest, rememberChoice };
