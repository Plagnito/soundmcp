'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const repo = path.join(__dirname, '..');
const profiles = { full: 18, studio: 18, music: 11, sound: 9, audition: 17, patches: 17, presets: 17, compact: 15 };

function inspect(entry, profile, language, calls = []) {
  const requests = [
    { method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'soundmcp-check', version: '1' } } },
    { method: 'tools/list' }, ...calls,
  ];
  const response = spawnSync(process.execPath, [entry], {
    env: { ...process.env, SOUNDMCP_TOOLSET: profile, SOUNDMCP_LANG: language },
    input: requests.map((request, index) => JSON.stringify({ jsonrpc: '2.0', id: index + 1, ...request })).join('\n') + '\n',
    encoding: 'utf8', maxBuffer: 25 * 1024 * 1024,
  });
  assert.equal(response.status, 0, response.stderr || String(response.error ?? ''));
  const replies = response.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(replies.length, requests.length, response.stderr);
  for (const [index, reply] of replies.entries()) {
    assert.equal(reply.id, index + 1);
    assert(!reply.error && !reply.result?.isError, JSON.stringify(reply));
  }
  assert.equal(replies[1].result.tools.length, profiles[profile]);
  return { info: replies[0].result.serverInfo, definitions: replies[1].result, results: replies.slice(2).map(({ result }) => result) };
}

function capture(output, entry = path.join(repo, 'src', 'index.js')) {
  fs.mkdirSync(output, { recursive: true });
  return ['fr', 'en'].flatMap((language) => Object.keys(profiles).map((profile) => {
    const { definitions } = inspect(entry, profile, language);
    const bytes = JSON.stringify({ serverName: 'SoundMCP', ...definitions });
    const file = `${profile}-${language}.json`;
    fs.writeFileSync(path.join(output, file), bytes + '\n');
    return { profile, language, file, tools: definitions.tools.length,
      sha256: createHash('sha256').update(JSON.stringify(definitions)).digest('hex') };
  }));
}

if (require.main === module) {
  const destination = path.resolve(process.argv[2] ?? path.join(repo, 'tmp', 'toolsets'));
  const checks = capture(destination);
  fs.writeFileSync(path.join(destination, 'index.json'), JSON.stringify(checks, null, 2) + '\n');
  console.log(destination);
}

module.exports = { inspect, capture, profiles };
