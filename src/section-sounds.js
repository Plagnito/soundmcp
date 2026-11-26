'use strict';

const { INSTRUMENTS } = require('./dsp');
const { COLORS, SOUNDS } = require('./texture-voices');
const { parseKey, midiToFreq } = require('./theory');
const { hash32 } = require('./rng');
const { isCustom } = require('./custom-patch');
const { readOrchestralPercussion } = require('./orchestral-percussion');

const SOUND_DESIGNS = ['classic', 'evolving'];
const SOUND_PARTS = ['pad', 'bass', 'arp', 'mel', 'counter'];
const TEXTURES = Object.keys(SOUNDS).filter((id) => SOUNDS[id][2] === 'texture');

function readSectionSounds(section, label) {
  const { color, instruments, textures } = section;
  const orchestral = readOrchestralPercussion(section.orchestral_percussion);
  if (color !== undefined && !Object.hasOwn(COLORS, color)) throw new Error(`${label} : couleur de mix inconnue.`);
  if (instruments !== undefined && (!instruments || typeof instruments !== 'object' || Array.isArray(instruments) ||
      Object.entries(instruments).some(([part, inst]) => !SOUND_PARTS.includes(part) ||
        !(isCustom(inst) || Object.hasOwn(INSTRUMENTS, inst)) || TEXTURES.includes(inst)))) {
    throw new Error(`${label} : instruments attend des pupitres mélodiques et des instruments connus. Consulte list_sounds.`);
  }
  if (textures !== undefined && (!Array.isArray(textures) || textures.length > 32)) throw new Error(`${label} : jusqu’à 32 textures attendues.`);
  const notes = textures?.map((texture) => {
    if (!texture || !TEXTURES.includes(texture.sound)) throw new Error(`${label} : texture inconnue. Consulte list_sounds.`);
    const { sound, bar = 1, beat = 0, duration = 2, level = 0.26, pan = 0, timbre = 0.5, midi } = texture;
    const pulses = section.meter?.[0] ?? 4;
    if (!Number.isInteger(bar) || bar < 1 || bar > section.bars || !Number.isFinite(beat) || beat < 0 || beat >= pulses ||
        !Number.isFinite(duration) || duration < 0.08 || duration > 32 || !Number.isFinite(level) || level < 0.02 || level > 1 ||
        !Number.isFinite(pan) || Math.abs(pan) > 1 || !Number.isFinite(timbre) || timbre < 0 || timbre > 1 ||
        (midi !== undefined && (!Number.isInteger(midi) || midi < 0 || midi > 127))) {
      throw new Error(`${label} : position, durée, niveau ou timbre de texture invalide.`);
    }
    return { sound, bar, beat, duration, level, pan, timbre, ...(midi === undefined ? {} : { midi }) };
  });
  return { ...(color === undefined ? {} : { color }), ...(instruments === undefined ? {} : { instruments }),
    ...(notes === undefined ? {} : { textures: notes }), ...(orchestral === undefined ? {} : { orchestral_percussion: orchestral }) };
}

function automaticSounds(section, index, count, seed) {
  const first = index === 0, last = index + 1 === count && count > 2;
  const close = last && (['outro', 'Cadence'].includes(section.name) || section.energy <= 0.7);
  const high = !first && !close && (section.energy >= 0.82 || index === Math.floor(count / 2));
  const open = !first && !close && !high;
  const beats = section.meter?.[0] ?? 4;
  const instruments = first ? { arp: 'electric-clean', pad: 'tape-keys' }
    : close ? { pad: 'electric-swell', mel: 'tape-keys' }
      : high ? { pad: 'granular-pad', arp: 'electric-drive', mel: 'glass-keys', counter: 'bowed-metal', bass: 'sub-pulse' }
        : { pad: 'electric-swell', arp: 'electric-clean', mel: 'tape-keys', counter: 'glass-keys' };
  const textures = first || close ? [{ sound: 'tape-air', bar: 1, duration: Math.min(12, beats * section.bars), level: close ? 0.2 : 0.24 }]
    : high ? [{ sound: 'dark-impact', bar: 1, duration: 0.45, level: 0.33 }]
      : [{ sound: 'iron-scrape', bar: 1, duration: beats * 0.85, level: 0.31, pan: seed % 2 ? 0.18 : -0.18 }];
  if (index + 1 < count && !close) textures.push({ sound: 'reverse-swell', bar: section.bars, beat: beats * 0.43,
    duration: beats * 0.57, level: high ? 0.25 : 0.39 });
  return { instruments, color: first ? 'radio' : close ? 'warm' : open ? 'warm' : 'wide', textures };
}

function applySounds(song, design = 'classic', options = {}) {
  if (!SOUND_DESIGNS.includes(design)) throw new Error('sound_design attend classic ou evolving.');
  const source = song.meta.sections;
  if (design === 'classic' && !source.some((s) => s.color || s.instruments || s.textures)) return song;
  const positions = new Map();
  const noiseEvents = [];
  const sections = source.map((section, i) => {
    const auto = design === 'evolving' ? automaticSounds(section, i, source.length, song.meta.seed) : {};
    const instruments = Object.fromEntries(Object.entries(auto.instruments ?? {})
      .filter(([role]) => section.parts.includes(role) && !options.protect?.includes(role)));
    Object.assign(instruments, section.instruments);
    const color = section.color ?? auto.color ?? 'natural';
    const values = { ...section, color, instruments, textures: section.textures ?? (options.solo ? [] : auto.textures ?? []) };
    const sound = readSectionSounds(values, `Section ${i + 1}`);
    for (const inst of Object.values(sound.instruments)) {
      if (isCustom(inst) && !Object.hasOwn(song.patches ?? {}, inst)) throw new Error(`Son personnel absent : ${inst}. Fournis son patch_path.`);
    }
    const parts = [...new Set([...section.parts, ...(sound.textures?.length ? ['texture'] : [])])];
    const final = { ...section, ...sound, parts };
    const first = section.startBar - 1;
    for (let bar = first; bar < first + section.bars; bar++) positions.set(bar, final);
    const unit = 4 / (section.meter?.[0] ?? 4);
    const root = parseKey(section.key ?? song.meta.key)?.root ?? 0;
    for (const [j, fx] of final.textures.entries()) {
      const beat = (first + fx.bar - 1) * 4 + fx.beat * unit;
      const midi = fx.midi ?? 48 + root;
      noiseEvents.push({ t: beat, beat, dur: Math.min(fx.duration * unit, (first + section.bars) * 4 - beat), midi, freq: midiToFreq(midi),
        vel: fx.level, pan: fx.pan, timbre: fx.timbre, inst: fx.sound, bus: 'texture', take: j,
        seedIdx: hash32(song.meta.seed, (i + 1) * 163 + j) });
    }
    return final;
  });
  const events = song.events.map((event) => {
    const section = positions.get(Math.floor((event.beat ?? event.t) / 4));
    const inst = section?.instruments[event.bus];
    if (inst === undefined || event.inst === 'sub') return event;
    let midi = event.midi;
    if (inst.startsWith('electric-')) while (midi > 77) midi -= 12;
    return { ...event, inst, midi, freq: midiToFreq(midi), ...(SOUNDS[inst] ? { timbre: 0.35 + section.energy * 0.28 } : {}) };
  });
  return { ...song, events: events.concat(noiseEvents), bankVersion: 3,
    meta: { ...song.meta, sections, soundDesign: design, instruments: [...new Set([...events, ...noiseEvents].map((event) => event.drum ? 'drum' : event.inst))] } };
}

module.exports = { SOUND_DESIGNS, SOUND_PARTS, TEXTURES, readSectionSounds, applySounds };
