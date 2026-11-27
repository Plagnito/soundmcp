'use strict';

const { ui } = require('./language');

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const ROLES = {
  mel: { delay: 0.013, timing: 1, accents: 1, gate: 1 },
  counter: { delay: 0.025, timing: 0.8, accents: 0.75, gate: 0.9 },
  pad: { delay: 0.028, timing: 0.65, accents: 0.65, gate: 0.5 },
  arp: { delay: 0.005, timing: 0.62, accents: 0.77, gate: 0.85 },
  bass: { delay: -0.009, timing: 0.31, accents: 0.55, gate: 0.36 },
  drum: { delay: 0, timing: 0.22, accents: 0.5, gate: 0 },
  texture: { delay: 0.019, timing: 0.24, accents: 0.33, gate: 0.33 },
};

function readPerformance(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((k) => k !== 'amount' && k !== 'parts')) throw new Error(ui('performance attend amount et parts.', 'performance accepts amount and parts.'));
  const { amount = 0.72, parts = Object.keys(ROLES).filter((part) => part !== 'texture') } = value;
  if (!Number.isFinite(amount) || amount < 0 || amount > 1 || !Array.isArray(parts) || !parts.length ||
      parts.some((part) => !Object.hasOwn(ROLES, part)) || new Set(parts).size !== parts.length) throw new Error(ui('performance attend une intensité de 0 à 1 et des pupitres distincts.', 'performance requires an intensity from 0 to 1 and distinct parts.'));
  return { amount, parts };
}

function groupsFor(events) {
  const groups = [];
  const beatOf = (event) => event.beat ?? event.t;
  for (const event of [...events].sort((a, b) => beatOf(a) - beatOf(b))) {
    const beat = beatOf(event);
    const last = groups.at(-1);
    if (last && beat === last.beat) {
      last.events.push(event);
      last.end = Math.max(last.end, event.t + event.dur);
    } else groups.push({ beat, end: event.t + event.dur, events: [event] });
  }
  return groups;
}

function phrasesFor(groups, clock, sections) {
  const phrases = [];
  let phrase, previous, section;
  for (const [index, group] of groups.entries()) {
    const current = sections.find(({ start, end }) => group.beat >= start && group.beat < end);
    if (!phrase || section !== current || group.beat - phrase[0].beat >= 8 ||
        clock.at(group.beat) - clock.at(previous.end) > 0.73) {
      phrase = [];
      phrases.push(phrase);
    }
    group.section = current;
    group.previousBeat = groups[index - 1]?.beat;
    group.nextBeat = groups[index + 1]?.beat;
    phrase.push(group);
    previous = group;
    section = current;
  }
  return phrases;
}

function performEvents(song, clock) {
  const { performance } = song;
  if (!performance?.amount) return song.events;
  const sections = (song.meta?.sections ?? []).map((section) => ({
    start: (section.startBar - 1) * 4, end: (section.startBar + section.bars - 1) * 4,
  }));
  const performed = new Map();
  for (const part of performance.parts) {
    const feel = ROLES[part];
    const groups = groupsFor(song.events.filter((event) => event.bus === part));
    const phrases = phrasesFor(groups, clock, sections);
    for (const phrase of phrases) {
      for (const [index, group] of phrase.entries()) {
        const first = index === 0, last = index === phrase.length - 1;
        const multiple = phrase.length > 1;
        const progress = multiple ? index / (phrase.length - 1) : 0.5;
        const arch = multiple ? Math.sin(Math.PI * progress) : 0.15;
        const strain = first ? -0.009 : last ? 0.028 : -0.019 * arch;
        const accent = first ? 0.12 : last ? -0.16 : 0.15 * arch;
        const end = group.section?.end ?? song.totalBeats;
        const start = group.section?.start ?? 0;
        const maxEarly = Math.min(0.25, (group.beat - (group.previousBeat ?? start)) * 0.23);
        const maxLate = Math.min(0.25, ((group.nextBeat ?? end) - group.beat) * 0.23);
        const localRate = (clock.at(group.beat + 0.001) - clock.at(group.beat)) * 1000;
        const shift = performance.amount * (feel.delay + strain * feel.timing) / localRate;
        const delta = clamp(shift, -Math.max(0, maxEarly), Math.max(0, maxLate));
        for (const event of group.events) {
          const t = clamp(event.t + delta, Math.min(start, event.t), Math.min(song.totalBeats, Math.max(event.t, end - 0.002)));
          const pause = last ? -0.14 : 0.065 * arch;
          const dur = event.dur ? Math.min(song.totalBeats - t, event.dur * (1 + pause * feel.gate * performance.amount)) : 0;
          const vel = clamp(event.vel * (1 + accent * feel.accents * performance.amount), 0.02, 1);
          const amount = feel.accents * performance.amount;
          const expression = event.expression ?? (event.dur > 0.35 ? [1 - 0.09 * amount, 1 + (last ? -0.22 : 0.18) * amount] : undefined);
          performed.set(event, { ...event, t, dur, vel, ...(expression ? { expression } : {}) });
        }
      }
    }
  }
  return song.events.map((event) => performed.get(event) ?? event);
}

module.exports = { readPerformance, performEvents };
