'use strict';

const { ui } = require('./language');

const { createSong } = require('./composer');
const { sliceSong, sectionIndex } = require('./music-project');
const { musicClock } = require('./music-clock');
const { hash32 } = require('./rng');
const { orchestra } = require('./arranger');

function anchor(song) {
  return song.meta.sections.find((s) => s.name === 'Thème' && s.parts.includes('mel'))
    ?? song.meta.sections.find((s) => s.parts.includes('mel')) ?? song.meta.sections[0];
}

function excerpt(song, { section, region, max_seconds: max = 18 } = {}) {
  if (!Number.isFinite(max) || max < 4 || max > 45) throw new Error(ui('max_seconds attend 4 à 45 secondes.', 'max_seconds must be between 4 and 45 seconds.'));
  if (section !== undefined && region !== undefined) throw new Error(ui('Choisis une section ou une plage de mesures.', 'Choose a section or a bar range.'));
  const selected = section === undefined ? anchor(song) : song.meta.sections[sectionIndex(song, section)];
  const start = region?.start_bar ?? selected.startBar;
  const limit = section !== undefined ? selected.bars : song.bars - start + 1;
  const explicit = region?.bars;
  if (!Number.isInteger(start) || start < 1 || start > song.bars || (region !== undefined && (!Number.isInteger(explicit) || explicit < 1 || explicit > limit))) {
    throw new Error(ui('Plage de préécoute invalide.', 'Invalid preview range.'));
  }
  const first = (start - 1) * 4;
  const clock = musicClock(song);
  const from = clock.at(first);
  let count = 0;
  for (let n = 1; n <= (explicit ?? limit); n++) {
    if (n > 1 && clock.at(first + n * 4) - from > max - 0.65) break;
    count = n;
  }
  const preview = sliceSong(song, start, count);
  const body = musicClock(preview).seconds;
  preview.targetSeconds = body + Math.min(1.1, Math.max(0.5, max - body));
  preview.endFade = 0.65;
  preview.sr = 44100;
  return { song: preview, region: { startBar: start, bars: count, section: selected.name } };
}

function combine(song, pieces) {
  let bars = 0;
  const sections = [], events = [], builds = [];
  for (const piece of pieces) {
    const shift = bars * 4;
    sections.push(...piece.meta.sections.map((s) => ({ ...s, startBar: s.startBar + bars })));
    events.push(...piece.events.map((e) => ({ ...e, t: e.t + shift, beat: (e.beat ?? e.t) + shift })));
    builds.push(...(piece.builds ?? []).map((b) => ({ ...b, start: b.start + shift, arrival: b.arrival + shift,
      from: b.from + shift, to: b.to + shift })));
    bars += piece.bars;
  }
  return { ...song, bars, totalBeats: bars * 4, loop: false, events, builds: builds.length ? builds : undefined, endFade: 0.8,
    meta: { ...song.meta, sections, bars, loop: false } };
}

function cutMusic(song, seconds) {
  if (![15, 30, 60].includes(seconds)) throw new Error(ui('Une édition courte dure 15, 30 ou 60 secondes.', 'A short edit must be 15, 30, or 60 seconds long.'));
  const hook = anchor(song);
  const tempo = hook.tempo ?? song.bpm;
  const parts = [...new Set([...hook.parts.filter((p) => p !== 'drum' && p !== 'counter'), 'mel'])];
  const instruments = Object.fromEntries(Object.entries(hook.instruments ?? {}).filter(([part]) => part !== 'texture' && parts.includes(part)));
  let ending = createSong({ style: song.meta.style, key: hook.key ?? song.meta.key, seed: hash32(song.meta.seed, seconds),
    tempo: song.bpm, loop: false, palette: song.palette, patches: song.patches, phrasing: song.meta.phrasing, arrangement: { sections: [{ name: 'Cadence', bars: 1,
      parts, tempo: hook.tempo, meter: hook.meter, energy: 0.67,
      ...(Object.keys(instruments).length ? { instruments } : {}), ...(hook.color ? { color: hook.color } : {}),
      progression: [[{ beat: 0, chord: 5 }, { beat: 2, chord: 1 }]],
      motif: [{ beat: 0, degree: 5, duration: 1.42 }, { beat: 2, degree: 1, duration: 1.72 }] }] } });
  const plan = song.meta.brief ?? { excluded: [], solo: false, pizzicato: false };
  ending = orchestra(ending, { ...song.instrumentAssignments, ...instruments }, plan);
  const endingSeconds = musicClock(ending).seconds;
  const pieces = [];
  const clock = musicClock(song);
  const start = hook.startBar;
  const first = (start - 1) * 4;
  const from = clock.at(first);
  const available = Math.max(1, song.bars - start + 1 - (song.meta.sections.at(-1)?.name === 'Cadence' && start !== song.meta.sections.at(-1).startBar ? song.meta.sections.at(-1).bars : 0));
  let remaining = seconds - endingSeconds - 0.72;
  for (let pass = 0; pass < 64 && remaining > 0; pass++) {
    const limit = pass === 0 ? available : Math.min(hook.bars, available);
    let count = 0;
    for (let n = 1; n <= limit; n++) {
      if (clock.at(first + n * 4) - from > remaining + 1e-8) break;
      count = n;
    }
    if (!count) break;
    const fragment = sliceSong(song, start, count);
    pieces.push(fragment);
    remaining -= musicClock(fragment).seconds;
    if (count < limit) break;
  }
  pieces.push(ending);
  const result = combine(song, pieces);
  const duration = musicClock(result).seconds;
  if (duration > seconds + 1e-8) throw new Error(ui(`Une mesure à ${tempo} BPM dépasse ${seconds} s.`, `A bar at ${tempo} BPM lasts longer than ${seconds} s.`));
  return { ...result, targetSeconds: seconds, meta: { ...result.meta, durationSeconds: Number(duration.toFixed(2)), cutSeconds: seconds } };
}

module.exports = { excerpt, cutMusic };
