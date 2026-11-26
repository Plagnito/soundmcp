'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const RECORD_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const ACTIONS = ['list', 'archive', 'restore'];

function lstat(file) {
  try {
    return fs.lstatSync(file, { bigint: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  }
}

function inside(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error('Chemin de sortie invalide.');
  const resolved = path.resolve(root, relative);
  const back = path.relative(root, resolved);
  if (!back || back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) throw new Error('Fichier hors du dossier de sortie.');
  return resolved;
}

function directory(location, create = false) {
  let current = lstat(location);
  if (!current && create) {
    fs.mkdirSync(location, { recursive: true });
    current = lstat(location);
  }
  if (current && !current.isDirectory()) throw new Error('Dossier de gestion des sorties invalide.');
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
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
}

function recordOutputs(outputDir, tool, files) {
  const store = library(outputDir, true);
  const entries = [...new Set(files)].map((file) => {
    const relative = path.relative(outputDir, file);
    return { relative, fingerprint: fingerprint(inside(store.root, relative)) };
  }).filter((entry) => entry.fingerprint);
  if (!entries.length) return undefined;
  const id = randomUUID();
  const created_at = new Date().toISOString();
  const record = { tool, created_at, entries };
  const temporary = path.join(store.base, `${id}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(record), { flag: 'wx' });
    fs.renameSync(temporary, path.join(store.base, `${id}.json`));
  } finally {
    if (lstat(temporary)) fs.unlinkSync(temporary);
  }
  return { output_dir: outputDir, files: entries.map(({ relative }, index) => ({ file_id: `${id}:${index}`, path: inside(outputDir, relative) })) };
}

function readRecord(store, id) {
  const file = path.join(store.base, `${id}.json`);
  if (!lstat(file)?.isFile()) throw new Error('Sortie inconnue dans ce dossier.');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function locate(store, id, entry) {
  const original = inside(store.root, entry.relative);
  if (typeof entry.fingerprint !== 'string' || !path.relative(store.base, original).startsWith(`..${path.sep}`)) {
    throw new Error('Enregistrement de sortie invalide.');
  }
  const archived = store.archive && inside(store.archive, id.replace(':', '-') + path.extname(original));
  return { original, archived, active: fingerprint(original) === entry.fingerprint,
    saved: Boolean(archived) && fingerprint(archived) === entry.fingerprint };
}

function ensureParent(root, destination) {
  let current = root;
  const relative = path.relative(root, path.dirname(destination));
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    directory(current, true);
  }
  if (path.relative(current, fs.realpathSync(current))) throw new Error('Le dossier de destination a été redirigé.');
}

function moveToFreePath(source, destination) {
  let handle;
  try {
    handle = fs.openSync(destination, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Un autre fichier occupe le chemin de destination.');
    throw error;
  }
  fs.closeSync(handle);
  const reservation = fingerprint(destination);
  try {
    fs.renameSync(source, destination);
  } finally {
    if (fingerprint(destination) === reservation) fs.unlinkSync(destination);
  }
}

function listOutputs(outputDir, store, { offset = 0, limit = 30 } = {}) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('offset doit être positif ou nul et limit compris entre 1 et 100.');
  }
  const files = [];
  for (const name of store ? fs.readdirSync(store.base) : []) {
    if (!name.endsWith('.json') || !RECORD_ID.test(name.slice(0, -5))) continue;
    const recordId = name.slice(0, -5);
    const record = readRecord(store, recordId);
    for (const [index, entry] of record.entries.entries()) {
      const id = `${recordId}:${index}`;
      const { original, archived, active, saved } = locate(store, id, entry);
      if (active || saved) files.push({ file_id: id, path: original, state: active ? 'active' : 'archived', tool: record.tool,
        created_at: record.created_at, ...(saved && !active ? { archive_path: archived } : {}) });
    }
  }
  files.sort((a, b) => b.created_at.localeCompare(a.created_at) || a.file_id.localeCompare(b.file_id));
  const page = files.slice(offset, offset + limit);
  return { output_dir: outputDir, files: page, total: files.length, next_offset: offset + page.length < files.length ? offset + page.length : null };
}

function manageOutputs(outputDir, args) {
  const { action, file_id: id } = args;
  if (!ACTIONS.includes(action)) throw new Error('action attend list, archive ou restore.');
  const store = library(outputDir);
  if (action === 'list') return listOutputs(outputDir, store, args);
  const [recordId, index, rest] = typeof id === 'string' ? id.split(':') : [];
  if (!store || !RECORD_ID.test(recordId ?? '') || !/^\d+$/.test(index ?? '') || rest !== undefined) throw new Error('Utilise un file_id renvoyé par manage_outputs dans le même dossier.');
  const entry = readRecord(store, recordId).entries[Number(index)];
  if (!entry) throw new Error('Sortie inconnue dans ce dossier.');
  const canonicalId = `${recordId}:${Number(index)}`;
  const lock = path.join(store.base, `${canonicalId.replace(':', '-')}.lock`);
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Une opération est déjà en cours pour cette sortie.');
    throw error;
  }
  try {
    const { original, archived, active, saved } = locate(store, canonicalId, entry);
    const restoring = action === 'restore';
    const source = restoring ? archived : original;
    const destination = restoring ? original : archived;
    const ready = restoring ? saved : active;
    const already = restoring ? active : saved;
    if (ready && !already) {
      if (!destination) throw new Error('Dossier d’archivage absent.');
      ensureParent(store.root, destination);
      if (fingerprint(source) !== entry.fingerprint) throw new Error('Le fichier a changé pendant le déplacement.');
      moveToFreePath(source, destination);
    } else if (!already) {
      throw new Error('La sortie a été déplacée, remplacée ou modifiée.');
    }
    return { file_id: canonicalId, path: original, state: restoring ? 'active' : 'archived', output_dir: outputDir, ...(!restoring ? { archive_path: archived } : {}) };
  } finally {
    fs.rmdirSync(lock);
  }
}

module.exports = { ACTIONS, recordOutputs, manageOutputs };
