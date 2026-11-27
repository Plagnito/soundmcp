'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { callTool } = require('../../src/tools');

async function main() {
  const directory = path.join(__dirname, 'generated');
  const { structuredContent: source } = await callTool('create_music', {
    style: 'ambient', title: 'La traversée', key: 'C major', tempo: 120, seed: 382,
    loop: false, save_project: true, format: 'midi', output_dir: directory, palette: 'synth',
    arrangement: { sections: [
      { name: 'Introduction', bars: 1, parts: ['pad', 'arp'], progression: [1] },
      { name: 'Boucle', bars: 2, parts: ['pad', 'arp', 'bass', 'mel'], progression: [1, 4], energy: 0.74 },
      { name: 'Sortie', bars: 1, parts: ['pad', 'mel'], progression: [1], energy: 0.52 },
    ] },
  });
  const { structuredContent: master } = await callTool('finish_music', {
    project_path: source.project_path, output_dir: directory, format: 'wav', stems: false,
    adaptive: { loop_region: { start_bar: 2, bars: 2 } },
  });
  const manifest = path.relative(directory, master.adaptive.manifest_path).split(path.sep).join('/');
  fs.writeFileSync(path.join(directory, 'current.txt'), manifest);
  console.log(master.adaptive.manifest_path);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
