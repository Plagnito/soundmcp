'use strict';

const { ui } = require('./language');

const { brotliDecompressSync } = require('node:zlib');

function pcmByteLength(samples) {
  let length = 0;
  for (const { offset, frames, channels } of samples) {
    if (offset !== length || !Number.isSafeInteger(frames) || frames <= 0 || (channels !== 1 && channels !== 2)) {
      throw new Error(ui('Le manifeste de la banque Studio est incomplet ou invalide.', 'The Studio bank manifest is incomplete or invalid.'));
    }
    length += frames * channels * 2;
  }
  if (!length || !Number.isSafeInteger(length)) throw new Error(ui('La banque Studio ne contient aucune prise exploitable.', 'The Studio bank has no usable samples.'));
  return length;
}

function unpackPcm(compressed, samples) {
  const length = pcmByteLength(samples);
  const deltas = brotliDecompressSync(compressed, { maxOutputLength: length });
  if (deltas.length !== length) throw new Error(ui('La taille de la banque Studio compressée est incorrecte.', 'The compressed Studio bank has an incorrect size.'));
  const pcm = Buffer.allocUnsafe(length);
  const words = length / 2;
  for (const { offset, frames, channels } of samples) {
    const previous = new Uint16Array(channels);
    const first = offset / 2;
    for (let word = 0; word < frames * channels; word++) {
      const index = first + word;
      const channel = word % channels;
      previous[channel] += deltas[index] | (deltas[index + words] << 8);
      pcm[index * 2] = previous[channel];
      pcm[index * 2 + 1] = previous[channel] >>> 8;
    }
  }
  return pcm;
}

module.exports = { pcmByteLength, unpackPcm };
