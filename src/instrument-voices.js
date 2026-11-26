'use strict';

const { makeRng } = require('./rng');
const TAU = 2 * Math.PI;

/** Modèles de cordes pincées ou frappées, avec amortissement distinct par partiel. */
function struckStrings({ release, gain, amplitudes, decay, stiffness = 0, detune = 0, drive = 0, noise = 0 }) {
  return {
    release, gain,
    fn(L, R, start, length, ev, sr, duration, level) {
      const pan = (ev.pan + 1) * Math.PI / 4;
      const gainL = Math.cos(pan) * level * ev.vel;
      const gainR = Math.sin(pan) * level * ev.vel;
      const rng = makeRng(ev.seedIdx);
      const attack = (noise > 0.05 ? 0.0025 : 0.004) * sr;
      const muted = ev.articulation === 'mute';
      const slide = ev.articulation === 'slide';
      const noteEnd = (muted ? Math.min(duration, 0.145) : duration) * sr;
      const releaseLength = (muted ? 0.061 : release) * sr;
      const modes = [];
      const register = Math.sqrt(Math.max(0.35, ev.freq / 260));
      const addMode = (hz, amplitude, seconds, phase, side) => {
        if (hz >= sr * 0.45) return;
        const step = TAU * hz / sr;
        const damp = Math.exp(-1 / (seconds * sr));
        modes.push({ a: 2 * damp * Math.cos(step), b: damp * damp,
          x: amplitude * Math.sin(phase), y: amplitude * Math.sin(phase - step) / damp,
          side, step, phase, amplitude, damp });
      };
      for (const [i, weight] of amplitudes.entries()) {
        const harmonic = i + 1;
        const hz = ev.freq * harmonic * Math.sqrt((1 + stiffness * harmonic ** 2) / (1 + stiffness));
        const amplitude = weight * (0.56 + ev.vel * 0.56) ** (harmonic / 2) * (muted ? 0.76 ** i : 1);
        const seconds = decay / (register * (1 + i * 0.21) * (muted ? 3.6 : 1));
        const phase = rng.f(-0.2, 0.2);
        addMode(hz, amplitude, seconds, phase, 0);
        if (detune && i < 4) {
          addMode(hz * (1 - detune), amplitude * 0.3, seconds * 0.93, phase, -0.65);
          addMode(hz * (1 + detune), amplitude * 0.3, seconds * 0.93, phase, 0.65);
        }
      }
      let previousNoise = 0;
      for (let i = 0; i < length; i++) {
        const released = Math.max(0, i - noteEnd) / releaseLength;
        if (released >= 1) break;
        let mid = 0, side = 0;
        const bend = slide ? 1 - 0.108 * Math.exp(-i / (0.028 * sr)) : 1;
        for (const mode of modes) {
          let value;
          if (slide) {
            value = mode.amplitude * Math.sin(mode.phase);
            mode.phase += mode.step * bend;
            mode.amplitude *= mode.damp;
          } else {
            value = mode.x;
            mode.x = mode.a * mode.x - mode.b * mode.y;
            mode.y = value;
          }
          mid += value;
          side += value * mode.side;
        }
        if (i < 0.025 * sr) {
          const excitation = rng.f(-1, 1);
          mid += (excitation - previousNoise) * noise * (1 - i / (0.025 * sr)) ** 3;
          previousNoise = excitation;
        }
        if (drive) mid = Math.tanh(mid * drive) / Math.tanh(drive);
        const progress = Math.min(1, i / Math.max(1, noteEnd));
        const expression = ev.expression ? ev.expression[0] + progress * (ev.expression[1] - ev.expression[0]) : 1;
        const envelope = Math.min(1, i / attack) * (1 - released) ** 2 * expression;
        L[start + i] += (mid - side) * envelope * gainL;
        R[start + i] += (mid + side) * envelope * gainR;
      }
    },
  };
}

/** Vent avec vibrato retardé et partiels dont le niveau dépend du souffle. */
function wind({ release, gain, attack, harmonics, air, vibrato, brightness }) {
  return {
    release, gain,
    fn(L, R, start, length, ev, sr, duration, level) {
      const pan = (ev.pan + 1) * Math.PI / 4;
      const gainL = Math.cos(pan) * level * ev.vel;
      const gainR = Math.sin(pan) * level * ev.vel;
      const rng = makeRng(ev.seedIdx);
      const vibRate = rng.f(4.7, 5.55);
      const cut = 1 - Math.exp(-TAU * 2800 / sr);
      const low = 1 - Math.exp(-TAU * 560 / sr);
      const partials = harmonics.slice(0, Math.floor(sr * 0.45 / ev.freq));
      const slur = ev.articulation === 'legato';
      const swell = ev.articulation === 'swell';
      const onset = Math.min(attack * (slur ? 0.28 : 1), duration * 0.58);
      let phase = 0, airLow = 0, airHigh = 0;
      for (let i = 0; i < length; i++) {
        const t = i / sr;
        const a = Math.min(1, t / onset);
        const tail = Math.max(0, t - duration) / release;
        if (tail >= 1) break;
        const vibratoDepth = (0.4 + 0.6 * (ev.vib || 0)) * Math.min(1, t / 0.36);
        const bend = vibrato * vibratoDepth * Math.sin(TAU * vibRate * t) - 0.003 * (1 - a);
        phase += TAU * ev.freq * (1 + bend) / sr;
        const color = brightness * (0.5 + 0.5 * ev.vel) * (0.55 + 0.45 * a);
        let pitch = 0;
        for (let h = 0; h < partials.length; h++) pitch += partials[h] * color ** Math.min(h, 3) * Math.sin(phase * (h + 1));
        const breath = rng.f(-1, 1);
        airHigh += cut * (breath - airHigh);
        airLow += low * (airHigh - airLow);
        const crescendo = swell ? 0.48 + 0.56 * Math.sin(Math.min(1, t / duration) * Math.PI / 2) : 1;
        const progress = Math.min(1, t / duration);
        const expression = ev.expression ? ev.expression[0] + progress * (ev.expression[1] - ev.expression[0]) : 1;
        const pressure = Math.sin(a * Math.PI / 2) * (1 - tail) ** 2 * (1 + 0.025 * Math.sin(TAU * 2.2 * t)) * expression;
        const value = (pitch + (airHigh - airLow) * air * (1.65 - a) * (slur ? 0.42 : 1)) * pressure * crescendo;
        L[start + i] += value * gainL;
        R[start + i] += value * gainR;
      }
    },
  };
}

const celloBowed = wind({ release: 0.24, gain: 0.41, attack: 0.14,
  harmonics: [0.72, 0.54, 0.37, 0.22, 0.15, 0.1, 0.06], air: 0.09, vibrato: 0.006, brightness: 0.94 });
const celloPlucked = struckStrings({ release: 0.2, gain: 0.41, amplitudes: [0.78, 0.46, 0.25, 0.12, 0.08],
  decay: 0.38, stiffness: 0.00009, noise: 0.055 });

module.exports = {
  harp: struckStrings({ release: 0.4, gain: 0.48, amplitudes: [0.84, 0.39, 0.29, 0.07, -0.09, -0.06, 0.05],
    decay: 1.55, stiffness: 0.00008, detune: 0.0006, noise: 0.045 }),
  cello: { ...celloBowed, fn(L, R, start, length, ev, sr, duration, level) {
    const voice = ev.articulation === 'pizzicato' ? celloPlucked : celloBowed;
    voice.fn(L, R, start, length, ev, sr, duration, level);
  } },
  piano: struckStrings({ release: 0.35, gain: 0.43, amplitudes: [0.79, 0.42, 0.3, 0.17, 0.11, 0.07, 0.042, 0.022],
    decay: 1.2, stiffness: 0.00031, detune: 0.0011, noise: 0.055 }),
  nylon: struckStrings({ release: 0.24, gain: 0.52, amplitudes: [0.9, 0.34, 0.2, -0.11, -0.12, -0.06, 0.067, 0.05],
    decay: 0.73, stiffness: 0.00012, noise: 0.08 }),
  upright: struckStrings({ release: 0.09, gain: 0.63, amplitudes: [0.95, 0.4, 0.21, 0.11, 0.09, 0.07, 0.03],
    decay: 0.37, stiffness: 0.00009, noise: 0.085 }),
  guitar: struckStrings({ release: 0.18, gain: 0.39, amplitudes: [0.72, 0.41, 0.32, 0.21, 0.18, 0.13, 0.07],
    decay: 0.8, stiffness: 0.00006, detune: 0.0007, drive: 1.65, noise: 0.08 }),
  'acoustic-guitar': struckStrings({ release: 0.21, gain: 0.43, amplitudes: [0.88, 0.44, 0.26, 0.13, -0.12, 0.06, 0.05],
    decay: 0.9, stiffness: 0.00008, noise: 0.075 }),
  flute: wind({ release: 0.14, gain: 0.47, attack: 0.075,
    harmonics: [1, 0.27, 0.16, 0.036], air: 0.21, vibrato: 0.005, brightness: 0.92 }),
  clarinet: wind({ release: 0.18, gain: 0.4, attack: 0.057,
    harmonics: [1, 0.11, 0.45, 0.08, 0.18, 0.04, 0.08], air: 0.1, vibrato: 0.0025, brightness: 1.05 }),
  brass: wind({ release: 0.21, gain: 0.38, attack: 0.085,
    harmonics: [0.87, 0.55, 0.48, 0.27, 0.22, 0.18, 0.14, 0.11], air: 0.08, vibrato: 0.0045, brightness: 1.06 }),
  trumpet: wind({ release: .17, gain: .40, attack: .051,
    harmonics: [.73, .58, .50, .34, .24, .17, .10], air: .12, vibrato: .003, brightness: 1.13 }),
  trombone: wind({ release: .20, gain: .42, attack: .071,
    harmonics: [.94, .57, .32, .20, .17, .10], air: .09, vibrato: .0028, brightness: .97 }),
  tuba: wind({ release: .20, gain: .49, attack: .092,
    harmonics: [1, .42, .24, .14, .09], air: .05, vibrato: .0019, brightness: .89 }),
};
