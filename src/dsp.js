'use strict';

const { ui } = require('./language');

/**
 * Moteur DSP : synthèse des instruments, effets (réverbération type freeverb,
 * délai ping-pong), chaîne master et export WAV 16 bits stéréo.
 * Zéro dépendance : tout est généré mathématiquement.
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { makeRng, hash32 } = require('./rng');
const instrumentalVoices = require('./instrument-voices');
const { planSampleLegato, renderSamples } = require('./sample-bank');
const { musicClock } = require('./music-clock');
const { COLORS, textureVoices } = require('./texture-voices');
const { renderCustom } = require('./custom-synth');
const { isCustom, supportsGesture } = require('./custom-patch');
const { renderModal } = require('./modal-synth');
const { renderWaveguide } = require('./waveguide-synth');
const { performEvents } = require('./performance');
const { applyRoom } = require('./virtual-room');
const { applyBuilds } = require('./build-shaping');

const SR = 44100;

/* ---------------------------------- utilitaires ---------------------------------- */

const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
const lpCoef = (hz, sr) => 1 - Math.exp((-2 * Math.PI * hz) / sr);

/** enveloppe : attaque sinus, soutien, relâchement cosinus (zéro clic). */
function envCurve(t, durSec, attack, release) {
  if (t < durSec) return t < attack ? Math.sin((t / attack) * (Math.PI / 2)) : 1;
  if (t < durSec + release) {
    const tr = (t - durSec) / release;
    const level = durSec < attack ? Math.sin((durSec / attack) * (Math.PI / 2)) : 1;
    return level * (0.5 + 0.5 * Math.cos(tr * Math.PI));
  }
  return 0;
}

/** écrêtage doux : transparent jusqu'à 0.8, asymptote à ±1. */
function softClip(x) {
  if (x > 0.8) x = 0.8 + 0.2 * (1 - Math.exp(-(x - 0.8) / 0.2));
  else if (x < -0.8) x = -0.8 - 0.2 * (1 - Math.exp((x + 0.8) / 0.2));
  return x;
}

const triWave = (p) => 4 * Math.abs(p - Math.floor(p) - 0.5) - 1;

/**
 * PolyBLEP : lisse la discontinuité d'une dent de scie / impulsion.
 * Sans ça, les oscillateurs naïfs replient les harmoniques (aliasing)
 * et sonnent « verre cassé » dans les aigus. dt = fréquence / sr.
 */
function polyBlep(t, dt) {
  if (dt <= 0) return 0;
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

/** Dent de scie bande-limitée (PolyBLEP). */
function blepSaw(p, dt) {
  const t = p - Math.floor(p);
  return 2 * t - 1 - polyBlep(t, dt);
}

/** Impulsion bande-limitée (PolyBLEP), duty 0..1. */
function blepPulse(p, dt, duty = 0.5) {
  const t = p - Math.floor(p);
  let v = t < duty ? 1 : -1;
  v += polyBlep(t, dt);
  let t2 = t - duty;
  if (t2 < 0) t2 += 1;
  v -= polyBlep(t2, dt);
  return v;
}

function panGains(pan) {
  const a = (pan + 1) * (Math.PI / 4);
  return [Math.cos(a), Math.sin(a)]; // [L, R]
}

/* ---------------------------------- réverbération ---------------------------------- */

class Comb {
  constructor(lenSamples, feedback, damp) {
    this.buf = new Float32Array(Math.max(2, Math.round(lenSamples)));
    this.idx = 0;
    this.fb = feedback;
    this.damp1 = damp;       // conserve l'aigu retenu
    this.damp2 = 1 - damp;   // passe l'aigu nouveau
    this.store = 0;
  }
  process(x) {
    const out = this.buf[this.idx];
    this.store = out * this.damp2 + this.store * this.damp1;
    let w = x + this.store * this.fb;
    if (w > -1e-15 && w < 1e-15) w = 0; // anti-dénomormes
    this.buf[this.idx] = w;
    if (++this.idx === this.buf.length) this.idx = 0;
    return out;
  }
}

class Allpass {
  constructor(lenSamples, feedback) {
    this.buf = new Float32Array(Math.max(2, Math.round(lenSamples)));
    this.idx = 0;
    this.fb = feedback;
  }
  process(x) {
    const bufout = this.buf[this.idx];
    const out = -x + bufout;
    this.buf[this.idx] = x + bufout * this.fb;
    if (++this.idx === this.buf.length) this.idx = 0;
    return out;
  }
}

/**
 * Réverbération Schroeder/freeverb-like, instance par canal.
 * Améliorations : pré-délai (clarté), 6 combs par canal avec des longueurs
 * légèrement différentes à gauche/droite (vraie largeur stéréo), 3 allpass.
 */
const COMB_TUNINGS = [1116, 1188, 1277, 1356, 1422, 1491];
const ALLPASS_TUNINGS = [556, 441, 341];

class Reverb {
  constructor(sr, room = 0.6, damp = 0.35, channel = 0) {
    const scale = sr / 44100;
    const fb = 0.7 + Math.min(0.95, Math.max(0.1, room)) * 0.28;
    const off = channel ? 23 : 0;
    this.combs = COMB_TUNINGS.map((n, i) => new Comb((n + off + (i % 2) * 7) * scale, fb, damp));
    this.allpasses = ALLPASS_TUNINGS.map((n) => new Allpass((n + off) * scale, 0.5));
    this.predelay = new Float32Array(Math.max(2, Math.round((0.021 + channel * 0.004) * sr)));
    this.pdIdx = 0;
    this.wetScale = 4 / 6; // conserve le niveau de l'ancienne réverb à 4 combs
  }
  process(x) {
    const pd = this.predelay[this.pdIdx];
    this.predelay[this.pdIdx] = x;
    if (++this.pdIdx === this.predelay.length) this.pdIdx = 0;
    let out = 0;
    for (let i = 0; i < this.combs.length; i++) out += this.combs[i].process(pd);
    for (let i = 0; i < this.allpasses.length; i++) out = this.allpasses[i].process(out);
    return out * this.wetScale;
  }
}

/** Délai ping-pong stéréo avec atténuation dans le retour. */
function applyPingPong(L, R, n, delaySec, fb, wet, sr, dampHz = 5500) {
  const d = Math.max(1, Math.round(delaySec * sr));
  const size = d + 1;
  const bufL = new Float32Array(size);
  const bufR = new Float32Array(size);
  const a = lpCoef(dampHz, sr);
  let w = 0, lpL = 0, lpR = 0;
  for (let i = 0; i < n; i++) {
    const r = w + 1 === size ? 0 : w + 1;
    const oL = bufL[r], oR = bufR[r];
    let fL = oR * fb, fR = oL * fb; // croisement = ping-pong
    lpL += a * (fL - lpL); fL = Math.abs(lpL) < 1e-14 ? 0 : lpL;
    lpR += a * (fR - lpR); fR = Math.abs(lpR) < 1e-14 ? 0 : lpR;
    bufL[w] = L[i] + fL;
    bufR[w] = R[i] + fR;
    L[i] += oL * wet;
    R[i] += oR * wet;
    w = r;
  }
}

/* ---------------------------------- instruments ---------------------------------- */

/*
 * Convention : chaque synthé reçoit (L, R, start, len, ev, sr, durSec, gain)
 * ev : { freq (Hz), vel (0..1), pan (-1..1), vib (0..1), seedIdx }
 * Les voix écrivent DANS le buffer (addition), jamais écrasement.
 */

function twoVoicePad(L, R, start, len, ev, sr, durSec, gain, o) {
  const [gcl, gcr] = panGains(ev.pan);
  const release = o.release;
  const lfoHz = o.lfoHz, lfoDepth = o.lfoDepth;
  const lpBase = o.lpHz;
  const lpMod = o.lpMod ?? 0.22;      // respiration du filtre
  const width = o.width ?? 0.77;      // largeur stéréo (mid/side)
  const f0 = ev.freq;
  const vel = ev.vel;
  const detC = o.detune;
  const fDet0 = f0 * Math.pow(2, -detC / 1200), fDet1 = f0 * Math.pow(2, detC / 1200);
  const dt0 = fDet0 / sr, dt1 = fDet1 / sr;
  const oscMix = o.mix; // { sine, tri, saw, duty? }
  let lpL0 = 0, lpR1 = 0;
  let ph0 = 0, ph1 = 0;
  let lpA = lpCoef(lpBase, sr);
  for (let i = 0; i < len; i++) {
    const idx = start + i;
    if (idx >= L.length) break;
    const t = i / sr;
    const e = envCurve(t, durSec, o.attack, release);
    if (e === 0 && t > durSec + release) break;
    if ((i & 31) === 0) {
      // le filtre s'ouvre et se referme lentement : la nappe « respire »
      const cut = lpBase * (1 + lpMod * Math.sin(2 * Math.PI * lfoHz * 0.5 * t + 0.7));
      lpA = lpCoef(cut, sr);
    }
    const lfo = 1 + lfoDepth * Math.sin(2 * Math.PI * lfoHz * t + 1.3);
    ph0 += dt0; ph1 += dt1;
    const s0 = oscMix.sine * Math.sin(2 * Math.PI * ph0)
      + oscMix.tri * triWave(ph0)
      + oscMix.saw * blepSaw(ph0, dt0);
    const s1 = oscMix.sine * Math.sin(2 * Math.PI * ph1)
      + oscMix.tri * triWave(ph1)
      + oscMix.saw * blepSaw(ph1, dt1);
    lpL0 += lpA * (s0 - lpL0);
    lpR1 += lpA * (s1 - lpR1);
    // mid/side : élargit sans perdre le centre
    const mid = 0.5 * (lpL0 + lpR1);
    const side = 0.5 * (lpL0 - lpR1) * width;
    const outL = mid + side;
    const outR = mid - side;
    const g = e * lfo * gain * vel;
    L[idx] += outL * g * gcl;
    R[idx] += outR * g * gcr;
  }
}

const INSTRUMENTS = {
  ...textureVoices,
  ...instrumentalVoices,
  padwarm: { release: 1.5, gain: 0.5, fn: (L, R, s, l, ev, sr, d, g) =>
    twoVoicePad(L, R, s, l, ev, sr, d, g, { mix: { sine: 0.62, tri: 0.38, saw: 0 }, detune: 7, attack: 0.9, release: 1.5, lpHz: 2200, lfoHz: 0.13, lfoDepth: 0.07 }) },

  padbright: { release: 2.4, gain: 0.5, fn: (L, R, s, l, ev, sr, d, g) =>
    twoVoicePad(L, R, s, l, ev, sr, d, g, { mix: { sine: 0.55, tri: 0.45, saw: 0 }, detune: 9, attack: 1.4, release: 2.4, lpHz: 3400, lfoHz: 0.09, lfoDepth: 0.1 }) },

  paddark: { release: 2.0, gain: 0.5, fn: (L, R, s, l, ev, sr, d, g) =>
    twoVoicePad(L, R, s, l, ev, sr, d, g, { mix: { sine: 0.72, tri: 0, saw: 0.26 }, detune: 6, attack: 1.1, release: 2.0, lpHz: 1000, lfoHz: 0.08, lfoDepth: 0.06 }) },

  padchip: { release: 0.2, gain: 0.4, fn: (L, R, s, l, ev, sr, d, g) =>
    twoVoicePad(L, R, s, l, ev, sr, d, g, { mix: { sine: 0.3, tri: 0.3, saw: 0.4 }, detune: 4, attack: 0.15, release: 0.2, lpHz: 2600, lfoHz: 0.5, lfoDepth: 0.03 }) },

  strings: { release: 0.9, gain: 0.4, fn: (L, R, s, len, ev, sr, durSec, gain) => {
    const [gcl, gcr] = panGains(ev.pan);
    const f0 = ev.freq, vel = ev.vel;
    const det = 11, vibDepth = 0.005, vibHz = 4.7;
    const lpMin = 900 + 900 * vel, lpMax = 2600 + 1400 * vel;
    let ph0 = 0, ph1 = 0, lpL = 0, lpR = 0;
    for (let i = 0; i < len; i++) {
      const idx = s + i;
      if (idx >= L.length) break;
      const t = i / sr;
      const e = envCurve(t, durSec, 0.55, 0.9);
      if (e === 0 && t > durSec + 0.9) break;
      const vib = 1 + vibDepth * Math.sin(2 * Math.PI * vibHz * t) * Math.min(1, t / 0.35) * (ev.vib || 0.5);
      const cut = lpMin + (lpMax - lpMin) * Math.min(1, t / 0.6);
      const lpA = lpCoef(cut, sr);
      const fA = f0 * Math.pow(2, -det / 1200) * vib;
      const fB = f0 * Math.pow(2, det / 1200) * vib;
      ph0 += fA / sr; ph1 += fB / sr;
      let s0 = 0.7 * blepSaw(ph0, fA / sr) + 0.3 * Math.sin(2 * Math.PI * ph0);
      let s1 = 0.7 * blepSaw(ph1, fB / sr) + 0.3 * Math.sin(2 * Math.PI * ph1);
      lpL += lpA * (s0 - lpL); s0 = lpL;
      lpR += lpA * (s1 - lpR); s1 = lpR;
      const g = e * gain * vel;
      L[idx] += s0 * g * gcl;
      R[idx] += s1 * g * gcr;
    }
  } },

  ep: { release: 0.25, gain: 0.5, fn: (L, R, s, len, ev, sr, durSec, gain) => {
    const [gl, gr] = panGains(ev.pan);
    const f = ev.freq, vel = ev.vel;
    let pc = 0, pm = 0, p2 = 0;
    for (let i = 0; i < len; i++) {
      const idx = s + i;
      if (idx >= L.length) break;
      const t = i / sr;
      const a = Math.min(1, t / 0.006);
      const sus = 0.38 + 0.62 * Math.exp(-t / 0.7);
      let e = a * sus;
      if (t > durSec) e *= 0.5 + 0.5 * Math.cos(Math.min(1, (t - durSec) / 0.25) * Math.PI);
      if (t > durSec && e <= 0) break;
      const I = 0.12 + 1.9 * Math.exp(-t / 0.12);
      pc += f / sr; pm += f / sr; p2 += 2 * f / sr;
      const body = Math.sin(2 * Math.PI * pc + I * Math.sin(2 * Math.PI * pm));
      const tine = 0.2 * Math.exp(-t / 0.35) * Math.sin(2 * Math.PI * p2);
      const v = (body + tine) * e * gain * vel;
      L[idx] += v * gl; R[idx] += v * gr;
    }
  } },

  ks: { release: 0.1, gain: 0.5, fn: (L, R, s, len, ev, sr, durSec, gain) => {
    const [gl, gr] = panGains(ev.pan);
    const f = ev.freq, vel = ev.vel;
    const N = Math.max(2, Math.round(sr / f));
    const line = new Float32Array(N);
    const rng = makeRng(hash32(ev.midi || 60, ev.seedIdx || 0));
    let prev = 0;
    for (let i = 0; i < N; i++) {
      let n = rng.f(-1, 1);
      n = 0.5 * (n + prev); prev = n; // bruit légèrement filtré = corde chaude
      line[i] = n;
    }
    const damp = ev.damp || 0.996;
    let w = 0;
    const fadeSamples = Math.round(0.06 * sr);
    for (let i = 0; i < len; i++) {
      const idx = s + i;
      if (idx >= L.length) break;
      const out = line[w];
      const nxt = line[(w + 1) % N];
      line[w] = 0.5 * (out + nxt) * damp;
      w = (w + 1) % N;
      let e = 1;
      if (i < fadeSamples) e = Math.sin((i / fadeSamples) * (Math.PI / 2));
      const tailFade = Math.min(1, (len - i) / fadeSamples);
      e *= 0.5 + 0.5 * tailFade;
      const v = out * e * gain * vel * 0.9;
      L[idx] += v * gl; R[idx] += v * gr;
    }
  } },

  bell: { release: 1.6, gain: 0.42, fn: (L, R, s, len, ev, sr, durSec, gain) => {
    const [gl, gr] = panGains(ev.pan);
    const f = ev.freq, vel = ev.vel;
    let pc = 0, pm = 0;
    const modRatio = 3.53;
    for (let i = 0; i < len; i++) {
      const idx = s + i;
      if (idx >= L.length) break;
      const t = i / sr;
      let e = Math.min(1, t / 0.003) * Math.exp(-t / 0.95);
      if (t > durSec) e *= 0.5 + 0.5 * Math.cos(Math.min(1, (t - durSec) / 0.3) * Math.PI);
      if (t > durSec && e <= 0) break;
      const I = 2.6 * Math.exp(-t / 0.24);
      pc += f / sr; pm += f * modRatio / sr;
      const v = Math.sin(2 * Math.PI * pc + I * Math.sin(2 * Math.PI * pm)) * e * gain * vel;
      L[idx] += v * gl; R[idx] += v * gr;
    }
  } },

  tri: { release: 0.14, gain: 0.48, fn: (L, R, s, len, ev, sr, durSec, gain) => {
    const [gl, gr] = panGains(ev.pan);
    const f0 = ev.freq, vel = ev.vel;
    const lpA = lpCoef(4500, sr);
    let ph = 0, lp = 0;
    for (let i = 0; i < len; i++) {
      const idx = s + i;
      if (idx >= L.length) break;
      const t = i / sr;
      const e = envCurve(t, durSec, 0.012, 0.14);
      if (e === 0 && t > durSec + 0.14) break;
      const vib = 1 + 0.004 * Math.sin(2 * Math.PI * 5.2 * t) * Math.min(1, t / 0.3) * (ev.vib || 0);
      ph += (f0 * vib) / sr;
      let v = triWave(ph);
      lp += lpA * (v - lp); v = lp;
      L[idx] += v * e * gain * vel * gl;
      R[idx] += v * e * gain * vel * gr;
    }
  } },

  square: { release: 0.06, gain: 0.4, fn: (L, R, s, len, ev, sr, durSec, gain) => {
    const [gl, gr] = panGains(ev.pan);
    const f0 = ev.freq, vel = ev.vel;
    const duty = ev.duty ?? 0.25;
    const lpA = lpCoef(5200 + 3200 * vel, sr);
    let ph = 0, lp = 0;
    for (let i = 0; i < len; i++) {
      const idx = s + i;
      if (idx >= L.length) break;
      const t = i / sr;
      let e = Math.min(1, t / 0.004);
      e *= t < durSec ? 0.92 + 0.08 * Math.exp(-t / 0.05) : 0.5 + 0.5 * Math.cos(Math.min(1, (t - durSec) / 0.06) * Math.PI);
      if (t > durSec && e <= 0) break;
      ph += f0 / sr;
      let v = blepPulse(ph, f0 / sr, duty);
      lp += lpA * (v - lp); v = lp;
      L[idx] += v * e * gain * vel * gl;
      R[idx] += v * e * gain * vel * gr;
    }
  } },

  saw: { release: 0.28, gain: 0.4, fn: (L, R, s, len, ev, sr, durSec, gain) => {
    const [gl, gr] = panGains(ev.pan);
    const f0 = ev.freq, vel = ev.vel;
    let ph0 = 0, ph1 = 0, lpL = 0, lpR = 0, subPh = 0;
    for (let i = 0; i < len; i++) {
      const idx = s + i;
      if (idx >= L.length) break;
      const t = i / sr;
      const e = envCurve(t, durSec, 0.045, 0.28);
      if (e === 0 && t > durSec + 0.28) break;
      const vib = 1 + 0.006 * Math.sin(2 * Math.PI * 5.3 * t) * Math.min(1, t / 0.28) * (ev.vib || 0.5);
      const cut = (700 + 1900 * vel) + (2600 + 1200 * vel) * Math.min(1, t / 0.18);
      const lpA = lpCoef(cut, sr);
      const fA = f0 * Math.pow(2, -6 / 1200) * vib;
      const fB = f0 * Math.pow(2, 6 / 1200) * vib;
      ph0 += fA / sr; ph1 += fB / sr;
      subPh += f0 / sr;
      let s0 = blepSaw(ph0, fA / sr), s1 = blepSaw(ph1, fB / sr);
      lpL += lpA * (s0 - lpL); s0 = lpL;
      lpR += lpA * (s1 - lpR); s1 = lpR;
      const body = 0.28 * Math.sin(2 * Math.PI * subPh);
      const g = e * gain * vel;
      L[idx] += (s0 + body) * g * gl;
      R[idx] += (s1 + body) * g * gr;
    }
  } },

  bass: { release: 0.09, gain: 0.6, fn: (L, R, s, len, ev, sr, durSec, gain) => {
    const [gl, gr] = panGains(ev.pan);
    const f = ev.freq, vel = ev.vel;
    const lpA = lpCoef(1300, sr);
    let ph = 0, pt = 0, lp = 0;
    for (let i = 0; i < len; i++) {
      const idx = s + i;
      if (idx >= L.length) break;
      const t = i / sr;
      let e = Math.min(1, t / 0.006) * (0.7 + 0.3 * Math.exp(-t / 0.16));
      if (t > durSec) e *= 0.5 + 0.5 * Math.cos(Math.min(1, (t - durSec) / 0.09) * Math.PI);
      if (t > durSec && e <= 0) break;
      ph += f / sr; pt += f / sr;
      let v = 0.8 * Math.sin(2 * Math.PI * ph) + 0.45 * triWave(pt);
      lp += lpA * (v - lp); v = lp;
      L[idx] += v * e * gain * vel * gl;
      R[idx] += v * e * gain * vel * gr;
    }
  } },

  'bass-sq': { release: 0.05, gain: 0.5, fn: (L, R, s, len, ev, sr, durSec, gain) => {
    const [gl, gr] = panGains(ev.pan);
    const f = ev.freq, vel = ev.vel;
    const lpA = lpCoef(1800, sr);
    let ph = 0, lp = 0;
    for (let i = 0; i < len; i++) {
      const idx = s + i;
      if (idx >= L.length) break;
      const t = i / sr;
      let e = Math.min(1, t / 0.004) * (0.75 + 0.25 * Math.exp(-t / 0.1));
      if (t > durSec) e *= 0.5 + 0.5 * Math.cos(Math.min(1, (t - durSec) / 0.05) * Math.PI);
      if (t > durSec && e <= 0) break;
      ph += f / sr;
      let v = blepPulse(ph, f / sr, 0.5);
      lp += lpA * (v - lp); v = lp;
      L[idx] += v * e * gain * vel * gl;
      R[idx] += v * e * gain * vel * gr;
    }
  } },

  'bass-tri': { release: 0.07, gain: 0.55, fn: (L, R, s, len, ev, sr, durSec, gain) => {
    const [gl, gr] = panGains(ev.pan);
    const f = ev.freq, vel = ev.vel;
    const lpA = lpCoef(900, sr);
    let ph = 0, lp = 0;
    for (let i = 0; i < len; i++) {
      const idx = s + i;
      if (idx >= L.length) break;
      const t = i / sr;
      let e = Math.min(1, t / 0.008) * (0.8 + 0.2 * Math.exp(-t / 0.12));
      if (t > durSec) e *= 0.5 + 0.5 * Math.cos(Math.min(1, (t - durSec) / 0.07) * Math.PI);
      if (t > durSec && e <= 0) break;
      ph += f / sr;
      let v = triWave(ph);
      lp += lpA * (v - lp); v = lp;
      L[idx] += v * e * gain * vel * gl;
      R[idx] += v * e * gain * vel * gr;
    }
  } },

  sub: { release: 0.12, gain: 0.4, fn: (L, R, s, len, ev, sr, durSec, gain) => {
    const [gl, gr] = panGains(ev.pan);
    const f = ev.freq, vel = ev.vel;
    let ph = 0;
    for (let i = 0; i < len; i++) {
      const idx = s + i;
      if (idx >= L.length) break;
      const t = i / sr;
      let e = Math.min(1, t / 0.01) * (0.7 + 0.3 * Math.exp(-t / 0.25));
      if (t > durSec) e *= 0.5 + 0.5 * Math.cos(Math.min(1, (t - durSec) / 0.12) * Math.PI);
      if (t > durSec && e <= 0) break;
      ph += f / sr;
      const v = Math.sin(2 * Math.PI * ph) * e * gain * vel;
      L[idx] += v * gl; R[idx] += v * gr;
    }
  } },
};

/* ---------------------------------- percussions ---------------------------------- */

function drumNoise(seedIdx, len, warm = 0) {
  const rng = makeRng(hash32(seedIdx, len));
  const arr = new Float32Array(len);
  let prev = 0;
  for (let i = 0; i < len; i++) {
    let n = rng.f(-1, 1);
    if (warm > 0) { n = (1 - warm) * n + warm * prev; prev = n; }
    arr[i] = n;
  }
  return arr;
}

function drumEvent(L, R, s, len, ev, sr, kind) {
  const [gl, gr] = panGains(ev.pan || 0);
  const vel = ev.vel * (ev.gain ?? 1) * (ev.articulation === 'ghost' ? 0.72 : 1);
  const acoustic = ev.kit === 'acoustic';
  const tune = 1 + 0.045 * ((ev.seedIdx >>> 0) / 4294967295 - 0.5);
  const envelope = (i, end) => Math.min(1, i / (sr * 0.00035), (end - i) / (sr * 0.011));
  const put = (i, v) => {
    const idx = s + i;
    if (idx >= 0 && idx < L.length) {
      const value = v * envelope(i, len);
      L[idx] += value * gl;
      R[idx] += value * gr;
    }
  };

  if (kind === 'kick') {
    const lenN = Math.min(len, Math.round(0.42 * sr));
    const noise = drumNoise(ev.seedIdx || 1, Math.round(0.01 * sr));
    let ph = 0;
    for (let i = 0; i < lenN; i++) {
      const t = i / sr;
      const f = (acoustic ? 54 + 92 * Math.exp(-t / 0.021) : 46 + 118 * Math.exp(-t / 0.028)) * tune;
      ph += f / sr;
      const amp = Math.min(1, t / 0.0015) * Math.exp(-t / (acoustic ? 0.075 : 0.14));
      const click = i < noise.length ? noise[i] * Math.exp(-t / 0.003) * (0.15 + vel * 0.22) : 0;
      const beater = acoustic ? 0.21 * Math.sin(2 * Math.PI * 145 * t) * Math.exp(-t / 0.028) : 0;
      const v = Math.tanh((Math.sin(2 * Math.PI * ph) * amp + click + beater) * 1.55) * 0.81 * vel;
      put(i, v * envelope(i, lenN));
    }
  } else if (kind === 'snare') {
    const lenN = Math.min(len, Math.round(0.3 * sr));
    const noise = drumNoise(ev.seedIdx || 2, lenN);
    // passe-bande approx : passe-bas puis passe-haut
    const aLP = lpCoef((acoustic ? 4900 : 3200) + 950 * vel, sr), aHP = lpCoef(1250, sr);
    let lpS = 0, hpS = 0;
    for (let i = 0; i < lenN; i++) {
      const t = i / sr;
      const n = noise[i];
      lpS += aLP * (n - lpS);         // coupe ~3.2k
      hpS += aHP * (lpS - hpS);       // retire sous 1.4k
      const nz = lpS - hpS;
      const env = Math.exp(-t / 0.085) * Math.min(1, t / 0.0008);
      const shell = Math.sin(2 * Math.PI * 185 * tune * t) + 0.35 * Math.sin(2 * Math.PI * 317 * tune * t);
      const body = (acoustic ? 0.58 : 0.38) * Math.exp(-t / 0.051) * shell;
      put(i, (nz * env * (acoustic ? 1.28 : 1) + body * env) * 0.62 * vel * envelope(i, lenN));
    }
  } else if (kind === 'hat' || kind === 'ohat') {
    const dur = kind === 'ohat' ? 0.24 : 0.032;
    const lenN = Math.min(len, Math.round((dur + 0.06) * sr));
    const noise = drumNoise(ev.seedIdx || 3, lenN);
    const a1 = lpCoef(acoustic ? 4900 : 6500, sr), a2 = a1;
    const cutoff = lpCoef(10500, sr);
    let h1 = 0, h2 = 0, l1 = 0;
    for (let i = 0; i < lenN; i++) {
      const t = i / sr;
      const n = noise[i];
      h1 += a1 * (n - h1); const hp1 = n - h1;
      h2 += a2 * (hp1 - h2); const hp2 = hp1 - h2;
      l1 += cutoff * (hp2 - l1);
      const env = Math.exp(-t / dur) * Math.min(1, t / 0.0006);
      put(i, l1 * env * 0.53 * vel * envelope(i, lenN));
    }
  } else if (kind === 'crash' || kind === 'ride') {
    const crash = kind === 'crash';
    const rng = makeRng(ev.seedIdx);
    const high = lpCoef(Math.min(10500, sr * 0.42), sr), low = lpCoef(crash ? 2800 : 1750, sr);
    const frequencies = [813, 1459, 2073, 2975, 4111, 5687].map((hz) => hz * tune * rng.f(0.985, 1.015));
    let a = 0, b = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      a += high * (rng.f(-1, 1) - a);
      b += low * (a - b);
      let metal = 0;
      for (const hz of frequencies) metal += Math.sin(2 * Math.PI * hz * t) * Math.exp(-t * (3.1 + hz / 2700));
      const wash = (a - b) * Math.exp(-t / (crash ? 0.25 : 0.105));
      put(i, (wash * (crash ? 0.5 : 0.22) + metal * 0.055) * vel);
    }
  } else if (kind === 'clap') {
    const lenN = Math.min(len, Math.round(0.35 * sr));
    const noise = drumNoise(ev.seedIdx || 4, lenN);
    const aLP = lpCoef(2800, sr), aHP = lpCoef(900, sr);
    let lpS = 0, hpS = 0;
    for (let i = 0; i < lenN; i++) {
      const t = i / sr;
      lpS += aLP * (noise[i] - lpS);
      hpS += aHP * (lpS - hpS);
      const nz = lpS - hpS;
      const env = 0.9 * Math.exp(-Math.abs(t) / 0.005)
        + 0.8 * Math.exp(-Math.abs(t - 0.011) / 0.005)
        + 0.7 * Math.exp(-Math.abs(t - 0.022) / 0.005)
        + (t > 0.022 ? 0.5 * Math.exp(-(t - 0.022) / 0.11) : 0);
      put(i, nz * env * 0.5 * vel * envelope(i, lenN));
    }
  } else if (kind === 'shaker') {
    const lenN = Math.min(len, Math.round(0.12 * sr));
    const noise = drumNoise(ev.seedIdx || 5, lenN);
    const a1 = lpCoef(5800, sr);
    let h = 0;
    for (let i = 0; i < lenN; i++) {
      const t = i / sr;
      h += a1 * (noise[i] - h);
      const env = Math.min(1, t / 0.008) * Math.exp(-t / 0.045);
      put(i, (noise[i] - h) * env * 0.4 * vel * envelope(i, lenN));
    }
  } else if (kind === 'tom') {
    const lenN = Math.min(len, Math.round(0.45 * sr));
    let ph = 0;
    for (let i = 0; i < lenN; i++) {
      const t = i / sr;
      const f = 78 + 34 * Math.exp(-t / 0.06);
      ph += f / sr;
      const env = Math.min(1, t / 0.002) * Math.exp(-t / 0.25);
      put(i, Math.sin(2 * Math.PI * ph) * env * 0.6 * vel * envelope(i, lenN));
    }
  }
}

/* ---------------------------------- rendu complet ---------------------------------- */

// Une liaison ne rejoint qu'une voix monodique du même instrument.
function linkedVoices(events, sr) {
  const sort = [...events].sort((a, b) => a.start - b.start);
  const voices = [];
  let previous;
  for (const [i, note] of sort.entries()) {
    const before = sort[i - 1], after = sort[i + 1];
    const solo = before?.start !== note.start && after?.start !== note.start;
    const gap = before ? (note.start - before.start) / sr - before.duration : Infinity;
    const { articulation, inst, bus } = note.event;
    if (solo && previous && note.patch && (articulation === 'legato' || articulation === 'slide') &&
        inst === before.event.inst && bus === before.event.bus && gap <= 0.14 && gap >= -0.38) {
      previous.push(note);
      continue;
    }
    const voice = [note];
    voices.push(voice);
    previous = solo ? voice : undefined;
  }
  return voices;
}

/**
 * Rendu d'une liste d'événements dans des buffers (signal sec).
 * Utilisé par renderSong et par les outils de débogage.
 */
function renderEventsInto(evs, L, R, sr, spb, palette = 'synth', clock, bankVersion = 1, patches) {
  const totalSamples = L.length;
  const ordered = evs.some((ev) => supportsGesture(patches?.[ev.inst])) ? [] : null;
  const notes = [];
  for (const ev of evs) {
    const time = clock ? clock.at(ev.t) : ev.t * spb;
    const start = Math.max(0, Math.round(time * sr));
    if (start >= totalSamples) continue;
    const duration = clock ? clock.at(ev.t + ev.dur) - time : ev.dur * spb;
    const durSec = duration * (ev.articulation === 'staccato' ? 0.57 : 1);
    notes.push({ event: ev, start, duration: durSec });
  }
  const joins = palette === 'studio' ? planSampleLegato(notes, sr, bankVersion) : null;
  for (const note of notes) {
    const { event: ev, start, duration: durSec } = note;
    if (isCustom(ev.inst)) {
      const patch = patches?.[ev.inst];
      if (!patch) throw new Error(ui(`Son personnel absent du projet : ${ev.inst}.`, `Custom sound missing from the project: ${ev.inst}.`));
      if (supportsGesture(patch)) ordered.push({ ...note, patch });
      else {
        renderCustom(L, R, start, ev, sr, durSec, patch);
        ordered?.push(note);
      }
      continue;
    }
    ordered?.push(note);
    if (joins && renderSamples(L, R, start, ev, sr, durSec, ev.take ?? 0, ev.bankVersion ?? bankVersion, joins.get(note))) continue;
    if (ev.bus === 'drum') {
      const seconds = ev.drum === 'crash' ? 1.25 : ev.drum === 'ride' ? 0.47 : 0.5;
      const len = Math.min(Math.round(seconds * sr), totalSamples - start);
      drumEvent(L, R, start, len, ev, sr, ev.drum);
    } else {
      const inst = INSTRUMENTS[ev.inst];
      if (!inst) throw new Error(ui(`Instrument inconnu : ${ev.inst}.`, `Unknown instrument: ${ev.inst}.`));
      const len = Math.min(Math.round((durSec + inst.release) * sr) + 64, totalSamples - start);
      const gain = (ev.gain ?? 1) * inst.gain;
      inst.fn(L, R, start, len, ev, sr, durSec, gain);
    }
  }
  if (ordered) {
    for (const voice of linkedVoices(ordered, sr)) {
      const patch = voice[0].patch;
      if (patch?.modal) renderModal(L, R, voice, sr, patch.modal);
      if (patch?.waveguide) renderWaveguide(L, R, voice, sr, patch.waveguide);
    }
  }
}

/**
 * Rendu du morceau : bus par rôle (nappe, arpège, mélodie, basse, batterie),
 * effets par bus, repli de boucle, master.
 * song: { events, bpm, totalBeats, loop, fx }
 * retourne { L, R, sr, samples }
 */
const BUS_MIX = {
  pad: { gain: 1, highPass: 135 },
  arp: { gain: 0.94, highPass: 90 },
  mel: { gain: 0.93, highPass: 80 },
  counter: { gain: 0.67, highPass: 110 },
  texture: { gain: 0.92, highPass: 43 },
  bass: { gain: 0.76, highPass: 25 },
  drum: { gain: 0.82, highPass: 29 },
};

function renderSong(song, onStem) {
  const sr = song.sr || SR;
  const spb = 60 / song.bpm;
  const clock = musicClock(song);
  const musicSamples = Math.round(clock.seconds * sr);
  const loop = !!song.loop;
  const tailSamples = loop || song.targetSeconds === undefined ? Math.round((loop ? 4.1 : 2.6) * sr)
    : Math.max(0, Math.round(song.targetSeconds * sr) - musicSamples);
  const totalSamples = musicSamples + tailSamples;
  const samples = loop ? musicSamples : totalSamples;
  const stereo = !song.mono;

  const masterL = new Float32Array(samples);
  const masterR = new Float32Array(samples);
  const busL = new Float32Array(totalSamples);
  const busR = new Float32Array(totalSamples);
  const fx = song.fx || {};
  const events = performEvents(song, clock);
  const endFade = Math.min(samples, Math.round((song.endFade || 0) * sr));
  const colors = (song.meta?.sections ?? []).map((s) => ({ start: Math.round(clock.at((s.startBar - 1) * 4) * sr),
    ...COLORS[s.color ?? 'natural'] }));
  const colored = colors.some((color) => color.mix > 0 || color.width !== 1);

  for (const [bus, mix] of Object.entries(BUS_MIX)) {
    const evs = events.filter((e) => e.bus === bus);
    if (!evs.length) continue;
    busL.fill(0);
    busR.fill(0);
    renderEventsInto(evs, busL, busR, sr, spb, song.palette, clock.changes.length ? clock : undefined, song.bankVersion, song.patches);

    const hp = lpCoef(mix.highPass, sr);
    let lowL = 0, lowR = 0;
    for (let i = 0; i < totalSamples; i++) {
      lowL += hp * (busL[i] - lowL);
      lowR += hp * (busR[i] - lowR);
      busL[i] = (busL[i] - lowL) * mix.gain;
      busR[i] = (busR[i] - lowR) * mix.gain;
    }
    applyBuilds(busL, busR, bus, song.builds, clock, sr, loop);
    const delayWet = (fx.delay && fx.delay[bus]) || 0;
    if (delayWet > 0.01 && fx.delayBeats) {
      const delaySec = fx.delayBeats * spb;
      applyPingPong(busL, busR, totalSamples, delaySec, fx.delayFb ?? 0.3, delayWet, sr);
    }
    const wet = (fx.wet && fx.wet[bus]) || (bus === 'counter' ? 0.17 : bus === 'texture' ? 0.22 : 0);
    if (song.room?.amount) applyRoom(busL, busR, sr, bus, song.room, Reverb);
    else if (wet > 0.01) {
      const revL = new Reverb(sr, fx.room ?? 0.6, fx.damp ?? 0.35, 0);
      const revR = new Reverb(sr, fx.room ?? 0.6, fx.damp ?? 0.35, 1);
      const send = lpCoef(180, sr);
      let sendL = 0, sendR = 0;
      for (let i = 0; i < totalSamples; i++) {
        sendL += send * (busL[i] - sendL);
        sendR += send * (busR[i] - sendR);
        const inL = busL[i] - sendL, inR = busR[i] - sendR;
        const l = revL.process(inL * 0.84 + inR * 0.16);
        const r = revR.process(inR * 0.84 + inL * 0.16);
        // Le retour reste sous le signal direct, même sur une note proche d’un mode de la pièce.
        busL[i] += (l * 0.23 + r * 0.05) * wet;
        busR[i] += (r * 0.23 + l * 0.05) * wet;
      }
    }
    if (colored) applySectionColors(busL, busR, colors, sr, loop ? musicSamples : 0);

    // Pour les boucles très courtes, les retours peuvent occuper plusieurs tours.
    if (loop) {
      const taper = sr * 0.35;
      for (let i = musicSamples; i < totalSamples; i++) {
        const gain = Math.min(1, (totalSamples - 1 - i) / taper);
        const target = i % musicSamples;
        busL[target] += busL[i] * gain;
        busR[target] += busR[i] * gain;
      }
    }
    if (endFade) fadeEnd(busL, busR, samples, endFade);
    if (!stereo) toMono({ L: busL.subarray(0, samples), R: busR.subarray(0, samples) });
    for (let i = 0; i < samples; i++) {
      masterL[i] += busL[i];
      masterR[i] += busR[i];
    }
    if (onStem) onStem(bus, busL.subarray(0, samples), busR.subarray(0, samples), sr, !stereo);
  }

  const out = masterOutput(masterL, masterR, samples, sr, 0, loop);
  return { ...out, mono: !stereo, metrics: measureAudio(out) };
}

function applySectionColors(L, R, colors, sr, loopLength) {
  const smooth = 1 - Math.exp(-1 / (0.052 * sr));
  const targets = colors.map((c) => ({ ...c, hp: lpCoef(c.low, sr), lp: lpCoef(Math.min(c.high, sr * 0.43), sr) }));
  const preRoll = Math.min(loopLength, Math.round(sr * 0.35));
  const state = { ...(preRoll ? targets.at(-1) : targets[0]) };
  let section = 0;
  let lowL = 0, lowR = 0, filteredL = 0, filteredR = 0;
  for (let i = -preRoll; i < L.length; i++) {
    if (section + 1 < targets.length && i >= targets[section + 1].start) section++;
    const goal = i < 0 ? targets.at(-1) : targets[section];
    state.hp += smooth * (goal.hp - state.hp);
    state.lp += smooth * (goal.lp - state.lp);
    state.mix += smooth * (goal.mix - state.mix);
    state.width += smooth * (goal.width - state.width);
    state.drive += smooth * (goal.drive - state.drive);
    const index = i < 0 ? loopLength + i : i;
    const l = L[index], r = R[index];
    lowL += state.hp * (l - lowL);
    lowR += state.hp * (r - lowR);
    filteredL += state.lp * (l - lowL - filteredL);
    filteredR += state.lp * (r - lowR - filteredR);
    if (i < 0) continue;
    let a = l + (filteredL - l) * state.mix, b = r + (filteredR - r) * state.mix;
    if (state.drive > 0.00005) {
      const amount = 1 + state.drive * 5;
      const scale = 1 / Math.tanh(amount);
      a += state.drive * (Math.tanh(a * amount) * scale - a);
      b += state.drive * (Math.tanh(b * amount) * scale - b);
    }
    const mid = (a + b) * 0.5, side = (a - b) * 0.5 * state.width;
    L[i] = mid + side;
    R[i] = mid - side;
  }
}

/** Convertit un rendu stéréo { L, R } en mono (moyenne des canaux, in-place). */
function toMono(out) {
  const n = out.L.length;
  for (let i = 0; i < n; i++) {
    const m = (out.L[i] + out.R[i]) / 2;
    out.L[i] = m;
    out.R[i] = m;
  }
  return out;
}

function fadeEnd(L, R, n, length) {
  for (let i = 0; i < length; i++) {
    const gain = 0.5 + 0.5 * Math.cos(i * Math.PI / Math.max(1, length - 1));
    L[n - length + i] *= gain;
    R[n - length + i] *= gain;
  }
}

/** Passe-haut, égalisation, compression stéréo liée et plafond de crête. */
function masterOutput(L, R, n, sr, endFadeSec, loop = null) {
  const music = loop !== null;
  const lead = loop ? Math.min(n, Math.round(1.8 * sr)) : 0;
  // 1) passe-haut : retire le rumble inaudible qui mange la headroom
  const a = lpCoef(music ? 22 : 32, sr);
  let lpL = 0, lpR = 0;
  for (let i = n - lead; i < n; i++) {
    lpL += a * (L[i] - lpL);
    lpR += a * (R[i] - lpR);
  }
  for (let i = 0; i < n; i++) {
    lpL += a * (L[i] - lpL); L[i] -= lpL;
    lpR += a * (R[i] - lpR); R[i] -= lpR;
  }

  // 2) tilt EQ : léger creux sous 120 Hz, léger air au-dessus de 6 kHz
  const aLow = lpCoef(120, sr);
  const aHigh = lpCoef(6000, sr);
  const air = music ? 0.08 : 0.16, lowCut = music ? 0.06 : 0.10;
  let lowL = 0, lowR = 0, highL = 0, highR = 0;
  for (let i = n - lead; i < n; i++) {
    lowL += aLow * (L[i] - lowL);
    lowR += aLow * (R[i] - lowR);
    highL += aHigh * (L[i] - highL);
    highR += aHigh * (R[i] - highR);
  }
  for (let i = 0; i < n; i++) {
    lowL += aLow * (L[i] - lowL);
    lowR += aLow * (R[i] - lowR);
    highL += aHigh * (L[i] - highL);
    highR += aHigh * (R[i] - highR);
    L[i] += air * (L[i] - highL) - lowCut * lowL;
    R[i] += air * (R[i] - highR) - lowCut * lowR;
  }

  // 3) colle de bus : compresseur doux (2.2:1) pour souder les pistes
  const th = music ? 0.24 : 0.22, ratio = music ? 1.8 : 2.2, makeup = music ? 1.15 : 1.22;
  const atk = 1 - Math.exp(-1 / (0.025 * sr));
  const rel = 1 - Math.exp(-1 / (0.22 * sr));
  let env = 0;
  for (let i = n - lead; i < n; i++) {
    const peak = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    env += (peak > env ? atk : rel) * (peak - env);
  }
  for (let i = 0; i < n; i++) {
    const peak = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    env += (peak > env ? atk : rel) * (peak - env);
    const over = env / th;
    const gr = over > 1 ? Math.pow(over, 1 / ratio - 1) : 1;
    const g = gr * makeup;
    L[i] *= g;
    R[i] *= g;
  }

  if (endFadeSec > 0) fadeEnd(L, R, n, Math.min(n, Math.round(endFadeSec * sr)));
  for (let i = 0; i < n; i++) {
    L[i] = softClip(L[i]);
    R[i] = softClip(R[i]);
  }
  // 4) normalisation vers une loudness cible (RMS) avec plafond de crête :
  //    évite qu'une nappe continue finisse deux fois plus forte qu'un morceau percussif.
  let peak = 0, sumSq = 0;
  for (let i = 0; i < n; i++) {
    const p = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    if (p > peak) peak = p;
    sumSq += 0.5 * (L[i] * L[i] + R[i] * R[i]);
  }
  const rms = Math.sqrt(sumSq / Math.max(1, n));
  if (peak > 1e-6 && rms > 1e-6) {
    const g = Math.min((music ? 0.89 : 0.95) / peak, (music ? 0.155 : 0.16) / rms);
    for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; }
  }
  return { L: L.subarray(0, n), R: R.subarray(0, n), sr, samples: n };
}

function measureAudio({ L, R, samples }) {
  let peak = 0, energyL = 0, energyR = 0, cross = 0;
  for (let i = 0; i < samples; i++) {
    const l = L[i], r = R[i];
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
    energyL += l * l;
    energyR += r * r;
    cross += l * r;
  }
  const rms = Math.sqrt((energyL + energyR) / (2 * samples));
  const db = (amplitude) => amplitude > 0 ? Number((20 * Math.log10(amplitude)).toFixed(2)) : null;
  const correlation = energyL > 0 && energyR > 0 ? Number((cross / Math.sqrt(energyL * energyR)).toFixed(3)) : null;
  return { peakDbfs: db(peak), rmsDbfs: db(rms), crestDb: rms > 0 ? db(peak / rms) : null, stereoCorrelation: correlation };
}

/* ---------------------------------- WAV ---------------------------------- */

function wavEncoding(L, R, sr, mono, bits) {
  if (![16, 24, 32].includes(bits)) throw new Error(ui(`Profondeur WAV invalide : ${bits}.`, `Invalid WAV bit depth: ${bits}.`));
  const float = bits === 32;
  const channels = mono ? 1 : 2;
  const n = mono ? L.length : Math.min(L.length, R.length);
  const bytesPerSample = bits / 8;
  const blockAlign = channels * bytesPerSample;
  const dataSize = n * blockAlign;
  const pad = dataSize % 2;
  const header = Buffer.alloc(float ? 58 : 44);
  const bytes = header.length + dataSize + pad;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(bytes - 8, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(float ? 18 : 16, 16);
  header.writeUInt16LE(float ? 3 : 1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sr, 24);
  header.writeUInt32LE(sr * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  if (float) {
    header.write('fact', 38, 'ascii');
    header.writeUInt32LE(4, 42);
    header.writeUInt32LE(n, 46);
  }
  header.write('data', header.length - 8, 'ascii');
  header.writeUInt32LE(dataSize, header.length - 4);

  const max = 2 ** (bits - 1) - 1;
  const writeSample = float
    ? (buf, value, pos) => buf.writeFloatLE(value, pos)
    : (buf, value, pos) => buf.writeIntLE(Math.round(Math.max(-1, Math.min(1, value)) * max), pos, bytesPerSample);
  function writeBlock(buf, first, length) {
    for (let i = 0; i < length; i++) {
      const pos = i * blockAlign;
      writeSample(buf, L[first + i], pos);
      if (!mono) writeSample(buf, R[first + i], pos + bytesPerSample);
    }
    return buf.subarray(0, length * blockAlign);
  }
  return { header, pad, blockAlign, writeBlock,
    info: { bytes, samples: n, sr, channels, bits, encoding: float ? 'float' : 'pcm' } };
}

function wavBuffer(L, R, sr = SR, mono = false, bits = 16) {
  const { header, writeBlock, info } = wavEncoding(L, R, sr, mono, bits);
  const buf = Buffer.alloc(info.bytes);
  header.copy(buf);
  writeBlock(buf.subarray(header.length), 0, info.samples);
  return buf;
}

/** WAV PCM 16/24 bits ou IEEE Float 32 bits pour les pistes séparées. */
function writeWav(filePath, L, R, sr = SR, mono = false, bits = 16) {
  const { header, pad, blockAlign, writeBlock, info } = wavEncoding(L, R, sr, mono, bits);
  const blockFrames = 16384;
  const buf = Buffer.allocUnsafe(blockFrames * blockAlign);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${randomUUID()}.wav.tmp`);
  const fd = fs.openSync(tempPath, 'wx');
  try {
    try {
      fs.writeFileSync(fd, header);
      for (let frame = 0; frame < info.samples; frame += blockFrames) {
        const length = Math.min(info.samples - frame, blockFrames);
        fs.writeFileSync(fd, writeBlock(buf, frame, length));
      }
      if (pad) fs.writeFileSync(fd, Buffer.alloc(1));
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
  return info;
}

/** Infos rapides des fichiers WAV écrits par SoundMCP. */
function readWavInfo(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const header = Buffer.alloc(58);
  try {
    fs.readSync(fd, header, 0, header.length, 0);
    const encoding = header.readUInt16LE(20) === 3 ? 'float' : 'pcm';
    const dataSize = header.readUInt32LE(encoding === 'float' ? 54 : 40);
    return {
      riff: header.toString('ascii', 0, 4),
      channels: header.readUInt16LE(22),
      sr: header.readUInt32LE(24),
      bits: header.readUInt16LE(34),
      encoding, dataSize, bytes: fs.fstatSync(fd).size,
      duration: dataSize / header.readUInt32LE(28),
    };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  SR,
  renderSong,
  renderEventsInto,
  Reverb,
  applyPingPong,
  masterOutput,
  toMono,
  lpCoef,
  writeWav,
  wavBuffer,
  readWavInfo,
  midiToFreq,
  INSTRUMENTS,
};
