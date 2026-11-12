'use strict';

/**
 * Catalogue d'outils MCP + logique d'exécution partagée
 * (utilisée par le serveur MCP et par le CLI).
 */

const path = require('node:path');
const { createSong } = require('./composer');
const { renderSong, writeWav } = require('./dsp');
const { writeMidi } = require('./midi');
const { createSfx, SFX_IDS, SFX_KINDS } = require('./sfx');
const { STYLES, STYLE_IDS } = require('./styles');
const { randomSeed } = require('./rng');

const DEFAULT_OUTPUT_DIR = path.join(__dirname, '..', 'output');

const slug = (s) =>
  String(s).toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'musique';

const fmtSec = (s) => (s >= 90 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);
const fmtBytes = (b) => (b >= 1024 * 1024 ? `${(b / 1048576).toFixed(1)} Mo` : `${Math.round(b / 1024)} Ko`);

/* ---------------------------------- descriptions ---------------------------------- */

const TIP_SEED = 'Note le « seed » renvoyé : la même graine + les mêmes paramètres reproduisent exactement le même son.';
const TIP_LOOP = 'Pour une boucle de jeu, utilise loop: true — la queue de réverbération est repliée au début, le raccord est inaudible.';

const TOOLS = [
  {
    name: 'list_styles',
    description: 'Liste les styles musicaux disponibles (ambiant, lo-fi, chiptune, épique, combat, victoire…) et les effets sonores (SFX), avec leurs usages et tempos par défaut. À consulter avant de créer une musique.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_music',
    description: 'Compose et rend une piste musicale de jeu (WAV stéréo 44.1 kHz 16 bits, MIDI GM, ou les deux). 14 styles : ambient, lofi, chiptune, epic, mystery, fantasy, upbeat, sad, dungeon, menu, suspense, victory, village, combat. Déterministe : même seed = même musique. loop: true produit une boucle sans raccord audible, parfaite en fond de jeu.',
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
          description: 'Graine aléatoire. Même seed + mêmes paramètres = musique identique. Change le seed pour une variation.',
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
    name: 'create_sfx',
    description: 'Crée un effet sonore de jeu prêt à l\'emploi (WAV) : jump, coin, pickup, hit, damage, explosion, whoosh, laser, powerup, levelup, heal, click, hover, error, success, footstep, door, splash, heartbeat, alarm, sword, bubble. Déterministe via seed.',
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
  lines.push('## Effets sonores disponibles (create_sfx)');
  lines.push('');
  for (const id of SFX_IDS) {
    lines.push(`**${id}** — ${SFX_KINDS[id].desc}`);
  }
  lines.push('');
  lines.push('## Astuces');
  lines.push(`- ${TIP_SEED}`);
  lines.push(`- ${TIP_LOOP}`);
  lines.push('- Tonalité : accepte noms EN et FR — "A minor", "la mineur", "F# dorien", "C majeur", "F# mixolydien"…');
  lines.push('- WAV : stéréo 44.1 kHz 16 bits, prêt à l\'emploi. MIDI : format GM, éditable dans un DAW.');
  return lines.join('\n');
}

function musicSummaryText(meta, files) {
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
  lines.push(`- Durée : ${meta.durationSeconds} s ${meta.loop ? '(boucle sans raccord)' : '(avec fondu de fin)'}`);
  lines.push(`- Seed : ${meta.seed} — ${TIP_SEED.toLowerCase().replace('note le « seed » renvoyé : ', 'réutilisable pour reproduire cette musique : ')}`);
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

/**
 * Appelle un outil. Lève une Error en cas de paramètre invalide
 * (le serveur MCP convertit en result isError, le CLI affiche et sort en 1).
 * Retourne { content, structuredContent }.
 */
async function callTool(name, args = {}) {
  if (name === 'list_styles') {
    const text = listStylesText();
    return { content: [{ type: 'text', text }] };
  }

  if (name === 'create_music') {
    const styleId = String(args.style || '').trim();
    if (!STYLES[styleId]) {
      throw new Error(`Style inconnu: "${styleId}". Styles valides: ${STYLE_IDS.join(', ')}. Appelle list_styles pour le détail.`);
    }
    const outputDir = args.output_dir ? path.resolve(String(args.output_dir)) : DEFAULT_OUTPUT_DIR;
    const format = args.format === 'midi' || args.format === 'both' ? args.format : 'wav';
    const seed = args.seed !== undefined ? (args.seed >>> 0) : randomSeed();

    const params = {
      style: styleId,
      duration_seconds: args.duration_seconds,
      tempo: args.tempo,
      key: args.key,
      seed,
      loop: args.loop,
      title: args.title ? String(args.title) : undefined,
    };
    const song = createSong(params);
    const base = args.title ? slug(args.title) : `music-${styleId}-${seed}`;

    const files = [];
    if (format === 'wav' || format === 'both') {
      const audio = renderSong(song);
      const wavPath = path.join(outputDir, `${base}.wav`);
      const wav = writeWav(wavPath, audio.L, audio.R, audio.sr);
      files.push({ path: wavPath, format: 'wav', bytes: wav.bytes, samples: wav.samples, sr: wav.sr });
    }
    if (format === 'midi' || format === 'both') {
      const midiPath = path.join(outputDir, `${base}.mid`);
      const midi = writeMidi(midiPath, song, params.title || styleId);
      files.push({ path: midiPath, format: 'midi', bytes: midi.bytes });
    }

    const text = musicSummaryText(song.meta, files);
    return {
      content: [{ type: 'text', text }],
      structuredContent: { meta: song.meta, files },
    };
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

  throw new Error(`Outil inconnu: ${name}. Disponibles: ${TOOLS.map((t) => t.name).join(', ')}.`);
}

module.exports = {
  TOOLS,
  callTool,
  DEFAULT_OUTPUT_DIR,
  listStylesText,
};
