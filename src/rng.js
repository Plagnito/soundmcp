'use strict';

/**
 * Générateur pseudo-aléatoire déterministe (mulberry32).
 * Même graine => même musique. C'est la base de la reproductibilité :
 * une IA peut noter le `seed` renvoyé et le rejouer/modifier.
 */
function makeRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  const next = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const f = (min = 0, max = 1) => min + next() * (max - min);
  const int = (min, max) => Math.floor(min + next() * (max - min + 1)); // inclusif
  const pick = (arr) => arr[Math.floor(next() * arr.length) % arr.length];
  const chance = (p) => next() < p;
  const weighted = (items, getW) => {
    let total = 0;
    const ws = items.map((it) => {
      const v = Math.max(0, getW(it));
      total += v;
      return v;
    });
    let r = next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= ws[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  };
  return { next, f, int, pick, chance, weighted };
}

/** Graine aléatoire au lancement (quand l'IA n'en fournit pas). */
function randomSeed() {
  return Math.floor(Math.random() * 0xfffffffe) >>> 0;
}

/** Petit hash 32 bits déterministe (pour le bruit par événement). */
function hash32(a, b) {
  let h = (Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b ^ 0xc2b2ae35, 0x27d4eb2f)) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x2545f491) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0x2545f491) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

module.exports = { makeRng, randomSeed, hash32 };
