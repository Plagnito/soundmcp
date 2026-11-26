'use strict';

const fs = require('node:fs');
const { musicClock } = require('./music-clock');
const { reportOverlaps } = require('./score-diagnostics');

function biquad(b0, b1, b2, a1, a2) {
  let s1 = 0, s2 = 0;
  return (sample) => {
    const out = sample * b0 + s1;
    s1 = sample * b1 + s2 - out * a1;
    s2 = sample * b2 - out * a2;
    return out;
  };
}

// Pondération K à fréquence variable, puis portes de niveau selon BS.1770.
function kWeight(rate) {
  const h = Math.tan(Math.PI * 1681.974450955533 / rate);
  const l = Math.tan(Math.PI * 38.13547087602444 / rate);
  const boost = 10 ** (3.999843853973347 / 20);
  const middle = boost ** 0.4996667741545416;
  const hs = h / 0.7071752369554196;
  const ls = l / 0.5003270373238773;
  const h2 = h * h, l2 = l * l;
  const hd = 1 + hs + h2, ld = 1 + ls + l2;
  const shelf = biquad((boost + middle * hs + h2) / hd, 2 * (h2 - boost) / hd,
    (boost - middle * hs + h2) / hd, 2 * (h2 - 1) / hd, (1 - hs + h2) / hd);
  const highpass = biquad(1, -2, 1, 2 * (l2 - 1) / ld, (1 - ls + l2) / ld);
  return (sample) => highpass(shelf(sample));
}

const rounded = (value, digits = 2) => Number(value.toFixed(digits));
const db = (amplitude) => amplitude > 0 ? rounded(20 * Math.log10(amplitude)) : null;

function measure(audio) {
  const { L, R, sr, mono } = audio;
  const n = mono ? L.length : Math.min(L.length, R.length);
  const left = kWeight(sr), right = kWeight(sr);
  const hop = Math.round(sr / 10);
  const windows = [];
  const parts = new Float64Array(4);
  let eL = 0, eR = 0, cross = 0, peak = 0, clipped = 0, invalid = 0;
  let block = 0, h = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    const a = Number.isFinite(L[i]) ? L[i] : 0;
    const b = mono ? a : Number.isFinite(R[i]) ? R[i] : 0;
    if (!Number.isFinite(L[i]) || (!mono && !Number.isFinite(R[i]))) invalid++;
    const max = Math.max(Math.abs(a), Math.abs(b));
    peak = Math.max(peak, max);
    if (max >= 0.9999) clipped++;
    eL += a * a;
    eR += b * b;
    cross += a * b;
    const ka = left(a), kb = mono ? 0 : right(b);
    block += ka * ka + kb * kb;
    if ((i + 1) % hop === 0) {
      const index = h % 4;
      sum += block - parts[index];
      parts[index] = block;
      block = 0;
      if (++h >= 4) windows.push(sum / (4 * hop));
    }
  }
  const absolute = 10 ** ((-70 + 0.691) / 10);
  const gated = windows.filter((value) => value >= absolute);
  const mean = (items) => items.reduce((a, b) => a + b, 0) / items.length;
  const relativeGate = mean(gated) * 0.1;
  const energy = mean(gated.filter((value) => value >= relativeGate));
  const rms = Math.sqrt((eL + eR) / (2 * Math.max(1, n)));
  return { samples: n, sampleRate: sr, channels: mono ? 1 : 2, durationSeconds: rounded(n / sr, 3),
    integratedLufs: energy > 0 ? rounded(-0.691 + 10 * Math.log10(energy)) : null,
    samplePeakDbfs: db(peak), rmsDbfs: db(rms), crestDb: rms > 0 ? db(peak / rms) : null,
    stereoCorrelation: eL > 0 && eR > 0 ? rounded(cross / Math.sqrt(eL * eR), 3) : null,
    clippedFrames: clipped, invalidFrames: invalid };
}

function diagnose(stats) {
  const warnings = [];
  if (stats.invalidFrames) warnings.push('Échantillons non numériques.');
  if (stats.clippedFrames) warnings.push('Crêtes numériques à saturation.');
  if (stats.integratedLufs === null || stats.integratedLufs < -32) warnings.push('Signal silencieux ou très faible.');
  if (stats.channels === 2 && stats.stereoCorrelation !== null && stats.stereoCorrelation < 0.15) warnings.push('Écarts de phase à vérifier en mono.');
  if (stats.crestDb !== null && stats.crestDb > 22) warnings.push('Crêtes très hautes par rapport au niveau moyen.');
  return warnings;
}

function scoreMetrics(song, audio, stems = {}) {
  const clock = musicClock(song);
  const instruments = [...new Set(song.events.map((e) => e.drum ? 'drum' : e.inst))];
  const sections = song.meta.sections.map((section) => {
    const start = (section.startBar - 1) * 4, end = start + section.bars * 4;
    const events = song.events.filter((e) => (e.beat ?? e.t) >= start && (e.beat ?? e.t) < end);
    const from = Math.round(clock.at(start) * audio.sr), to = Math.round(clock.at(end) * audio.sr);
    return { name: section.name, startBar: section.startBar, bars: section.bars, seconds: rounded(clock.at(start), 3),
      eventCount: events.length, perPart: Object.fromEntries(section.parts.map((part) => [part, events.filter((e) => e.bus === part).length])),
      instruments: [...new Set(events.map((e) => e.drum ? 'drum' : e.inst))], ...(section.color ? { color: section.color } : {}),
      rmsDbfs: localRms(audio.L, audio.R, from, to) };
  });
  const melody = Array.from({ length: song.bars }, () => []);
  for (const event of song.events.filter((e) => e.bus === 'mel')) {
    const beat = event.beat ?? event.t;
    if (beat >= 0 && beat < song.totalBeats) melody[Math.floor(beat / 4)].push([event.midi, Math.round((beat % 4) * 4)]);
  }
  const phrases = melody.filter((bar) => bar.length).map((bar) => {
    bar.sort((a, b) => a[1] - b[1]);
    return bar.map(([midi, t]) => `${midi - bar[0][0]}@${t}`).join(',');
  });
  const counts = new Map();
  for (const phrase of phrases) counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
  const repetition = phrases.length ? Math.max(...counts.values()) / phrases.length : 0;
  const stats = measure(audio);
  const warnings = diagnose(stats);
  const harmonicOverlaps = reportOverlaps(song, clock);
  if (harmonicOverlaps.total) {
    const measures = harmonicOverlaps.bars.slice(0, 3).map(({ bar }) => bar);
    warnings.push(`Chevauchements prolongés entre mélodie et accompagnement à écouter, notamment aux mesures ${measures.join(', ')}.`);
  }
  const audible = sections.filter(({ rmsDbfs }) => rmsDbfs !== null).sort((a, b) => a.rmsDbfs - b.rmsDbfs);
  const marker = ({ name, startBar, seconds, rmsDbfs }) => ({ name, startBar, seconds, rmsDbfs });
  const formDynamics = audible.length ? { quietest: marker(audible[0]), loudest: marker(audible.at(-1)),
    rmsDifferenceDb: rounded(audible.at(-1).rmsDbfs - audible[0].rmsDbfs, 1) } : undefined;
  const suggestedEdits = [];
  if (phrases.length >= 7 && repetition > 0.7) {
    warnings.push('Plus de 70 % des mesures mélodiques reprennent le même rythme et contour.');
    const index = sections.findIndex((section) => section.name === 'Reprise' && section.perPart.mel > 0);
    if (index >= 0) suggestedEdits.push({ type: 'replace_section', section: index + 1, replacement: { variation: 2 } });
  }
  if (stems.mel?.rmsDbfs != null && stems.drum?.rmsDbfs != null && stems.mel.rmsDbfs < stems.drum.rmsDbfs - 11) {
    warnings.push('La batterie domine le niveau moyen de la mélodie.');
    const index = sections.findIndex((section) => section.perPart.mel > 0 && section.perPart.drum > 0);
    if (index >= 0) suggestedEdits.push({ type: 'gain', section: index + 1, part: 'drum', db: -5 });
  }
  const brief = song.meta.brief;
  const missing = brief ? brief.instruments.filter((inst) => !instruments.includes(inst)) : [];
  if (missing.length) warnings.push(`Instruments demandés absents : ${missing.join(', ')}.`);
  return { ...stats, instruments, sections, stems, repetitionRatio: rounded(repetition, 3), harmonicOverlaps,
    ...(formDynamics ? { formDynamics } : {}), warnings, suggestedEdits,
    history: song.history ?? [], ...(brief ? { briefCheck: { requestedSeconds: brief.duration, actualSeconds: stats.durationSeconds,
      durationErrorSeconds: rounded(stats.durationSeconds - brief.duration, 3), missingInstruments: missing,
      excludedInstrumentsPresent: brief.excluded.filter((inst) => instruments.includes(inst)), instrumental: true } } : {}) };
}

function localRms(L, R, from = 0, to = L.length) {
  let power = 0;
  const end = Math.min(to, L.length);
  for (let i = from; i < end; i++) power += (L[i] ** 2 + R[i] ** 2) / 2;
  return db(Math.sqrt(power / Math.max(1, end - from)));
}

function matchLevels(audio, target = -17, references) {
  const before = audio.map(measure);
  const anchors = references ? references.map(measure) : before;
  const gains = anchors.map((m) => m.integratedLufs === null ? 0 : target - m.integratedLufs);
  const headroom = Math.min(0, ...before.map((m, i) => m.samplePeakDbfs === null ? 0 : -2.5 - m.samplePeakDbfs - gains[i]));
  return audio.map((file, i) => {
    const gainDb = gains[i] + headroom;
    const gain = 10 ** (gainDb / 20);
    for (let n = 0; n < file.L.length; n++) {
      file.L[n] *= gain;
      if (file.R !== file.L) file.R[n] *= gain;
    }
    return { gainDb: rounded(gainDb), ...measure(file) };
  });
}

function readWave(file) {
  if (fs.statSync(file).size > 480 * 1024 * 1024) throw new Error('WAV trop volumineux.');
  const buffer = fs.readFileSync(file);
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Fichier WAV RIFF attendu.');
  let format, data;
  for (let i = 12; i + 8 <= buffer.length;) {
    const id = buffer.toString('ascii', i, i + 4), size = buffer.readUInt32LE(i + 4);
    const offset = i + 8;
    if (offset + size > buffer.length) throw new Error('WAV tronqué.');
    if (id === 'fmt ' && size >= 16) {
      const tag = buffer.readUInt16LE(offset);
      format = { type: tag === 0xfffe && size >= 40 ? buffer.readUInt16LE(offset + 24) : tag,
        channels: buffer.readUInt16LE(offset + 2), sr: buffer.readUInt32LE(offset + 4), bits: buffer.readUInt16LE(offset + 14) };
    }
    if (id === 'data') data = { size, offset };
    i = offset + size + size % 2;
  }
  if (!format || !data || ![1, 2].includes(format.channels) || format.sr < 8000 || format.sr > 96000 ||
      !(format.type === 3 && format.bits === 32 || format.type === 1 && [16, 24, 32].includes(format.bits))) {
    throw new Error('Utilise un WAV mono ou stéréo PCM 16/24/32 bits, ou flottant 32 bits.');
  }
  const { channels, sr, bits, type } = format;
  const width = bits / 8, stride = width * channels;
  const n = Math.floor(data.size / stride);
  if (!n || n / sr > 603) throw new Error('Durée du WAV hors plage.');
  const L = new Float32Array(n), R = channels === 2 ? new Float32Array(n) : L;
  const read = type === 3 ? (pos) => buffer.readFloatLE(pos) : (pos) => buffer.readIntLE(pos, width) / (2 ** (bits - 1));
  for (let i = 0, pos = data.offset; i < n; i++, pos += stride) {
    L[i] = read(pos);
    if (channels === 2) R[i] = read(pos + width);
  }
  return { L, R, sr, mono: channels === 1 };
}

module.exports = { measure, diagnose, scoreMetrics, localRms, matchLevels, readWave };
