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

const { callTool } = require('./tools');

const USAGE = [
  'SoundMCP — composition musicale pour IA (zéro dépendance)',
  '',
  'Commandes :',
  '  list                                   Liste les styles, les ambiances et les effets sonores.',
  '  music <style> [options]                Compose une piste.',
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
  '  --mono          Exporte en mono (taille moitié).',
  '  --json          Affiche les métadonnées en JSON.',
  '',
  'Options de sfx :',
  '  --seed N        Graine (variantes reproductibles).',
  '  --vol N         Volume 0.05-1 (défaut 1).',
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
    switch (key) {
      case 'dur': args.dur = num('dur'); break;
      case 'bpm': args.bpm = num('bpm'); break;
      case 'seed': args.seed = num('seed'); break;
      case 'vol': args.vol = num('vol'); break;
      case 'sr': args.sr = num('sr'); break;
      case 'key': args.key = str('key'); break;
      case 'out': args.out = str('out'); break;
      case 'title': args.title = str('title'); break;
      case 'midi': args.midi = true; break;
      case 'both': args.both = true; break;
      case 'loop': args.loop = true; break;
      case 'no-loop': args.loop = false; break;
      case 'mono': args.mono = true; break;
      case 'json': args.json = true; break;
      default: throw new Error(`Option inconnue: --${key}`);
    }
  }
  return args;
}

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

  if (cmd === 'music') {
    const style = args._[0];
    if (!style) {
      console.error('Usage : node src/cli.js music <style> [--dur N] [--seed N] ...');
      console.error('Styles : lance `node src/cli.js list`.');
      process.exitCode = 1;
      return;
    }
    const format = args.both ? 'both' : args.midi ? 'midi' : 'wav';
    const res = await callTool('create_music', {
      style,
      duration_seconds: args.dur,
      tempo: args.bpm,
      key: args.key,
      seed: args.seed,
      loop: args.loop,
      format,
      sampling_rate: args.sr,
      mono: args.mono,
      output_dir: args.out,
      title: args.title,
    });
    console.log(res.content[0].text);
    if (args.json) console.log(JSON.stringify(res.structuredContent, null, 2));
    return;
  }

  if (cmd === 'sfx') {
    const kind = args._[0];
    if (!kind) {
      console.error('Usage : node src/cli.js sfx <kind> [--seed N] [--vol N]');
      console.error('Kinds : lance `node src/cli.js list`.');
      process.exitCode = 1;
      return;
    }
    const res = await callTool('create_sfx', {
      kind,
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
