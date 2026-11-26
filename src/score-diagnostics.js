'use strict';

const { performEvents } = require('./performance');

const BACKING = new Set(['pad', 'arp', 'bass']);
const INTERVALS = [-13, -1, 1, 13];
const MIN_SECONDS = .22;
const MAX_DETAILS = 12;
const rounded = (n) => Number(n.toFixed(3));

function reportOverlaps(song, clock) {
  const notes = performEvents(song, clock).flatMap((event) => {
    const melody = event.bus === 'mel';
    if ((!melody && !BACKING.has(event.bus)) || !Number.isInteger(event.midi) || event.drum ||
      event.vel * (event.gain ?? 1) < (melody ? .20 : .11)) return [];
    const from = clock.at(event.t);
    const gate = event.articulation === 'staccato' ? .57 : 1;
    const to = clock.at(event.t + event.dur * gate);
    const end = event.inst === 'acoustic-guitar' && event.articulation === 'mute' ? Math.min(to, from + .13) : to;
    return end - from >= MIN_SECONDS ? [{ melody, event, from, end }] : [];
  }).sort((a, b) => a.from - b.from);

  const lead = new Map(), backing = new Map();
  const details = [];
  const byMeasure = new Map();
  let total = 0;
  const describe = ({ event }) => ({ part: event.bus, instrument: event.inst, pitch: event.midi,
    bar: 1 + Math.floor((event.beat ?? event.t) / 4) });

  for (const note of notes) {
    const { midi } = note.event;
    const previous = note.melody ? backing : lead;
    for (const interval of INTERVALS) {
      const pitch = midi + interval;
      const voices = previous.get(pitch);
      if (!voices) continue;
      const active = [];
      for (const earlier of voices) {
        if (earlier.end < note.from + MIN_SECONDS) continue;
        active.push(earlier);
        const bar = 1 + Math.floor((note.event.beat ?? note.event.t) / 4);
        const overlap = Math.min(note.end, earlier.end) - note.from;
        total++;
        byMeasure.set(bar, (byMeasure.get(bar) ?? 0) + 1);
        if (details.length === MAX_DETAILS && overlap <= details.at(-1).overlap) continue;
        details.push({ bar, seconds: rounded(note.from), overlapSeconds: rounded(overlap), semitones: Math.abs(interval),
          melody: describe(note.melody ? note : earlier), backing: describe(note.melody ? earlier : note), overlap });
        details.sort((a, b) => b.overlap - a.overlap || a.seconds - b.seconds);
        if (details.length > MAX_DETAILS) details.pop();
      }
      if (active.length) previous.set(pitch, active);
      else previous.delete(pitch);
    }
    const own = note.melody ? lead : backing;
    const samePitch = (own.get(midi) ?? []).filter((earlier) => earlier.end >= note.from + MIN_SECONDS);
    own.set(midi, [...samePitch, note]);
  }
  return { total, minimumSeconds: MIN_SECONDS,
    bars: [...byMeasure].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, MAX_DETAILS).map(([bar, count]) => ({ bar, count })),
    examples: details.map(({ overlap, ...entry }) => entry) };
}

module.exports = { reportOverlaps };
