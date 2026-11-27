'use strict';

const { ui } = require('./language');
const { renderSong } = require('./dsp');
const { musicClock } = require('./music-clock');
const { chordFromSymbol } = require('./theory');
const { bridgeLoop, joinFrames, planAdaptiveMusic } = require('./adaptive-music');
const { sectionIndex } = require('./music-project');

const PROBE_SECONDS = [0.15, 0.45, 0.9];
const PREVIEW_SR = 22050;

function bands(audio, boundary, side) {
  return PROBE_SECONDS.map((seconds) => {
    const frames = Math.round(seconds * audio.sr);
    const first = Math.max(0, boundary + Math.min(0, side * frames));
    const last = Math.min(audio.samples, boundary + Math.max(0, side * frames));
    let power = 0;
    for (let i = first; i < last; i++) power += (audio.L[i] ** 2 + audio.R[i] ** 2) / 2;
    return 10 * Math.log10(Math.max(1e-7, power / Math.max(1, last - first)));
  });
}

function pitchClasses(chord) {
  try {
    return typeof chord === 'string' ? chordFromSymbol(chord).pitchClasses : [];
  } catch {
    return [];
  }
}

function harmonicDistance(a, b) {
  if (!a.length || !b.length) return 0;
  return 1 - a.filter((pitch) => b.includes(pitch)).length / new Set([...a, ...b]).size;
}

function difference(a, b) {
  return a.reduce((total, level, index) => total + Math.abs(level - b[index]), 0) / a.length;
}

function boundaryProfiles(song, audio, clock, first, last) {
  const measures = song.meta.sections.flatMap((section) => Array.from({ length: section.bars }, (_, offset) => {
    const changes = section.harmony?.[offset];
    const chord = section.chords?.[offset];
    return {
      opening: pitchClasses(changes?.[0]?.chord ?? chord), closing: pitchClasses(changes?.at(-1)?.chord ?? chord),
      tempo: section.tempo ?? song.bpm, meter: (section.meter ?? [4, 4]).join('/'),
    };
  }));
  const boundaries = new Map();
  for (let bar = first; bar <= last; bar++) {
    const at = clock.at((bar - 1) * 4);
    const frame = Math.round(at * audio.sr);
    boundaries.set(bar, { at, left: bands(audio, frame, -1), right: bands(audio, frame, 1),
      previous: measures[bar - 2], next: measures[bar - 1] });
  }
  return boundaries;
}

const rounded = (number) => Math.round(number * 1000) / 1000;

function scoreJoin(a, b) {
  const before = difference(a.left, b.left);
  const after = difference(a.right, b.right);
  const harmony = (harmonicDistance(a.previous.closing, b.previous.closing) * 2 +
    harmonicDistance(a.next.opening, b.next.opening)) / 3;
  const timing = (a.next.meter === b.next.meter ? 0 : 6) +
    10 * Math.abs(Math.log(a.next.tempo / b.next.tempo));
  // Low-energy edges need a penalty even when both ends are equally quiet.
  const quiet = Math.max(0, (-38 - Math.min(a.left[1], a.right[1], b.left[1], b.right[1])) * 0.35);
  return { cost: rounded(before + 0.45 * after + 8 * harmony + timing + quiet),
    level_difference_db: rounded(before), harmonic_distance: rounded(harmony) };
}

function searchRange(song, args) {
  if (args.section !== undefined && args.region !== undefined) {
    throw new Error(ui('Choisis section ou region.', 'Choose section or region.'));
  }
  const section = args.section === undefined ? undefined : song.meta.sections[sectionIndex(song, args.section)];
  const { start_bar, bars } = section ? { start_bar: section.startBar, bars: section.bars }
    : args.region === undefined ? { start_bar: 1, bars: song.bars } : args.region ?? {};
  if (!Number.isInteger(start_bar) || start_bar < 1 || !Number.isInteger(bars) || bars < 1 || start_bar + bars - 1 > song.bars) {
    throw new Error(ui('La région doit tenir dans la partition.', 'The region must fit within the score.'));
  }
  return [Math.max(2, start_bar), Math.min(song.bars, start_bar + bars)];
}

function repeatTwice(channel) {
  const take = new Float32Array(channel.length * 2);
  take.set(channel);
  take.set(channel, channel.length);
  return take;
}

function previewLoopChoices(source, args) {
  const [first, last] = searchRange(source, args);
  const options = args.loop_options ?? {};
  const { count = 3, crossfade_ms = 400 } = options;
  const maxSeconds = args.max_seconds ?? 45;
  if (args.loop_options === null || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some((key) => !['count', 'min_bars', 'crossfade_ms'].includes(key)) ||
      ![2, 3].includes(count) || (options.min_bars !== undefined && (!Number.isInteger(options.min_bars) || options.min_bars < 1)) ||
      !Number.isFinite(maxSeconds) || maxSeconds < 4 || maxSeconds > 45) {
    throw new Error(ui('Donne 2 ou 3 prises, au moins une mesure et une durée maximale de 4 à 45 s.',
      'Choose 2 or 3 takes, at least one bar, and a maximum duration of 4 to 45 s.'));
  }
  const clock = musicClock(source);
  const at = (bar) => clock.at((bar - 1) * 4);
  let defaultBars = Math.min(8, Math.max(1, last - first - 2));
  while (defaultBars > 1 && !Array.from({ length: last - first - defaultBars + 1 }, (_, i) => first + i)
    .some((bar) => at(bar + defaultBars) - at(bar) <= maxSeconds)) defaultBars--;
  const minBars = options.min_bars ?? defaultBars;
  if (last - first < minBars) {
    throw new Error(ui('La plage est trop courte pour une boucle avec introduction et sortie.',
      'The range is too short for a loop with room for an intro and outro.'));
  }
  const song = { ...source, sr: PREVIEW_SR, loop: false,
    ...(source.loop ? { targetSeconds: undefined, endFade: source.endFade || 0.65 } : {}) };
  planAdaptiveMusic(song, { loop_region: { start_bar: first, bars: minBars }, crossfade_ms }, 'wav');
  const audio = renderSong(song);
  const boundaries = boundaryProfiles(song, audio, clock, first, last);
  const ranked = [];
  for (let start = first; start <= last - minBars; start++) {
    const opening = boundaries.get(start);
    for (let end = start + minBars; end <= last; end++) {
      const ending = boundaries.get(end);
      if (ending.at - opening.at > maxSeconds) break;
      const adaptive = { loop_region: { start_bar: start, bars: end - start }, crossfade_ms };
      ranked.push({ adaptive, metrics: scoreJoin(opening, ending) });
    }
  }
  ranked.sort((a, b) => a.metrics.cost - b.metrics.cost || b.adaptive.loop_region.bars - a.adaptive.loop_region.bars);
  if (!ranked.length) {
    throw new Error(ui('Aucune boucle dans la région avec cette durée. Élargis la région ou augmente max_seconds.',
      'No loop fits this region and duration. Widen the region or increase max_seconds.'));
  }
  const chosen = [];
  for (const candidate of ranked) {
    if (chosen.length === count) break;
    const region = candidate.adaptive.loop_region;
    if (chosen.every(({ adaptive: { loop_region: other } }) =>
      other.start_bar !== region.start_bar && other.start_bar + other.bars !== region.start_bar + region.bars)) chosen.push(candidate);
  }
  chosen.push(...ranked.filter((candidate) => !chosen.includes(candidate)).slice(0, count - chosen.length));
  chosen.sort((a, b) => a.metrics.cost - b.metrics.cost || b.adaptive.loop_region.bars - a.adaptive.loop_region.bars);
  return chosen.map(({ adaptive, metrics }) => {
    const plan = planAdaptiveMusic(song, adaptive, 'wav');
    const frames = joinFrames(plan, audio.samples);
    const L = repeatTwice(bridgeLoop(audio.L, plan.start, plan.end, frames));
    const R = audio.mono ? L : repeatTwice(bridgeLoop(audio.R, plan.start, plan.end, frames));
    const join = L.length / 2;
    const seconds = join / audio.sr;
    const span = Math.min(join, audio.sr * 3);
    return { adaptive, metrics, seconds, audio: { L, R, sr: audio.sr, mono: audio.mono },
      reference: { L: L.subarray(join - span, join + span), R: R.subarray(join - span, join + span), sr: audio.sr, mono: audio.mono } };
  });
}

module.exports = { previewLoopChoices };
