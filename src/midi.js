'use strict';

/**
 * Export MIDI (Standard MIDI File, format 1) — zéro dépendance.
 * 4 pistes : mélodie / accords (nappe) / basse / batterie (canal 10 GM).
 * Utile pour les jeux : fichier léger, bouclable, éditable dans un DAW.
 */

const fs = require('node:fs');
const path = require('node:path');

const PPQ = 480;

const GM_PROGRAMS = {
  // inst -> programme General MIDI (0-indexé)
  ep: 4,        // Electric Piano 1
  ks: 24,       // Nylon Guitar (harpe/pluck)
  bell: 9,      // Glockenspiel
  tri: 11,      // Vibraphone (lead doux)
  square: 80,   // Square Lead
  saw: 81,      // Saw Lead
  piano: 0,     // Acoustic Grand
  padwarm: 89,  // Pad 2 (warm)
  padbright: 88,// Pad 1 (new age)
  paddark: 91,  // Pad 4 (choir)
  padchip: 62,  // Synth Brass? -> 98? garder simple
  strings: 48,  // Strings
  bass: 33,     // Finger Bass -> préférer synth : 38
  'bass-sq': 38,// Synth Bass 1
  'bass-tri': 32,
  sub: 38,
  tri2: 11,
};

const GM_DRUMS = { kick: 36, snare: 38, hat: 42, ohat: 46, clap: 39, shaker: 70, tom: 45 };

function varLen(value) {
  const bytes = [value & 0x7f];
  value >>= 7;
  while (value > 0) {
    bytes.unshift((value & 0x7f) | 0x80);
    value >>= 7;
  }
  return bytes;
}

function vlqToBytes(arr) {
  return Buffer.from(arr);
}

function trackChunk(events) {
  // events: [{ tick, data: Buffer }] triés
  const out = [];
  let lastTick = 0;
  for (const ev of events) {
    out.push(vlqToBytes(varLen(Math.max(0, ev.tick - lastTick))));
    out.push(ev.data);
    lastTick = ev.tick;
  }
  out.push(vlqToBytes(varLen(0)));
  out.push(Buffer.from([0xff, 0x2f, 0x00])); // end of track
  const payload = Buffer.concat(out);
  const head = Buffer.alloc(8);
  head.write('MTrk', 0, 'ascii');
  head.writeUInt32BE(payload.length, 4);
  return Buffer.concat([head, payload]);
}

function noteEventsToTrack(events, opts = {}) {
  const { channel = 0, program = null, drumMap = null, defaultDurTicks = 240 } = opts;
  const evs = [];
  if (program !== null) {
    evs.push({ tick: 0, data: Buffer.from([0xc0 | channel, program & 0x7f]) });
  }
  for (const e of events) {
    const tick = Math.round(e.t * PPQ);
    const dur = Math.max(30, Math.round((e.dur || (defaultDurTicks / PPQ)) * PPQ));
    const note = drumMap ? (drumMap[e.drum] ?? 38) : ((e.midi % 128) + 128) % 128;
    const vel = Math.max(1, Math.min(127, Math.round((e.vel || 0.7) * 110)));
    if (drumMap) {
      evs.push({ tick, data: Buffer.from([0x90 | 9, note, vel]) });
      evs.push({ tick: tick + dur, data: Buffer.from([0x80 | 9, note, 0]) });
    } else {
      evs.push({ tick, data: Buffer.from([0x90 | channel, note, vel]) });
      evs.push({ tick: tick + dur, data: Buffer.from([0x80 | channel, note, 0]) });
    }
  }
  evs.sort((a, b) => a.tick - b.tick || (a.data[0] & 0xf0) - (b.data[0] & 0xf0));
  return trackChunk(evs);
}

function metaTrack(bpm, name) {
  const evs = [];
  evs.push({ tick: 0, data: Buffer.from([0xff, 0x03, name.length, ...Buffer.from(name, 'ascii')]) });
  const mpqn = Math.round(60000000 / bpm);
  evs.push({ tick: 0, data: Buffer.from([0xff, 0x51, 0x03, (mpqn >> 16) & 0xff, (mpqn >> 8) & 0xff, mpqn & 0xff]) });
  evs.push({ tick: 0, data: Buffer.from([0xff, 0x58, 0x04, 4, 2, 24, 8]) }); // 4/4
  evs.sort((a, b) => a.tick - b.tick);
  return trackChunk(evs);
}

/**
 * song (résultat createSong) -> Buffer MIDI.
 */
function renderMidiBuffer(song, title = 'SoundMCP') {
  const groups = { mel: [], pad: [], bass: [], drum: [] };
  for (const e of song.events) {
    if (e.bus === 'mel') groups.mel.push(e);
    else if (e.bus === 'pad') groups.pad.push(e);
    else if (e.bus === 'bass') groups.bass.push(e);
    else if (e.bus === 'drum') groups.drum.push(e);
    else if (e.bus === 'arp') groups.mel.push({ ...e, inst: e.inst }); // arpèges avec la mélodie
  }
  const melodyProg = GM_PROGRAMS[song.events.find((e) => e.bus === 'mel')?.inst] ?? 81;
  const padProg = GM_PROGRAMS[song.events.find((e) => e.bus === 'pad')?.inst] ?? 89;
  const bassProg = GM_PROGRAMS[song.events.find((e) => e.bus === 'bass')?.inst] ?? 38;

  const tracks = [
    metaTrack(song.bpm, title.slice(0, 60)),
    noteEventsToTrack(groups.mel, { channel: 0, program: melodyProg }),
    noteEventsToTrack(groups.pad, { channel: 1, program: padProg }),
    noteEventsToTrack(groups.bass, { channel: 2, program: bassProg }),
    noteEventsToTrack(groups.drum, { drumMap: GM_DRUMS }),
  ];
  const header = Buffer.alloc(14);
  header.write('MThd', 0, 'ascii');
  header.writeUInt32BE(6, 4);
  header.writeUInt16BE(1, 8);      // format 1
  header.writeUInt16BE(tracks.length, 10);
  header.writeUInt16BE(PPQ, 12);
  return Buffer.concat([header, ...tracks]);
}

function writeMidi(filePath, song, title) {
  const buf = renderMidiBuffer(song, title);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buf);
  return { bytes: buf.length };
}

module.exports = { writeMidi, renderMidiBuffer };
