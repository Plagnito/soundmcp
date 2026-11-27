'use strict';

const { ui } = require('./language');

/**
 * Ambiances de jeu en boucle parfaite : pluie, orage, vent, forêt, feu de camp,
 * océan, rivière, grotte, vaisseau, café, nuit. Zéro dépendance.
 *
 * Chaque ambiance combine :
 *  - un « bed » de couches de bruit continu filtré (roulements browniens,
 *    souffles, sizzles) modulées par des LFO lents et une dérive aléatoire ;
 *  - des événements stochastiques ponctuels (gouttes, oiseaux, crépitements,
 *    tonnerre, vagues, bips…) synthétisés avec les primitives des SFX.
 *
 * Boucle parfaite sans contrainte de périodicité : le contenu est généré sur
 * D + F secondes (F ≈ 0.8 s de fondu), puis les F dernières secondes sont
 * fondées en fondu avec le début (crossfade circulaire). Le raccord est
 * inaudible, la sortie dure exactement D secondes.
 */

const path = require('node:path');
const { makeRng, randomSeed, hash32 } = require('./rng');
const { lpCoef, masterOutput, writeWav } = require('./dsp');
const { Mixer, renderTone, renderNoise } = require('./sfx');

const CROSSFADE_SEC = 0.8;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ---------------------------------- couches continues ---------------------------------- */

/**
 * Rend une couche de bruit continu (bed) sur n échantillons.
 * cfg : {
 *   wave: 'brown' | 'white',
 *   gain: 0.4,           // gain nominal
 *   lp: 600,             // passe-bas (Hz, 0/falsy = off)
 *   hp: 0,               // passe-haut (Hz)
 *   lfoRate: 0.07,       // fréquence de modulation du gain (Hz, 0 = off)
 *   lfoDepth: 0.3,       // profondeur de modulation (0-1)
 *   pan: 0,              // -1 (gauche) à 1 (droite)
 *   wander: 0.2,         // dérive lente du gain (0-0.6) : cible re-tirée toutes les ~2 s
 * }
 * Les LFO/dérives n'ont pas besoin d'être périodiques : le crossfade
 * circulaire recolle le début à la fin.
 */
function renderBedLayer(cfg, sr, n, rng) {
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const aLP = cfg.lp ? lpCoef(cfg.lp, sr) : 0;
  const aHP = cfg.hp ? lpCoef(cfg.hp, sr) : 0;
  const brown = cfg.wave === 'brown';
  const gain = cfg.gain ?? 0.4;
  const lfoRate = cfg.lfoRate || 0;
  const lfoDepth = clamp(cfg.lfoDepth || 0, 0, 0.9);
  const lfoPh = rng.f(0, Math.PI * 2);
  const wander = clamp(cfg.wander || 0, 0, 0.6);
  const segN = Math.max(16, Math.round(sr * 2)); // fenêtre de dérive ~2 s
  let segStart = 1, segTarget = 1, segI = 0;
  const a = (cfg.pan || 0) + 1;
  const gl = Math.cos((a * Math.PI) / 4);
  const gr = Math.sin((a * Math.PI) / 4);
  let brownS = 0, lpS = 0, hpS = 0;
  for (let i = 0; i < n; i++) {
    let g = gain;
    if (wander) {
      if (segI >= segN) { segStart = segTarget; segTarget = 1 + rng.f(-wander, wander); segI = 0; }
      const u = segI / segN;
      const w = 0.5 - 0.5 * Math.cos(u * Math.PI); // lissage cosinus
      g *= segStart + (segTarget - segStart) * w;
      segI++;
    }
    if (lfoRate) {
      g *= 1 - lfoDepth * (0.5 - 0.5 * Math.sin(lfoPh + (2 * Math.PI * lfoRate * i) / sr));
    }
    let x = rng.f(-1, 1);
    if (brown) { brownS = (brownS + x * 0.08) * 0.996; x = brownS * 3.2; }
    if (aHP) { hpS += aHP * (x - hpS); x = x - hpS; }
    if (aLP) { lpS += aLP * (x - lpS); x = lpS; }
    L[i] += x * g * gl;
    R[i] += x * g * gr;
  }
  return { L, R };
}

/** Hum continu (moteur de vaisseau) : somme de sinus avec vibrato d'amplitude lent. */
function renderHumLayer(freqs, sr, n, { gain = 0.12, vibRate = 0.17, vibDepth = 0.25 } = {}, rng) {
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const phs = freqs.map(() => rng.f(0, Math.PI * 2));
  const lfoPh = rng.f(0, Math.PI * 2);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const m = 1 - vibDepth + vibDepth * (0.5 + 0.5 * Math.sin(lfoPh + 2 * Math.PI * vibRate * t));
    let v = 0;
    for (let k = 0; k < freqs.length; k++) v += Math.sin(2 * Math.PI * freqs[k] * t + phs[k]);
    v = (v / freqs.length) * gain * m;
    L[i] += v;
    R[i] += v * 0.97;
  }
  return { L, R };
}

/* ---------------------------------- événements ---------------------------------- */

/** Micro-bursts de bruit très courts : pluie sur feuillage, feu, poussière. */
function crackles(rng, durSec, {
  rateMin = 0.08, rateMax = 0.25, hp = 1800, lp = 7000,
  gain = 0.14, durMin = 0.003, durMax = 0.014, brown = false, panSpread = 0.5,
} = {}) {
  const items = [];
  let t = rng.f(0, rateMax);
  while (t < durSec - 0.1) {
    items.push({
      at: t,
      spec: {
        type: 'noise',
        dur: rng.f(durMin, durMax),
        hp, lp,
        gain: gain * rng.f(0.5, 1.3),
        env: 'exp',
        tau: 0.012,
        brown,
        pan: rng.f(-panSpread, panSpread),
      },
    });
    t += rng.f(rateMin, rateMax);
  }
  return items;
}

/** Gouttes : pluches descendants (cave, goutte-à-goutte, pluie sur tôle). */
function drops(rng, durSec, {
  rateMin = 0.4, rateMax = 1.6, fMin = 900, fMax = 1700,
  gain = 0.1, dur = 0.05, splash = false, echoes = 0, echoDelay = 0.22, echoGain = 0.45,
} = {}) {
  const items = [];
  let t = rng.f(0, 0.5);
  while (t < durSec - 0.3) {
    const f = rng.f(fMin, fMax);
    const g = gain * rng.f(0.6, 1.2);
    items.push({
      at: t,
      spec: { type: 'tone', dur, f0: f, f1: f * 0.55, wave: 'sine', gain: g, attack: 0.001, release: 0.012 },
    });
    if (splash) {
      items.push({ at: t + dur * 0.4, spec: { type: 'noise', dur: 0.03, hp: 1200, lp: 5000, gain: g * 0.5, env: 'exp', tau: 0.01 } });
    }
    for (let e = 1; e <= echoes; e++) {
      const ge = g * Math.pow(echoGain, e);
      if (ge < 0.005) break;
      items.push({
        at: t + e * echoDelay * rng.f(0.9, 1.1),
        spec: { type: 'tone', dur, f0: f * 0.92, f1: f * 0.55, wave: 'sine', gain: ge, attack: 0.001, release: 0.012 },
      });
    }
    t += rng.f(rateMin, rateMax);
  }
  return items;
}

/** Oiseaux : petits groupes de blips montants rapides. */
function birds(rng, durSec, {
  everyMin = 2.5, everyMax = 7, fMin = 1800, fMax = 4200,
  gain = 0.1, notesMin = 2, notesMax = 4,
} = {}) {
  const items = [];
  let t = rng.f(0.5, 2);
  while (t < durSec - 0.6) {
    const base = rng.f(fMin, fMax);
    const dir = rng.chance(0.6) ? 1 : -1; // montant ou descendant
    const n = rng.int(notesMin, notesMax);
    let off = 0;
    for (let i = 0; i < n; i++) {
      const f = base * Math.pow(1.12, dir * i);
      const d = rng.f(0.03, 0.07);
      items.push({
        at: t + off,
        spec: { type: 'tone', dur: d, f0: f * 0.85, f1: f * 1.18, wave: 'sine', gain, attack: 0.002, release: 0.012, pan: rng.f(-0.6, 0.6) },
      });
      off += d + rng.f(0.03, 0.09);
    }
    t += rng.f(everyMin, everyMax);
  }
  return items;
}

/** Grillons : stridulations rapides en séries régulières (nuit d'été). */
function crickets(rng, durSec, {
  fMin = 4300, fMax = 5200, gain = 0.07,
  seriesEveryMin = 0.5, seriesEveryMax = 1.4,
} = {}) {
  const items = [];
  let t = rng.f(0, 1);
  while (t < durSec - 0.8) {
    const f = rng.f(fMin, fMax);
    const n = rng.int(3, 6);
    let off = 0;
    for (let i = 0; i < n; i++) {
      items.push({
        at: t + off,
        spec: { type: 'tone', dur: 0.02, f0: f, f1: f * 1.02, wave: 'sine', gain, attack: 0.002, release: 0.006, pan: rng.f(-0.4, 0.4) },
      });
      off += rng.f(0.032, 0.05);
    }
    t += rng.f(seriesEveryMin, seriesEveryMax);
  }
  return items;
}

/** Vagues : souffles amples qui montent puis retombent (océan, mer, vent). */
function waves(rng, durSec, {
  periodMin = 5, periodMax = 9, gain = 0.5,
  lpFrom = 350, lpPeak = 2200, lpTo = 280, brown = true, foam = true,
} = {}) {
  const items = [];
  let t = rng.f(0, 2);
  while (t < durSec - 8) {
    const dur = rng.f(periodMin, periodMax) * 0.8;
    items.push({
      at: t,
      spec: {
        type: 'noise', dur, gain: gain * rng.f(0.75, 1.1),
        env: 'hump', brown, lpEnv: { from: lpFrom, peak: lpPeak, to: lpTo },
      },
    });
    if (foam) {
      // écume : sizzle white qui suit la crête
      items.push({
        at: t + dur * 0.35,
        spec: { type: 'noise', dur: dur * 0.5, gain: gain * 0.18, env: 'hump', hp: 700, lp: 3600 },
      });
    }
    t += dur * rng.f(0.9, 1.15);
  }
  return items;
}

/** Tonnerre : craquement initial + grondement long vers le grave. */
function thunder(rng, durSec, { everyMin = 6, everyMax = 16, gain = 0.8 } = {}) {
  const items = [];
  let t = rng.f(2, everyMax * 0.6);
  while (t < durSec - 4.5) {
    const dur = rng.f(1.6, 3.4);
    const g = gain * rng.f(0.6, 1);
    if (rng.chance(0.7)) {
      items.push({ at: t, spec: { type: 'noise', dur: 0.14, hp: 1300, gain: g * 0.4, env: 'exp', tau: 0.05 } });
    }
    items.push({
      at: t + 0.06,
      spec: {
        type: 'noise', dur, gain: g,
        env: 'hump', brown: true, lpEnv: { from: 700, peak: rng.f(900, 1600), to: 60 },
      },
    });
    t += rng.f(everyMin, everyMax);
  }
  return items;
}

/** Bruits de voix murmurées (brouhaha de café) : souffles courts modulés. */
function chatter(rng, durSec, { rateMin = 0.5, rateMax = 2, gain = 0.1 } = {}) {
  const items = [];
  let t = rng.f(0, 1);
  while (t < durSec - 0.6) {
    const dur = rng.f(0.12, 0.4);
    items.push({
      at: t,
      spec: {
        type: 'noise', dur, gain: gain * rng.f(0.5, 1.1),
        env: 'hump', lp: rng.f(700, 1300), hp: rng.f(180, 320),
        pan: rng.f(-0.5, 0.5),
      },
    });
    t += rng.f(rateMin, rateMax);
  }
  return items;
}

/** Tintements de tasse/verre : chocs inharmoniques courts et clairs. */
function clinks(rng, durSec, { rateMin = 1.5, rateMax = 5, fMin = 1700, fMax = 2700, gain = 0.09 } = {}) {
  const items = [];
  let t = rng.f(0.3, 2);
  while (t < durSec - 0.5) {
    const f = rng.f(fMin, fMax);
    items.push({ at: t, spec: { type: 'tone', dur: 0.07, f0: f, wave: 'sine', gain, decay: 0.02, attack: 0.001, pan: rng.f(-0.5, 0.5) } });
    items.push({ at: t, spec: { type: 'tone', dur: 0.09, f0: f * 1.51, wave: 'sine', gain: gain * 0.4, decay: 0.025, attack: 0.001, pan: rng.f(-0.5, 0.5) } });
    t += rng.f(rateMin, rateMax);
  }
  return items;
}

/** Bips électroniques rares (vaisseau, terminal). */
function bips(rng, durSec, { rateMin = 4, rateMax = 10, fPool = [880, 1175, 1320], gain = 0.05 } = {}) {
  const items = [];
  let t = rng.f(1, rateMax);
  while (t < durSec - 0.5) {
    const f = rng.pick(fPool);
    items.push({ at: t, spec: { type: 'tone', dur: 0.09, f0: f, wave: 'square', lpHz: 3200, gain, attack: 0.004, release: 0.02, pan: rng.f(-0.3, 0.3) } });
    if (rng.chance(0.35)) {
      items.push({ at: t + 0.12, spec: { type: 'tone', dur: 0.07, f0: f * 1.5, wave: 'square', lpHz: 3200, gain: gain * 0.8, attack: 0.004, release: 0.02 } });
    }
    t += rng.f(rateMin, rateMax);
  }
  return items;
}

/** Souffles qui passent (courants d'air, vaisseau, cave profonde). */
function gusts(rng, durSec, { everyMin = 5, everyMax = 12, gain = 0.12, lpFrom = 300, lpPeak = 1800, lpTo = 250 } = {}) {
  return waves(rng, durSec, { periodMin: everyMin, periodMax: everyMax, gain, lpFrom, lpPeak, lpTo, brown: true, foam: false });
}

/**
 * Planifie les événements d'un générateur dans le mixeur.
 * fn(rng, durSec) → [{ at, spec }] ; les specs sont rendues avec les
 * primitives SFX (renderTone / renderNoise), chaque bruit ayant son seed dérivé.
 */
function scheduleEvents(fn, mix, rng, durSec, seed) {
  const items = fn(rng, durSec);
  items.forEach((it, idx) => {
    const spec = it.spec;
    if (spec.type === 'noise') renderNoise(mix, spec, hash32(seed, idx + 101));
    else renderTone(mix, spec);
  });
}

/* ---------------------------------- registre des ambiances ---------------------------------- */

const AMBIENCE_KINDS = {
  rain: {
    desc: ui('Pluie fine sur un feuillage : souffle grave doux, sizzle des gouttes, pluches éparses.', 'Light rain on leaves with a soft low wash and scattered droplets.'),
    defaultSec: 45,
    bed(rng) {
      return [
        { wave: 'brown', gain: 0.5, lp: 650, lfoRate: 0.06, lfoDepth: 0.22, wander: 0.12 },
        { wave: 'white', gain: 0.22, lp: 5200, hp: 500, lfoRate: 0.11, lfoDepth: 0.3 },
        { wave: 'white', gain: 0.07, lp: 9000, hp: 2600 },
      ];
    },
    events(rng, durSec) {
      return [
        ...crackles(rng, durSec, { rateMin: 0.05, rateMax: 0.2, hp: 1500, lp: 7000, gain: 0.09 }),
        ...drops(rng, durSec, { rateMin: 0.4, rateMax: 1.7, fMin: 900, fMax: 1700, gain: 0.09 }),
      ];
    },
  },

  storm: {
    desc: ui('Orage : pluie dense, vent qui se lève, coups de tonnerre espacés.', 'Heavy rain, rising wind, and occasional thunder.'),
    defaultSec: 60,
    bed(rng) {
      return [
        { wave: 'brown', gain: 0.5, lp: 420, lfoRate: 0.05, lfoDepth: 0.35, wander: 0.3 },
        { wave: 'white', gain: 0.3, lp: 5000, hp: 380, lfoRate: 0.09, lfoDepth: 0.3 },
        { wave: 'brown', gain: 0.3, lp: 120, lfoRate: 0.03, lfoDepth: 0.45 },
      ];
    },
    events(rng, durSec) {
      return [
        ...crackles(rng, durSec, { rateMin: 0.03, rateMax: 0.12, hp: 1400, lp: 7500, gain: 0.12 }),
        ...thunder(rng, durSec, { everyMin: 5, everyMax: 15, gain: 0.85 }),
      ];
    },
  },

  wind: {
    desc: ui('Vent : souffle ample qui va et vient, sifflement léger sur les crêtes.', 'Broad gusts of wind with a light whistle.'),
    defaultSec: 50,
    bed(rng) {
      return [
        { wave: 'brown', gain: 0.55, lp: 380, lfoRate: 0.07, lfoDepth: 0.45, wander: 0.35 },
        { wave: 'white', gain: 0.1, lp: 4600, hp: 800, lfoRate: 0.13, lfoDepth: 0.5, pan: 0.25 },
        { wave: 'brown', gain: 0.25, lp: 260, lfoRate: 0.045, lfoDepth: 0.4, pan: -0.3 },
      ];
    },
    events(rng, durSec) {
      return [
        ...gusts(rng, durSec, { everyMin: 6, everyMax: 13, gain: 0.25, lpFrom: 320, lpPeak: 1500, lpTo: 240 }),
        ...crackles(rng, durSec, { rateMin: 0.5, rateMax: 2, hp: 900, lp: 4200, gain: 0.03, durMax: 0.03 }),
      ];
    },
  },

  forest: {
    desc: ui('Forêt de jour : brise dans les feuilles, feuillages frottés, oiseaux épars.', 'Daytime forest with a breeze, rustling leaves, and scattered birds.'),
    defaultSec: 55,
    bed(rng) {
      return [
        { wave: 'brown', gain: 0.24, lp: 300, lfoRate: 0.05, lfoDepth: 0.3, wander: 0.2 },
        { wave: 'white', gain: 0.055, lp: 5500, hp: 1200, lfoRate: 0.09, lfoDepth: 0.4 },
      ];
    },
    events(rng, durSec) {
      return [
        ...birds(rng, durSec, { everyMin: 2.5, everyMax: 7, gain: 0.09 }),
        ...crackles(rng, durSec, { rateMin: 0.9, rateMax: 3.5, hp: 1000, lp: 4800, gain: 0.045, durMin: 0.04, durMax: 0.14, panSpread: 0.6 }),
      ];
    },
  },

  campfire: {
    desc: ui('Feu de camp : ronron chaud, crépitements vifs, occasionnels petits éclats.', 'Warm campfire with lively crackling and occasional pops.'),
    defaultSec: 45,
    bed(rng) {
      return [
        { wave: 'brown', gain: 0.42, lp: 520, lfoRate: 0.05, lfoDepth: 0.25, wander: 0.2 },
        { wave: 'brown', gain: 0.26, lp: 170, lfoRate: 0.03, lfoDepth: 0.35 },
        { wave: 'white', gain: 0.03, lp: 2600, hp: 300, lfoRate: 0.08, lfoDepth: 0.4 },
      ];
    },
    events(rng, durSec) {
      const items = [
        ...crackles(rng, durSec, { rateMin: 0.07, rateMax: 0.28, hp: 1700, lp: 7200, gain: 0.15 }),
      ];
      // éclats : pops graves ponctuels
      let t = rng.f(0.5, 2.5);
      while (t < durSec - 0.4) {
        const f = rng.f(280, 620);
        items.push({ at: t, spec: { type: 'tone', dur: 0.035, f0: f, f1: f * 0.6, wave: 'sine', gain: 0.06, attack: 0.001, release: 0.008 } });
        t += rng.f(0.8, 3);
      }
      return items;
    },
  },

  ocean: {
    desc: ui('Océan : longues vagues qui montent et retombent, écume sur le sable.', 'Long ocean waves breaking into foam on the sand.'),
    defaultSec: 60,
    bed(rng) {
      return [
        { wave: 'brown', gain: 0.32, lp: 380, lfoRate: 0.03, lfoDepth: 0.3, wander: 0.25 },
        { wave: 'white', gain: 0.04, lp: 3000, hp: 500, lfoRate: 0.045, lfoDepth: 0.4 },
      ];
    },
    events(rng, durSec) {
      return [
        ...waves(rng, durSec, { periodMin: 5.5, periodMax: 9.5, gain: 0.55, lpFrom: 320, lpPeak: 2300, lpTo: 260 }),
      ];
    },
  },

  river: {
    desc: ui('Rivière : clapotis continu de l\'eau qui court, remous et petites vagues.', 'Running river with ripples and small eddies.'),
    defaultSec: 45,
    bed(rng) {
      return [
        { wave: 'white', gain: 0.3, lp: 6800, hp: 550, lfoRate: 0.1, lfoDepth: 0.22 },
        { wave: 'brown', gain: 0.26, lp: 620, lfoRate: 0.07, lfoDepth: 0.25, wander: 0.2 },
      ];
    },
    events(rng, durSec) {
      return [
        ...waves(rng, durSec, { periodMin: 2.2, periodMax: 4.5, gain: 0.3, lpFrom: 600, lpPeak: 3200, lpTo: 500, foam: false }),
        ...crackles(rng, durSec, { rateMin: 0.25, rateMax: 1, hp: 1200, lp: 6000, gain: 0.07, durMin: 0.01, durMax: 0.05 }),
      ];
    },
  },

  cave: {
    desc: ui('Grotte : gravité sourde, gouttes d\'eau qui résonnent avec leur écho.', 'Low cave ambience with resonant water drops.'),
    defaultSec: 60,
    bed(rng) {
      return [
        { wave: 'brown', gain: 0.4, lp: 160, lfoRate: 0.02, lfoDepth: 0.3, wander: 0.15 },
        { wave: 'white', gain: 0.035, lp: 900, lfoRate: 0.05, lfoDepth: 0.35 },
      ];
    },
    events(rng, durSec) {
      const items = [
        ...drops(rng, durSec, { rateMin: 1.8, rateMax: 6, fMin: 750, fMax: 1500, gain: 0.13, splash: true, echoes: 3, echoDelay: 0.24, echoGain: 0.5 }),
      ];
      // craquements minéraux profonds très rares
      let t = rng.f(4, 12);
      while (t < durSec - 3) {
        items.push({
          at: t,
          spec: { type: 'noise', dur: rng.f(0.8, 1.6), gain: 0.2, env: 'hump', brown: true, lpEnv: { from: 260, peak: 420, to: 60 } },
        });
        t += rng.f(8, 20);
      }
      return items;
    },
  },

  spaceship: {
    desc: ui('Vaisseau : hum grave des moteurs, souffle de ventilation, bips rares.', 'Low engine hum, ventilation, and rare beeps.'),
    defaultSec: 50,
    bed(rng) {
      return [
        { wave: 'brown', gain: 0.3, lp: 240, lfoRate: 0.04, lfoDepth: 0.2, wander: 0.1 },
        { wave: 'white', gain: 0.035, lp: 3400, hp: 500, lfoRate: 0.07, lfoDepth: 0.3 },
      ];
    },
    events(rng, durSec) {
      return [
        ...bips(rng, durSec, { rateMin: 4, rateMax: 9, gain: 0.05 }),
        ...gusts(rng, durSec, { everyMin: 7, everyMax: 14, gain: 0.14, lpFrom: 260, lpPeak: 1400, lpTo: 220 }),
      ];
    },
    hum: [52, 104, 156],
    humOpts: { gain: 0.1, vibRate: 0.13, vibDepth: 0.3 },
  },

  cafe: {
    desc: ui('Café : brouhaha de conversations, tintements de tasses, mouvement feutré.', 'Muffled conversation, clinking cups, and quiet movement.'),
    defaultSec: 55,
    bed(rng) {
      return [
        { wave: 'brown', gain: 0.3, lp: 560, lfoRate: 0.08, lfoDepth: 0.25, wander: 0.3 },
        { wave: 'white', gain: 0.075, lp: 2400, hp: 350, lfoRate: 0.2, lfoDepth: 0.3 },
      ];
    },
    events(rng, durSec) {
      return [
        ...chatter(rng, durSec, { rateMin: 0.45, rateMax: 1.8, gain: 0.11 }),
        ...clinks(rng, durSec, { rateMin: 1.4, rateMax: 4.5, gain: 0.08 }),
      ];
    },
  },

  night: {
    desc: ui('Nuit calme : très bas, grillons stridulants, chouette au loin, brise légère.', 'Quiet night with crickets, a distant owl, and a light breeze.'),
    defaultSec: 60,
    bed(rng) {
      return [
        { wave: 'brown', gain: 0.3, lp: 130, lfoRate: 0.02, lfoDepth: 0.25, wander: 0.1 },
        { wave: 'white', gain: 0.022, lp: 2600, hp: 500, lfoRate: 0.05, lfoDepth: 0.35 },
      ];
    },
    events(rng, durSec) {
      const items = [
        ...crickets(rng, durSec, { gain: 0.075 }),
        ...gusts(rng, durSec, { everyMin: 8, everyMax: 16, gain: 0.14, lpFrom: 220, lpPeak: 1100, lpTo: 180 }),
      ];
      // chouette : deux tons descendants graves, très rares
      let t = rng.f(4, 14);
      while (t < durSec - 2.5) {
        const f = rng.f(440, 520);
        items.push({ at: t, spec: { type: 'tone', dur: 0.4, f0: f, f1: f * 0.88, wave: 'sine', gain: 0.07, vib: 0.4, vibHz: 5, attack: 0.03, release: 0.08 } });
        items.push({ at: t + 0.62, spec: { type: 'tone', dur: 0.35, f0: f * 0.95, f1: f * 0.8, wave: 'sine', gain: 0.06, vib: 0.4, vibHz: 5, attack: 0.03, release: 0.08 } });
        t += rng.f(12, 26);
      }
      return items;
    },
  },
};

const AMBIENCE_IDS = Object.keys(AMBIENCE_KINDS);

/* ---------------------------------- rendu ---------------------------------- */

/**
 * Crée une ambiance. Retourne { path, kind, seed, bytes, durationSeconds, desc, loop }.
 * opts : { seed, durationSec, volume, sr, mono, outputDir }
 * La sortie est toujours une boucle parfaite (crossfade circulaire intégré).
 */
function createAmbience(kind, opts = {}) {
  const def = AMBIENCE_KINDS[kind];
  if (!def) throw new Error(ui(`Ambiance inconnue: ${kind}. Disponibles: ${AMBIENCE_IDS.join(', ')}`, `Unknown ambience: ${kind}. Available: ${AMBIENCE_IDS.join(', ')}`));
  const seed = opts.seed == null ? randomSeed() : opts.seed >>> 0;
  const rng = makeRng(seed);
  const sr = opts.sr || 44100;
  const durSec = clamp(opts.durationSec ?? def.defaultSec ?? 45, 5, 600);
  const vol = clamp(opts.volume ?? 1, 0.05, 1);

  const D = Math.round(durSec * sr);
  const F = Math.min(Math.round(CROSSFADE_SEC * sr), Math.floor(D / 4));
  const nLayer = D + F;

  // 1. couches continues (bed)
  const bedL = new Float32Array(nLayer);
  const bedR = new Float32Array(nLayer);
  const addLayer = (layer) => {
    for (let i = 0; i < nLayer; i++) {
      bedL[i] += layer.L[i];
      bedR[i] += layer.R[i];
    }
  };
  for (const cfg of def.bed(rng)) addLayer(renderBedLayer(cfg, sr, nLayer, rng));
  if (def.hum) addLayer(renderHumLayer(def.hum, sr, nLayer, def.humOpts || {}, rng));

  // 2. événements stochastiques
  const mix = new Mixer(sr, durSec + CROSSFADE_SEC + 0.1);
  mix.add(bedL, bedR, 0);
  if (def.events) scheduleEvents(def.events, mix, rng, durSec, seed);

  // 3. master sur le flux continu complet (D+F) : HP 32 Hz + écrêtage doux +
  //    normalisation. En maîtrisant AVANT le crossfade, la couture de boucle
  //    relie deux échantillons consécutifs du flux masterisé (échauffement du
  //    filtre HP compris) : le raccord reste exactement continu.
  const full = masterOutput(mix.L, mix.R, nLayer, sr, 0);

  // 4. crossfade circulaire : les F dernières secondes fondent dans le début
  const outL = new Float32Array(D);
  const outR = new Float32Array(D);
  for (let i = 0; i < D; i++) {
    if (i < F) {
      const u = i / F;
      outL[i] = full.L[D + i] * (1 - u) + full.L[i] * u;
      outR[i] = full.R[D + i] * (1 - u) + full.R[i] * u;
    } else {
      outL[i] = full.L[i];
      outR[i] = full.R[i];
    }
  }

  // 5. volume relatif, puis écriture (stéréo ou mono 1 canal)
  if (vol !== 1) {
    for (let i = 0; i < outL.length; i++) { outL[i] *= vol; outR[i] *= vol; }
  }
  const mono = !!opts.mono;
  if (mono) { for (let i = 0; i < outL.length; i++) outL[i] = outR[i] = (outL[i] + outR[i]) / 2; }

  const outDir = opts.outputDir || path.join(__dirname, '..', 'output');
  const file = path.join(outDir, `ambience-${kind}-${seed}.wav`);
  const res = writeWav(file, outL, outR, sr, mono);
  return {
    path: file,
    kind,
    seed,
    bytes: res.bytes,
    durationSeconds: Math.round(durSec * 100) / 100,
    desc: def.desc,
    loop: true,
  };
}

module.exports = { createAmbience, AMBIENCE_IDS, AMBIENCE_KINDS };
