#!/usr/bin/env node
'use strict';

/**
 * SoundMCP — serveur MCP stdio (JSON-RPC 2.0, une ligne = un message).
 *
 * Ne rien écrire sur stdout autre que les réponses JSON ;
 * tous les logs vont sur stderr.
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { TOOLS, callTool } = require('./tools');

const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const PROTOCOL_FALLBACK = '2025-06-18';

const INSTRUCTIONS = [
  'SoundMCP compose des instrumentaux sans voix et des effets sonores pour jeux et médias.',
  'Pour une demande musicale, appelle draft_music avec le brief en une phrase. Le résultat donne des préécoutes à niveau égal et trois chemins de projets.',
  'Pour une musique chaleureuse ou chantante, utilise phrasing: lyrical. Il adapte les hauteurs aux accords, garde le rythme du thème et laisse de la place à la mélodie. palette: synth privilégie les sons synthétisés.',
  'En phrasé lyrical, une introduction peut annoncer le thème par un fragment, la reprise développe sa réponse et le contrechant entre dans les respirations.',
  'Si tu as un thème précis, donne motif à draft_music. Les esquisses harmonisent les notes tenues et conservent le motif. reprise_treatment accepte sequence pour répéter la cellule plus haut ou augmentation pour l’étirer.',
  'Utilise calibrate_sound pour vérifier le jeu d’un patch dans plusieurs registres puis réimporte calibration_path dans calibration_paths. Les esquisses lyrical équilibrent les pupitres par section. mix_music permet de reprendre le mix.',
  'compare_music_choices génère deux variantes depuis un même projet. Avec criterion accompaniment ou breath, learn_music_preference peut mémoriser le choix explicite de l’auditeur. Avec criterion build, situe l’arrivée et compare les deux montées à niveau égal à la reprise.',
  'shape_build dans edits de edit_music règle une montée. build_contour dans draft_music l’applique à l’esquisse. sound_design: evolving fait varier les timbres et les textures entre sections.',
  'Pour écrire des percussions orchestrales, utilise orchestral_percussion: march ou drive dans le brief ou les sections. La retouche write_measure dans edits de edit_music peut accorder les timbales.',
  'Pour créer un son inédit, utilise design_sound. Il accepte un brief ou un patch détaillé. Importe ensuite patch_path via patch_paths et applique son id via patch_roles ou dans une section.',
  'Pour un son jouable de zéro, définis patch.modal.modes pour un matériau résonant ou patch.waveguide pour une corde pincée avec sa caisse. Relie la force, la position et l’amortissement au timbre. Avec edit_music, le type de retouche write_measure accepte gesture, slide et legato.',
  'Pour un matériau frotté ou une texture soutenue, ajoute patch.modal.friction. La résonance reste excitée pendant la tenue, et expression fait varier sa pression.',
  'list_sounds donne les identifiants du nuancier. play_sound accepte sounds pour écouter une série d’extraits ou instrument, patch ou patch_path pour jouer une phrase. compare_sounds joue cette phrase avec plusieurs timbres dans des WAV séparés à sonie égale. Affine un patch avec vary_sound puis réimporte sa variante dans un morceau.',
  'Pour un jeu expressif, active performance sur les pupitres qui en bénéficient. room place les pupitres à des distances différentes dans la même pièce virtuelle.',
  'Pour les choix détaillés, chaque section peut préciser instruments, color et textures. Les textures ont leur propre stem audio.',
  'Appelle finish_music sur le projet retenu pour livrer le master. preview_music rend des passages de projets existants. analyze_music donne les mesures et avertissements.',
  'Dans analyze_music, harmonicOverlaps indique les mesures où mélodie et accompagnement tiennent des notes à une seconde mineure ou une neuvième mineure. Vérifie ces passages avec preview_music et inspect_score avant de retoucher.',
  'Utilise create_music pour exporter directement un morceau à partir d’un style et d’un arrangement. edit_music crée une copie retouchée d’un projet existant.',
  'Avant de réécrire une mesure, consulte inspect_score pour retrouver ses accords, ses notes et le placement joué.',
  'Pour un morceau fini : loop: false. Pour un fond répétable : loop: true. Utilise arrangement pour définir les sections, les accords et le motif mélodique.',
  'Pour un master de production : sampling_rate: 48000, bit_depth: 24. format: both ajoute le MIDI. stems: true ajoute les pupitres avant mastering.',
  'palette: studio sélectionne les prises instrumentales. Le paramètre save_project de create_music conserve la partition éditable pour edit_music.',
  'editions: ["loop", "calm", "intense", "transition"] produit des versions alignées, sur loop_region si fourni. cuts: [15,30,60] pour des versions courtes dans finish_music.',
  'Conserve la version, les paramètres et le seed pour reproduire un rendu.',
  'Options techniques sur les trois outils de rendu : sampling_rate (22050/44100/48000) et mono (WAV 1 canal, taille moitié).',
].join(' ');

const log = (...a) => {
  process.stderr.write(`[soundmcp] ${a.join(' ')}\n`);
};

const send = (obj) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
};

const respond = (id, result) => {
  if (id === undefined || id === null) return; // jamais de réponse à une notification
  send({ jsonrpc: '2.0', id, result });
};

const respondError = (id, code, message) => {
  if (id === undefined || id === null) {
    log(`erreur sans destinataire: ${code} ${message}`);
    return;
  }
  send({ jsonrpc: '2.0', id, error: { code, message } });
};

/* ---------------------------------- handlers ---------------------------------- */

function initializeResult(params) {
  const requested = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
  const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : PROTOCOL_FALLBACK;
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'soundmcp', version: PKG.version },
    instructions: INSTRUCTIONS,
  };
}

async function handleRequest(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      respond(id, initializeResult(params));
      return;

    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'initialized':
      return; // notification : rien à faire

    case 'ping':
      respond(id, {});
      return;

    case 'tools/list':
      respond(id, { tools: TOOLS });
      return;

    case 'tools/call': {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      try {
        const result = await callTool(name, args);
        respond(id, result);
      } catch (err) {
        log(`outil ${name}: ${err.message}`);
        respond(id, {
          content: [{ type: 'text', text: `❌ ${err.message}` }],
          isError: true,
        });
      }
      return;
    }

    case 'logging/setLevel':
      respond(id, {});
      return;

    case 'resources/list':
      respond(id, { resources: [] });
      return;

    case 'prompts/list':
      respond(id, { prompts: [] });
      return;

    case 'completion/complete':
      respond(id, { completion: { values: [], hasMore: false } });
      return;

    case 'shutdown':
      respond(id, {});
      return;

    default:
      if (isNotification) return; // notifications inconnues : ignorées
      respondError(id, -32601, `Méthode inconnue: ${method}`);
  }
}

/* ---------------------------------- boucle stdio ---------------------------------- */

function main() {
  log(`v${PKG.version} — en attente sur stdin/stdout`);

  let queue = Promise.resolve();

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      respondError(null, -32700, `JSON invalide reçu sur stdin : ${trimmed.slice(0, 80)}`);
      return;
    }

    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      const id = msg && typeof msg === 'object' ? msg.id : null;
      respondError(id, -32600, 'Requête invalide : il faut jsonrpc="2.0", method et id.');
      return;
    }

    // Sérialise les traitements pour préserver l'ordre des réponses.
    const run = () => handleRequest(msg).catch((err) => {
      log(`erreur interne (${msg.method}): ${err.message}`);
      respondError(msg.id, -32603, `Erreur interne : ${err.message}`);
    });
    queue = queue.then(run, run);
  });

  rl.on('close', () => {
    log('stdin fermé, arrêt.');
    process.exit(0);
  });

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

main();
