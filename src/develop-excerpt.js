'use strict';

const { ui } = require('./language');
const { COMMON_METER } = require('./music-clock');
const { SOUND_PARTS } = require('./section-sounds');

const PRESERVE_EXCERPT = ['motif', 'instruments', 'harmony'];
const MAX_EXCERPT_BARS = 12;
const writtenBeat = (event) => event.beat ?? event.t;

function melody(song, start, end) {
  const candidates = song.events.filter((event) => event.bus === 'mel' && writtenBeat(event) < end &&
    writtenBeat(event) + event.dur > start).map((event) => ({
    beat: Math.max(0, writtenBeat(event) - start), end: Math.min(end, writtenBeat(event) + event.dur) - start,
    midi: event.midi, velocity: Math.min(1, Math.max(1 / 127, event.vel)),
  })).sort((a, b) => a.beat - b.beat || b.velocity - a.velocity || b.midi - a.midi);
  const monophonic = candidates.filter((note, index) => !index || note.beat - candidates[index - 1].beat >= 1e-7).slice(0, 24);
  if (!monophonic.length) {
    throw new Error(ui('Les deux premières mesures de l’extrait ne contiennent aucune mélodie. Choisis une autre plage ou omets motif dans preserve.',
      'The first two bars have no melody. Choose another range or omit motif from preserve.'));
  }
  return monophonic.map(({ beat, end: stop, midi, velocity }, index) => ({
    beat, duration: Math.min(stop, monophonic[index + 1]?.beat ?? stop) - beat, midi, velocity,
  }));
}

function sourceRoles(song, first, last) {
  const totals = new Map();
  for (const event of song.events) {
    if (!SOUND_PARTS.includes(event.bus)) continue;
    const overlap = Math.min(last, writtenBeat(event) + event.dur) - Math.max(first, writtenBeat(event));
    if (overlap <= 0) continue;
    const part = totals.get(event.bus) ?? new Map();
    const weight = overlap * event.vel * (event.gain ?? 1);
    part.set(event.inst, (part.get(event.inst) ?? 0) + weight);
    totals.set(event.bus, part);
  }
  return Object.fromEntries([...totals].map(([bus, counts]) => [
    bus, [...counts].sort((a, b) => b[1] - a[1])[0][0],
  ]));
}

function readDevelopment(song, spec) {
  const { region, preserve = PRESERVE_EXCERPT } = spec;
  const { start_bar, bars } = region ?? {};
  if (!region || Object.keys(region).some((name) => !['start_bar', 'bars'].includes(name)) ||
      !Number.isInteger(start_bar) || !Number.isInteger(bars) || start_bar < 1 ||
      bars < 1 || bars > MAX_EXCERPT_BARS || start_bar + bars - 1 > song.bars) {
    throw new Error(ui('Choisis une région de 1 à 12 mesures existantes.', 'Choose a region of 1 to 12 existing bars.'));
  }
  if (!Array.isArray(preserve) || !preserve.length || new Set(preserve).size !== preserve.length ||
      preserve.some((item) => !PRESERVE_EXCERPT.includes(item))) {
    throw new Error(ui('preserve attend motif, instruments et/ou harmony, sans doublon.',
      'preserve accepts motif, instruments, and/or harmony without duplicates.'));
  }
  const sectionAt = (bar) => song.meta.sections.find((section) => bar >= section.startBar && bar < section.startBar + section.bars);
  const opening = sectionAt(start_bar);
  const start = (start_bar - 1) * 4;
  const end = start + bars * 4;
  const motif = preserve.includes('motif') ? melody(song, start, Math.min(end, start + 8)) : undefined;
  const roles = preserve.includes('instruments') ? sourceRoles(song, start, end) : {};
  const progression = preserve.includes('harmony') ? Array.from({ length: bars }, (_, i) => {
    const bar = start_bar + i;
    const section = sectionAt(bar);
    const offset = bar - (section?.startBar ?? 0);
    const changes = section?.harmony?.[offset];
    return changes?.length > 1 ? changes.map(({ beat, chord }) => ({ beat, chord }))
      : changes?.[0]?.chord ?? section?.chords?.[offset];
  }) : undefined;
  if (progression?.some((chord) => chord === undefined)) {
    throw new Error(ui('Accords absents dans cet extrait. Choisis une autre plage ou omets harmony dans preserve.',
      'Chord information is missing from this region. Choose another range or omit harmony from preserve.'));
  }
  const patches = Object.fromEntries(Object.values(roles).filter((id) => Object.hasOwn(song.patches ?? {}, id))
    .map((id) => [id, song.patches[id]]));
  return { motif, roles, progression, patches, style: song.meta.style,
    tempo: opening?.tempo ?? song.bpm, meter: opening?.meter ?? COMMON_METER,
    key: opening?.key ?? song.meta.key, palette: song.palette,
    excerpt: { region: { start_bar, bars }, preserve: [...preserve] } };
}

module.exports = { MAX_EXCERPT_BARS, PRESERVE_EXCERPT, readDevelopment };
