'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSong } = require('../src/composer');
const { renderSong, readWavInfo, writeWav } = require('../src/dsp');
const { renderMidiBuffer } = require('../src/midi');
const { STYLE_IDS } = require('../src/styles');
const { callTool } = require('../src/tools');

function readMidiTracks(buffer) {
  const count = buffer.readUInt16BE(10);
  let offset = 14;
  const tracks = [];
  const vlq = () => {
    let byte, value = 0;
    do { byte = buffer[offset++]; value = value * 128 + (byte & 127); } while (byte & 128);
    return value;
  };
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.toString('ascii', offset, offset + 4), 'MTrk');
    const end = offset + 8 + buffer.readUInt32BE(offset + 4);
    offset += 8;
    let tick = 0;
    const events = [];
    while (offset < end) {
      tick += vlq();
      const status = buffer[offset++];
      if (status === 0xff) {
        const type = buffer[offset++];
        const length = vlq();
        events.push({ status, type, tick, text: buffer.toString('utf8', offset, offset + length) });
        offset += length;
      } else {
        const type = status & 0xf0;
        const note = buffer[offset++];
        const value = type === 0xc0 ? undefined : buffer[offset++];
        events.push({ status, type, tick, note, value });
      }
    }
    assert.equal(offset, end);
    tracks.push(events);
  }
  assert.equal(offset, buffer.length);
  return tracks;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soundmcp-quality-'));
  const arrangement = {
    motif: [{ beat: 0, degree: 1, duration: 0.5 }, { beat: 0.75, degree: 3, duration: 1 }, { beat: 4, degree: 5, duration: 2 }],
    sections: [
      { name: 'Départ', bars: 1, progression: [1], parts: ['mel', 'pad'], energy: 0.5 },
      { name: 'Réponse', bars: 2, progression: [4, 5], parts: ['mel', 'arp', 'bass', 'drum'], energy: 0.95 },
    ],
  };
  const args = { style: 'jazz', key: 'C major', tempo: 120, seed: 0, loop: true, arrangement };
  const score = createSong(args);
  const same = createSong(args);
  assert.equal(score.meta.seed, 0);
  assert.deepEqual(score, same);
  assert.notDeepEqual(score.events, createSong({ ...args, seed: 1 }).events);
  assert.equal(score.totalBeats, 12);
  assert.deepEqual(score.meta.sections.map(({ chords }) => chords), [['Cmaj7'], ['Fmaj7add9', 'G7']]);
  assert.deepEqual(score.events.filter((e) => e.bus === 'mel').map((e) => e.midi), [72, 76, 72, 76, 79]);
  const override = { ...arrangement, sections: [arrangement.sections[0], { ...arrangement.sections[1],
    motif: [{ beat: 0, degree: 8, duration: 2 }] }] };
  assert.deepEqual(createSong({ ...args, arrangement: override }).events.filter((e) => e.bus === 'mel').map((e) => e.midi), [72, 76, 84]);
  assert(score.events.filter((e) => e.bus === 'pad').every((e) => e.t < 4));
  assert(score.events.filter((e) => ['bass', 'arp', 'drum'].includes(e.bus)).every((e) => e.t > 3.98));
  assert.throws(() => createSong({ ...args, arrangement: { sections: [{ bars: 1, progression: [0] }] } }), /degrés/);
  assert.throws(() => createSong({ ...args, arrangement: { motif: [{ beat: 7, degree: 4, duration: 2 }] } }), /motif/);
  assert.throws(() => createSong({ ...args, arrangement: { sections: Array(8).fill({ bars: 64 }) } }), /600/);
  assert.throws(() => createSong({ ...args, key: 'inconnue' }), /Tonalité/);

  const short = createSong({ style: 'sad', key: 'C minor', tempo: 40, duration_seconds: 5, seed: 3, loop: false });
  assert.equal(short.bars, 1);
  const full = createSong({ style: 'epic', key: 'D harmonic minor', duration_seconds: 76, seed: 7, loop: false });
  assert(full.meta.sections.some(({ theme }) => theme === 'B'));
  assert.equal(full.meta.sections.at(-1).chords.at(-1), 'Dm');
  assert.equal(full.events.filter((e) => e.bus === 'mel').at(-1).midi % 12, 2);

  const result = await callTool('create_music', { ...args, format: 'both', bit_depth: 24, sampling_rate: 48000, stems: true, output_dir: dir });
  const { files, audio } = result.structuredContent;
  const [mix, ...rest] = files;
  assert.equal(audio.durationSeconds, 6);
  assert(audio.peakDbfs <= -1);
  assert.equal(readWavInfo(mix.path).bits, 24);
  assert.equal(readWavInfo(mix.path).sr, 48000);
  assert.equal(rest.filter((file) => file.stem).length, 5);
  for (const stem of rest.filter((file) => file.stem)) {
    assert.equal(readWavInfo(stem.path).encoding, 'float');
    assert.equal(readWavInfo(stem.path).duration, audio.durationSeconds);
  }
  await assert.rejects(callTool('create_music', { ...args, format: 'midi', stems: true }), /stems/);

  const tracks = readMidiTracks(renderMidiBuffer(score, 'Été'));
  assert.equal(tracks[0][0].text, 'Été');
  assert.deepEqual(tracks[0].filter(({ type }) => type === 6).map(({ tick, text }) => [tick, text]), [[0, 'Départ'], [1920, 'Réponse']]);
  assert(tracks.some((track) => track[0].text.startsWith('Accompaniment')));
  assert(tracks.every((track) => track.at(-1).tick === 5760));
  for (const style of STYLE_IDS) {
    const song = createSong({ style, seed: 42, tempo: 220, duration_seconds: 5, loop: true, sr: 22050 });
    const audio = renderSong(song);
    assert(audio.metrics.rmsDbfs > -35, `${style}: signal trop faible`);
    assert(audio.metrics.peakDbfs <= -1, `${style}: crête excessive`);
    assert(audio.metrics.stereoCorrelation > 0.15, `${style}: compatibilité mono insuffisante`);
    for (const channel of [audio.L, audio.R]) {
      const n = channel.length;
      let largestNeighbor = 0;
      for (let i = 1; i < 128; i++) {
        largestNeighbor = Math.max(largestNeighbor, Math.abs(channel[i] - channel[i - 1]), Math.abs(channel[n - i] - channel[n - i - 1]));
      }
      assert(Math.abs(channel[0] - channel[n - 1]) < Math.max(0.00015, largestNeighbor * 1.6), `${style}: clic de raccord`);
    }
    for (const track of readMidiTracks(renderMidiBuffer(song))) {
      const programs = track.filter(({ type }) => type === 0xc0);
      assert(programs.every(({ note }) => ![52, 53, 54, 91].includes(note)), `${style}: programme vocal`);
      const sounding = new Set();
      for (const event of track.filter(({ type }) => type === 0x90 || type === 0x80)) {
        if (event.type === 0x90) {
          assert(!sounding.has(event.note), `${style}: note MIDI superposée`);
          sounding.add(event.note);
        } else assert(sounding.delete(event.note), `${style}: note MIDI sans attaque`);
      }
      assert.equal(sounding.size, 0);
    }
  }

  const odd = path.join(dir, 'mono-odd.wav');
  const info = writeWav(odd, Float32Array.of(0.5, -0.5, 0), undefined, 48000, true, 24);
  assert.equal(info.bytes, 54);
  assert.equal(readWavInfo(odd).dataSize, 9);
  assert.equal(fs.readFileSync(odd).readUInt32LE(4), info.bytes - 8);
  console.log(`Validation musique : ${STYLE_IDS.length} styles, boucles, MIDI instrumental, WAV 24 bits et stems 32 bits.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
