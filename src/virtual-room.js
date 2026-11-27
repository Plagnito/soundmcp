'use strict';

const { ui } = require('./language');

const DISTANCE = { mel: 0.18, pad: 0.74, arp: 0.34, counter: 0.47, texture: 0.77, bass: 0.27, drum: 0.43 };
const REFLECTIONS = [
  [0.0064, 0.0092, 0.42, 0.22],
  [0.0118, 0.0137, 0.26, 0.52],
  [0.0181, 0.0163, 0.30, 0.35],
  [0.0239, 0.0276, 0.23, 0.63],
  [0.0347, 0.0313, 0.16, 0.45],
];
const unit = (v) => Number.isFinite(v) && v >= 0 && v <= 1;
const coefficient = (hz, sr) => 1 - Math.exp(-2 * Math.PI * hz / sr);

function readRoom(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((k) => !['amount', 'size', 'damping', 'distance'].includes(k))) {
    throw new Error(ui('room attend amount, size, damping et distance.', 'room accepts amount, size, damping, and distance.'));
  }
  const { amount = 0.58, size = 0.52, damping = 0.58, distance = {} } = value;
  if (![amount, size, damping].every(unit) || !distance || typeof distance !== 'object' || Array.isArray(distance) ||
      Object.entries(distance).some(([part, depth]) => !Object.hasOwn(DISTANCE, part) || !unit(depth))) {
    throw new Error(ui('Les réglages de room et les distances par pupitre doivent être entre 0 et 1.', 'room settings and per-part distances must be between 0 and 1.'));
  }
  return { amount, size, damping, distance };
}

function applyRoom(L, R, sr, bus, room, Reverb) {
  const { amount, size, damping } = room;
  if (!amount) return;
  const distance = room.distance[bus] ?? DISTANCE[bus];
  const space = 0.56 + size * 0.96;
  const taps = REFLECTIONS.map(([l, r, gain, cross]) => ({
    l: Math.round(l * space * sr), r: Math.round(r * space * sr), gain, cross,
  }));
  const length = 1 + Math.max(...taps.flatMap((tap) => [tap.l, tap.r]));
  const delayL = new Float32Array(length), delayR = new Float32Array(length);
  const revL = new Reverb(sr, 0.26 + size * 0.62, 0.22 + damping * 0.59, 0);
  const revR = new Reverb(sr, 0.26 + size * 0.62, 0.22 + damping * 0.59, 1);
  const directFilter = coefficient(Math.min(sr * 0.44, 17000 * 2 ** (-2.3 * distance * amount)), sr);
  const roomFilter = coefficient(7500 * 2 ** (-1.9 * damping), sr);
  const lowCut = coefficient(165, sr);
  const dry = 1 - 0.33 * amount * distance;
  const early = amount * (0.115 + 0.40 * distance);
  const late = amount * (0.065 + 0.27 * distance);
  let cursor = 0, clearL = 0, clearR = 0, lowL = 0, lowR = 0, darkL = 0, darkR = 0;
  for (let i = 0; i < L.length; i++) {
    clearL += directFilter * (L[i] - clearL);
    clearR += directFilter * (R[i] - clearR);
    lowL += lowCut * (L[i] - lowL);
    lowR += lowCut * (R[i] - lowR);
    darkL += roomFilter * (L[i] - lowL - darkL);
    darkR += roomFilter * (R[i] - lowR - darkR);
    delayL[cursor] = darkL;
    delayR[cursor] = darkR;
    let firstL = 0, firstR = 0;
    for (const tap of taps) {
      const l = (cursor + length - tap.l) % length, r = (cursor + length - tap.r) % length;
      firstL += tap.gain * ((1 - tap.cross) * delayL[l] + tap.cross * delayR[l]);
      firstR += tap.gain * ((1 - tap.cross) * delayR[r] + tap.cross * delayL[r]);
    }
    L[i] = clearL * dry + firstL * early + revL.process(0.74 * darkL + 0.26 * darkR) * late;
    R[i] = clearR * dry + firstR * early + revR.process(0.74 * darkR + 0.26 * darkL) * late;
    if (++cursor === length) cursor = 0;
  }
}

module.exports = { readRoom, applyRoom };
