#!/usr/bin/env node
'use strict';

const { ui } = require('./language');

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
const { INLINE_AUDIO_TOOLS } = require('./inline-audio');

const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const PROTOCOL_FALLBACK = '2025-06-18';
const LEGACY_TOOLS = TOOLS.map(({ title, outputSchema, ...tool }) => {
  if (!INLINE_AUDIO_TOOLS.has(tool.name)) return tool;
  const { inline_audio, ...properties } = tool.inputSchema.properties;
  return { ...tool, inputSchema: { ...tool.inputSchema, properties } };
});
let negotiatedProtocol = PROTOCOL_FALLBACK;

const INSTRUCTIONS = [
  ui(
    'SoundMCP compose des instrumentaux sans voix et des effets sonores pour jeux et médias.',
    'SoundMCP composes instrumental music and sound effects for games and media.',
  ),
  ui(
    'Pour explorer une idée musicale, donne le brief à draft_music. Le résultat contient un à trois projets éditables avec leurs préécoutes à niveau égal. Pour produire directement depuis un style déjà choisi, utilise create_music.',
    'To explore a musical idea, send the brief to draft_music. It returns one to three editable projects with loudness-matched previews. Use create_music to render directly from a chosen style.',
  ),
  ui(
    'Pour créer plusieurs morceaux distincts, donne à draft_music trois à six briefs, un par morceau. Précise les contrastes de rythme, d’harmonie ou d’instrumentation et les contraintes communes. Pour refaire un seul morceau, utilise son brief et sa graine avec variants=1 et les réglages shared_options de la collection.',
    'For several distinct tracks, give draft_music three to six briefs, one per track. Describe each rhythm, harmony, or instrumentation and the shared constraints. To recreate one track, reuse its brief and seed with variants=1 and the collection\'s shared_options.',
  ),
  ui(
    'Pour une musique chaleureuse ou chantante, utilise phrasing: lyrical. Il adapte les hauteurs aux accords, garde le rythme du thème et laisse de la place à la mélodie. palette: synth privilégie les sons synthétisés.',
    'For warm, melodic music, set phrasing to lyrical. It fits pitches to the chords while preserving the theme\'s rhythm and space for the melody. Set palette to synth to favor synthesized sounds.',
  ),
  ui(
    'En phrasé lyrical, une introduction peut annoncer le thème par un fragment, la reprise développe sa réponse et le contrechant entre dans les respirations.',
    'With lyrical phrasing, the introduction may foreshadow the theme, the reprise develops its response, and the countermelody fills the rests.',
  ),
  ui(
    'Pour partir d’un thème, donne motif ou midi_motif à draft_music. Les esquisses harmonisent le motif. instrument_roles choisit les timbres par pupitre. reprise_treatment accepte sequence pour répéter la cellule plus haut ou augmentation pour l’étirer.',
    'Give draft_music a motif or midi_motif to start from a theme. instrument_roles assigns instruments to parts. For reprise_treatment, sequence repeats the motif higher and augmentation stretches it.',
  ),
  ui(
    'Utilise calibrate_sound pour vérifier le jeu d’un patch dans plusieurs registres puis réimporte calibration_path dans calibration_paths. edit_music accepte mix pour rééquilibrer les pupitres après les retouches.',
    'Use calibrate_sound to check a patch across registers, then pass calibration_path in calibration_paths. edit_music accepts mix to rebalance parts after editing.',
  ),
  ui(
    'compare_music_choices génère deux variantes depuis un même projet. Avec criterion accompaniment ou breath, learn_music_preference peut mémoriser le choix explicite de l’auditeur. Avec criterion build, situe l’arrivée et compare les deux montées à niveau égal à la reprise.',
    'compare_music_choices makes two variants of the same project. For accompaniment or breath comparisons, learn_music_preference can save the listener\'s explicit choice. For build, align the previews at the arrival and compare both approaches at matched loudness.',
  ),
  ui(
    'shape_build dans edits de edit_music règle une montée. build_contour dans draft_music l’applique à l’esquisse. sound_design: evolving fait varier les timbres et les textures entre sections.',
    'Use shape_build in edit_music to shape a build, or build_contour in draft_music. Set sound_design to evolving to vary timbres and textures by section.',
  ),
  ui(
    'Pour écrire des percussions orchestrales, utilise orchestral_percussion: march ou drive dans le brief ou les sections. La retouche write_measure dans edits de edit_music peut accorder les timbales.',
    'Set orchestral_percussion to march or drive in the brief or sections to add orchestral percussion. Use write_measure in edit_music to tune timpani.',
  ),
  ui(
    'Pour créer un son inédit, utilise design_sound. Il accepte un brief ou un patch détaillé. Importe ensuite patch_path via patch_paths et applique son id via patch_roles ou dans une section.',
    'Use design_sound to make a sound from a brief or a detailed patch. Load the returned patch_path in patch_paths and assign its ID in patch_roles or in a section.',
  ),
  ui(
    'Pour un son jouable de zéro, définis patch.modal.modes pour un matériau résonant ou patch.waveguide pour une corde pincée avec sa caisse. Relie la force, la position et l’amortissement au timbre. Avec edit_music, le type de retouche write_measure accepte gesture, slide et legato.',
    'Use patch.modal.modes for resonant material or patch.waveguide for a plucked string with a body. Note position, damping, and force affect the timbre. The write_measure edit supports gesture, slide, and legato.',
  ),
  ui(
    'Pour un matériau frotté ou une texture soutenue, ajoute patch.modal.friction. La résonance reste excitée pendant la tenue, et expression fait varier sa pression.',
    'For a bowed or sustained sound, add patch.modal.friction. It excites resonances throughout the note, and expression can vary bow pressure.',
  ),
  ui(
    'list_catalog donne les identifiants par catégorie. play_sound accepte sounds pour écouter des extraits ou instrument, patch ou patch_path pour jouer une phrase. compare_sounds rend les mêmes notes avec plusieurs timbres dans des WAV séparés à sonie égale. Affine un patch avec vary_sound puis réimporte sa variante dans un morceau.',
    'list_catalog returns IDs by category. play_sound accepts sounds for examples or instrument, patch, or patch_path to play a phrase. compare_sounds renders the same notes with different sounds at matched loudness. Use vary_sound to refine a patch and reuse it in a track.',
  ),
  ui(
    'Pour un jeu expressif, active performance sur les pupitres qui en bénéficient. room place les pupitres à des distances différentes dans la même pièce virtuelle.',
    'Use performance for expressive playing and room to position parts at different distances in a shared space.',
  ),
  ui(
    'Pour les choix détaillés, chaque section peut préciser instruments, color et textures. Les textures ont leur propre stem audio.',
    'Sections can specify instruments, color, and textures. Textures have their own audio stem.',
  ),
  ui(
    'Appelle finish_music sur le projet retenu. adaptive exporte une introduction, une boucle et une sortie. preview_music rend des passages de projets existants. Avec un client audio MCP, inline_audio ajoute un extrait court aux préécoutes et comparaisons.',
    'Call finish_music on the chosen project. adaptive exports an intro, loop, and outro. preview_music renders excerpts from saved projects. With an audio-capable MCP client, inline_audio adds short audio previews or comparisons.',
  ),
  ui(
    'Dans analyze_music, harmonicOverlaps indique les mesures où mélodie et accompagnement tiennent des notes à une seconde mineure ou une neuvième mineure. Vérifie ces passages avec preview_music et inspect_score avant de retoucher.',
    'In analyze_music, harmonicOverlaps identifies sustained minor seconds or minor ninths between melody and accompaniment. Check the bars with preview_music and inspect_score before editing.',
  ),
  ui(
    'Utilise create_music pour exporter directement un morceau à partir d’un style et d’un arrangement. edit_music crée une copie retouchée d’un projet existant.',
    'Use create_music to export a track from a style and arrangement. edit_music saves an edited copy of a project.',
  ),
  ui(
    'Avant de réécrire une mesure, consulte inspect_score pour retrouver ses accords, ses notes et le placement joué.',
    'Before rewriting a bar, use inspect_score to see its chords, notes, and performed timing.',
  ),
  ui(
    'Pour un morceau fini : loop: false. Pour un fond répétable : loop: true. Utilise arrangement pour définir les sections, les accords et le motif mélodique.',
    'Set loop to false for a track with an ending or true for a repeating background track. Use arrangement to specify sections, chords, and the melody motif.',
  ),
  ui(
    'Pour un master de production : sampling_rate: 48000, bit_depth: 24. format: both ajoute le MIDI. stems: true ajoute les pupitres avant mastering.',
    'For production masters, use sampling_rate: 48000 and bit_depth: 24. format: both includes MIDI. stems: true adds pre-master stems.',
  ),
  ui(
    'palette: studio sélectionne les prises instrumentales. Le paramètre save_project de create_music conserve la partition éditable pour edit_music.',
    'Set palette to studio for recorded instruments. Use save_project in create_music to save the score for edit_music.',
  ),
  ui(
    'editions: ["loop", "calm", "intense", "transition"] produit des versions alignées, sur loop_region si fourni. cuts: [15,30,60] pour des versions courtes dans finish_music.',
    'Use editions ["loop", "calm", "intense", "transition"] for aligned variants, with loop_region if needed. Use cuts [15,30,60] in finish_music for short edits.',
  ),
  ui('Conserve la version, les paramètres et le seed pour reproduire un rendu.', 'Keep the engine version, settings, and seed to reproduce a render.'),
  ui(
    'manage_outputs liste les fichiers enregistrés après un rendu. Utilise file_type=project pour retrouver les projets et archive ou restore sur demande de l’utilisateur. Pour retoucher un effet ou une ambiance, repasse son file_id comme source_file_id au même outil, avec le dossier de la source.',
    'manage_outputs lists saved files. Filter with file_type=project for scores. Use archive or restore at the user\'s request. To revise an effect or ambience, give its file_id as source_file_id to its original tool and supply the source directory.',
  ),
  ui(
    'Options techniques sur les trois outils de rendu : sampling_rate (22050/44100/48000) et mono (WAV 1 canal, taille moitié).',
    'Rendering tools support sampling_rate (22050, 44100, or 48000) and mono (one-channel WAV at half the size).',
  ),
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
    log(ui(`erreur sans destinataire: ${code} ${message}`, `error without a request ID: ${code} ${message}`));
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
    case 'initialize': {
      const result = initializeResult(params);
      negotiatedProtocol = result.protocolVersion;
      respond(id, result);
      return;
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'initialized':
      return; // notification : rien à faire

    case 'ping':
      respond(id, {});
      return;

    case 'tools/list':
      respond(id, { tools: negotiatedProtocol === PROTOCOL_FALLBACK ? TOOLS : LEGACY_TOOLS });
      return;

    case 'tools/call': {
      const name = params && params.name;
      const input = (params && params.arguments) || {};
      const args = negotiatedProtocol !== PROTOCOL_FALLBACK && INLINE_AUDIO_TOOLS.has(name)
        ? { ...input, inline_audio: false } : input;
      try {
        const result = await callTool(name, args);
        if (negotiatedProtocol !== PROTOCOL_FALLBACK && result.structuredContent !== undefined) {
          result.content.push({ type: 'text', text: JSON.stringify(result.structuredContent) });
        }
        respond(id, result);
      } catch (err) {
        log(`${ui('outil', 'tool')} ${name}: ${err.message}`);
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
      respondError(id, -32601, ui(`Méthode inconnue: ${method}`, `Unknown method: ${method}`));
  }
}

/* ---------------------------------- boucle stdio ---------------------------------- */

function main() {
  log(`v${PKG.version} — ${ui('en attente sur stdin/stdout', 'listening on stdin/stdout')}`);

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
      respondError(null, -32700, ui('JSON invalide reçu sur stdin : ', 'Invalid JSON received on stdin: ') + trimmed.slice(0, 80));
      return;
    }

    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      const id = msg && typeof msg === 'object' ? msg.id : null;
      respondError(id, -32600, ui('Requête invalide : il faut jsonrpc="2.0", method et id.',
        'Invalid request. Supply jsonrpc="2.0", method, and id.'));
      return;
    }

    // Sérialise les traitements pour préserver l'ordre des réponses.
    const run = () => handleRequest(msg).catch((err) => {
      log(`${ui('erreur interne', 'internal error')} (${msg.method}): ${err.message}`);
      respondError(msg.id, -32603, ui('Erreur interne : ', 'Internal error: ') + err.message);
    });
    queue = queue.then(run, run);
  });

  rl.on('close', () => {
    log(ui('stdin fermé, arrêt.', 'stdin closed, stopping.'));
    process.exit(0);
  });

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

main();
