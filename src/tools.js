'use strict';

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

const DEFAULT_OUTPUT_DIR = path.join(__dirname, '..', 'output');
const DEFAULT_PROFILE = process.env.SOUNDMCP_PROFILE_PATH || path.join(os.homedir(), '.soundmcp', 'preferences.soundmcp.json');
const SR_CHOICES = [22050, 44100, 48000];

/** Valide et borne les options techniques communes (sampling rate, mono). */
function techOptions(args) {
  const sr = SR_CHOICES.includes(args.sampling_rate) ? args.sampling_rate : 44100;
  if (args.sampling_rate !== undefined && !SR_CHOICES.includes(args.sampling_rate)) {
    throw new Error(`sampling_rate invalide: ${args.sampling_rate}. Choix: ${SR_CHOICES.join(', ')}.`);
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
const fmtBytes = (b) => (b >= 1024 * 1024 ? `${(b / 1048576).toFixed(1)} Mo` : `${Math.round(b / 1024)} Ko`);

/* ---------------------------------- descriptions ---------------------------------- */

const TIP_SEED = 'Conserve le seed, les paramètres et la version de SoundMCP pour reproduire le rendu.';
const TIP_LOOP = 'Pour une boucle de jeu, utilise loop: true. Les queues d’effets sont raccordées au début de la piste.';

const MOTIF_SCHEMA = {
  type: 'array', minItems: 1, maxItems: 24,
  description: 'Notes de mélodie sur deux mesures, par ordre de temps, sans chevauchement.',
  items: {
    type: 'object', required: ['beat', 'degree', 'duration'], properties: {
      beat: { type: 'number', minimum: 0, exclusiveMaximum: 8 },
      degree: { type: 'integer', minimum: -6, maximum: 15, description: '1 = tonique, 8 = tonique à l’octave au-dessus.' },
      duration: { type: 'number', minimum: 0.0625, maximum: 8 },
      velocity: { type: 'number', minimum: 0.05, maximum: 1 },
      articulation: { type: 'string', enum: ARTICULATIONS,
        description: 'mute et slide pour la guitare, legato et swell pour les vents, staccato pour les notes courtes.' },
    },
  },
};

const CHORD_SCHEMA = { anyOf: [{ type: 'integer', minimum: 1, maximum: 7 }, { type: 'string' }] };
const METER_SCHEMA = { type: 'array', minItems: 2, maxItems: 2, items: { type: 'integer' }, description: 'Numérateur et dénominateur, ex. [3,4] ou [6,8].' };
const TEMPO_SCHEMA = { type: 'number', minimum: 40, maximum: 220, description: 'Tempo en noires par minute.' };
const SECTION_SELECTOR = { anyOf: [{ type: 'string' }, { type: 'integer', minimum: 1 }], description: 'Nom unique ou numéro à partir de 1.' };
const REGION_SCHEMA = { type: 'object', required: ['start_bar', 'bars'], properties: {
  start_bar: { type: 'integer', minimum: 1 }, bars: { type: 'integer', minimum: 1 },
} };
const PITCH_SCHEMA = { anyOf: [{ type: 'integer', minimum: 0, maximum: 127 }, { type: 'string', description: 'Note avec octave, ex. C4 ou Bb3.' }] };
const NUMBER = (minimum, maximum) => ({ type: 'number', minimum, maximum });
const UNIT = NUMBER(0, 1);
const GESTURE_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  position: { ...UNIT, description: 'Point de frappe ou de pincement. Change les résonances excitées.' },
  hardness: { ...UNIT, description: 'De contact souple à frappe dure et brillante.' },
  damping: { ...UNIT, description: 'Amortissement du matériau pendant ce geste.' },
  glide_ms: { ...NUMBER(0, MAX_GLIDE_MS), description: 'Durée en millisecondes du glissé depuis la note précédente avec slide ou legato.' },
} };
const MEASURE_NOTES_SCHEMA = { type: 'array', maxItems: 64, items: { type: 'object', required: ['beat'], properties: {
  beat: { type: 'number', minimum: 0, description: 'Temps à partir de zéro, dans le dénominateur de la mesure.' },
  duration: { type: 'number', minimum: 0.025, maximum: 32 }, pitch: PITCH_SCHEMA,
  pitches: { type: 'array', minItems: 1, maxItems: 8, items: PITCH_SCHEMA },
  degree: { type: 'integer', minimum: -13, maximum: 22 }, hit: { type: 'string', enum: DRUMS },
  velocity: { type: 'number', minimum: 0.05, maximum: 1 },
  pan: { type: 'number', minimum: -1, maximum: 1 },
  timbre: { type: 'number', minimum: 0, maximum: 1, description: 'Couleur de la voix, de sombre à brillante ou plus saturée selon le son.' },
  articulation: { type: 'string', enum: [...ARTICULATIONS, 'ghost'] },
  gesture: GESTURE_SCHEMA,
  expression: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number', minimum: 0.15, maximum: 1.6 },
    description: 'Gain relatif au début et à la fin de la note.' },
} } };
const CUSTOM_ID = { type: 'string', pattern: '^custom-[a-z0-9][a-z0-9-]{0,63}$' };
const PATCH_IMPORT = {
  patch_paths: { type: 'array', maxItems: 16, items: { type: 'string' }, description: 'Fichiers patch_path renvoyés par design_sound.' },
  calibration_paths: { type: 'array', maxItems: 16, items: { type: 'string' },
    description: 'Profils de niveau par registre renvoyés par calibrate_sound, pour un son et un pupitre.' },
  patch_roles: { type: 'object', properties: Object.fromEntries(PATCH_ROLES.map((role) => [role, CUSTOM_ID])), additionalProperties: false,
    description: 'Applique un son personnel importé à un pupitre dans la partition.' },
};
const OSCILLATOR_PATCH_SCHEMA = { type: 'object', required: ['layers'], additionalProperties: false, properties: {
  layers: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', properties: {
    wave: { type: 'string', enum: WAVES }, gain: NUMBER(0, 1), ratio: NUMBER(0.125, 16), detune_cents: NUMBER(-240, 240),
    pan: NUMBER(-1, 1), pulse_width: NUMBER(0.08, 0.92), envelope: { type: 'object', properties: {
      attack: NUMBER(0.002, 6), decay: NUMBER(0, 8), sustain: NUMBER(0, 1), release: NUMBER(0.008, 4),
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
    modes: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', additionalProperties: false, properties: {
      ratio: NUMBER(0.25, 32), gain: UNIT, decay_seconds: NUMBER(0.025, 8),
      position_node: { type: 'integer', minimum: 1, maximum: 12 }, pan: NUMBER(-0.7, 0.7),
    } } },
    contact: NUMBER(0, 0.7), damping: UNIT,
    friction: { type: 'object', additionalProperties: false,
      description: 'Excite les résonances pendant toute la tenue, comme un matériau frotté.',
      properties: { amount: NUMBER(0.05, 1), roughness: UNIT, motion_hz: NUMBER(0.05, 18), attack_seconds: NUMBER(0.008, 4) } },
  } },
} };
const WAVEGUIDE_PATCH_SCHEMA = { type: 'object', required: ['waveguide'], additionalProperties: false, properties: {
  waveguide: { type: 'object', additionalProperties: false, properties: {
    brightness: UNIT, stiffness: UNIT, contact: NUMBER(0, 0.7), release_damping: UNIT,
    decay_seconds: { ...NUMBER(0.12, 8), description: 'Durée visée d’atténuation de 60 dB pour la corde libre.' },
    body: { type: 'object', additionalProperties: false, properties: {
      frequency: NUMBER(45, 1800), resonance: NUMBER(0.4, 8), mix: NUMBER(0, 0.75),
    } },
  } },
} };
const PATCH_SCHEMA = { type: 'object', oneOf: [OSCILLATOR_PATCH_SCHEMA, MODAL_PATCH_SCHEMA, WAVEGUIDE_PATCH_SCHEMA] };
const PATCH_SOURCE_PROPERTIES = {
  patch: PATCH_SCHEMA, patch_path: { type: 'string', description: 'Chemin du patch créé par design_sound ou vary_sound.' },
  title: { type: 'string', maxLength: 80 },
};
const PATCH_SOURCE_REQUIRED = [{ required: ['patch'] }, { required: ['patch_path'] }];
const CATALOG_ID = { type: 'string', enum: Object.keys(AUDITION_SOUNDS) };
const SOUND_SOURCE_PROPERTIES = { ...PATCH_SOURCE_PROPERTIES,
  instrument: { ...CATALOG_ID, description: 'Identifiant du son intégré, renvoyé par list_sounds.' } };
const SOUND_SOURCE_REQUIRED = [...PATCH_SOURCE_REQUIRED, { required: ['instrument'] }];
const SOUND_LIST_PROPERTIES = {
  sounds: { type: 'array', minItems: 1, maxItems: 12, items: { anyOf: [CATALOG_ID, CUSTOM_ID] },
    description: 'Identifiants à écouter dans l’ordre avec les notes de démonstration. Fournis patch_paths pour les sons personnels.' },
  patch_paths: PATCH_IMPORT.patch_paths,
  timbre: UNIT,
};
const PHRASE_ONLY_FIELDS = ['instrument', 'patch', 'patch_path', 'notes', 'tail_seconds', 'sampling_rate', 'mono', 'title'];
const PLAY_SOUND_MODES = [
  ...SOUND_SOURCE_REQUIRED.map((mode) => ({ ...mode, not: { required: ['sounds'] } })),
  { required: ['sounds'], not: { anyOf: PHRASE_ONLY_FIELDS.map((name) => ({ required: [name] })) } },
];
const AUDITION_PROPERTIES = {
  notes: { type: 'array', minItems: 1, maxItems: 32, description: 'Phrase à jouer. Trois notes de démonstration par défaut.',
    items: { type: 'object', required: ['at', 'pitch'], properties: {
      at: { ...NUMBER(0, 14), description: 'Début en secondes. Plusieurs notes au même instant forment un accord.' },
      pitch: PITCH_SCHEMA, duration: NUMBER(0.025, 8), velocity: NUMBER(0.05, 1), pan: NUMBER(-1, 1), timbre: UNIT,
      articulation: { type: 'string', enum: ARTICULATIONS }, gesture: GESTURE_SCHEMA,
      expression: MEASURE_NOTES_SCHEMA.items.properties.expression,
    } } },
  tail_seconds: NUMBER(0.12, 6), sampling_rate: { type: 'integer', enum: SR_CHOICES }, mono: { type: 'boolean' },
  seed: { type: 'integer', minimum: 0, maximum: 4294967295 }, output_dir: { type: 'string' },
};
const INTERPRETATION_PROPERTIES = {
  performance: { description: 'Phrasé déterministe par pupitre. null le retire d’un projet.', anyOf: [{ type: 'null' }, {
    type: 'object', additionalProperties: false, properties: { amount: UNIT,
      parts: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: PARTS } } },
  }] },
  room: { description: 'Pièce virtuelle commune avec distance de 0 (proche) à 1 (loin). null rétablit la pièce du style.', anyOf: [{ type: 'null' }, {
    type: 'object', additionalProperties: false, properties: { amount: UNIT, size: UNIT, damping: UNIT,
      distance: { type: 'object', additionalProperties: false, properties: Object.fromEntries(PARTS.map((part) => [part, UNIT])) } },
  }] },
};
const ORCHESTRAL_SCHEMA = { type: 'string', enum: ORCHESTRAL_PERCUSSION,
  description: 'march organise les accents et les roulements orchestraux. drive ajoute les contretemps et les ponctuations de gong. none coupe le kit de la section.' };
const SECTION_PROPERTIES = {
  name: { type: 'string', minLength: 1, maxLength: 60 },
  theme: { type: 'string', enum: ['A', 'B', 'C'], description: 'Réutilise le motif associé à un thème. A par défaut.' },
  theme_treatment: { type: 'string', enum: THEME_TREATMENTS, description: 'fragment isole la première cellule. reprise peut ajouter une levée. augmentation double les durées de la cellule. sequence la répète une tierce diatonique plus haut.' },
  variation: { type: 'integer', minimum: 0, maximum: 3,
    description: 'Décale la variation du thème généré : original, transposé, rythme décalé, contour renversé.' },
  key: { type: 'string', description: 'Tonalité locale, ex. « F minor ».' },
  tempo: TEMPO_SCHEMA,
  meter: METER_SCHEMA,
  color: { type: 'string', enum: Object.keys(COLORS), description: 'Traitement du mix dans la section, par exemple radio pour un son étroit et filtré.' },
  orchestral_percussion: ORCHESTRAL_SCHEMA,
  instruments: { type: 'object', properties: Object.fromEntries(SOUND_PARTS.map((part) => [part, { anyOf: [{ type: 'string',
    enum: Object.keys(INSTRUMENTS).filter((inst) => !TEXTURES.includes(inst)) }, CUSTOM_ID] }])), additionalProperties: false,
    description: 'Nouvel instrument par pupitre, uniquement pour cette section.' },
  textures: { type: 'array', maxItems: 32, items: { type: 'object', required: ['sound'], properties: {
    sound: { type: 'string', enum: TEXTURES }, bar: { type: 'integer', minimum: 1 }, beat: { type: 'number', minimum: 0 },
    duration: { type: 'number', minimum: 0.08, maximum: 32 }, level: { type: 'number', minimum: 0.02, maximum: 1 },
    pan: { type: 'number', minimum: -1, maximum: 1 }, timbre: { type: 'number', minimum: 0, maximum: 1 },
    midi: { type: 'integer', minimum: 0, maximum: 127, description: 'Hauteur explicite, notamment pour les timbales.' },
  } }, description: 'Événements du pupitre texture. Mesures relatives à la section à partir de 1.' },
  progression: {
    type: 'array', minItems: 1, maxItems: 64,
    items: { anyOf: [...CHORD_SCHEMA.anyOf, { type: 'array', minItems: 1, maxItems: 8, items: {
      type: 'object', required: ['beat', 'chord'], properties: { beat: { type: 'number', minimum: 0, maximum: 3.75 }, chord: CHORD_SCHEMA },
    } }] },
    description: 'Une entrée par mesure : degré, symbole (Dm9, G13, Cmaj7/E), ou suite de changements à partir de beat: 0.',
  },
  parts: { type: 'array', items: { type: 'string', enum: PARTS }, description: 'Pupitres actifs parmi ceux du style.' },
  energy: { type: 'number', minimum: 0.25, maximum: 1, description: 'Dynamique de la section. 0.9 par défaut.' },
  motif: MOTIF_SCHEMA,
};

const ARRANGEMENT_SCHEMA = {
  type: 'object',
  description: 'Arrangement facultatif avec variations de tonalité, de tempo et de mesure par section.',
  properties: {
    sections: {
      type: 'array', minItems: 1, maxItems: 64,
      description: 'Ordre des sections. Leur nombre de mesures fixe la durée musicale.',
      items: {
        type: 'object', required: ['bars'], properties: { ...SECTION_PROPERTIES, bars: { type: 'integer', minimum: 1, maximum: 64 } },
      },
    },
    motif: { ...MOTIF_SCHEMA, description: 'Motif par défaut pour les sections qui incluent la mélodie. Une section peut fournir son propre motif.' },
  },
};

const EDITION_PROPERTIES = {
  editions: { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true, items: { type: 'string', enum: EDITIONS },
    description: 'Ajoute des éditions alignées au master : boucle standard, calme, intense et transition calme vers intense.' },
  loop_region: { type: 'object', properties: { start_bar: { type: 'integer', minimum: 1 }, bars: { type: 'integer', minimum: 1 } },
    description: 'Région commune des variantes. La numérotation des mesures commence à 1.' },
};

const PALETTE_SCHEMA = { type: 'string', enum: PALETTES,
  description: 'studio utilise les prises instrumentales enregistrées dont la harpe, le vibraphone et les violoncelles. synth utilise la synthèse.' };

const PROJECT_SCHEMA = { type: 'string', description: 'Chemin local .soundmcp.json renvoyé par draft_music, create_music ou edit_music.' };
const SOUND_DESIGN_SCHEMA = { type: 'string', enum: SOUND_DESIGNS, description: 'evolving fait varier les timbres, les textures et le traitement entre sections.' };
const BUILD_PROPERTIES = {
  arrival_bar: { type: 'integer', minimum: 2, description: 'Première mesure de la reprise ou de l’arrivée.' },
  before_bars: { type: 'integer', minimum: 1, maximum: MAX_BEFORE },
  amount: UNIT,
};
const PHRASING_SCHEMA = { type: 'string', enum: PHRASINGS,
  description: 'lyrical conserve le rythme du thème, ajuste ses notes aux accords et ménage des respirations. style suit le phrasé du genre.' };
const MIX_PROPERTIES = {
  auto_mix: { type: 'boolean', description: 'Mesure les pupitres et équilibre chaque section. Actif par défaut dans les esquisses lyrical.' },
  mix_strength: { ...UNIT, description: 'Intensité de la correction du mix automatique.' },
};
const PROFILE_PATH = { type: 'string', description: 'Chemin local du profil renvoyé par learn_music_preference.' };
const PREFERENCE_PROPERTIES = { profile_path: PROFILE_PATH,
  use_preferences: { type: 'boolean', description: 'Les esquisses utilisent le profil local existant par défaut. false les compose sans profil.' } };
const REGION_PROPERTIES = {
  section: SECTION_SELECTOR, region: REGION_SCHEMA, max_seconds: { type: 'number', minimum: 4, maximum: 45 },
  full: { type: 'boolean', description: 'Compare les morceaux complets de 45 s ou moins, sans recadrage.' },
};
const MUSIC_COMPARISON_CRITERIA = [...PREFERENCES, 'build'];
const EXPORT_PROPERTIES = {
  title: { type: 'string' }, format: { type: 'string', enum: ['wav', 'midi', 'both'] },
  bit_depth: { type: 'integer', enum: [16, 24] }, sampling_rate: { type: 'integer', enum: SR_CHOICES },
  mono: { type: 'boolean' }, stems: { type: 'boolean' }, output_dir: { type: 'string' }, palette: PALETTE_SCHEMA,
  ...EDITION_PROPERTIES,
};

const TOOLS = [
  {
    name: 'design_sound',
    description: 'Crée un son de zéro par oscillateurs, synthèse modale (matériau frappé ou frotté) ou guide d’onde (corde pincée). Sur un modèle physique, gesture règle la position, la dureté et l’amortissement du contact. Renvoie un WAV, un patch éditable et un identifiant pour les morceaux.',
    inputSchema: { type: 'object', properties: { brief: { type: 'string', maxLength: 1000 }, patch: PATCH_SCHEMA,
      title: { type: 'string', maxLength: 80 }, note: PITCH_SCHEMA, duration_seconds: NUMBER(0.7, 12), gate_seconds: NUMBER(0.03, 10),
      velocity: NUMBER(0.05, 1), gesture: GESTURE_SCHEMA,
      seed: { type: 'integer', minimum: 0, maximum: 4294967295 }, output_dir: { type: 'string' },
    }, oneOf: [{ required: ['brief'] }, { required: ['patch'] }] },
  },
  {
    name: 'play_sound',
    description: 'Écoute un son intégré ou personnel avec une phrase en secondes fournie dans notes. Pour parcourir le nuancier, passe jusqu’à douze identifiants dans sounds et reçois un seul WAV à sonie alignée avec des repères.',
    inputSchema: { type: 'object', properties: { ...SOUND_SOURCE_PROPERTIES, ...AUDITION_PROPERTIES, ...SOUND_LIST_PROPERTIES },
      oneOf: PLAY_SOUND_MODES },
  },
  {
    name: 'calibrate_sound',
    description: 'Joue un patch à trois forces dans plusieurs registres, mesure l’attaque et la tenue, puis exporte une courbe de gain pour un pupitre. Réutilise la calibration dans calibration_paths.',
    inputSchema: { type: 'object', properties: { ...PATCH_SOURCE_PROPERTIES,
      role: { type: 'string', enum: PATCH_ROLES }, notes: { type: 'array', minItems: 3, maxItems: 6, items: PITCH_SCHEMA },
      seed: { type: 'integer', minimum: 0, maximum: 4294967295 }, output_dir: { type: 'string' },
    }, oneOf: PATCH_SOURCE_REQUIRED },
  },
  {
    name: 'compare_sounds',
    description: 'Évalue deux à quatre timbres avec la même phrase. Écrit un WAV séparé par timbre à sonie égale. Active blind pour mélanger les prises et placer les identités dans une clé séparée.',
    inputSchema: { type: 'object', required: ['sounds'], properties: {
      sounds: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'object', properties: SOUND_SOURCE_PROPERTIES, oneOf: SOUND_SOURCE_REQUIRED } },
      ...AUDITION_PROPERTIES, blind: { type: 'boolean' },
    } },
  },
  {
    name: 'vary_sound',
    description: 'Dérive jusqu’à quatre patches d’un son, plus brillants, sombres, brefs ou longs. Livre les réglages éditables et des WAV à sonie commune avec le son de départ.',
    inputSchema: { type: 'object', properties: { ...PATCH_SOURCE_PROPERTIES, ...AUDITION_PROPERTIES,
      directions: { type: 'array', minItems: 1, maxItems: DIRECTIONS.length, uniqueItems: true,
        items: { type: 'string', enum: DIRECTIONS } },
      amount: NUMBER(0.05, 1),
    }, oneOf: PATCH_SOURCE_REQUIRED },
  },
  {
    name: 'list_sounds',
    description: 'Liste les timbres et les couleurs de mix sans écrire de fichiers. Passe un identifiant à play_sound pour l’écouter, ou à l’arrangement pour l’utiliser dans un morceau.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'draft_music',
    description: 'Transforme un brief français ou anglais en une à trois esquisses d’arrangement. Chaque esquisse fournit une préécoute à sonie égale et un projet éditable à sélectionner pour finish_music.',
    inputSchema: { type: 'object', required: ['brief'], properties: {
      brief: { type: 'string', minLength: 1, maxLength: 1600, description: 'Ex. « 75 secondes pour une exploration nocturne, piano feutré, montée progressive, fin calme. »' },
      variants: { type: 'integer', minimum: 1, maximum: 3, default: 3 },
      style: { type: 'string', enum: STYLE_IDS }, duration_seconds: { type: 'number', minimum: 5, maximum: 600 },
      tempo: TEMPO_SCHEMA, meter: METER_SCHEMA, key: { type: 'string' },
      energy: { type: 'string', enum: ['gentle', 'balanced', 'rising', 'strong'] }, loop: { type: 'boolean' },
      sound_design: SOUND_DESIGN_SCHEMA,
      orchestral_percussion: ORCHESTRAL_SCHEMA,
      phrasing: PHRASING_SCHEMA, palette: PALETTE_SCHEMA,
      motif: MOTIF_SCHEMA,
      reprise_treatment: { type: 'string', enum: THEME_TREATMENTS, description: 'Développe la cellule du thème dans la reprise.' },
      build_contour: { type: 'string', enum: CONTOURS, description: 'Forme l’accompagnement juste avant la reprise.' },
      ...MIX_PROPERTIES, ...PREFERENCE_PROPERTIES,
      ...INTERPRETATION_PROPERTIES,
      ...PATCH_IMPORT,
      instruments: { type: 'array', items: { type: 'string', enum: PLAYABLE } }, without: { type: 'array', items: { type: 'string', enum: PLAYABLE } },
      seed: { type: 'integer', minimum: 0, maximum: 4294967295 }, title: { type: 'string' }, output_dir: { type: 'string' },
    } },
  },
  {
    name: 'finish_music',
    description: 'Rend le projet sélectionné en master WAV 48 kHz/24 bits et MIDI. Propose aussi les pistes séparées, trois boucles, une transition et des formats courts de 15, 30 ou 60 secondes avec cadence.',
    inputSchema: { type: 'object', required: ['project_path'], properties: { ...EXPORT_PROPERTIES, project_path: PROJECT_SCHEMA,
      cuts: { type: 'array', maxItems: 3, uniqueItems: true, items: { type: 'integer', enum: [15, 30, 60] } },
    } },
  },
  {
    name: 'preview_music',
    description: 'Rend en WAV un passage d’un projet enregistré, ou le même passage de plusieurs projets déjà créés. Alignement en sonie et anonymisation facultative des WAV.',
    inputSchema: { type: 'object', properties: { project_path: PROJECT_SCHEMA,
      project_paths: { type: 'array', minItems: 1, maxItems: 3, items: PROJECT_SCHEMA },
      ...REGION_PROPERTIES,
      blind: { type: 'boolean' }, seed: { type: 'integer', minimum: 0, maximum: 4294967295 }, output_dir: { type: 'string' },
    } },
  },
  {
    name: 'mix_music',
    description: 'Rééquilibre les pupitres à partir de mesures audio section par section. Produit un WAV et une copie éditable avec les corrections de gain.',
    inputSchema: { type: 'object', required: ['project_path'], properties: {
      project_path: PROJECT_SCHEMA, section: SECTION_SELECTOR, mix_strength: UNIT, title: { type: 'string' }, output_dir: { type: 'string' },
    } },
  },
  {
    name: 'compare_music_choices',
    description: 'Part d’un seul projet pour générer deux variantes anonymes à sonie alignée selon criterion. accompaniment et breath livrent un comparison_path pour learn_music_preference. build compare deux montées et livre les projets complets et un reveal_path.',
    inputSchema: { type: 'object', required: ['project_path', 'criterion'], properties: {
      project_path: PROJECT_SCHEMA, criterion: { type: 'string', enum: MUSIC_COMPARISON_CRITERIA,
        description: 'Teste la présence de l’accompagnement, la respiration mélodique ou le type de montée avant une arrivée.' },
      ...REGION_PROPERTIES, ...BUILD_PROPERTIES,
      after_bars: { type: 'integer', minimum: 1, maximum: 8, description: 'Mesures après l’arrivée pour le critère build.' },
      seed: { type: 'integer', minimum: 0, maximum: 4294967295 }, output_dir: { type: 'string' },
    } },
  },
  {
    name: 'learn_music_preference',
    description: 'Enregistre dans un fichier local le choix A ou B exprimé par l’auditeur. draft_music réutilise le profil pour les esquisses suivantes.',
    inputSchema: { type: 'object', required: ['comparison_path', 'chosen'], properties: {
      comparison_path: { type: 'string' }, chosen: { type: 'string', enum: ['A', 'B'] }, profile_path: PROFILE_PATH,
    } },
  },
  {
    name: 'analyze_music',
    description: 'Donne les mesures audio (LUFS, crêtes, saturation et stéréo) d’un WAV ou d’un projet. Pour un projet, vérifie aussi le niveau par pupitre, les sections, les répétitions, le respect du brief et l’historique.',
    inputSchema: { type: 'object', properties: { project_path: PROJECT_SCHEMA, wav_path: { type: 'string' } } },
  },
  {
    name: 'inspect_score',
    description: 'Lit les accords, les notes de la partition et leur position jouée. Pour réécrire une mesure, transmets les notes à edit_music dans edits avec le type write_measure. Page les grands résultats avec next_offset.',
    inputSchema: { type: 'object', required: ['project_path'], properties: { project_path: PROJECT_SCHEMA,
      start_bar: { type: 'integer', minimum: 1 }, bars: { type: 'integer', minimum: 1, maximum: 12 },
      part: { type: 'string', enum: PARTS }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 512 },
    } },
  },
  {
    name: 'list_styles',
    description: 'Liste les styles musicaux, les effets et les ambiances en boucle sans écrire de fichiers. Donne les identifiants à passer à create_music, create_sfx et create_ambience.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_music',
    description: 'Compose et exporte directement un instrumental à partir d’un style et d’un arrangement facultatif. Renvoie un WAV, un MIDI ou les deux. Le paramètre booléen save_project ajoute un projet éditable.',
    inputSchema: {
      type: 'object',
      properties: {
        style: {
          type: 'string',
          enum: STYLE_IDS,
          description: 'Style musical. Utilise list_styles pour voir le détail de chacun.',
        },
        duration_seconds: {
          type: 'number',
          minimum: 5,
          maximum: 600,
          description: 'Durée cible en secondes (5 à 600). Arrondie à un nombre entier de mesures.',
        },
        tempo: {
          type: 'number',
          minimum: 40,
          maximum: 220,
          description: 'Tempo en BPM (40-220). Optionnel : chaque style a un tempo naturel.',
        },
        key: {
          type: 'string',
          description: 'Tonalité, ex. "A minor", "F# dorien", "la mineur", "C majeur". Optionnel : choisie selon le style sinon.',
        },
        seed: {
          type: 'integer',
          minimum: 0,
          maximum: 4294967295,
          description: 'Graine de génération. 0 est une graine valide.',
        },
        loop: {
          type: 'boolean',
          description: 'Boucle sans raccord (pour fond de jeu continu). Par défaut : true pour la plupart des styles.',
        },
        format: {
          type: 'string',
          enum: ['wav', 'midi', 'both'],
          default: 'wav',
          description: 'Format de sortie : wav (audio prêt), midi (éditable dans un DAW), both.',
        },
        sampling_rate: {
          type: 'integer',
          enum: [22050, 44100, 48000],
          default: 44100,
          description: 'Fréquence d’échantillonnage du WAV en Hz. 44100 par défaut.',
        },
        bit_depth: { type: 'integer', enum: [16, 24], default: 16, description: 'Profondeur du master WAV. 24 bits pour le travail audio.' },
        stems: { type: 'boolean', default: false, description: 'Ajoute les pupitres séparés, avec effets et avant mastering, en WAV 32 bits flottant. Nécessite wav ou both.' },
        palette: { ...PALETTE_SCHEMA, default: 'studio' },
        sound_design: SOUND_DESIGN_SCHEMA,
        orchestral_percussion: ORCHESTRAL_SCHEMA,
        phrasing: PHRASING_SCHEMA,
        ...MIX_PROPERTIES, ...PREFERENCE_PROPERTIES,
        ...INTERPRETATION_PROPERTIES,
        ...PATCH_IMPORT,
        save_project: { type: 'boolean', default: false, description: 'Sauvegarde la partition et l’interprétation pour edit_music.' },
        ...EDITION_PROPERTIES,
        arrangement: ARRANGEMENT_SCHEMA,
        mono: {
          type: 'boolean',
          default: false,
          description: 'Exporte en mono (taille moitié). À réserver aux fonds ambisoniques ou aux contraintes de taille.',
        },
        output_dir: {
          type: 'string',
          description: 'Dossier de sortie. Par défaut : <projet>/output.',
        },
        title: {
          type: 'string',
          description: 'Titre de la piste (sert aussi de nom de fichier).',
        },
      },
      required: ['style'],
    },
  },
  {
    name: 'edit_music',
    description: 'Reprend un projet SoundMCP enregistré. Permet de retoucher un pupitre, remplacer une section, façonner une montée ou proposer jusqu’à cinq fins. Produit une nouvelle partition.',
    inputSchema: {
      type: 'object', required: ['project_path'], properties: {
        project_path: { type: 'string', description: 'Chemin du fichier .soundmcp.json retourné par create_music ou edit_music.' },
        edits: { type: 'array', maxItems: 32, items: { type: 'object', required: ['type'], properties: {
          type: { type: 'string', enum: ['gain', 'mute', 'replace_section', 'write_measure', 'shape_build'] },
          ...BUILD_PROPERTIES,
          contour: { type: 'string', enum: [...CONTOURS, 'flat'] },
          section: SECTION_SELECTOR,
          part: { type: 'string', enum: PARTS },
          db: { type: 'number', minimum: -60, maximum: 12 },
          replacement: { type: 'object', properties: SECTION_PROPERTIES },
          bar: { type: 'integer', minimum: 1 }, notes: MEASURE_NOTES_SCHEMA, instrument: { type: 'string' },
        } } },
        ending_variants: { type: 'integer', minimum: 1, maximum: 5 },
        ...EXPORT_PROPERTIES,
        ...PATCH_IMPORT,
        ...INTERPRETATION_PROPERTIES,
      },
    },
  },
  {
    name: 'create_sfx',
    description: 'Crée un effet sonore de jeu prêt à l\'emploi (WAV 16 bits, 32 types) : action (jump, coin, pickup, hit, damage, powerup, levelup), combat (explosion, laser, sword, gunShoot, bowShoot), nature (thunder, splash, whoosh), UI (click, hover, error, success, menuOpen, chestOpen, questComplete), personnages (footstep, door, heartbeat, alarm, ghost, forge, bubble, magic, teleport). Déterministe via seed.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: SFX_IDS,
          description: 'Type d\'effet sonore.',
        },
        seed: {
          type: 'integer',
          minimum: 0,
          description: 'Graine : même seed = même SFX (utile pour des variantes cohérentes).',
        },
        volume: {
          type: 'number',
          minimum: 0.05,
          maximum: 1,
          default: 1,
          description: 'Volume relatif (0.05 à 1).',
        },
        sampling_rate: {
          type: 'integer',
          enum: [22050, 44100, 48000],
          default: 44100,
          description: 'Fréquence d\'échantillonnage du WAV en Hz (22050 = taille moitié, ok pour les UI/retro).',
        },
        mono: {
          type: 'boolean',
          default: false,
          description: 'Exporte en mono (taille moitié).',
        },
        output_dir: {
          type: 'string',
          description: 'Dossier de sortie. Par défaut : <projet>/output.',
        },
      },
      required: ['kind'],
    },
  },
  {
    name: 'create_ambience',
    description: 'Crée une ambiance de jeu en boucle parfaite (WAV 16 bits) : rain (pluie), storm (orage), wind (vent), forest (forêt), campfire (feu de camp), ocean (océan), river (rivière), cave (grotte), spaceship (vaisseau), cafe (café), night (nuit). Couches de bruit continu + événements stochastiques (gouttes, oiseaux, tonnerre, vagues…) ; le crossfade circulaire rend le raccord de boucle inaudible. Déterministe via seed.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: AMBIENCE_IDS,
          description: 'Type d\'ambiance.',
        },
        duration_seconds: {
          type: 'number',
          minimum: 5,
          maximum: 600,
          description: 'Durée de la boucle en secondes (5 à 600). Par défaut : 45-60 s selon l\'ambiance. Une boucle plus longue = événements moins répétitifs.',
        },
        volume: {
          type: 'number',
          minimum: 0.05,
          maximum: 1,
          default: 1,
          description: 'Volume relatif (0.05 à 1).',
        },
        seed: {
          type: 'integer',
          minimum: 0,
          description: 'Graine : même seed = même ambiance.',
        },
        sampling_rate: {
          type: 'integer',
          enum: [22050, 44100, 48000],
          default: 44100,
          description: 'Fréquence d\'échantillonnage du WAV en Hz. 22050 recommandé pour les fonds d\'ambiance (taille moitié, qualité largement suffisante).',
        },
        mono: {
          type: 'boolean',
          default: false,
          description: 'Exporte en mono (taille moitié).',
        },
        output_dir: {
          type: 'string',
          description: 'Dossier de sortie. Par défaut : <projet>/output.',
        },
      },
      required: ['kind'],
    },
  },
];

/* ---------------------------------- textes ---------------------------------- */

function listStylesText() {
  const lines = ['## Styles musicaux disponibles (create_music)'];
  lines.push('');
  for (const id of STYLE_IDS) {
    const s = STYLES[id];
    lines.push(`**${id}** — ${s.label}`);
    lines.push(`   ${s.desc}`);
    lines.push(`   Tempo par défaut : ${s.defaults.tempo} BPM · durée : ${fmtSec(s.defaults.duration)} · boucle : ${s.defaults.loop ? 'oui' : 'non'}`);
    lines.push(`   Idéal pour : ${s.use.join(', ')}`);
    lines.push('');
  }
  lines.push('## Ambiances disponibles (create_ambience)');
  lines.push('');
  lines.push('Boucles de fond de jeu en continu — croise-les avec les musiques (ex. cave + dungeon).');
  lines.push('');
  for (const id of AMBIENCE_IDS) {
    lines.push(`**${id}** — ${AMBIENCE_KINDS[id].desc}`);
  }
  lines.push('');
  lines.push('## Effets sonores disponibles (create_sfx)');
  lines.push('');
  for (const id of SFX_IDS) {
    lines.push(`**${id}** — ${SFX_KINDS[id].desc}`);
  }
  lines.push('');
  lines.push('## Astuces');
  lines.push(`- ${TIP_SEED}`);
  lines.push(`- ${TIP_LOOP}`);
  lines.push('- Ambiance en boucle : create_ambience produit toujours une boucle parfaite (crossfade intégré). Parfait pour recouvrir une musique : ambiance à ~40 % de volume sous la piste musicale.');
  lines.push('- Fichiers plus légers : sampling_rate 22050 (taille moitié) et/ou mono — largement suffisant pour les fonds de jeu.');
  lines.push('- Tonalité : accepte noms EN et FR — "A minor", "la mineur", "F# dorien", "C majeur", "F# mixolydien"…');
  lines.push('- Instrumental uniquement. Pour la production, utilise sampling_rate: 48000 et bit_depth: 24. stems: true ajoute les pupitres avant mastering.');
  lines.push('- MIDI : instruments séparés et marqueurs de sections. arrangement permet de choisir les accords, les pupitres et le motif.');
  lines.push('- Composition guidée : draft_music accepte une phrase et retourne les projets de trois esquisses. finish_music livre le projet choisi.');
  lines.push('- Timbres : list_sounds présente la palette. Passe les identifiants à sounds dans play_sound. sound_design: evolving fait changer de matière entre sections.');
  lines.push('- Synthèse : design_sound invente un son à partir d’un brief ou d’un patch. Importe le fichier patch_path dans patch_paths et affecte son identifiant dans patch_roles.');
  lines.push('- Studio : piano, contrebasse, batterie, cordes, bois, cor, guitares, harpe, vibraphone et violoncelles enregistrés.');
  lines.push('- Jeu : editions livre trois boucles et une transition alignées. cuts dans finish_music produit des formats de 15, 30 ou 60 secondes.');
  return lines.join('\n');
}

function musicSummaryText(meta, files, audio) {
  const lines = [];
  lines.push(`🎵 « ${meta.title || meta.styleLabel} » créé.`);
  lines.push('');
  lines.push(`- Style : ${meta.styleLabel} (${meta.style})`);
  lines.push(`- Ambiance : ${meta.description}`);
  lines.push(`- Tonalité : ${meta.keyFr} (${meta.key})`);
  lines.push(`- Tempo : ${meta.tempo} BPM · ${meta.bars} mesures`);
  lines.push(`- Progression : ${meta.progression} [${meta.progressionRomans}]`);
  if (meta.progressionB && meta.progressionB !== meta.progression) {
    lines.push(`- Section B : ${meta.progressionB}`);
  }
  lines.push(`- Structure : ${meta.sections.map((s) => `${s.name}(${s.bars})`).join(' → ')}`);
  lines.push(`- Durée musicale : ${meta.durationSeconds} s${meta.loop ? ' (boucle)' : ''}`);
  if (audio) lines.push(`- WAV : ${audio.durationSeconds} s · ${audio.sr} Hz · ${audio.bits} bits · crête ${audio.peakDbfs ?? 'silence'} dBFS`);
  lines.push(`- Seed : ${meta.seed}. ${TIP_SEED}`);
  lines.push('');
  lines.push('Fichiers :');
  for (const f of files) {
    lines.push(`- ${f.path} (${fmtBytes(f.bytes)})`);
  }
  if (meta.loop) lines.push('');
  lines.push(TIP_LOOP);
  lines.push(`Idéal pour : ${meta.idealFor.join(', ')}`);
  return lines.join('\n');
}

/* ---------------------------------- exécution ---------------------------------- */

function musicOutputs(args, bitDepth = 16) {
  const format = args.format ?? 'wav';
  const bits = args.bit_depth ?? bitDepth;
  if (!['wav', 'midi', 'both'].includes(format)) throw new Error(`Format invalide : ${format}.`);
  if (![16, 24].includes(bits)) throw new Error('bit_depth attend 16 ou 24.');
  if (args.stems && format === 'midi') throw new Error('stems nécessite format: wav ou both.');
  if (args.palette !== undefined && !PALETTES.includes(args.palette)) throw new Error('palette attend studio ou synth.');
  return { format, bits, stems: args.stems };
}

function exportTrack(song, { format, bits, stems }, outputDir, base) {
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

function exportMusic(song, outputs, outputDir, base, args) {
  const editions = getEditions(song, args.editions, args.loop_region);
  const exported = exportTrack(song, outputs, outputDir, base);
  if (args.save_project) exported.files.push(writeProject(path.join(outputDir, `${base}.soundmcp.json`), song, outputs.bits));
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
  if (typeof value !== 'string' || !value.trim()) throw new Error('project_path est requis.');
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
  if (seed !== undefined && (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)) throw new Error('seed attend un entier de 0 à 4294967295.');
  return seed ?? randomSeed();
}

function listSounds() {
  const sounds = Object.entries(AUDITION_SOUNDS).map(([id, [label, description, part]]) => ({ id, label, description, part,
    source: RECORDED_SOUNDS.has(id) ? 'prise instrumentale' : 'synthèse' }));
  const colors = { natural: 'Sans traitement supplémentaire.', radio: 'Bande étroite et presque mono.',
    warm: 'Aigus adoucis et image resserrée.', rough: 'Saturation légère et aigus filtrés.', wide: 'Image stéréo élargie.' };
  return resultText(sounds.map(({ id, label, description }) => `- ${id} · ${label}. ${description}`).join('\n') +
    '\nCouleurs de section : ' + Object.keys(colors).join(', ') + '\nPour inventer un son, appelle design_sound.',
    { sounds, colors, instruments: Object.keys(INSTRUMENTS), designTool: 'design_sound' });
}

function designSound(args) {
  if ((args.brief === undefined) === (args.patch === undefined)) throw new Error('Indique un brief ou un patch.');
  const seed = musicSeed(args.seed);
  const patch = createPatch(args.title ?? 'Son personnel', args.patch ?? patchFromBrief(args.brief, seed));
  const duration = args.duration_seconds ?? 4;
  const gate = args.gate_seconds ?? Math.min(1.8, duration * 0.63);
  if (!Number.isFinite(duration) || duration < 0.7 || duration > 12 || !Number.isFinite(gate) || gate < 0.03 || gate > 10 || gate > duration - 0.15) {
    throw new Error('Durée de préécoute de 0.7 à 12 s, avec une tenue de 0.03 à 10 s qui tient dans le fichier.');
  }
  const midi = noteNumber(args.note ?? 'C4');
  const velocity = args.velocity ?? 0.78;
  if (!Number.isFinite(velocity) || velocity < 0.05 || velocity > 1) throw new Error('velocity doit être entre 0.05 et 1.');
  const gesture = normalizeGesture(args.gesture);
  if (gesture && !supportsGesture(patch.patch)) throw new Error(GESTURE_PATCH_ERROR);
  const event = { t: 0.045, dur: gate, midi, freq: midiToFreq(midi), pan: 0, vel: velocity, inst: patch.id, bus: 'mel', seedIdx: seed, gesture };
  const audio = renderSong({ bpm: 60, totalBeats: duration - 0.12, bars: 1, sr: 48000, events: [event], loop: false,
    targetSeconds: duration, endFade: 0.08, patches: { [patch.id]: patch.patch } });
  const directory = newFolder(outputDirectory(args.output_dir), patch.label);
  const wavPath = path.join(directory, `${slug(patch.label)}.wav`);
  writeWav(wavPath, audio.L, audio.R, audio.sr, false, 24);
  const patchPath = writePatch(directory, slug(patch.label), patch);
  return resultText(`${patch.label} · ${duration} s\n${wavPath}\nRéglages : ${patchPath}\nIdentifiant : ${patch.id}`,
    { ...patch, preview_path: wavPath, patch_path: patchPath, seed, note: midi, audio: measure(audio) });
}

function calibration(args) {
  const sound = loadPatch(args);
  const result = calibrateSound(sound, args.role ?? 'mel', args.notes, musicSeed(args.seed));
  const folder = newFolder(outputDirectory(args.output_dir), `${sound.label}-calibration`);
  const calibration_path = jsonFile(folder, 'registre.soundmcp-calibration.json', result);
  return resultText(`${sound.label} · ${result.probes.length} mesures sur le pupitre ${result.role}\n${calibration_path}`, { ...result, calibration_path });
}

function soundAudition(args, seed) {
  const phrase = readPhrase(args, seed);
  const tech = techOptions({ sampling_rate: args.sampling_rate ?? 48000, mono: args.mono });
  return (sound) => playPhrase(sound, tech, phrase);
}

function playSound(args) {
  if (args.sounds !== undefined) {
    if (PHRASE_ONLY_FIELDS.some((name) => args[name] !== undefined)) {
      throw new Error('sounds écoute les extraits du catalogue. Pour jouer une phrase personnalisée, indique instrument, patch ou patch_path avec notes.');
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
  if (!Array.isArray(args.sounds) || args.sounds.length < 2 || args.sounds.length > 4) throw new Error('sounds attend entre deux et quatre sons.');
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
    throw new Error('Indique des directions distinctes parmi brighter, darker, shorter, longer et amount entre 0.05 et 1.');
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
    throw new Error('sounds attend 1 à 12 sons connus. Consulte list_sounds.');
  }
  const timbre = args.timbre ?? 0.5;
  if (!Number.isFinite(timbre) || timbre < 0 || timbre > 1) throw new Error('timbre doit être entre 0 et 1.');
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
  const palette = args.palette ?? 'studio';
  if (!PALETTES.includes(palette)) throw new Error('palette attend studio ou synth.');
  const intent = interpretBrief(args.brief, args);
  if (args.build_contour !== undefined && !CONTOURS.includes(args.build_contour)) {
    throw new Error('build_contour attend progressive ou break.');
  }
  const choices = preferencesFor(args, true);
  const plan = { ...intent, palette, autoMix: args.auto_mix ?? intent.phrasing === 'lyrical',
    ...(args.build_contour ? { buildContour: args.build_contour } : {}),
    ...(Object.keys(choices).length ? { preferences: choices } : {}) };
  const patches = importPatches(args.patch_paths);
  const calibrations = loadCalibrations(args.calibration_paths);
  const seed = musicSeed(args.seed);
  const count = args.variants ?? 3;
  if (!Number.isInteger(count) || count < 1 || count > 3) throw new Error('variants attend de 1 à 3 esquisses.');
  const title = args.title ? String(args.title) : 'Esquisses instrumentales';
  const drafts = Array.from({ length: count }, (_, i) => {
    const arranged = withInterpretation(assignPatchRoles(arrange(plan, seed, i, `${title} — ${i + 1}`), args.patch_roles, patches), args);
    const prepared = plan.buildContour && arranged.bars > 1
      ? shapeBuild(arranged, { arrival_bar: arrivalBar(arranged), contour: plan.buildContour }) : arranged;
    const { song, mix } = production(prepared, args, calibrations, choices, plan.autoMix);
    const fragment = excerpt(song);
    const audio = renderSong(fragment.song);
    return { song, fragment, audio, mix };
  });
  const levels = matchLevels(drafts.map((draft) => draft.audio));
  const outputDir = newFolder(outputDirectory(args.output_dir), title);
  const candidates = drafts.map(({ song, fragment, audio, mix }, i) => {
    const base = `esquisse-${i + 1}`;
    const previewPath = path.join(outputDir, `${base}.wav`);
    const projectPath = path.join(outputDir, `${base}.soundmcp.json`);
    writeWav(previewPath, audio.L, audio.R, audio.sr, audio.mono, 24);
    writeProject(projectPath, song, 24);
    const gaps = plan.instruments.filter((name) => !song.meta.instruments.includes(name));
    const warnings = diagnose(levels[i]);
    if (plan.buildContour && song.bars === 1) warnings.push('La montée demande au moins deux mesures.');
    if (gaps.length) warnings.push(`Instruments demandés absents : ${gaps.join(', ')}.`);
    if (plan.loop && Math.abs(song.meta.durationSeconds - plan.duration) > 0.05) warnings.push('Durée musicale arrondie à une mesure complète pour la boucle.');
    if (!plan.loop && song.targetSeconds > plan.duration + 0.05) warnings.push('Une mesure entière dépasse la durée demandée à ce tempo.');
    return { id: i + 1, project_path: projectPath, preview_path: previewPath, music: song.meta,
      preview: { ...fragment.region, ...levels[i] }, ...(mix.length ? { mix } : {}), warnings };
  });
  const preferred = candidates.reduce((a, b) => b.warnings.length < a.warnings.length ? b : a);
  const result = { seed, plan, candidates, firstToPreview: preferred.id };
  result.report_path = jsonFile(outputDir, 'esquisses.json', result);
  return resultText(`${count} esquisse(s) instrumentale(s), style ${plan.style}, ${plan.tempo} BPM.\n` +
    candidates.map((c) => `- ${c.id}. ${c.music.key} · ${c.preview.integratedLufs ?? 'silence'} LUFS · ${c.preview_path}\n  Projet : ${c.project_path}`).join('\n') +
    '\nPasse le project_path retenu à finish_music.', result);
}

function previewFragment(song, args) {
  if (!args.full) return excerpt(song, args);
  if (args.full && (args.section !== undefined || args.region !== undefined || args.max_seconds !== undefined)) {
    throw new Error('full s’utilise sans section, region ni max_seconds.');
  }
  const body = musicClock(song).seconds;
  const duration = song.loop ? body : song.targetSeconds ?? body + 2.6;
  if (duration > 45) throw new Error('full attend des morceaux de 45 secondes ou moins.');
  return { song, region: { startBar: 1, bars: song.bars } };
}

function previewMusic(args) {
  if (args.project_path !== undefined && args.project_paths !== undefined) throw new Error('Choisis project_path ou project_paths.');
  const paths = args.project_paths ?? [args.project_path];
  if (!Array.isArray(paths) || !paths.length || paths.length > 3) throw new Error('La comparaison accepte 1 à 3 projets.');
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
  if (criterion === 'build') {
    if (['region', 'full', 'max_seconds'].some((name) => args[name] !== undefined)) {
      throw new Error('Pour build, situe l’arrivée avec section ou arrival_bar, puis borne le passage avec before_bars et after_bars.');
    }
    const result = compareBuilds(args);
    return { ...result, structuredContent: { criterion, ...result.structuredContent } };
  }
  if (!Object.hasOwn(CHOICES, criterion)) throw new Error(`criterion attend ${MUSIC_COMPARISON_CRITERIA.join(' ou ')}.`);
  if (['arrival_bar', 'before_bars', 'after_bars', 'amount'].some((name) => args[name] !== undefined)) {
    throw new Error('Les réglages de montée exigent criterion build. Utilise section ou region pour ce critère.');
  }
  const { song, bit_depth } = openProject(args.project_path);
  const region = previewFragment(song, args).region;
  const normal = applyPreference(song, criterion, 'normal', region);
  const alternative = applyPreference(normal, criterion, CHOICES[criterion], region);
  if (alternative === normal) throw new Error('Ce passage ne contient aucune note compatible avec ce critère.');
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
  if (args.section !== undefined && args.arrival_bar !== undefined) throw new Error('Indique une section ou arrival_bar.');
  const arrival = args.section === undefined ? args.arrival_bar ?? arrivalBar(song)
    : song.meta.sections[sectionIndex(song, args.section)].startBar;
  const window = buildWindow(song, { ...args, arrival_bar: arrival });
  const available = song.bars - arrival + 1;
  let after = args.after_bars ?? Math.min(2, available);
  if (!Number.isInteger(after) || after < 1 || after > Math.min(8, available)) throw new Error('after_bars doit tenir dans la partition, entre 1 et 8.');
  if (args.amount === 0) throw new Error('Une comparaison demande une intensité supérieure à zéro.');
  const clock = musicClock(song);
  const previewLength = () => clock.at(window.arrival + after * 4) - clock.at(window.start);
  while (previewLength() + .65 > 45) {
    if (args.before_bars === undefined && window.arrival - window.start > 4) window.start += 4;
    else if (args.after_bars === undefined && after > 1) after--;
    else throw new Error('La préécoute dépasse 45 secondes. Réduis before_bars ou after_bars.');
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
    throw new Error('Ce passage ne contient pas d’accompagnement audible dans la montée.');
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
  if ((args.project_path === undefined) === (args.wav_path === undefined)) throw new Error('Indique un project_path ou un wav_path.');
  let report;
  if (args.wav_path !== undefined) {
    if (typeof args.wav_path !== 'string' || !args.wav_path.trim()) throw new Error('Chemin WAV invalide.');
    report = measure(readWave(path.resolve(args.wav_path)));
    report.warnings = diagnose(report);
  } else {
    const { song } = openProject(args.project_path);
    const stems = {};
    const audio = renderSong(song, (part, L, R) => { stems[part] = { rmsDbfs: localRms(L, R) }; });
    report = scoreMetrics(song, audio, stems);
    report.title = song.meta.title;
  }
  const text = `${report.durationSeconds} s · ${report.integratedLufs ?? 'silence'} LUFS · crête échantillon ${report.samplePeakDbfs ?? 'silence'} dBFS.\n` +
    (report.warnings.length ? report.warnings.join('\n') : 'Aucun problème détecté par les contrôles automatiques.');
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
    throw new Error('cuts attend une liste sans doublon parmi 15, 30 et 60.');
  }
  const cuts = requested.map((seconds) => cutMusic(song, seconds));
  const outputDir = newFolder(outputDirectory(args.output_dir, path.dirname(project.source)), `${title}-master`);
  const base = slug(title);
  const result = exportMusic(song, outputs, outputDir, base, { ...opts, save_project: true });
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

/**
 * Appelle un outil. Lève une Error en cas de paramètre invalide
 * (le serveur MCP convertit en result isError, le CLI affiche et sort en 1).
 * Retourne { content, structuredContent }.
 */
async function callTool(name, args = {}) {
  if (name === 'design_sound') return designSound(args);
  if (name === 'calibrate_sound') return calibration(args);
  if (name === 'mix_music') return mixMusic(args);
  if (name === 'compare_music_choices') return compareMusicChoices(args);
  if (name === 'compare_builds') return compareBuilds(args);
  if (name === 'learn_music_preference') {
    const result = rememberChoice(args.comparison_path, args.chosen, args.profile_path ?? DEFAULT_PROFILE);
    return resultText(`Préférence enregistrée dans ${result.profile_path}.`, result);
  }
  if (name === 'play_sound') return playSound(args);
  if (name === 'compare_sounds') return compareSounds(args);
  if (name === 'vary_sound') return varySound(args);
  if (name === 'inspect_score') {
    const { song } = openProject(args.project_path);
    const report = inspectScore(song, args);
    return resultText(`${report.title ?? 'Partition'} · ${report.events.length} / ${report.event_count} événement(s).`, report);
  }
  if (name === 'list_sounds') return listSounds();
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
      throw new Error(`Style inconnu: "${styleId}". Styles valides: ${STYLE_IDS.join(', ')}. Appelle list_styles pour le détail.`);
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
    const updated = applyCalibrations(withInterpretation({ ...assignPatchRoles(editSong(editable, args.edits), args.patch_roles, patches),
      ...tech, palette: args.palette ?? project.song.palette }, args), loadCalibrations(args.calibration_paths));
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
      structuredContent: { versions: results } };
  }

  if (name === 'create_sfx') {
    const kind = String(args.kind || '').trim();
    if (!SFX_KINDS[kind]) {
      throw new Error(`SFX inconnu: "${kind}". Disponibles: ${SFX_IDS.join(', ')}.`);
    }
    const outputDir = args.output_dir ? path.resolve(String(args.output_dir)) : DEFAULT_OUTPUT_DIR;
    const sfx = createSfx(kind, {
      seed: args.seed,
      volume: args.volume,
      outputDir,
      ...techOptions(args),
    });
    const text = [
      `🔊 SFX « ${kind} » créé : ${sfx.desc}`,
      '',
      `- Fichier : ${sfx.path} (${fmtBytes(sfx.bytes)})`,
      `- Durée : ${sfx.durationSeconds} s`,
      `- Seed : ${sfx.seed} — même seed = même effet (variantes cohérentes possibles).`,
    ].join('\n');
    return {
      content: [{ type: 'text', text }],
      structuredContent: sfx,
    };
  }

  if (name === 'create_ambience') {
    const kind = String(args.kind || '').trim();
    if (!AMBIENCE_KINDS[kind]) {
      throw new Error(`Ambiance inconnue: "${kind}". Disponibles: ${AMBIENCE_IDS.join(', ')}.`);
    }
    const outputDir = args.output_dir ? path.resolve(String(args.output_dir)) : DEFAULT_OUTPUT_DIR;
    const amb = createAmbience(kind, {
      seed: args.seed,
      durationSec: args.duration_seconds,
      volume: args.volume,
      outputDir,
      ...techOptions(args),
    });
    const text = [
      `🌫️ Ambiance « ${kind} » créée : ${amb.desc}`,
      '',
      `- Fichier : ${amb.path} (${fmtBytes(amb.bytes)})`,
      `- Boucle : ${amb.durationSeconds} s, sans raccord audible (crossfade intégré)`,
      `- Seed : ${amb.seed} — même seed = même ambiance.`,
      '',
      'Astuce : joue-la en fond en continu (loop) ; une ambiance plus longue a des événements moins répétitifs.',
    ].join('\n');
    return {
      content: [{ type: 'text', text }],
      structuredContent: amb,
    };
  }

  throw new Error(`Outil inconnu: ${name}. Disponibles: ${TOOLS.map((t) => t.name).join(', ')}.`);
}

module.exports = {
  TOOLS,
  callTool,
  DEFAULT_OUTPUT_DIR,
  listStylesText,
};
