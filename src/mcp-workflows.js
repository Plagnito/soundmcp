'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ui } = require('./language');
const { openRegisteredOutput } = require('./output-library');
const { SoundMcpError } = require('./tool-errors');

const MAX_RESOURCE_BYTES = 16 * 1024 * 1024;
const MIME_TYPES = { '.wav': 'audio/wav', '.mid': 'audio/midi', '.midi': 'audio/midi', '.json': 'application/json' };
const RESOURCE_TEMPLATE = {
  uriTemplate: 'soundmcp://outputs/{file_id}{?directory}',
  name: 'registered_output',
  title: ui('Sortie enregistrée', 'Registered output'),
  description: ui('Ouvre une sortie par file_id dans son dossier de rendu.', 'Read an output by file_id in its render directory.'),
};
const guides = {
  adaptive_loop: {
    title: ui('Préparer une boucle adaptative', 'Prepare an adaptive loop'),
    description: ui('Compare des raccords, puis livre intro, boucle et sortie avec leur manifeste.', 'Compare transitions, then deliver intro, loop, outro, and their manifest.'),
    arguments: [
      { name: 'project_path', required: true, description: ui('Chemin du projet éditable.', 'Path of the editable project.') },
      { name: 'section', required: false, description: ui('Section à auditionner.', 'Section to audition.') },
    ],
  },
  blind_timbres: {
    title: ui('Comparer des timbres à l’aveugle', 'Compare timbres blind'),
    description: ui('Prépare des prises anonymes de la même phrase à sonie égale.', 'Prepare anonymous loudness-matched takes of one phrase.'),
    arguments: [{ name: 'instruments', required: true, description: ui(
      'Deux à quatre identifiants de list_catalog séparés par des virgules.',
      'Two to four list_catalog IDs separated by commas.',
    ) }],
  },
};

function listPrompts(tools) {
  const names = new Set(tools.map(({ name }) => name));
  const available = [];
  if (names.has('compare_music_choices') && names.has('finish_music')) available.push('adaptive_loop');
  if (names.has('compare_sounds') || names.has('audition_sound')) available.push('blind_timbres');
  return available.map((name) => ({ name, ...guides[name] }));
}

function getPrompt(name, args, tools) {
  const prompt = listPrompts(tools).find((entry) => entry.name === name);
  if (!prompt) throw new SoundMcpError('PROMPT_NOT_FOUND', ui('Parcours inconnu dans ce profil.', 'Workflow not found in this toolset.'));
  for (const argument of prompt.arguments) {
    if ((argument.required || args[argument.name] !== undefined) &&
        (typeof args[argument.name] !== 'string' || !args[argument.name].trim())) {
      throw new SoundMcpError('INCOMPATIBLE_PARAMETERS', ui(`Renseigne ${argument.name}.`, `Supply ${argument.name}.`));
    }
  }
  let text;
  if (name === 'adaptive_loop') {
    const call = { project_path: args.project_path, criterion: 'loop', inline_audio: true, ...(args.section && { section: args.section }) };
    text = ui(
      `Appelle compare_music_choices avec ${JSON.stringify(call)}. Fais écouter les prises sur deux tours et attends le choix. Appelle ensuite finish_music avec project_path=${JSON.stringify(args.project_path)}, format="wav" et l’objet adaptive de la prise choisie. Remets adaptive.manifest_path et les trois WAV qui l’accompagnent.`,
      `Call compare_music_choices with ${JSON.stringify(call)}. Let the listener hear the two-turn takes and wait for their choice. Then call finish_music with project_path=${JSON.stringify(args.project_path)}, format="wav", and the selected take’s adaptive object. Deliver adaptive.manifest_path and its three WAV files.`,
    );
  } else {
    const sounds = args.instruments.split(',').map((name) => name.trim()).filter(Boolean).map((instrument) => ({ instrument }));
    if (sounds.length < 2 || sounds.length > 4) throw new SoundMcpError('INCOMPATIBLE_PARAMETERS', ui(
      'Donne deux à quatre identifiants de timbre.', 'Supply two to four instrument IDs.',
    ));
    const combined = tools.some((tool) => tool.name === 'audition_sound');
    const tool = combined ? 'audition_sound' : 'compare_sounds';
    const call = { ...(combined && { mode: 'comparison' }), sounds, blind: true };
    text = ui(
      `Appelle ${tool} avec ${JSON.stringify(call)}. Présente les prises anonymes à sonie égale. Ouvre reveal_path seulement après le choix pour retrouver le timbre retenu.`,
      `Call ${tool} with ${JSON.stringify(call)}. Present the anonymous loudness-matched takes. Open reveal_path after the listener chooses to identify the selected sound.`,
    );
  }
  return { description: prompt.description, messages: [{ role: 'user', content: { type: 'text', text } }] };
}

function outputUri(fileId, outputDir) {
  return `soundmcp://outputs/${encodeURIComponent(fileId)}?directory=${encodeURIComponent(outputDir)}`;
}

function readOutputResource(uri, defaultOutputDir) {
  let parsed;
  try { parsed = new URL(uri); } catch { /* invalid URI */ }
  if (parsed?.protocol !== 'soundmcp:' || parsed.host !== 'outputs' || !/^\/[^/]+$/.test(parsed.pathname) ||
      parsed.username || parsed.password || parsed.hash || [...parsed.searchParams.keys()].some((key) => key !== 'directory')) {
    throw new SoundMcpError('RESOURCE_NOT_FOUND', ui('Ressource SoundMCP inconnue.', 'Unknown SoundMCP resource.'));
  }
  let fileId;
  try { fileId = decodeURIComponent(parsed.pathname.slice(1)); } catch {
    throw new SoundMcpError('RESOURCE_NOT_FOUND', ui('Identifiant de ressource invalide.', 'Invalid resource identifier.'));
  }
  const outputDir = path.resolve(parsed.searchParams.get('directory') || defaultOutputDir);
  const { fd, path: file, bytes } = openRegisteredOutput(outputDir, fileId);
  try {
    const mimeType = MIME_TYPES[path.extname(file).toLowerCase()];
    if (!mimeType) throw new SoundMcpError('RESOURCE_NOT_FOUND', ui('Format de ressource inconnu.', 'Unsupported resource format.'));
    if (bytes > MAX_RESOURCE_BYTES) {
      throw new SoundMcpError('RESOURCE_TOO_LARGE', ui(
        'Cette sortie dépasse la limite de 16 Mio pour une ressource. Utilise son chemin local.',
        'This output exceeds the 16 MiB resource limit. Use its local path.',
      ));
    }
    const buffer = Buffer.alloc(Number(bytes));
    let offset = 0;
    while (offset < buffer.length) {
      const read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!read) throw new SoundMcpError('OUTPUT_CHANGED', ui('Le fichier a changé pendant la lecture.', 'The file changed during the read.'));
      offset += read;
    }
    return { contents: [{ uri, mimeType, ...(mimeType === 'application/json'
      ? { text: buffer.toString('utf8') } : { blob: buffer.toString('base64') }) }] };
  } finally {
    fs.closeSync(fd);
  }
}

function attachOutputResources(result) {
  const data = result.structuredContent;
  const tracked = data?.managed_outputs;
  const candidates = tracked?.files ?? (data?.file_id && data.current_path ? [data] : []);
  const outputDir = tracked?.output_dir ?? data?.output_dir;
  if (!outputDir || !candidates.length) return;
  const preferred = new Set([data.adaptive?.manifest_path, data.report_path, data.project_path, data.preview_path, data.path]);
  const selected = [...candidates.filter(({ path }) => preferred.has(path)), ...candidates.filter(({ path }) => !preferred.has(path))]
    .filter(({ path: file }) => MIME_TYPES[path.extname(file).toLowerCase()]).slice(0, 3);
  for (const file of selected) result.content.push({ type: 'resource_link', uri: outputUri(file.file_id, outputDir),
    name: path.basename(file.path), mimeType: MIME_TYPES[path.extname(file.path).toLowerCase()] });
}

module.exports = { RESOURCE_TEMPLATE, listPrompts, getPrompt, readOutputResource, attachOutputResources };
