'use strict';

/**
 * Test de fumée SoundMCP : rends courts + vérifications WAV/MIDI.
 *   node scripts/smoke.js   (ou npm test)
 * Sort en 0 si tout passe, 1 sinon.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createSong } = require('../src/composer');
const { renderSong, writeWav, readWavInfo } = require('../src/dsp');
const { writeMidi } = require('../src/midi');
const { createSfx } = require('../src/sfx');

const TMP = path.join(process.env.TEMP || os.tmpdir(), 'soundmcp-smoke');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${label}`);
  if (!ok) failures.push(label);
};

/** Décode le chunk data d'un WAV 16 bits stéréo → { L, R } Float64Array. */
function decodeWav(file) {
  const buf = fs.readFileSync(file);
  // trouve le chunk 'data' (robuste à un en-tête étendu)
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'data') break;
    pos += 8 + size + (size % 2);
  }
  const dataStart = pos + 8;
  const dataEnd = Math.min(buf.length, dataStart + buf.readUInt32LE(pos + 4));
  const n = Math.floor((dataEnd - dataStart) / 4);
  const L = new Float64Array(n);
  const R = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = buf.readInt16LE(dataStart + i * 4) / 32768;
    R[i] = buf.readInt16LE(dataStart + i * 4 + 2) / 32768;
  }
  return { L, R, n, chunks: { dataStart, dataEnd, dataSize: buf.readUInt32LE(pos + 4) } };
}

function audioStats(audio, label) {
  let sumSq = 0;
  let peak = 0;
  let nan = false;
  for (let i = 0; i < audio.n; i++) {
    const l = audio.L[i];
    const r = audio.R[i];
    if (!Number.isFinite(l) || !Number.isFinite(r)) { nan = true; break; }
    const p = Math.max(Math.abs(l), Math.abs(r));
    if (p > peak) peak = p;
    sumSq += (l * l + r * r) / 2;
  }
  const rms = audio.n ? Math.sqrt(sumSq / audio.n) : 0;
  check(!nan, `${label} : pas de NaN/Inf`);
  check(rms > 0.01, `${label} : RMS ${rms.toFixed(4)} > 0.01`);
  check(peak <= 1.0 && peak > 0.1, `${label} : crête ${peak.toFixed(3)} dans (0.1, 1.0]`);
  return { rms, peak };
}

function checkWavHeader(file, label, expectSamples) {
  const info = readWavInfo(file);
  check(info.riff === 'RIFF', `${label} : signature RIFF`);
  check(info.channels === 2, `${label} : stéréo`);
  check(info.sr === 44100, `${label} : 44100 Hz`);
  check(info.bits === 16, `${label} : 16 bits`);
  check(info.dataSize === info.bytes - 44, `${label} : tailles cohérentes (${info.dataSize} + 44 = ${info.bytes})`);
  if (expectSamples !== undefined) {
    const samples = Math.round(info.dataSize / 4);
    check(samples === expectSamples, `${label} : ${samples} échantillons (attendu ${expectSamples})`);
    const dur = samples / info.sr;
    const expectedDur = expectSamples / info.sr;
    check(Math.abs(dur - expectedDur) < 0.01, `${label} : durée ${dur.toFixed(3)} s ≈ ${expectedDur.toFixed(3)} s`);
  }
  return info;
}

/* ---------------------------------- morceaux ---------------------------------- */

console.log('— Rendu lofi (boucle 12 s, seed 42) —');
const songLoop = createSong({ style: 'lofi', duration_seconds: 12, seed: 42, loop: true, tempo: 80 });
const audioLoop = renderSong(songLoop);
const loopWav = path.join(TMP, 'lofi-loop.wav');
writeWav(loopWav, audioLoop.L, audioLoop.R, audioLoop.sr);
// boucle exacte : samples == totalBeats * spb * sr
const expectedLoopSamples = Math.round(songLoop.totalBeats * (60 / songLoop.bpm) * 44100);
checkWavHeader(loopWav, 'lofi loop', expectedLoopSamples);
audioStats(decodeWav(loopWav), 'lofi loop');

console.log('— Rendu fantasy (non boucle 10 s, seed 7) —');
const songEnd = createSong({ style: 'fantasy', duration_seconds: 10, seed: 7, loop: false, tempo: 92 });
const audioEnd = renderSong(songEnd);
const endWav = path.join(TMP, 'fantasy-end.wav');
writeWav(endWav, audioEnd.L, audioEnd.R, audioEnd.sr);
checkWavHeader(endWav, 'fantasy end', audioEnd.samples);
audioStats(decodeWav(endWav), 'fantasy end');

console.log('— Rendu chiptune (8 s, seed 1) + MIDI —');
const songChip = createSong({ style: 'chiptune', duration_seconds: 8, seed: 1, tempo: 120 });
const audioChip = renderSong(songChip);
const chipWav = path.join(TMP, 'chiptune.wav');
writeWav(chipWav, audioChip.L, audioChip.R, audioChip.sr);
checkWavHeader(chipWav, 'chiptune', audioChip.samples);
audioStats(decodeWav(chipWav), 'chiptune');

const midiPath = path.join(TMP, 'chiptune.mid');
const midiRes = writeMidi(midiPath, songChip, 'test');
const midiBuf = fs.readFileSync(midiPath);
check(midiRes.bytes === midiBuf.length && midiBuf.length > 200, `MIDI écrit (${midiBuf.length} octets)`);
check(midiBuf.toString('ascii', 0, 4) === 'MThd', 'MIDI : signature MThd');
check(midiBuf.readUInt16BE(8) === 1, 'MIDI : format 1');
check(midiBuf.readUInt16BE(10) >= 2, `MIDI : ${midiBuf.readUInt16BE(10)} pistes (>= 2)`);
check(midiBuf.readUInt16BE(12) === 480, 'MIDI : PPQ 480');

console.log('— Déterminisme (même seed → WAV identique) —');
const songA = createSong({ style: 'upbeat', duration_seconds: 8, seed: 999, tempo: 128 });
const wavA = path.join(TMP, 'upbeat-a.wav');
const wavB = path.join(TMP, 'upbeat-b.wav');
{
  const a = renderSong(songA);
  writeWav(wavA, a.L, a.R, a.sr);
  const songB = createSong({ style: 'upbeat', duration_seconds: 8, seed: 999, tempo: 128 });
  const b = renderSong(songB);
  writeWav(wavB, b.L, b.R, b.sr);
  const bufA = fs.readFileSync(wavA);
  const bufB = fs.readFileSync(wavB);
  check(bufA.equals(bufB), 'WAV identiques pour le même seed');
}
audioStats(decodeWav(wavA), 'upbeat');

console.log('— SFX (jump, coin, explosion) —');
for (const kind of ['jump', 'coin', 'explosion']) {
  const sfx = createSfx(kind, { seed: 5, outputDir: TMP });
  const info = checkWavHeader(sfx.path, `sfx ${kind}`);
  check(sfx.bytes > 800 && sfx.bytes === info.bytes, `sfx ${kind} : ${info.bytes} octets`);
  const dec = decodeWav(sfx.path);
  audioStats(dec, `sfx ${kind}`);
  check(sfx.durationSeconds > 0.05 && sfx.durationSeconds < 4, `sfx ${kind} : durée ${sfx.durationSeconds} s`);
}

console.log('— Diversité (2 seeds différents → WAV différents) —');
{
  const s1 = createSong({ style: 'menu', duration_seconds: 6, seed: 1 });
  const s2 = createSong({ style: 'menu', duration_seconds: 6, seed: 2 });
  const a1 = path.join(TMP, 'menu1.wav');
  const a2 = path.join(TMP, 'menu2.wav');
  const r1 = renderSong(s1);
  const r2 = renderSong(s2);
  writeWav(a1, r1.L, r1.R, r1.sr);
  writeWav(a2, r2.L, r2.R, r2.sr);
  check(!fs.readFileSync(a1).equals(fs.readFileSync(a2)), 'seeds différents → fichiers différents');
}

/* ---------------------------------- bilan ---------------------------------- */

console.log('');
if (failures.length === 0) {
  console.log('✅ TOUT PASSE');
  process.exit(0);
} else {
  console.log(`❌ ${failures.length} échec(s) :`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
