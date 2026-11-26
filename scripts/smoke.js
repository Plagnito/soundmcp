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
const { createSfx, SFX_IDS } = require('../src/sfx');
const { createAmbience, AMBIENCE_IDS, AMBIENCE_KINDS } = require('../src/ambience');
const { STYLES, STYLE_IDS } = require('../src/styles');
const { listStylesText } = require('../src/tools');

const TMP = path.join(process.env.TEMP || os.tmpdir(), 'soundmcp-smoke');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${label}`);
  if (!ok) failures.push(label);
};

/** Décode le chunk data d'un WAV PCM 16 bits (stéréo ou mono) → { L, R } Float64Array. */
function decodeWav(file) {
  const buf = fs.readFileSync(file);
  const channels = buf.readUInt16LE(22) || 2;
  const blockAlign = channels * 2;
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
  const n = Math.floor((dataEnd - dataStart) / blockAlign);
  const L = new Float64Array(n);
  const R = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = buf.readInt16LE(dataStart + i * blockAlign) / 32768;
    R[i] = channels === 2 ? buf.readInt16LE(dataStart + i * blockAlign + 2) / 32768 : L[i];
  }
  return { L, R, n, channels, chunks: { dataStart, dataEnd, dataSize: buf.readUInt32LE(pos + 4) } };
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

function checkWavHeader(file, label, expectSamples, expectSr = 44100, expectChannels = 2) {
  const info = readWavInfo(file);
  check(info.riff === 'RIFF', `${label} : signature RIFF`);
  check(info.channels === expectChannels, `${label} : ${expectChannels} canal${expectChannels > 1 ? 'x' : ''} (lu ${info.channels})`);
  check(info.sr === expectSr, `${label} : ${expectSr} Hz`);
  check(info.bits === 16, `${label} : 16 bits`);
  check(info.dataSize === info.bytes - 44, `${label} : tailles cohérentes (${info.dataSize} + 44 = ${info.bytes})`);
  if (expectSamples !== undefined) {
    const samples = Math.round(info.dataSize / (info.channels * 2));
    check(samples === expectSamples, `${label} : ${samples} échantillons (attendu ${expectSamples})`);
    const dur = samples / info.sr;
    const expectedDur = expectSamples / info.sr;
    check(Math.abs(dur - expectedDur) < 0.01, `${label} : durée ${dur.toFixed(3)} s ≈ ${expectedDur.toFixed(3)} s`);
  }
  return info;
}

/**
 * Continuité de boucle : l'écart à la couture (dernier → premier échantillon)
 * doit être dans la gamme des écarts voisins normaux du signal.
 * (crossfade circulaire = les deux côtés de la couture sont des échantillons
 * consécutifs du flux continu rendu)
 */
function checkLoopSeam(file, label) {
  const dec = decodeWav(file);
  const n = dec.n;
  const diffs = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) diffs[i] = Math.abs(dec.L[i + 1] - dec.L[i]);
  const sorted = Float64Array.from(diffs).sort();
  const p999 = sorted[Math.min(n - 2, Math.floor(n * 0.999))] || 0;
  const seam = Math.abs(dec.L[0] - dec.L[n - 1]);
  check(seam <= Math.max(p999 * 2, 1e-4), `${label} : raccord de boucle fluide (écart couture ${seam.toFixed(4)} ≤ p99.9 ${p999.toFixed(4)} × 2)`);
  return { seam, p999 };
}

/** Vérifie qu'un WAV est mono (1 canal dans l'en-tête, taille moitié en 16 bits). */
function checkMono(file, label) {
  const info = readWavInfo(file);
  check(info.channels === 1, `${label} : en-tête mono (1 canal, lu ${info.channels})`);
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

console.log('— Rendus des 4 nouveaux styles (suspense, victory, village, combat) —');
const newStyles = [
  { style: 'suspense', dur: 10, seed: 11 },
  { style: 'victory', dur: 10, seed: 12 },
  { style: 'village', dur: 10, seed: 13 },
  { style: 'combat', dur: 10, seed: 14 },
];
for (const { style, dur, seed } of newStyles) {
  const song = createSong({ style, duration_seconds: dur, seed });
  const audio = renderSong(song);
  const wav = path.join(TMP, `${style}.wav`);
  writeWav(wav, audio.L, audio.R, audio.sr);
  checkWavHeader(wav, style, audio.samples);
  audioStats(decodeWav(wav), style);
}

console.log(`— SFX (${SFX_IDS.length} kinds, tous rendus) —`);
for (const kind of SFX_IDS) {
  const sfx = createSfx(kind, { seed: 5, outputDir: TMP });
  const info = checkWavHeader(sfx.path, `sfx ${kind}`);
  check(sfx.bytes > 800 && sfx.bytes === info.bytes, `sfx ${kind} : ${info.bytes} octets`);
  const dec = decodeWav(sfx.path);
  audioStats(dec, `sfx ${kind}`);
  check(sfx.durationSeconds > 0.05 && sfx.durationSeconds < 4, `sfx ${kind} : durée ${sfx.durationSeconds} s`);
}

console.log('— 5 nouveaux styles (rock, jazz, horror, hiphop, space) —');
const v12Styles = [
  { style: 'rock', dur: 10, seed: 21 },
  { style: 'jazz', dur: 10, seed: 22 },
  { style: 'horror', dur: 10, seed: 23 },
  { style: 'hiphop', dur: 10, seed: 24 },
  { style: 'space', dur: 10, seed: 25 },
];
for (const { style, dur, seed } of v12Styles) {
  const song = createSong({ style, duration_seconds: dur, seed });
  const audio = renderSong(song);
  const wav = path.join(TMP, `${style}.wav`);
  writeWav(wav, audio.L, audio.R, audio.sr);
  checkWavHeader(wav, style, audio.samples);
  audioStats(decodeWav(wav), style);
}

console.log(`— Inventaire complet : ${STYLE_IDS.length} styles, ${SFX_IDS.length} SFX, ${AMBIENCE_IDS.length} ambiances —`);
check(STYLE_IDS.length === 19, `${STYLE_IDS.length} styles (attendu 19)`);
check(SFX_IDS.length === 32, `${SFX_IDS.length} SFX (attendu 32)`);
check(AMBIENCE_IDS.length === 11, `${AMBIENCE_IDS.length} ambiances (attendu 11)`);

console.log('— Options techniques (sampling_rate + mono) sur create_music —');
{
  const song = createSong({ style: 'ambient', duration_seconds: 6, seed: 31, sr: 22050, mono: true });
  check(song.sr === 22050, `createSong : sr passé dans song (${song.sr})`);
  check(song.mono === true, 'createSong : mono passé dans song');
  const audio = renderSong(song);
  const wav = path.join(TMP, 'ambient-sr-mono.wav');
  writeWav(wav, audio.L, audio.R, audio.sr, !!audio.mono);
  checkWavHeader(wav, 'music sr 22050', audio.samples, 22050, 1);
  checkMono(wav, 'music mono');
  // sr invalide → rejeté côté composer (retombe sur 44100) et rejeté côté tools (erreur)
  const songBad = createSong({ style: 'ambient', duration_seconds: 4, seed: 31, sr: 12345 });
  check(songBad.sr === 44100, 'createSong : sr invalide retombe sur 44100');
}

console.log(`— Ambiances (${AMBIENCE_IDS.length} kinds, tous rendus en boucle 8 s) —`);
for (const kind of AMBIENCE_IDS) {
  const amb = createAmbience(kind, { seed: 17, durationSec: 8, outputDir: TMP });
  check(amb.loop === true, `ambience ${kind} : marquée boucle`);
  check(AMBIENCE_KINDS[kind].desc === amb.desc, `ambience ${kind} : description cohérente`);
  const samples = Math.round(8 * 44100);
  checkWavHeader(amb.path, `ambience ${kind}`, samples);
  audioStats(decodeWav(amb.path), `ambience ${kind}`);
  checkLoopSeam(amb.path, `ambience ${kind}`);
  check(amb.durationSeconds === 8, `ambience ${kind} : durée ${amb.durationSeconds} s`);
}

console.log('— Ambiance : déterminisme + tailles sr/mono —');
{
  const a1 = createAmbience('ocean', { seed: 42, durationSec: 6, outputDir: TMP });
  const a2 = createAmbience('ocean', { seed: 42, durationSec: 6, outputDir: TMP });
  check(fs.readFileSync(a1.path).equals(fs.readFileSync(a2.path)), 'ambiance : WAV identiques pour le même seed');
  const light = createAmbience('rain', { seed: 8, durationSec: 6, sr: 22050, mono: true, outputDir: TMP });
  checkWavHeader(light.path, 'ambience sr 22050 mono', Math.round(6 * 22050), 22050, 1);
  checkMono(light.path, 'ambience mono');
  check(light.bytes < a1.bytes / 3, `ambience sr/mono : ${light.bytes} octets < 1/3 du rendu 44.1 kHz stéréo`);
  // graine différente → fichier différent
  const a3 = createAmbience('ocean', { seed: 43, durationSec: 6, outputDir: TMP });
  check(!fs.readFileSync(a1.path).equals(fs.readFileSync(a3.path)), 'ambiance : seeds différents → fichiers différents');
}

console.log('— Graine zéro sur les effets et les ambiances —');
for (const render of [() => createSfx('coin', { seed: 0, outputDir: TMP }),
  () => createAmbience('wind', { seed: 0, durationSec: 5, sr: 22050, outputDir: TMP })]) {
  const first = render();
  const bytes = fs.readFileSync(first.path);
  const second = render();
  check(first.seed === 0 && second.seed === 0 && bytes.equals(fs.readFileSync(second.path)), `${first.kind} : seed 0 conservée et WAV identiques`);
}

console.log('— list_styles : sections complètes —');
{
  const text = listStylesText();
  for (const id of [...STYLE_IDS.slice(0, 5), ...STYLE_IDS.slice(-5)]) {
    check(text.includes(`**${id}**`), `list_styles contient le style « ${id} »`);
  }
  check(text.includes('## Ambiances disponibles (create_ambience)'), 'list_styles : section ambiances présente');
  for (const id of AMBIENCE_IDS) check(text.includes(`**${id}**`), `list_styles contient l'ambiance « ${id} »`);
  for (const id of ['magic', 'teleport', 'bowShoot', 'gunShoot', 'thunder', 'questComplete', 'menuOpen', 'chestOpen', 'ghost', 'forge']) {
    check(text.includes(`**${id}**`), `list_styles contient le SFX « ${id} »`);
  }
  check(text.includes('create_ambience produit toujours une boucle parfaite'), 'list_styles : astuce boucle parfaite présente');
  check(text.includes('sampling_rate 22050'), 'list_styles : astuce sampling_rate présente');
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
