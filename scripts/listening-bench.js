'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { callTool } = require('../src/tools');
const { diagnose, matchLevels, measure, readWave } = require('../src/music-analysis');
const { writeWav } = require('../src/dsp');
const { hash32, randomSeed } = require('../src/rng');
const { version } = require('../package.json');
const cases = require('./listening-cases.json');

const TYPE = 'soundmcp-listening-bench';

function argumentsFrom(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!['--output', '--against'].includes(key) || !value || value.startsWith('--') || options[key]) {
      throw new Error('Usage : npm run bench -- [--output dossier] [--against manifeste.json]');
    }
    options[key] = path.resolve(value);
  }
  return options;
}

function saveJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function engineDigest() {
  const src = path.join(__dirname, '..', 'src');
  const hash = createHash('sha256');
  for (const file of fs.readdirSync(src).filter((name) => name.endsWith('.js')).sort()) {
    hash.update(file).update('\0').update(fs.readFileSync(path.join(src, file))).update('\0');
  }
  return hash.digest('hex');
}

function readBaseline(file) {
  if (!file) return;
  const baseline = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (baseline.type !== TYPE || baseline.version !== 1 || !Array.isArray(baseline.entries) || baseline.entries.length !== cases.length) {
    throw new Error('Manifeste de référence SoundMCP v1 attendu.');
  }
  for (const [i, item] of cases.entries()) {
    const entry = baseline.entries[i];
    assert.deepEqual(entry?.case, item, `Le brief ou les réglages diffèrent de la référence pour ${item.id}.`);
    if (entry.file !== `audio/${item.id}.wav`) throw new Error(`Chemin de référence invalide pour ${item.id}.`);
  }
  return { directory: path.dirname(file), data: baseline };
}

function stats(audio, loop) {
  const analysis = measure(audio);
  const result = {
    durationSeconds: analysis.durationSeconds,
    integratedLufs: analysis.integratedLufs,
    samplePeakDbfs: analysis.samplePeakDbfs,
    clippedFrames: analysis.clippedFrames,
    warnings: diagnose(analysis),
  };
  if (loop) {
    const end = audio.L.length - 1;
    result.loopSeamDelta = Math.max(Math.abs(audio.L[end] - audio.L[0]), Math.abs(audio.R[end] - audio.R[0]));
  }
  return result;
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const root = options['--output'] ?? path.join(__dirname, '..', 'output', 'banc-ecoute');
  const baseline = readBaseline(options['--against']);
  const orderSeed = baseline && randomSeed();
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'soundmcp-'));
  const projects = path.join(dir, 'projects'), audioDir = path.join(dir, 'audio');
  fs.mkdirSync(audioDir);
  const entries = [], listening = [], identities = [];
  for (const item of cases) {
    const { structuredContent: draft } = await callTool('draft_music', {
      ...item.settings, brief: item.brief, title: item.id, seed: item.seed, variants: 1, use_preferences: false, output_dir: projects,
    });
    const { project_path, warnings } = draft.candidates[0];
    const { structuredContent: preview } = await callTool('preview_music', {
      ...item.listen, project_path, output_dir: projects,
    });
    const file = `audio/${item.id}.wav`;
    const current = path.join(dir, file);
    fs.copyFileSync(preview.files[0].path, current);
    const sound = readWave(current);
    const measurements = stats(sound, Boolean(item.settings?.loop && item.listen?.full));
    entries.push({ case: item, file, measurements: { ...measurements, warnings: [...new Set([...measurements.warnings, ...warnings])] } });
    if (baseline) {
      const reference = readWave(path.join(baseline.directory, file));
      const candidateFirst = hash32(item.seed, orderSeed) % 2 === 0;
      const clips = candidateFirst ? [sound, reference] : [reference, sound];
      const matched = matchLevels(clips);
      const files = clips.map((clip, i) => {
        const label = i ? 'B' : 'A';
        const file = `ab/${item.id}-${label}.wav`;
        writeWav(path.join(dir, file), clip.L, clip.R, clip.sr, clip.mono, 24);
        return { label, file, integratedLufs: matched[i].integratedLufs };
      });
      listening.push({ id: item.id, focus: item.focus, files });
      identities.push({ id: item.id, candidate: candidateFirst ? 'A' : 'B', reference: candidateFirst ? 'B' : 'A' });
    }
    console.log(`✓ ${item.id}`);
  }
  const engine_sha256 = engineDigest();
  saveJson(path.join(dir, 'manifest.json'), { type: TYPE, version: 1, soundmcp_version: version, engine_sha256, entries });
  if (baseline) {
    saveJson(path.join(dir, 'ab.json'), { cases: listening });
    saveJson(path.join(dir, 'reveal.json'), {
      reference_version: baseline.data.soundmcp_version, reference_engine_sha256: baseline.data.engine_sha256,
      candidate_version: version, candidate_engine_sha256: engine_sha256, order_seed: orderSeed, identities,
    });
  }
  console.log(path.join(dir, 'manifest.json'));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
