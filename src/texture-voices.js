'use strict';

const { makeRng } = require('./rng');

const TAU = Math.PI * 2;
const ELECTRIC = ['electric-clean', 'electric-drive', 'electric-swell'];
const ORCHESTRAL_TEXTURES = ['timpani', 'timpani-roll', 'concert-bass-drum', 'concert-snare', 'frame-drum', 'gong', 'cymbal-swell', 'orchestral-cymbals'];
const STUDIO_INSTRUMENTS = [...ELECTRIC, 'harp', 'vibraphone', 'cello', 'trumpet', 'trombone', 'tuba', ...ORCHESTRAL_TEXTURES];
const SOUNDS = {
  trumpet: ['Trompette', 'Cuivre aigu, jeu tenu ou détaché.', 'mel', 70, 56],
  trombone: ['Trombone ténor', 'Cuivre grave et franc, jeu tenu ou détaché.', 'counter', 53, 57],
  tuba: ['Tuba', 'Cuivre grave aux attaques rondes.', 'bass', 43, 58],
  timpani: ['Timbales', 'Frappes accordées et prises alternées.', 'texture', 43, 47],
  'timpani-roll': ['Roulement de timbales', 'Roulement continu accordé à la note jouée.', 'texture', 43, 47],
  'concert-bass-drum': ['Grosse caisse d’orchestre', 'Frappes graves de concert en deux nuances.', 'texture', 36, null],
  'concert-snare': ['Caisse claire à cordes', 'Caisse claire grave, frappes alternées.', 'texture', 38, null],
  'frame-drum': ['Tambour sur cadre', 'Résonance de peau et attaques alternées.', 'texture', 45, null],
  gong: ['Gong', 'Frappe métallique à longue résonance.', 'texture', 55, null],
  'cymbal-swell': ['Crescendo de cymbale', 'Roulement de cymbale dont le point fort tombe à la fin de la durée.', 'texture', 55, null],
  'orchestral-cymbals': ['Cymbales frappées', 'Accents d’orchestre à plusieurs nuances.', 'texture', 49, null],
  harp: ['Harpe de concert', 'Cordes pincées et résonance boisée, deux nuances enregistrées.', 'arp', 62, 46],
  vibraphone: ['Vibraphone', 'Lames de métal résonnantes, baguettes souples et dures selon la nuance.', 'mel', 65, 11],
  cello: ['Section de violoncelles', 'Archet, pizzicato et spiccato, plusieurs nuances et prises.', 'pad', 55, 42],
  'electric-clean': ['Guitare électrique claire', 'Prises au micro magnétique, attaque nette et léger chorus.', 'arp', 55, 27],
  'electric-drive': ['Guitare électrique saturée', 'Prises électriques avec saturation et filtrage de baffle.', 'arp', 48, 30],
  'electric-swell': ['Guitare en volume progressif', 'L’attaque s’efface et la note se déploie comme une nappe.', 'pad', 55, 27],
  'tape-keys': ['Clavier sur bande', 'Clavier électrique voilé, avec une fluctuation lente de hauteur.', 'mel', 65, 4],
  'glass-keys': ['Verre frappé', 'Attaque vitreuse, partiels inharmoniques et courte résonance.', 'mel', 71, 9],
  'bowed-metal': ['Métal frotté', 'Résonance accordée à l’archet, avec un frottement qui monte.', 'counter', 60, 98],
  'granular-pad': ['Nappe granulaire', 'Petits grains décalés, avec une légère dérive stéréo et de hauteur.', 'pad', 57, 89],
  'sub-pulse': ['Grave pulsé', 'Fondamentale ronde et pulsation douce, centrée dans le mix.', 'bass', 40, 38],
  'iron-scrape': ['Raclement métallique', 'Grain de friction et plusieurs résonances qui se déplacent.', 'texture', 55, null],
  'reverse-swell': ['Montée inversée', 'Gonflement de bruit filtré et de partiels avant une rupture.', 'texture', 50, null],
  'dark-impact': ['Impact sourd', 'Frappe brève, corps grave et décroissance irrégulière.', 'texture', 43, null],
  'tape-air': ['Souffle de bande', 'Fond de bruit instable, avec de petits passages plus rugueux.', 'texture', 54, null],
};

const COLORS = {
  natural: { low: 20, high: 18000, mix: 0, width: 1, drive: 0 },
  radio: { low: 260, high: 1500, mix: 0.98, width: 0.035, drive: 0.05 },
  warm: { low: 42, high: 2700, mix: 0.8, width: 0.64, drive: 0 },
  rough: { low: 82, high: 4800, mix: 0.78, width: 0.8, drive: 0.25 },
  wide: { low: 42, high: 9800, mix: 0.25, width: 1.26, drive: 0 },
};

const alpha = (hz, sr) => 1 - Math.exp(-TAU * Math.min(hz, sr * 0.45) / sr);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function voice(gain, release, setup) {
  return { gain, release, fn(L, R, start, length, ev, sr, seconds, level) {
    const pan = (ev.pan + 1) * Math.PI / 4;
    const gainL = level * ev.vel * Math.cos(pan), gainR = level * ev.vel * Math.sin(pan);
    const color = ev.timbre ?? 0.5;
    const out = [0, 0];
    const oscillator = setup(ev, sr, seconds, color);
    for (let i = 0; i < length; i++) {
      const t = i / sr;
      const releasePosition = Math.max(0, t - seconds) / release;
      if (releasePosition >= 1) break;
      oscillator(out, t);
      const attack = Math.min(1, t * 240);
      const remain = 0.5 + 0.5 * Math.cos(Math.PI * releasePosition);
      const progress = Math.min(1, t / Math.max(0.01, seconds));
      const expression = ev.expression ? ev.expression[0] + (ev.expression[1] - ev.expression[0]) * progress : 1;
      const envelope = attack * remain * expression;
      L[start + i] += (out[0] - out[1]) * envelope * gainL;
      R[start + i] += (out[0] + out[1]) * envelope * gainR;
    }
  } };
}

function resonator({ ratios, weights, decay, bowed = false }) {
  return (ev, sr, seconds, color) => {
    const rng = makeRng(ev.seedIdx);
    const partials = ratios.flatMap((ratio, i) => ev.freq * ratio < sr * 0.45 ? [{ hz: ev.freq * ratio,
      weight: weights[i] * (0.7 + color * 0.56) ** i, phase: rng.f(0, 0.4), spread: i % 2 ? -0.23 : 0.17 }] : []);
    let low = 0;
    const a = alpha(4200, sr);
    return (out, t) => {
      let sum = 0, side = 0;
      for (const [i, mode] of partials.entries()) {
        const phase = TAU * mode.hz * t + mode.phase;
        const env = bowed ? Math.min(1, t / 0.31) * (0.66 + 0.34 * Math.sin(TAU * (1.8 + i * 0.94) * t + mode.phase))
          : Math.exp(-t * (1 + i * 0.72) / decay);
        const v = Math.sin(phase + (bowed ? 0.12 * Math.sin(0.43 * phase) : 0)) * mode.weight * env;
        sum += v;
        side += v * mode.spread;
      }
      const air = rng.f(-1, 1);
      low += a * (air - low);
      out[0] = sum + low * (bowed ? 0.11 * Math.min(1, t / 0.2) : 0.055 * Math.exp(-t * 78));
      out[1] = side;
    };
  };
}

function drumTone(frequency, seconds, buzz, roll = false) {
  return (ev, sr, _duration, color) => {
    const rng = makeRng(ev.seedIdx);
    const coefficient = alpha(1600 + 4400 * color, sr);
    const hz = frequency ?? ev.freq;
    let low = 0;
    return (out, t) => {
      low += coefficient * (rng.f(-1, 1) - low);
      const phase = TAU * hz * t;
      const pulse = roll ? .62 + .38 * Math.cos(TAU * 15.3 * t) : Math.exp(-t / seconds);
      out[0] = pulse * (.66 * Math.sin(phase) + .22 * Math.sin(phase * 1.51) + buzz * low);
      out[1] = low * .045 * pulse;
    };
  };
}

function cymbal(crescendo) {
  return (ev, sr, seconds, color) => {
    const rng = makeRng(ev.seedIdx);
    const coefficient = alpha(1400 + 800 * color, sr);
    let low = 0;
    return (out, t) => {
      const noise = rng.f(-1, 1);
      low += coefficient * (noise - low);
      const progress = Math.min(1, t / Math.max(.05, seconds));
      const envelope = crescendo ? progress ** 2 * Math.exp(-Math.max(0, t - seconds) * 4) : Math.exp(-t * 3.1);
      out[0] = envelope * ((noise - low) * .71 + .13 * Math.sin(TAU * 2131 * t));
      out[1] = envelope * low * .21;
    };
  };
}

const gongResonator = resonator({ ratios: [1, 1.31, 1.89, 2.87, 4.03], weights: [.52, .35, .29, .22, .10], decay: 1.8 });
const textureVoices = {
  timpani: voice(.46, .41, drumTone(null, .48, .16)),
  'timpani-roll': voice(.39, .23, drumTone(null, .51, .19, true)),
  'concert-bass-drum': voice(.52, .32, drumTone(51, .37, .14)),
  'concert-snare': voice(.45, .19, drumTone(177, .083, .87)),
  'frame-drum': voice(.43, .23, drumTone(107, .20, .23)),
  gong: voice(.41, 1.20, (ev, sr, duration, color) => gongResonator({ ...ev, freq: 131 }, sr, duration, color)),
  'cymbal-swell': voice(.35, .64, cymbal(true)),
  'orchestral-cymbals': voice(.46, .76, cymbal(false)),
  vibraphone: voice(0.48, 0.48, resonator({ ratios: [1, 4, 9.2, 13.7], weights: [0.93, 0.22, 0.08, 0.027], decay: 1.8 })),
  'glass-keys': voice(0.48, 0.59, resonator({ ratios: [1, 2.43, 3.76, 5.18, 7.05], weights: [0.84, 0.42, 0.25, 0.18, 0.12], decay: 0.78 })),
  'bowed-metal': voice(0.41, 0.41, resonator({ ratios: [1, 1.41, 2.07, 2.89, 4.58], weights: [0.72, 0.2, 0.29, 0.16, 0.08], decay: 1.2, bowed: true })),
  'tape-keys': voice(0.47, 0.31, (ev, sr, _duration, color) => {
    let phase = 0, lp = 0;
    const rate = ev.freq / sr;
    const soft = alpha(1300 + color * 2300, sr);
    return (out, t) => {
      phase += TAU * rate * (1 + 0.0042 * Math.sin(TAU * 1.2 * t) + 0.0014 * Math.sin(TAU * 13.8 * t));
      const carrier = Math.sin(phase + (0.35 + (0.7 + color * 1.4) * Math.exp(-t * 7)) * Math.sin(phase * 2.003));
      const reed = 0.2 * Math.sin(phase * 2) * Math.exp(-t * 3.4);
      lp += soft * (carrier + reed - lp);
      out[0] = lp * (0.36 + 0.64 * Math.exp(-t * 1.35));
      out[1] = (Math.sin(phase + 0.2 * Math.sin(TAU * 0.57 * t)) - Math.sin(phase)) * 0.19;
    };
  }),
  'granular-pad': voice(0.46, 0.78, (ev, sr, _duration, color) => {
    const rng = makeRng(ev.seedIdx);
    const grains = Array.from({ length: 6 }, (_, i) => ({ age: 0, length: 0, offset: i * 0.035,
      hz: ev.freq, phase: 0, pan: i % 2 ? 0.38 : -0.38 }));
    const replenish = (grain) => {
      grain.length = rng.f(0.1, 0.32);
      grain.age = 0;
      grain.phase = rng.f(0, TAU);
      grain.hz = ev.freq * rng.f(0.99 - color * 0.019, 1.01 + color * 0.019) * (rng.chance(color * 0.55) ? 2 : 1);
    };
    return (out, t) => {
      let mid = 0, side = 0;
      for (const grain of grains) {
        if (t < grain.offset) continue;
        if (grain.age >= grain.length) replenish(grain);
        const p = grain.age / grain.length;
        const gain = 0.5 - 0.5 * Math.cos(TAU * p);
        grain.phase += TAU * grain.hz * (0.997 + 0.006 * p) / sr;
        const x = Math.sin(grain.phase + 0.18 * Math.sin(grain.phase * 1.49)) * gain;
        mid += x;
        side += x * grain.pan;
        grain.age += 1 / sr;
      }
      out[0] = mid * 0.28;
      out[1] = side * 0.22;
    };
  }),
  'sub-pulse': voice(0.56, 0.16, (ev, _sr, _duration, color) => {
    const hz = clamp(ev.freq, 32, 135);
    return (out, t) => {
      const pulse = 0.52 + 0.48 * (0.5 + 0.5 * Math.cos(TAU * (1.7 + 2.1 * color) * t)) ** 3;
      const phase = TAU * hz * t;
      out[0] = (0.8 * Math.sin(phase) + 0.19 * Math.sin(phase * 2) + 0.07 * color * Math.sin(phase * 3)) * pulse;
      out[1] = 0;
    };
  }),
};

function texture(kind) {
  return voice(kind === 'dark-impact' ? 0.72 : 0.43, kind === 'dark-impact' ? 0.53 : 0.24, (ev, sr, duration, color) => {
    const rng = makeRng(ev.seedIdx);
    const narrow = alpha(230 + 410 * color, sr), bright = alpha(1200 + 5500 * color, sr);
    const hz = clamp(ev.freq, 44, 480);
    let low = 0, high = 0, phase = 0;
    return (out, t) => {
      const noise = rng.f(-1, 1);
      low += narrow * (noise - low);
      high += bright * (noise - high);
      const p = Math.min(1, t / Math.max(0.01, duration));
      const grain = 0.58 + 0.28 * Math.sin(TAU * 5.7 * t) + 0.14 * Math.sin(TAU * 22.4 * t);
      const airy = high - low;
      if (kind === 'tape-air') {
        out[0] = (airy * 0.7 + low * 0.4) * grain * Math.min(1, p * 9);
        out[1] = (noise - high) * 0.09;
      } else if (kind === 'reverse-swell') {
        const edge = p < 0.97 ? p ** 2.15 : (1 - p) / 0.03;
        const tone = 0.17 * Math.sin(TAU * hz * t) + 0.11 * Math.sin(TAU * hz * 1.5 * t);
        out[0] = (airy * 0.83 + tone) * edge;
        out[1] = (noise - high) * edge * 0.15;
      } else if (kind === 'iron-scrape') {
        phase += TAU * (340 + hz * (0.5 + p) + color * 340) / sr;
        const ring = Math.sin(phase) + 0.5 * Math.sin(phase * 1.93) + 0.28 * Math.sin(phase * 2.614);
        const curve = Math.sin(Math.PI * p) ** 0.83;
        out[0] = (airy * grain + 0.11 * ring) * curve;
        out[1] = Math.sin(phase * 1.69) * curve * 0.12;
      } else {
        phase += TAU * (clamp(hz * 0.65, 36, 100) + 88 * Math.exp(-t * 24)) / sr;
        const weight = Math.exp(-t * 9);
        out[0] = 0.88 * Math.sin(phase) * weight + (low * 0.54 + airy * 0.40) * Math.exp(-t * 22);
        out[1] = airy * Math.exp(-t * 28) * 0.15;
      }
    };
  });
}

for (const [id, spec] of Object.entries(SOUNDS)) if (spec[2] === 'texture') textureVoices[id] = texture(id);

function electricFallback(mode) {
  return voice(0.45, 0.18, (ev, sr, seconds, color) => {
    const edge = alpha(mode === 'electric-drive' ? 3500 : 4700, sr);
    let a = 0, b = 0;
    return (out, t) => {
      const p = TAU * ev.freq * t;
      const base = Math.sin(p) + 0.42 * Math.sin(p * 2 + 0.2) + 0.27 * Math.sin(p * 3) + 0.12 * Math.sin(p * 5);
      const sharp = base * Math.exp(-t * (1.3 + color * 0.4));
      const x = mode === 'electric-drive' ? Math.tanh(sharp * (3.1 + 5 * color)) : sharp;
      a += edge * (x - a);
      b += edge * (a - b);
      const swell = mode === 'electric-swell' ? Math.sin(Math.min(1, t / Math.max(0.04, Math.min(seconds * 0.59, 0.85))) * Math.PI / 2) ** 2 : 1;
      out[0] = b * swell;
      out[1] = mode === 'electric-clean' ? 0.14 * (Math.sin(p + 0.19 * Math.sin(TAU * 0.8 * t)) - Math.sin(p)) * swell : 0;
    };
  });
}

for (const id of ELECTRIC) textureVoices[id] = electricFallback(id);

module.exports = { SOUNDS, COLORS, ELECTRIC, ORCHESTRAL_TEXTURES, STUDIO_INSTRUMENTS, textureVoices };
