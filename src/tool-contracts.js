'use strict';

const { ui } = require('./language');

const { CHOICES: MUSIC_CHOICES } = require('./music-preferences');
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

const wav = { ...path, description: ui('Chemin du fichier WAV généré.', 'Path to the generated WAV file.') };
const project = { ...path, description: ui(
  'Projet .soundmcp.json à transmettre à inspect_score, edit_music ou finish_music.',
  '.soundmcp.json project to pass to inspect_score, edit_music, or finish_music.',
) };
const patch = { ...path, description: ui('Patch réutilisable dans play_sound ou dans patch_paths lors d’un arrangement.', 'Reusable patch for play_sound or the arrangement\'s patch_paths.') };
const fileId = { ...text, description: ui(
  'Pour reprendre un effet ou une ambiance, passe file_id comme source_file_id et output_dir comme source_output_dir à l’outil qui a créé le WAV.',
  'To revise an effect or ambience, pass file_id as source_file_id and output_dir as source_output_dir to the tool that created the WAV.',
) };
const file = object({ path, format: { type: 'string', enum: ['wav', 'midi', 'project', 'json'] }, bytes: integer });
const take = object({ label: text, path: wav, integratedLufs: numericOrNull }, { project_path: project });
const barRegion = object({ start_bar: { ...integer, minimum: 1 }, bars: { ...integer, minimum: 1 } });
const loopTake = object({
  label: text, path: wav, integratedLufs: numericOrNull,
  join_seconds: { ...number, description: ui('Position du raccord entre les deux tours dans le WAV.',
    'Time of the join between the two turns in the WAV.') },
  adaptive: { ...object({ loop_region: barRegion, crossfade_ms: number }), description: ui(
    'À transmettre tel quel à finish_music avec le project_path source.',
    'Pass unchanged to finish_music with the source project_path.',
  ) },
  metrics: object({
    cost: { ...number, description: ui('Coût de classement, plus bas pour les meilleurs raccords.', 'Ranking cost. Lower is better.') },
    level_difference_db: { ...number, description: ui('Écart de niveau avant les deux bornes.', 'Level difference before the two boundaries.') },
    harmonic_distance: { ...number, minimum: 0, maximum: 1, description: ui(
      'Distance entre les accords autour des deux bornes.', 'Chord distance around the two boundaries.',
    ) },
  }),
});
const variantSound = object({ id: text, label: text, patch_path: patch, preview_path: wav });
const exported = object({ meta: details, files: array(file) }, { project_path: project, audio: details, editions: array(details) });
const savedExport = { ...exported, required: [...exported.required, 'project_path'] };
const shortEdit = object({
  seconds: { ...integer, enum: [15, 30, 60] },
  sections: { ...array(text), description: ui('Sections du montage dans l’ordre de lecture.', 'Sections of the edit in playback order.') },
  files: array(file),
}, { audio: details });
const waveStats = object({ durationSeconds: number, integratedLufs: numericOrNull, samplePeakDbfs: numericOrNull });
const renderSettings = { kind: text, seed: integer, volume: number, sampling_rate: integer, mono: bool };
const generatedWave = { path: wav, kind: text, seed: integer, durationSeconds: number, bytes: integer };
const sfxControls = { pitch_semitones: number, attack_ms: number };
const adaptiveSegment = object({ file: { ...text, description: ui('Nom du WAV, relatif au dossier du manifeste.', 'WAV filename relative to the manifest directory.') },
  start_sample: integer, end_sample_exclusive: integer, frames: integer });
const adaptivePack = object({ manifest_path: { ...path, description: ui(
  'Manifeste JSON à lire pour programmer l’intro, la boucle et la sortie. Garde les trois WAV à côté du manifeste, avec leurs noms relatifs.',
  'JSON manifest for scheduling intro, loop, and outro. Keep the three WAV files beside it with the filenames given in the manifest.',
) }, type: { const: 'soundmcp-adaptive' }, version: { const: 1 },
  sample_rate: integer, channels: { enum: [1, 2] }, bit_depth: { enum: [16, 24] }, total_frames: integer, crossfade_frames: integer,
  loop_region: object({ start_bar: integer, bars: integer, start_sample: integer, end_sample_exclusive: integer }),
  segments: object({ intro: adaptiveSegment, loop: adaptiveSegment, outro: adaptiveSegment }) });
const managedOutputs = object({ output_dir: path, files: array(object({ file_id: fileId, path })) });
const archivedPathRequired = {
  if: { properties: { state: { const: 'archived' } }, required: ['state'] },
  then: { required: ['archive_path'] },
};
const asset = { ...object({
  file_id: fileId,
  path: { ...path, description: ui(
    'Chemin d’origine, y compris après archivage. Pour un projet actif, réutilise-le comme project_path.',
    'Original path, including after archival. For an active project, reuse it as project_path.',
  ) },
  state: { type: 'string', enum: OUTPUT_STATES, description: ui('Emplacement actuel du fichier, au chemin d’origine ou dans l’archive.', 'Current file location, at its original path or in the archive.') },
}, { archive_path: { ...path, description: ui('Chemin actuel du fichier lorsqu’il est archivé.', 'Current path of the archived file.') }, tool: text, created_at: text }),
  ...archivedPathRequired,
};
const draftCandidate = object({ id: { ...integer, description: ui('Numéro de l’esquisse ou du morceau dans la liste.', 'Draft or track number in the list.') },
  project_path: project, preview_path: wav, warnings: { ...array(text), description: ui('Écarts au brief et avertissements techniques pour cette esquisse.', 'Technical warnings and differences from the brief for this draft.') } }, {
  music: { ...details, description: ui('Style, tempo en BPM, tonalité, durée musicale et instruments retenus pour ce morceau.', 'Style, tempo in BPM, key, duration, and instruments for this track.'),
    properties: { style: text, tempo: number, key: text, durationSeconds: number, instruments: array(text) } },
  brief: { ...text, description: ui(
    'Brief du morceau de la collection. Réutilise-le avec seed dans draft_music et variants=1 pour reprendre ce morceau seul.',
    'Track brief from the collection. Reuse it and its seed in draft_music with variants=1 to recreate the track on its own.',
  ) },
  seed: { ...integer, description: ui('Graine à transmettre à draft_music pour rejouer ce morceau seul.', 'Seed to give draft_music to recreate this track on its own.') },
  title: { ...text, description: ui('Titre affiché du morceau.', 'Display title of the track.') },
  midi_source: object({ track: integer, channel: integer, start_bar: integer, bars: integer, meter: array(integer),
    ticks_per_quarter: integer, tempo: integer }),
});

const results = {
  design_sound: variantSound,
  play_sound: {
    ...object({ path: wav, seed: integer }, { sound: text, audio: waveStats, timbre: number,
      markers: array(object({ sound: text, label: text, from: number, integratedLufs: numericOrNull })) }),
    oneOf: [{ required: ['sound', 'audio'] }, { required: ['markers', 'timbre'] }],
  },
  calibrate_sound: object({ sound: text, role: text, probes: array(details),
    calibration_path: { ...path, description: ui('Fichier à inclure dans calibration_paths pour appliquer les corrections.', 'File to include in calibration_paths to apply the correction.') } }),
  compare_sounds: object({ files: array(take) }, {
    reveal_path: { ...path, description: ui('Manifeste des identités des prises anonymisées avec blind=true.', 'Manifest revealing the take identities when blind=true.') },
    seed: { ...integer, description: ui('Graine de génération renvoyée lorsque la comparaison est nominative.', 'Generation seed returned when take identities are visible.') },
  }),
  vary_sound: object({ reference: object({ id: text, label: text, preview_path: wav }), sounds: array(variantSound) }),
  list_catalog: object({ category: text, items: array(object({ id: text, description: text }, { label: text, part: text, source: text, tempo: number })) },
    { colors: details, instruments: array(text) }),
  draft_music: {
    ...object({ seed: integer,
      candidates: { ...array(draftCandidate), description: ui('Esquisses issues d’un brief, ou un morceau par brief dans l’ordre fourni.', 'Drafts from one brief, or one track per brief in the supplied order.') },
      firstToPreview: { ...integer, description: ui('Identifiant de la préécoute suggérée en premier.', 'ID of the suggested first preview.') },
      report_path: { ...path, description: ui('Manifeste local qui rassemble les préécoutes et les projets de cette génération.', 'Local manifest listing the previews and projects from this generation.') },
    }, { mode: { const: 'collection', description: ui('La réponse contient des morceaux indépendants.', 'The response contains standalone tracks.') }, title: text,
      source_excerpt: object({ region: barRegion, preserve: array(text) }),
      shared_options: { ...details, description: ui(
        'Réglages explicites communs à recopier dans draft_music pour reprendre un morceau de la collection.',
        'Shared explicit settings to reuse in draft_music when recreating a collection track.',
      ) },
    }),
    if: { required: ['mode'] }, then: { required: ['title', 'shared_options'], properties: {
      candidates: { minItems: 3, maxItems: 6, items: { required: ['brief', 'seed', 'title'] } },
    } },
  },
  create_music: exported,
  edit_music: object({ versions: array(savedExport) }, { mix: array(details) }),
  finish_music: {
    ...savedExport,
    properties: { ...savedExport.properties,
      report_path: { ...path, description: ui(
        'Rapport JSON regroupant les chemins des fichiers livrés, les métadonnées et les montages demandés.',
        'JSON delivery report with the exported file paths, metadata, and requested edits.',
      ) },
      cuts: array(shortEdit), adaptive: adaptivePack,
    },
    required: [...savedExport.required, 'report_path'],
  },
  preview_music: object({ files: array(take) }, { reveal_path: path }),
  compare_music_choices: {
    ...object({ criterion: text, files: array(take) }, {
      comparison_path: { ...path, description: ui(
        'Pour learn_music_preference après choix explicite sur accompaniment ou breath.',
        'Pass to learn_music_preference after an explicit accompaniment or breath choice.',
      ) },
      reveal_path: { ...path, description: ui('Correspondance des variantes et des projets du critère build.', 'Mapping between build variants and their projects.') },
    }),
    oneOf: [
      { properties: { criterion: { enum: ['accompaniment', 'breath'] } }, required: ['comparison_path'] },
      { properties: { criterion: { const: 'build' } }, required: ['reveal_path'] },
      { properties: { criterion: { const: 'loop' }, files: { ...array(loopTake), minItems: 1, maxItems: 3 } } },
    ],
  },
  learn_music_preference: object({
    criterion: { ...text, enum: Object.keys(MUSIC_CHOICES) },
    choice: { ...text, enum: ['normal', ...Object.values(MUSIC_CHOICES)], description: ui(
      'Variante réelle enregistrée pour ce critère, après résolution de la lettre A ou B.',
      'Variant saved for this criterion after resolving the selected A or B label.',
    ) },
    choices: { ...object({}, Object.fromEntries(Object.entries(MUSIC_CHOICES).map(([criterion, option]) =>
      [criterion, { ...text, enum: ['normal', option] }]))), description: ui(
      'Tous les choix mémorisés dans ce profil, y compris ceux des autres critères.',
      'All choices saved in this profile, including choices for other criteria.',
    ) },
    profile_path: { ...path, description: ui('Profil local réutilisable dans draft_music.', 'Local profile that can be reused in draft_music.') } }),
  analyze_music: object({ ...waveStats.properties, warnings: array(text) }, {
    channels: { ...integer, enum: [1, 2], description: ui('Nombre de canaux du signal mesuré.', 'Number of channels in the measured signal.') },
    sampleRate: { ...integer, description: ui('Fréquence d’échantillonnage du signal mesuré, en hertz.', 'Sample rate of the measured signal in hertz.') },
    clippedFrames: { ...integer, description: ui('Nombre de trames dont un canal atteint le seuil de saturation numérique.', 'Number of frames where any channel reaches the digital clipping threshold.') },
    stereoCorrelation: { ...numericOrNull, description: ui('Corrélation entre canaux de −1 à 1, ou null si elle est indéfinie.', 'Channel correlation from −1 to 1, or null when undefined.') },
    sections: { ...array(details), description: ui('Mesures par section pour un projet SoundMCP.', 'Per-section measurements for a SoundMCP project.') },
    stems: { ...details, description: ui('Niveaux moyens rmsDbfs par pupitre pour un projet SoundMCP.', 'Per-part average rmsDbfs for a SoundMCP project.') },
    suggestedEdits: { ...array(details), description: ui('Retouches proposées pour un projet, au format edits de edit_music.', 'Suggested project edits in the format accepted by edit_music.') },
    harmonicOverlaps: object({ total: integer, minimumSeconds: number, bars: array(details), examples: array(details) }),
  }),
  inspect_score: object({ start_bar: integer, bars: integer, measures: array(details),
    events: array(object({ bar: integer, part: text, instrument: text, beat: number, duration: number, played: details }, { pitch: integer, hit: text })),
    offset: integer, event_count: integer, next_offset: { ...offset, description: ui('Valeur à passer dans offset pour la page suivante.', 'Pass this value as offset for the next page.') } }),
  manage_outputs: {
    ...object({ output_dir: path }, {
      files: array(asset),
      total: { ...integer, minimum: 0, description: ui('Nombre de sorties correspondant aux filtres sur toutes les pages.', 'Number of outputs matching the filters across all pages.') },
      next_offset: { ...offset, description: ui('À passer dans offset avec les mêmes filtres, ou null à la dernière page.', 'Pass as offset with the same filters, or null on the last page.') },
      ...asset.properties,
    }),
    ...archivedPathRequired,
    oneOf: [{ required: ['files', 'total', 'next_offset'] }, { required: asset.required }],
  },
  create_sfx: { type: 'object', oneOf: [
    object({ ...generatedWave, render_settings: object(renderSettings, sfxControls) }),
    object({ kind: text, seed: integer, directory: path, variants: { ...array(object({
      ...generatedWave, index: integer, render_settings: object({ ...renderSettings, ...sfxControls }),
    })), minItems: 2, maxItems: 12 } }),
  ] },
  create_ambience: object({ ...generatedWave, loop: bool, render_settings: object({ ...renderSettings, duration_seconds: number }) }),
};

const READ_ONLY = new Set(['list_catalog', 'analyze_music', 'inspect_score']);
const CHANGES_PATHS = new Set(['create_music', 'create_sfx', 'create_ambience', 'learn_music_preference', 'manage_outputs']);
const IDEMPOTENT = new Set(['learn_music_preference', 'manage_outputs']);

function toolContract(name, createsFiles) {
  const schema = results[name];
  if (!schema) throw new Error(ui(`Contrat de sortie manquant pour ${name}.`, `Missing output contract for ${name}.`));
  return {
    outputSchema: createsFiles ? { ...schema, properties: { ...schema.properties, managed_outputs: managedOutputs, output_management_warning: text } } : schema,
    annotations: READ_ONLY.has(name) ? { readOnlyHint: true, openWorldHint: false } : {
      readOnlyHint: false, destructiveHint: CHANGES_PATHS.has(name), idempotentHint: IDEMPOTENT.has(name), openWorldHint: false,
    },
  };
}

module.exports = { toolContract };
