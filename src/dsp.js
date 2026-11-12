'use strict';

/**
 * Moteur DSP : synthèse des instruments, effets (réverbération type freeverb,
 * délai ping-pong), chaîne master et export WAV 16 bits stéréo.
 * Zéro dépendance : tout est généré mathématiquement.
 */

const fs = require('node:fs');
const path = require('node:path');
const { makeRng, hash32 } = require('./rng');

const SR = 44100;

/* ---------------------------------- utilitaires ---------------------------------- */

const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
const lpCoef = (hz, sr) => 1 - Math.exp((-2 * Math.PI * hz) / sr);

/** enveloppe : attaque sinus, soutien, relâchement cosinus (zéro clic). */
function envCurve(t, durSec, attack, release) {
  if (t < attack) return Math.sin((t / attack) * (Math.PI / 2));
  if (t < durSec) return 1;
  if (t < durSec + release) {
    const tr = (t - durSec) / release;
    return 0.5 + 0.5 * Math.cos(tr * Math.PI);
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
const sawWave = (p) => 2 * (p - Math.floor(p)) - 1;
const pulseWave = (p, duty) => (p - Math.floor(p) < duty ? 1 : -1);

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
    this.idx = (this.idx + 1) % this.buf.length;
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
    this.idx = (this.idx + 1) % this.buf.length;
    return out;
  }
}

/** Réverbération Schroeder/freeverb-like, instance par canal. */
class Reverb {
  constructor(sr, room = 0.6, damp = 0.35, spread = 23) {
    const scale = sr / 44100;
    const base = [1116, 1188, 1277, 1356];
    const fb = 0.7 + Math.min(0.95, Math.max(0.1, room)) * 0.28;
    this.combs = base.map((n) => new Comb(n * scale, fb, damp));
    this.allpasses = [556, 441].map((n) => new Allpass(n * scale, 0.5));
    this.spread = spread;
  }
  process(x, channelOffset = 0) {
    let out = 0;
    for (let i = 0; i < this.combs.length; i++) {
      out += this.combs[i].process(x + channelOffset * this.spread * 0.0001);
    }
    for (let i = 0; i < this.allpasses.length; i++) out = this.allpasses[i].process(out);
    return out;
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
    const r = (w - d + size) % size;
    const oL = bufL[r], oR = bufR[r];
    let fL = oR * fb, fR = oL * fb; // croisement = ping-pong
    lpL += a * (fL - lpL); fL = Math.abs(lpL) < 1e-14 ? 0 : lpL;
    lpR += a * (fR - lpR); fR = Math.abs(lpR) < 1e-14 ? 0 : lpR;
    bufL[w] = L[i] + fL;
    bufR[w] = R[i] + fR;
    L[i] += oL * wet;
    R[i] += oR * wet;
    w = (w + 1) % size;
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
  const lpA = lpCoef(o.lpHz, sr);
  const f0 = ev.freq;
  const vel = ev.vel;
  const detC = o.detune;
  let lpL0 = 0, lpL1 = 0, lpR0 = 0, lpR1 = 0;
  let ph0 = 0, ph1 = 0;
  const oscMix = o.mix; // { sine, tri, saw, duty? }
  for (let i = 0; i < len; i++) {
    const idx = start + i;
    if (idx >= L.length) break;
    const t = i / sr;
    const e = envCurve(t, durSec, o.attack, release);
    if (e === 0 && t > durSec + release) break;
    const lfo = 1 + lfoDepth * Math.sin(2 * Math.PI * lfoHz * t + 1.3);
    let s0, s1;
    const fDet0 = f0 * Math.pow(2, -detC / 1200);
    const fDet1 = f0 * Math.pow(2, detC / 1200);
    ph0 += fDet0 / sr; ph1 += fDet1 / sr;
    s0 = oscMix.sine * Math.sin(2 * Math.PI * ph0) + oscMix.tri * triWave(ph0) + oscMix.saw * sawWave(ph0);
    s1 = oscMix.sine * Math.sin(2 * Math.PI * ph1) + oscMix.tri * triWave(ph1) + oscMix.saw * sawWave(ph1);
    lpL0 += lpA * (s0 - lpL0); s0 = lpL0;
    lpR1 += lpA * (s1 - lpR1); s1 = lpR1;
    const g = e * lfo * gain * vel;
    L[idx] += s0 * g * gcl;
    R[idx] += s1 * g * gcr;
  }
}

const INSTRUMENTS = {
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
    const det = 11, vibDepth = 0.004, vibHz = 4.8;
    const lpMin = 1000, lpMax = 2900;
    let ph0 = 0, ph1 = 0, lpL = 0, lpR = 0;
    for (let i = 0; i < len; i++) {
      const idx = s + i;
      if (idx >= L.length) break;
      const t = i / sr;
      const e = envCurve(t, durSec, 0.55, 0.9);
      if (e === 0 && t > durSec + 0.9) break;
      const vib = 1 + vibDepth * Math.sin(2 * Math.PI * vibHz * t) * Math.min(1, t / 0.3) * (ev.vib || 0.5);
      const cut = lpMin + (lpMax - lpMin) * Math.min(1, t / 0.6);
      const lpA = lpCoef(cut, sr);
      ph0 += (f0 * Math.pow(2, -det / 1200) * vib) / sr;
      ph1 += (f0 * Math.pow(2, det / 1200) * vib) / sr;
      let s0 = 0.75 * sawWave(ph0) + 0.25 * Math.sin(2 * Math.PI * ph0);
      let s1 = 0.75 * sawWave(ph1) + 0.25 * Math.sin(2 * Math.PI * ph1);
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
    const lpA = lpCoef(7000, sr);
    let ph = 0, lp = 0;
    for (let i = 0; i < len; i++) {
      const idx = s + i;
      if (idx >= L.length) break;
      const t = i / sr;
      let e = Math.min(1, t / 0.004);
      e *= t < durSec ? 0.92 + 0.08 * Math.exp(-t / 0.05) : 0.5 + 0.5 * Math.cos(Math.min(1, (t - durSec) / 0.06) * Math.PI);
      if (t > durSec && e <= 0) break;
      ph += f0 / sr;
      let v = pulseWave(ph, 0.25);
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
      const cut = 900 + 2600 * Math.min(1, t / 0.18);
      const lpA = lpCoef(cut, sr);
      ph0 += (f0 * Math.pow(2, -6 / 1200) * vib) / sr;
      ph1 += (f0 * Math.pow(2, 6 / 1200) * vib) / sr;
      subPh += f0 / sr;
      let s0 = sawWave(ph0), s1 = sawWave(ph1);
      lpL += lpA * (s0 - lpL); s0 = lpL;
      lpR += lpA * (s1 - lpR); s1 = lpR;
      const body = 0.3 * Math.sin(2 * Math.PI * subPh);
      const g = e * gain * vel;
      L[idx] += (s0 + body) * g * gl;
      R[idx] += (s1 + body) * g * gr;
    }
  } },

  piano: { release: 0.3, gain: 0.45, fn: (L, R, s, len, ev, sr, durSec, gain) => {
    const [gl, gr] = panGains(ev.pan);
    const f = ev.freq, vel = ev.vel;
    const lpA = lpCoef(3800, sr);
    let ph0 = 0, ph1 = 0, ps = 0, p2 = 0, lpL = 0, lpR = 0;
    for (let i = 0; i < len; i++) {
      const idx = s + i;
      if (idx >= L.length) break;
      const t = i / sr;
      let e = Math.min(1, t / 0.004) * (0.25 + 0.75 * Math.exp(-t / 1.3));
      if (t > durSec) e *= 0.5 + 0.5 * Math.cos(Math.min(1, (t - durSec) / 0.3) * Math.PI);
      if (t > durSec && e <= 0.001) break;
      ph0 += (f * Math.pow(2, 3 / 1200)) / sr;
      ph1 += (f * Math.pow(2, -3 / 1200)) / sr;
      ps += f / sr; p2 += 2 * f / sr;
      let v0 = 0.5 * triWave(ph0) + 0.3 * Math.sin(2 * Math.PI * ps) + 0.2 * triWave(ph1);
      let v1 = 0.5 * triWave(ph1) + 0.3 * Math.sin(2 * Math.PI * ps) + 0.2 * triWave(ph0);
      const h2 = 0.15 * Math.exp(-t / 0.22) * Math.sin(2 * Math.PI * p2);
      lpL += lpA * (v0 - lpL); v0 = lpL + h2;
      lpR += lpA * (v1 - lpR); v1 = lpR + h2;
      const g = e * gain * vel;
      L[idx] += v0 * g * gl;
      R[idx] += v1 * g * gr;
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
      let v = pulseWave(ph, 0.5);
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
  const vel = ev.vel;
  const put = (i, v) => {
    const idx = s + i;
    if (idx >= 0 && idx < L.length) {
      L[idx] += v * gl;
      R[idx] += v * gr;
    }
  };

  if (kind === 'kick') {
    const lenN = Math.min(len, Math.round(0.42 * sr));
    const noise = drumNoise(ev.seedIdx || 1, Math.round(0.01 * sr));
    let ph = 0;
    for (let i = 0; i < lenN; i++) {
      const t = i / sr;
      const f = 46 + 118 * Math.exp(-t / 0.028);
      ph += f / sr;
      let amp = Math.min(1, t / 0.0015) * Math.exp(-t / 0.18);
      let click = noise[Math.min(i, noise.length - 1)] * Math.exp(-t / 0.004) * 0.3;
      const v = Math.tanh((Math.sin(2 * Math.PI * ph) * amp + click) * 1.6) * 0.85 * vel;
      put(i, v);
    }
  } else if (kind === 'snare') {
    const lenN = Math.min(len, Math.round(0.3 * sr));
    const noise = drumNoise(ev.seedIdx || 2, lenN);
    // passe-bande approx : passe-bas puis passe-haut
    const aLP = lpCoef(3200, sr), aHP = lpCoef(1400, sr);
    let lpS = 0, hpS = 0;
    let pb = 0;
    for (let i = 0; i < lenN; i++) {
      const t = i / sr;
      const n = noise[i];
      lpS += aLP * (n - lpS);         // coupe ~3.2k
      hpS += aHP * (lpS - hpS);       // retire sous 1.4k
      const nz = lpS - hpS;
      const env = Math.exp(-t / 0.085) * Math.min(1, t / 0.0008);
      const body = 0.45 * Math.exp(-t / 0.05) * Math.sin(2 * Math.PI * 185 * (t + pb));
      put(i, (nz * env + body * env) * 0.6 * vel);
    }
  } else if (kind === 'hat' || kind === 'ohat') {
    const dur = kind === 'ohat' ? 0.24 : 0.032;
    const lenN = Math.min(len, Math.round((dur + 0.06) * sr));
    const noise = drumNoise(ev.seedIdx || 3, lenN);
    const a1 = lpCoef(7200, sr), a2 = lpCoef(7200, sr);
    let h1 = 0, h2 = 0, l1 = 0;
    for (let i = 0; i < lenN; i++) {
      const t = i / sr;
      const n = noise[i];
      h1 += a1 * (n - h1); const hp1 = n - h1;
      h2 += a2 * (hp1 - h2); const hp2 = hp1 - h2;
      l1 += lpCoef(9000, sr) * (hp2 - l1);
      const env = Math.exp(-t / dur) * Math.min(1, t / 0.0006);
      put(i, l1 * env * 0.5 * vel);
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
      put(i, nz * env * 0.5 * vel);
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
      put(i, (noise[i] - h) * env * 0.4 * vel);
    }
  } else if (kind === 'tom') {
    const lenN = Math.min(len, Math.round(0.45 * sr));
    let ph = 0;
    for (let i = 0; i < lenN; i++) {
      const t = i / sr;
      const f = 78 + 34 * Math.exp(-t / 0.06);
      ph += f / sr;
      const env = Math.min(1, t / 0.002) * Math.exp(-t / 0.25);
      put(i, Math.sin(2 * Math.PI * ph) * env * 0.6 * vel);
    }
  }
}

/* ---------------------------------- rendu complet ---------------------------------- */

/**
 * Rendu d'une liste d'événements dans des buffers (signal sec).
 * Utilisé par renderSong et par les outils de débogage.
 */
function renderEventsInto(evs, L, R, sr, spb) {
  const totalSamples = L.length;
  for (const ev of evs) {
    const start = Math.max(0, Math.round(ev.t * spb * sr));
    if (start >= totalSamples) continue;
    if (ev.bus === 'drum') {
      const len = Math.min(Math.round(0.5 * sr), totalSamples - start);
      drumEvent(L, R, start, len, ev, sr, ev.drum);
    } else {
      const inst = INSTRUMENTS[ev.inst];
      if (!inst) continue;
      const durSec = ev.dur * spb;
      const len = Math.min(Math.round((durSec + inst.release) * sr) + 64, totalSamples - start);
      const gain = (ev.gain ?? 1) * inst.gain;
      try { inst.fn(L, R, start, len, ev, sr, durSec, gain); } catch { /* robustesse */ }
    }
  }
}

/**
 * Rendu du morceau : bus par rôle (nappe, arpège, mélodie, basse, batterie),
 * effets par bus, repli de boucle, master.
 * song: { events, bpm, totalBeats, loop, fx }
 * retourne { L, R, sr, samples }
 */
function renderSong(song) {
  const sr = SR;
  const spb = 60 / song.bpm;
  const musicSamples = Math.round(song.totalBeats * spb * sr);
  const loop = !!song.loop;
  const loopSamples = loop ? musicSamples : null;
  const tailSamples = Math.round((loop ? 3.2 : 2.6) * sr);
  const totalSamples = (loop ? loopSamples : musicSamples) + tailSamples;

  const masterL = new Float32Array(totalSamples);
  const masterR = new Float32Array(totalSamples);

  const buses = ['pad', 'arp', 'mel', 'bass', 'drum'];
  for (const bus of buses) {
    const evs = song.events.filter((e) => e.bus === bus);
    if (!evs.length) continue;
    const busL = new Float32Array(totalSamples);
    const busR = new Float32Array(totalSamples);

    renderEventsInto(evs, busL, busR, sr, spb);

    const fx = song.fx || {};
    const delayWet = (fx.delay && fx.delay[bus]) || 0;
    if (delayWet > 0.01 && fx.delayBeats) {
      const delaySec = fx.delayBeats * spb;
      applyPingPong(busL, busR, totalSamples, delaySec, fx.delayFb ?? 0.3, delayWet, sr);
    }
    const wet = (fx.wet && fx.wet[bus]) || 0;
    if (wet > 0.01) {
      const revL = new Reverb(sr, fx.room ?? 0.6, fx.damp ?? 0.35, 0);
      const revR = new Reverb(sr, fx.room ?? 0.6, fx.damp ?? 0.35, 1);
      for (let i = 0; i < totalSamples; i++) {
        const l = revL.process(busL[i]);
        const r = revR.process(busR[i]);
        busL[i] += l * wet;
        busR[i] += r * wet;
      }
    }

    for (let i = 0; i < totalSamples; i++) {
      masterL[i] += busL[i];
      masterR[i] += busR[i];
    }
  }

  // repli de boucle : la queue (réverb/délai/relâchements) revient au début
  if (loop) {
    for (let i = 0; i < tailSamples; i++) {
      masterL[i] += masterL[loopSamples + i];
      masterR[i] += masterR[loopSamples + i];
    }
    return masterOutput(masterL, masterR, loopSamples, sr, song.endFade || 0);
  }
  return masterOutput(masterL, masterR, musicSamples + tailSamples, sr, song.endFade || 0);
}

/** passe-bas HP global + écrêtage doux + normalisation, éventuel fondu de fin. */
function masterOutput(L, R, n, sr, endFadeSec) {
  const a = lpCoef(32, sr);
  let lpL = 0, lpR = 0;
  for (let i = 0; i < n; i++) {
    lpL += a * (L[i] - lpL); L[i] -= lpL;
    lpR += a * (R[i] - lpR); R[i] -= lpR;
  }
  if (endFadeSec > 0) {
    const fadeN = Math.min(n, Math.round(endFadeSec * sr));
    for (let i = 0; i < fadeN; i++) {
      const g = 0.5 + 0.5 * Math.cos((i / fadeN) * Math.PI);
      L[n - fadeN + i] *= g;
      R[n - fadeN + i] *= g;
    }
  }
  for (let i = 0; i < n; i++) {
    L[i] = softClip(L[i]);
    R[i] = softClip(R[i]);
  }
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const p = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    if (p > peak) peak = p;
  }
  if (peak > 1e-6) {
    const g = 0.95 / peak;
    for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; }
  }
  return { L: L.subarray(0, n), R: R.subarray(0, n), sr, samples: n };
}

/* ---------------------------------- WAV ---------------------------------- */

/** Écrit un WAV PCM 16 bits stéréo. */
function writeWav(filePath, L, R, sr = SR) {
  const n = Math.min(L.length, R.length);
  const dataSize = n * 2 * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);        // PCM
  buf.writeUInt16LE(2, 22);        // stéréo
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 4, 28);   // byte rate
  buf.writeUInt16LE(4, 32);        // block align
  buf.writeUInt16LE(16, 34);       // bits
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < n; i++) {
    const l = Math.max(-1, Math.min(1, L[i]));
    const r = Math.max(-1, Math.min(1, R[i]));
    buf.writeInt16LE(Math.round(l * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(r * 32767), 46 + i * 4);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buf);
  return { bytes: buf.length, samples: n, sr };
}

/** Infos rapides d'un WAV écrit (pour tests). */
function readWavInfo(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const head = Buffer.alloc(44);
  fs.readSync(fd, head, 0, 44, 0);
  fs.closeSync(fd);
  const stat = fs.statSync(filePath);
  return {
    riff: head.toString('ascii', 0, 4),
    channels: head.readUInt16LE(22),
    sr: head.readUInt32LE(24),
    bits: head.readUInt16LE(34),
    dataSize: head.readUInt32LE(40),
    bytes: stat.size,
    duration: head.readUInt32LE(40) / (head.readUInt32LE(24) * head.readUInt16LE(22) * 2),
  };
}

module.exports = {
  SR,
  renderSong,
  renderEventsInto,
  Reverb,
  applyPingPong,
  writeWav,
  readWavInfo,
  midiToFreq,
  INSTRUMENTS,
};
