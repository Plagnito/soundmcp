'use strict';

const { ui } = require('./language');

const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { makeRng } = require('./rng');

const WAVES = ['sine', 'triangle', 'saw', 'pulse', 'white', 'pink', 'brown'];
const FILTERS = ['lowpass', 'highpass', 'bandpass', 'notch'];
const LFO_WAVES = ['sine', 'triangle', 'step'];
const TARGETS = { pitch: 240, gain: 0.9, cutoff: 4, pan: 0.9, pulse: 0.35 };
const MAX_GLIDE_MS = 6000;
const PATCH_ROLES = ['mel', 'pad', 'arp', 'bass', 'counter', 'texture'];
const isCustom = (id) => typeof id === 'string' && /^custom-[a-z0-9][a-z0-9-]{0,63}$/.test(id);

function object(value, label, keys, optional = false) {
  if (value === undefined && optional) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(ui(`${label} attend un objet.`, `${label} must be an object.`));
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown) throw new Error(ui(`${label}.${unknown} est inconnu.`, `Unknown field ${label}.${unknown}.`));
  return value;
}

function bounded(value, base, min, max, label) {
  if (value === undefined) return base;
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(ui(`${label} attend un nombre entre ${min} et ${max}.`, `${label} must be a number between ${min} and ${max}.`));
  return value;
}

function choice(value, base, names, label) {
  if (value === undefined) return base;
  if (!names.includes(value)) throw new Error(ui(`${label} attend ${names.join(', ')}.`, `${label} must be one of ${names.join(', ')}.`));
  return value;
}

function envelope(value, label) {
  const e = object(value, label, ['attack', 'decay', 'sustain', 'release'], true);
  return { attack: bounded(e.attack, 0.014, 0.002, 6, `${label}.attack`),
    decay: bounded(e.decay, 0.36, 0, 8, `${label}.decay`),
    sustain: bounded(e.sustain, 0.62, 0, 1, `${label}.sustain`),
    release: bounded(e.release, 0.35, 0.008, 4, `${label}.release`) };
}

function normalizeModal(value) {
  const label = 'patch.modal';
  const modal = object(value, label, ['modes', 'contact', 'damping', 'friction']);
  if (!Array.isArray(modal.modes) || modal.modes.length < 1 || modal.modes.length > 12) {
    throw new Error(ui('patch.modal.modes attend 1 à 12 résonances.', 'patch.modal.modes requires 1 to 12 resonances.'));
  }
  const modes = modal.modes.map((entry, i) => {
    const at = `${label}.modes[${i}]`;
    const mode = object(entry, at, ['ratio', 'gain', 'decay_seconds', 'position_node', 'pan']);
    const node = bounded(mode.position_node, 1, 1, 12, `${at}.position_node`);
    if (!Number.isInteger(node)) throw new Error(ui(`${at}.position_node attend un entier.`, `${at}.position_node must be an integer.`));
    return { ratio: bounded(mode.ratio, 1, 0.25, 32, `${at}.ratio`), gain: bounded(mode.gain, 0.6, 0, 1, `${at}.gain`),
      decay_seconds: bounded(mode.decay_seconds, 2.2, 0.025, 8, `${at}.decay_seconds`), position_node: node,
      pan: bounded(mode.pan, 0, -0.7, 0.7, `${at}.pan`) };
  });
  if (!modes.some(({ gain }) => gain > 0)) throw new Error(ui('Au moins une résonance doit avoir du gain.', 'At least one resonance must have positive gain.'));
  const normalized = { modes, contact: bounded(modal.contact, 0.15, 0, 0.7, `${label}.contact`),
    damping: bounded(modal.damping, 0, 0, 1, `${label}.damping`) };
  if (modal.friction !== undefined) {
    const at = `${label}.friction`;
    const friction = object(modal.friction, at, ['amount', 'roughness', 'motion_hz', 'attack_seconds']);
    normalized.friction = {
      amount: bounded(friction.amount, 0.72, 0.05, 1, `${at}.amount`),
      roughness: bounded(friction.roughness, 0.48, 0, 1, `${at}.roughness`),
      motion_hz: bounded(friction.motion_hz, 2.5, 0.05, 18, `${at}.motion_hz`),
      attack_seconds: bounded(friction.attack_seconds, 0.16, 0.008, 4, `${at}.attack_seconds`),
    };
  }
  return normalized;
}

function normalizeWaveguide(value) {
  const label = 'patch.waveguide';
  const waveguide = object(value, label, ['brightness', 'decay_seconds', 'stiffness', 'contact', 'release_damping', 'body']);
  const body = object(waveguide.body, `${label}.body`, ['frequency', 'resonance', 'mix'], true);
  return {
    brightness: bounded(waveguide.brightness, 0.52, 0, 1, `${label}.brightness`),
    decay_seconds: bounded(waveguide.decay_seconds, 2.8, 0.12, 8, `${label}.decay_seconds`),
    stiffness: bounded(waveguide.stiffness, 0.24, 0, 1, `${label}.stiffness`),
    contact: bounded(waveguide.contact, 0.14, 0, 0.7, `${label}.contact`),
    release_damping: bounded(waveguide.release_damping, 0.44, 0, 1, `${label}.release_damping`),
    body: {
      frequency: bounded(body.frequency, 190, 45, 1800, `${label}.body.frequency`),
      resonance: bounded(body.resonance, 1.8, 0.4, 8, `${label}.body.resonance`),
      mix: bounded(body.mix, 0.28, 0, 0.75, `${label}.body.mix`),
    },
  };
}

const supportsGesture = (patch) => Boolean(patch?.modal || patch?.waveguide);
const GESTURE_PATCH_ERROR = ui('gesture attend un instrument créé avec patch.modal ou patch.waveguide.',
  'gesture requires an instrument created with patch.modal or patch.waveguide.');

function normalizeGesture(value) {
  if (value === undefined) return undefined;
  const fields = ['position', 'hardness', 'damping', 'glide_ms'];
  const gesture = object(value, 'gesture', fields);
  return Object.fromEntries(fields.filter((key) => gesture[key] !== undefined).map((key) => [key,
    bounded(gesture[key], undefined, 0, key === 'glide_ms' ? MAX_GLIDE_MS : 1, `gesture.${key}`)]));
}

function normalizePatch(value) {
  const raw = object(value, 'patch', ['layers', 'filter', 'lfos', 'effects', 'modal', 'waveguide']);
  if (raw.modal !== undefined) {
    object(raw, 'patch', ['modal']);
    return { modal: normalizeModal(raw.modal) };
  }
  if (raw.waveguide !== undefined) {
    object(raw, 'patch', ['waveguide']);
    return { waveguide: normalizeWaveguide(raw.waveguide) };
  }
  if (!Array.isArray(raw.layers) || raw.layers.length < 1 || raw.layers.length > 8) throw new Error(ui('patch.layers attend 1 à 8 sources.', 'patch.layers requires 1 to 8 sources.'));
  const layers = raw.layers.map((entry, i) => {
    const label = `layers[${i}]`;
    const layer = object(entry, label, ['wave', 'gain', 'ratio', 'detune_cents', 'pan', 'pulse_width', 'envelope', 'pitch_drop', 'fm']);
    const drop = object(layer.pitch_drop, `${label}.pitch_drop`, ['cents', 'seconds'], true);
    const fm = object(layer.fm, `${label}.fm`, ['ratio', 'index'], true);
    return { wave: choice(layer.wave, 'sine', WAVES, `${label}.wave`), gain: bounded(layer.gain, 0.55, 0, 1, `${label}.gain`),
      ratio: bounded(layer.ratio, 1, 0.125, 16, `${label}.ratio`), detune_cents: bounded(layer.detune_cents, 0, -240, 240, `${label}.detune_cents`),
      pan: bounded(layer.pan, 0, -1, 1, `${label}.pan`), pulse_width: bounded(layer.pulse_width, 0.5, 0.08, 0.92, `${label}.pulse_width`),
      envelope: envelope(layer.envelope, `${label}.envelope`),
      pitch_drop: { cents: bounded(drop.cents, 0, -3200, 3200, `${label}.pitch_drop.cents`), seconds: bounded(drop.seconds, 0.1, 0.004, 4, `${label}.pitch_drop.seconds`) },
      fm: { ratio: bounded(fm.ratio, 2, 0.125, 16, `${label}.fm.ratio`), index: bounded(fm.index, 0, 0, 7, `${label}.fm.index`) } };
  });
  if (!layers.some((layer) => layer.gain > 0)) throw new Error(ui('Au moins une source doit avoir du gain.', 'At least one source must have positive gain.'));
  const f = object(raw.filter, 'filter', ['type', 'frequency', 'q', 'envelope_octaves'], true);
  const filter = { type: choice(f.type, 'lowpass', FILTERS, 'filter.type'), frequency: bounded(f.frequency, 12000, 30, 18000, 'filter.frequency'),
    q: bounded(f.q, 0.707, 0.2, 10, 'filter.q'), envelope_octaves: bounded(f.envelope_octaves, 0, -5, 5, 'filter.envelope_octaves') };
  const rawLfos = raw.lfos ?? [];
  if (!Array.isArray(rawLfos) || rawLfos.length > 5) throw new Error(ui('lfos attend jusqu’à cinq modulations.', 'lfos allows up to five modulations.'));
  const lfos = rawLfos.map((entry) => {
    const lfo = object(entry, 'lfo', ['target', 'rate', 'depth', 'wave']);
    const target = choice(lfo.target, 'pitch', Object.keys(TARGETS), 'lfo.target');
    return { target, rate: bounded(lfo.rate, 1.4, 0.03, 42, 'lfo.rate'), depth: bounded(lfo.depth, 0, 0, TARGETS[target], 'lfo.depth'),
      wave: choice(lfo.wave, 'sine', LFO_WAVES, 'lfo.wave') };
  });
  const effect = object(raw.effects, 'effects', ['drive', 'chorus', 'bits', 'delay'], true);
  const delay = object(effect.delay, 'effects.delay', ['time_ms', 'feedback', 'mix'], true);
  const bits = bounded(effect.bits, 16, 4, 16, 'effects.bits');
  if (!Number.isInteger(bits)) throw new Error(ui('effects.bits attend un entier.', 'effects.bits must be an integer.'));
  const effects = { drive: bounded(effect.drive, 0, 0, 1, 'effects.drive'), chorus: bounded(effect.chorus, 0, 0, 0.8, 'effects.chorus'), bits,
    delay: { time_ms: bounded(delay.time_ms, 260, 20, 750, 'effects.delay.time_ms'), feedback: bounded(delay.feedback, 0.28, 0, 0.72, 'effects.delay.feedback'),
      mix: bounded(delay.mix, 0, 0, 0.66, 'effects.delay.mix') } };
  return { layers, filter, lfos, effects };
}

function createPatch(label, patch) {
  if (typeof label !== 'string' || !label.trim() || label.length > 80) throw new Error(ui('Le nom du son doit faire entre 1 et 80 caractères.', 'The sound name must contain 1 to 80 characters.'));
  const clean = label.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'son';
  const normalized = normalizePatch(patch);
  const hash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 10);
  return { id: `custom-${clean}-${hash}`, label: label.trim(), patch: normalized };
}

function patchFromBrief(brief, seed) {
  if (typeof brief !== 'string' || !brief.trim() || brief.length > 1000) throw new Error(ui('brief attend 1 à 1000 caractères.', 'brief must contain 1 to 1000 characters.'));
  const t = brief.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const rng = makeRng(seed);
  if (/\b(frottement continu|metal frotte|continuous friction|sustained scrape)\b/.test(t)) {
    return { modal: {
      modes: [
        { ratio: 1, gain: 0.82, decay_seconds: rng.f(0.62, 1.18), position_node: 1 },
        { ratio: rng.f(1.018, 1.07), gain: 0.58, decay_seconds: 0.52, position_node: 2 },
        { ratio: rng.f(2.12, 2.78), gain: 0.47, decay_seconds: 0.37, position_node: 3 },
      ],
      contact: 0.32, friction: { roughness: rng.f(0.46, 0.73), motion_hz: rng.f(1.6, 4.3) },
    } };
  }
  if (/\b(cordes? pincees?|plucked strings?|waveguide|guide d.onde)\b/.test(t)) {
    const nylon = /\b(nylon|doux|douce|feutre|sombre|soft|dark)\b/.test(t);
    return { waveguide: {
      brightness: nylon ? rng.f(0.3, 0.51) : rng.f(0.55, 0.78),
      stiffness: nylon ? rng.f(0.08, 0.25) : rng.f(0.28, 0.62),
      decay_seconds: rng.f(2.25, 3.9), contact: nylon ? rng.f(0.05, 0.15) : rng.f(0.12, 0.26),
      body: { frequency: rng.f(145, 245), mix: rng.f(0.23, 0.42) },
    } };
  }
  const dark = /\b(sombre|dark|enterre|voile|grave|muffled)\b/.test(t);
  const metallic = /\b(metal|metallique|metallic|verre|glass|cloche|bell|fm|clang)\b/.test(t);
  const noisy = /\b(bruit|noise|grain|granuleux|souffle|friction|sable)\b/.test(t);
  const short = /\b(court|short|percussif|percute|attaque|frappe|impact|pluck)\b/.test(t);
  const swell = /\b(gonfle|montee|lent|slow|swell|progressif|aspire|inverse)\b/.test(t);
  const pulse = /\b(pulse|pulsation|pulsatil|tremolo|oscille|vibre)\b/.test(t);
  const drop = /\b(descend|tombe|chute|falling|glisse)\b/.test(t);
  const distortion = /\b(sature|saturation|distorted|drive|rugueux|rough)\b/.test(t);
  const echo = /\b(echo|delay|lointain|resonne|reverbere)\b/.test(t);
  const wide = /\b(stereo|large|wide|derive|detune)\b/.test(t);
  const attack = swell ? rng.f(0.55, 1.35) : short ? 0.006 : rng.f(0.033, 0.19);
  const decay = short ? rng.f(0.19, 0.46) : rng.f(0.43, 0.83);
  const sustain = short ? 0.06 : swell ? 0.83 : 0.59;
  const release = short ? rng.f(0.16, 0.49) : echo ? 0.97 : rng.f(0.42, 0.82);
  const env = { attack, decay, sustain, release };
  const layers = [{ wave: dark ? 'triangle' : metallic ? 'sine' : 'pulse', ratio: 1, gain: dark ? 0.68 : 0.5, envelope: env,
    pulse_width: rng.f(0.27, 0.65), pitch_drop: { cents: drop ? rng.f(390, 1100) : 0, seconds: rng.f(0.09, 0.26) },
    fm: { ratio: metallic ? rng.f(1.65, 4.44) : 2, index: metallic ? rng.f(0.87, 2.65) : 0 } }];
  if (metallic || wide || !noisy) layers.push({ wave: metallic ? 'sine' : 'triangle', ratio: metallic ? rng.f(2.1, 4.1) : 1,
    gain: metallic ? 0.36 : 0.25, detune_cents: wide ? rng.f(7, 31) : rng.f(-6, 6), pan: wide ? 0.55 : 0.18,
    envelope: { attack: attack * 1.18, decay: decay * 0.75, sustain: sustain * 0.57, release: release * 0.8 },
    fm: { ratio: rng.f(1.4, 3.5), index: metallic ? rng.f(0.49, 2.6) : 0 } });
  if (noisy) layers.push({ wave: dark ? 'brown' : 'pink', gain: rng.f(0.13, 0.36), pan: -0.32,
    envelope: { attack: Math.max(0.002, attack * 0.74), decay: decay * 0.96, sustain: sustain * 0.7, release: release * 0.8 } });
  if (/\b(sub|tres grave|low|bourdon)\b/.test(t)) layers.push({ wave: 'sine', ratio: 0.5, gain: 0.28, envelope: env });
  const hz = /\b(?:filtre|cutoff|coupure)\D{0,18}(\d{2,5})\s*hz\b/.exec(t);
  const lfos = [{ target: 'pitch', rate: rng.f(0.22, 2.2), depth: wide ? rng.f(4, 14) : rng.f(0.8, 3.7), wave: 'sine' }];
  if (pulse) lfos.push({ target: 'gain', rate: rng.f(1.45, 6.3), depth: rng.f(0.3, 0.66), wave: 'triangle' });
  if (swell || noisy) lfos.push({ target: 'cutoff', rate: rng.f(0.32, 2.35), depth: rng.f(0.18, 1.2), wave: noisy ? 'step' : 'sine' });
  if (wide) lfos.push({ target: 'pan', rate: rng.f(0.14, 0.47), depth: 0.36 });
  return { layers, lfos, filter: { type: /\b(radio|bande etroite|bandpass)\b/.test(t) ? 'bandpass' : 'lowpass',
    frequency: hz ? Math.max(30, Math.min(18000, Number(hz[1]))) : dark ? rng.f(430, 1370) : rng.f(2400, 7500),
    q: metallic ? rng.f(1.15, 2.45) : rng.f(0.6, 1), envelope_octaves: swell ? rng.f(0.7, 2.2) : rng.f(0, 0.5) },
    effects: { drive: distortion ? rng.f(0.31, 0.72) : 0, chorus: wide ? rng.f(0.23, 0.56) : 0,
      bits: /\b(bitcrush|8 bits|crush)\b/.test(t) ? 8 : 16,
      delay: { time_ms: rng.f(125, 465), mix: echo ? rng.f(0.16, 0.34) : 0, feedback: rng.f(0.2, 0.53) } } };
}

function validatePatches(patches) {
  if (patches === undefined) return {};
  if (!patches || typeof patches !== 'object' || Array.isArray(patches) || Object.keys(patches).length > 16) throw new Error(ui('Jusqu’à 16 sons personnels par projet.', 'A project can use up to 16 custom sounds.'));
  return Object.fromEntries(Object.entries(patches).map(([id, patch]) => {
    if (!isCustom(id)) throw new Error(ui(`Identifiant de son personnel invalide : ${id}.`, `Invalid custom sound ID: ${id}.`));
    return [id, normalizePatch(patch)];
  }));
}

function readPatch(file) {
  if (typeof file !== 'string' || !file.trim()) throw new Error(ui('Indique un chemin de patch SoundMCP.', 'Supply a SoundMCP patch path.'));
  if (fs.statSync(file).size > 128 * 1024) throw new Error(ui('Fichier de son personnel trop volumineux.', 'Custom sound file is too large.'));
  const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (data?.type !== 'soundmcp-patch' || data.version !== 1) throw new Error(ui('Fichier son personnel SoundMCP attendu.', 'Expected a SoundMCP custom sound file.'));
  return createPatch(data.label, data.patch);
}

function importPatches(paths, previous) {
  const imported = validatePatches(previous);
  if (paths === undefined) return imported;
  if (!Array.isArray(paths) || paths.length > 16 || paths.some((p) => typeof p !== 'string' || !p.trim())) throw new Error(ui('patch_paths attend jusqu’à 16 chemins.', 'patch_paths allows up to 16 paths.'));
  for (const file of paths) {
    const normalized = readPatch(file);
    imported[normalized.id] = normalized.patch;
  }
  return validatePatches(imported);
}

function assignPatchRoles(song, roles, patches) {
  if (roles === undefined) return Object.keys(patches).length ? { ...song, patches } : song;
  const mapping = object(roles, 'patch_roles', PATCH_ROLES);
  for (const version of Object.values(mapping)) {
    if (!isCustom(version) || !Object.hasOwn(patches, version)) throw new Error(ui(`Son personnel absent : ${version}. Fournis son patch_path.`, `Custom sound not found: ${version}. Supply its patch_path.`));
  }
  for (const role of Object.keys(mapping)) {
    if (!song.events.some((event) => event.bus === role && event.inst !== 'sub')) throw new Error(ui(`Aucune note dans le pupitre ${role}.`, `No notes found in part ${role}.`));
  }
  const events = song.events.map((e) => mapping[e.bus] && e.inst !== 'sub' ? { ...e, inst: mapping[e.bus] } : e);
  const sections = song.meta.sections.map((section) => ({ ...section, instruments: {
    ...section.instruments, ...Object.fromEntries(Object.entries(mapping).filter(([part]) => part !== 'texture' && section.parts.includes(part))),
  } }));
  return { ...song, patches, patchRoles: mapping, events,
    meta: { ...song.meta, sections, instruments: [...new Set(events.map((e) => e.drum ? 'drum' : e.inst))] } };
}

module.exports = { WAVES, FILTERS, LFO_WAVES, TARGETS, MAX_GLIDE_MS, PATCH_ROLES, normalizePatch, normalizeGesture,
  supportsGesture, GESTURE_PATCH_ERROR, createPatch, patchFromBrief, isCustom, validatePatches, readPatch, importPatches, assignPatchRoles };
