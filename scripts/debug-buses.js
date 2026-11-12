'use strict';

/** Débogage rapide : stats par bus (signal sec) d'un rendu. Usage : node scripts/debug-buses.js [style] [seed] */
const { createSong } = require('../src/composer');
const { renderEventsInto } = require('../src/dsp');

const style = process.argv[2] || 'upbeat';
const seed = Number(process.argv[3] || 999);

const song = createSong({ style, duration_seconds: 8, seed, tempo: 128 });

const SR = 44100;
const spb = 60 / song.bpm;
const musicSamples = Math.round(song.totalBeats * spb * SR);
console.log(`style=${style} bpm=${song.bpm} bars=${song.bars} musicSamples=${musicSamples} loop=${song.loop}`);
console.log(`events=${song.events.length} (par bus: ${['pad', 'arp', 'mel', 'bass', 'drum'].map((b) => `${b}=${song.events.filter((e) => e.bus === b).length}`).join(' ')})`);

const tailSamples = Math.round((song.loop ? 3.2 : 2.6) * SR);
const totalSamples = musicSamples + tailSamples;
let sumSqAll = 0;
let peakAll = 0;

for (const bus of ['pad', 'arp', 'mel', 'bass', 'drum']) {
  const evs = song.events.filter((e) => e.bus === bus);
  const L = new Float32Array(totalSamples);
  const R = new Float32Array(totalSamples);
  renderEventsInto(evs, L, R, SR, spb);
  let peak = 0, sq = 0;
  for (let i = 0; i < totalSamples; i++) {
    const p = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    if (p > peak) peak = p;
    sq += (L[i] * L[i] + R[i] * R[i]) / 2;
  }
  const rms = Math.sqrt(sq / totalSamples);
  console.log(`bus ${bus.padEnd(5)} events=${evs.length} peak=${peak.toFixed(4)} rms=${rms.toFixed(5)}`);
  sumSqAll += sq;
  peakAll = Math.max(peakAll, peak);
}
console.log(`SANS FX  peak=${peakAll.toFixed(4)} rms=${Math.sqrt(sumSqAll / totalSamples).toFixed(5)}`);
