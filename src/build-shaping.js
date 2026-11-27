'use strict';

const { ui } = require('./language');

const CONTOURS = ['progressive', 'break'];
const MAX_BEFORE = 8;
const PART_LEVELS = {
  pad: [.49, .14], arp: [.48, .10], bass: [.66, .06], counter: [.49, .19], drum: [.32, .045], texture: [.32, .055],
};

function buildWindow(song, { arrival_bar: arrival, before_bars: before } = {}) {
  if (!Number.isInteger(arrival) || arrival < 2 || arrival > song.bars) {
    throw new Error(ui('arrival_bar attend une mesure existante après la première.', 'arrival_bar must be an existing bar after the first.'));
  }
  const bars = before ?? Math.min(3, arrival - 1);
  if (!Number.isInteger(bars) || bars < 1 || bars > Math.min(MAX_BEFORE, arrival - 1)) {
    throw new Error(ui('before_bars attend entre 1 et 8 mesures disponibles avant l’arrivée.', 'before_bars must be between 1 and 8 bars available before the arrival.'));
  }
  return { start: (arrival - 1 - bars) * 4, arrival: (arrival - 1) * 4 };
}

function validateBuilds(builds, beats) {
  if (builds === undefined) return;
  if (!Array.isArray(builds)) throw new Error(ui('Courbes de montée invalides.', 'Invalid build curves.'));
  let end = 0;
  for (const b of builds) {
    if (!b || ![b.start, b.arrival, b.from, b.to].every(Number.isFinite) || b.start > b.from || b.arrival < b.to ||
        b.from < end || b.from >= b.to || b.to > beats || b.arrival - b.start < 4 || b.arrival - b.start > MAX_BEFORE * 4 ||
        !CONTOURS.includes(b.contour) || !Number.isFinite(b.amount) || b.amount < 0 || b.amount > 1) {
      throw new Error(ui('Courbe de montée hors de la partition ou superposée.', 'Build curve outside the score or overlapping another build.'));
    }
    end = b.to;
  }
}

function shapeBuild(song, input) {
  const { start, arrival } = buildWindow(song, input);
  const { contour, amount = 1 } = input;
  if (![...CONTOURS, 'flat'].includes(contour) || !Number.isFinite(amount) || amount < 0 || amount > 1) {
    throw new Error(ui('Choisis progressive, break ou flat et une intensité de 0 à 1.', 'Choose progressive, break, or flat and an intensity from 0 to 1.'));
  }
  const old = song.builds ?? [];
  const builds = old.flatMap((build) => {
    if (build.to <= start || build.from >= arrival) return [build];
    return [...(build.from < start ? [{ ...build, to: start }] : []),
      ...(build.to > arrival ? [{ ...build, from: arrival }] : [])];
  });
  if (contour !== 'flat' && amount > 0) builds.push({ start, arrival, from: start, to: arrival, contour, amount });
  builds.sort((a, b) => a.from - b.from);
  const next = { ...song, history: [...(song.history ?? []), { action: 'shape_build', arrival_bar: input.arrival_bar,
    before_bars: (arrival - start) / 4, contour, amount }].slice(-60) };
  if (builds.length) next.builds = builds;
  else delete next.builds;
  return next;
}

function cropBuilds(builds, first, last) {
  return builds?.flatMap((build) => {
    const from = Math.max(first, build.from), to = Math.min(last, build.to);
    if (to <= from) return [];
    return [{ ...build, start: build.start - first, arrival: build.arrival - first, from: from - first, to: to - first }];
  });
}

function curve(build, [floor, dip]) {
  const { start, arrival, amount } = build;
  const length = arrival - start;
  const breath = Math.min(1.7, length * .34);
  const shape = build.contour === 'break' ? [
    [0, 1], [length - breath - .75, .94], [length - breath, 1.03],
    [length - breath * .72, dip], [length - breath * .15, dip], [length - .025, 1], [length, 1],
  ] : [[0, 1], [.20, floor], [length * .55, floor + .36 * (1 - floor)],
    [length * .87, .94], [length - .025, 1], [length, 1]];
  return shape.map(([beat, gain]) => ({ beat: start + beat, gain: 1 + (gain - 1) * amount }));
}

function applyBuilds(L, R, bus, builds, clock, sr, loop = false) {
  const profile = PART_LEVELS[bus];
  if (!profile || !builds?.length) return;
  for (const build of builds) {
    const knots = curve(build, profile);
    // La courbe suit les mesures, même quand le tempo change pendant la montée.
    const beats = [...new Set([build.from, build.to, ...knots.map(({ beat }) => beat), ...clock.changes.map(({ beat }) => beat)])]
      .filter((beat) => beat >= build.from && beat <= build.to).sort((a, b) => a - b);
    const points = beats.map((beat) => {
      const i = knots.findIndex((k, index) => index && k.beat >= beat);
      const right = knots[i], left = knots[i - 1];
      const gain = left.gain + (right.gain - left.gain) * (beat - left.beat) / (right.beat - left.beat);
      return { sample: Math.round(clock.at(beat) * sr), gain };
    });
    const low = points[0].sample, high = points.at(-1).sample;
    const crossfade = Math.max(1, Math.min(Math.round(.018 * sr), (high - low) / 2));
    const fadeIn = build.from !== build.start && (build.from > 0 || loop);
    const fadeOut = build.to !== build.arrival && (high < Math.round(clock.seconds * sr) || loop);
    for (let j = 1; j < points.length; j++) {
      const from = points[j - 1], to = points[j];
      const length = to.sample - from.sample;
      if (!length) continue;
      const step = (to.gain - from.gain) / length;
      for (let i = from.sample, gain = from.gain; i < Math.min(to.sample, L.length); i++, gain += step) {
        const edge = Math.min(1, fadeIn ? (i - low) / crossfade : 1, fadeOut ? (high - i - 1) / crossfade : 1);
        const value = 1 + (gain - 1) * edge;
        L[i] *= value;
        R[i] *= value;
      }
    }
  }
}

module.exports = { CONTOURS, MAX_BEFORE, buildWindow, validateBuilds, shapeBuild, cropBuilds, applyBuilds };
