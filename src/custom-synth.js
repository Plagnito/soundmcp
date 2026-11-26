'use strict';

const { makeRng, hash32 } = require('./rng');

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function edge(t, step) {
  if (t < step) {
    const x = t / step;
    return x + x - x * x - 1;
  }
  if (t > 1 - step) {
    const x = (t - 1) / step;
    return x * x + x + x + 1;
  }
  return 0;
}

function shape(wave, state, sr, phase, step, width) {
  if (wave === 'sine') return Math.sin(TAU * phase);
  if (wave === 'triangle') return 1 - 4 * Math.abs(phase - 0.5);
  if (wave === 'saw') return 2 * phase - 1 - edge(phase, step);
  if (wave === 'pulse') return (phase < width ? 1 : -1) + edge(phase, step) - edge((phase + 1 - width) % 1, step) - (2 * width - 1);
  const noise = state.rng.f(-1, 1);
  if (wave === 'white') return noise;
  state.low += state.alpha * (noise - state.low);
  if (wave === 'brown') return clamp(state.low * Math.sqrt(sr / 850) * 0.7, -1, 1);
  state.mid += state.beta * (noise - state.mid);
  return noise * 0.29 + state.mid * 0.62 + state.low * 1.35;
}

function envelopeAt(t, { attack, decay, sustain }) {
  if (t < attack) return Math.sin(t / attack * Math.PI / 2) ** 2;
  if (!decay) return sustain;
  const tail = clamp((t - attack) / decay, 0, 1);
  return sustain + (1 - sustain) * (0.5 + 0.5 * Math.cos(Math.PI * tail));
}

function filterCoefficients(out, type, frequency, q, sr) {
  const omega = TAU * clamp(frequency, 20, sr * 0.43) / sr;
  const cos = Math.cos(omega), alpha = Math.sin(omega) / (2 * q), norm = 1 / (1 + alpha);
  out[3] = -2 * cos * norm;
  out[4] = (1 - alpha) * norm;
  if (type === 'lowpass' || type === 'highpass') {
    const low = type === 'lowpass';
    out[0] = out[2] = (1 + (low ? -cos : cos)) * 0.5 * norm;
    out[1] = (low ? 2 : -2) * out[0];
  } else if (type === 'bandpass') {
    out[0] = alpha * norm;
    out[1] = 0;
    out[2] = -out[0];
  } else {
    out[0] = out[2] = norm;
    out[1] = out[3];
  }
}

function channelFilter() {
  let first = 0, second = 0;
  return (x, c) => {
    const y = c[0] * x + first;
    first = c[1] * x + second - c[3] * y;
    second = c[2] * x - c[4] * y;
    return y;
  };
}

function modulator(lfo, seed) {
  let segment = -1, value = 0;
  const offset = lfo.target === 'gain' ? 0 : makeRng(seed).f(0, 0.38);
  return (t) => {
    const phase = t * lfo.rate + offset;
    const fraction = phase % 1;
    if (lfo.wave === 'sine') return Math.sin(TAU * fraction) * lfo.depth;
    if (lfo.wave === 'triangle') return (1 - 4 * Math.abs(fraction - 0.5)) * lfo.depth;
    if (Math.floor(phase) !== segment) {
      segment = Math.floor(phase);
      value = makeRng(hash32(seed, segment)).f(-1, 1);
    }
    return value * lfo.depth;
  };
}

const GROUPS = ['pitch', 'gain', 'cutoff', 'pan', 'pulse'];

function renderCustom(L, R, start, ev, sr, duration, patch) {
  const { layers, filter, lfos, effects } = patch;
  const releases = layers.map((layer) => layer.envelope.release);
  const feedbackTail = effects.delay.mix ? Math.min(2.7, effects.delay.time_ms / 1000 * (2 + Math.ceil(effects.delay.feedback * 7))) : 0;
  const drySeconds = duration + Math.max(...releases);
  const length = Math.min(L.length - start, Math.ceil((drySeconds + feedbackTail + (effects.chorus > 0 ? 0.035 : 0)) * sr));
  const rng = makeRng(ev.seedIdx);
  const states = layers.map((layer, i) => {
    const envelope = { ...layer.envelope, attack: Math.min(layer.envelope.attack, Math.max(0.002, duration * 0.83)) };
    return { layer, envelope, hold: envelopeAt(duration, envelope), phase: rng.f(0, 1), fmPhase: rng.f(0, 1),
      root: ev.freq * layer.ratio * 2 ** (layer.detune_cents / 1200), low: 0, mid: 0, rng: makeRng(hash32(ev.seedIdx, i + 1)),
      alpha: 1 - Math.exp(-TAU * 115 / sr), beta: 1 - Math.exp(-TAU * 1200 / sr) };
  });
  const controls = Object.fromEntries(GROUPS.map((target) => [target, lfos.flatMap((lfo, i) =>
    lfo.target === target && lfo.depth ? [modulator(lfo, hash32(ev.seedIdx, i + 529))] : [])]));
  const mod = (group, t) => controls[group].reduce((sum, fn) => sum + fn(t), 0);
  const coeff = new Float64Array(5), leftFilter = channelFilter(), rightFilter = channelFilter();
  const drive = 1 + effects.drive * 8;
  const driveScale = 1 / Math.tanh(drive);
  const step = 2 ** (effects.bits - 1) - 1;
  const padGain = 0.54 / Math.max(1, Math.sqrt(layers.reduce((sum, l) => sum + l.gain * l.gain, 0)));
  const echoLength = effects.delay.mix ? Math.max(2, Math.round(effects.delay.time_ms * sr / 1000)) : 0;
  const echoL = new Float32Array(echoLength), echoR = new Float32Array(echoLength);
  let echoIndex = 0, dampL = 0, dampR = 0;
  const damp = 1 - Math.exp(-TAU * 3400 / sr);
  const modLength = effects.chorus > 0 ? Math.ceil(sr * 0.034) + 2 : 0;
  const chorusL = new Float32Array(modLength), chorusR = new Float32Array(modLength);
  let chorusIndex = 0;
  const tap = (buffer, lag) => {
    const pos = (chorusIndex + buffer.length - lag) % buffer.length;
    const at = Math.floor(pos), fraction = pos - at;
    return buffer[at] + fraction * (buffer[(at + 1) % buffer.length] - buffer[at]);
  };

  for (let i = 0; i < length; i++) {
    const t = i / sr;
    const progress = Math.min(1, t / Math.max(0.01, duration));
    const expression = ev.expression ? ev.expression[0] + (ev.expression[1] - ev.expression[0]) * progress : 1;
    const pitch = mod('pitch', t), pan = mod('pan', t), pulse = mod('pulse', t);
    let l = 0, r = 0, weight = 0;
    if (t < drySeconds) {
      for (const state of states) {
        const { layer, envelope, root } = state;
        const release = clamp((t - duration) / envelope.release, 0, 1);
        if (release >= 1) continue;
        const amount = t <= duration ? envelopeAt(t, envelope) : state.hold * (0.5 + 0.5 * Math.cos(Math.PI * release));
        const bend = layer.pitch_drop.cents * Math.exp(-t / layer.pitch_drop.seconds);
        const rate = Math.min(0.425, root * 2 ** ((pitch + bend) / 1200) / sr);
        state.phase = (state.phase + rate) % 1;
        state.fmPhase = (state.fmPhase + Math.min(0.425, rate * layer.fm.ratio)) % 1;
        const fm = layer.fm.index * Math.min(1, Math.max(0, (0.46 / rate - 1) / layer.fm.ratio));
        const phase = (state.phase + fm * Math.sin(TAU * state.fmPhase) / TAU + 2) % 1;
        const sample = shape(layer.wave, state, sr, phase, rate, clamp(layer.pulse_width + pulse, 0.08, 0.92)) * amount * layer.gain;
        const place = (clamp(ev.pan + layer.pan + pan, -1, 1) + 1) * Math.PI / 4;
        l += sample * Math.cos(place);
        r += sample * Math.sin(place);
        weight = Math.max(weight, amount);
      }
    }
    if ((i & 31) === 0) filterCoefficients(coeff, filter.type,
      filter.frequency * 2 ** (filter.envelope_octaves * weight + mod('cutoff', t) + ((ev.timbre ?? 0.5) - 0.5) * 1.4), filter.q, sr);
    const gain = padGain * (ev.gain ?? 1) * ev.vel * expression * clamp(1 + mod('gain', t), 0.08, 1.85);
    l = leftFilter(l, coeff) * gain;
    r = rightFilter(r, coeff) * gain;
    if (effects.drive) {
      l = Math.tanh(l * drive) * driveScale;
      r = Math.tanh(r * drive) * driveScale;
    }
    if (effects.bits < 16) {
      l = Math.round(l * step) / step;
      r = Math.round(r * step) / step;
    }
    if (modLength) {
      chorusL[chorusIndex] = l;
      chorusR[chorusIndex] = r;
      l += tap(chorusR, sr * (0.012 + 0.0042 * Math.sin(TAU * 0.62 * t))) * effects.chorus * 0.48;
      r += tap(chorusL, sr * (0.017 + 0.0052 * Math.sin(TAU * 0.73 * t + 1.2))) * effects.chorus * 0.48;
      if (++chorusIndex === modLength) chorusIndex = 0;
    }
    if (echoLength) {
      const bL = echoL[echoIndex], bR = echoR[echoIndex];
      dampL += damp * (bR - dampL);
      dampR += damp * (bL - dampR);
      echoL[echoIndex] = l + dampL * effects.delay.feedback;
      echoR[echoIndex] = r + dampR * effects.delay.feedback;
      l += bL * effects.delay.mix;
      r += bR * effects.delay.mix;
      if (++echoIndex === echoLength) echoIndex = 0;
    }
    const fade = Math.min(1, (length - 1 - i) / (sr * 0.018));
    L[start + i] += l * fade;
    R[start + i] += r * fade;
  }
}

module.exports = { renderCustom };
