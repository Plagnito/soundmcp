'use strict';

const { wavBuffer } = require('./dsp');
const { matchLevels, readWave } = require('./music-analysis');
const { ui } = require('./language');

const SAMPLE_RATE = 22050;
const SECONDS = 8;
const TOOLS = new Set(['draft_music', 'preview_music', 'compare_music_choices']);

function audition(file, arrival = 0) {
  const { L, R, sr } = readWave(file);
  const duration = L.length / sr;
  const start = Math.round(Math.min(Math.max(0, arrival - SECONDS / 2), Math.max(0, duration - SECONDS)) * sr);
  const step = sr / SAMPLE_RATE;
  const samples = Math.min(SECONDS * SAMPLE_RATE, Math.floor((L.length - start) / step));
  const mono = new Float32Array(samples);
  const fadeIn = Math.round(0.008 * SAMPLE_RATE), fadeOut = Math.round(0.035 * SAMPLE_RATE);
  for (let i = 0; i < samples; i++) {
    const from = start + i * step, to = Math.min(L.length, from + step);
    let sum = 0;
    for (let j = Math.floor(from); j < to; j++) {
      sum += (L[j] + R[j]) * (Math.min(to, j + 1) - Math.max(from, j));
    }
    const fade = Math.min(1, i / fadeIn, (samples - 1 - i) / fadeOut);
    mono[i] = sum * fade / (2 * (to - from));
  }
  return { L: mono, R: mono, sr: SAMPLE_RATE, mono: true };
}

function appendInlineAudio(name, result) {
  const data = result.structuredContent;
  const takes = name === 'draft_music'
    ? data.candidates.map((candidate) => ({ file: candidate.preview_path, label: `${ui('Prise', 'Take')} ${candidate.id}` }))
    : data.files.map(({ path: file, label, join_seconds }) => ({ file, label, join_seconds }));
  const clips = takes.map(({ file, join_seconds }) => audition(file, join_seconds ?? data.region?.arrivalSeconds));
  matchLevels(clips);
  for (const [i, clip] of clips.entries()) {
    const annotations = { audience: ['user'] };
    result.content.push(
      { type: 'text', text: `${takes[i].label} · ${ui('extrait audio mono', 'mono audio excerpt')}`, annotations },
      { type: 'audio', mimeType: 'audio/wav', data: wavBuffer(clip.L, clip.R, clip.sr, clip.mono).toString('base64'), annotations },
    );
  }
}

module.exports = { appendInlineAudio, INLINE_AUDIO_TOOLS: TOOLS };
