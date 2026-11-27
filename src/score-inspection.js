'use strict';

const { ui } = require('./language');

const { PARTS } = require('./arrangement');
const { COMMON_METER, musicClock } = require('./music-clock');
const { performEvents } = require('./performance');

function inspectScore(song, { start_bar: start = 1, bars = Math.min(4, song.bars - start + 1), part, offset = 0, limit = 160 }) {
  if (!Number.isInteger(start) || start < 1 || start > song.bars || !Number.isInteger(bars) || bars < 1 ||
      bars > 12 || start + bars - 1 > song.bars || (part !== undefined && !PARTS.includes(part))) {
    throw new Error(ui('Indique une plage de 1 à 12 mesures existantes et, si nécessaire, un pupitre.', 'Provide a range of 1 to 12 existing bars and a part if needed.'));
  }
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 512) {
    throw new Error(ui('offset doit être positif ou nul, limit doit être entre 1 et 512.', 'offset must be zero or greater, and limit must be between 1 and 512.'));
  }
  const clock = musicClock(song);
  const measures = Array.from({ length: bars }, (_, i) => {
    const bar = start + i;
    const section = song.meta.sections.find((s) => s.startBar <= bar && bar < s.startBar + s.bars);
    const from = (bar - 1) * 4;
    const meter = section?.meter ?? COMMON_METER;
    const units = meter[0] / 4;
    const harmony = section?.harmony?.[bar - section.startBar] ?? [];
    return { bar, from_seconds: clock.at(from), to_seconds: clock.at(from + 4), meter, tempo: section?.tempo ?? song.bpm,
      key: section?.key ?? song.meta.key, section: section?.name, parts: section?.parts ?? [], color: section?.color,
      chords: harmony.map(({ beat, chord }) => ({ beat: beat * units, chord })) };
  });
  const played = performEvents(song, clock);
  const matches = song.events.flatMap((event, index) => {
    const beat = event.beat ?? event.t;
    const bar = Math.floor(beat / 4) + 1;
    if (bar < start || bar >= start + bars || (part !== undefined && part !== event.bus)) return [];
    return [{ event, played: played[index], beat, bar }];
  }).sort((a, b) => a.beat - b.beat || a.event.t - b.event.t || (a.event.midi ?? 0) - (b.event.midi ?? 0));
  const events = matches.slice(offset, offset + limit).map(({ event, played, beat, bar }) => {
    const from = (bar - 1) * 4;
    const units = measures[bar - start].meter[0] / 4;
    const { midi, bus, inst, drum, dur, vel, pan, timbre, articulation, expression, gesture, gain } = event;
    return { bar, part: bus, instrument: inst, beat: (beat - from) * units, duration: dur * units,
      ...(drum ? { hit: drum } : { pitch: midi }), velocity: vel, pan, timbre, articulation, expression, gesture, gain,
      played: { beat: (played.t - from) * units, seconds: clock.at(played.t), velocity: played.vel,
        gate_seconds: clock.at(played.t + played.dur * (articulation === 'staccato' ? 0.57 : 1)) - clock.at(played.t) } };
  });
  return { title: song.meta.title, start_bar: start, bars, part, measures, events, offset,
    event_count: matches.length, next_offset: offset + events.length < matches.length ? offset + events.length : null };
}

module.exports = { inspectScore };
