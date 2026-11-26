'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createSong } = require('./composer');
const { INSTRUMENTS } = require('./dsp');
const { midiToFreq } = require('./theory');
const { PARTS } = require('./arrangement');
const { hash32 } = require('./rng');
const { musicClock } = require('./music-clock');
const { DRUMS, validExpression, writeMeasure } = require('./score-notes');
const { orchestra } = require('./arranger');
const { readSectionSounds } = require('./section-sounds');
const { validatePatches, isCustom, assignPatchRoles, normalizeGesture } = require('./custom-patch');
const { readPerformance } = require('./performance');
const { readRoom } = require('./virtual-room');
const { validateBuilds, shapeBuild, cropBuilds } = require('./build-shaping');

const EDITIONS = ['loop', 'calm', 'intense', 'transition'];
const PALETTES = ['synth', 'studio'];
const LEVELS = { calm: { drum: -12, bass: -5, mel: -3.5, arp: -3 }, intense: { drum: 4.5, bass: 2, arp: 3, pad: -2 } };

function writeProject(file, song, bit_depth) {
  const data = JSON.stringify({ type: 'soundmcp-score', version: 1, bit_depth, song });
  const temp = path.join(path.dirname(file), `.${randomUUID()}.json.tmp`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(temp, data);
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  return { path: file, format: 'project', bytes: Buffer.byteLength(data) };
}

function readProject(file) {
  if (fs.statSync(file).size > 32 * 1024 * 1024) throw new Error('Projet SoundMCP trop volumineux.');
  const project = JSON.parse(fs.readFileSync(file, 'utf8'));
  const song = project?.song;
  if (project?.type !== 'soundmcp-score' || project.version !== 1 || !song?.meta?.instrumental ||
      !PALETTES.includes(song.palette) || !Array.isArray(song.events) || !Array.isArray(song.meta.sections) ||
      !Number.isInteger(song.bars) || song.bars < 1 || song.totalBeats !== song.bars * 4 ||
      !Number.isFinite(song.bpm) || song.bpm < 40 || song.bpm > 220 || musicClock(song).seconds > 600 + 1e-8 ||
      (song.targetSeconds !== undefined && (!Number.isFinite(song.targetSeconds) || song.targetSeconds > 600 || song.targetSeconds + 1e-8 < musicClock(song).seconds))) {
    throw new Error('Projet SoundMCP invalide.');
  }
  validateBuilds(song.builds, song.totalBeats);
  const patches = validatePatches(song.patches);
  if (Object.keys(patches).length) song.patches = patches;
  if (song.performance !== undefined) song.performance = readPerformance(song.performance);
  if (song.room !== undefined) song.room = readRoom(song.room);
  for (const event of song.events) {
    const validNote = (Object.hasOwn(INSTRUMENTS, event?.inst) || (isCustom(event?.inst) && Object.hasOwn(patches, event.inst))) &&
      Number.isInteger(event.midi) && event.midi >= 0 && event.midi <= 127;
    const validDrum = event?.bus === 'drum' && event.inst === event.drum && DRUMS.includes(event.drum);
    if (!(event?.bus === 'drum' ? validDrum : validNote) || !PARTS.includes(event.bus) ||
        !Number.isFinite(event.t) || !Number.isFinite(event.dur) || event.t < 0 || event.dur < 0 ||
        !Number.isFinite(event.vel) || !Number.isFinite(event.pan) || Math.abs(event.pan) > 1 ||
        (event.expression !== undefined && !validExpression(event.expression)) ||
        (event.timbre !== undefined && (!Number.isFinite(event.timbre) || event.timbre < 0 || event.timbre > 1))) {
      throw new Error('Le projet contient un événement invalide.');
    }
    if (event.gesture !== undefined) event.gesture = normalizeGesture(event.gesture);
    if (validNote) event.freq = midiToFreq(event.midi);
  }
  for (const [i, section] of song.meta.sections.entries()) readSectionSounds(section, `Section ${i + 1}`);
  return project;
}

function sectionIndex(song, selector) {
  if (Number.isInteger(selector) && selector >= 1 && selector <= song.meta.sections.length) return selector - 1;
  const matches = song.meta.sections.flatMap((section, i) => section.name === selector ? [i] : []);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`La section ${selector} existe plusieurs fois. Utilise son numéro.`);
  throw new Error(`Section introuvable : ${selector}.`);
}

const beatOf = (event) => event.beat ?? event.t;
const gainFromDb = (db) => 10 ** (db / 20);
const withGain = (event, db) => ({ ...event, gain: (event.gain ?? 1) * gainFromDb(db) });

function replaceSection(song, index, patch, seed) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('La section de remplacement doit être un objet.');
  const old = song.meta.sections[index];
  const start = (old.startBar - 1) * 4;
  const stop = start + old.bars * 4;
  const { name, parts, energy, theme, theme_treatment, motif, variation, key = song.meta.key, tempo, meter, instruments, color, textures,
    orchestral_percussion } = old;
  const progression = old.harmony.map((bar) => bar.length === 1 ? bar[0].chord : bar);
  const replacement = { name, parts, energy, theme, theme_treatment, motif, variation, progression, tempo, meter, instruments, color, textures,
    orchestral_percussion, ...patch, bars: old.bars };
  let fragment = createSong({ style: song.meta.style, key, tempo: song.bpm, seed, loop: false, palette: song.palette, patches: song.patches,
    phrasing: song.meta.phrasing,
    arrangement: { sections: [replacement] } });
  if (song.meta.brief) {
    const local = fragment.meta.sections[0].instruments ?? {};
    const assignments = { ...song.instrumentAssignments, ...local };
    fragment = orchestra(fragment, assignments, song.meta.brief);
  }
  if (song.patchRoles) {
    const roles = Object.fromEntries(Object.entries(song.patchRoles).filter(([role]) => !Object.hasOwn(replacement.instruments ?? {}, role) &&
      fragment.events.some((e) => e.bus === role && e.inst !== 'sub')));
    if (Object.keys(roles).length) fragment = assignPatchRoles(fragment, roles, song.patches ?? {});
  }
  const preserved = song.events.filter((e) => beatOf(e) < start || beatOf(e) >= stop);
  const inserted = fragment.events.map((e) => ({ ...e, ...(fragment.bankVersion > (song.bankVersion ?? 1) ? { bankVersion: fragment.bankVersion } : {}),
    t: e.t + start, beat: beatOf(e) + start,
    dur: Math.min(e.dur, Math.max(0, stop - start - e.t)) }));
  const sections = song.meta.sections.map((section, i) => i === index
    ? { ...fragment.meta.sections[0], startBar: old.startBar, ...(replacement.key || old.key ? { key: replacement.key || old.key } : {}) }
    : section);
  const updates = {};
  if (index === song.meta.sections.findIndex((s) => s.theme === 'A' && s.parts.includes('mel'))) {
    updates.progression = fragment.meta.progression;
    updates.progressionRomans = fragment.meta.progressionRomans;
  }
  if (index === song.meta.sections.findIndex((s) => s.theme === 'B')) updates.progressionB = fragment.meta.progression;
  const next = { ...song, events: [...preserved, ...inserted], meta: { ...song.meta, ...updates, sections } };
  const seconds = musicClock(next).seconds;
  if (seconds > 600 + 1e-8) throw new Error('La partition retouchée dépasse 600 secondes.');
  if (next.targetSeconds < seconds - 1e-8) delete next.targetSeconds;
  next.meta.durationSeconds = Number(seconds.toFixed(2));
  return next;
}

function editSong(song, edits = []) {
  if (!Array.isArray(edits) || edits.length > 32) throw new Error('edits attend jusqu’à 32 retouches.');
  for (const [operation, edit] of edits.entries()) {
    if (!edit || !['gain', 'mute', 'replace_section', 'write_measure', 'shape_build'].includes(edit.type)) throw new Error('Type de retouche invalide.');
    if (edit.type === 'shape_build') {
      song = shapeBuild(song, edit);
      continue;
    }
    if (edit.type === 'write_measure') {
      song = writeMeasure(song, edit, hash32(song.meta.seed, operation + 10000));
      continue;
    }
    const index = sectionIndex(song, edit.section);
    if (edit.type === 'replace_section') {
      song = replaceSection(song, index, edit.replacement, hash32(song.meta.seed, operation + 8000));
      continue;
    }
    if (!PARTS.includes(edit.part)) throw new Error(`Pupitre inconnu : ${edit.part}.`);
    if (edit.type === 'gain' && (!Number.isFinite(edit.db) || edit.db < -60 || edit.db > 12)) throw new Error('db doit être entre -60 et 12.');
    const section = song.meta.sections[index];
    const first = (section.startBar - 1) * 4;
    const last = first + section.bars * 4;
    const selected = (ev) => ev.bus === edit.part && beatOf(ev) >= first && beatOf(ev) < last;
    if (!song.events.some(selected)) throw new Error(`Aucun événement du pupitre ${edit.part} dans ${section.name}.`);
    const events = edit.type === 'mute' ? song.events.filter((e) => !selected(e))
      : song.events.map((e) => selected(e) ? withGain(e, edit.db) : e);
    const sections = edit.type === 'mute' ? song.meta.sections.map((s, i) => i === index ? { ...s,
      parts: s.parts.filter((part) => part !== edit.part), ...(edit.part === 'texture' ? { textures: [],
        ...(s.orchestral_percussion === undefined ? {} : { orchestral_percussion: 'none' }) } : {}) } : s)
      : song.meta.sections;
    song = { ...song, events, meta: { ...song.meta, sections } };
  }
  if (!song.events.length) throw new Error('Le projet retouché est silencieux.');
  if (edits.length) {
    const actions = edits.map(({ type, section, part, bar, db, arrival_bar, before_bars, contour, amount }) =>
      ({ type, section, part, bar, db, arrival_bar, before_bars, contour, amount }));
    song = { ...song, history: [...(song.history ?? []), { action: 'edit', edits: actions }].slice(-60) };
  }
  return song;
}

function endingVariations(song, count) {
  if (!Number.isInteger(count) || count < 1 || count > 5) throw new Error('ending_variants attend de 1 à 5 fins.');
  const index = song.meta.sections.length - 1;
  const last = song.meta.sections[index];
  const patterns = [[5, 1], [4, 1], [6, 4, 5, 1], [2, 5, 1], [1, 4, 1]];
  return Array.from({ length: count }, (_, i) => {
    const pattern = patterns[i];
    const progression = Array.from({ length: last.bars }, (_, b) => pattern[(b + pattern.length - last.bars % pattern.length) % pattern.length]);
    const parts = [...new Set([...last.parts, 'mel'])];
    const energy = Math.max(0.38, Math.min(1, last.energy + [0, -0.15, 0.14, 0.07, -0.08][i]));
    const motif = last.bars === 1 ? [
      { beat: 0, degree: [5, 3, 8, 2, 4][i], duration: 0.8 },
      { beat: 1.5, degree: i === 2 ? 8 : 1, duration: 2.15 },
    ] : undefined;
    const next = replaceSection(song, index, { name: `${last.name.slice(0, 48)} · fin ${i + 1}`, progression,
      parts, energy, theme: ['A', 'B', 'C', 'A', 'B'][i], variation: i % 4, motif }, hash32(song.meta.seed, 9000 + i));
    return { ...next, loop: false, endFade: 1.4, history: [...(next.history ?? []), { action: 'ending', variant: i + 1 }].slice(-60),
      meta: { ...next.meta, loop: false } };
  });
}

function sliceSong(song, start, bars, loop = false) {
  if (!Number.isInteger(start) || start < 1 || !Number.isInteger(bars) || bars < 1 || start + bars - 1 > song.bars) {
    throw new Error('La région de boucle doit tenir dans la partition. start_bar commence à 1.');
  }
  const first = (start - 1) * 4;
  const last = first + bars * 4;
  const events = song.events.flatMap((ev) => {
    if (beatOf(ev) >= last || (beatOf(ev) < first && ev.t + ev.dur <= first)) return [];
    const onset = Math.max(0, ev.t - first);
    if (onset >= bars * 4) return [];
    return [{ ...ev, t: onset, beat: Math.max(0, beatOf(ev) - first), dur: Math.max(0, Math.min(ev.t + ev.dur, last) - first - onset) }];
  });
  if (!events.length) throw new Error('Aucune note dans la région de boucle.');
  const sections = song.meta.sections.flatMap((section) => {
    const lo = Math.max(start, section.startBar);
    const hi = Math.min(start + bars, section.startBar + section.bars);
    if (hi <= lo) return [];
    const offset = lo - section.startBar;
    const textures = section.textures?.filter(({ bar }) => bar > offset && bar <= offset + hi - lo)
      .map((texture) => ({ ...texture, bar: texture.bar - offset }));
    return [{ ...section, startBar: lo - start + 1, bars: hi - lo, ...(textures ? { textures } : {}),
      chords: section.chords.slice(offset, offset + hi - lo), harmony: section.harmony.slice(offset, offset + hi - lo) }];
  });
  const slice = { ...song, loop, endFade: loop ? 0 : 0.8, bars, totalBeats: bars * 4, events, targetSeconds: undefined,
    builds: cropBuilds(song.builds, first, last),
    meta: { ...song.meta, loop, bars, sections } };
  slice.meta.durationSeconds = Number(musicClock(slice).seconds.toFixed(2));
  return slice;
}

function getEditions(song, ids, region) {
  if (ids === undefined && region === undefined) return [];
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => !EDITIONS.includes(id)) || new Set(ids).size !== ids.length) {
    throw new Error(`editions attend une liste de formats parmi ${EDITIONS.join(', ')}.`);
  }
  const preferred = song.meta.sections.find((section) => section.parts.includes('mel') && section.bars >= 2);
  const { start_bar: start = preferred?.startBar ?? 1, bars = Math.min(8, preferred?.bars ?? song.bars) } = region ?? {};
  const slice = sliceSong(song, start, bars, true);
  const clock = musicClock(slice);
  const regionInfo = { startBar: start, endBar: start + bars - 1, bars, tempo: song.bpm,
    startSample: 0, samples: Math.round(clock.seconds * song.sr) };
  const transitionStart = Math.max(0, (bars - 2) * 4);
  return ids.map((id) => {
    const transition = id === 'transition';
    const events = id === 'loop' ? slice.events : slice.events.map((event) => {
      if (!transition) return withGain(event, LEVELS[id][event.bus] ?? 0);
      const blend = Math.min(1, Math.max(0, (beatOf(event) - transitionStart) / Math.max(0.25, slice.totalBeats - transitionStart - 0.5)));
      const low = LEVELS.calm[event.bus] ?? 0;
      return withGain(event, low + blend * ((LEVELS.intense[event.bus] ?? 0) - low));
    });
    return { id, region: { ...regionInfo, ...(transition ? { from: 'calm', to: 'intense', riseStartSample: Math.round(clock.at(transitionStart) * song.sr) } : {}) },
      song: { ...slice, events, ...(transition ? { loop: false, targetSeconds: clock.seconds, meta: { ...slice.meta, loop: false } } : {}) } };
  });
}

module.exports = { EDITIONS, PALETTES, writeProject, readProject, editSong, endingVariations, getEditions, sliceSong, sectionIndex };
