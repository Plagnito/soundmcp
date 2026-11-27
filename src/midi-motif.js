'use strict';

const { ui } = require('./language');

const fs = require('node:fs');
const path = require('node:path');
const { COMMON_METER, isMeter } = require('./music-clock');
const { validateMotif } = require('./arrangement');

const MAX_BYTES = 8 * 1024 * 1024;

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }
  take(size) {
    if (size > this.remaining) throw new Error(ui('Fichier MIDI tronqué.', 'Truncated MIDI file.'));
    const data = this.bytes.subarray(this.offset, this.offset + size);
    this.offset += size;
    return data;
  }
  get remaining() {
    return this.bytes.length - this.offset;
  }
  byte() {
    if (!this.remaining) throw new Error(ui('Fichier MIDI tronqué.', 'Truncated MIDI file.'));
    return this.bytes[this.offset++];
  }
  dataByte() {
    const byte = this.byte();
    if (byte >= 0x80) throw new Error(ui('Octet de données MIDI invalide.', 'Invalid MIDI data byte.'));
    return byte;
  }
  number() {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const byte = this.byte();
      value = value * 128 + (byte & 0x7f);
      if (byte < 0x80) return value;
    }
    throw new Error(ui('Entier MIDI de longueur variable invalide.', 'Invalid MIDI variable-length integer.'));
  }
  chunk() {
    const header = this.take(8);
    return { id: header.toString('ascii', 0, 4), data: this.take(header.readUInt32BE(4)) };
  }
}

function parseTrack(bytes) {
  const reader = new Reader(bytes);
  const notes = [], meters = [], tempos = [];
  const active = new Map();
  let tick = 0, running = 0;
  while (reader.remaining) {
    tick += reader.number();
    let status = reader.byte();
    if (status >= 0xf0) {
      running = 0;
      if (status === 0xff) {
        const meta = reader.byte();
        const data = reader.take(reader.number());
        if (meta === 0x2f) break;
        if (meta === 0x51 && data.length === 3 && data.readUIntBE(0, 3)) {
          tempos.push({ tick, bpm: 60_000_000 / data.readUIntBE(0, 3) });
        }
        if (meta === 0x58 && data.length === 4) meters.push({ tick, meter: [data[0], 2 ** data[1]] });
      } else if (status === 0xf0 || status === 0xf7) {
        reader.take(reader.number());
      } else {
        throw new Error(ui('Événement système MIDI inconnu.', 'Unknown MIDI system event.'));
      }
      continue;
    }
    let first;
    if (status < 0x80) {
      if (!running) throw new Error(ui('Statut MIDI manquant avant les données.', 'Missing MIDI status before data.'));
      first = status;
      status = running;
    } else {
      running = status;
      first = reader.dataByte();
    }
    const command = status >> 4, channel = (status & 0x0f) + 1;
    if (command === 0xc || command === 0xd) continue;
    const second = reader.dataByte();
    if (command !== 0x8 && command !== 0x9) continue;
    const id = channel * 128 + first;
    if (command === 0x9 && second) {
      const queue = active.get(id) ?? { notes: [], head: 0 };
      queue.notes.push({ tick, midi: first, velocity: second / 127, channel });
      active.set(id, queue);
    } else {
      const queue = active.get(id);
      if (!queue) continue;
      const note = queue.notes[queue.head++];
      if (queue.head === queue.notes.length) active.delete(id);
      if (tick > note.tick) notes.push({ ...note, end: tick });
    }
  }
  return { notes, meters, tempos };
}

function readMidi(file) {
  if (!fs.statSync(file).isFile()) throw new Error(ui('L’import MIDI attend un fichier local.', 'MIDI import requires a local file.'));
  const handle = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(handle);
    const { size } = stat;
    if (!stat.isFile() || size < 14 || size > MAX_BYTES) throw new Error(ui('Le fichier MIDI doit faire entre 14 octets et 8 Mio.', 'The MIDI file must be between 14 bytes and 8 MiB.'));
    const bytes = Buffer.allocUnsafe(size);
    if (fs.readSync(handle, bytes, 0, size, 0) !== size) throw new Error(ui('Fichier MIDI tronqué.', 'Truncated MIDI file.'));
    const reader = new Reader(bytes);
    const header = reader.chunk();
    if (header.id !== 'MThd' || header.data.length < 6) throw new Error(ui('En-tête Standard MIDI File attendu.', 'Expected a Standard MIDI File header.'));
    const format = header.data.readUInt16BE(0), count = header.data.readUInt16BE(2);
    const ppq = header.data.readUInt16BE(4);
    if (format > 1 || !count || (format === 0 && count !== 1) || !ppq || ppq >= 0x8000) {
      throw new Error(ui(
        'L’import attend un fichier MIDI SMF 0 ou 1 avec une résolution en ticks par noire.',
        'Import requires an SMF 0 or 1 MIDI file with a ticks-per-quarter resolution.',
      ));
    }
    const tracks = [];
    while (reader.remaining && tracks.length < count) {
      const chunk = reader.chunk();
      if (chunk.id === 'MTrk') tracks.push(parseTrack(chunk.data));
    }
    if (tracks.length !== count) throw new Error(ui('Piste MIDI manquante.', 'Missing MIDI track.'));
    return { ppq, tracks };
  } finally {
    fs.closeSync(handle);
  }
}

function timingChanges(tracks, key) {
  return [...(tracks[0][key].length ? tracks[0][key] : tracks.flatMap((track) => track[key]))]
    .sort((a, b) => a.tick - b.tick);
}

function motifWindow(ppq, changes, first, bars) {
  let tick = 0, index = 0, meter = COMMON_METER;
  let start, ticksPerBar, selectedMeter;
  for (let bar = 1; bar < first + bars; bar++) {
    while (changes[index]?.tick <= tick + 1e-8) meter = changes[index++].meter;
    if (!isMeter(meter)) throw new Error(ui('Signature MIDI hors des mesures prises en charge par SoundMCP.', 'SoundMCP does not support this MIDI time signature.'));
    const length = ppq * meter[0] * 4 / meter[1];
    if (bar === first) {
      start = tick;
      selectedMeter = meter;
      ticksPerBar = length;
    }
    if (bar >= first && (meter[0] !== selectedMeter[0] || meter[1] !== selectedMeter[1])) {
      throw new Error(ui('Choisis une plage MIDI dont la signature rythmique reste constante.', 'Select a MIDI region with one time signature.'));
    }
    tick += length;
    if (changes[index]?.tick < tick - 1e-8) throw new Error(ui('Le fichier change de signature au milieu d’une mesure.', 'The file changes time signature in the middle of a bar.'));
  }
  return { start, end: tick, meter: selectedMeter, ticksPerBar };
}

function readMidiMotif(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some((key) => !['path', 'track', 'channel', 'start_bar', 'bars'].includes(key))) {
    throw new Error(ui(
      'midi_motif attend path et les sélecteurs facultatifs track, channel, start_bar et bars.',
      'midi_motif requires path and accepts the optional track, channel, start_bar, and bars selectors.',
    ));
  }
  const { path: file, track, channel, start_bar = 1, bars = 2 } = options;
  if (typeof file !== 'string' || !file.trim()) throw new Error(ui('Indique le chemin local du fichier MIDI.', 'Supply the local MIDI file path.'));
  if (!Number.isInteger(start_bar) || start_bar < 1 || start_bar > 10000 || ![1, 2].includes(bars) ||
      (track !== undefined && (!Number.isInteger(track) || track < 1)) ||
      (channel !== undefined && (!Number.isInteger(channel) || channel < 1 || channel > 16))) {
    throw new Error(ui('Piste ou canal MIDI invalide, ou plage en dehors de 1 à 2 mesures.', 'Invalid MIDI track or channel, or a region outside the 1 to 2 bar limit.'));
  }
  const { ppq, tracks } = readMidi(path.resolve(file));
  if (track > tracks.length) throw new Error(ui(`Le fichier MIDI a ${tracks.length} piste(s).`, `The MIDI file has ${tracks.length} track(s).`));
  const { start, end, meter, ticksPerBar } = motifWindow(ppq, timingChanges(tracks, 'meters'), start_bar, bars);
  const available = tracks.map(({ notes }) => notes.filter((n) => n.tick >= start && n.tick < end &&
    (channel === undefined ? n.channel !== 10 : n.channel === channel))
    .sort((a, b) => a.tick - b.tick || a.channel - b.channel));
  const trackIndex = track === undefined ? available.findIndex((notes) => notes.length) : track - 1;
  const selected = available[trackIndex] ?? [];
  const selectedChannel = channel ?? selected[0]?.channel;
  const notes = selected.filter((note) => note.channel === selectedChannel);
  if (!notes.length) throw new Error(ui('Aucune note complète sur cette piste et ce canal MIDI dans la plage choisie.', 'No complete notes on this MIDI track and channel in the selected region.'));
  if (notes.length > 24 || notes.some((note, i) => i && note.tick < notes[i - 1].end)) {
    throw new Error(ui('Choisis une plage MIDI monophonique de 24 notes au plus, sans chevauchement.', 'Select a monophonic MIDI region of up to 24 non-overlapping notes.'));
  }
  const motif = notes.map(({ tick, end: stop, midi, velocity }) => {
    const beat = (tick - start) * 4 / ticksPerBar;
    return { beat, midi, duration: Math.min((Math.min(stop, end) - tick) * 4 / ticksPerBar, bars * 4 - beat), velocity };
  });
  validateMotif(motif);
  const bpm = timingChanges(tracks, 'tempos').filter((entry) => entry.tick <= start).at(-1)?.bpm ?? 120;
  return { motif, meter, tempo: Math.round(bpm),
    source: { track: trackIndex + 1, channel: selectedChannel, start_bar, bars, meter, ticks_per_quarter: ppq, tempo: Math.round(bpm) } };
}

module.exports = { readMidiMotif };
