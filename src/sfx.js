'use strict';

/**
 * Effets sonores procéduraux pour les jeux : jump, coin, hit, explosion…
 * Chaque preset est un mini-programme de synthèse (oscillateurs + bruit filtré).
 * Déterministe via seed.
 */

const path = require('node:path');
const { makeRng, randomSeed, hash32 } = require('./rng');
const { writeWav } = require('./dsp');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lpCoef = (hz, sr) => 1 - Math.exp((-2 * Math.PI * hz) / sr);
const panGains = (pan) => {
  const a = (pan + 1) * (Math.PI / 4);
  return [Math.cos(a), Math.sin(a)];
};

const SFX_KINDS = {
  jump: { desc: 'Saut : sweep carré ascendant (plateformeur)' },
  coin: { desc: 'Pièce : deux notes brillantes, classique arcade' },
  pickup: { desc: 'Ramassage : pluck doux' },
  hit: { desc: 'Coup reçu : bruit + impact grave' },
  damage: { desc: 'Dégâts : impact agressif + buzz descendant' },
  explosion: { desc: 'Explosion : souffle grave long + sub' },
  whoosh: { desc: 'Passage rapide : souffle filtré montant/descendant' },
  laser: { desc: 'Laser : sweep descendant métallique' },
  powerup: { desc: 'Power-up : arpège carré ascendant' },
  levelup: { desc: 'Level-up : fanfare de cloches (accord majeur)' },
  heal: { desc: 'Soin : dyade chaude montant' },
  click: { desc: 'Clic UI : tick très court' },
  hover: { desc: 'Survol UI : blip doux' },
  error: { desc: 'Erreur : deux buzz descendants dissonants' },
  success: { desc: 'Succès : deux notes triomphantes' },
  footstep: { desc: 'Pas : thump feutré (varié par seed)' },
  door: { desc: 'Porte : couinement lent + claquement sourd' },
  splash: { desc: 'Éclaboussure : gerbe d\'eau + gouttes descendantes' },
  heartbeat: { desc: 'Battement de cœur : double pouls grave (lub-dub)' },
  alarm: { desc: 'Alarme : klaxon deux tons répété' },
  sword: { desc: 'Épée : coup d\'air + choc métallique (shing)' },
  bubble: { desc: 'Bulles : trois blips d\'eau montants' },
  magic: { desc: 'Magie : arpège scintillant montant + poussière de étoiles' },
  teleport: { desc: 'Téléportation : aspiration grave puis flash aigu' },
  bowShoot: { desc: 'Arc : corde qui claque + flèche qui siffle' },
  gunShoot: { desc: 'Coup de feu : détonation sèche + boom grave + écho' },
  thunder: { desc: 'Tonnerre : craquement initial + grondement long' },
  questComplete: { desc: 'Quête accomplie : fanfare 4 notes + cloche brillante' },
  menuOpen: { desc: 'Menu ouvert : deux notes douces montantes' },
  chestOpen: { desc: 'Coffre : grincement de charnière + claquement + trésor' },
  ghost: { desc: 'Fantôme : whoosh spectral + voix éthérée vacillante' },
  forge: { desc: 'Forge : coup de marteau + résonance métallique + braises' },
};

/* --------------------------- primitives --------------------------- */

class Mixer {
  constructor(sr, durSec) {
    const n = Math.max(16, Math.round(durSec * sr));
    this.sr = sr;
    this.n = n;
    this.L = new Float32Array(n);
    this.R = new Float32Array(n);
  }
  add(L, R, offsetSec = 0) {
    const off = Math.round(offsetSec * this.sr);
    for (let i = 0; i < L.length; i++) {
      const idx = off + i;
      if (idx < 0 || idx >= this.n) continue;
      this.L[idx] += L[i];
      this.R[idx] += R[i];
    }
  }
}

function renderTone(mix, opts) {
  const sr = mix.sr;
  const durSec = opts.dur;
  const n = Math.round(durSec * sr);
  const L = new Float32Array(n), R = new Float32Array(n);
  const [gl, gr] = panGains(opts.pan || 0);
  const f0 = opts.f0, f1 = opts.f1 ?? f0;
  const curve = opts.curve || 'exp';
  const wave = opts.wave || 'sine';
  const duty = opts.duty || 0.5;
  const vib = opts.vib || 0, vibHz = opts.vibHz || 6;
  const attack = opts.attack ?? 0.005;
  const release = opts.release ?? 0.03;
  const sustain = opts.sustain ?? 0;
  const decay = opts.decay || 0;
  const gain = (opts.gain ?? 0.5);
  const lpHz = opts.lpHz || null;
  const fmRatio = opts.fmRatio || 0, fmIndex = opts.fmIndex || 0, fmDecay = opts.fmDecay || 0;
  const lpA = lpHz ? lpCoef(lpHz, sr) : 0;
  let ph = 0, phm = 0, lpS = 0;
  const osc = (p) => {
    const pf = p - Math.floor(p);
    switch (wave) {
      case 'square': return pf < duty ? 1 : -1;
      case 'saw': return 2 * pf - 1;
      case 'tri': return 4 * Math.abs(pf - 0.5) - 1;
      default: return Math.sin(2 * Math.PI * p);
    }
  };
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const prog = durSec > 0 ? t / durSec : 0;
    let f = curve === 'lin' ? f0 + (f1 - f0) * prog : f0 * Math.pow(f1 / f0, prog);
    if (vib) f *= 1 + vib * 0.02 * Math.sin(2 * Math.PI * vibHz * t);
    ph += f / sr;
    if (fmRatio) phm += f * fmRatio / sr;
    let v = fmRatio
      ? Math.sin(2 * Math.PI * ph + fmIndex * Math.exp(fmDecay ? -t / fmDecay : 0) * Math.sin(2 * Math.PI * phm))
      : osc(ph);
    let e;
    if (t < attack) e = Math.sin((t / Math.max(attack, 1e-4)) * (Math.PI / 2));
    else e = decay ? sustain + (1 - sustain) * Math.exp(-(t - attack) / decay) : 1;
    const tail = durSec - t;
    if (tail < release) e *= 0.5 + 0.5 * Math.cos((Math.max(0, tail) / release) * Math.PI);
    if (lpA) { lpS += lpA * (v - lpS); v = lpS; }
    const s = v * e * gain;
    L[i] += s * gl; R[i] += s * gr;
  }
  mix.add(L, R, opts.offset || 0);
}

function renderNoise(mix, opts, seed) {
  const sr = mix.sr;
  const durSec = opts.dur;
  const n = Math.round(durSec * sr);
  const L = new Float32Array(n), R = new Float32Array(n);
  const [gl, gr] = panGains(opts.pan || 0);
  const rng = makeRng(seed || 1234);
  const brown = !!opts.brown;
  const hp = opts.hp || 0, lp = opts.lp || 0;
  const aHP = hp ? lpCoef(hp, sr) : 0, aLP = lp ? lpCoef(lp, sr) : 0;
  const envType = opts.env || 'exp'; // 'exp' | 'hump' | 'flat'
  const tau = opts.tau || 0.1;
  const lpEnv = opts.lpEnv || null; // {from, peak, to} sweep du cutoff
  const gain = opts.gain ?? 0.5;
  let brownS = 0, hpS = 0, lpS = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const prog = durSec > 0 ? t / durSec : 0;
    let x = rng.f(-1, 1);
    if (brown) { brownS = (brownS + x * 0.08) * 0.996; x = brownS * 3.2; }
    if (hp) { hpS += aHP * (x - hpS); x = x - hpS; }
    let cutoff = lp;
    if (lpEnv) {
      const peak = lpEnv.peak ?? lpEnv.from;
      cutoff = prog < 0.5
        ? lpEnv.from + (peak - lpEnv.from) * (prog / 0.5)
        : peak + ((lpEnv.to ?? lpEnv.from) - peak) * ((prog - 0.5) / 0.5);
    }
    if (cutoff > 20) { const a = lpCoef(cutoff, sr); lpS += a * (x - lpS); x = lpS; }
    let e;
    if (envType === 'hump') e = Math.pow(Math.sin(prog * Math.PI), 1.5);
    else if (envType === 'flat') e = 1;
    else e = Math.min(1, t / 0.001) * Math.exp(-t / tau);
    const s = x * e * gain;
    L[i] += s * gl; R[i] += s * gr;
  }
  mix.add(L, R, opts.offset || 0);
}

/* --------------------------- presets --------------------------- */

const PRESETS = {
  jump(rng) {
    const f0 = 250 * rng.f(0.95, 1.05);
    return [
      { type: 'tone', dur: 0.24, f0, f1: f0 * 3.2, wave: 'square', lpHz: 5200, gain: 0.5, release: 0.05, vib: 0.2 },
      { type: 'tone', dur: 0.24, f0: f0 / 2, f1: f0 * 1.6, wave: 'sine', gain: 0.25, release: 0.05 },
    ];
  },
  coin(rng) {
    const d = rng.f(0.98, 1.02);
    return [
      { type: 'tone', dur: 0.085, f0: 988 * d, wave: 'tri', lpHz: 8000, gain: 0.5 },
      { type: 'tone', dur: 0.55, f0: 1319 * d, wave: 'tri', lpHz: 8000, gain: 0.5, decay: 0.35, sustain: 0.15, offset: 0.08 },
      { type: 'tone', dur: 0.55, f0: 2637 * d, wave: 'sine', gain: 0.15, decay: 0.2, offset: 0.08 },
    ];
  },
  pickup(rng) {
    const f = 660 * rng.f(0.95, 1.15);
    return [
      { type: 'tone', dur: 0.3, f0: f, f1: f * 1.5, wave: 'tri', lpHz: 4000, gain: 0.5, decay: 0.12 },
      { type: 'noise', dur: 0.03, hp: 3000, gain: 0.15 },
    ];
  },
  hit(rng) {
    return [
      { type: 'noise', dur: 0.2, hp: 300, lp: 2600, gain: 0.65, tau: 0.05 },
      { type: 'tone', dur: 0.15, f0: 170, f1: 62, wave: 'sine', gain: 0.65, decay: 0.05 },
      { type: 'noise', dur: 0.05, hp: 1200, gain: 0.35 },
    ];
  },
  damage(rng) {
    const f = 300 * rng.f(0.95, 1.05);
    return [
      { type: 'noise', dur: 0.3, hp: 400, lp: 4000, gain: 0.7, tau: 0.07 },
      { type: 'tone', dur: 0.3, f0: f, f1: f * 0.4, wave: 'square', lpHz: 2400, gain: 0.4, decay: 0.1 },
      { type: 'tone', dur: 0.2, f0: 130, f1: 55, wave: 'sine', gain: 0.6, decay: 0.06 },
    ];
  },
  explosion() {
    return [
      { type: 'noise', dur: 1.5, brown: true, hp: 30, gain: 0.9, tau: 0.5 },
      { type: 'noise', dur: 1.2, hp: 80, lp: 500, gain: 0.6, tau: 0.4 },
      { type: 'noise', dur: 0.25, hp: 1500, gain: 0.5 },
      { type: 'tone', dur: 1.1, f0: 60, f1: 34, wave: 'sine', gain: 0.8, decay: 0.35 },
    ];
  },
  whoosh(rng) {
    const up = rng.chance(0.5);
    return [
      {
        type: 'noise', dur: 0.85, hp: 180, gain: 0.6, env: 'hump',
        lpEnv: up ? { from: 350, peak: 3200, to: 600 } : { from: 3000, peak: 900, to: 3800 },
      },
    ];
  },
  laser(rng) {
    const f0 = 1400 * rng.f(0.9, 1.15);
    return [
      { type: 'tone', dur: 0.38, f0, f1: f0 * 0.1, wave: 'saw', lpHz: 6000, gain: 0.45, vib: 0.3 },
      { type: 'tone', dur: 0.38, f0: f0 * 1.5, f1: f0 * 0.15, wave: 'square', lpHz: 5000, gain: 0.2 },
    ];
  },
  powerup() {
    const notes = [523, 659, 784, 1047];
    const layers = [];
    notes.forEach((f, i) => {
      layers.push({ type: 'tone', dur: 0.1, f0: f, wave: 'square', lpHz: 7000, gain: 0.4, offset: i * 0.085 });
    });
    layers.push({ type: 'tone', dur: 0.3, f0: 1047, f1: 1319, wave: 'square', lpHz: 8000, gain: 0.35, offset: 0.36 });
    return layers;
  },
  levelup() {
    const notes = [523, 659, 784];
    const layers = [];
    notes.forEach((f, i) => {
      layers.push({ type: 'tone', dur: 1.0, f0: f, wave: 'sine', fmRatio: 3.5, fmIndex: 2.4, fmDecay: 0.3, gain: 0.4, decay: 0.5, offset: i * 0.13, release: 0.2 });
    });
    layers.push({ type: 'tone', dur: 1.2, f0: 1046, wave: 'sine', fmRatio: 3.5, fmIndex: 2, fmDecay: 0.25, gain: 0.3, decay: 0.5, offset: 0.39, release: 0.2 });
    return layers;
  },
  heal(rng) {
    const d = rng.f(0.98, 1.02);
    return [
      { type: 'tone', dur: 0.9, f0: 698 * d, wave: 'sine', attack: 0.15, gain: 0.35, decay: 0.6, sustain: 0.3, release: 0.2 },
      { type: 'tone', dur: 0.9, f0: 880 * d, wave: 'sine', attack: 0.18, gain: 0.3, decay: 0.6, sustain: 0.3, offset: 0.12, release: 0.2 },
      { type: 'tone', dur: 0.9, f0: 1397 * d, wave: 'sine', attack: 0.2, gain: 0.14, decay: 0.5, offset: 0.2, release: 0.2 },
    ];
  },
  click() {
    return [
      { type: 'noise', dur: 0.02, hp: 3200, gain: 0.5 },
      { type: 'tone', dur: 0.025, f0: 2100, wave: 'sine', gain: 0.4, release: 0.01 },
    ];
  },
  hover() {
    return [
      { type: 'tone', dur: 0.07, f0: 1250, wave: 'sine', attack: 0.012, gain: 0.3, release: 0.02 },
    ];
  },
  error() {
    return [
      { type: 'tone', dur: 0.12, f0: 233, wave: 'square', lpHz: 2800, gain: 0.4 },
      { type: 'tone', dur: 0.16, f0: 208, wave: 'square', lpHz: 2800, gain: 0.4, offset: 0.14, release: 0.05 },
    ];
  },
  success() {
    return [
      { type: 'tone', dur: 0.14, f0: 1047, wave: 'tri', lpHz: 7000, gain: 0.45 },
      { type: 'tone', dur: 0.5, f0: 1568, wave: 'tri', lpHz: 7000, gain: 0.45, decay: 0.3, offset: 0.12 },
      { type: 'tone', dur: 0.5, f0: 3136, wave: 'sine', gain: 0.15, decay: 0.2, offset: 0.12 },
    ];
  },
  footstep(rng) {
    const f = 95 * rng.f(0.85, 1.2);
    return [
      { type: 'noise', dur: 0.1, hp: 60, lp: 550, gain: 0.45, tau: 0.03 },
      { type: 'tone', dur: 0.07, f0: f, f1: f * 0.7, wave: 'sine', gain: 0.4, decay: 0.03 },
    ];
  },
  door(rng) {
    const up = rng.chance(0.5);
    const c0 = up ? 160 : 230, c1 = up ? 240 : 170;
    return [
      // couinement (charnière) : oscillateur battant + bruit filtré balayé
      { type: 'tone', dur: 0.4, f0: c0, f1: c1, wave: 'saw', lpHz: 1400, vib: 7, vibHz: 7.5, attack: 0.09, gain: 0.22, release: 0.1 },
      { type: 'noise', dur: 0.4, hp: 500, lp: 2200, env: 'hump', gain: 0.16, lpEnv: { from: 1100, peak: 2600, to: 800 } },
      // claquement
      { type: 'tone', dur: 0.28, f0: 115, f1: 48, wave: 'sine', gain: 0.75, decay: 0.07, offset: 0.42 },
      { type: 'noise', dur: 0.2, brown: true, hp: 40, gain: 0.45, tau: 0.05, offset: 0.42 },
      { type: 'noise', dur: 0.06, hp: 1400, gain: 0.3, offset: 0.42 },
    ];
  },
  splash() {
    return [
      { type: 'noise', dur: 0.55, hp: 700, gain: 0.65, env: 'hump', lpEnv: { from: 6500, peak: 7500, to: 700 } },
      { type: 'noise', dur: 0.8, brown: true, hp: 100, lp: 750, gain: 0.35, tau: 0.28 },
      { type: 'noise', dur: 0.04, hp: 3500, gain: 0.22, offset: 0.2 },
      { type: 'noise', dur: 0.035, hp: 3000, gain: 0.18, offset: 0.32 },
      { type: 'noise', dur: 0.03, hp: 2600, gain: 0.14, offset: 0.43 },
    ];
  },
  heartbeat() {
    return [
      { type: 'tone', dur: 0.16, f0: 66, f1: 40, wave: 'sine', gain: 0.85, decay: 0.055 },
      { type: 'noise', dur: 0.1, brown: true, hp: 30, lp: 220, gain: 0.3, tau: 0.04 },
      { type: 'tone', dur: 0.14, f0: 58, f1: 38, wave: 'sine', gain: 0.6, decay: 0.05, offset: 0.26 },
      { type: 'noise', dur: 0.08, brown: true, hp: 30, lp: 200, gain: 0.22, tau: 0.035, offset: 0.26 },
    ];
  },
  alarm() {
    const a = 640, b = 475;
    const layers = [];
    for (let i = 0; i < 2; i++) {
      const t = i * 0.62;
      layers.push({ type: 'tone', dur: 0.3, f0: a, wave: 'square', lpHz: 3000, gain: 0.3, attack: 0.012, release: 0.04, offset: t });
      layers.push({ type: 'tone', dur: 0.3, f0: a / 2, wave: 'sine', gain: 0.22, attack: 0.012, release: 0.04, offset: t });
      layers.push({ type: 'tone', dur: 0.3, f0: b, wave: 'square', lpHz: 3000, gain: 0.3, attack: 0.012, release: 0.04, offset: t + 0.31 });
      layers.push({ type: 'tone', dur: 0.3, f0: b / 2, wave: 'sine', gain: 0.22, attack: 0.012, release: 0.04, offset: t + 0.31 });
    }
    return layers;
  },
  sword() {
    const clang = 2600 * 1.12;
    return [
      // coup d'air
      { type: 'noise', dur: 0.2, hp: 400, gain: 0.5, env: 'hump', lpEnv: { from: 2400, peak: 6800, to: 900 } },
      // choc métallique (FM inharmonique)
      { type: 'tone', dur: 0.5, f0: clang, f1: clang * 0.7, wave: 'sine', fmRatio: 7.3, fmIndex: 3.2, fmDecay: 0.09, gain: 0.32, decay: 0.16, offset: 0.2 },
      { type: 'tone', dur: 0.5, f0: clang * 1.51, wave: 'sine', gain: 0.14, decay: 0.22, offset: 0.2 },
      { type: 'noise', dur: 0.1, hp: 2600, gain: 0.45, offset: 0.2 },
      // résonance
      { type: 'tone', dur: 0.7, f0: clang * 2.02, wave: 'sine', gain: 0.12, decay: 0.3, offset: 0.22 },
    ];
  },
  bubble(rng) {
    const d = rng.f(0.95, 1.08);
    return [
      { type: 'tone', dur: 0.11, f0: 310 * d, f1: 720 * d, wave: 'sine', vib: 1.5, gain: 0.4, release: 0.02 },
      { type: 'noise', dur: 0.025, hp: 2200, gain: 0.14, offset: 0.02 },
      { type: 'tone', dur: 0.1, f0: 430 * d, f1: 980 * d, wave: 'sine', vib: 1.5, gain: 0.32, release: 0.02, offset: 0.11 },
      { type: 'tone', dur: 0.09, f0: 560 * d, f1: 1250 * d, wave: 'sine', vib: 1.5, gain: 0.26, release: 0.02, offset: 0.21 },
    ];
  },
  magic(rng) {
    const d = rng.f(0.97, 1.04);
    // arpège pentatonique montant : [0, 4, 7, 12, 16, 19] demi-tons au-dessus de C5
    const base = 523 * d;
    const st = [0, 4, 7, 12, 16, 19];
    const layers = [];
    st.forEach((s, i) => {
      const f = base * Math.pow(2, s / 12);
      layers.push({ type: 'tone', dur: 0.16, f0: f, wave: 'tri', lpHz: 8000, gain: 0.34, decay: 0.09, offset: i * 0.055, pan: ((i % 3) - 1) * 0.35 });
    });
    // poussière d'étoiles : souffle très aigu qui scintille
    layers.push({ type: 'noise', dur: 0.5, hp: 4000, lp: 11000, gain: 0.14, env: 'hump', offset: 0.08 });
    // note finale tenue
    const fTop = base * Math.pow(2, 19 / 12);
    layers.push({ type: 'tone', dur: 0.55, f0: fTop, f1: fTop * 1.02, wave: 'sine', fmRatio: 3.01, fmIndex: 1.6, fmDecay: 0.35, gain: 0.26, decay: 0.3, offset: 0.36, release: 0.15 });
    return layers;
  },
  teleport(rng) {
    const d = rng.f(0.96, 1.05);
    return [
      // aspiration : souffle qui s'ouvre puis se referme
      { type: 'noise', dur: 0.38, gain: 0.5, env: 'hump', lpEnv: { from: 400, peak: 6000, to: 300 } },
      // tonalité qui plonge (le corps aspiré)
      { type: 'tone', dur: 0.34, f0: 520 * d, f1: 110 * d, wave: 'sine', gain: 0.4, vib: 2, release: 0.05 },
      { type: 'tone', dur: 0.34, f0: 523 * d, f1: 110 * d, wave: 'saw', lpHz: 1600, gain: 0.18, release: 0.05 },
      // flash : sweep aigu montant
      { type: 'tone', dur: 0.18, f0: 700, f1: 2600, wave: 'tri', lpHz: 9000, gain: 0.4, offset: 0.33, release: 0.03 },
      // ping de réapparition
      { type: 'noise', dur: 0.06, hp: 2500, gain: 0.3, offset: 0.4 },
      { type: 'tone', dur: 0.2, f0: 1980, wave: 'sine', gain: 0.25, decay: 0.09, offset: 0.4 },
    ];
  },
  bowShoot() {
    return [
      // corde tendue : frottement feutré
      { type: 'noise', dur: 0.22, hp: 800, lp: 3400, gain: 0.2, env: 'hump' },
      // claquement du départ
      { type: 'noise', dur: 0.045, hp: 1400, gain: 0.75, env: 'exp', tau: 0.06 },
      { type: 'tone', dur: 0.09, f0: 320, f1: 190, wave: 'sine', gain: 0.3, decay: 0.03 },
      // flèche qui siffle (décalée à droite)
      { type: 'noise', dur: 0.5, gain: 0.4, env: 'hump', lpEnv: { from: 2400, peak: 5400, to: 600 }, pan: 0.2, offset: 0.05 },
      { type: 'tone', dur: 0.42, f0: 1900, f1: 1150, wave: 'sine', gain: 0.07, attack: 0.06, release: 0.12, pan: 0.2, offset: 0.08 },
    ];
  },
  gunShoot() {
    return [
      // détonation : crack très court
      { type: 'noise', dur: 0.05, hp: 2000, gain: 0.9, env: 'exp', tau: 0.02 },
      // boom : bas du coup de feu
      { type: 'noise', dur: 0.45, brown: true, lp: 900, gain: 0.75, tau: 0.12 },
      { type: 'tone', dur: 0.32, f0: 90, f1: 40, wave: 'sine', gain: 0.6, decay: 0.08 },
      // écho de réverbération
      { type: 'noise', dur: 0.55, hp: 450, lp: 3200, gain: 0.28, env: 'hump', offset: 0.12 },
      { type: 'noise', dur: 0.3, hp: 600, lp: 2200, gain: 0.12, env: 'hump', offset: 0.3 },
    ];
  },
  thunder() {
    return [
      // craquement initial
      { type: 'noise', dur: 0.12, hp: 1200, gain: 0.55, env: 'exp', tau: 0.04 },
      // grondement long qui descend vers le grave
      { type: 'noise', dur: 2.4, brown: true, gain: 0.8, env: 'hump', lpEnv: { from: 800, peak: 1400, to: 55 }, offset: 0.06 },
      // sub : la masse d'air qui roule
      { type: 'tone', dur: 2.0, f0: 60, f1: 38, wave: 'sine', gain: 0.5, decay: 0.8, offset: 0.12 },
    ];
  },
  questComplete(rng) {
    const d = rng.f(0.99, 1.01);
    // fanfare : [0, 4, 7, 12] demi-tons au-dessus de C5
    const base = 523 * d;
    const steps = [0, 4, 7, 12];
    const layers = [];
    steps.forEach((s, i) => {
      const f = base * Math.pow(2, s / 12);
      const last = i === steps.length - 1;
      layers.push({ type: 'tone', dur: last ? 0.9 : 0.26, f0: f, wave: 'tri', lpHz: 7500, gain: 0.4, decay: last ? 0.4 : 0.1, offset: i * 0.16, release: 0.08 });
      layers.push({ type: 'tone', dur: last ? 0.9 : 0.26, f0: f * 2, wave: 'sine', gain: 0.12, decay: last ? 0.35 : 0.08, offset: i * 0.16, release: 0.08 });
    });
    // cloche brillante de conclusion (2 octaves au-dessus)
    layers.push({ type: 'tone', dur: 1.1, f0: base * 4, wave: 'sine', fmRatio: 3.5, fmIndex: 1.8, fmDecay: 0.25, gain: 0.28, decay: 0.5, offset: 0.72, release: 0.2 });
    return layers;
  },
  menuOpen() {
    return [
      { type: 'tone', dur: 0.09, f0: 620, wave: 'sine', attack: 0.008, gain: 0.35, release: 0.02 },
      { type: 'tone', dur: 0.14, f0: 930, wave: 'sine', attack: 0.008, gain: 0.4, offset: 0.075, release: 0.05 },
      { type: 'tone', dur: 0.14, f0: 1860, wave: 'sine', gain: 0.12, offset: 0.075, release: 0.05 },
      // shwoosh d'interface
      { type: 'noise', dur: 0.18, hp: 2000, lp: 8000, gain: 0.1, env: 'hump', offset: 0.02 },
    ];
  },
  chestOpen() {
    return [
      // grincement de charnière (saw battant)
      { type: 'tone', dur: 0.45, f0: 180, f1: 150, wave: 'saw', lpHz: 900, vib: 0.8, vibHz: 11, attack: 0.04, gain: 0.25, release: 0.06 },
      { type: 'noise', dur: 0.4, hp: 600, lp: 2400, gain: 0.12, env: 'hump', lpEnv: { from: 900, peak: 2100, to: 800 } },
      // claquement du couvercle
      { type: 'tone', dur: 0.25, f0: 110, f1: 45, wave: 'sine', gain: 0.7, decay: 0.06, offset: 0.46 },
      { type: 'noise', dur: 0.08, hp: 1000, gain: 0.3, offset: 0.46 },
      // trésor : tintements
      { type: 'tone', dur: 0.3, f0: 1568, wave: 'sine', gain: 0.3, decay: 0.16, offset: 0.56 },
      { type: 'tone', dur: 0.35, f0: 2093, wave: 'sine', gain: 0.24, decay: 0.2, offset: 0.64 },
      { type: 'noise', dur: 0.03, hp: 3200, gain: 0.12, offset: 0.58 },
    ];
  },
  ghost() {
    return [
      // whoosh spectral
      { type: 'noise', dur: 0.9, hp: 300, lp: 1800, gain: 0.4, env: 'hump' },
      // voix éthérée : tons descendants très vibrato
      { type: 'tone', dur: 0.8, f0: 660, f1: 430, wave: 'sine', vib: 1.2, vibHz: 5.5, attack: 0.16, gain: 0.3, release: 0.2, offset: 0.12 },
      { type: 'tone', dur: 0.8, f0: 990, f1: 645, wave: 'sine', vib: 1.4, vibHz: 4.6, attack: 0.2, gain: 0.2, release: 0.2, offset: 0.24, pan: -0.25 },
      { type: 'tone', dur: 0.7, f0: 1320, f1: 860, wave: 'sine', vib: 1.3, vibHz: 6, attack: 0.22, gain: 0.09, release: 0.2, offset: 0.3, pan: 0.25 },
    ];
  },
  forge() {
    return [
      // clac du marteau sur l'enclume
      { type: 'noise', dur: 0.03, hp: 2400, gain: 0.6, env: 'exp', tau: 0.015 },
      // clang métallique (FM inharmonique)
      { type: 'tone', dur: 0.5, f0: 2200, wave: 'sine', fmRatio: 6.7, fmIndex: 2.6, fmDecay: 0.09, gain: 0.32, decay: 0.14, offset: 0.01 },
      // résonance partielle (×1.52)
      { type: 'tone', dur: 0.65, f0: 2200 * 1.52, wave: 'sine', gain: 0.18, decay: 0.3, offset: 0.01 },
      { type: 'tone', dur: 0.55, f0: 2200 * 2.02, wave: 'sine', gain: 0.1, decay: 0.25, offset: 0.02 },
      // braises qui s'échappent
      { type: 'noise', dur: 0.02, hp: 2800, gain: 0.16, offset: 0.22 },
      { type: 'noise', dur: 0.018, hp: 3400, gain: 0.12, offset: 0.31 },
      { type: 'noise', dur: 0.015, hp: 3000, gain: 0.09, offset: 0.52 },
    ];
  },
};

const SFX_IDS = Object.keys(SFX_KINDS);

/**
 * Crée un SFX. Retourne { path, kind, seed, bytes, durationSeconds, desc }.
 */
function createSfx(kind, opts = {}) {
  const preset = PRESETS[kind];
  if (!preset) throw new Error(`SFX inconnu: ${kind}. Disponibles: ${SFX_IDS.join(', ')}`);
  const seed = opts.seed == null ? randomSeed() : opts.seed >>> 0;
  const rng = makeRng(seed);
  const sr = opts.sr || 44100;
  const vol = clamp(opts.volume ?? 1, 0.05, 1);

  const layers = preset(rng);
  const dur = Math.max(...layers.map((l) => (l.offset || 0) + l.dur)) + 0.15;
  const mix = new Mixer(sr, dur);
  const pitch = 2 ** ((opts.pitchSemitones ?? 0) / 12);
  const frequency = (value) => Math.min(value * pitch, 0.48 * sr);
  layers.forEach((layer, idx) => {
    if (pitch !== 1) {
      for (const name of ['f0', 'f1', 'lp', 'hp', 'lpHz']) {
        if (layer[name]) layer[name] = frequency(layer[name]);
      }
      if (layer.lpEnv) {
        const { from, peak, to } = layer.lpEnv;
        layer.lpEnv = { from: frequency(from), peak: frequency(peak), to: frequency(to) };
      }
    }
    if (layer.type === 'noise') renderNoise(mix, layer, hash32(seed, idx));
    else renderTone(mix, layer);
  });

  // master : soft clip + normalisation au volume demandé
  const attack = Math.round((opts.attackMs ?? 0) * sr / 1000);
  for (let i = 0; i < Math.min(attack, mix.n); i++) {
    const gain = Math.sin(Math.PI * i / (2 * attack));
    mix.L[i] *= gain;
    mix.R[i] *= gain;
  }
  let peak = 0;
  for (let i = 0; i < mix.n; i++) {
    mix.L[i] = clamp(mix.L[i], -1.4, 1.4);
    mix.R[i] = clamp(mix.R[i], -1.4, 1.4);
    peak = Math.max(peak, Math.abs(mix.L[i]), Math.abs(mix.R[i]));
  }
  if (peak > 1e-6) {
    const g = (0.92 * vol) / peak;
    for (let i = 0; i < mix.n; i++) { mix.L[i] *= g; mix.R[i] *= g; }
  }

  if (opts.mono) {
    for (let i = 0; i < mix.n; i++) {
      const m = (mix.L[i] + mix.R[i]) / 2;
      mix.L[i] = m;
      mix.R[i] = m;
    }
  }

  const outDir = opts.outputDir || path.join(__dirname, '..', 'output');
  const file = path.join(outDir, opts.index === undefined ? `sfx-${kind}-${seed}.wav`
    : `${String(opts.index).padStart(2, '0')}-${kind}.wav`);
  const res = writeWav(file, mix.L, mix.R, sr, !!opts.mono);
  return {
    path: file,
    kind,
    seed,
    bytes: res.bytes,
    durationSeconds: Math.round((mix.n / sr) * 100) / 100,
    desc: SFX_KINDS[kind].desc,
  };
}

module.exports = { createSfx, SFX_IDS, SFX_KINDS, Mixer, renderTone, renderNoise };
