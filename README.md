# SoundMCP 🎵

**Serveur MCP de composition musicale pour IA** — créez de la jolie musique pour vos jeux vidéo et vos effets sonores, sans aucune dépendance.

Le tout est généré mathématiquement en Node.js pur : théorie musicale (gammes, progressions d'accords, voice-leading, motifs) + DSP maison (réverbération type freeverb, délai ping-pong, écrêtage doux, normalisation). Aucune bibliothèque externe, aucun binaire, aucun appel réseau.

## Ce que ça produit

| Sortie | Format | Usage |
|---|---|---|
| Musique | WAV stéréo 44,1 kHz 16 bits (+ MIDI GM en option) | Fond sonore de jeu, ambiance, menu |
| Effets sonores (SFX) | WAV stéréo 44,1 kHz 16 bits | Saut, pièce, dégât, explosion, UI… |

Points clés :

- **Déterministe** : même `seed` + mêmes paramètres = exactement le même son. Idéal pour itérer (« essaie le seed 42 ») et reproduire un rendu validé.
- **Boucles sans raccord** : avec `loop: true`, la queue de réverbération/délai est repliée au début du morceau — le raccord est inaudible, parfait en fond de jeu continu.
- **Zéro dépendance** : `npm install` inutile. Un seul fichier de serveur, `node src/index.js`.
- **14 styles musicaux** et **22 effets sonores** prêts à l'emploi.

## Installation

Aucune. Node.js ≥ 18 suffit.

```bash
node src/index.js   # démarre le serveur MCP sur stdio
```

## Brancher dans OpenCode

Dans la configuration OpenCode (`opencode.json` du projet ou global) :

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "soundmcp": {
        "type": "local",
        "command": ["node", "D:/Claude/SoundMCP/src/index.js"]
      }
    }
  }
}
```

Ou en une commande : `opencode mcp add soundmcp -- node D:/Claude/SoundMCP/src/index.js`

## Brancher dans Claude Code

```bash
claude mcp add soundmcp -- node D:/Claude/SoundMCP/src/index.js
```

Ou dans `.mcp.json` du projet :

```json
{
  "mcpServers": {
    "soundmcp": {
      "command": "node",
      "args": ["D:/Claude/SoundMCP/src/index.js"]
    }
  }
}
```

## Les 3 outils MCP

### `list_styles`

Liste les styles musicaux et les effets sonores avec leurs usages et tempos. **À consulter d'abord** : chaque style a un tempo naturel, une durée par défaut et des cas d'usage recommandés.

### `create_music`

| Paramètre | Type | Défaut | Description |
|---|---|---|---|
| `style` *(requis)* | string | — | Un des 14 styles (voir ci-dessous) |
| `duration_seconds` | nombre (5–600) | selon style | Durée cible, arrondie à des mesures entières |
| `tempo` | nombre (40–220) | selon style | BPM ; laisser le style choisir sinon |
| `key` | string | selon style | Tonalité EN ou FR : `"A minor"`, `"la mineur"`, `"F# dorien"`, `"C majeur"`… |
| `seed` | entier ≥ 0 | aléatoire | Graine déterministe |
| `loop` | booléen | `true` (majorité) | Boucle sans raccord pour fond de jeu |
| `format` | `wav` \| `midi` \| `both` | `wav` | WAV prêt à l'emploi, MIDI éditable dans un DAW, ou les deux |
| `output_dir` | string | `<projet>/output` | Dossier de sortie |
| `title` | string | — | Titre (sert aussi de nom de fichier) |

Retour : résumé musical complet (tonalité, tempo, progression, structure, seed) + chemins des fichiers.

### `create_sfx`

| Paramètre | Type | Défaut | Description |
|---|---|---|---|
| `kind` *(requis)* | string | — | Un des 22 effets (voir ci-dessous) |
| `seed` | entier ≥ 0 | aléatoire | Graine déterministe |
| `volume` | nombre (0.05–1) | `1` | Volume relatif |
| `output_dir` | string | `<projet>/output` | Dossier de sortie |

## Les 14 styles

| Style | Ambiance | Idéal pour |
|---|---|---|
| `ambient` | Nappes aériennes, texture évolutive | Exploration, scènes calmes, fond d'atmosphère |
| `lofi` | Hip-hop apaisé, accords jazzy, swing doux | Villes cozy, menus détendus, streams |
| `chiptune` | Ondes carrées 8-bit rétro | Jeux NES/GB, plateformer rétro |
| `epic` | Cordes amples, cuivres, percussions | Boss, trailer, victoire, bandes-annonces |
| `mystery` | Tension mystérieuse, textures sombres | Enigmes, zones inquiétantes, infiltration |
| `fantasy` | Médiéval-fantastique chaleureux | Villages, tavernes, quêtes |
| `upbeat` | Pop énergique, joyeux | Gameplay dynamique, niveaux rythmés |
| `sad` | Mélancolique, piano/intimos | Scènes d'émotion, pertes, fins tristes |
| `dungeon` | Sombre, réverbérant, drone | Donjons, caves, zones hostiles |
| `menu` | Thème de titre accrocheur | Écran titre, menus, hall principal |
| `suspense` | Pulse obsédant, ostinato nerveux | Poursuites, infiltration, compte à rebours |
| `victory` | Fanfare lumineuse, percussions triomphantes | Boss vaincu, podium, ending |
| `village` | Bourg chaleureux, flûte et luth | Marchés, tavernes, zones sûres |
| `combat` | Bataille nerveuse, riffs carrés | Boss rapides, arènes, duels |

## Les 22 effets sonores

`jump`, `coin`, `pickup`, `hit`, `damage`, `explosion`, `whoosh`, `laser`, `powerup`, `levelup`, `heal`, `click`, `hover`, `error`, `success`, `footstep`, `door`, `splash`, `heartbeat`, `alarm`, `sword`, `bubble`

## Utilisation en ligne de commande

Le même moteur est exposé en CLI, pratique pour tester sans client MCP :

```bash
node src/cli.js list                                   # styles + SFX
node src/cli.js music lofi --dur 24 --seed 7           # musique lo-fi de 24 s
node src/cli.js music epic --seed 42 --midi            # + export MIDI GM
node src/cli.js music fantasy --key "ré mineur"        # tonalité en français
node src/cli.js music upbeat --dur 30 --no-loop        # avec fondu de fin
node src/cli.js sfx coin                               # effet sonore
node src/cli.js sfx explosion --seed 3                 # variante déterministe
```

Options : `--dur`, `--bpm`, `--key`, `--seed`, `--midi`, `--both`, `--loop/--no-loop`, `--out`, `--title`, `--json`.

## Astuces

- **Itérer sur un rendu** : gardez le style/la tonalité et changez uniquement le `seed` jusqu'à obtenir le morceau parfait ; le seed retenu reproduit exactement ce rendu.
- **Boucle de jeu** : `loop: true` (défaut pour la plupart des styles) — la queue de réverbération est repliée au début, le raccord est inaudible. La durée du WAV correspond exactement au nombre de mesures.
- **Fond sonore long** : une boucle de 30–60 s en `loop` suffit pour des heures de jeu, sans fichier volumineux.
- **Piste pour DAW** : `format: "midi"` donne un fichier GM à 5 pistes (nappe, arpège, mélodie, basse, batterie) réarrangeable dans n'importe quel DAW.
- **Cohérence de palette** : même `key` + `tempo` proches à travers les styles = univers sonore homogène.

## Tests

```bash
npm test   # 139 vérifications : en-têtes WAV, bouclage exact, déterminisme, RMS, MIDI, SFX, styles…
```

## Architecture

```
src/
├── index.js      Serveur MCP stdio (JSON-RPC 2.0, newline-délimité)
├── tools.js      Catalogue d'outils partagé (MCP + CLI)
├── cli.js        Interface ligne de commande
├── composer.js   Composition : structure, accords, motifs, bus
├── theory.js     Gammes, accords, degrés, parsing tonalité EN/FR
├── styles.js     Les 14 styles (tempo, pools de tonalités, effets)
├── dsp.js        Synthèse des instruments, réverbération, délai, master, WAV
├── midi.js       Export MIDI GM (5 pistes, PPQ 480)
├── sfx.js        Les 22 effets sonores
└── rng.js        PRNG mulberry32 + hachage déterministe

scripts/smoke.js  Suite de tests (139 vérifications)
output/           Fichiers générés
```

## Licence

MIT
