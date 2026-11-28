'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { inspect, capture } = require('./inspect-toolsets');

const repo = path.join(__dirname, '..');
const npmEntry = process.env.npm_execpath;
if (!npmEntry) throw new Error('Run this check with npm run check:release.');
const temp = path.join(repo, 'tmp');
fs.mkdirSync(temp, { recursive: true });
const directory = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(temp, 'release-check-'));
fs.mkdirSync(directory, { recursive: true });

function npm(args) {
  const result = spawnSync(process.execPath, [npmEntry, ...args], { cwd: repo, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || String(result.error ?? ''));
  return result.stdout;
}

function inspectCredits(installed) {
  const studio = path.join(installed, 'banks', 'studio');
  const credits = fs.readFileSync(path.join(studio, 'CREDITS.md'), 'utf8');
  assert(credits.includes('CC0 1.0'));
  return ['manifest', 'extension', 'cinematic'].map((name) => {
    const data = JSON.parse(fs.readFileSync(path.join(studio, name + '.json'), 'utf8'));
    const archive = path.join(studio, (name === 'manifest' ? 'studio' : name) + '.pcm.br');
    assert(fs.statSync(archive).size > 0);
    assert.match(data.sha256, /^[0-9a-f]{64}$/);
    const sources = [...new Set(data.samples.map(({ source }) => source))].map((name) => {
      const source = data.sources[name];
      assert.match(source.repository, /^[^/]+\/[^/]+$/);
      assert.match(source.commit, /^[0-9a-f]{40}$/);
      assert.equal(source.license, 'CC0-1.0');
      return { name, ...source };
    });
    assert(data.samples.every(({ path }) => typeof path === 'string' && path.length));
    return { name, sha256: data.sha256, samples: data.samples.length, sources };
  });
}

const [packed] = JSON.parse(npm(['pack', '--json', '--pack-destination', directory]));
const packageFile = path.join(directory, packed.filename);
const integrity = 'sha512-' + createHash('sha512').update(fs.readFileSync(packageFile)).digest('base64');
assert.equal(integrity, packed.integrity);
const prefix = path.join(directory, 'offline-install');
npm(['install', '--offline', '--ignore-scripts', '--no-fund', '--no-audit', '--prefix', prefix, packageFile]);
const installed = path.join(prefix, 'node_modules', '@plagnito', 'soundmcp');
const pkg = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
assert.equal(pkg.version, packed.version);
assert.equal(pkg.license, 'MIT');
assert(fs.existsSync(path.join(prefix, 'node_modules', '.bin', process.platform === 'win32' ? 'soundmcp.cmd' : 'soundmcp')));
const entry = path.join(installed, pkg.bin.soundmcp);
const output_dir = path.join(directory, 'demo');
const { info, results: [tour] } = inspect(entry, 'compact', 'en', [
  { method: 'tools/call', params: { name: 'audition_sound', arguments: { mode: 'catalog', sounds: ['piano', 'harp', 'strings'], output_dir, seed: 7 } } },
]);
assert.equal(info.version, packed.version);
assert.equal(tour.structuredContent.markers.length, 3);
assert(fs.statSync(tour.structuredContent.path).size > 44);
const tools = capture(path.join(directory, 'toolsets'), entry);
const source = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
const tags = spawnSync('git', ['tag', '--points-at', 'HEAD'], { cwd: repo, encoding: 'utf8' });
const manifest = {
  package: packed.name, version: packed.version, git_commit: source.status === 0 ? source.stdout.trim() : null,
  git_tags: tags.status === 0 ? tags.stdout.trim().split(/\r?\n/).filter(Boolean) : [],
  git_tree_clean: source.status === 0 ? spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).stdout?.trim() === '' : null,
  tarball: packed.filename, integrity, sample_banks: inspectCredits(installed), toolsets: tools,
};
fs.writeFileSync(path.join(directory, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ directory, package: packed.name, version: packed.version, integrity, definitions: tools.length }));
