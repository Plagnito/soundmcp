'use strict';

const { ui } = require('./language');

/**
 * Catalogue d'outils MCP + logique d'exécution partagée
 * (utilisée par le serveur MCP et par le CLI).
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createSong } = require('./composer');
const { renderSong, writeWav, INSTRUMENTS } = require('./dsp');
const { writeMidi } = require('./midi');
const { createSfx, SFX_IDS, SFX_KINDS } = require('./sfx');
const { createAmbience, AMBIENCE_IDS, AMBIENCE_KINDS } = require('./ambience');
const { STYLES, STYLE_IDS } = require('./styles');
const { randomSeed, makeRng, hash32 } = require('./rng');
const { PARTS, ARTICULATIONS } = require('./arrangement');
const { EDITIONS, PALETTES, writeProject, readProject, editSong, endingVariations, getEditions, sectionIndex, sliceSong } = require('./music-project');
const { PLAYABLE, interpretBrief, arrange } = require('./arranger');
const { excerpt, cutMusic } = require('./studio-workflow');
const { measure, diagnose, scoreMetrics, localRms, matchLevels, readWave } = require('./music-analysis');
const { DRUMS, noteNumber } = require('./score-notes');
const { midiToFreq } = require('./theory');
const { COLORS } = require('./texture-voices');
const { SOUND_DESIGNS, SOUND_PARTS, TEXTURES } = require('./section-sounds');
const { ORCHESTRAL_PERCUSSION } = require('./orchestral-percussion');
const { WAVES, FILTERS, LFO_WAVES, TARGETS, MAX_GLIDE_MS, PATCH_ROLES, createPatch, patchFromBrief, importPatches, assignPatchRoles,
  normalizeGesture, supportsGesture, GESTURE_PATCH_ERROR } = require('./custom-patch');
const { readPerformance } = require('./performance');
const { readRoom } = require('./virtual-room');
const { musicClock } = require('./music-clock');
const { AUDITION_SOUNDS, RECORDED_SOUNDS, DIRECTIONS, loadPatch, loadSound, readPhrase, playPhrase, variantSound } = require('./sound-audition');
const { inspectScore } = require('./score-inspection');
const { PHRASINGS, THEME_TREATMENTS } = require('./melodic-phrasing');
const { calibrateSound, loadCalibrations, applyCalibrations } = require('./sound-calibration');
const { mixSong } = require('./automatic-mix');
const { CONTOURS, MAX_BEFORE, buildWindow, shapeBuild } = require('./build-shaping');
const { CHOICES, PREFERENCES, readPreferences, applyPreference, withPreferences, choiceManifest, rememberChoice } = require('./music-preferences');
const { ACTIONS: OUTPUT_ACTIONS, STATES: OUTPUT_STATES, recordOutputs, outputRenderSettings, manageOutputs } = require('./output-library');
const { toolContract } = require('./tool-contracts');
const { appendInlineAudio, INLINE_AUDIO_TOOLS } = require('./inline-audio');
const { MAX_CROSSFADE_MS, planAdaptiveMusic, exportAdaptiveMusic } = require('./adaptive-music');
const { previewLoopChoices } = require('./loop-audition');
const { MAX_EXCERPT_BARS, PRESERVE_EXCERPT, readDevelopment } = require('./develop-excerpt');
const { readMidiMotif } = require('./midi-motif');

const DEFAULT_OUTPUT_DIR = path.join(__dirname, '..', 'output');
const CATALOG_CATEGORIES = ['music', 'sfx', 'ambiences', 'sounds'];
const OUTPUT_TOOLS = new Set(['design_sound', 'calibrate_sound', 'play_sound', 'preview_sounds', 'compare_sounds', 'vary_sound',
  'draft_music', 'create_music', 'edit_music', 'mix_music', 'preview_music', 'compare_music_choices', 'compare_builds',
  'finish_music', 'create_sfx', 'create_ambience']);
const PROJECT_OUTPUT_TOOLS = new Set(['edit_music', 'mix_music', 'finish_music']);
const DEFAULT_PROFILE = process.env.SOUNDMCP_PROFILE_PATH || path.join(os.homedir(), '.soundmcp', 'preferences.soundmcp.json');
const SR_CHOICES = [22050, 44100, 48000];

/** Valide et borne les options techniques communes (sampling rate, mono). */
function techOptions(args) {
  const sr = SR_CHOICES.includes(args.sampling_rate) ? args.sampling_rate : 44100;
  if (args.sampling_rate !== undefined && !SR_CHOICES.includes(args.sampling_rate)) {
    throw new Error(ui(
      `sampling_rate invalide: ${args.sampling_rate}. Choix: ${SR_CHOICES.join(', ')}.`,
      `Invalid sampling_rate: ${args.sampling_rate}. Available: ${SR_CHOICES.join(', ')}.`,
    ));
  }
  return { sr, mono: !!args.mono };
}

const slug = (s) =>
  String(s).toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'musique';

const fmtSec = (s) => (s >= 90 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);
const fmtBytes = (b) => (b >= 1024 * 1024 ? `${(b / 1048576).toFixed(1)} ${ui('Mo', 'MiB')}` : `${Math.round(b / 1024)} ${ui('Ko', 'KiB')}`);

/* ---------------------------------- descriptions ---------------------------------- */

const TIP_SEED = ui('Conserve le seed, les paramètres et la version de SoundMCP pour reproduire le rendu.',
  'Keep the seed, settings, and SoundMCP version to reproduce the render.');
const TIP_LOOP = ui('Pour une boucle de jeu, utilise loop: true. Les queues d’effets sont raccordées au début de la piste.',
  'Set loop to true for a game loop. Effect tails wrap into the start of the track.');

const MOTIF_SCHEMA = {
  type: 'array', minItems: 1, maxItems: 24,
  description: ui('Notes de mélodie sur deux mesures, par ordre de temps, sans chevauchement.', 'Melody notes over two bars, sorted by time and without overlaps.'),
  items: {
    type: 'object', required: ['beat', 'duration'], properties: {
      beat: { type: 'number', minimum: 0, exclusiveMaximum: 8 },
      degree: { type: 'integer', minimum: -6, maximum: 15, description: ui('1 = tonique, 8 = tonique à l’octave au-dessus.', '1 is the tonic and 8 is the tonic one octave above.') },
      midi: { type: 'integer', minimum: 0, maximum: 127, description: ui('Hauteur MIDI absolue, conservée dans le thème.', 'Absolute MIDI pitch preserved in the theme.') },
      duration: { type: 'number', exclusiveMinimum: 0, maximum: 8 },
      velocity: { type: 'number', minimum: 1 / 127, maximum: 1 },
      articulation: { type: 'string', enum: ARTICULATIONS,
        description: ui(
          'mute et slide pour la guitare, legato et swell pour les vents, staccato pour les notes courtes.',
          'Use mute and slide for guitar, legato and swell for winds, or staccato for short notes.',
        ) },
    }, oneOf: [{ required: ['degree'], properties: { duration: { minimum: 0.0625 }, velocity: { minimum: 0.05 } } },
      { required: ['midi'] }],
  },
};

const CHORD_SCHEMA = { anyOf: [{ type: 'integer', minimum: 1, maximum: 7 }, { type: 'string' }] };
const METER_SCHEMA = { type: 'array', minItems: 2, maxItems: 2, items: { type: 'integer' }, description: ui('Numérateur et dénominateur, ex. [3,4] ou [6,8].', 'Numerator and denominator, for example [3,4] or [6,8].') };
const TEMPO_SCHEMA = { type: 'number', minimum: 40, maximum: 220, description: ui('Tempo en noires par minute.', 'Tempo in quarter notes per minute.') };
const SECTION_SELECTOR = { anyOf: [{ type: 'string' }, { type: 'integer', minimum: 1 }], description: ui('Nom unique ou numéro à partir de 1.', 'Unique name or one-based index.') };
const REGION_SCHEMA = { type: 'object', description: ui('Plage explicite dans la partition. Utilise region ou section.', 'Explicit region of the score. Use region or section.'), required: ['start_bar', 'bars'], properties: {
  start_bar: { type: 'integer', minimum: 1, description: ui('Première mesure du passage, numérotée à partir de 1.', 'First bar in the excerpt, numbered from 1.') },
  bars: { type: 'integer', minimum: 1, description: ui('Nombre de mesures consécutives disponibles à partir de start_bar.', 'Number of consecutive bars from start_bar.') },
} };
const PITCH_SCHEMA = { description: ui('Numéro MIDI ou note avec octave, par exemple 60 ou C4.', 'MIDI number or note with an octave, for example 60 or C4.'),
  anyOf: [{ type: 'integer', minimum: 0, maximum: 127 }, { type: 'string' }] };
const NUMBER = (minimum, maximum) => ({ type: 'number', minimum, maximum });
const UNIT = NUMBER(0, 1);
const SEED_SCHEMA = { type: 'integer', minimum: 0, maximum: 4294967295,
  description: ui(
    'Graine aléatoire. Réutilise-la avec les mêmes entrées et la même version pour reproduire le rendu ou les mesures.',
    'Random seed. Reuse it with the same inputs and version to reproduce renders or measurements.',
  ) };
const OUTPUT_DIR = { type: 'string', description: ui('Dossier parent des fichiers locaux. Par défaut, le dossier output de SoundMCP.', 'Parent directory for local files. Defaults to the SoundMCP output directory.') };
const PROJECT_OUTPUT_DIR = { type: 'string', description: ui('Dossier parent des exports. Par défaut, le dossier du fichier project_path.', 'Parent directory for exports. Defaults to the directory containing project_path.') };
const SAMPLING_RATE = { type: 'integer', enum: SR_CHOICES, description: ui('Fréquence d’échantillonnage du WAV en hertz.', 'WAV sample rate in hertz.') };
const MONO = { type: 'boolean', description: ui('true exporte le WAV sur un seul canal, false en stéréo.', 'true exports one WAV channel and false exports stereo.') };
const GESTURE_SCHEMA = { type: 'object', additionalProperties: false,
  description: ui('Façon de jouer la note, disponible pour les patchs modaux et guides d’onde.', 'Note gesture, supported by modal and waveguide patches.'), properties: {
  position: { ...UNIT, description: ui('Point de frappe ou de pincement. Change les résonances excitées.', 'Strike or pluck position. Controls which resonances are excited.') },
  hardness: { ...UNIT, description: ui('De contact souple à frappe dure et brillante.', 'From soft contact to a hard, bright strike.') },
  damping: { ...UNIT, description: ui('Amortissement du matériau pendant ce geste.', 'Material damping during this gesture.') },
  glide_ms: { ...NUMBER(0, MAX_GLIDE_MS), description: ui(
    'Durée en millisecondes du glissé depuis la note précédente avec slide ou legato.',
    'Glide duration from the preceding note in milliseconds, with slide or legato.',
  ) },
} };
const MEASURE_NOTES_SCHEMA = { type: 'array', maxItems: 64,
  description: ui(
    'Notes de remplacement du pupitre dans cette mesure. Donne pitch, pitches ou degree pour les notes, et hit pour le pupitre drum. Une liste vide efface le contenu de ce pupitre dans la mesure.',
    'Replacement notes for this part and bar. Use pitch, pitches, or degree for pitched notes, and hit for drum. An empty array clears the part in this bar.',
  ),
  items: { type: 'object', required: ['beat'], properties: {
  beat: { type: 'number', minimum: 0, description: ui('Temps à partir de zéro, dans le dénominateur de la mesure.', 'Zero-based beat in units of the time signature denominator.') },
  duration: { type: 'number', minimum: 0.025, maximum: 32, description: ui('Durée dans la même unité de temps que beat. Par défaut 0,5.', 'Duration in the same units as beat. Defaults to 0.5.') }, pitch: PITCH_SCHEMA,
  pitches: { type: 'array', minItems: 1, maxItems: 8, items: PITCH_SCHEMA, description: ui('Hauteurs simultanées d’un accord.', 'Simultaneous pitches of a chord.') },
  degree: { type: 'integer', minimum: -13, maximum: 22, description: ui('Degré de la gamme locale. 1 désigne la tonique et 8 son octave.', 'Local scale degree. 1 is the tonic and 8 is its octave.') },
  hit: { type: 'string', enum: DRUMS, description: ui('Frappe à jouer sur le pupitre drum, par exemple kick.', 'Drum hit to play, for example kick.') },
  velocity: { type: 'number', minimum: 0.05, maximum: 1, description: ui('Force relative de la note. Par défaut 0,72.', 'Relative note velocity. Defaults to 0.72.') },
  pan: { type: 'number', minimum: -1, maximum: 1, description: ui('Panoramique de gauche (-1) à droite (1), avec 0 au centre.', 'Pan from left (-1) to right (1), with 0 centered.') },
  timbre: { type: 'number', minimum: 0, maximum: 1, description: ui('Couleur de la voix, de sombre à brillante ou plus saturée selon le son.', 'Voice color, from dark to bright or more saturated depending on the sound.') },
  articulation: { type: 'string', enum: [...ARTICULATIONS, 'ghost'] },
  gesture: GESTURE_SCHEMA,
  expression: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number', minimum: 0.15, maximum: 1.6 },
    description: ui('Gain relatif au début et à la fin de la note.', 'Relative gain at the beginning and end of a note.') },
} } };
const CUSTOM_ID = { type: 'string', pattern: '^custom-[a-z0-9][a-z0-9-]{0,63}$' };
const PATCH_IMPORT = {
  patch_paths: { type: 'array', maxItems: 16, items: { type: 'string' }, description: ui('Chemins patch_path renvoyés par design_sound ou vary_sound pour importer les sons correspondants.', 'patch_path values returned by design_sound or vary_sound.') },
  calibration_paths: { type: 'array', maxItems: 16, items: { type: 'string' },
    description: ui(
      'Profils de niveau par registre renvoyés par calibrate_sound, pour un son et un pupitre.',
      'Per-register level profiles returned by calibrate_sound for a sound and part.',
    ) },
  patch_roles: { type: 'object', properties: Object.fromEntries(PATCH_ROLES.map((role) => [role, CUSTOM_ID])), additionalProperties: false,
    description: ui(
      'Associe les pupitres aux identifiants id des sons importés par patch_paths, par exemple {"mel":"custom-cloche"}.',
      'Maps parts to sound IDs imported through patch_paths, for example {"mel":"custom-bell"}.',
    ) },
};
const OSCILLATOR_PATCH_SCHEMA = { type: 'object', required: ['layers'], additionalProperties: false, properties: {
  layers: { type: 'array', minItems: 1, maxItems: 8, description: ui(
    'Oscillateurs superposés. Commence par une couche à ratio 1 pour la note fondamentale.',
    'Layered oscillators. Start with a layer at ratio 1 for the fundamental.',
  ), items: { type: 'object', properties: {
    wave: { type: 'string', enum: WAVES, description: ui('Forme d’onde de la couche.', 'Waveform of this layer.') },
    gain: { ...UNIT, description: ui('Niveau relatif de cette couche.', 'Relative level of this layer.') },
    ratio: { ...NUMBER(0.125, 16), description: ui('Multiplicateur de la fréquence de la note. 2 donne l’octave au-dessus.', 'Multiplier of note frequency. 2 raises it by an octave.') },
    detune_cents: { ...NUMBER(-240, 240), description: ui('Décalage supplémentaire de hauteur en centièmes de demi-ton.', 'Additional pitch offset in cents, or hundredths of a semitone.') },
    pan: NUMBER(-1, 1), pulse_width: NUMBER(0.08, 0.92), envelope: { type: 'object',
      description: ui(
        'Enveloppe de gain. attack, decay et release sont en secondes, sustain est le niveau tenu entre 0 et 1.',
        'Gain envelope. attack, decay, and release are in seconds. sustain is a level between 0 and 1.',
      ), properties: {
      attack: NUMBER(0.002, 6), decay: NUMBER(0, 8), sustain: UNIT, release: NUMBER(0.008, 4),
    } }, pitch_drop: { type: 'object', properties: { cents: NUMBER(-3200, 3200), seconds: NUMBER(0.004, 4) } },
    fm: { type: 'object', properties: { ratio: NUMBER(0.125, 16), index: NUMBER(0, 7) } },
  } } },
  filter: { type: 'object', properties: { type: { type: 'string', enum: FILTERS }, frequency: NUMBER(30, 18000), q: NUMBER(0.2, 10), envelope_octaves: NUMBER(-5, 5) } },
  lfos: { type: 'array', maxItems: 5, items: { type: 'object', properties: { target: { type: 'string', enum: Object.keys(TARGETS) },
    rate: NUMBER(0.03, 42), depth: NUMBER(0, 240), wave: { type: 'string', enum: LFO_WAVES } } } },
  effects: { type: 'object', properties: { drive: NUMBER(0, 1), chorus: NUMBER(0, 0.8), bits: { type: 'integer', minimum: 4, maximum: 16 },
    delay: { type: 'object', properties: { time_ms: NUMBER(20, 750), feedback: NUMBER(0, 0.72), mix: NUMBER(0, 0.66) } } } },
} };
const MODAL_PATCH_SCHEMA = { type: 'object', required: ['modal'], additionalProperties: false, properties: {
  modal: { type: 'object', required: ['modes'], additionalProperties: false, properties: {
    modes: { type: 'array', minItems: 1, maxItems: 12, description: ui('Résonances du matériau. Garde au moins un mode de gain positif.', 'Material resonances. Keep at least one mode with positive gain.'), items: { type: 'object', additionalProperties: false, properties: {
      ratio: { ...NUMBER(0.25, 32), description: ui('Fréquence de cette résonance en multiple de la note.', 'Resonance frequency as a multiple of the note frequency.') }, gain: UNIT,
      decay_seconds: { ...NUMBER(0.025, 8), description: ui('Temps de décroissance de cette résonance en secondes.', 'Decay time of this resonance in seconds.') },
      position_node: { type: 'integer', minimum: 1, maximum: 12, description: ui('Indice du mode utilisé pour moduler son excitation selon gesture.position.', 'Mode index used to vary its excitation with gesture.position.') }, pan: NUMBER(-0.7, 0.7),
    } } },
    contact: NUMBER(0, 0.7), damping: UNIT,
    friction: { type: 'object', additionalProperties: false,
      description: ui('Excite les résonances pendant toute la tenue, comme un matériau frotté.', 'Excites resonances throughout the note, as with a bowed material.'),
      properties: { amount: NUMBER(0.05, 1), roughness: UNIT, motion_hz: NUMBER(0.05, 18), attack_seconds: NUMBER(0.008, 4) } },
  } },
} };
const WAVEGUIDE_PATCH_SCHEMA = { type: 'object', required: ['waveguide'], additionalProperties: false, properties: {
  waveguide: { type: 'object', additionalProperties: false, properties: {
    brightness: UNIT, stiffness: UNIT, contact: NUMBER(0, 0.7), release_damping: UNIT,
    decay_seconds: { ...NUMBER(0.12, 8), description: ui('Durée visée d’atténuation de 60 dB pour la corde libre.', 'Time for the free string to decay by 60 dB.') },
    body: { type: 'object', additionalProperties: false, description: ui('Résonance de la caisse ajoutée au son de la corde.', 'Body resonance added to the string sound.'), properties: {
      frequency: { ...NUMBER(45, 1800), description: ui('Fréquence de résonance de la caisse en hertz.', 'Body resonance frequency in hertz.') },
      resonance: { ...NUMBER(0.4, 8), description: ui(
        'Facteur Q de la résonance. Augmente-le pour concentrer davantage la réponse autour de frequency.',
        'Resonance Q. Increase it for a narrower response around frequency.',
      ) },
      mix: { ...NUMBER(0, 0.75), description: ui('Part de la caisse dans le son final.', 'Contribution of the body to the final sound.') },
    } },
  } },
} };
const PATCH_SCHEMA = { type: 'object',
  description: ui(
    'Réglages du son fournis en ligne. Choisis layers pour des oscillateurs, modal pour un matériau frappé ou frotté, ou waveguide pour une corde pincée.',
    'Inline sound settings. Choose layers for oscillators, modal for struck or bowed material, or waveguide for a plucked string.',
  ),
  oneOf: [OSCILLATOR_PATCH_SCHEMA, MODAL_PATCH_SCHEMA, WAVEGUIDE_PATCH_SCHEMA],
  examples: [{ layers: [{ wave: 'sine', ratio: 1 }] }, { modal: { modes: [{ ratio: 1, gain: 0.8 }] } }, { waveguide: { brightness: 0.5 } }],
};
const PATCH_SOURCE_PROPERTIES = {
  patch: PATCH_SCHEMA, patch_path: { type: 'string', description: ui(
    'Chemin local patch_path renvoyé par design_sound ou vary_sound. Utilise-le pour charger un patch enregistré.',
    'Local patch_path returned by design_sound or vary_sound. Use it to load a saved patch.',
  ) },
  title: { type: 'string', maxLength: 80, description: ui('Nom du son fourni en ligne, utilisé pour son libellé et ses fichiers.', 'Inline sound title used for its label and files.') },
};
const PATCH_SOURCE_REQUIRED = [{ required: ['patch'] }, { required: ['patch_path'] }];
const CATALOG_ID = { type: 'string', enum: Object.keys(AUDITION_SOUNDS) };
const SOUND_SOURCE_PROPERTIES = { ...PATCH_SOURCE_PROPERTIES,
  instrument: { ...CATALOG_ID, description: ui('Identifiant intégré de la catégorie sounds de list_catalog.', 'Built-in ID from list_catalog with category=sounds.') } };
const SOUND_SOURCE_REQUIRED = [...PATCH_SOURCE_REQUIRED, { required: ['instrument'] }];
const SOUND_LIST_PROPERTIES = {
  sounds: { type: 'array', minItems: 1, maxItems: 12, items: { anyOf: [CATALOG_ID, CUSTOM_ID] },
    description: ui(
      'Identifiants à écouter dans l’ordre avec les notes de démonstration. Fournis patch_paths pour les sons personnels.',
      'IDs to audition in order with demonstration notes. Supply patch_paths for custom sounds.',
    ) },
  patch_paths: PATCH_IMPORT.patch_paths,
  timbre: { ...UNIT, description: ui(
    'Couleur commune aux extraits du nuancier sounds. Utilise notes[].timbre pour chaque note d’une phrase.',
    'Shared timbre for catalog previews. Use notes[].timbre for individual notes in a phrase.',
  ) },
};
const PHRASE_ONLY_FIELDS = ['instrument', 'patch', 'patch_path', 'notes', 'tail_seconds', 'sampling_rate', 'mono', 'title'];
const PLAY_SOUND_MODES = [
  ...SOUND_SOURCE_REQUIRED.map((mode) => ({ ...mode, not: { required: ['sounds'] } })),
  { required: ['sounds'], not: { anyOf: PHRASE_ONLY_FIELDS.map((name) => ({ required: [name] })) } },
];
const AUDITION_PROPERTIES = {
  notes: { type: 'array', minItems: 1, maxItems: 32, description: ui(
    'Phrase à jouer en secondes. Par défaut, trois notes de démonstration. Pour une note isolée, passe [{"at":0,"pitch":"C4"}].',
    'Phrase to play, timed in seconds. Defaults to three demonstration notes. For one note, pass [{"at":0,"pitch":"C4"}].',
  ),
    items: { type: 'object', required: ['at', 'pitch'], properties: {
      at: { ...NUMBER(0, 14), description: ui('Début en secondes. Plusieurs notes au même instant forment un accord.', 'Start in seconds. Notes at the same time form a chord.') },
      pitch: PITCH_SCHEMA, duration: { ...NUMBER(0.025, 8), description: ui('Tenue en secondes. Par défaut 0,55.', 'Note duration in seconds. Defaults to 0.55.') },
      velocity: MEASURE_NOTES_SCHEMA.items.properties.velocity, pan: MEASURE_NOTES_SCHEMA.items.properties.pan,
      timbre: MEASURE_NOTES_SCHEMA.items.properties.timbre,
      articulation: { type: 'string', enum: ARTICULATIONS }, gesture: GESTURE_SCHEMA,
      expression: MEASURE_NOTES_SCHEMA.items.properties.expression,
    } } },
  tail_seconds: { ...NUMBER(0.12, 6), description: ui(
    'Temps après la dernière note pour laisser décroître le son. Par défaut 1,45 s, dans un rendu de 24 s maximum.',
    'Decay time after the last note. Defaults to 1.45 s in a render up to 24 s.',
  ) },
  sampling_rate: { ...SAMPLING_RATE, description: ui('Fréquence de la phrase WAV en hertz. Par défaut 48000.', 'WAV phrase sample rate in hertz. Defaults to 48000.') }, mono: MONO,
  seed: SEED_SCHEMA, output_dir: OUTPUT_DIR,
};
const INTERPRETATION_PROPERTIES = {
  performance: { description: ui('Phrasé déterministe par pupitre. null le retire d’un projet.', 'Deterministic phrasing by part. null removes it from a project.'), anyOf: [{ type: 'null' }, {
    type: 'object', additionalProperties: false, properties: { amount: UNIT,
      parts: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: PARTS } } },
  }] },
  room: { description: ui(
    'Pièce virtuelle commune avec distance de 0 (proche) à 1 (loin). null rétablit la pièce du style.',
    'Shared virtual room with distance from 0 (near) to 1 (far). null restores the style\'s room.',
  ), anyOf: [{ type: 'null' }, {
    type: 'object', additionalProperties: false, properties: { amount: UNIT, size: UNIT, damping: UNIT,
      distance: { type: 'object', additionalProperties: false, properties: Object.fromEntries(PARTS.map((part) => [part, UNIT])) } },
  }] },
};
const ORCHESTRAL_SCHEMA = { type: 'string', enum: ORCHESTRAL_PERCUSSION,
  description: ui(
    'march organise les accents et les roulements orchestraux. drive ajoute les contretemps et les ponctuations de gong. none coupe le kit de la section.',
    'march adds orchestral accents and rolls. drive adds offbeats and gong punctuation. none mutes the section\'s kit.',
  ) };
const SECTION_PROPERTIES = {
  name: { type: 'string', minLength: 1, maxLength: 60 },
  theme: { type: 'string', enum: ['A', 'B', 'C'], description: ui('Réutilise le motif associé à un thème. A par défaut.', 'Reuse the motif associated with a theme. Defaults to A.') },
  theme_treatment: { type: 'string', enum: THEME_TREATMENTS, description: ui(
    'fragment isole la première cellule. reprise peut ajouter une levée. augmentation double les durées de la cellule. sequence la répète une tierce diatonique plus haut.',
    'fragment selects the first motif cell. reprise may add a pickup. augmentation doubles note durations. sequence repeats the cell a diatonic third higher.',
  ) },
  variation: { type: 'integer', minimum: 0, maximum: 3,
    description: ui(
      'Décale la variation du thème généré : original, transposé, rythme décalé, contour renversé.',
      'Shift the generated theme variation between original, transposed, displaced rhythm, and inverted contour.',
    ) },
  key: { type: 'string', description: ui('Tonalité locale, ex. « F minor ».', 'Local key, for example "F minor".') },
  tempo: TEMPO_SCHEMA,
  meter: METER_SCHEMA,
  color: { type: 'string', enum: Object.keys(COLORS), description: ui('Traitement du mix dans la section, par exemple radio pour un son étroit et filtré.', 'Section mix treatment, for example radio for a narrow, filtered sound.') },
  orchestral_percussion: ORCHESTRAL_SCHEMA,
  instruments: { type: 'object', properties: Object.fromEntries(SOUND_PARTS.map((part) => [part, { anyOf: [{ type: 'string',
    enum: Object.keys(INSTRUMENTS).filter((inst) => !TEXTURES.includes(inst)) }, CUSTOM_ID] }])), additionalProperties: false,
    description: ui('Nouvel instrument par pupitre, uniquement pour cette section.', 'Instrument overrides by part for this section only.') },
  textures: { type: 'array', maxItems: 32, items: { type: 'object', required: ['sound'], properties: {
    sound: { type: 'string', enum: TEXTURES }, bar: { type: 'integer', minimum: 1 }, beat: { type: 'number', minimum: 0 },
    duration: { type: 'number', minimum: 0.08, maximum: 32 }, level: { type: 'number', minimum: 0.02, maximum: 1 },
    pan: { type: 'number', minimum: -1, maximum: 1 }, timbre: { type: 'number', minimum: 0, maximum: 1 },
    midi: { type: 'integer', minimum: 0, maximum: 127, description: ui('Hauteur explicite, notamment pour les timbales.', 'Explicit pitch, particularly for timpani.') },
  } }, description: ui('Événements du pupitre texture. Mesures relatives à la section à partir de 1.', 'Events in the texture part. Bar numbers are one-based within the section.') },
  progression: {
    type: 'array', minItems: 1, maxItems: 64,
    items: { anyOf: [...CHORD_SCHEMA.anyOf, { type: 'array', minItems: 1, maxItems: 8, items: {
      type: 'object', required: ['beat', 'chord'], properties: { beat: { type: 'number', minimum: 0, maximum: 3.75 }, chord: CHORD_SCHEMA },
    } }] },
    description: ui(
      'Une entrée par mesure : degré, symbole (Dm9, G13, Cmaj7/E), ou suite de changements à partir de beat: 0.',
      'One entry per bar: a scale degree, a chord symbol (Dm9, G13, Cmaj7/E), or a series of changes starting at beat: 0.',
    ),
  },
  parts: { type: 'array', items: { type: 'string', enum: PARTS }, description: ui('Pupitres actifs parmi ceux du style.', 'Active parts from the selected style.') },
  energy: { type: 'number', minimum: 0.25, maximum: 1, description: ui('Dynamique de la section. 0.9 par défaut.', 'Section dynamics. Defaults to 0.9.') },
  motif: MOTIF_SCHEMA,
};

const ARRANGEMENT_SCHEMA = {
  type: 'object',
  description: ui(
    'Arrangement facultatif avec variations de tonalité, de tempo et de mesure par section.',
    'Optional arrangement with section-specific key, tempo, and time signature.',
  ),
  properties: {
    sections: {
      type: 'array', minItems: 1, maxItems: 64,
      description: ui('Ordre des sections. Leur nombre de mesures fixe la durée musicale.', 'Section order. Their bar counts determine the musical duration.'),
      items: {
        type: 'object', required: ['bars'], properties: { ...SECTION_PROPERTIES, bars: { type: 'integer', minimum: 1, maximum: 64 } },
      },
    },
    motif: { ...MOTIF_SCHEMA, description: ui(
      'Motif par défaut pour les sections qui incluent la mélodie. Une section peut fournir son propre motif.',
      'Default motif for sections with a melody. A section can supply its own motif.',
    ) },
  },
};

const EDITION_PROPERTIES = {
  editions: { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true, items: { type: 'string', enum: EDITIONS },
    description: ui(
      'Éditions supplémentaires sur la même plage. loop boucle le morceau, calm et intense changent la densité, transition relie les deux.',
      'Extra editions of the same region. loop repeats the track, calm and intense vary density, and transition connects them.',
    ) },
  loop_region: { type: 'object', properties: REGION_SCHEMA.properties,
    description: ui(
      'Plage commune aux editions, à partir de la mesure 1. Sans plage explicite, SoundMCP choisit une section musicale.',
      'Shared region for editions, starting from bar 1. If omitted, SoundMCP selects a musical section.',
    ) },
};

const PALETTE_SCHEMA = { type: 'string', enum: PALETTES,
  description: ui(
    'studio utilise les prises instrumentales enregistrées dont la harpe, le vibraphone et les violoncelles. synth utilise la synthèse.',
    'studio uses instrument recordings including harp, vibraphone, and cellos. synth uses synthesis.',
  ) };

const PROJECT_SCHEMA = { type: 'string',
  description: ui(
    'Chemin local .soundmcp.json. Réutilise project_path d’une esquisse, d’une prise A/B ou d’une version exportée.',
    'Local .soundmcp.json path. Reuse project_path from a draft, A/B take, or export.',
  ) };
const SOUND_DESIGN_SCHEMA = { type: 'string', enum: SOUND_DESIGNS, description: ui('evolving fait varier les timbres, les textures et le traitement entre sections.', 'evolving varies timbres, textures, and processing from section to section.') };
const BUILD_PROPERTIES = {
  arrival_bar: { type: 'integer', minimum: 2, description: ui('Première mesure de la reprise ou de l’arrivée.', 'First bar of the return or arrival.') },
  before_bars: { type: 'integer', minimum: 1, maximum: MAX_BEFORE, description: ui(
    'Nombre de mesures de montée avant l’arrivée. Par défaut, jusqu’à 3 mesures disponibles.',
    'Number of build-up bars before the arrival. Defaults to up to 3 available bars.',
  ) },
  amount: { ...UNIT, description: ui('Intensité de la montée. 1 applique l’effet complet, 0 le désactive.', 'Build intensity. 1 applies the full effect and 0 turns it off.') },
};
const PHRASING_SCHEMA = { type: 'string', enum: PHRASINGS,
  description: ui(
    'lyrical conserve le rythme du thème, ajuste ses notes aux accords et ménage des respirations. style suit le phrasé du genre.',
    'lyrical keeps the theme rhythm, adapts pitches to chords, and leaves space for breaths. style follows the genre\'s phrasing.',
  ) };
const MIX_PROPERTIES = {
  auto_mix: { type: 'boolean', description: ui(
    'Mesure les pupitres et équilibre chaque section. Actif par défaut dans les esquisses lyrical.',
    'Measure parts and balance each section. Enabled by default for lyrical drafts.',
  ) },
  mix_strength: { ...UNIT, description: ui('Intensité de la correction du mix automatique.', 'Strength of the automatic mix correction.') },
};
const PROFILE_PATH = { type: 'string', description: ui('Chemin du profil de préférences à lire, renvoyé par learn_music_preference.', 'Path to the preference profile returned by learn_music_preference.') };
const PREFERENCE_PROPERTIES = { profile_path: PROFILE_PATH,
  use_preferences: { type: 'boolean', description: ui(
    'Les esquisses utilisent le profil local existant par défaut. false les compose sans profil.',
    'Drafts use the existing local profile by default. Set false to compose without it.',
  ) } };
const REGION_PROPERTIES = {
  section: { ...SECTION_SELECTOR, description: ui(
    'Section à écouter, par nom unique ou numéro à partir de 1. Utilise section ou region.',
    'Section to preview by unique name or one-based index. Use section or region.',
  ) },
  region: REGION_SCHEMA,
  max_seconds: { type: 'number', minimum: 4, maximum: 45, description: ui(
    'Durée cible de l’extrait. Par défaut 18 s. Le rendu garde au moins une mesure entière.',
    'Target excerpt length. Defaults to 18 s. The render retains at least one full bar.',
  ) },
  full: { type: 'boolean', description: ui(
    'true rend le projet entier s’il dure au plus 45 s. Omet alors section, region et max_seconds.',
    'true renders a complete project up to 45 s. Omit section, region, and max_seconds with this option.',
  ) },
};
const REGION_SELECTION = { allOf: [
  { not: { required: ['section', 'region'] } },
  { if: { properties: { full: { const: true } }, required: ['full'] },
    then: { not: { anyOf: [{ required: ['section'] }, { required: ['region'] }, { required: ['max_seconds'] }] } } },
] };
const MUSIC_COMPARISON_CRITERIA = [...PREFERENCES, 'build', 'loop'];
const INLINE_AUDIO = { type: 'boolean', default: false,
  description: ui(
    'Ajoute une préécoute audio MCP mono à sonie alignée, jusqu’à 8 s par prise. Les WAV complets restent disponibles par chemin.',
    'Add a loudness-matched mono MCP audio preview of up to 8 s per take. Full WAV files are still available by path.',
  ) };
const EXPORT_PROPERTIES = {
  title: { type: 'string', description: ui('Titre de la version exportée et base du nom de ses fichiers.', 'Exported version title and base name for its files.') },
  format: { type: 'string', enum: ['wav', 'midi', 'both'], description: ui('Choisis le rendu audio WAV, la partition MIDI ou les deux.', 'Choose WAV audio, MIDI, or both.') },
  bit_depth: { type: 'integer', enum: [16, 24], description: ui('Résolution du WAV principal et des éditions, en bits.', 'Bit depth of the main WAV and editions.') },
  sampling_rate: SAMPLING_RATE, mono: MONO,
  stems: { type: 'boolean', description: ui('Ajoute un WAV par pupitre. Utilise format wav ou both.', 'Add a WAV per part. Use format wav or both.') },
  output_dir: PROJECT_OUTPUT_DIR, palette: PALETTE_SCHEMA,
  ...EDITION_PROPERTIES,
};
const EXPORT_CONSTRAINTS = {
  allOf: [
    { if: { required: ['loop_region'] }, then: { required: ['editions'] } },
    { if: { properties: { format: { const: 'midi' } }, required: ['format'] }, then: { properties: { stems: { const: false } } } },
  ],
};
const MUSIC_EDIT_TYPES = {
  gain: ['section', 'part', 'db'],
  mute: ['section', 'part'],
  replace_section: ['section', 'replacement'],
  write_measure: ['bar', 'part', 'notes'],
  shape_build: ['arrival_bar', 'contour'],
};
const PROCEDURAL_AUDIO_PROPERTIES = {
  source_file_id: { type: 'string', description: ui(
    'Identifiant d’un rendu précédent du même outil, issu de managed_outputs ou de manage_outputs. Fournis source_file_id ou kind.',
    'ID of a previous render by the same tool, from managed_outputs or manage_outputs. Supply source_file_id or kind.',
  ) },
  source_output_dir: { type: 'string', description: ui(
    'Dossier de la sortie source, indiqué dans managed_outputs.output_dir. À défaut, utilise output_dir ou le dossier output de SoundMCP.',
    'Source output directory from managed_outputs.output_dir. Falls back to output_dir or SoundMCP\'s output directory.',
  ) },
  seed: { ...SEED_SCHEMA, description: ui('Graine du rendu. Une variante reprend celle de la source par défaut.', 'Render seed. Variants reuse the source seed by default.') },
  volume: { ...NUMBER(0.05, 1), description: ui(
    'Volume relatif. Par défaut, reprend la valeur de la source ou utilise 1 pour une création.',
    'Relative volume. Defaults to the source value, or 1 for a new render.',
  ) },
  sampling_rate: { ...SAMPLING_RATE, description: ui(
    'Fréquence du WAV en hertz. Par défaut, reprend celle de la source ou utilise 44100 pour une création.',
    'WAV sample rate in hertz. Defaults to the source rate, or 44100 for a new render.',
  ) },
  mono: { ...MONO, description: ui(
    'true produit un WAV mono, false un WAV stéréo. Par défaut, reprend la source ou produit un WAV stéréo.',
    'true produces a mono WAV and false produces stereo. Defaults to the source setting, or stereo for a new render.',
  ) },
  output_dir: { ...OUTPUT_DIR, description: ui(
    'Dossier parent du nouveau rendu. Pour une variante, source_output_dir sert de valeur par défaut.',
    'Parent directory for the new render. Variants default to source_output_dir.',
  ) },
};
const PROCEDURAL_AUDIO_MODES = [{ required: ['kind'] }, { required: ['source_file_id'] }];
const SFX_PITCH = NUMBER(-6, 6), SFX_ATTACK = NUMBER(0, 100);
const SFX_PITCH_SPREAD = NUMBER(0, 3), SFX_ATTACK_SPREAD = NUMBER(0, 35);
const DRAFT_BRIEF = { type: 'string', minLength: 1, maxLength: 1600, pattern: '\\S' };
const DRAFT_MUSIC_OPTIONS = {
  style: { type: 'string', enum: STYLE_IDS, description: ui(
    'Force un identifiant de style issu de list_catalog(category=music). À défaut, SoundMCP le déduit du brief.',
    'Force a style ID from list_catalog(category=music). If omitted, SoundMCP infers the style from the brief.',
  ) },
  duration_seconds: { type: 'number', minimum: 5, maximum: 600, description: ui(
    'Durée visée du morceau complet en secondes. Le bouclage peut l’arrondir à une mesure entière.',
    'Target duration of the full track in seconds. Looping can round this to a whole bar.',
  ) },
  tempo: TEMPO_SCHEMA, meter: METER_SCHEMA, key: { type: 'string', description: ui('Tonalité globale, par exemple F minor. Cette valeur prime sur le brief.', 'Overall key, for example F minor. This overrides the brief.') },
  energy: { type: 'string', enum: ['gentle', 'balanced', 'rising', 'strong'], description: ui(
    'Trajectoire d’énergie. rising accentue la montée, strong demande un arrangement soutenu.',
    'Energy over time. rising emphasizes the build, and strong keeps the arrangement full.',
  ) },
  loop: { type: 'boolean', description: ui('true prépare un morceau bouclable, false demande une fin musicale.', 'true prepares a loopable track. false gives the track an ending.') },
  sound_design: SOUND_DESIGN_SCHEMA,
  orchestral_percussion: ORCHESTRAL_SCHEMA,
  phrasing: PHRASING_SCHEMA, palette: PALETTE_SCHEMA,
  motif: MOTIF_SCHEMA,
  midi_motif: { type: 'object', required: ['path'], additionalProperties: false,
    description: ui(
      'Importe une ligne monophonique MIDI SMF 0 ou 1, sur une à deux mesures. Utilise midi_motif ou motif.',
      'Import one to two bars of a monophonic SMF 0 or 1 MIDI line. Use midi_motif or motif.',
    ),
    properties: {
      path: { type: 'string', minLength: 1, description: ui('Chemin local du fichier .mid, jusqu’à 8 Mio.', 'Local path to a .mid file up to 8 MiB.') },
      track: { type: 'integer', minimum: 1, description: ui(
        'Piste MIDI à partir de 1, y compris la piste des métadonnées. Par défaut, première piste avec des notes mélodiques dans la plage.',
        'One-based MIDI track number, including the metadata track. Defaults to the first track with melody notes in the region.',
      ) },
      channel: { type: 'integer', minimum: 1, maximum: 16, description: ui(
        'Canal MIDI à partir de 1. Par défaut, canal de la première note mélodique de la piste sélectionnée.',
        'One-based MIDI channel. Defaults to the channel of the first melody note in the selected track.',
      ) },
      start_bar: { type: 'integer', minimum: 1, maximum: 10000, default: 1, description: ui('Première mesure source à partir de 1.', 'One-based first source bar.') },
      bars: { type: 'integer', enum: [1, 2], default: 2, description: ui('Nombre de mesures à lire, avec la même signature rythmique.', 'Number of bars to read under the same time signature.') },
    } },
  reprise_treatment: { type: 'string', enum: THEME_TREATMENTS, description: ui('Développe la cellule du thème dans la reprise.', 'How the motif develops in the reprise.') },
  build_contour: { type: 'string', enum: CONTOURS, description: ui('Forme l’accompagnement juste avant la reprise.', 'Shape the accompaniment just before the reprise.') },
  ...MIX_PROPERTIES, ...PREFERENCE_PROPERTIES,
  ...INTERPRETATION_PROPERTIES,
  ...PATCH_IMPORT,
  instruments: { type: 'array', items: { type: 'string', enum: PLAYABLE }, description: ui('Timbres à privilégier dans l’orchestration.', 'Instruments to favor in the arrangement.') },
  instrument_roles: { type: 'object', minProperties: 1, additionalProperties: false,
    description: ui(
      'Affecte explicitement des timbres intégrés aux pupitres présents. Les autres pupitres restent choisis selon instruments et le style.',
      'Assign built-in instruments to active parts explicitly. Unassigned parts still follow instruments and the style.',
    ),
    properties: Object.fromEntries(SOUND_PARTS.map((part) => [part, { type: 'string', enum: PLAYABLE.filter((id) => id !== 'drum') }])),
  },
  without: { type: 'array', items: { type: 'string', enum: PLAYABLE }, description: ui('Timbres à exclure de l’orchestration.', 'Instruments to exclude from the arrangement.') },
};

const TOOLS = [
  {
    name: 'design_sound',
    title: ui('Créer un timbre', 'Design a sound'),
    description: ui(
      'Crée un timbre inédit. Donne brief pour partir d’une idée ou patch pour contrôler la synthèse. Écrit un WAV et un patch éditable dans un nouveau sous-dossier. Passe patch_path à play_sound pour l’écouter ou à vary_sound pour le décliner.',
      'Create a new sound from a brief or use patch for detailed synthesis control. Writes a WAV and an editable patch in a new subdirectory. Pass patch_path to play_sound or vary_sound.',
    ),
    inputSchema: { type: 'object', properties: {
      brief: { type: 'string', maxLength: 1000, description: ui(
        'Décris le matériau, le geste et le caractère du timbre, par exemple « cloche métallique frappée, sombre et courte ». Fournis brief ou patch.',
        'Describe the material, gesture, and sound character, for example "a dark, short bell struck on metal". Supply brief or patch.',
      ) },
      patch: PATCH_SCHEMA,
      title: PATCH_SOURCE_PROPERTIES.title,
      note: { ...PITCH_SCHEMA, description: ui('Hauteur de la note de démonstration. Par défaut C4.', 'Pitch of the demonstration note. Defaults to C4.') },
      duration_seconds: { ...NUMBER(0.7, 12), description: ui('Durée totale du WAV de démonstration. Par défaut 4 s.', 'Total demonstration WAV duration. Defaults to 4 s.') },
      gate_seconds: { ...NUMBER(0.03, 10), description: ui(
        'Temps de tenue de la note en secondes. Laisse au moins 0,15 s entre la fin de la tenue et la fin du WAV.',
        'Note hold in seconds. Allow at least 0.15 s between the end of the hold and the end of the WAV.',
      ) },
      velocity: { ...NUMBER(0.05, 1), description: ui('Force relative de la note de démonstration. Par défaut 0,78.', 'Relative velocity of the demonstration note. Defaults to 0.78.') }, gesture: GESTURE_SCHEMA,
      seed: SEED_SCHEMA, output_dir: OUTPUT_DIR,
    }, oneOf: [{ required: ['brief'] }, { required: ['patch'] }] },
  },
  {
    name: 'play_sound',
    title: ui('Écouter des timbres', 'Audition sounds'),
    description: ui(
      'Joue une phrase avec un timbre choisi par instrument, patch ou patch_path. Pour parcourir rapidement le nuancier, donne sounds seul comme source. Écrit un WAV par appel dans un nouveau sous-dossier. Pour jouer la même phrase avec plusieurs timbres à sonie égale, utilise compare_sounds.',
      'Play a phrase using instrument, patch, or patch_path. Use sounds on its own as the source for a quick catalog tour. Writes one WAV per call in a new subdirectory. Use compare_sounds to compare the same phrase across sounds at matched loudness.',
    ),
    inputSchema: { type: 'object', properties: { ...SOUND_SOURCE_PROPERTIES, ...AUDITION_PROPERTIES, ...SOUND_LIST_PROPERTIES },
      oneOf: PLAY_SOUND_MODES },
  },
  {
    name: 'calibrate_sound',
    title: ui('Étalonner un timbre', 'Calibrate a sound'),
    description: ui(
      'Étalonne un patch pour l’intégrer à un pupitre. Mesure l’attaque et la tenue à trois forces par hauteur, puis écrit la courbe de gain dans un nouveau sous-dossier. Passe calibration_path dans calibration_paths de draft_music, create_music ou edit_music. Pour simplement écouter le timbre, utilise play_sound.',
      'Calibrate a patch for an arrangement part. Measures attack and sustain at three velocities per pitch, then writes the gain curve in a new subdirectory. Pass calibration_path in calibration_paths for draft_music, create_music, or edit_music. Use play_sound for an audition.',
    ),
    inputSchema: { type: 'object', properties: { ...PATCH_SOURCE_PROPERTIES,
      role: { type: 'string', enum: PATCH_ROLES, description: ui(
        'Pupitre à équilibrer, par exemple mel pour mélodie ou bass pour basse. Adapte le registre et le niveau cible. Par défaut mel.',
        'Part to balance, for example mel for melody or bass for bass. Determines the register and target level. Defaults to mel.',
      ) },
      notes: { type: 'array', minItems: 3, maxItems: 6, items: PITCH_SCHEMA,
        description: ui(
          'Trois à six hauteurs distinctes couvrant le registre du pupitre. À défaut, C3, C4 et C5 pour la plupart des pupitres, une octave plus bas pour bass.',
          'Three to six distinct pitches spanning the part\'s register. Defaults to C3, C4, and C5, or one octave lower for bass.',
        ) },
      seed: SEED_SCHEMA, output_dir: OUTPUT_DIR,
    }, oneOf: PATCH_SOURCE_REQUIRED },
  },
  {
    name: 'compare_sounds',
    title: ui('Comparer des timbres', 'Compare sounds'),
    description: [
      ui(
        'Compare deux à quatre timbres sur les mêmes notes, avec un WAV par prise à sonie alignée dans un nouveau dossier sous output_dir.',
        'Compare two to four sounds on the same notes. Writes one WAV per take at matched loudness in a new subdirectory of output_dir.',
      ),
      ui(
        'Déclare une source par entrée de sounds, par exemple [{"instrument":"harp"},{"patch_path":"corde.soundmcp-patch.json"}]. Les notes communes, exprimées en secondes, se placent à la racine.',
        'Provide one source per entry in sounds, for example [{"instrument":"harp"},{"patch_path":"string.soundmcp-patch.json"}]. Set the shared notes in seconds at the top level.',
      ),
      ui(
        'Avec blind, les prises sont anonymisées et reveal_path donne leur correspondance. Pour générer deux variantes d’un même projet musical, utilise compare_music_choices.',
        'blind hides the take identities and reveal_path provides their mapping. Use compare_music_choices for two variants of a musical project.',
      ),
    ].join('\n'),
    inputSchema: { type: 'object', required: ['sounds'], properties: {
      sounds: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'object', properties: SOUND_SOURCE_PROPERTIES, oneOf: SOUND_SOURCE_REQUIRED },
        description: ui(
          'Deux à quatre sources, une par prise. Indique instrument, patch ou patch_path pour chacune.',
          'Two to four sources, one per take. Use instrument, patch, or patch_path for each.',
        ) },
      ...AUDITION_PROPERTIES, blind: { type: 'boolean', description: ui(
        'Mélange les prises à partir de seed et écrit leur correspondance dans reveal_path.',
        'Shuffle the takes using seed and save their identity mapping at reveal_path.',
      ) },
    } },
  },
  {
    name: 'vary_sound',
    title: ui('Décliner un timbre', 'Create sound variants'),
    description: ui(
      'Affine un timbre existant à partir de patch ou patch_path. Écrit les variantes éditables et le WAV de référence à sonie alignée dans un nouveau sous-dossier. Pour partir d’un brief inédit, utilise design_sound.',
      'Refine an existing sound from patch or patch_path. Writes editable variants and the reference WAV at matched loudness in a new subdirectory. Use design_sound to start from a new brief.',
    ),
    inputSchema: { type: 'object', properties: { ...PATCH_SOURCE_PROPERTIES, ...AUDITION_PROPERTIES,
      directions: { type: 'array', minItems: 1, maxItems: DIRECTIONS.length, uniqueItems: true,
        items: { type: 'string', enum: DIRECTIONS }, description: ui(
          'Une variante par direction. brighter et darker changent la couleur, shorter et longer changent la durée du son. Par défaut darker, brighter et shorter.',
          'One variant per direction. brighter and darker change timbre, shorter and longer change duration. Defaults to darker, brighter, and shorter.',
        ) },
      amount: { ...NUMBER(0.05, 1), description: ui(
        'Amplitude de chaque variation, de 0,05 (subtile) à 1 (marquée). Par défaut 0,7.',
        'Strength of each variation from 0.05 (subtle) to 1 (strong). Defaults to 0.7.',
      ) },
    }, oneOf: PATCH_SOURCE_REQUIRED },
  },
  {
    name: 'list_catalog',
    title: ui('Parcourir le catalogue sonore', 'Browse the sound catalog'),
    description: ui(
      'Liste les styles musicaux, effets, ambiances ou timbres selon category. Les identifiants de items sont utilisables dans create_music, create_sfx, create_ambience ou play_sound. Lecture seule.',
      'List music styles, effects, ambiences, or instruments by category. Use item IDs in create_music, create_sfx, create_ambience, or play_sound. Read-only.',
    ),
    inputSchema: { type: 'object', required: ['category'], properties: {
      category: { type: 'string', enum: CATALOG_CATEGORIES },
    } },
  },
  {
    name: 'draft_music',
    title: ui('Préparer des esquisses instrumentales', 'Draft instrumental music'),
    description: [
      ui(
        'Compose des esquisses instrumentales à partir d’un brief. Chaque appel écrit des projets éditables et leurs préécoutes à sonie alignée dans un nouveau sous-dossier.',
        'Compose instrumental drafts from a brief. Each call writes editable projects and matched-loudness previews in a new subdirectory.',
      ),
      ui(
        'Avec brief, variants choisit le nombre de prises de la même idée. Avec briefs, chaque entrée donne un morceau. Les valeurs fournies pour tempo et duration_seconds priment sur celles du texte. Les exclusions du texte et de without se cumulent.',
        'With brief, variants controls the take count for one idea. With briefs, each entry produces a track. Explicit tempo and duration_seconds override the brief. Exclusions in without and the brief are combined.',
      ),
      ui(
        'Pour reprendre un morceau de la collection seul, copie les champs du résultat shared_options à la racine du nouvel appel. Ajoute le brief et le seed du morceau avec variants=1.',
        'To recreate one collection track, copy the returned shared_options fields to the top level of the new call. Add the track’s brief and seed with variants=1.',
      ),
      ui(
        'Pars d’une ligne MIDI avec midi_motif ou d’un passage SoundMCP avec source_excerpt. Le brief décrit le nouveau morceau.',
        'Start from a MIDI line with midi_motif or a saved SoundMCP passage with source_excerpt. The brief describes the new track.',
      ),
      ui(
        'Pour le master, passe le project_path retenu à finish_music. Pour composer et exporter directement depuis un style, appelle create_music.',
        'Pass the selected project_path to finish_music for the master. To compose and export directly from a style, use create_music.',
      ),
    ].join('\n'),
    inputSchema: { type: 'object', properties: {
      brief: { ...DRAFT_BRIEF, description: ui(
        'Brief français ou anglais pour une seule idée musicale. Ex. « 75 secondes pour une exploration nocturne, piano feutré et montée progressive. »',
        'French or English brief for one musical idea, for example "75 seconds for nighttime exploration, soft piano and a gradual build."',
      ) },
      briefs: { type: 'array', minItems: 3, maxItems: 6, items: DRAFT_BRIEF,
        description: ui(
          'Un brief français ou anglais par morceau, dans l’ordre de la collection. Donne à chacun une ambiance, un rythme ou une instrumentation propre. Les réglages explicites, par exemple instruments, sont communs à la collection.',
          'One French or English brief per track in collection order. Give each its own mood, rhythm, or instrumentation. Explicit options such as instruments are shared.',
        ) },
      variants: { type: 'integer', minimum: 1, maximum: 3, description: ui(
        'Nombre d’esquisses pour brief, 3 par défaut. Avec briefs, chaque morceau reçoit une seule esquisse.',
        'Draft count for brief. Defaults to 3. With briefs, each track gets one draft.',
      ) },
      ...DRAFT_MUSIC_OPTIONS,
      source_excerpt: { type: 'object', additionalProperties: false, required: ['project_path', 'region'],
        description: ui('Développe un extrait d’un projet SoundMCP avec un nouveau brief. Le fichier source reste en lecture seule.',
          'Develop an excerpt of a SoundMCP project with a new brief. The source project is read-only.'),
        properties: {
          project_path: PROJECT_SCHEMA,
          region: { ...REGION_SCHEMA, additionalProperties: false, properties: {
            ...REGION_SCHEMA.properties, bars: { ...REGION_SCHEMA.properties.bars, maximum: MAX_EXCERPT_BARS },
          } },
          preserve: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: { enum: PRESERVE_EXCERPT },
            description: ui('À reprendre. motif extrait jusqu’à deux mesures de mélodie, instruments garde les timbres dominants, harmony garde les accords de la plage. Par défaut, les trois.',
              'What to carry over. motif extracts up to two bars of melody, instruments keeps dominant sounds, and harmony keeps the region’s chords. Defaults to all three.') },
        },
      },
      inline_audio: INLINE_AUDIO,
      seed: SEED_SCHEMA,
      title: { ...EXPORT_PROPERTIES.title, description: ui('Titre des esquisses ou de la collection. Sert à nommer leur dossier.', 'Draft or collection title used in the directory name.') },
      output_dir: OUTPUT_DIR,
    }, oneOf: [{ required: ['brief'] }, { required: ['briefs'] }], not: { anyOf: [
      { required: ['briefs', 'variants'] }, { required: ['motif', 'midi_motif'] },
      ...['briefs', 'motif', 'midi_motif'].map((field) => ({ required: ['source_excerpt', field] })),
    ] } },
  },
  {
    name: 'finish_music',
    title: ui('Livrer un master', 'Render a master'),
    description: [
      ui('Livre le master d’un projet choisi après draft_music ou edit_music. Pour écouter un extrait avant de livrer, utilise preview_music.',
        'Render the master of a selected project after draft_music or edit_music. To audition an excerpt first, use preview_music.'),
      ui('Chaque appel crée un nouveau dossier et préserve les exports précédents. report_path pointe vers le rapport JSON des fichiers livrés. Si le projet est illisible, reprends le project_path renvoyé par l’outil qui l’a créé.',
        'Each call creates a new folder and preserves earlier exports. report_path points to the JSON delivery report. If the project cannot be read, reuse the project_path returned by the tool that created it.'),
    ].join('\n'),
    inputSchema: { type: 'object', required: ['project_path'], properties: { ...EXPORT_PROPERTIES, project_path: PROJECT_SCHEMA,
      format: { ...EXPORT_PROPERTIES.format, default: 'both' },
      output_dir: { ...EXPORT_PROPERTIES.output_dir, description: ui(
        'Dossier parent de la livraison. Par défaut, utilise le dossier du projet source.',
        'Parent directory for the delivery. Defaults to the source project directory.',
      ) },
      bit_depth: { ...EXPORT_PROPERTIES.bit_depth, default: 24 },
      sampling_rate: { ...SAMPLING_RATE, default: 48000 },
      stems: { ...EXPORT_PROPERTIES.stems, description: ui(
        'Ajoute des pistes WAV par pupitre. Actif par défaut avec wav ou both. Avec midi, omets stems ou passe false.',
        'Add WAV stems per part. Enabled by default with wav or both. For midi, omit stems or set it to false.',
      ) },
      cuts: { type: 'array', maxItems: 3, uniqueItems: true, items: { type: 'integer', enum: [15, 30, 60] },
        description: ui(
          'Formats courts supplémentaires, en secondes. Chaque montage commence sur un thème et se termine par une cadence.',
          'Additional short edits, in seconds. Each starts with a theme and ends with a cadence.',
        ) },
      adaptive: { type: 'object', required: ['loop_region'], additionalProperties: false,
        description: ui(
          'Livre l’intro, la boucle et la sortie en WAV. Avec compare_music_choices (criterion=loop), passe l’objet adaptive de la prise choisie avec le project_path source. Requiert format=wav ou both.',
          'Deliver WAV intro, loop, and outro. For compare_music_choices (criterion=loop), pass the selected take’s adaptive object with the source project_path. Requires format=wav or both.',
        ),
        properties: {
          loop_region: { ...REGION_SCHEMA,
            description: ui('Mesures à répéter. Garde au moins une mesure avant et après la boucle.', 'Bars to repeat. Leave at least one bar before and after the loop.'),
            properties: { ...REGION_SCHEMA.properties, start_bar: { ...REGION_SCHEMA.properties.start_bar, minimum: 2 } },
          },
          crossfade_ms: { ...NUMBER(5, MAX_CROSSFADE_MS), default: 25, description: ui(
            'Durée maximale du fondu de raccord en millisecondes. Les bornes temporelles restent fixes.',
            'Maximum crossfade length in milliseconds. Segment boundaries stay fixed.',
          ) },
        } },
    }, allOf: [...EXPORT_CONSTRAINTS.allOf,
      { if: { properties: { format: { const: 'midi' } }, required: ['format'] }, then: { not: { required: ['adaptive'] } } }],
    },
  },
  {
    name: 'preview_music',
    title: ui('Préécouter un projet musical', 'Preview a music project'),
    description: [
      ui('Écoute des projets déjà enregistrés. Écrit des WAV à sonie alignée dans un nouveau dossier et conserve les partitions source.',
        'Audition saved projects. Writes loudness-matched WAV files in a new directory and preserves the source scores.'),
      ui('Pour comparer plusieurs projets sur les mêmes numéros de mesures, utilise region, qui doit tenir dans chacun. Un nom section doit pouvoir être résolu dans chaque projet.',
        'To compare the same numbered bars across projects, use region, which must fit each score. A named section must resolve in each project.'),
      ui('Pour générer des alternatives d’arrangement ou de boucle à partir d’un seul projet, utilise compare_music_choices. Pour un timbre isolé, utilise play_sound.',
        'Use compare_music_choices to generate arrangement or loop alternatives from one project. Use play_sound for a single sound.'),
    ].join('\n'),
    inputSchema: { type: 'object', properties: { project_path: PROJECT_SCHEMA,
      project_paths: { type: 'array', minItems: 1, maxItems: 3, items: PROJECT_SCHEMA },
      ...REGION_PROPERTIES,
      inline_audio: INLINE_AUDIO,
      blind: { type: 'boolean', description: ui('Mélange et anonymise les prises. Les identités sont dans le fichier reveal_path.', 'Shuffle and anonymize the takes. Their identities are in reveal_path.') },
      seed: SEED_SCHEMA, output_dir: OUTPUT_DIR,
    }, oneOf: [{ required: ['project_path'] }, { required: ['project_paths'] }], ...REGION_SELECTION },
  },
  {
    name: 'compare_music_choices',
    title: ui('Comparer des choix dans un projet musical', 'Compare choices within a music project'),
    description: [
      ui('Compare des variantes tirées d’un seul projet. Écrit des WAV à sonie alignée dans un nouveau dossier.',
        'Compare alternatives derived from one project. Writes loudness-matched WAV files in a new directory.'),
      ui('Avec loop, classe jusqu’à trois raccords. Chaque WAV joue deux tours. Passe adaptive de la prise choisie à finish_music sur le projet source.',
        'With loop, rank up to three joins. Each WAV plays two turns. Pass the chosen take’s adaptive settings to finish_music on the source project.'),
      ui('Avec accompaniment, breath ou build, crée deux variantes anonymes et leurs projets. Seuls accompaniment et breath donnent un comparison_path pour learn_music_preference.',
        'With accompaniment, breath, or build, create two blind variants and their projects. Only accompaniment and breath provide a comparison_path for learn_music_preference.'),
      ui('Utilise preview_music pour écouter un projet existant sans proposer de variantes.',
        'Use preview_music to audition an existing project without generating alternatives.'),
    ].join('\n'),
    inputSchema: { type: 'object', required: ['project_path', 'criterion'], properties: {
      project_path: PROJECT_SCHEMA, criterion: { type: 'string', enum: MUSIC_COMPARISON_CRITERIA,
        description: ui(
          'Choisis la présence de l’accompagnement, les respirations, la montée ou les points de reprise d’une boucle.',
          'Compare accompaniment presence, melodic breathing room, a build, or musical loop points.',
        ) },
      ...REGION_PROPERTIES, ...BUILD_PROPERTIES,
      max_seconds: { ...REGION_PROPERTIES.max_seconds, description: ui(
        'Durée cible de l’extrait, 18 s par défaut. Avec loop, durée maximale d’un tour, 45 s par défaut.',
        'Target excerpt duration, 18 s by default. With loop, maximum duration per turn, 45 s by default.',
      ) },
      loop_options: { type: 'object', additionalProperties: false, description: ui(
        'Réglages pour criterion=loop. La région et la durée peuvent limiter le nombre de prises.',
        'Options for criterion=loop. The region and duration can limit the number of takes.',
      ), properties: {
        count: { type: 'integer', enum: [2, 3], default: 3, description: ui('Nombre maximal de raccords proposés.', 'Maximum number of proposed joins.') },
        min_bars: { type: 'integer', minimum: 1, description: ui('Durée minimale en mesures, huit par défaut si la plage le permet.',
          'Minimum duration in bars, eight by default when the range allows it.') },
        crossfade_ms: { ...NUMBER(5, MAX_CROSSFADE_MS), default: 400, description: ui(
          'Durée maximale du fondu sans déplacer les mesures.', 'Maximum crossfade duration without shifting the bar boundaries.',
        ) },
      } },
      inline_audio: INLINE_AUDIO,
      section: { ...SECTION_SELECTOR, description: ui(
        'Avec build, indique la section d’arrivée à la place de arrival_bar. Sinon, choisis la section à écouter ou à parcourir à la place de region.',
        'For build, choose the arrival section instead of arrival_bar. Otherwise, choose the section to audition or search instead of region.',
      ) },
      amount: { ...BUILD_PROPERTIES.amount, description: ui(
        'Pour build, intensité de la montée. Utilise une valeur strictement positive, jusqu’à 1 (effet complet).',
        'Build intensity. Use a positive value up to 1 for the full effect.',
      ) },
      after_bars: { type: 'integer', minimum: 1, maximum: 8, description: ui(
        'Pour build, mesures à écouter à partir de l’arrivée. Par défaut, jusqu’à 2 mesures disponibles.',
        'For build, the number of bars to audition from the arrival. Defaults to up to 2 available bars.',
      ) },
      seed: { ...SEED_SCHEMA, description: ui('Graine de l’ordre anonyme des prises A et B. Omet pour loop.', 'Seed for the blind A/B order. Omit for loop.') }, output_dir: OUTPUT_DIR,
    }, if: { properties: { criterion: { const: 'build' } } }, then: { allOf: [
      { not: { anyOf: [{ required: ['region'] }, { required: ['full'] }, { required: ['max_seconds'] }, { required: ['section', 'arrival_bar'] }] } },
      { properties: { amount: { exclusiveMinimum: 0 } } },
    ] }, else: { allOf: [
      ...REGION_SELECTION.allOf,
      { not: { anyOf: [{ required: ['arrival_bar'] }, { required: ['before_bars'] }, { required: ['after_bars'] }, { required: ['amount'] }] } },
    ] }, allOf: [{
      if: { properties: { criterion: { const: 'loop' } } },
      then: { not: { anyOf: [{ required: ['full'] }, { required: ['seed'] }] } },
      else: { not: { required: ['loop_options'] } },
    }] },
  },
  {
    name: 'learn_music_preference',
    title: ui('Mémoriser une préférence musicale', 'Remember a music preference'),
    description: [
      ui(
        'Enregistre le choix A ou B de l’auditeur après une comparaison accompaniment ou breath. Chaque lettre désigne la prise de cette comparaison. Répéter le même choix conserve le profil sans le réécrire.',
        'Save the listener’s A or B choice after an accompaniment or breath comparison. Each letter identifies a take from that comparison. Repeating the same choice leaves the profile file unchanged.',
      ),
      ui(
        'Si le manifeste est invalide, relance compare_music_choices et fais écouter les nouvelles prises avant de mémoriser un choix. Si le profil est en cours de mise à jour, réessaie dans un instant.',
        'If the manifest is invalid, run compare_music_choices again and audition the new takes before saving a choice. If the profile is being updated, retry shortly.',
      ),
      ui(
        'draft_music applique le profil aux prochaines esquisses. Passe-lui use_preferences=false pour l’ignorer le temps d’un appel.',
        'draft_music applies the profile to future drafts. Pass use_preferences=false to skip it for one draft.',
      ),
    ].join('\n'),
    inputSchema: { type: 'object', required: ['comparison_path', 'chosen'], properties: {
      comparison_path: { type: 'string', description: ui(
        'Valeur comparison_path de compare_music_choices avec criterion=accompaniment ou breath. Elle relie la lettre choisie à la variante entendue.',
        'comparison_path returned by compare_music_choices with criterion=accompaniment or breath. It maps the selected letter to the variant the listener heard.',
      ) },
      chosen: { type: 'string', enum: ['A', 'B'], description: ui('Lettre de la prise choisie explicitement par l’auditeur.', 'Letter of the take explicitly chosen by the listener.') },
      profile_path: { type: 'string', description: ui(
        'Profil JSON local à créer ou mettre à jour. Par défaut, utilise le profil SoundMCP configuré. Pour un autre profil, passe le même chemin à draft_music.',
        'Local JSON profile to create or update. Defaults to the configured SoundMCP profile. For a separate profile, pass the same path to draft_music.',
      ) },
    } },
  },
  {
    name: 'analyze_music',
    title: ui('Mesurer un rendu musical', 'Analyze a music render'),
    description: [
      ui('Mesure la sonie, les crêtes, la saturation et la stéréo. Fournis un seul chemin local.', 'Measure loudness, peaks, clipping, and stereo. Supply one local path.'),
      ui(
        'Avec wav_path, mesure le fichier WAV existant tel quel. Avec project_path, calcule le rendu en mémoire pour analyser aussi les pupitres, les répétitions et les écarts au brief. Les deux modes sont en lecture seule.',
        'wav_path measures the existing WAV as saved. project_path renders in memory to assess parts, repetition, and differences from the brief. Both modes are read-only.',
      ),
      ui(
        'Utilise wav_path pour contrôler le master livré. Pour retrouver les notes et les accords d’une mesure, utilise inspect_score.',
        'Use wav_path to check a delivered master. Use inspect_score to find a bar\'s notes and chords.',
      ),
    ].join('\n'),
    inputSchema: { type: 'object', properties: { project_path: PROJECT_SCHEMA,
      wav_path: { type: 'string', description: ui(
        'Chemin d’un WAV RIFF mono ou stéréo, PCM 16/24/32 bits ou flottant 32 bits, de 8 à 96 kHz et d’au plus 603 secondes.',
        'Path to a mono or stereo RIFF WAV. Supports 16-, 24-, or 32-bit PCM or 32-bit float, 8 to 96 kHz, and up to 603 seconds.',
      ) },
    }, oneOf: [{ required: ['project_path'] }, { required: ['wav_path'] }] },
  },
  {
    name: 'inspect_score',
    title: ui('Lire la partition', 'Inspect the score'),
    description: ui(
      'Consulte les accords et les notes d’un projet sans lancer de rendu. La réponse distingue les temps écrits des positions jouées. Pour paginer, renvoie next_offset dans offset avec le même filtre. Pour réécrire les notes, utilise edit_music avec edits[].type=write_measure.',
      'Read project chords and notes without rendering. Written beats and performed timing are separate. For the next page, use next_offset as offset with the same filter. To rewrite a bar, use edit_music with edits[].type=write_measure.',
    ),
    inputSchema: { type: 'object', required: ['project_path'], properties: { project_path: PROJECT_SCHEMA,
      start_bar: { ...REGION_SCHEMA.properties.start_bar, default: 1 },
      bars: { type: 'integer', minimum: 1, maximum: 12, description: ui('Nombre de mesures demandées. Par défaut, jusqu’à quatre mesures restantes.', 'Number of bars to read. Defaults to up to four remaining bars.') },
      part: { type: 'string', enum: PARTS, description: ui(
        'Restreint les notes à un pupitre, par exemple mel ou bass. La réponse conserve les accords de chaque mesure.',
        'Filter notes by part, for example mel or bass. Every bar still includes its chords.',
      ) },
      offset: { type: 'integer', minimum: 0, default: 0, description: ui(
        'Nombre d’événements à ignorer après filtrage. Reprends la valeur next_offset de la page précédente.',
        'Number of note events to skip after filtering. Reuse next_offset from the preceding page.',
      ) },
      limit: { type: 'integer', minimum: 1, maximum: 512, default: 160, description: ui(
        'Nombre maximal d’événements de notes dans cette page. La liste des mesures reste entière.',
        'Maximum number of note events on this page. The full list of bars is still returned.',
      ) },
    } },
  },
  {
    name: 'manage_outputs',
    title: ui('Retrouver et ranger les sorties', 'Find and manage outputs'),
    description: [
      ui(
        'Retrouve et range les sorties déjà enregistrées par SoundMCP dans un dossier de rendu.',
        'Find and organize outputs already registered by SoundMCP in a render directory.',
      ),
      ui(
        'Pour rouvrir un morceau, utilise list avec file_type=project et state=active. Passe le path du projet comme project_path à preview_music ou edit_music.',
        'To reopen a track, use list with file_type=project and state=active. Pass the project’s path as project_path to preview_music or edit_music.',
      ),
      ui(
        'Sur demande de l’utilisateur, déplace un fichier avec archive et annule le déplacement avec restore. Répéter la même action conserve l’état atteint. Un fichier occupant la destination est préservé et l’appel échoue.',
        'At the user’s request, move a file with archive and undo the move with restore. Repeating the same action preserves the resulting state. If another file occupies the destination, the call fails and leaves that file in place.',
      ),
    ].join('\n'),
    inputSchema: { type: 'object', required: ['action'], properties: {
      action: { type: 'string', enum: OUTPUT_ACTIONS, description: ui(
        'list retrouve les sorties, archive déplace un fichier, restore le remet à son chemin d’origine.',
        'list finds outputs, archive moves a file, and restore returns it to its original path.',
      ) },
      output_dir: { type: 'string', description: ui(
        'Valeur managed_outputs.output_dir du rendu ou output_dir de list. Sans valeur, utilise le dossier de sortie par défaut.',
        'The render’s managed_outputs.output_dir or the output_dir returned by list. Defaults to the configured output directory.',
      ) },
      file_id: { type: 'string', description: ui(
        'Identifiant renvoyé par list ou managed_outputs.files dans ce dossier. Requis pour archive et restore.',
        'ID returned by list or managed_outputs.files in this directory. Required for archive and restore.',
      ) },
      file_type: { type: 'string', enum: ['project'], description: ui('Pour list, ne retourne que les projets musicaux éditables enregistrés par SoundMCP.', 'With list, return only editable music projects registered by SoundMCP.') },
      state: { type: 'string', enum: OUTPUT_STATES, description: ui(
        'Pour list, limite les résultats aux fichiers actifs ou archivés. Par défaut, inclut les deux états.',
        'With list, filter active or archived files. Defaults to both states.',
      ) },
      offset: { type: 'integer', minimum: 0, default: 0, description: ui('Position de départ parmi les résultats filtrés pour list.', 'Start position among the filtered results for list.') },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 30, description: ui('Nombre maximal de fichiers renvoyés par list.', 'Maximum number of files returned by list.') },
    }, oneOf: [{ properties: { action: { const: 'list' } } },
      { properties: { action: { enum: ['archive', 'restore'] } }, required: ['file_id'] }] },
  },
  {
    name: 'create_music',
    title: ui('Exporter un morceau depuis un style', 'Compose and export from a style'),
    description: [
      ui(
        'Compose et exporte un instrumental à partir d’un style de list_catalog(category=music), avec un arrangement facultatif. Pour composer à partir d’un brief, utilise draft_music.',
        'Compose and export an instrumental in a style from list_catalog(category=music), optionally with an arrangement. Use draft_music to compose from a brief.',
      ),
      ui(
        'Combine format=both et stems=true pour livrer le WAV, le MIDI et les pupitres séparés. Ajoute save_project=true pour récupérer project_path. Demande des variantes alignées avec editions et choisis leurs mesures avec loop_region si nécessaire.',
        'Use format=both and stems=true for WAV, MIDI, and stems. Add save_project=true for project_path. Use editions for aligned variants and loop_region to choose their bars if needed.',
      ),
      ui(
        'Écrit dans output_dir ou dans le dossier output de SoundMCP. Un même titre, ou le même couple style et seed sans titre, peut écraser les fichiers de même nom.',
        'Writes to output_dir or SoundMCP\'s output directory. The same title, or the same style and seed without a title, can overwrite files with the same name.',
      ),
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        style: {
          type: 'string',
          enum: STYLE_IDS,
          description: ui('Style musical. Consulte la catégorie music de list_catalog.', 'Music style. See the music category in list_catalog.'),
        },
        duration_seconds: {
          type: 'number',
          minimum: 5,
          maximum: 600,
          description: ui('Durée cible en secondes (5 à 600). Arrondie à un nombre entier de mesures.', 'Target duration in seconds (5 to 600), rounded to whole bars.'),
        },
        tempo: {
          type: 'number',
          minimum: 40,
          maximum: 220,
          description: ui('Tempo en BPM (40-220). Optionnel : chaque style a un tempo naturel.', 'Tempo in BPM (40–220). Defaults to the style\'s normal tempo.'),
        },
        key: {
          type: 'string',
          description: ui(
            'Tonalité, ex. "A minor", "F# dorien", "la mineur", "C majeur". Optionnel : choisie selon le style sinon.',
            'Key, for example "A minor", "F# dorian", "la mineur", or "C majeur". Defaults to a key chosen for the style.',
          ),
        },
        seed: {
          type: 'integer',
          minimum: 0,
          maximum: 4294967295,
          description: ui('Graine de génération. 0 est une graine valide.', 'Generation seed. Zero is a valid seed.'),
        },
        loop: {
          type: 'boolean',
          description: ui(
            'Boucle sans raccord (pour fond de jeu continu). Par défaut : true pour la plupart des styles.',
            'Seamless loop for continuous game music. Defaults to true for most styles.',
          ),
        },
        format: {
          type: 'string',
          enum: ['wav', 'midi', 'both'],
          default: 'wav',
          description: ui('Format de sortie : wav (audio prêt), midi (éditable dans un DAW), both.', 'Output format: wav for audio, midi for editing in a DAW, or both.'),
        },
        sampling_rate: {
          type: 'integer',
          enum: [22050, 44100, 48000],
          default: 44100,
          description: ui('Fréquence d’échantillonnage du WAV en Hz. 44100 par défaut.', 'WAV sample rate in hertz. Defaults to 44100.'),
        },
        bit_depth: { type: 'integer', enum: [16, 24], default: 16, description: ui('Profondeur du master WAV. 24 bits pour le travail audio.', 'WAV master bit depth. Use 24 for production work.') },
        stems: { type: 'boolean', default: false, description: ui(
          'Ajoute les pupitres séparés, avec effets et avant mastering, en WAV 32 bits flottant. Nécessite wav ou both.',
          'Add separate stems with effects, before mastering, as 32-bit float WAV. Requires wav or both.',
        ) },
        palette: { ...PALETTE_SCHEMA, default: 'studio' },
        sound_design: SOUND_DESIGN_SCHEMA,
        orchestral_percussion: ORCHESTRAL_SCHEMA,
        phrasing: PHRASING_SCHEMA,
        ...MIX_PROPERTIES, ...PREFERENCE_PROPERTIES,
        ...INTERPRETATION_PROPERTIES,
        ...PATCH_IMPORT,
        save_project: { type: 'boolean', default: false, description: ui('Sauvegarde la partition et l’interprétation pour edit_music.', 'Save the score and performance for edit_music.') },
        ...EDITION_PROPERTIES,
        arrangement: ARRANGEMENT_SCHEMA,
        mono: {
          type: 'boolean',
          default: false,
          description: ui('Exporte en mono (taille moitié). À réserver aux fonds ambisoniques ou aux contraintes de taille.', 'Export one channel at half the file size.'),
        },
        output_dir: {
          type: 'string',
          description: ui('Dossier de sortie. Par défaut : <projet>/output.', 'Output directory. Defaults to <project>/output.'),
        },
        title: {
          type: 'string',
          description: ui('Titre de la piste (sert aussi de nom de fichier).', 'Track title, also used for the filename.'),
        },
      },
      required: ['style'],
      ...EXPORT_CONSTRAINTS,
    },
  },
  {
    name: 'edit_music',
    title: ui('Retoucher un projet musical', 'Edit a music project'),
    description: [
      ui(
        'Retouche un projet enregistré et exporte une copie éditable à côté du fichier source par défaut. Les retouches edits s’exécutent dans l’ordre, puis mix rééquilibre les pupitres.',
        'Edit a saved project and export an editable copy beside the source by default. edits are applied in order, then mix rebalances the parts.',
      ),
      ui(
        'Pour réécrire une mesure, relève ses accords avec inspect_score et fournis le numéro global de la mesure dans write_measure. Demande des variantes alignées avec editions et précise leur plage avec loop_region si nécessaire. stems requiert format=wav ou both.',
        'To rewrite a bar, get its chords from inspect_score and pass the absolute bar number to write_measure. Use editions for aligned variants and loop_region to choose their range. stems requires format=wav or both.',
      ),
      ui(
        'Préécoute le project_path de la copie avec preview_music. Utilise finish_music pour livrer la version retenue.',
        'Preview the copy\'s project_path with preview_music. Use finish_music on the chosen version.',
      ),
    ].join('\n'),
    inputSchema: {
      type: 'object', required: ['project_path'], properties: {
        project_path: PROJECT_SCHEMA,
        edits: { type: 'array', maxItems: 32, description: ui(
          'Retouches appliquées dans l’ordre. Par exemple {"type":"gain","section":1,"part":"mel","db":-3}.',
          'Edits in application order. For example {"type":"gain","section":1,"part":"mel","db":-3}.',
        ),
          items: { type: 'object', required: ['type'], properties: {
            type: { type: 'string', enum: Object.keys(MUSIC_EDIT_TYPES), description: ui(
              'gain ajuste le niveau, mute coupe un pupitre, replace_section régénère une section, write_measure réécrit les notes et shape_build modifie une montée.',
              'gain adjusts level, mute silences a part, replace_section regenerates a section, write_measure rewrites notes, and shape_build adjusts a build.',
            ) },
            ...BUILD_PROPERTIES,
            contour: { type: 'string', enum: [...CONTOURS, 'flat'], description: ui(
              'Pour shape_build, progressive intensifie l’accompagnement, break crée une rupture, flat retire la montée.',
              'For shape_build, progressive builds up the accompaniment, break creates a break, and flat removes the build.',
            ) },
            section: { ...SECTION_SELECTOR, description: ui(
              'Section visée par gain, mute ou replace_section. Nom exact ou numéro à partir de 1.',
              'Section for gain, mute, or replace_section. Use an exact name or one-based index.',
            ) },
            part: { type: 'string', enum: PARTS, description: ui('Pupitre à modifier, par exemple mel ou bass.', 'Part to edit, for example mel or bass.') },
            db: { type: 'number', minimum: -60, maximum: 12, description: ui('Variation relative de gain en dB. Une valeur négative atténue le pupitre.', 'Relative gain in dB. Negative values lower the part\'s level.') },
            replacement: { type: 'object', properties: SECTION_PROPERTIES, description: ui(
              'Paramètres à modifier lors de la régénération, par exemple accords ou instrumentation. La section garde son nombre de mesures.',
              'Regeneration settings such as chords or instrumentation. The bar count remains fixed.',
            ) },
            bar: { ...REGION_SCHEMA.properties.start_bar, description: ui('Numéro global de la mesure à réécrire, à partir de 1.', 'One-based absolute number of the bar to rewrite.') },
            notes: MEASURE_NOTES_SCHEMA,
            instrument: { type: 'string', description: ui(
              'Pour write_measure, timbre intégré ou identifiant de patch importé. Sans valeur, reprend l’instrument du pupitre.',
              'Built-in instrument or imported patch ID for write_measure. Defaults to the part\'s instrument.',
            ) },
          }, oneOf: Object.entries(MUSIC_EDIT_TYPES).map(([type, required]) => ({ properties: { type: { const: type } }, required })) } },
        mix: { type: 'object', additionalProperties: false, description: ui('Équilibre les pupitres après les retouches, sur une section ou le projet entier.', 'Rebalance parts after the edits, in a section or the whole project.'),
          properties: { section: SECTION_SELECTOR, strength: UNIT } },
        ending_variants: { type: 'integer', minimum: 1, maximum: 5, description: ui(
          'Exporte autant de copies avec des cadences différentes sur la dernière section. Chaque copie est un morceau non bouclé.',
          'Export copies with different final cadences. Each copy is a track with an ending.',
        ) },
        ...EXPORT_PROPERTIES,
        format: { ...EXPORT_PROPERTIES.format, default: 'wav' },
        sampling_rate: { ...SAMPLING_RATE, description: ui('Fréquence du WAV en hertz. À défaut, reprend celle du projet.', 'WAV sample rate in hertz. Defaults to the project\'s rate.') },
        bit_depth: { ...EXPORT_PROPERTIES.bit_depth, description: ui('Résolution du WAV en bits. À défaut, reprend celle du projet.', 'WAV bit depth. Defaults to the project\'s bit depth.') },
        ...PATCH_IMPORT,
        ...INTERPRETATION_PROPERTIES,
      },
      ...EXPORT_CONSTRAINTS,
    },
  },
  {
    name: 'create_sfx',
    title: ui('Créer ou reprendre un effet sonore', 'Create or revise a sound effect'),
    description: [
      ui(
        'Rend un effet ponctuel en WAV 16 bits. Pour un fond sonore continu, utilise create_ambience.',
        'Render a one-shot sound effect as 16-bit WAV. Use create_ambience for a continuous background.',
      ),
      ui(
        'Pour créer un effet, choisis kind dans list_catalog(category=sfx), par exemple coin. Le même couple kind et seed dans le même output_dir écrase le WAV précédent.',
        'For a new effect, choose kind from list_catalog(category=sfx), for example coin. The same kind and seed in the same output_dir overwrites the previous WAV.',
      ),
      ui(
        'Pour une variante, remplace kind par source_file_id. Reprends le file_id du WAV et son dossier dans source_output_dir. Indique uniquement les réglages à changer, par exemple volume=0.4. Le nouveau WAV est écrit dans un sous-dossier et la source est conservée.',
        'For a variant, use source_file_id in place of kind. Reuse the WAV\'s file_id and its directory in source_output_dir. Pass only settings to change, for example volume=0.4. The result is written to a subdirectory and the source is preserved.',
      ),
      ui(
        'Pour générer une famille, fournis variants avec count, par exemple {"count":6,"pitch_spread":0.8,"attack_spread_ms":12}. Chaque WAV numéroté a sa graine et ses réglages de reprise.',
        'To generate a family, use variants with count, for example {"count":6,"pitch_spread":0.8,"attack_spread_ms":12}. Each numbered WAV has its own seed and reusable settings.',
      ),
      ui(
        'Un identifiant inconnu dans ce dossier ou dépourvu de réglages compatibles renvoie une erreur.',
        'An unknown ID in this directory or one without compatible render settings returns an error.',
      ),
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: { ...PROCEDURAL_AUDIO_PROPERTIES,
        kind: { type: 'string', enum: SFX_IDS, description: ui('Identifiant d’effet issu de list_catalog(category=sfx) pour une création.', 'Sound effect ID from list_catalog(category=sfx) for a new render.') },
        pitch_semitones: { ...SFX_PITCH, description: ui('Décalage de hauteur en demi-tons. Par défaut, reprend la source ou utilise 0.', 'Pitch offset in semitones. Defaults to the source value or 0.') },
        attack_ms: { ...SFX_ATTACK, description: ui(
          'Fondu d’attaque en millisecondes ajouté à l’effet. Par défaut, reprend la source ou utilise 0.',
          'Attack fade added to the effect in milliseconds. Defaults to the source value or 0.',
        ) },
        variants: { type: 'object', required: ['count'], additionalProperties: false,
          description: ui(
            'Rend 2 à 12 prises d’un même effet dans un nouveau sous-dossier. La graine d’appel détermine les prises.',
            'Render 2 to 12 takes of one effect in a new subdirectory. The call\'s seed determines the takes.',
          ),
          properties: {
            count: { type: 'integer', minimum: 2, maximum: 12, description: ui('Nombre de WAV numérotés.', 'Number of numbered WAV files.') },
            pitch_spread: { ...SFX_PITCH_SPREAD, default: 0.8, description: ui('Écart maximal autour de pitch_semitones, en demi-tons.', 'Maximum offset around pitch_semitones, in semitones.') },
            attack_spread_ms: { ...SFX_ATTACK_SPREAD, default: 12, description: ui(
              'Variation maximale autour de attack_ms, en millisecondes. Le fondu appliqué reste positif ou nul.',
              'Maximum variation around attack_ms in milliseconds. The resulting fade is never negative.',
            ) },
          } },
      },
      oneOf: PROCEDURAL_AUDIO_MODES,
    },
  },
  {
    name: 'create_ambience',
    title: ui('Créer ou reprendre une ambiance', 'Create or revise an ambience'),
    description: [
      ui(
        'Rend un fond sonore continu en WAV 16 bits bouclable. Pour un son ponctuel, utilise create_sfx.',
        'Render a continuous, seamless background loop as 16-bit WAV. Use create_sfx for a one-shot sound.',
      ),
      ui(
        'Pour créer une ambiance, choisis kind dans list_catalog(category=ambiences), par exemple rain. Le même couple kind et seed dans le même output_dir écrase le WAV précédent, même si la durée change.',
        'For a new ambience, choose kind from list_catalog(category=ambiences), for example rain. The same kind and seed in the same output_dir overwrites the previous WAV even if the duration changes.',
      ),
      ui(
        'Pour une variante, remplace kind par source_file_id. Reprends le file_id du WAV et son dossier dans source_output_dir. Passe duration_seconds=20 pour obtenir une boucle de 20 secondes en conservant les autres réglages. Le nouveau WAV est écrit dans un sous-dossier et la source est conservée.',
        'For a variant, use source_file_id in place of kind. Reuse the WAV\'s file_id and its directory in source_output_dir. Set duration_seconds=20 for a 20-second loop with the other settings preserved. The result is written to a subdirectory and the source is preserved.',
      ),
      ui(
        'Un identifiant inconnu dans ce dossier ou dépourvu de réglages compatibles renvoie une erreur.',
        'An unknown ID in this directory or one without compatible render settings returns an error.',
      ),
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: { ...PROCEDURAL_AUDIO_PROPERTIES,
        kind: { type: 'string', enum: AMBIENCE_IDS, description: ui('Identifiant d’ambiance issu de list_catalog(category=ambiences) pour une création.', 'Ambience ID from list_catalog(category=ambiences) for a new render.') },
        duration_seconds: {
          type: 'number',
          minimum: 5,
          maximum: 600,
          description: ui(
            'Durée de la boucle en secondes. À défaut, reprend la durée source pour une variante ou celle de l’ambiance choisie.',
            'Loop duration in seconds. Defaults to the source duration for a variant or the chosen ambience\'s duration.',
          ),
        },
      },
      oneOf: PROCEDURAL_AUDIO_MODES,
    },
  },
].map((tool) => ({ ...tool, ...toolContract(tool.name, OUTPUT_TOOLS.has(tool.name)) }));

/* ---------------------------------- textes ---------------------------------- */

function listStylesText() {
  const lines = [ui('## Styles musicaux disponibles (create_music)', '## Music styles (create_music)')];
  lines.push('');
  for (const id of STYLE_IDS) {
    const s = STYLES[id];
    lines.push(`**${id}** — ${s.label}`);
    lines.push(`   ${s.desc}`);
    const tempo = `${s.defaults.tempo} BPM`, duration = fmtSec(s.defaults.duration);
    const loop = s.defaults.loop ? ui('oui', 'yes') : ui('non', 'no');
    lines.push(ui(`   Tempo par défaut : ${tempo} · durée : ${duration} · boucle : ${loop}`,
      `   Default tempo ${tempo} · duration ${duration} · loop ${loop}`));
    lines.push(ui(`   Idéal pour : ${s.use.join(', ')}`, `   Suitable for ${s.use.join(', ')}`));
    lines.push('');
  }
  lines.push(ui('## Ambiances disponibles (create_ambience)', '## Ambiences (create_ambience)'));
  lines.push('');
  lines.push(ui('Boucles de fond de jeu en continu — croise-les avec les musiques (ex. cave + dungeon).',
    'Layer a looping ambience under music, for example cave ambience under dungeon music.'));
  lines.push('');
  for (const id of AMBIENCE_IDS) {
    lines.push(`**${id}** — ${AMBIENCE_KINDS[id].desc}`);
  }
  lines.push('');
  lines.push(ui('## Effets sonores disponibles (create_sfx)', '## Sound effects (create_sfx)'));
  lines.push('');
  for (const id of SFX_IDS) {
    lines.push(`**${id}** — ${SFX_KINDS[id].desc}`);
  }
  lines.push('');
  lines.push(ui('## Astuces', '## Tips'));
  lines.push(`- ${TIP_SEED}`);
  lines.push(`- ${TIP_LOOP}`);
  lines.push(ui('- Ambiance en boucle : create_ambience produit toujours une boucle parfaite (crossfade intégré). Parfait pour recouvrir une musique : ambiance à ~40 % de volume sous la piste musicale.',
    '- create_ambience crossfades the loop. Try placing the ambience at about 40% volume under the music.'));
  lines.push(ui('- Fichiers plus légers : sampling_rate 22050 (taille moitié) et/ou mono — largement suffisant pour les fonds de jeu.',
    '- Use sampling_rate 22050 or mono to make smaller audio files.'));
  lines.push(ui('- Tonalité : accepte noms EN et FR — "A minor", "la mineur", "F# dorien", "C majeur", "F# mixolydien"…',
    '- Keys accept English and French names, including "A minor", "F# dorian", and "la mineur".'));
  lines.push(ui('- Instrumental uniquement. Pour la production, utilise sampling_rate: 48000 et bit_depth: 24. stems: true ajoute les pupitres avant mastering.',
    '- For production audio, set sampling_rate to 48000 and bit_depth to 24. stems adds pre-master stems.'));
  lines.push(ui('- MIDI : instruments séparés et marqueurs de sections. arrangement permet de choisir les accords, les pupitres et le motif.',
    '- MIDI includes separate instruments and section markers. Use arrangement to set chords, parts, and a motif.'));
  lines.push(ui('- Composition guidée : draft_music explore un brief ou compose une collection à partir de trois à six briefs. finish_music livre le projet choisi.',
    '- Use draft_music to explore one brief or compose three to six tracks. Use finish_music on the chosen project.'));
  lines.push(ui('- Timbres : la catégorie sounds de list_catalog présente la palette. Passe les identifiants à sounds dans play_sound.',
    '- Browse the sounds category of list_catalog and pass IDs to sounds in play_sound.'));
  lines.push(ui('- Synthèse : design_sound invente un son à partir d’un brief ou d’un patch. Importe le fichier patch_path dans patch_paths et affecte son identifiant dans patch_roles.',
    '- Use design_sound with a brief or patch. Import patch_path through patch_paths and assign its ID through patch_roles.'));
  lines.push(ui('- Studio : piano, contrebasse, batterie, cordes, bois, cor, guitares, harpe, vibraphone et violoncelles enregistrés.',
    '- The Studio palette records piano, upright bass, drums, strings, woodwinds, horn, guitars, harp, vibraphone, and cello.'));
  lines.push(ui('- Jeu : editions livre trois boucles et une transition alignées. cuts dans finish_music produit des formats de 15, 30 ou 60 secondes.',
    '- Use editions for aligned loops and a transition. finish_music can make 15-, 30-, or 60-second cuts.'));
  return lines.join('\n');
}

function musicSummaryText(meta, files, audio) {
  const lines = [];
  const title = meta.title || meta.styleLabel;
  lines.push(ui(`🎵 « ${title} » créé.`, `🎵 Created “${title}”.`));
  lines.push('');
  lines.push(ui('- Style : ', '- Style ') + `${meta.styleLabel} (${meta.style})`);
  lines.push(ui('- Ambiance : ', '- Mood ') + meta.description);
  lines.push(ui(`- Tonalité : ${meta.keyFr} (${meta.key})`, `- Key ${meta.key}`));
  lines.push(ui(`- Tempo : ${meta.tempo} BPM · ${meta.bars} mesures`, `- Tempo ${meta.tempo} BPM · ${meta.bars} bars`));
  lines.push(ui('- Progression : ', '- Progression ') + `${meta.progression} [${meta.progressionRomans}]`);
  if (meta.progressionB && meta.progressionB !== meta.progression) {
    lines.push(ui('- Section B : ', '- Section B ') + meta.progressionB);
  }
  lines.push(ui('- Structure : ', '- Structure ') + meta.sections.map((s) => `${s.name}(${s.bars})`).join(' → '));
  lines.push(ui('- Durée musicale : ', '- Music duration ') + `${meta.durationSeconds} s${meta.loop ? ui(' (boucle)', ' (loop)') : ''}`);
  if (audio) lines.push(ui('- WAV : ', '- WAV ') + `${audio.durationSeconds} s · ${audio.sr} Hz · ${audio.bits} bits · ${ui('crête', 'peak')} ${audio.peakDbfs ?? 'silence'} dBFS`);
  lines.push(ui('- Seed : ', '- Seed ') + `${meta.seed}. ${TIP_SEED}`);
  lines.push('');
  lines.push(ui('Fichiers :', 'Files'));
  for (const f of files) {
    lines.push(`- ${f.path} (${fmtBytes(f.bytes)})`);
  }
  if (meta.loop) lines.push('');
  lines.push(TIP_LOOP);
  lines.push(ui('Idéal pour : ', 'Suitable for ') + meta.idealFor.join(', '));
  return lines.join('\n');
}

/* ---------------------------------- exécution ---------------------------------- */

function musicOutputs(args, bitDepth = 16) {
  const format = args.format ?? 'wav';
  const bits = args.bit_depth ?? bitDepth;
  if (!['wav', 'midi', 'both'].includes(format)) throw new Error(ui(`Format invalide : ${format}.`, `Invalid format: ${format}.`));
  if (![16, 24].includes(bits)) throw new Error(ui('bit_depth attend 16 ou 24.', 'bit_depth must be 16 or 24.'));
  if (args.stems && format === 'midi') throw new Error(ui('stems nécessite format: wav ou both.', 'stems requires format wav or both.'));
  if (args.palette !== undefined && !PALETTES.includes(args.palette)) throw new Error(ui('palette attend studio ou synth.', 'palette must be studio or synth.'));
  return { format, bits, stems: args.stems };
}

function exportTrack(song, { format, bits, stems }, outputDir, base, onAudio) {
  const files = [];
  let audioInfo;
  if (format !== 'midi') {
    const parts = [];
    const onStem = stems ? (name, L, R, sr, mono) => {
      const file = path.join(outputDir, `${base}-stems`, `${name}.wav`);
      parts.push({ path: file, format: 'wav', stem: name, ...writeWav(file, L, R, sr, mono, 32) });
    } : undefined;
    const audio = renderSong(song, onStem);
    const file = path.join(outputDir, `${base}.wav`);
    const wav = writeWav(file, audio.L, audio.R, audio.sr, audio.mono, bits);
    onAudio?.(audio);
    files.push({ path: file, format: 'wav', ...wav }, ...parts);
    audioInfo = { sr: wav.sr, bits: wav.bits, channels: wav.channels,
      durationSeconds: Number((wav.samples / wav.sr).toFixed(3)), ...audio.metrics };
  }
  if (format !== 'wav') {
    const file = path.join(outputDir, `${base}.mid`);
    const midi = writeMidi(file, song, song.meta.title || song.meta.style);
    files.push({ path: file, format: 'midi', bytes: midi.bytes });
  }
  return { files, ...(audioInfo ? { audio: audioInfo } : {}) };
}

function exportMusic(song, outputs, outputDir, base, args, editions = getEditions(song, args.editions, args.loop_region), onAudio) {
  const exported = exportTrack(song, outputs, outputDir, base, onAudio);
  if (args.save_project) {
    const project = writeProject(path.join(outputDir, `${base}.soundmcp.json`), song, outputs.bits);
    exported.files.push(project);
    exported.project_path = project.path;
  }
  if (editions.length) {
    const manifest = editions.map(({ id, region, song: edition }) => {
      const { files, audio } = exportTrack(edition, { ...outputs, stems: false }, outputDir, `${base}-${id}`);
      exported.files.push(...files.map((file) => ({ ...file, edition: id })));
      return { id, ...region, sampleRate: song.sr, files: files.map((file) => path.basename(file.path)), ...(audio ? { audio } : {}) };
    });
    const file = path.join(outputDir, `${base}-editions.json`);
    const data = `${JSON.stringify({ title: song.meta.title, tempo: song.bpm, editions: manifest }, null, 2)}\n`;
    fs.writeFileSync(file, data);
    exported.files.push({ path: file, format: 'json', bytes: Buffer.byteLength(data) });
    exported.editions = manifest;
  }
  return { meta: { ...song.meta, palette: song.palette }, ...exported };
}

function resultText(text, structuredContent) {
  return { content: [{ type: 'text', text }], structuredContent };
}

function outputDirectory(value, fallback = DEFAULT_OUTPUT_DIR) {
  return value ? path.resolve(String(value)) : fallback;
}

function newFolder(root, name) {
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, `${slug(name)}-`));
}

function jsonFile(dir, name, data) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

function writePatch(directory, base, sound) {
  return jsonFile(directory, `${base}.soundmcp-patch.json`, { type: 'soundmcp-patch', version: 1, ...sound });
}

function writeAudition(directory, base, audio) {
  const file = path.join(directory, `${base}.wav`);
  writeWav(file, audio.L, audio.R, audio.sr, audio.mono, 24);
  return file;
}

function shuffle(items, seed) {
  const rng = makeRng(seed);
  for (let i = items.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [items[i], items[j]] = [items[j], items[i]];
  }
}

function openProject(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(ui('project_path est requis.', 'project_path is required.'));
  const source = path.resolve(value);
  return { source, ...readProject(source) };
}

function preferencesFor(args, defaultProfile) {
  if (args.use_preferences === false) return {};
  if (args.profile_path !== undefined) return readPreferences(args.profile_path);
  return defaultProfile || args.use_preferences ? readPreferences(DEFAULT_PROFILE, true) : {};
}

function production(song, args, calibrations, choices, autoMix = false) {
  const calibrated = applyCalibrations(song, calibrations);
  const mix = (args.auto_mix ?? autoMix) ? mixSong(calibrated, { strength: args.mix_strength }) : { song: calibrated, sections: [] };
  return { song: withPreferences(mix.song, choices), mix: mix.sections };
}

function withInterpretation(song, args) {
  if (args.performance === undefined && args.room === undefined) return song;
  return { ...song,
    ...(args.performance === undefined ? {} : { performance: readPerformance(args.performance) }),
    ...(args.room === undefined ? {} : { room: readRoom(args.room) }) };
}

function musicSeed(seed) {
  if (seed !== undefined && (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)) throw new Error(ui('seed attend un entier de 0 à 4294967295.', 'seed must be an integer from 0 to 4294967295.'));
  return seed ?? randomSeed();
}

function listSounds() {
  const sounds = Object.entries(AUDITION_SOUNDS).map(([id, [label, description, part]]) => ({ id, label, description, part,
    source: RECORDED_SOUNDS.has(id) ? ui('prise instrumentale', 'recorded instrument') : ui('synthèse', 'synthesis') }));
  const colors = {
    natural: ui('Sans traitement supplémentaire.', 'No additional processing.'),
    radio: ui('Bande étroite et presque mono.', 'Narrow frequency range and nearly mono.'),
    warm: ui('Aigus adoucis et image resserrée.', 'Softened highs and a narrower stereo image.'),
    rough: ui('Saturation légère et aigus filtrés.', 'Light saturation and filtered highs.'),
    wide: ui('Image stéréo élargie.', 'Wider stereo image.'),
  };
  return resultText(sounds.map(({ id, label, description }) => `- ${id} · ${label}. ${description}`).join('\n') +
    ui('\nCouleurs de section : ', '\nSection mix colors ') + Object.keys(colors).join(', ') +
    ui('\nPour inventer un son, appelle design_sound.', '\nUse design_sound to create a sound.'),
    { sounds, colors, instruments: Object.keys(INSTRUMENTS), designTool: 'design_sound' });
}

function listCatalog(category) {
  if (category === 'sounds') {
    const result = listSounds();
    const { sounds, ...details } = result.structuredContent;
    return { ...result, structuredContent: { category, items: sounds, ...details } };
  }
  if (!CATALOG_CATEGORIES.includes(category)) throw new Error(ui('category attend music, sfx, ambiences ou sounds.', 'category must be music, sfx, ambiences, or sounds.'));
  const items = category === 'music' ? STYLE_IDS.map((id) => {
    const { label, desc, defaults, use } = STYLES[id];
    return { id, label, description: desc, tempo: defaults.tempo, duration_seconds: defaults.duration, loop: defaults.loop, use };
  }) : (category === 'sfx' ? SFX_IDS : AMBIENCE_IDS).map((id) => ({ id, description: (category === 'sfx' ? SFX_KINDS : AMBIENCE_KINDS)[id].desc }));
  return resultText(items.map(({ id, description }) => `- ${id} · ${description}`).join('\n'), { category, items });
}

function designSound(args) {
  if ((args.brief === undefined) === (args.patch === undefined)) throw new Error(ui('Indique un brief ou un patch.', 'Supply a brief or a patch.'));
  const seed = musicSeed(args.seed);
  const patch = createPatch(args.title ?? ui('Son personnel', 'Custom sound'), args.patch ?? patchFromBrief(args.brief, seed));
  const duration = args.duration_seconds ?? 4;
  const gate = args.gate_seconds ?? Math.min(1.8, duration * 0.63);
  if (!Number.isFinite(duration) || duration < 0.7 || duration > 12 || !Number.isFinite(gate) || gate < 0.03 || gate > 10 || gate > duration - 0.15) {
    throw new Error(ui(
      'Durée de préécoute de 0.7 à 12 s, avec une tenue de 0.03 à 10 s qui tient dans le fichier.',
      'Preview duration must be 0.7 to 12 s, with a note hold of 0.03 to 10 s that fits within the file.',
    ));
  }
  const midi = noteNumber(args.note ?? 'C4');
  const velocity = args.velocity ?? 0.78;
  if (!Number.isFinite(velocity) || velocity < 0.05 || velocity > 1) throw new Error(ui('velocity doit être entre 0.05 et 1.', 'velocity must be between 0.05 and 1.'));
  const gesture = normalizeGesture(args.gesture);
  if (gesture && !supportsGesture(patch.patch)) throw new Error(GESTURE_PATCH_ERROR);
  const event = { t: 0.045, dur: gate, midi, freq: midiToFreq(midi), pan: 0, vel: velocity, inst: patch.id, bus: 'mel', seedIdx: seed, gesture };
  const audio = renderSong({ bpm: 60, totalBeats: duration - 0.12, bars: 1, sr: 48000, events: [event], loop: false,
    targetSeconds: duration, endFade: 0.08, patches: { [patch.id]: patch.patch } });
  const directory = newFolder(outputDirectory(args.output_dir), patch.label);
  const wavPath = path.join(directory, `${slug(patch.label)}.wav`);
  writeWav(wavPath, audio.L, audio.R, audio.sr, false, 24);
  const patchPath = writePatch(directory, slug(patch.label), patch);
  return resultText(`${patch.label} · ${duration} s\n${wavPath}\n${ui('Réglages :', 'Settings')} ${patchPath}\n${ui('Identifiant :', 'ID')} ${patch.id}`,
    { ...patch, preview_path: wavPath, patch_path: patchPath, seed, note: midi, audio: measure(audio) });
}

function calibration(args) {
  const sound = loadPatch(args);
  const result = calibrateSound(sound, args.role ?? 'mel', args.notes, musicSeed(args.seed));
  const folder = newFolder(outputDirectory(args.output_dir), `${sound.label}-calibration`);
  const calibration_path = jsonFile(folder, 'registre.soundmcp-calibration.json', result);
  const measurements = ui(`${result.probes.length} mesures sur le pupitre ${result.role}`,
    `${result.probes.length} measurements for part ${result.role}`);
  return resultText(`${sound.label} · ${measurements}\n${calibration_path}`, { ...result, calibration_path });
}

function soundAudition(args, seed) {
  const phrase = readPhrase(args, seed);
  const tech = techOptions({ sampling_rate: args.sampling_rate ?? 48000, mono: args.mono });
  return (sound) => playPhrase(sound, tech, phrase);
}

function playSound(args) {
  if (args.sounds !== undefined) {
    if (PHRASE_ONLY_FIELDS.some((name) => args[name] !== undefined)) {
      throw new Error(ui(
        'sounds écoute les extraits du catalogue. Pour jouer une phrase personnalisée, indique instrument, patch ou patch_path avec notes.',
        'sounds auditions catalog examples. To play a custom phrase, use instrument, patch, or patch_path with notes.',
      ));
    }
    return previewSounds(args);
  }
  const seed = musicSeed(args.seed);
  const sound = loadSound(args);
  if (!supportsGesture(sound.patch) && Array.isArray(args.notes) && args.notes.some((note) => note?.gesture !== undefined)) {
    throw new Error(GESTURE_PATCH_ERROR);
  }
  const audio = soundAudition(args, seed)(sound);
  const directory = newFolder(outputDirectory(args.output_dir), `${sound.label}-jeu`);
  const file = writeAudition(directory, 'phrase', audio);
  const stats = measure(audio);
  return resultText(`${sound.label} · ${stats.durationSeconds} s\n${file}`, { path: file, sound: sound.id, seed, audio: stats });
}

function compareSounds(args) {
  if (!Array.isArray(args.sounds) || args.sounds.length < 2 || args.sounds.length > 4) throw new Error(ui('sounds attend entre deux et quatre sons.', 'sounds requires two to four sounds.'));
  const seed = musicSeed(args.seed);
  const render = soundAudition(args, seed);
  const entries = args.sounds.map((source, index) => {
    const sound = loadSound(source);
    return { sourceIndex: index + 1, title: sound.label, id: sound.id, patch_path: source.patch_path, audio: render(sound) };
  });
  if (args.blind) shuffle(entries, hash32(seed, 605));
  const measures = matchLevels(entries.map(({ audio }) => audio), -18);
  const directory = newFolder(outputDirectory(args.output_dir), args.blind ? 'Sons a l’aveugle' : 'Comparer les sons');
  const identities = [];
  const files = entries.map(({ audio, ...identity }, i) => {
    const label = String.fromCharCode(65 + i);
    identities.push({ label, ...identity });
    return { label, path: writeAudition(directory, label, audio), ...measures[i], ...(args.blind ? {} : identity) };
  });
  const result = { files, ...(args.blind ? { reveal_path: jsonFile(directory, 'correspondance.json', identities) } : { seed }) };
  return resultText(files.map((file) => `${file.label} · ${file.integratedLufs ?? 'silence'} LUFS · ${file.path}`).join('\n'), result);
}

function varySound(args) {
  const seed = musicSeed(args.seed);
  const original = loadPatch(args);
  const { directions = ['darker', 'brighter', 'shorter'], amount = 0.7 } = args;
  if (!Number.isFinite(amount) || amount < 0.05 || amount > 1 || !Array.isArray(directions) || !directions.length ||
      directions.some((direction) => !DIRECTIONS.includes(direction)) || directions.length !== new Set(directions).size) {
    throw new Error(ui(
      'Indique des directions distinctes parmi brighter, darker, shorter, longer et amount entre 0.05 et 1.',
      'Choose distinct directions from brighter, darker, shorter, and longer, and an amount between 0.05 and 1.',
    ));
  }
  const variants = directions.map((direction) => variantSound(original, direction, amount));
  const clips = [original, ...variants].map(soundAudition(args, seed));
  const levels = matchLevels(clips, -18);
  const directory = newFolder(outputDirectory(args.output_dir), `${original.label}-variations`);
  const reference = { id: original.id, label: original.label, preview_path: writeAudition(directory, 'reference', clips[0]), audio: levels[0] };
  const sounds = variants.map((sound, i) => {
    const direction = directions[i];
    return { ...sound, direction, patch_path: writePatch(directory, direction, sound),
      preview_path: writeAudition(directory, direction, clips[i + 1]), audio: levels[i + 1] };
  });
  return resultText([reference, ...sounds].map((sound) => `${sound.label} · ${sound.preview_path}`).join('\n'), { reference, sounds, amount, seed });
}

function previewSounds(args) {
  const patches = importPatches(args.patch_paths);
  if (!Array.isArray(args.sounds) || !args.sounds.length || args.sounds.length > 12 ||
      args.sounds.some((id) => typeof id !== 'string' || (!Object.hasOwn(AUDITION_SOUNDS, id) && !Object.hasOwn(patches, id)))) {
    throw new Error(ui(
      'sounds attend 1 à 12 sons connus. Consulte la catégorie sounds de list_catalog.',
      'sounds requires 1 to 12 known sounds. See the sounds category of list_catalog.',
    ));
  }
  const timbre = args.timbre ?? 0.5;
  if (!Number.isFinite(timbre) || timbre < 0 || timbre > 1) throw new Error(ui('timbre doit être entre 0 et 1.', 'timbre must be between 0 and 1.'));
  const seed = musicSeed(args.seed);
  const sr = 44100, clipLength = 2.85, gap = 0.3;
  const clips = args.sounds.map((id, index) => {
    const [, , bus, pitch] = AUDITION_SOUNDS[id] ?? [id, '', 'mel', 60];
    const notes = bus === 'texture' || bus === 'bass' ? [[0.03, pitch, 1.94]]
      : bus === 'pad' ? [[0.03, pitch, 1.9], [0.21, pitch + 7, 1.72]] : [[0.03, pitch, 0.84], [1.06, pitch + 3, 1.02]];
    const events = notes.map(([t, midi, dur], n) => ({ t, dur, midi, freq: midiToFreq(midi), vel: 0.68, pan: 0,
      timbre, bus, inst: id, seedIdx: hash32(seed, index * 7 + n), take: n }));
    return renderSong({ bpm: 60, totalBeats: 2.35, bars: 1, sr, events, loop: false, targetSeconds: clipLength,
      endFade: 0.24, palette: 'studio', bankVersion: 3, patches });
  });
  const volumes = matchLevels(clips, -18);
  const stride = Math.round(sr * (clipLength + gap));
  const samples = (clips.length - 1) * stride + clips[0].samples;
  const L = new Float32Array(samples), R = new Float32Array(samples);
  const markers = args.sounds.map((id, i) => {
    L.set(clips[i].L, i * stride);
    R.set(clips[i].R, i * stride);
    return { sound: id, label: AUDITION_SOUNDS[id]?.[0] ?? id, from: Number((i * stride / sr).toFixed(3)), integratedLufs: volumes[i].integratedLufs };
  });
  const folder = newFolder(outputDirectory(args.output_dir), 'Palette sonore');
  const file = path.join(folder, 'palette.wav');
  writeWav(file, L, R, sr, false, 24);
  return resultText(`${file}\n` + markers.map(({ from, label }) => `- ${from} s · ${label}`).join('\n'),
    { path: file, markers, seed, timbre });
}

function draftMusic(args) {
  const collection = args.briefs !== undefined;
  if (collection && (args.brief !== undefined || args.variants !== undefined)) throw new Error(ui('briefs donne un morceau par entrée. Omet brief et variants.', 'briefs produces one track per entry. Omit brief and variants.'));
  if (collection && (!Array.isArray(args.briefs) || args.briefs.length < 3 || args.briefs.length > 6)) {
    throw new Error(ui('briefs attend de trois à six briefs, un par morceau.', 'briefs requires three to six briefs, one per track.'));
  }
  const source = args.source_excerpt;
  if (source !== undefined && (!source || typeof source !== 'object' || Array.isArray(source) ||
      Object.keys(source).some((field) => !['project_path', 'region', 'preserve'].includes(field)) ||
      ['briefs', 'motif', 'midi_motif'].some((field) => args[field] !== undefined))) {
    throw new Error(ui('Utilise source_excerpt avec un seul brief, sans motif ni midi_motif.',
      'Use source_excerpt with one brief and omit motif and midi_motif.'));
  }
  const development = source === undefined ? undefined : readDevelopment(openProject(source.project_path).song, source);
  const palette = args.palette ?? (development?.excerpt.preserve.includes('instruments') ? development.palette : 'studio');
  if (!PALETTES.includes(palette)) throw new Error(ui('palette attend studio ou synth.', 'palette must be studio or synth.'));
  if (args.midi_motif !== undefined && args.motif !== undefined) throw new Error(ui('Choisis motif ou midi_motif.', 'Choose motif or midi_motif.'));
  const midiImport = args.midi_motif === undefined ? undefined : readMidiMotif(args.midi_motif);
  const briefOptions = development ? { ...args, development, motif: development.motif }
    : midiImport ? { ...args, midiImport } : args;
  const intents = Array.from(collection ? args.briefs : [args.brief], (brief, index) => {
    try {
      return interpretBrief(brief, briefOptions);
    } catch (error) {
      if (!collection) throw error;
      throw new Error(ui(`Morceau ${index + 1} : ${error.message}`, `Track ${index + 1}: ${error.message}`));
    }
  });
  if (args.build_contour !== undefined && !CONTOURS.includes(args.build_contour)) {
    throw new Error(ui('build_contour attend progressive ou break.', 'build_contour must be progressive or break.'));
  }
  const choices = preferencesFor(args, true);
  const plans = intents.map((intent) => {
    const imported = development && Object.fromEntries(Object.entries(development.roles)
      .filter(([, instrument]) => !intent.excluded.includes(instrument)));
    return { ...intent, palette, autoMix: args.auto_mix ?? intent.phrasing === 'lyrical',
      ...(development ? { sourceExcerpt: development.excerpt, sourceProgression: development.progression,
        instrumentRoles: { ...imported, ...intent.instrumentRoles } } : {}),
      ...(args.build_contour ? { buildContour: args.build_contour } : {}),
      ...(Object.keys(choices).length ? { preferences: choices } : {}) };
  });
  const patches = importPatches(args.patch_paths, development?.patches);
  const calibrations = loadCalibrations(args.calibration_paths);
  const seed = musicSeed(args.seed);
  const count = args.variants ?? 3;
  if (!Number.isInteger(count) || count < 1 || count > 3) throw new Error(ui('variants attend de 1 à 3 esquisses.', 'variants must be between 1 and 3 drafts.'));
  const defaultTitle = collection ? ui('Collection instrumentale', 'Instrumental collection') : ui('Esquisses instrumentales', 'Instrumental drafts');
  const title = args.title ? String(args.title) : defaultTitle;
  const jobs = collection
    ? plans.map((plan, index) => ({ plan, seed: hash32(seed, index + 1), variant: 0,
      title: `${index + 1} · ${Array.from(plan.brief.replace(/\s+/g, ' ')).slice(0, 65).join('')}` }))
    : Array.from({ length: count }, (_, variant) => ({ plan: plans[0], seed, variant, title: `${title} — ${variant + 1}` }));
  const drafts = jobs.map((job) => {
    const { plan, seed: draftSeed, variant } = job;
    const arranged = withInterpretation(assignPatchRoles(arrange(plan, draftSeed, variant, job.title), args.patch_roles, patches), args);
    const prepared = plan.buildContour && arranged.bars > 1
      ? shapeBuild(arranged, { arrival_bar: arrivalBar(arranged), contour: plan.buildContour }) : arranged;
    const { song, mix } = production(prepared, args, calibrations, choices, plan.autoMix);
    const fragment = excerpt(song);
    const audio = renderSong(fragment.song);
    return { song, fragment, audio, mix, plan, draftSeed };
  });
  const levels = matchLevels(drafts.map((draft) => draft.audio));
  const outputDir = newFolder(outputDirectory(args.output_dir), title);
  const candidates = drafts.map(({ song, fragment, audio, mix, plan, draftSeed }, i) => {
    const base = `${collection ? 'morceau' : 'esquisse'}-${i + 1}`;
    const previewPath = path.join(outputDir, `${base}.wav`);
    const projectPath = path.join(outputDir, `${base}.soundmcp.json`);
    writeWav(previewPath, audio.L, audio.R, audio.sr, audio.mono, 24);
    writeProject(projectPath, song, 24);
    const gaps = plan.instruments.filter((name) => !song.meta.instruments.includes(name));
    const warnings = diagnose(levels[i]);
    if (plan.buildContour && song.bars === 1) warnings.push(ui('La montée demande au moins deux mesures.', 'A build needs at least two bars.'));
    if (gaps.length) warnings.push(ui('Instruments demandés absents : ', 'Missing requested instruments: ') + `${gaps.join(', ')}.`);
    if (plan.loop && Math.abs(song.meta.durationSeconds - plan.duration) > 0.05) {
      warnings.push(ui('Durée musicale arrondie à une mesure complète pour la boucle.', 'Music duration rounded to a whole bar for looping.'));
    }
    if (!plan.loop && song.targetSeconds > plan.duration + 0.05) {
      warnings.push(plan.sourceExcerpt
        ? ui('Durée étendue pour présenter l’extrait et sa cadence.', 'Duration extended to fit the source excerpt and cadence.')
        : plan.midi_source
        ? ui('Durée étendue pour présenter le motif MIDI complet et une cadence.', 'Duration extended to fit the full MIDI motif and a cadence.')
        : ui('Une mesure entière dépasse la durée demandée à ce tempo.', 'A full bar is longer than the requested duration at this tempo.'));
    }
    return { id: i + 1, project_path: projectPath, preview_path: previewPath, music: song.meta,
      ...(plan.midi_source ? { midi_source: plan.midi_source } : {}),
      ...(collection ? { brief: plan.brief, seed: draftSeed, title: song.meta.title } : {}),
      preview: { ...fragment.region, ...levels[i] }, ...(mix.length ? { mix } : {}), warnings };
  });
  const preferred = candidates.reduce((a, b) => b.warnings.length < a.warnings.length ? b : a);
  if (collection) {
    const shared_options = Object.fromEntries(Object.keys(DRAFT_MUSIC_OPTIONS).filter((name) => args[name] !== undefined)
      .map((name) => [name, args[name]]));
    const result = { mode: 'collection', title, seed, shared_options, candidates, firstToPreview: preferred.id };
    result.report_path = jsonFile(outputDir, 'collection.json', result);
    return resultText(`${title} · ${candidates.length} ${ui('morceaux', 'tracks')}\n` + candidates.map((candidate) =>
      `- ${candidate.title} · ${candidate.music.style} · ${candidate.music.tempo} BPM\n  ${ui('Préécoute :', 'Preview')} ${candidate.preview_path}\n  ${ui('Projet :', 'Project')} ${candidate.project_path}`).join('\n') +
      ui('\nPour livrer un morceau, passe son project_path à finish_music.', '\nPass a track’s project_path to finish_music to render it.'), result);
  }
  const [plan] = plans;
  const result = { seed, plan, candidates, firstToPreview: preferred.id,
    ...(development ? { source_excerpt: development.excerpt } : {}) };
  result.report_path = jsonFile(outputDir, 'esquisses.json', result);
  const summary = ui(`${count} esquisse(s) instrumentale(s), style ${plan.style}, ${plan.tempo} BPM.\n`,
    `${count} instrumental ${count === 1 ? 'draft' : 'drafts'} · ${plan.style} · ${plan.tempo} BPM.\n`);
  return resultText(summary +
    candidates.map((c) => `- ${c.id}. ${c.music.key} · ${c.preview.integratedLufs ?? 'silence'} LUFS · ${c.preview_path}\n  ${ui('Projet :', 'Project')} ${c.project_path}`).join('\n') +
    ui('\nPasse le project_path retenu à finish_music.', '\nPass the chosen project_path to finish_music.'), result);
}

function previewFragment(song, args) {
  if (!args.full) return excerpt(song, args);
  if (args.full && (args.section !== undefined || args.region !== undefined || args.max_seconds !== undefined)) {
    throw new Error(ui('full s’utilise sans section, region ni max_seconds.', 'Use full without section, region, or max_seconds.'));
  }
  const body = musicClock(song).seconds;
  const duration = song.loop ? body : song.targetSeconds ?? body + 2.6;
  if (duration > 45) throw new Error(ui('full attend des morceaux de 45 secondes ou moins.', 'full requires a track of 45 seconds or less.'));
  return { song, region: { startBar: 1, bars: song.bars } };
}

function previewMusic(args) {
  if (args.project_path !== undefined && args.project_paths !== undefined) throw new Error(ui('Choisis project_path ou project_paths.', 'Choose project_path or project_paths.'));
  const paths = args.project_paths ?? [args.project_path];
  if (!Array.isArray(paths) || !paths.length || paths.length > 3) throw new Error(ui('La comparaison accepte 1 à 3 projets.', 'The comparison accepts 1 to 3 projects.'));
  const previews = paths.map((input) => {
    const project = openProject(input);
    const fragment = previewFragment(project.song, args);
    return { ...fragment, source: project.source, sourceTitle: project.song.meta.title, audio: renderSong(fragment.song) };
  });
  if (args.blind) shuffle(previews, musicSeed(args.seed));
  const levels = matchLevels(previews.map((clip) => clip.audio));
  const outputDir = newFolder(outputDirectory(args.output_dir), args.blind ? 'Ecoute-aveugle' : 'Preecoute');
  const files = previews.map(({ audio, region, source, sourceTitle }, i) => {
    const label = String.fromCharCode(65 + i);
    const out = path.join(outputDir, `${label}.wav`);
    writeWav(out, audio.L, audio.R, audio.sr, audio.mono, 24);
    return { label, path: out, ...levels[i], ...(args.blind ? {} : { region, source, title: sourceTitle }) };
  });
  const result = { files };
  if (args.blind) {
    result.reveal_path = jsonFile(outputDir, 'correspondance.json', previews.map(({ source, sourceTitle, region }, i) => ({ label: files[i].label, source, title: sourceTitle, region })));
  }
  return resultText(files.map((file) => `${file.label} · ${file.integratedLufs ?? 'silence'} LUFS · ${file.path}`).join('\n'), result);
}

function mixMusic(args) {
  const project = openProject(args.project_path);
  const index = args.section === undefined ? undefined : sectionIndex(project.song, args.section);
  const result = mixSong(project.song, { strength: args.mix_strength, sectionIndex: index });
  const title = args.title ? String(args.title) : `${project.song.meta.title ?? 'Morceau'} — mix`;
  const folder = newFolder(outputDirectory(args.output_dir, path.dirname(project.source)), title);
  const song = { ...result.song, meta: { ...result.song.meta, title } };
  const exported = exportMusic(song, musicOutputs({ format: 'wav' }, project.bit_depth), folder, slug(title), { save_project: true });
  return resultText(musicSummaryText(exported.meta, exported.files, exported.audio), { ...exported, mix: result.sections });
}

function compareMusicChoices(args) {
  const { criterion } = args;
  if (criterion === 'loop') {
    if (['full', 'seed', 'arrival_bar', 'before_bars', 'after_bars', 'amount'].some((name) => args[name] !== undefined)) {
      throw new Error(ui('Avec loop, choisis une région, max_seconds ou loop_options.', 'For loop, use a region, max_seconds, or loop_options.'));
    }
    const { song } = openProject(args.project_path);
    const takes = previewLoopChoices(song, args);
    const levels = matchLevels(takes.map((take) => take.audio), -17, takes.map((take) => take.reference));
    const folder = newFolder(outputDirectory(args.output_dir), ui('Raccords de boucle', 'Loop joins'));
    const files = takes.map(({ audio, adaptive, metrics, seconds }, index) => {
      const label = ['A', 'B', 'C'][index];
      return { label, path: writeAudition(folder, label, audio), ...levels[index], adaptive, metrics, join_seconds: seconds };
    });
    return resultText(ui('Raccords classés, deux tours par WAV.', 'Ranked joins, two turns per WAV.') + '\n' +
      files.map(({ label, path: file, adaptive: { loop_region } }) =>
        `${label} · ${ui('mesure', 'bar')} ${loop_region.start_bar} · ${loop_region.bars} ${ui('mesure(s)', 'bars')} · ${file}`).join('\n') +
      '\n' + ui('Passe adaptive de la prise choisie à finish_music.', 'Pass the chosen take’s adaptive settings to finish_music.'), { criterion, files });
  }
  if (args.loop_options !== undefined) throw new Error(ui('loop_options exige criterion=loop.', 'loop_options requires criterion=loop.'));
  if (criterion === 'build') {
    if (['region', 'full', 'max_seconds'].some((name) => args[name] !== undefined)) {
      throw new Error(ui(
        'Pour build, situe l’arrivée avec section ou arrival_bar, puis borne le passage avec before_bars et after_bars.',
        'For build, locate the arrival with section or arrival_bar, then bound the excerpt with before_bars and after_bars.',
      ));
    }
    const result = compareBuilds(args);
    return { ...result, structuredContent: { criterion, ...result.structuredContent } };
  }
  if (!Object.hasOwn(CHOICES, criterion)) throw new Error(ui(`criterion attend ${MUSIC_COMPARISON_CRITERIA.join(' ou ')}.`, `criterion must be one of ${MUSIC_COMPARISON_CRITERIA.join(', ')}.`));
  if (['arrival_bar', 'before_bars', 'after_bars', 'amount'].some((name) => args[name] !== undefined)) {
    throw new Error(ui(
      'Les réglages de montée exigent criterion build. Utilise section ou region pour ce critère.',
      'Build settings require criterion build. Use section or region for this criterion.',
    ));
  }
  const { song, bit_depth } = openProject(args.project_path);
  const region = previewFragment(song, args).region;
  const normal = applyPreference(song, criterion, 'normal', region);
  const alternative = applyPreference(normal, criterion, CHOICES[criterion], region);
  if (alternative === normal) throw new Error(ui('Ce passage ne contient aucune note compatible avec ce critère.', 'This excerpt has no notes compatible with the criterion.'));
  const takes = [{ option: 'normal', song: normal, audio: renderSong(previewFragment(normal, args).song) },
    { option: CHOICES[criterion], song: alternative, audio: renderSong(previewFragment(alternative, args).song) }];
  shuffle(takes, musicSeed(args.seed));
  const levels = matchLevels(takes.map((take) => take.audio));
  const folder = newFolder(outputDirectory(args.output_dir), 'Choix a l’aveugle');
  const files = takes.map(({ audio }, index) => {
    const label = index === 0 ? 'A' : 'B';
    return { label, path: writeAudition(folder, label, audio), ...levels[index] };
  });
  const manifest = takes.map((take, index) => {
    const { label } = files[index];
    const project_path = writeProject(path.join(folder, `${label}.soundmcp.json`), take.song, bit_depth).path;
    files[index].project_path = project_path;
    return { label, option: take.option, project_path };
  });
  const comparison_path = jsonFile(folder, 'choix.soundmcp-comparison.json', choiceManifest(criterion, manifest));
  return resultText(files.map((file) => `${file.label} · ${file.path}`).join('\n'), { criterion, files, comparison_path });
}

function arrivalBar(song) {
  const later = song.meta.sections.filter((s) => s.startBar > 1);
  const reprise = later.find((s) => s.name === 'Reprise');
  if (reprise) return reprise.startBar;
  return later.reduce((best, section) => !best || (section.energy ?? 0) > (best.energy ?? 0) ? section : best, undefined)?.startBar ??
    Math.max(2, Math.min(song.bars, Math.round(song.bars * .68) + 1));
}

function compareBuilds(args) {
  const { song, bit_depth } = openProject(args.project_path);
  if (args.section !== undefined && args.arrival_bar !== undefined) throw new Error(ui('Indique une section ou arrival_bar.', 'Supply a section or arrival_bar.'));
  const arrival = args.section === undefined ? args.arrival_bar ?? arrivalBar(song)
    : song.meta.sections[sectionIndex(song, args.section)].startBar;
  const window = buildWindow(song, { ...args, arrival_bar: arrival });
  const available = song.bars - arrival + 1;
  let after = args.after_bars ?? Math.min(2, available);
  if (!Number.isInteger(after) || after < 1 || after > Math.min(8, available)) throw new Error(ui('after_bars doit tenir dans la partition, entre 1 et 8.', 'after_bars must fit within the score and be between 1 and 8.'));
  if (args.amount === 0) throw new Error(ui('Une comparaison demande une intensité supérieure à zéro.', 'A comparison requires an intensity greater than zero.'));
  const clock = musicClock(song);
  const previewLength = () => clock.at(window.arrival + after * 4) - clock.at(window.start);
  while (previewLength() + .65 > 45) {
    if (args.before_bars === undefined && window.arrival - window.start > 4) window.start += 4;
    else if (args.after_bars === undefined && after > 1) after--;
    else throw new Error(ui('La préécoute dépasse 45 secondes. Réduis before_bars ou after_bars.', 'The preview exceeds 45 seconds. Reduce before_bars or after_bars.'));
  }
  const startBar = window.start / 4 + 1;
  const before = arrival - startBar;
  const first = clock.at(window.start), anchor = clock.at(window.arrival);
  const seconds = previewLength();
  const controls = { arrival_bar: arrival, before_bars: before, amount: args.amount };
  const sr = 44100;
  const takes = CONTOURS.map((contour) => {
    const full = shapeBuild(song, { ...controls, contour });
    const fragment = sliceSong(full, startBar, before + after);
    const audio = renderSong({ ...fragment, sr, endFade: .60, targetSeconds: seconds + .65 });
    const edge = Math.round((anchor - first) * sr);
    const stop = Math.round((clock.at(window.arrival + 4 * Math.min(after, 2)) - first) * sr);
    const reference = { ...audio, L: audio.L.subarray(edge, stop), R: audio.R.subarray(edge, stop) };
    return { contour, full, audio, reference };
  });
  if (!takes[0].audio.L.some((sample, i) => sample !== takes[1].audio.L[i] || takes[0].audio.R[i] !== takes[1].audio.R[i])) {
    throw new Error(ui('Ce passage ne contient pas d’accompagnement audible dans la montée.', 'This excerpt has no audible accompaniment during the build.'));
  }
  shuffle(takes, musicSeed(args.seed));
  const references = takes.map((take) => take.reference);
  const anchored = references.every((ref) => measure(ref).integratedLufs !== null);
  const levels = matchLevels(takes.map((take) => take.audio), -17, anchored ? references : undefined);
  const folder = newFolder(outputDirectory(args.output_dir), 'Montees A B');
  const files = takes.map(({ audio, full, reference }, i) => {
    const label = i ? 'B' : 'A';
    const project_path = writeProject(path.join(folder, `${label}.soundmcp.json`), full, bit_depth).path;
    return { label, path: writeAudition(folder, label, audio), project_path, ...levels[i], arrivalLufs: measure(reference).integratedLufs };
  });
  const reveal_path = jsonFile(folder, 'correspondance.json', files.map(({ label, project_path }, i) => ({ label, project_path, contour: takes[i].contour })));
  const region = { startBar, bars: before + after, arrivalBar: arrival, arrivalSeconds: Number((anchor - first).toFixed(3)) };
  return resultText(files.map(({ label, path: file }) => `${label} · ${file}`).join('\n'),
    { files, region, levelMatching: anchored ? 'arrival' : 'excerpt', reveal_path });
}

function analyzeMusic(args) {
  if ((args.project_path === undefined) === (args.wav_path === undefined)) throw new Error(ui('Indique un project_path ou un wav_path.', 'Supply a project_path or a wav_path.'));
  let report;
  if (args.wav_path !== undefined) {
    if (typeof args.wav_path !== 'string' || !args.wav_path.trim()) throw new Error(ui('Chemin WAV invalide.', 'Invalid WAV path.'));
    report = measure(readWave(path.resolve(args.wav_path)));
    report.warnings = diagnose(report);
  } else {
    const { song } = openProject(args.project_path);
    const stems = {};
    const audio = renderSong(song, (part, L, R) => { stems[part] = { rmsDbfs: localRms(L, R) }; });
    report = scoreMetrics(song, audio, stems);
    report.title = song.meta.title;
  }
  const text = `${report.durationSeconds} s · ${report.integratedLufs ?? 'silence'} LUFS · ${ui('crête échantillon', 'sample peak')} ${report.samplePeakDbfs ?? 'silence'} dBFS.\n` +
    (report.warnings.length ? report.warnings.join('\n') : ui('Aucun problème détecté par les contrôles automatiques.', 'Automated checks found no issues.'));
  return resultText(text, report);
}

function finishMusic(args) {
  const project = openProject(args.project_path);
  const opts = { ...args, format: args.format ?? 'both' };
  if (opts.stems === undefined) opts.stems = opts.format !== 'midi';
  const outputs = musicOutputs(opts, 24);
  const tech = techOptions({ sampling_rate: args.sampling_rate ?? 48000, mono: args.mono ?? project.song.mono });
  const title = args.title ? String(args.title) : project.song.meta.title ?? project.song.meta.styleLabel;
  const song = { ...project.song, ...tech, palette: args.palette ?? project.song.palette, meta: { ...project.song.meta, title } };
  const requested = args.cuts ?? [];
  if (!Array.isArray(requested) || new Set(requested).size !== requested.length || requested.some((cut) => ![15, 30, 60].includes(cut))) {
    throw new Error(ui('cuts attend une liste sans doublon parmi 15, 30 et 60.', 'cuts must be a list of distinct durations chosen from 15, 30, and 60.'));
  }
  const editions = getEditions(song, args.editions, args.loop_region);
  const adaptivePlan = planAdaptiveMusic(song, args.adaptive, opts.format);
  const cuts = requested.map((seconds) => cutMusic(song, seconds));
  const outputDir = newFolder(outputDirectory(args.output_dir, path.dirname(project.source)), `${title}-master`);
  const base = slug(title);
  let adaptive;
  const renderAdaptive = adaptivePlan && ((audio) => {
    adaptive = exportAdaptiveMusic(song, adaptivePlan, path.join(outputDir, 'adaptive'), base, outputs.bits, audio);
  });
  const result = exportMusic(song, outputs, outputDir, base, { ...opts, save_project: true }, editions, renderAdaptive);
  if (adaptive) {
    result.adaptive = adaptive.manifest;
    result.files.push(...adaptive.files);
  }
  if (cuts.length) {
    result.cuts = cuts.map((cut) => {
      const seconds = cut.meta.cutSeconds;
      const exported = exportTrack(cut, { ...outputs, stems: false }, outputDir, `${base}-${seconds}s`);
      const files = exported.files.map((file) => ({ ...file, cutSeconds: seconds }));
      result.files.push(...files);
      return { seconds, sections: cut.meta.sections.map((section) => section.name), ...exported, files };
    });
  }
  result.report_path = jsonFile(outputDir, 'livraison.json', result);
  return resultText(musicSummaryText(result.meta, result.files, result.audio), result);
}

function sfxControl(value, { minimum, maximum }, name) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(ui(`${name} attend une valeur de ${minimum} à ${maximum}.`, `${name} must be between ${minimum} and ${maximum}.`));
  }
  return value;
}

function sfxFamily(kind, args, control, options) {
  if (!args || typeof args !== 'object' || Array.isArray(args) ||
      Object.keys(args).some((key) => !['count', 'pitch_spread', 'attack_spread_ms'].includes(key))) {
    throw new Error(ui('variants attend count, pitch_spread ou attack_spread_ms.', 'variants accepts count, pitch_spread, and attack_spread_ms.'));
  }
  const { count, pitch_spread = 0.8, attack_spread_ms = 12 } = args;
  if (!Number.isInteger(count) || count < 2 || count > 12) throw new Error(ui('variants.count attend un entier de 2 à 12.', 'variants.count must be an integer from 2 to 12.'));
  sfxControl(pitch_spread, SFX_PITCH_SPREAD, 'variants.pitch_spread');
  sfxControl(attack_spread_ms, SFX_ATTACK_SPREAD, 'variants.attack_spread_ms');
  const directory = newFolder(options.outputDir, `${kind}-variantes`);
  const rng = makeRng(hash32(control.seed, 742));
  const rounded = (value) => Number(value.toFixed(4));
  const variants = Array.from({ length: count }, (_, i) => {
    const index = i + 1;
    const seed = hash32(control.seed, index);
    const pitch = control.pitch_semitones + (2 * i / (count - 1) - 1) * pitch_spread;
    const attack = control.attack_ms + rng.f(-attack_spread_ms, attack_spread_ms);
    const pitch_semitones = rounded(Math.max(-6, Math.min(6, pitch)));
    const attack_ms = rounded(control.attack_ms === 0 ? Math.abs(attack) : Math.max(0, Math.min(100, attack)));
    const take = createSfx(kind, { ...options, outputDir: directory, index, seed, pitchSemitones: pitch_semitones, attackMs: attack_ms });
    return { ...take, index, render_settings: { ...control, seed, pitch_semitones, attack_ms } };
  });
  return resultText(ui(`${variants.length} prises de ${kind}`, `${variants.length} takes of ${kind}`) + ` · ${directory}\n` +
    variants.map(({ index, path: file, seed }) => `- ${index}. ${file} · seed ${seed}`).join('\n'),
  { kind, seed: control.seed, directory, variants });
}

function proceduralAudio(name, args) {
  const isAmbience = name === 'create_ambience';
  const catalog = isAmbience ? AMBIENCE_KINDS : SFX_KINDS;
  const generator = isAmbience ? createAmbience : createSfx;
  const sourceId = args.source_file_id;
  if (sourceId !== undefined && args.kind !== undefined) throw new Error(ui('Indique kind ou source_file_id.', 'Supply kind or source_file_id.'));
  const root = outputDirectory(args.output_dir ?? args.source_output_dir);
  const source = sourceId === undefined ? {} : outputRenderSettings(outputDirectory(args.source_output_dir, root), sourceId, name);
  const kind = source.kind ?? String(args.kind || '').trim();
  if (!Object.hasOwn(catalog, kind)) {
    throw new Error(ui(
      `Identifiant inconnu : ${kind}. Consulte ${isAmbience ? 'ambiences' : 'sfx'} dans list_catalog.`,
      `Unknown ID: ${kind}. See ${isAmbience ? 'ambiences' : 'sfx'} in list_catalog.`,
    ));
  }
  const seed = musicSeed(args.seed ?? source.seed);
  const volume = Math.max(0.05, Math.min(1, args.volume ?? source.volume ?? 1));
  const tech = techOptions({ sampling_rate: args.sampling_rate ?? source.sampling_rate, mono: args.mono ?? source.mono });
  const durationSec = isAmbience ? Math.max(5, Math.min(600,
    args.duration_seconds ?? source.duration_seconds ?? catalog[kind].defaultSec ?? 45)) : undefined;
  if (!Number.isFinite(volume) || (isAmbience && !Number.isFinite(durationSec))) throw new Error(ui('Volume ou durée de rendu invalide.', 'Invalid render volume or duration.'));
  const render_settings = { kind, seed, volume, sampling_rate: tech.sr, mono: tech.mono,
    ...(isAmbience ? { duration_seconds: durationSec } : {}) };
  const sfx = {};
  if (!isAmbience) {
    sfx.pitchSemitones = sfxControl(args.pitch_semitones === undefined ? source.pitch_semitones ?? 0 : args.pitch_semitones,
      SFX_PITCH, 'pitch_semitones');
    sfx.attackMs = sfxControl(args.attack_ms === undefined ? source.attack_ms ?? 0 : args.attack_ms, SFX_ATTACK, 'attack_ms');
    if (args.pitch_semitones !== undefined || source.pitch_semitones !== undefined) render_settings.pitch_semitones = sfx.pitchSemitones;
    if (args.attack_ms !== undefined || source.attack_ms !== undefined) render_settings.attack_ms = sfx.attackMs;
    if (args.variants !== undefined) return sfxFamily(kind, args.variants, {
      ...render_settings, pitch_semitones: sfx.pitchSemitones, attack_ms: sfx.attackMs,
    }, { volume, outputDir: root, ...tech });
  }
  const outputDir = sourceId === undefined ? root : newFolder(root, `${kind}-variante`);
  const render = generator(kind, { seed, volume, durationSec, outputDir, ...tech, ...sfx });
  const text = [
    `${isAmbience ? ui('🌫️ Ambiance', '🌫️ Ambience') : '🔊 SFX'} ${ui(`« ${kind} »`, `“${kind}”`)} · ${render.desc}`,
    `${ui('- Fichier :', '- File')} ${render.path} (${fmtBytes(render.bytes)})`,
    `${isAmbience ? ui('- Boucle :', '- Loop') : ui('- Durée :', '- Duration')} ${render.durationSeconds} s`,
    `${ui('- Seed :', '- Seed')} ${seed}`,
  ].join('\n');
  return resultText(text, { ...render, render_settings });
}

/**
 * Appelle un outil. Lève une Error en cas de paramètre invalide
 * (le serveur MCP convertit en result isError, le CLI affiche et sort en 1).
 * Retourne { content, structuredContent }.
 */
function runTool(name, args) {
  if (name === 'design_sound') return designSound(args);
  if (name === 'calibrate_sound') return calibration(args);
  if (name === 'mix_music') return mixMusic(args);
  if (name === 'compare_music_choices') return compareMusicChoices(args);
  if (name === 'compare_builds') return compareBuilds(args);
  if (name === 'learn_music_preference') {
    const result = rememberChoice(args.comparison_path, args.chosen, args.profile_path ?? DEFAULT_PROFILE);
    return resultText(ui(`Préférence enregistrée dans ${result.profile_path}.`, `Preference saved to ${result.profile_path}.`), result);
  }
  if (name === 'play_sound') return playSound(args);
  if (name === 'compare_sounds') return compareSounds(args);
  if (name === 'vary_sound') return varySound(args);
  if (name === 'inspect_score') {
    const { song } = openProject(args.project_path);
    const report = inspectScore(song, args);
    return resultText(`${report.title ?? ui('Partition', 'Score')} · ${report.events.length} / ${report.event_count} ${ui('événement(s)', 'events')}.`, report);
  }
  if (name === 'list_sounds') return listSounds();
  if (name === 'list_catalog') return listCatalog(args.category);
  if (name === 'manage_outputs') {
    const result = manageOutputs(outputDirectory(args.output_dir), args);
    const text = result.files ? result.files.map(({ file_id, state, path }) => `- ${file_id} · ${state} · ${path}`).join('\n') : `${result.state} · ${result.path}`;
    return resultText(text || ui('Aucune sortie enregistrée dans ce dossier.', 'No outputs registered in this directory.'), result);
  }
  if (name === 'preview_sounds') return previewSounds(args);
  if (name === 'draft_music') return draftMusic(args);
  if (name === 'preview_music') return previewMusic(args);
  if (name === 'analyze_music') return analyzeMusic(args);
  if (name === 'finish_music') return finishMusic(args);
  if (name === 'list_styles') {
    const text = listStylesText();
    return { content: [{ type: 'text', text }] };
  }

  if (name === 'create_music') {
    const styleId = String(args.style || '').trim();
    if (!Object.hasOwn(STYLES, styleId)) {
      throw new Error(ui(
        `Style inconnu: "${styleId}". Styles valides: ${STYLE_IDS.join(', ')}. Consulte la catégorie music de list_catalog.`,
        `Unknown style: "${styleId}". Valid styles: ${STYLE_IDS.join(', ')}. See the music category of list_catalog.`,
      ));
    }
    const outputDir = args.output_dir ? path.resolve(String(args.output_dir)) : DEFAULT_OUTPUT_DIR;
    const outputs = musicOutputs(args);
    const seed = musicSeed(args.seed);

    const patches = importPatches(args.patch_paths);
    const params = {
      style: styleId,
      duration_seconds: args.duration_seconds,
      tempo: args.tempo,
      key: args.key,
      seed,
      loop: args.loop ?? (args.editions === undefined ? undefined : false),
      arrangement: args.arrangement,
      palette: args.palette ?? 'studio',
      sound_design: args.sound_design,
      orchestral_percussion: args.orchestral_percussion,
      phrasing: args.phrasing,
      patches,
      title: args.title ? String(args.title) : undefined,
      ...techOptions(args),
    };
    const arranged = withInterpretation(assignPatchRoles(createSong(params), args.patch_roles, patches), args);
    const { song, mix } = production(arranged, args, loadCalibrations(args.calibration_paths), preferencesFor(args, false));
    const base = args.title ? slug(args.title) : `music-${styleId}-${seed}`;

    const exported = exportMusic(song, outputs, outputDir, base, args);
    const result = { ...exported, ...(mix.length ? { mix } : {}) };
    const text = musicSummaryText(result.meta, result.files, result.audio);
    return {
      content: [{ type: 'text', text }],
      structuredContent: result,
    };
  }

  if (name === 'edit_music') {
    const project = openProject(args.project_path);
    const source = project.source;
    const outputs = musicOutputs(args, project.bit_depth);
    const outputDir = args.output_dir ? path.resolve(String(args.output_dir)) : path.dirname(source);
    const title = args.title ? String(args.title) : `${project.song.meta.title ?? project.song.meta.styleLabel} — retouche`;
    const tech = techOptions({ sampling_rate: args.sampling_rate ?? project.song.sr, mono: args.mono ?? project.song.mono });
    const patches = importPatches(args.patch_paths, project.song.patches);
    const editable = Object.keys(patches).length ? { ...project.song, patches } : project.song;
    const revised = applyCalibrations(withInterpretation({ ...assignPatchRoles(editSong(editable, args.edits), args.patch_roles, patches),
      ...tech, palette: args.palette ?? project.song.palette }, args), loadCalibrations(args.calibration_paths));
    if (args.mix !== undefined && (!args.mix || typeof args.mix !== 'object' || Array.isArray(args.mix) ||
        Object.keys(args.mix).some((key) => key !== 'section' && key !== 'strength'))) throw new Error(ui('mix attend section et strength.', 'mix accepts section and strength.'));
    const mixing = args.mix ? mixSong(revised, { strength: args.mix.strength,
      sectionIndex: args.mix.section === undefined ? undefined : sectionIndex(revised, args.mix.section) }) : undefined;
    const updated = mixing?.song ?? revised;
    updated.history = [...(updated.history ?? []), { action: 'revision', source }].slice(-60);
    const variants = args.ending_variants === undefined ? [updated] : endingVariations(updated, args.ending_variants);
    const results = variants.map((song, i) => {
      const versionTitle = args.ending_variants === undefined ? title : `${title} — fin ${i + 1}`;
      const prefix = args.ending_variants === undefined ? slug(title) : `${slug(title)}-fin-${i + 1}`;
      let base = prefix;
      for (let n = 2; ['.soundmcp.json', '.wav', '.mid'].some((ext) => fs.existsSync(path.join(outputDir, `${base}${ext}`))); n++) {
        base = `${prefix}-${n}`;
      }
      return exportMusic({ ...song, meta: { ...song.meta, title: versionTitle } }, outputs, outputDir, base, { ...args, save_project: true });
    });
    return { content: [{ type: 'text', text: results.map((result) => musicSummaryText(result.meta, result.files, result.audio)).join('\n\n') }],
      structuredContent: { versions: results, ...(mixing ? { mix: mixing.sections } : {}) } };
  }

  if (name === 'create_sfx' || name === 'create_ambience') return proceduralAudio(name, args);

  throw new Error(ui(`Outil inconnu: ${name}. Disponibles: ${TOOLS.map((t) => t.name).join(', ')}.`, `Unknown tool: ${name}. Available: ${TOOLS.map((t) => t.name).join(', ')}.`));
}

async function callTool(name, args = {}) {
  const inline = INLINE_AUDIO_TOOLS.has(name) ? args.inline_audio : undefined;
  if (inline !== undefined && typeof inline !== 'boolean') throw new Error(ui('inline_audio attend true ou false.', 'inline_audio must be true or false.'));
  const result = runTool(name, args);
  if (inline) appendInlineAudio(name, result);
  if (!OUTPUT_TOOLS.has(name)) return result;
  const data = result.structuredContent;
  const variants = name === 'create_sfx' ? data.variants : undefined;
  const files = [...(data.files ?? []), ...(data.versions ?? []).flatMap(({ files }) => files)];
  const takes = [...(data.candidates ?? []), ...(data.sounds ?? []), ...(data.reference ? [data.reference] : [])];
  const paths = [data.path, data.preview_path, data.patch_path, data.calibration_path, data.report_path, data.reveal_path, data.comparison_path,
    ...files.flatMap(({ path, project_path }) => [path, project_path]), ...(variants ?? []).map(({ path }) => path),
    ...takes.flatMap(({ preview_path, project_path, patch_path }) => [preview_path, project_path, patch_path])].filter(Boolean);
  const fallback = PROJECT_OUTPUT_TOOLS.has(name) ? path.dirname(path.resolve(args.project_path)) : DEFAULT_OUTPUT_DIR;
  const outputDir = outputDirectory(args.output_dir ?? (data.render_settings || variants ? args.source_output_dir : undefined), fallback);
  try {
    const settingsByFile = variants && new Map(variants.map(({ path, render_settings }) => [path, render_settings]));
    const tracked = recordOutputs(outputDir, name, paths, data.render_settings, settingsByFile);
    if (tracked) data.managed_outputs = tracked;
  } catch (error) {
    data.output_management_warning = error.message;
  }
  return result;
}

module.exports = {
  TOOLS,
  callTool,
  DEFAULT_OUTPUT_DIR,
  listStylesText,
};
