'use strict';

const { ui } = require('./language');
const { TOOLS, CONFLICT_TOOLS, CONFLICT_POLICIES } = require('./tools');
const { EXTENDED_ACTIONS, FILE_TYPES } = require('./output-library');

const text = { type: 'string' };
const id = { type: 'string', minLength: 1 };
const integer = { type: 'integer', minimum: 0 };
const object = { type: 'object' };
const asset = {
  type: 'object',
  required: ['file_id', 'render_id', 'path', 'state'],
  properties: {
    file_id: id, render_id: id, path: id, current_path: id, archive_path: id,
    state: { enum: ['active', 'archived', 'missing'] }, file_type: { enum: FILE_TYPES },
    tool: text, created_at: text, source: object, render_settings: object,
  },
};
const delivery = {
  type: 'object',
  required: ['output_dir', 'render_id', 'files', 'state'],
  properties: {
    output_dir: id, render_id: id, tool: text, created_at: text, source: object, render_settings: object,
    state: { enum: ['active', 'archived', 'partial', 'missing'] },
    files: { type: 'array', items: asset }, related_render_ids: { type: 'array', items: id },
  },
};

const example = {
  play_sound: [{ instrument: 'piano', notes: [{ at: 0, pitch: 'C4' }] }, { sounds: ['piano', 'harp'] }],
  compare_sounds: [{ sounds: [{ instrument: 'clarinet' }, { instrument: 'flute' }],
    notes: [{ at: 0, pitch: 'A4', duration: 0.8 }], blind: true, seed: 7 }],
  analyze_music: [{ wav_path: 'master.wav' }, { project_path: 'esquisse.soundmcp.json' }],
  draft_music: [
    { brief: ui('20 secondes, menace discrète et piano feutré', '20 seconds, soft piano and quiet tension'), variants: 2 },
    { briefs: [ui('Jazz calme au piano', 'Calm piano jazz'), ui('Lofi à la guitare', 'Guitar lofi'),
      ui('Cordes lentes en mineur', 'Slow strings in a minor key')] },
    { brief: ui('Développe cette mélodie en thème de village', 'Develop this melody into a village theme'), midi_motif: { path: 'theme.mid' } },
    { brief: ui('Développe ce passage dans une ambiance nocturne', 'Develop this passage for a nighttime scene'),
      source_excerpt: { project_path: 'esquisse.soundmcp.json', region: { start_bar: 5, bars: 4 } } },
  ],
  create_music: [{ style: 'lofi', format: 'wav' }, { style: 'lofi', format: 'wav', stems: true },
    { style: 'lofi', format: 'both', save_project: true }],
  edit_music: [{ project_path: 'esquisse.soundmcp.json', edits: [{ type: 'gain', section: 2, part: 'mel', db: -2 }] }],
  finish_music: [
    { project_path: 'esquisse.soundmcp.json', format: 'wav' },
    { project_path: 'esquisse.soundmcp.json', format: 'midi' },
    { project_path: 'esquisse.soundmcp.json', format: 'wav', stems: true },
    { project_path: 'esquisse.soundmcp.json', format: 'wav', adaptive: { loop_region: { start_bar: 2, bars: 4 } } },
  ],
  calibrate_sound: [
    { patch_path: 'timbre.soundmcp-patch.json', role: 'bass', notes: ['C2', 'G2', 'C3'], seed: 7 },
    { patch_path: 'timbre.soundmcp-patch.json', role: 'mel', notes: ['C3', 'C4', 'C5'], seed: 7 },
  ],
  learn_music_preference: [{ comparison_path: 'comparaison.json', chosen: 'B', profile_path: 'preferences.json' }],
};

const guidance = {
  play_sound: ui('Avec sounds, markers donne le temps de départ de chaque exemple dans le même WAV.',
    'With sounds, markers gives the start time of each example in the single WAV.'),
  compare_sounds: ui('Une même seed et les mêmes sources reproduisent l’ordre des prises à l’aveugle. Lis reveal_path après le choix.',
    'The same seed and sources reproduce the blind take order. Read reveal_path after the listener chooses.'),
  edit_music: ui('Les retouches s’appliquent dans l’ordre avant le mix et l’export. Passe versions[].project_path à preview_music pour vérifier la copie.',
    'Edits apply in order before mixing and exporting. Pass versions[].project_path to preview_music to check the copy.'),
  calibrate_sound: ui('Choisis des notes couvrant le registre réellement joué. Réutilise calibration_path avec le même patch et le même pupitre, et seed pour reproduire la mesure.',
    'Choose notes spanning the range actually played. Reuse calibration_path with the same patch and part, and seed to reproduce the measurement.'),
  learn_music_preference: ui('La préférence du critère choisi est remplacée et les autres sont conservées. Réutilise profile_path dans draft_music. Si le manifeste est invalide, relance la comparaison et demande un nouveau choix.',
    'The selected criterion is replaced and other preferences are kept. Reuse profile_path in draft_music. For an invalid manifest, rerun the comparison and ask for a new choice.'),
};

function studioInventory(tool) {
  const base = tool.inputSchema.properties;
  const identifier = (description) => ({ ...id, description });
  return {
    ...tool,
    description: ui(
      'Gère les fichiers déjà rendus, dans le dossier output_dir de managed_outputs. Utilise list pour retrouver leurs identifiants, avec state et file_type pour filtrer et next_offset pour continuer. Utilise get avec file_id pour un fichier ou render_id pour la livraison, puis ouvre current_path. Archive déplace les fichiers hors de leurs chemins actifs et restore les y remet. Pour une boucle ou des pistes séparées, passe render_id pour garder les liens entre manifeste et WAV. Si une destination est occupée, libère-la puis relance la même action. list_catalog sert à choisir un preset intégré.',
      'Manage files already rendered in the output_dir from managed_outputs. Use list to find their IDs, with state and file_type to filter and next_offset to continue. Use get with file_id for one file or render_id for the delivery, then open current_path. archive moves files out of their active paths and restore puts them back. Use render_id for a loop or stems to preserve links between the manifest and WAVs. If a destination is occupied, free it and repeat the same action. Use list_catalog to choose a built-in preset.',
    ),
    inputSchema: {
      type: 'object', required: ['action'],
      properties: { ...base,
        action: { ...base.action, enum: EXTENDED_ACTIONS, description: ui(
          'list parcourt les fichiers, get retrouve un identifiant, archive déplace et restore remet en place.',
          'list browses files, get resolves an ID, archive moves files out, and restore puts them back.',
        ) },
        file_id: identifier(ui('Identifiant d’un fichier pour get, archive ou restore.', 'File ID for get, archive, or restore.')),
        render_id: identifier(ui(
          'Valeur managed_outputs.render_id. Filtre list ou cible une livraison entière pour get, archive et restore.',
          'managed_outputs.render_id. Filter list, or target one whole delivery for get, archive, and restore.',
        )),
        file_type: { ...base.file_type, enum: FILE_TYPES, description: ui(
          'Pour list, sélectionne un projet éditable, un WAV, un MIDI ou un autre JSON.',
          'With list, select an editable project, WAV, MIDI, or other JSON.',
        ) },
      },
      oneOf: [
        { properties: { action: { const: 'list' } }, not: { required: ['file_id'] } },
        { properties: { action: { enum: ['get', 'archive', 'restore'] } }, oneOf: [{ required: ['file_id'] }, { required: ['render_id'] }] },
      ],
      examples: [{ action: 'list', file_type: 'project', state: 'active', limit: 10 },
        { action: 'get', file_id: 'render-id:0' }, { action: 'archive', render_id: 'render-id' }],
    },
    outputSchema: { type: 'object', anyOf: [
      { type: 'object', required: ['output_dir', 'files', 'total', 'next_offset'], properties: {
        output_dir: id, files: { type: 'array', items: asset }, total: integer, next_offset: { type: ['integer', 'null'] },
      } },
      { ...asset, required: ['output_dir', ...asset.required], properties: { ...asset.properties, output_dir: id } },
      delivery,
    ] },
  };
}

const STUDIO_TOOLS = TOOLS.map((tool) => {
  if (tool.name === 'manage_outputs') return studioInventory(tool);
  const props = tool.inputSchema.properties;
  const inputSchema = {
    ...tool.inputSchema,
    ...(example[tool.name] && { examples: example[tool.name] }),
    ...(CONFLICT_TOOLS.has(tool.name) && { properties: { ...props, on_conflict: {
      type: 'string', enum: CONFLICT_POLICIES, default: 'replace', description: ui(
        'replace conserve l’écriture habituelle. unique crée un dossier distinct. reuse reprend un rendu identique actif ou crée un dossier distinct.',
        'replace keeps the usual write behavior. unique creates a separate folder. reuse returns an identical active render or creates a separate folder.',
      ),
    } } }),
  };
  const output = tool.outputSchema;
  const managed = output.properties?.managed_outputs;
  const outputSchema = managed ? { ...output, properties: { ...output.properties, managed_outputs: {
    ...managed,
    required: [...managed.required, 'render_id'],
    properties: { ...managed.properties, render_id: { ...id, description: ui(
      'Identifiant de la livraison pour retrouver, archiver ou restaurer tous ses fichiers ensemble.',
      'Delivery ID for finding, archiving, or restoring all of its files together.',
    ) } },
  } } } : output;
  const description = tool.name === 'analyze_music' ? ui(
    'Mesure la sonie, les crêtes, la saturation et la stéréo d’une seule source locale. Donne wav_path pour contrôler le master exact livré, ou project_path pour obtenir aussi un diagnostic par pupitre avant export. L’analyse rend en mémoire et écrit seulement les mesures dans la réponse. Passe suggestedEdits à edit_music, inspecte les accords avec inspect_score ou exporte une préécoute avec preview_music.',
    'Measure loudness, peaks, clipping, and stereo for one local source. Pass wav_path to check the exact delivered master, or project_path for per-part checks before export. Analysis renders in memory and returns measurements. Pass suggestedEdits to edit_music, check chords with inspect_score, or export a listening clip using preview_music.',
  ) : [tool.description, guidance[tool.name]].filter(Boolean).join('\n');
  return { ...tool, inputSchema, outputSchema, description };
});

module.exports = { STUDIO_TOOLS };
