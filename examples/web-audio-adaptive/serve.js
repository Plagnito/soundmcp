'use strict';

const { createServer } = require('node:http');
const { createReadStream, readFileSync, realpathSync } = require('node:fs');
const path = require('node:path');

function packFile(argument) {
  if (argument) return path.resolve(argument);
  const generated = path.resolve(__dirname, '../godot-adaptive/generated');
  const manifest = readFileSync(path.join(generated, 'current.txt'), 'utf8').trim();
  return path.join(generated, manifest);
}

function serve() {
  const manifestPath = realpathSync(packFile(process.argv[2]));
  const data = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const folder = path.dirname(manifestPath);
  const routes = new Map([
    ['/', [path.join(__dirname, 'index.html'), 'text/html; charset=utf-8']],
    ['/player.mjs', [path.join(__dirname, 'player.mjs'), 'text/javascript; charset=utf-8']],
    ['/pack/manifest.json', [manifestPath, 'application/json']],
  ]);
  for (const segment of ['intro', 'loop', 'outro']) {
    const name = data.segments?.[segment]?.file;
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]*\.wav$/i.test(name)) throw new Error('Invalid segment filename.');
    const file = realpathSync(path.join(folder, name));
    if (path.relative(folder, file) !== name) throw new Error('Segment outside the manifest directory.');
    routes.set('/pack/' + name, [file, 'audio/wav']);
  }
  const server = createServer((request, response) => {
    const file = routes.get(request.url);
    if (request.method !== 'GET' || !file) {
      response.writeHead(404).end();
      return;
    }
    const input = createReadStream(file[0]);
    input.once('open', () => {
      response.setHeader('Content-Type', file[1]);
      input.pipe(response);
    });
    input.once('error', () => response.destroy());
    response.once('close', () => input.destroy());
  });
  server.listen(Number(process.argv[3] ?? 8787), '127.0.0.1', () => {
    console.log('SoundMCP Web Audio demo on http://127.0.0.1:' + server.address().port + '/');
  });
}

try {
  serve();
} catch (error) {
  console.error(error.message);
  console.error('Pass the path of a SoundMCP adaptive manifest, or run node examples/godot-adaptive/prepare-demo.js first.');
  process.exitCode = 1;
}
