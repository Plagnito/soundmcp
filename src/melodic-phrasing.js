'use strict';

const { SCALES, degreeSemitone } = require('./theory');

const PHRASINGS = ['style', 'lyrical'];
const THEME_TREATMENTS = ['fragment', 'reprise', 'augmentation', 'sequence'];
const THEMES = [
  [[0, .82, 3], [1, .41, 2], [1.5, 1.1, 3], [3, .71, 5], [4, 1.05, 6], [5.5, .41, 5], [6, 1.55, 3]],
  [[0, 1.22, 1], [1.5, .42, 2], [2, .82, 3], [3, .72, 5], [4, 1.16, 4], [5.5, .40, 3], [6, 1.47, 2]],
  [[0, .74, 3], [1, .36, 5], [1.5, 1.12, 4], [3, .67, 3], [4, 1.05, 5], [5.5, .39, 4], [6, 1.65, 3]],
];
const ANSWERS = [
  [[0, .82, 5], [1, .45, 3], [1.5, 1.21, 4], [3, .63, 2], [4, .85, 3], [5, .85, 4], [6, 1.45, 5]],
  [[0, .83, 6], [1, .79, 5], [2, .88, 3], [3, .54, 4], [4, .9, 5], [5.5, .42, 3], [6, 1.6, 2]],
];
const pitchClass = (midi) => (midi + 120) % 12;

function readPhrasing(value) {
  if (value === undefined) return 'style';
  if (!PHRASINGS.includes(value)) throw new Error('phrasing attend style ou lyrical.');
  return value;
}

function lyricalMotif(rng, theme) {
  return rng.pick(theme === 'A' ? THEMES : ANSWERS).map(([beat, duration, degree]) => ({ beat, duration, degree }));
}

function moveNote(note, steps, key) {
  if (note.midi === undefined) return { degree: note.degree + steps };
  const scale = SCALES[key.scaleId];
  const relative = note.midi - key.root;
  let degree = Math.floor(relative / 12) * scale.degrees.length;
  while (degreeSemitone(scale, degree + 1) <= relative) degree++;
  const pitch = note.midi + degreeSemitone(scale, degree + steps) - degreeSemitone(scale, degree);
  return { midi: Math.max(0, Math.min(127, pitch)) };
}

function transformMotif(motif, treatment, key) {
  if (treatment === 'reprise') {
    const last = motif.at(-1);
    const beat = Math.max(7.72, last.beat + last.duration);
    if (beat > 7.92) return motif;
    return [...motif, { beat, duration: Math.min(.21, 8 - beat), ...moveNote(last, -1, key) }];
  }
  if (!['fragment', 'augmentation', 'sequence'].includes(treatment)) return motif;
  const from = motif[0].beat >= 4 ? 4 : 0;
  const cell = motif.filter((note) => note.beat < from + 4).map((note) => ({
    ...note, beat: note.beat - from, duration: Math.min(note.duration, from + 4 - note.beat),
  }));
  if (treatment === 'augmentation') return cell.map((note) => ({ ...note, beat: note.beat * 2, duration: note.duration * 2 }));
  if (treatment === 'sequence') return cell.concat(cell.map((note) => ({ ...note, beat: note.beat + 4, ...moveNote(note, 2, key) })));
  return cell;
}

function developMotif(motif, treatment, variation) {
  if (treatment !== undefined && treatment !== 'reprise') return transformMotif(motif, treatment);
  const answer = variation % 2 ? motif.map((note, index) => {
    const next = motif[index + 1]?.beat ?? 8;
    const shift = note.beat >= 4 && index < motif.length - 1 ? Math.min(0.17, (next - note.beat) * 0.16) : 0;
    return { ...note, beat: note.beat + shift, duration: Math.min(note.duration, next - note.beat - shift - 0.04) };
  }) : motif;
  return transformMotif(answer, treatment);
}

function noteHarmony(harmony, beat) {
  const bar = Math.floor(beat / 4);
  const local = beat - bar * 4;
  const changes = harmony[bar];
  let active = 0;
  while (changes[active + 1]?.beat <= local) active++;
  return { chord: changes[active].chord, from: bar * 4 + changes[active].beat,
    to: bar * 4 + (changes[active + 1]?.beat ?? 4) };
}

function motionCost(before, now, desired) {
  const interval = now.pitch - before.pitch;
  const distance = Math.abs(interval);
  const contrary = desired && interval && Math.sign(interval) !== Math.sign(desired);
  const weakLeap = (before.passing || now.passing) && distance > 2;
  return distance * 0.15 + Math.abs(interval - desired) * 0.32 + Math.max(0, distance - 4) ** 2 * 0.64 +
    (contrary ? 1.1 : 0) + (interval === 0 && desired ? 0.95 : 0) + (weakLeap ? 2.6 : 0);
}

// Choisit la ligne entière pour que chaque note prépare la suivante.
function fitPhrase(notes, previous) {
  let layer = [];
  for (const [index, note] of notes.entries()) {
    const current = note.candidates.map(({ pitch, passing }) => {
      const point = { pitch, passing };
      const local = Math.abs(pitch - note.target) * 0.47 + (passing ? 0.61 : 0);
      if (index === 0) {
        const entrance = previous === undefined ? 0 : Math.max(0, Math.abs(pitch - previous) - 3) ** 2 * 0.37;
        return { ...point, cost: local + entrance };
      }
      const desired = note.target - notes[index - 1].target;
      let bestCost = Infinity, best;
      for (const before of layer) {
        const cost = before.cost + motionCost(before, point, desired);
        if (cost < bestCost) { bestCost = cost; best = before; }
      }
      return { ...point, cost: local + bestCost, before: best };
    });
    layer = current;
  }
  let point = layer.reduce((best, candidate) => candidate.cost < best.cost ? candidate : best);
  const pitches = [];
  while (point) { pitches.push(point.pitch); point = point.before; }
  return pitches.reverse();
}

function addLyricalPhrase(push, humanize, instrument, ctx) {
  const begin = ctx.startBar * 4, end = begin + ctx.length * 4;
  const base = 12 * (instrument.octave + 1) + ctx.key.root - (ctx.key.root > 7 ? 12 : 0);
  const scale = new Set(ctx.scale.degrees.map((degree) => pitchClass(ctx.key.root + degree)));
  const motif = developMotif(ctx.motif, ctx.themeTreatment, ctx.variation).filter((note) => begin + note.beat < end);
  const lastIndex = motif.length - 1;
  if (lastIndex < 0) return ctx.previous;
  const notes = motif.map((note, index) => {
    const beat = begin + note.beat;
    const last = index === lastIndex;
    const harmony = noteHarmony(ctx.harmony, beat);
    const anchored = index === 0 || last || (note.beat % 1 === 0 && note.duration >= .68);
    const harmonic = new Set(harmony.chord.pitchClasses);
    const tailVariation = last && ctx.variation % 2 && !['reprise', 'augmentation', 'sequence'].includes(ctx.themeTreatment) ? -1 : 0;
    const target = base + degreeSemitone(ctx.scale, note.degree - 1 + tailVariation);
    const candidates = [];
    for (let pitch = Math.max(0, base - 5); pitch <= Math.min(127, base + 15); pitch++) {
      const pc = pitchClass(pitch), passing = !harmonic.has(pc);
      if (!passing || (!anchored && scale.has(pc))) candidates.push({ pitch, passing });
    }
    return { ...note, beat, target, candidates, last, ...harmony };
  });
  const pitches = fitPhrase(notes, ctx.previous);
  let previous = ctx.previous;
  for (const [i, note] of notes.entries()) {
    const [onset, vel] = humanize(note.beat, (.72 + .13 * Math.sin(Math.PI * i / Math.max(1, lastIndex))) * Math.sqrt(ctx.intensity));
    const t = Math.max(begin, note.from, onset);
    const next = notes[i + 1]?.beat ?? end;
    const roomForAnswer = ctx.withAnswer && !note.last && (i === 2 || i === 4) ? 0.34 : 0;
    const gate = Math.min(Math.max(0.2, note.duration - roomForAnswer), next - t - (note.last ? 0 : .035), note.to - t, end - t);
    if (gate < .035) continue;
    previous = pitches[i];
    push({ t, beat: note.beat, dur: gate, midi: previous, vel, inst: instrument.inst, pan: .028, bus: 'mel', vib: instrument.vibrato || 0 });
  }
  return previous;
}

function addLyricalAnswers(push, lead, section, fromBar, harmony) {
  let previous = 60;
  for (let bar = fromBar; bar < fromBar + section.bars; bar++) {
    const start = bar * 4, end = start + 4;
    const nearby = lead.filter((note) => note.t < end && note.t + note.dur > start);
    const gaps = [];
    let cursor = start + 0.08;
    for (const note of nearby) {
      const stop = Math.min(end, note.t) - 0.07;
      if (stop - cursor >= 0.39) gaps.push([cursor, stop]);
      cursor = Math.max(cursor, note.t + note.dur + 0.08);
    }
    if (end - cursor >= 0.44) gaps.push([cursor, end - 0.06]);
    const best = gaps.reduce((a, b) => !a || b[1] - b[0] > a[1] - a[0] ? b : a, undefined);
    if (!best) continue;
    const [beat, stop] = best;
    const { chord, to } = noteHarmony(harmony, beat);
    const dur = Math.min(0.8, stop - beat, to - beat);
    if (dur < 0.27) continue;
    const leadPitch = nearby.at(-1)?.midi ?? 69;
    const target = Math.max(54, Math.min(65, previous, leadPitch - 4));
    const choices = chord.pitchClasses.map((pc) => pc + 12 * Math.round((target - pc) / 12));
    const midi = choices.reduce((a, b) => Math.abs(target - b) < Math.abs(target - a) ? b : a);
    previous = midi;
    push({ t: beat, beat, dur, midi, vel: 0.47 * Math.sqrt(section.energy), inst: 'clarinet', pan: -0.21, bus: 'counter', articulation: 'legato' });
  }
}

module.exports = { PHRASINGS, THEME_TREATMENTS, readPhrasing, lyricalMotif, transformMotif, addLyricalPhrase, addLyricalAnswers };
