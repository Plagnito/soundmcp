'use strict';

/**
 * CLI de SoundMCP (indépendant du protocole MCP).
 *
 *   node src/cli.js list
 *   node src/cli.js music <style> [--dur N] [--bpm N] [--key "..."] [--seed N]
 *                        [--midi|--both] [--loop|--no-loop] [--out dir] [--title "..."] [--json]
 *   node src/cli.js sfx <kind> [--seed N] [--vol N] [--out dir]
 *   node src/cli.js ambience <kind> [--dur N] [--seed N] [--vol N] [--out dir]
 *   node src/cli.js help
 */

const { readFileSync } = require('node:fs');
const { callTool } = require('./tools');

const USAGE = [
  'SoundMCP — composition musicale pour IA (zéro dépendance)',
  '',
  'Commandes :',
  '  list                                   Liste les styles, les ambiances et les effets sonores.',
  '  music <style> [options]                Compose une piste.',
  '  edit <projet.soundmcp.json> [options]  Reprend une partition enregistrée.',
  '  draft "brief" [options]                Crée trois esquisses instrumentales.',
  '  sounds                                 Liste les timbres et les couleurs de mix.',
  '  sound-preview <sons séparés par virgules>   Joue le nuancier sonore.',
  '  design-sound "description" [options]  Invente un son avec réglages réutilisables.',
  '  finish <projet.soundmcp.json> [options] Rend le master et les livrables.',
  '  preview <projet> [projet B] [projet C] Préécoute à niveau égal.',
  '  analyze <projet ou WAV>                Mesures et historique.',
  '  sfx <kind> [options]                   Crée un effet sonore.',
  '  ambience <kind> [options]              Crée une ambiance en boucle parfaite.',
  '  help                                   Cette aide.',
  '',
  'Options de music :',
  '  --dur N         Durée en secondes (5-600, défaut : celle du style).',
  '  --bpm N         Tempo (40-220, défaut : celui du style).',
  '  --key "..."     Tonalité, ex. "A minor", "la mineur", "F# dorien".',
  '  --seed N        Graine : même graine = même musique.',
  '  --midi          Export MIDI au lieu du WAV.',
  '  --both          Export WAV + MIDI.',
  '  --loop / --no-loop  Force ou désactive la boucle sans raccord.',
  '  --out dir       Dossier de sortie (défaut : output/).',
  '  --title "..."   Titre (sert de nom de fichier).',
  '  --sr N          Fréquence d\'échantillonnage : 22050, 44100 (défaut) ou 48000.',
  '  --bits N        Master WAV en 16 bits (défaut) ou 24 bits.',
  '  --stems         Pupitres séparés avant mastering, en WAV 32 bits flottant.',
  '  --arrangement fichier.json  Charge les sections et le motif.',
  '  --palette studio|synth Choisit les enregistrements instrumentaux ou la synthèse.',
  '  --project       Enregistre la partition pour edit.',
  '  --editions loop,calm,intense  Exporte les boucles alignées.',
  '  --loop-region début:mesures   Indique la première mesure et le nombre de mesures.',
  '  --mono          Exporte en mono (taille moitié).',
  '  --json          Affiche les métadonnées en JSON.',
  '',
  'Options de edit :',
  '  --edits fichier.json  Charge le tableau de retouches.',
  '  --ending-variants N   Génère 1 à 5 fins.',
  '  Les options WAV, MIDI et éditions sont également disponibles.',
  '  draft : --dur N, --seed N, --variants N, --title, --out, --json.',
  '  draft : --midi-motif fichier.mid [--midi-track N] [--midi-channel N] [--midi-start N] [--midi-bars N].',
  '  draft et music : --sound-design classic|evolving.',
  '  draft et music : --orchestral-percussion march|drive|none.',
  '  design-sound : --definition fichier.json, --note C4, --dur N, --gate N.',
  '  Import : --patch fichier.soundmcp-patch.json et --patch-role pupitre:identifiant.',
  '  finish : --cuts 15,30,60, --editions loop,calm,intense,transition, --no-stems.',
  '  finish : --adaptive début:mesures [--adaptive-fade ms] exporte intro, boucle, sortie et manifeste.',
  '  preview : --blind, --section nom, --loop-region début:mesures, --dur N.',
  '',
  'Options de sfx :',
  '  --seed N        Graine (variantes reproductibles).',
  '  --vol N         Volume 0.05-1 (défaut 1).',
  '  --source ID [--source-out dir]  Reprend un effet enregistré à la place de kind.',
  '  --variants N [--pitch-spread N] [--attack-spread ms]  Génère une famille de 2 à 12 prises.',
  '  --pitch N et --attack ms règlent la hauteur et le fondu d’attaque.',
  '  --out dir       Dossier de sortie.',
  '',
  'Options de ambience :',
  '  --dur N         Durée de la boucle en secondes (5-600, défaut : 45-60 selon l\'ambiance).',
  '  --seed N        Graine : même graine = même ambiance.',
  '  --vol N         Volume 0.05-1 (défaut 1).',
  '  --out dir       Dossier de sortie.',
  '',
  'Exemples :',
  '  node src/cli.js music lofi --dur 24 --seed 7',
  '  node src/cli.js music epic --dur 90 --key "D mineur" --loop --both --title "Boss 1"',
  '  node src/cli.js sfx coin --seed 3',
  '  node src/cli.js ambience rain --dur 60 --sr 22050',
].join('\n');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { args._.push(a); continue; }
    const key = a.slice(2);
    const num = (name) => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`Option --${name} attend une valeur.`);
      i++;
      return Number(v);
    };
    const str = (name) => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`Option --${name} attend une valeur.`);
      i++;
      return v;
    };
    const region = (name) => {
      const raw = str(name);
      if (!/^\d+:\d+$/.test(raw)) throw new Error(`Option --${name} attend début:mesures.`);
      const [start_bar, bars] = raw.split(':').map(Number);
      return { start_bar, bars };
    };
    switch (key) {
      case 'dur': args.dur = num('dur'); break;
      case 'bpm': args.bpm = num('bpm'); break;
      case 'seed': args.seed = num('seed'); break;
      case 'vol': args.vol = num('vol'); break;
      case 'sr': args.sr = num('sr'); break;
      case 'bits': args.bits = num('bits'); break;
      case 'stems': args.stems = true; break;
      case 'no-stems': args.stems = false; break;
      case 'variants': args.variants = num('variants'); break;
      case 'midi-motif': args.midiMotif = str('midi-motif'); break;
      case 'midi-track': args.midiTrack = num('midi-track'); break;
      case 'midi-channel': args.midiChannel = num('midi-channel'); break;
      case 'midi-start': args.midiStart = num('midi-start'); break;
      case 'midi-bars': args.midiBars = num('midi-bars'); break;
      case 'source': args.source = str('source'); break;
      case 'source-out': args.sourceOut = str('source-out'); break;
      case 'pitch': args.pitch = num('pitch'); break;
      case 'attack': args.attack = num('attack'); break;
      case 'pitch-spread': args.pitchSpread = num('pitch-spread'); break;
      case 'attack-spread': args.attackSpread = num('attack-spread'); break;
      case 'cuts': args.cuts = str('cuts').split(',').map(Number); break;
      case 'section': {
        const section = str('section');
        args.section = /^\d+$/.test(section) ? Number(section) : section;
        break;
      }
      case 'blind': args.blind = true; break;
      case 'arrangement': args.arrangement = str('arrangement'); break;
      case 'palette': args.palette = str('palette'); break;
      case 'sound-design': args.soundDesign = str('sound-design'); break;
      case 'orchestral-percussion': args.orchestralPercussion = str('orchestral-percussion'); break;
      case 'timbre': args.timbre = num('timbre'); break;
      case 'definition': args.definition = str('definition'); break;
      case 'note': args.note = str('note'); break;
      case 'gate': args.gate = num('gate'); break;
      case 'patch': (args.patchPaths ??= []).push(str('patch')); break;
      case 'patch-role': {
        const mapping = str('patch-role').split(':');
        if (mapping.length !== 2 || !mapping[0] || !mapping[1]) throw new Error('Option --patch-role attend pupitre:identifiant.');
        args.patchRoles = { ...args.patchRoles, [mapping[0]]: mapping[1] };
        break;
      }
      case 'project': args.project = true; break;
      case 'editions': args.editions = str('editions').split(',').map((value) => value.trim()); break;
      case 'loop-region': args.loopRegion = region('loop-region'); break;
      case 'adaptive': args.adaptive = region('adaptive'); break;
      case 'adaptive-fade': args.adaptiveFade = num('adaptive-fade'); break;
      case 'edits': args.edits = str('edits'); break;
      case 'ending-variants': args.endings = num('ending-variants'); break;
      case 'key': args.key = str('key'); break;
      case 'out': args.out = str('out'); break;
      case 'title': args.title = str('title'); break;
      case 'midi': args.midi = true; break;
      case 'both': args.both = true; break;
      case 'wav': args.wav = true; break;
      case 'loop': args.loop = true; break;
      case 'no-loop': args.loop = false; break;
      case 'mono': args.mono = true; break;
      case 'json': args.json = true; break;
      default: throw new Error(`Option inconnue: --${key}`);
    }
  }
  return args;
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    return;
  }

  if (cmd === 'list' || cmd === 'styles') {
    const res = await callTool('list_styles', {});
    console.log(res.content[0].text);
    return;
  }

  const musicOptions = {
    format: args.both ? 'both' : args.midi ? 'midi' : 'wav',
    sampling_rate: args.sr,
    bit_depth: args.bits,
    stems: args.stems,
    mono: args.mono,
    output_dir: args.out,
    title: args.title,
    palette: args.palette,
    patch_paths: args.patchPaths,
    patch_roles: args.patchRoles,
    editions: args.editions,
    loop_region: args.loopRegion,
  };

  const display = (res) => {
    console.log(res.content[0].text);
    if (args.json) console.log(JSON.stringify(res.structuredContent, null, 2));
  };

  if (cmd === 'draft') {
    const selectors = { track: args.midiTrack, channel: args.midiChannel, start_bar: args.midiStart, bars: args.midiBars };
    if (!args.midiMotif && Object.values(selectors).some((value) => value !== undefined)) {
      throw new Error('Indique --midi-motif pour choisir une piste, un canal ou une plage MIDI.');
    }
    display(await callTool('draft_music', { brief: args._.join(' '), duration_seconds: args.dur, tempo: args.bpm,
      key: args.key, loop: args.loop, seed: args.seed, variants: args.variants, sound_design: args.soundDesign,
      orchestral_percussion: args.orchestralPercussion, title: args.title, output_dir: args.out, palette: args.palette,
      midi_motif: args.midiMotif ? { path: args.midiMotif, ...selectors } : undefined,
      patch_paths: args.patchPaths, patch_roles: args.patchRoles }));
    return;
  }
  if (cmd === 'design-sound') {
    if (args.definition && args._.length) throw new Error('Indique une description ou --definition.');
    const data = args.definition ? readJson(args.definition) : undefined;
    const patch = data?.type === 'soundmcp-patch' ? data.patch : data;
    display(await callTool('design_sound', { brief: args.definition ? undefined : args._.join(' '), patch,
      title: args.title ?? data?.label, note: args.note, duration_seconds: args.dur, gate_seconds: args.gate, seed: args.seed, output_dir: args.out }));
    return;
  }
  if (cmd === 'sounds') {
    display(await callTool('list_sounds'));
    return;
  }
  if (cmd === 'sound-preview') {
    display(await callTool('preview_sounds', { sounds: args._.flatMap((word) => word.split(',').map((id) => id.trim())).filter(Boolean),
      timbre: args.timbre, seed: args.seed, output_dir: args.out, patch_paths: args.patchPaths }));
    return;
  }
  if (cmd === 'finish') {
    if (!args.adaptive && args.adaptiveFade !== undefined) throw new Error('Indique --adaptive pour régler son fondu.');
    display(await callTool('finish_music', { ...musicOptions, project_path: args._[0], cuts: args.cuts,
      adaptive: args.adaptive ? { loop_region: args.adaptive, crossfade_ms: args.adaptiveFade } : undefined,
      format: args.both ? 'both' : args.midi ? 'midi' : args.wav ? 'wav' : undefined }));
    return;
  }
  if (cmd === 'preview') {
    display(await callTool('preview_music', { project_paths: args._, section: args.section, region: args.loopRegion, max_seconds: args.dur,
      blind: args.blind, seed: args.seed, output_dir: args.out }));
    return;
  }
  if (cmd === 'analyze') {
    const input = args._[0];
    display(await callTool('analyze_music', typeof input !== 'string' || /\.wav$/i.test(input) ? { wav_path: input } : { project_path: input }));
    return;
  }

  if (cmd === 'edit') {
    const res = await callTool('edit_music', { ...musicOptions, project_path: args._[0],
      edits: args.edits ? readJson(args.edits) : undefined, ending_variants: args.endings });
    display(res);
    return;
  }

  if (cmd === 'music') {
    const style = args._[0];
    if (!style) {
      console.error('Usage : node src/cli.js music <style> [--dur N] [--seed N] ...');
      console.error('Styles : lance `node src/cli.js list`.');
      process.exitCode = 1;
      return;
    }
    const res = await callTool('create_music', {
      ...musicOptions,
      style,
      duration_seconds: args.dur,
      tempo: args.bpm,
      key: args.key,
      seed: args.seed,
      loop: args.loop,
      sound_design: args.soundDesign,
      orchestral_percussion: args.orchestralPercussion,
      arrangement: args.arrangement ? readJson(args.arrangement) : undefined,
      save_project: args.project,
    });
    display(res);
    return;
  }

  if (cmd === 'sfx') {
    const kind = args._[0];
    if (!kind && !args.source) {
      console.error('Usage : node src/cli.js sfx <kind> ou --source ID [--variants N]');
      console.error('Kinds : lance `node src/cli.js list`.');
      process.exitCode = 1;
      return;
    }
    if (args.variants === undefined && (args.pitchSpread !== undefined || args.attackSpread !== undefined)) {
      throw new Error('Indique --variants pour régler les écarts entre les prises.');
    }
    display(await callTool('create_sfx', {
      kind, source_file_id: args.source, source_output_dir: args.sourceOut,
      seed: args.seed,
      volume: args.vol,
      sampling_rate: args.sr,
      mono: args.mono,
      output_dir: args.out,
      pitch_semitones: args.pitch, attack_ms: args.attack,
      variants: args.variants === undefined ? undefined : {
        count: args.variants, pitch_spread: args.pitchSpread, attack_spread_ms: args.attackSpread,
      },
    }));
    return;
  }

  if (cmd === 'ambience') {
    const kind = args._[0];
    if (!kind) {
      console.error('Usage : node src/cli.js ambience <kind> [--dur N] [--seed N] [--vol N]');
      console.error('Kinds : lance `node src/cli.js list`.');
      process.exitCode = 1;
      return;
    }
    const res = await callTool('create_ambience', {
      kind,
      duration_seconds: args.dur,
      seed: args.seed,
      volume: args.vol,
      sampling_rate: args.sr,
      mono: args.mono,
      output_dir: args.out,
    });
    console.log(res.content[0].text);
    if (args.json) console.log(JSON.stringify(res.structuredContent, null, 2));
    return;
  }

  console.error(`Commande inconnue: ${cmd}. Lance \`node src/cli.js help\`.`);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exitCode = 1;
});
