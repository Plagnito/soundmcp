'use strict';

const { chordFromSymbol, parseKey, midiToFreq } = require('./theory');
const { hash32 } = require('./rng');

const ORCHESTRAL_PERCUSSION = ['none', 'march', 'drive'];
const ORCHESTRAL_DRUM_MIDI = { 'concert-bass-drum': 35, 'concert-snare': 38, 'frame-drum': 45,
  gong: 57, 'cymbal-swell': 57, 'orchestral-cymbals': 49 };
const TUNED_PERCUSSION = ['timpani', 'timpani-roll'];

function readOrchestralPercussion(value) {
  if (value !== undefined && !ORCHESTRAL_PERCUSSION.includes(value)) {
    throw new Error('orchestral_percussion attend none, march ou drive.');
  }
  return value;
}

function accents([pulses, denominator]) {
  if (denominator >= 8 && pulses === 7) return [0, 2, 4];
  if (denominator >= 8 && pulses === 5) return [0, 3];
  const group = denominator >= 8 && pulses % 3 === 0 ? 3 : 2;
  return Array.from({ length: Math.ceil(pulses / group) }, (_, i) => i * group);
}

function orchestralPart(section, song) {
  const meter = section.meter ?? [4, 4];
  const unit = 4 / meter[0];
  const groups = accents(meter);
  const driving = section.orchestral_percussion === 'drive';
  const energy = section.energy ?? .82;
  const first = section.startBar - 1;
  const stop = (first + section.bars) * 4;
  const fallback = parseKey(section.key ?? song.meta.key)?.root ?? 0;
  const events = [];

  for (let bar = 0; bar < section.bars; bar++) {
    const line = (section.harmony?.[bar] ?? []).map(({ beat, chord }) => ({ beat, pc: chordFromSymbol(chord).bassPc }));
    const base = (first + bar) * 4;
    const hit = (inst, at, duration, vel, pan = 0, fifth = false) => {
      const local = at * unit;
      const beat = base + local;
      const pc = line.findLast((change) => change.beat <= local)?.pc ?? fallback;
      const midi = 42 + (pc + (fifth ? 7 : 0) + 6) % 12;
      const id = events.length + 37;
      events.push({ t: beat, beat, dur: Math.min(duration * unit, stop - beat), midi, freq: midiToFreq(midi),
        vel: vel * (.58 + .42 * energy), pan, inst, bus: 'texture', orchestral: true,
        seedIdx: hash32(song.meta.seed, (first + bar) * 149 + id), take: id });
    };

    if (bar % 2 === 0 || driving && energy >= .66) hit('concert-bass-drum', 0, Math.min(meter[0], 2.1), bar === 0 ? .89 : .71);
    for (const [i, at] of groups.entries()) {
      hit('timpani', at, Math.min(1.5, meter[0] - at), i === 0 ? .91 : .67, i % 2 ? -.20 : .13, i % 2 === 1);
      if (i) hit('concert-snare', at, .49, driving ? .70 : .54, -.25);
      if (driving && at + .50 < meter[0]) hit('frame-drum', at + .50, .55, i % 2 ? .60 : .72, .27);
      if (driving && at + 1.50 < meter[0] && groups[i + 1] !== at + 1) hit('frame-drum', at + 1.50, .47, .51, -.31);
    }
    if (bar === 0 && energy >= .75) {
      hit('orchestral-cymbals', 0, Math.min(meter[0], 2.1), .68, .22);
      if (driving) hit('gong', 0, Math.min(meter[0], 3.5), .61, -.20);
    }
    const endOfPhrase = bar + 1 === section.bars || bar % 4 === 3;
    if (endOfPhrase && energy >= .61) {
      const begin = meter[0] * .55;
      const duration = meter[0] - begin - .04;
      hit('timpani-roll', begin, duration, .66, -.15);
      if (driving || bar + 1 === section.bars) hit('cymbal-swell', begin, duration, .46, .34);
    }
  }
  return events;
}

function applyOrchestralPercussion(song) {
  if (!song.meta.sections.some((section) => section.orchestral_percussion !== undefined)) return song;
  const replacement = new Set();
  const cues = [];
  const sections = song.meta.sections.map((section) => {
    const mode = section.orchestral_percussion;
    if (mode === undefined) return section;
    for (let i = 0; i < section.bars; i++) replacement.add(section.startBar - 1 + i);
    if (mode !== 'none') cues.push(...orchestralPart(section, song));
    const parts = section.parts.filter((part) => part !== 'drum');
    if (mode !== 'none' && !parts.includes('texture')) parts.push('texture');
    return { ...section, parts };
  });
  const events = song.events.filter((e) => !((e.bus === 'drum' || e.orchestral) && replacement.has(Math.floor((e.beat ?? e.t) / 4)))).concat(cues);
  return { ...song, events, meta: { ...song.meta, sections, instruments: [...new Set(events.map((e) => e.drum ? 'drum' : e.inst))] } };
}

module.exports = { ORCHESTRAL_PERCUSSION, ORCHESTRAL_DRUM_MIDI, TUNED_PERCUSSION, readOrchestralPercussion, applyOrchestralPercussion };
