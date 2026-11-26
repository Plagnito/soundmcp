'use strict';

const { STATES: OUTPUT_STATES } = require('./output-library');

const text = { type: 'string' };
const path = { type: 'string', minLength: 1 };
const number = { type: 'number' };
const integer = { type: 'integer' };
const bool = { type: 'boolean' };
const numericOrNull = { type: ['number', 'null'] };
const offset = { type: ['integer', 'null'] };
const details = { type: 'object' };
const array = (items) => ({ type: 'array', items });
const object = (fields, optional = {}) => ({ type: 'object', properties: { ...fields, ...optional }, required: Object.keys(fields) });

const wav = { ...path, description: 'Chemin du fichier WAV généré.' };
const project = { ...path, description: 'Projet .soundmcp.json à transmettre à inspect_score, edit_music ou finish_music.' };
const patch = { ...path, description: 'Patch réutilisable dans play_sound ou dans patch_paths lors d’un arrangement.' };
const fileId = { ...text, description: 'Identifiant de la sortie dans son output_dir. Pour reprendre un effet ou une ambiance, donne cet identifiant comme source_file_id au même outil de création.' };
const file = object({ path, format: { type: 'string', enum: ['wav', 'midi', 'project', 'json'] }, bytes: integer });
const take = object({ label: text, path: wav, integratedLufs: numericOrNull }, { project_path: project });
const variantSound = object({ id: text, label: text, patch_path: patch, preview_path: wav });
const exported = object({ meta: details, files: array(file) }, { project_path: project, audio: details, editions: array(details) });
const savedExport = { ...exported, required: [...exported.required, 'project_path'] };
const waveStats = object({ durationSeconds: number, integratedLufs: numericOrNull, samplePeakDbfs: numericOrNull });
const renderSettings = { kind: text, seed: integer, volume: number, sampling_rate: integer, mono: bool };
const generatedWave = { path: wav, kind: text, seed: integer, durationSeconds: number, bytes: integer };
const managedOutputs = object({ output_dir: path, files: array(object({ file_id: fileId, path })) });
const asset = object({ file_id: fileId, path, state: { type: 'string', enum: OUTPUT_STATES } }, { archive_path: path, tool: text, created_at: text });
const draftCandidate = object({ id: { ...integer, description: 'Numéro de l’esquisse ou du morceau dans la liste.' },
  project_path: project, preview_path: wav, warnings: { ...array(text), description: 'Écarts au brief et avertissements techniques pour cette esquisse.' } }, {
  music: { ...details, description: 'Style, tempo en BPM, tonalité, durée musicale et instruments retenus pour ce morceau.',
    properties: { style: text, tempo: number, key: text, durationSeconds: number, instruments: array(text) } },
  brief: { ...text, description: 'Brief du morceau de la collection. Réutilise-le avec seed dans draft_music et variants=1 pour reprendre ce morceau seul.' },
  seed: { ...integer, description: 'Graine à transmettre à draft_music pour rejouer ce morceau seul.' },
  title: { ...text, description: 'Titre affiché du morceau.' },
});

const results = {
  design_sound: variantSound,
  play_sound: {
    ...object({ path: wav, seed: integer }, { sound: text, audio: waveStats, timbre: number,
      markers: array(object({ sound: text, label: text, from: number, integratedLufs: numericOrNull })) }),
    oneOf: [{ required: ['sound', 'audio'] }, { required: ['markers', 'timbre'] }],
  },
  calibrate_sound: object({ sound: text, role: text, probes: array(details),
    calibration_path: { ...path, description: 'Fichier à inclure dans calibration_paths pour appliquer les corrections.' } }),
  compare_sounds: object({ files: array(take) }, { reveal_path: path }),
  vary_sound: object({ reference: object({ id: text, label: text, preview_path: wav }), sounds: array(variantSound) }),
  list_catalog: object({ category: text, items: array(object({ id: text, description: text }, { label: text, part: text, source: text, tempo: number })) },
    { colors: details, instruments: array(text) }),
  draft_music: {
    ...object({ seed: integer,
      candidates: { ...array(draftCandidate), description: 'Esquisses issues d’un brief, ou un morceau par brief dans l’ordre fourni.' },
      firstToPreview: { ...integer, description: 'Identifiant de la préécoute suggérée en premier.' },
      report_path: { ...path, description: 'Manifeste local qui rassemble les préécoutes et les projets de cette génération.' },
    }, { mode: { const: 'collection', description: 'La réponse contient des morceaux indépendants.' }, title: text,
      shared_options: { ...details, description: 'Réglages explicites communs à recopier dans draft_music pour reprendre un morceau de la collection.' },
    }),
    if: { required: ['mode'] }, then: { required: ['title', 'shared_options'], properties: {
      candidates: { minItems: 3, maxItems: 6, items: { required: ['brief', 'seed', 'title'] } },
    } },
  },
  create_music: exported,
  edit_music: object({ versions: array(savedExport) }, { mix: array(details) }),
  finish_music: { ...savedExport, properties: { ...savedExport.properties, report_path: path, cuts: array(details) },
    required: [...savedExport.required, 'report_path'] },
  preview_music: object({ files: array(take) }, { reveal_path: path }),
  compare_music_choices: {
    ...object({ criterion: text, files: array(take) }, {
      comparison_path: { ...path, description: 'Pour learn_music_preference après choix explicite sur accompaniment ou breath.' },
      reveal_path: { ...path, description: 'Correspondance des variantes et des projets du critère build.' },
    }),
    oneOf: [
      { properties: { criterion: { enum: ['accompaniment', 'breath'] } }, required: ['comparison_path'] },
      { properties: { criterion: { const: 'build' } }, required: ['reveal_path'] },
    ],
  },
  learn_music_preference: object({ criterion: text, choice: text, choices: details,
    profile_path: { ...path, description: 'Profil local réutilisable dans draft_music.' } }),
  analyze_music: object({ ...waveStats.properties, warnings: array(text) }, {
    harmonicOverlaps: object({ total: integer, minimumSeconds: number, bars: array(details), examples: array(details) }),
  }),
  inspect_score: object({ start_bar: integer, bars: integer, measures: array(details),
    events: array(object({ bar: integer, part: text, instrument: text, beat: number, duration: number, played: details }, { pitch: integer, hit: text })),
    offset: integer, event_count: integer, next_offset: { ...offset, description: 'Valeur à passer dans offset pour la page suivante.' } }),
  manage_outputs: { type: 'object', oneOf: [
    object({ output_dir: path, files: array(asset), total: integer, next_offset: offset }),
    { ...asset, properties: { output_dir: path, ...asset.properties }, required: ['output_dir', ...asset.required] },
  ] },
  create_sfx: object({ ...generatedWave, render_settings: object(renderSettings) }),
  create_ambience: object({ ...generatedWave, loop: bool, render_settings: object({ ...renderSettings, duration_seconds: number }) }),
};

const READ_ONLY = new Set(['list_catalog', 'analyze_music', 'inspect_score']);
const CHANGES_PATHS = new Set(['create_music', 'create_sfx', 'create_ambience', 'learn_music_preference', 'manage_outputs']);

function toolContract(name, createsFiles) {
  const schema = results[name];
  if (!schema) throw new Error(`Contrat de sortie manquant pour ${name}.`);
  return {
    outputSchema: createsFiles ? { ...schema, properties: { ...schema.properties, managed_outputs: managedOutputs, output_management_warning: text } } : schema,
    annotations: READ_ONLY.has(name) ? { readOnlyHint: true, openWorldHint: false } : {
      readOnlyHint: false, destructiveHint: CHANGES_PATHS.has(name), openWorldHint: false,
    },
  };
}

module.exports = { toolContract };
