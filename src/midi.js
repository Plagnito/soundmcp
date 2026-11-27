'use strict';

const { ui } = require('./language');

const { performEvents } = require('./performance');

/**
 * Export MIDI (Standard MIDI File, format 1) — zéro dépendance.
 * Une piste par pupitre et instrument, batterie sur le canal 10 GM.
 * Utile pour les jeux : fichier léger, bouclable, éditable dans un DAW.
 */

const fs = require('node:fs');
const path = require('node:path');
const { musicClock, COMMON_METER } = require('./music-clock');
const { SOUNDS } = require('./texture-voices');
const { isCustom } = require('./custom-patch');
const { ORCHESTRAL_DRUM_MIDI, TUNED_PERCUSSION } = require('./orchestral-percussion');

const PPQ = 480;

const GM_PROGRAMS = {
  ...Object.fromEntries(Object.entries(SOUNDS).filter(([, spec]) => spec[4] !== null).map(([id, spec]) => [id, spec[4]])),
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
  paddark: 92,  // Pad 5 (bowed)
  padchip: 80,  // Square Lead
  strings: 48,  // Strings
  bass: 38,     // Synth Bass 1
  upright: 32,  // Acoustic Bass
  guitar: 30,   // Distortion Guitar
  'acoustic-guitar': 26, // Jazz Guitar
  nylon: 24,    // Nylon Guitar
  flute: 73,    // Flute
  clarinet: 71, // Clarinet
  brass: 60,    // French Horn
  'bass-sq': 38,// Synth Bass 1
  'bass-tri': 32,
  sub: 38,
  tri2: 11,
};

const GM_DRUMS = { kick: 36, snare: 38, hat: 42, ohat: 46, clap: 39, shaker: 70, tom: 45, crash: 49, ride: 51,
  ...ORCHESTRAL_DRUM_MIDI };

function varLen(value) {
  const bytes = [value & 0x7f];
  value >>= 7;
  while (value > 0) {
    bytes.unshift((value & 0x7f) | 0x80);
    value >>= 7;
  }
  return bytes;
}

function trackChunk(events, endTick) {
  const out = [];
  let lastTick = 0;
  for (const ev of events) {
    out.push(Buffer.from(varLen(ev.tick - lastTick)), ev.data);
    lastTick = ev.tick;
  }
  out.push(Buffer.from([...varLen(endTick - lastTick), 0xff, 0x2f, 0x00]));
  const payload = Buffer.concat(out);
  const head = Buffer.alloc(8);
  head.write('MTrk', 0, 'ascii');
  head.writeUInt32BE(payload.length, 4);
  return Buffer.concat([head, payload]);
}

function textEvent(type, value) {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([Buffer.from([0xff, type, ...varLen(bytes.length)]), bytes]);
}

function noteTrack(events, { channel, program, name, endTick, clock }) {
  const percussion = channel === 9;
  const evs = [{ tick: 0, order: 0, data: textEvent(0x03, name) }];
  if (!percussion) evs.push({ tick: 0, order: 1, data: Buffer.from([0xc0 | channel, program]) });
  const previous = new Map();
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    const tick = Math.max(0, Math.round(clock.quarter(e.t) * PPQ));
    if (tick >= endTick) continue;
    const shortening = e.articulation === 'staccato' || e.articulation === 'mute' ? 0.57 : 1;
    const duration = percussion ? Math.round(0.12 * PPQ) : Math.max(1, Math.round(clock.quarter(e.t + e.dur * shortening) * PPQ) - tick);
    const note = percussion ? GM_DRUMS[e.drum ?? e.inst] : e.midi;
    const vel = Math.max(1, Math.min(127, Math.round(e.vel * 112 * (e.gain ?? 1))));
    const earlier = previous.get(note);
    if (earlier?.start === tick) {
      earlier.on.data[2] = Math.max(earlier.on.data[2], vel);
      earlier.off.tick = Math.max(earlier.off.tick, Math.min(endTick, tick + duration));
      continue;
    }
    if (earlier && earlier.off.tick > tick) earlier.off.tick = tick;
    const on = { tick, order: 3, data: Buffer.from([0x90 | channel, note, vel]) };
    const off = { tick: Math.min(endTick, tick + duration), order: 2, data: Buffer.from([0x80 | channel, note, 0]) };
    previous.set(note, { start: tick, on, off });
    evs.push(on, off);
  }
  evs.sort((a, b) => a.tick - b.tick || a.order - b.order);
  return trackChunk(evs, endTick);
}

function metaTrack(song, name, endTick, clock) {
  const evs = [{ tick: 0, data: textEvent(0x03, name) }];
  const changes = clock.changes.length ? clock.changes : [{ quarter: 0, tempo: song.bpm, meter: COMMON_METER }];
  for (const change of changes) {
    const tick = Math.round(change.quarter * PPQ);
    const mpqn = Math.round(60000000 / change.tempo);
    evs.push({ tick, data: Buffer.from([0xff, 0x51, 0x03, (mpqn >> 16) & 0xff, (mpqn >> 8) & 0xff, mpqn & 0xff]) });
    evs.push({ tick, data: Buffer.from([0xff, 0x58, 0x04, change.meter[0], Math.log2(change.meter[1]), 24, 8]) });
  }
  for (const section of song.meta?.sections ?? []) {
    evs.push({ tick: Math.round(clock.quarter((section.startBar - 1) * 4) * PPQ), data: textEvent(0x06, section.name) });
  }
  return trackChunk(evs.sort((a, b) => a.tick - b.tick), endTick);
}

function renderMidiBuffer(song, title = 'SoundMCP') {
  const clock = musicClock(song);
  const performed = performEvents(song, clock);
  const endTick = Math.round(clock.quarter(song.totalBeats) * PPQ);
  const labels = { mel: 'Melody', pad: 'Harmony', arp: 'Accompaniment', bass: 'Bass', drum: 'Drums', counter: 'Countermelody', texture: 'Timpani' };
  const customPrograms = { mel: 81, pad: 89, arp: 11, bass: 38, counter: 80 };
  const tracks = [metaTrack(song, title.slice(0, 120), endTick, clock)];
  let channel = 0;
  for (const [bus, label] of Object.entries(labels)) {
    const events = performed.filter((event) => event.bus === bus && (bus !== 'texture' || TUNED_PERCUSSION.includes(event.inst)));
    if (bus === 'drum') {
      events.push(...performed.filter((e) => e.bus === 'texture' && Object.hasOwn(ORCHESTRAL_DRUM_MIDI, e.inst)));
      if (events.length) tracks.push(noteTrack(events, { channel: 9, name: label, endTick, clock }));
      continue;
    }
    if (bus === 'texture') {
      if (!events.length) continue;
      if (channel === 9) channel++;
      if (channel > 15) throw new Error(ui('Le MIDI accepte au plus 15 pistes instrumentales avec programmes distincts.', 'MIDI supports up to 15 instrument tracks with distinct programs.'));
      tracks.push(noteTrack(events, { channel: channel++, program: GM_PROGRAMS.timpani, name: label, endTick, clock }));
      continue;
    }
    for (const inst of new Set(events.map((event) => event.inst))) {
      const part = events.filter((event) => event.inst === inst);
      if (channel === 9) channel++;
      if (channel > 15) throw new Error(ui('Le MIDI accepte au plus 15 pistes instrumentales avec programmes distincts.', 'MIDI supports up to 15 instrument tracks with distinct programs.'));
      tracks.push(noteTrack(part, { channel: channel++, program: isCustom(inst) ? customPrograms[bus] : GM_PROGRAMS[inst] ?? 0,
        name: `${label} — ${inst}`, endTick, clock }));
    }
  }
  const header = Buffer.alloc(14);
  header.write('MThd', 0, 'ascii');
  header.writeUInt32BE(6, 4);
  header.writeUInt16BE(1, 8);
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
