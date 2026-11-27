'use strict';

const { ui } = require('./language');

const fs = require('node:fs');
const path = require('node:path');
const { renderSong, writeWav } = require('./dsp');
const { musicClock } = require('./music-clock');

function planAdaptiveMusic(song, options, format) {
  if (options === undefined) return;
  if (format === 'midi') throw new Error(ui('adaptive nécessite format wav ou both.', 'adaptive requires format wav or both.'));
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some((key) => !['loop_region', 'crossfade_ms'].includes(key))) {
    throw new Error(ui('adaptive attend loop_region et éventuellement crossfade_ms.', 'adaptive requires loop_region and optionally crossfade_ms.'));
  }
  const { start_bar: first, bars } = options.loop_region ?? {};
  if (!Number.isInteger(first) || first < 2 || !Number.isInteger(bars) || bars < 1 || first + bars > song.bars) {
    throw new Error(ui(
      'Garde au moins une mesure avant et après adaptive.loop_region pour l’introduction et la sortie.',
      'Leave at least one bar before and after adaptive.loop_region for the intro and outro.',
    ));
  }
  const crossfade = options.crossfade_ms ?? 25;
  if (!Number.isFinite(crossfade) || crossfade < 5 || crossfade > 100) throw new Error(ui('adaptive.crossfade_ms attend 5 à 100 ms.', 'adaptive.crossfade_ms must be between 5 and 100 ms.'));
  const clock = musicClock(song);
  return {
    start_bar: first, bars,
    start: Math.round(clock.at((first - 1) * 4) * song.sr),
    end: Math.round(clock.at((first - 1 + bars) * 4) * song.sr),
    fade: Math.round(crossfade * song.sr / 1000),
  };
}

function bridgeChannel(channel, start, end, frames) {
  const outro = channel.slice(end);
  const loop = channel.slice(start, end);
  // La fin de boucle rejoint le signal juste avant son départ. La sortie reprend ce même raccord.
  for (let i = 0; i < frames; i++) {
    const weight = 0.5 - 0.5 * Math.cos(Math.PI * i / (frames - 1));
    const tail = loop.length - frames + i;
    loop[tail] = loop[tail] * (1 - weight) + channel[start - frames + i] * weight;
    outro[i] = channel[start + i] * (1 - weight) + outro[i] * weight;
  }
  return { intro: channel.subarray(0, start), loop, outro };
}

function exportAdaptiveMusic(song, plan, outputDir, base, bits, master) {
  const audio = !song.loop && master ? master
    : renderSong({ ...song, loop: false, targetSeconds: undefined, endFade: song.endFade || 0.65 });
  const { start, end } = plan;
  const frames = Math.min(plan.fade, start, Math.floor((end - start) / 2), audio.samples - end);
  const left = bridgeChannel(audio.L, start, end, frames);
  const right = song.mono ? left : bridgeChannel(audio.R, start, end, frames);
  const files = [], segments = {};
  let offset = 0;
  for (const name of ['intro', 'loop', 'outro']) {
    const file = `${base}-${name}.wav`;
    const fullPath = path.join(outputDir, file);
    const wav = writeWav(fullPath, left[name], right[name], song.sr, song.mono, bits);
    segments[name] = { file, start_sample: offset, end_sample_exclusive: offset + wav.samples, frames: wav.samples };
    offset += wav.samples;
    files.push({ path: fullPath, format: 'wav', segment: name, ...wav });
  }
  const manifest = {
    type: 'soundmcp-adaptive', version: 1, sample_rate: song.sr, channels: song.mono ? 1 : 2,
    bit_depth: bits, total_frames: offset, crossfade_frames: frames,
    loop_region: { start_bar: plan.start_bar, bars: plan.bars, start_sample: start, end_sample_exclusive: end },
    segments,
  };
  const manifest_path = path.join(outputDir, `${base}-adaptive.json`);
  const data = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(manifest_path, data);
  files.push({ path: manifest_path, format: 'json', bytes: Buffer.byteLength(data) });
  return { files, manifest: { ...manifest, manifest_path } };
}

module.exports = { planAdaptiveMusic, exportAdaptiveMusic };
