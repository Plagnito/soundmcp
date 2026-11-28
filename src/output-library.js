'use strict';

const { ui } = require('./language');
const { SoundMcpError } = require('./tool-errors');

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const RECORD_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const ACTIONS = ['list', 'archive', 'restore'];
const EXTENDED_ACTIONS = ['list', 'get', 'archive', 'restore'];
const STATES = ['active', 'archived'];
const FILE_TYPES = ['project', 'wav', 'midi', 'json'];
const EXTENSIONS = { project: '.soundmcp.json', wav: '.wav', midi: '.mid', json: '.json' };

function lstat(file) {
  try {
    return fs.lstatSync(file, { bigint: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  }
}

function inside(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error(ui('Chemin de sortie invalide.', 'Invalid output path.'));
  const resolved = path.resolve(root, relative);
  const back = path.relative(root, resolved);
  if (!back || back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) throw new Error(ui('Fichier hors du dossier de sortie.', 'File is outside the output directory.'));
  return resolved;
}

function directory(location, create = false) {
  let current = lstat(location);
  if (!current && create) {
    fs.mkdirSync(location, { recursive: true });
    current = lstat(location);
  }
  if (current && !current.isDirectory()) throw new Error(ui('Dossier de gestion des sorties invalide.', 'Invalid output library directory.'));
  return current ? location : undefined;
}

function library(outputDir, create = false) {
  if (!lstat(outputDir)) return undefined;
  const root = fs.realpathSync(outputDir);
  const base = directory(path.join(root, '.soundmcp-outputs'), create);
  if (!base) return undefined;
  return { root, base, archive: directory(path.join(base, 'archive'), create) };
}

function fingerprint(file) {
  const stat = lstat(file);
  if (!stat) return undefined;
  if (!stat.isFile() || path.relative(file, fs.realpathSync(file))) return null;
  return fingerprintStat(stat);
}

function fingerprintStat(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
}

function recordOutputs(outputDir, tool, files, renderSettings, settingsByFile, { source, replay } = {}) {
  const store = library(outputDir, true);
  const entries = [...new Set(files)].map((file) => {
    const relative = path.relative(outputDir, file);
    const settings = settingsByFile?.get(file);
    return { relative, fingerprint: fingerprint(inside(store.root, relative)), ...(settings && { render_settings: settings }) };
  }).filter((entry) => entry.fingerprint);
  if (!entries.length) return undefined;
  const id = randomUUID();
  const created_at = new Date().toISOString();
  const record = { tool, created_at, entries, ...(renderSettings && { render_settings: renderSettings }),
    ...(source && { source }), ...(replay && { replay }) };
  const temporary = path.join(store.base, `${id}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(record), { flag: 'wx' });
    fs.renameSync(temporary, path.join(store.base, `${id}.json`));
  } finally {
    if (lstat(temporary)) fs.unlinkSync(temporary);
  }
  return managedRecord(outputDir, id, entries);
}

function managedRecord(outputDir, renderId, entries) {
  return { output_dir: outputDir, render_id: renderId,
    files: entries.map(({ relative }, index) => ({ file_id: `${renderId}:${index}`, path: inside(outputDir, relative) })) };
}

function outputNotFound() {
  return new SoundMcpError('OUTPUT_NOT_FOUND', ui('Sortie inconnue dans ce dossier.', 'Output not found in this directory.'),
    ui('Utilise le même output_dir que lors du rendu.', 'Use the same output_dir as the original render.'));
}

function readRecord(store, id) {
  if (!store || !RECORD_ID.test(id ?? '')) throw outputNotFound();
  const file = path.join(store.base, `${id}.json`);
  if (!lstat(file)?.isFile()) throw outputNotFound();
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(record?.entries)) throw new Error(ui('Enregistrement de sortie invalide.', 'Invalid output record.'));
  return record;
}

function recordIds(store) {
  return store ? fs.readdirSync(store.base).filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -5)).filter((id) => RECORD_ID.test(id)) : [];
}

function outputFileType(relative) {
  const name = relative.toLowerCase();
  return name.endsWith('.midi') ? 'midi' : FILE_TYPES.find((type) => name.endsWith(EXTENSIONS[type]));
}

function locate(store, id, entry) {
  const original = inside(store.root, entry.relative);
  if (typeof entry.fingerprint !== 'string' || !path.relative(store.base, original).startsWith(`..${path.sep}`)) {
    throw new Error(ui('Enregistrement de sortie invalide.', 'Invalid output record.'));
  }
  const renderId = id.split(':')[0];
  const nested = store.archive && inside(store.archive, path.join(renderId, entry.relative));
  const legacy = store.archive && inside(store.archive, id.replace(':', '-') + path.extname(original));
  const copies = [nested, legacy].filter((file) => file && fingerprint(file) === entry.fingerprint);
  return { original, nested, copies, archived: copies[0] ?? nested,
    active: fingerprint(original) === entry.fingerprint, saved: copies.length > 0 };
}

function ensureParent(root, destination) {
  let current = root;
  const relative = path.relative(root, path.dirname(destination));
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    directory(current, true);
  }
  if (path.relative(current, fs.realpathSync(current))) throw new Error(ui('Le dossier de destination a été redirigé.', 'The destination directory was redirected.'));
}

function occupied() {
  return new SoundMcpError('DESTINATION_OCCUPIED',
    ui('Un autre fichier occupe le chemin de destination.', 'Another file already exists at the destination.'),
    ui('Libère ce chemin puis relance la même action.', 'Free that path and retry the same action.'));
}

function unavailable() {
  return new SoundMcpError('OUTPUT_CHANGED',
    ui('La sortie a été déplacée, remplacée ou modifiée.', 'The output was moved, replaced, or modified.'));
}

function placeOutput(source, destination, expected, root) {
  if (fingerprint(destination) === expected) return;
  ensureParent(root, destination);
  if (fingerprint(source) !== expected) throw unavailable();
  try {
    fs.linkSync(source, destination);
  } catch (error) {
    if (error.code === 'EEXIST') throw occupied();
    if (!['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EINVAL'].includes(error.code)) throw error;
    // Some volumes allow rename but do not expose hard links.
    try {
      fs.closeSync(fs.openSync(destination, 'wx'));
    } catch (reservationError) {
      if (reservationError.code === 'EEXIST') throw occupied();
      throw reservationError;
    }
    const reservation = fingerprint(destination);
    try {
      if (fingerprint(source) !== expected || fingerprint(destination) !== reservation) throw unavailable();
      fs.renameSync(source, destination);
    } finally {
      if (reservation && fingerprint(destination) === reservation) fs.unlinkSync(destination);
    }
  }
}

function listOutputs(outputDir, store, { file_type, state, render_id, offset = 0, limit = 30 } = {}) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new SoundMcpError('INCOMPATIBLE_PARAMETERS', ui('offset doit être positif ou nul et limit compris entre 1 et 100.', 'offset must be zero or greater, and limit must be between 1 and 100.'));
  }
  if (file_type !== undefined && !FILE_TYPES.includes(file_type)) {
    throw new SoundMcpError('INCOMPATIBLE_PARAMETERS', ui('file_type attend project, wav, midi ou json.', 'file_type must be project, wav, midi, or json.'));
  }
  if (state !== undefined && !STATES.includes(state)) {
    throw new SoundMcpError('INCOMPATIBLE_PARAMETERS', ui('state attend active ou archived.', 'state must be active or archived.'));
  }
  const files = [];
  for (const recordId of render_id === undefined ? recordIds(store) : [render_id]) {
    const record = readRecord(store, recordId);
    for (const [index, entry] of record.entries.entries()) {
      if (file_type !== undefined && outputFileType(entry.relative) !== file_type) continue;
      const asset = describeAsset(store, recordId, record, entry, index);
      if (asset.state === 'missing' || (state !== undefined && state !== asset.state)) continue;
      files.push(asset);
    }
  }
  files.sort((a, b) => b.created_at.localeCompare(a.created_at) || a.file_id.localeCompare(b.file_id));
  const page = files.slice(offset, offset + limit);
  return { output_dir: outputDir, files: page, total: files.length, next_offset: offset + page.length < files.length ? offset + page.length : null };
}

function registeredOutput(store, id) {
  const [recordId, index, rest] = typeof id === 'string' ? id.split(':') : [];
  if (!store || !RECORD_ID.test(recordId ?? '') || !/^\d+$/.test(index ?? '') || rest !== undefined) {
    throw new SoundMcpError('OUTPUT_NOT_FOUND', ui('Utilise un file_id renvoyé par manage_outputs dans le même dossier.', 'Use a file_id returned by manage_outputs in the same directory.'));
  }
  const record = readRecord(store, recordId);
  const entry = record.entries[Number(index)];
  if (!entry) throw outputNotFound();
  return { recordId, record, entry, index: Number(index) };
}

function outputRenderSettings(outputDir, id, tool) {
  const { record, entry } = registeredOutput(library(outputDir), id);
  const settings = entry.render_settings ?? record.render_settings;
  if (record.tool !== tool || !settings) {
    throw new Error(ui(
      `Ce fichier ne contient pas de réglages réutilisables avec ${tool}. Indique kind pour créer un nouveau rendu.`,
      `This file has no settings that can be reused by ${tool}. Use kind for a new render.`,
    ));
  }
  return settings;
}

function describeAsset(store, recordId, record, entry, index) {
  const id = `${recordId}:${index}`;
  const { original, archived, active, saved } = locate(store, id, entry);
  return { file_id: id, render_id: recordId, path: original, file_type: outputFileType(entry.relative),
    state: active ? 'active' : saved ? 'archived' : 'missing', tool: record.tool, created_at: record.created_at,
    ...(active ? { current_path: original } : saved ? { current_path: archived, archive_path: archived } : {}) };
}

function describeRender(store, outputDir, renderId, record, related = false) {
  const files = record.entries.map((entry, index) => describeAsset(store, renderId, record, entry, index));
  const states = new Set(files.map(({ state }) => state));
  const source = record.source;
  const relatedIds = related ? recordIds(store).filter((id) => {
    if (id === renderId) return false;
    const { source: other } = readRecord(store, id);
    return other?.render_id === renderId || (other?.project_path && files.some(({ path: file }) => file === other.project_path));
  }) : undefined;
  return { output_dir: outputDir, render_id: renderId, tool: record.tool, created_at: record.created_at,
    state: states.size === 1 ? files[0].state : 'partial', files, ...(source && { source }),
    ...(record.render_settings && { render_settings: record.render_settings }),
    ...(relatedIds && { related_render_ids: relatedIds }) };
}

function reclaimInactiveLock(lock) {
  if (!lstat(lock)?.isDirectory()) return;
  let entries;
  try { entries = fs.readdirSync(lock); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!entries.length) {
    try { fs.rmdirSync(lock); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
    return;
  }
  const [owner] = entries;
  const match = entries.length === 1 && /^(\d+)-[a-f0-9-]{36}$/.exec(owner);
  if (!match) return;
  try {
    process.kill(Number(match[1]), 0);
    return;
  } catch (error) {
    if (error.code !== 'ESRCH') return;
  }
  try {
    fs.unlinkSync(path.join(lock, owner));
    fs.rmdirSync(lock);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  }
}

function withRenderLock(store, id, run) {
  const lock = path.join(store.base, `${id}.lock`);
  const stage = fs.mkdtempSync(path.join(store.base, `${id}.lock-`));
  const owner = `${process.pid}-${randomUUID()}`;
  let folder = stage;
  try {
    fs.writeFileSync(path.join(stage, owner), '');
    reclaimInactiveLock(lock);
    try {
      fs.renameSync(stage, lock);
    } catch (error) {
      if (lstat(lock)) throw new SoundMcpError('OUTPUT_BUSY', ui(
        'Une opération est déjà en cours pour cette sortie.', 'An operation is already in progress for this output.',
      ), ui('Réessaie dans un instant.', 'Retry shortly.'));
      throw error;
    }
    folder = lock;
    return run();
  } finally {
    const marker = path.join(folder, owner);
    if (lstat(marker)) fs.unlinkSync(marker);
    try { fs.rmdirSync(folder); } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
    }
  }
}

function moveEntries(store, renderId, members, restore) {
  const plans = members.map(({ entry, index }) => {
    const { original, nested, copies, active, saved } = locate(store, `${renderId}:${index}`, entry);
    const target = restore ? original : nested;
    if (!target || (!active && !saved)) throw unavailable();
    if (lstat(target) && fingerprint(target) !== entry.fingerprint) throw occupied();
    const sources = [...(active ? [original] : []), ...copies];
    return { target, sources, expected: entry.fingerprint };
  });
  for (const { target, sources, expected } of plans) {
    // Un lien déjà créé rend une reprise sûre, y compris entre link et unlink.
    placeOutput(sources[0], target, expected, store.root);
    for (const source of sources) {
      if (source !== target && fingerprint(source) === expected) fs.unlinkSync(source);
    }
  }
}

function manageOutputs(outputDir, { action, file_id, render_id, ...filters }) {
  if (!EXTENDED_ACTIONS.includes(action)) throw new SoundMcpError('INCOMPATIBLE_PARAMETERS', ui(
    'action attend list, get, archive ou restore.', 'action must be list, get, archive, or restore.',
  ));
  const store = library(outputDir);
  if (action === 'list') return listOutputs(outputDir, store, { ...filters, render_id });
  if ((file_id === undefined) === (render_id === undefined)) throw new SoundMcpError('INCOMPATIBLE_PARAMETERS',
    ui('Fournis un seul file_id ou render_id.', 'Supply exactly one file_id or render_id.'));
  const single = file_id === undefined ? undefined : registeredOutput(store, file_id);
  const id = single?.recordId ?? render_id;
  const record = single?.record ?? readRecord(store, id);
  const result = () => single
    ? { output_dir: outputDir, ...describeAsset(store, id, record, single.entry, single.index),
      ...(record.source && { source: record.source }), ...(single.entry.render_settings ?? record.render_settings
        ? { render_settings: single.entry.render_settings ?? record.render_settings } : {}) }
    : describeRender(store, outputDir, id, record, action === 'get');
  if (action === 'get') return result();
  const members = single ? [single] : record.entries.map((entry, index) => ({ entry, index }));
  return withRenderLock(store, id, () => {
    moveEntries(store, id, members, action === 'restore');
    return result();
  });
}

function findReplay(outputDir, key) {
  const store = library(outputDir);
  for (const id of recordIds(store)) {
    const record = readRecord(store, id);
    if (record.replay?.key === key && record.entries.every((entry, index) => locate(store, `${id}:${index}`, entry).active)) {
      const result = record.replay.result;
      result.structuredContent.managed_outputs = managedRecord(outputDir, id, record.entries);
      return result;
    }
  }
}

function openRegisteredOutput(outputDir, fileId) {
  const store = library(outputDir);
  const { recordId, entry, index } = registeredOutput(store, fileId);
  const { original, active, archived, saved } = locate(store, `${recordId}:${index}`, entry);
  const file = active ? original : saved ? archived : undefined;
  if (!file) throw unavailable();
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || fingerprintStat(stat) !== entry.fingerprint) throw unavailable();
    return { fd, path: file, bytes: stat.size };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

module.exports = { ACTIONS, STATES, EXTENDED_ACTIONS, FILE_TYPES, recordOutputs, outputRenderSettings, manageOutputs,
  findReplay, openRegisteredOutput };
