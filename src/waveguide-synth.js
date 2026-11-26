'use strict';

const { makeRng } = require('./rng');

const TAU = Math.PI * 2;
const T60 = Math.log(1000);
const clamp = (value, min, max) => Math.min(max, Math.max(value, min));
const pluck = (phase, position) => {
  const x = phase - Math.floor(phase);
  return (x < position ? x / position : (1 - x) / (1 - position)) - 0.5;
};

// Demi-bande à 17 coefficients. Seuls les taps impairs et le centre sont non nuls.
const DECIMATOR = Array.from({ length: 8 }, (_, i) => {
  const offset = i * 2 - 7;
  const window = 0.42 + 0.5 * Math.cos(Math.PI * offset / 8) + 0.08 * Math.cos(TAU * offset / 8);
  return Math.sin(Math.PI * offset / 2) * window / (Math.PI * offset);
});

function tuneDelay(frequency, rate, pole, dispersion, decay) {
  const omega = TAU * frequency / rate;
  const cosine = Math.cos(omega), sine = Math.sin(omega);
  const filterPhase = Math.atan2(pole * sine, 1 - pole * cosine);
  const dispersionPhase = 2 * Math.atan2((1 - dispersion) * Math.sin(omega * 0.5), (1 + dispersion) * Math.cos(omega * 0.5));
  const delay = Math.max(1, (TAU - filterPhase - dispersionPhase) / omega);
  const whole = Math.floor(delay);
  const fraction = delay - whole;
  // Compense la phase réelle de l'interpolation linéaire à la fondamentale.
  const fractionSin = Math.sin(omega * fraction);
  const mix = fractionSin / (fractionSin + Math.sin(omega * (1 - fraction)));
  const filterGain = (1 - pole) / Math.sqrt(1 + pole * pole - 2 * pole * cosine);
  const interpolationGain = Math.sqrt(1 - 2 * mix * (1 - mix) * (1 - cosine));
  const loss = T60 / (frequency * decay);
  return { whole, mix, loss, feedback: Math.min(0.99996, Math.exp(-loss) / (filterGain * interpolationGain)) };
}

function bodyFilter(settings, rate) {
  const omega = TAU * settings.frequency / rate;
  const alpha = Math.sin(omega) / (2 * settings.resonance);
  const b = alpha / (1 + alpha);
  const a1 = -2 * Math.cos(omega) / (1 + alpha), a2 = (1 - alpha) / (1 + alpha);
  let z1 = 0, z2 = 0;
  return (input) => {
    const out = b * input + z1;
    z1 = z2 - a1 * out;
    z2 = -b * input - a2 * out;
    return out;
  };
}

function renderWaveguide(L, R, notes, sr, settings) {
  const first = notes[0], last = notes.at(-1);
  const outEnd = Math.min(L.length, last.start + Math.ceil(settings.decay_seconds * sr));
  const rate = sr * 2;
  const highest = sr * 0.47;
  const minFrequency = notes.reduce((low, { event }) => Math.min(low, event.freq), highest);
  const gainOf = (event) => event.vel * (event.gain ?? 1) * clamp((sr * 0.49 - event.freq) / (sr * 0.022), 0, 1);
  const length = Math.ceil(rate / minFrequency) + 4;
  const delay = new Float64Array(length);
  const output = new Float64Array(16);
  const rng = makeRng(first.event.seedIdx);
  const hardness = first.event.gesture?.hardness ?? clamp((first.event.timbre ?? 0.5) * 0.41 + first.event.vel * 0.58, 0, 1);
  const position = 0.04 + (first.event.gesture?.position ?? 0.29) * 0.92;
  const width = 0.005 + (1 - hardness) ** 2 * 0.115;
  const pole = clamp(0.57 - settings.brightness * 0.48 + (0.5 - hardness) * 0.24, 0.025, 0.71);
  const dispersion = -0.44 * settings.stiffness;
  const body = bodyFilter(settings.body, rate);
  const contactFrames = Math.round((0.004 + (1 - hardness) * 0.008) * rate);
  const contactFilter = 1 - Math.exp(-TAU * (1250 + 7400 * hardness) / rate);
  const bodyMix = settings.body.mix;
  const settle = 1 - Math.exp(-1 / (0.012 * rate));
  let frequency = Math.min(first.event.freq, highest);
  for (let i = 1; i < length; i++) {
    const phase = -i * frequency / rate;
    delay[length - i] = 0.5 * pluck(phase, position) +
      0.25 * (pluck(phase - width, position) + pluck(phase + width, position));
  }

  let cursor = 0, frameIndex = 0, filtered = 0, phaseIn = 0, phaseOut = 0, contact = 0, previous = 0;
  let damping = first.event.gesture?.damping ?? 0, pan = first.event.pan;
  let volume = gainOf(first.event) * (first.event.expression?.[0] ?? 1);
  let tuning = tuneDelay(frequency, rate, pole, dispersion, settings.decay_seconds);

  for (const [index, note] of notes.entries()) {
    const { event, start, duration } = note;
    const next = notes[index + 1];
    const begin = start * 2, end = (next?.start ?? outEnd) * 2;
    const glide = index ? Math.min(end - begin, Math.round(rate * (event.gesture?.glide_ms ??
      (event.articulation === 'slide' ? 92 : 17)) / 1000)) : 0;
    const from = frequency, target = Math.min(highest, event.freq);
    const gestureDamping = Math.max(event.gesture?.damping ?? 0, event.articulation === 'mute' ? 0.85 : 0);
    const releaseDamping = event.articulation === 'staccato' ? 0.86 : settings.release_damping;
    const [expressionFrom, expressionTo] = event.expression ?? [1, 1];
    const noteGain = gainOf(event);
    if (!glide && frequency !== target) {
      frequency = target;
      tuning = tuneDelay(frequency, rate, pole, dispersion, settings.decay_seconds);
    }
    for (let i = begin; i < end; i++, frameIndex++) {
      const age = i - begin;
      if (glide && age <= glide + 7 && (age & 7) === 0) {
        const time = Math.min(1, age / glide);
        frequency = from * (target / from) ** (time * time * (3 - 2 * time));
        tuning = tuneDelay(frequency, rate, pole, dispersion, settings.decay_seconds);
      }
      const progress = Math.min(1, age / Math.max(1, duration * rate));
      const released = progress >= 1 && (!next || event.articulation === 'staccato');
      volume += settle * (noteGain * (expressionFrom + (expressionTo - expressionFrom) * progress) - volume);
      damping += settle * (Math.max(gestureDamping, released ? releaseDamping : 0) - damping);
      pan += settle * (event.pan - pan);

      const read = (cursor + length - tuning.whole) % length;
      const sample = delay[read] * (1 - tuning.mix) + delay[(read + length - 1) % length] * tuning.mix;
      filtered = sample * (1 - pole) + filtered * pole;
      const dispersed = dispersion * filtered + phaseIn - dispersion * phaseOut;
      phaseIn = filtered;
      phaseOut = dispersed;
      delay[cursor] = dispersed * tuning.feedback * Math.exp(-tuning.loss * 11 * damping);
      if (++cursor === length) cursor = 0;

      let touch = 0;
      if (frameIndex < contactFrames && settings.contact) {
        contact += contactFilter * (rng.f(-1, 1) - contact);
        const window = Math.sin(Math.PI * frameIndex / contactFrames);
        touch = contact * settings.contact * window * window * (0.36 + hardness * 0.65);
      }
      const bridge = sample + (sample - previous) * (0.55 + hardness * 1.15);
      previous = sample;
      const onset = Math.min(1, frameIndex / (rate * (0.0014 + (1 - hardness) * 0.0027)));
      const source = bridge * onset * onset + touch;
      const resonated = body(source);
      output[frameIndex & 15] = source * (1 - 0.22 * bodyMix) + resonated * bodyMix;

      if ((i & 1) === 0) continue;
      const frame = i >> 1;
      let value = 0.5 * output[(frameIndex - 8) & 15];
      for (let tap = 0; tap < DECIMATOR.length; tap++) {
        value += DECIMATOR[tap] * output[(frameIndex - (tap * 2 + 1)) & 15];
      }
      const fade = Math.min(1, (outEnd - 1 - frame) / (sr * 0.018));
      const angle = (pan + 1) * Math.PI / 4;
      L[frame] += value * volume * 0.7 * fade * Math.cos(angle);
      R[frame] += value * volume * 0.7 * fade * Math.sin(angle);
    }
  }
}

module.exports = { renderWaveguide };
