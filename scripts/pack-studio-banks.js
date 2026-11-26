#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { brotliCompressSync, constants } = require('node:zlib');
const { pcmByteLength, unpackPcm } = require('../src/packed-bank');

function packPcm(pcm, samples) {
  const words = pcm.length / 2;
  const deltas = Buffer.allocUnsafe(pcm.length);
  // Un delta par canal, avec les octets faibles et forts dans deux plages contiguës.
  for (const { offset, frames, channels } of samples) {
    const previous = new Uint16Array(channels);
    const first = offset / 2;
    for (let word = 0; word < frames * channels; word++) {
      const index = first + word;
      const channel = word % channels;
      const value = pcm.readUInt16LE(index * 2);
      const delta = value - previous[channel];
      deltas[index] = delta;
      deltas[index + words] = delta >> 8;
      previous[channel] = value;
    }
  }
  return brotliCompressSync(deltas, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } });
}

const root = join(__dirname, '..', 'banks', 'studio');
for (const [bank, manifest] of [['studio', 'manifest'], ['extension', 'extension'], ['cinematic', 'cinematic']]) {
  const { samples, sha256 } = JSON.parse(readFileSync(join(root, `${manifest}.json`), 'utf8'));
  const pcm = readFileSync(join(root, `${bank}.pcm`));
  if (pcmByteLength(samples) !== pcm.length || createHash('sha256').update(pcm).digest('hex') !== sha256) {
    throw new Error(`Les prises de la banque ${bank} ne correspondent pas à son manifeste.`);
  }
  const packed = packPcm(pcm, samples);
  if (!pcm.equals(unpackPcm(packed, samples))) throw new Error(`Vérification sans perte échouée pour ${bank}.`);
  writeFileSync(join(root, `${bank}.pcm.br`), packed);
  console.log(`${bank}: ${pcm.length} → ${packed.length} octets`);
}
