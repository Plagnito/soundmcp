# SoundMCP 🎵

**Serveur MCP de composition musicale pour IA** — créez de la jolie musique, des effets sonores et des ambiances pour vos jeux vidéo, sans aucune dépendance.

Le tout est généré mathématiquement en Node.js pur : théorie musicale (gammes, progressions d'accords, voice-leading, motifs) + DSP maison (réverbération type freeverb, délai ping-pong, écrêtage doux, normalisation). Aucune bibliothèque externe, aucun binaire, aucun appel réseau.

## Ce que ça produit

| Sortie | Format | Usage |
|---|---|---|
| Musique | WAV stéréo 44,1 kHz 16 bits (+ MIDI GM en option) | Fond sonore de jeu, ambiance, menu |
| Effets sonores (SFX) | WAV stéréo 44,1 kHz 16 bits | Saut, pièce, dégât, explosion, arc, marteau de forge… |
| Ambiances | WAV 44,1 kHz 16 bits, boucle parfaite | Pluie, orage, océan, grotte, feu de camp, vaisseau… |

Points clés :

- **Déterministe** : même `seed` + mêmes paramètres = exactement le même son. Idéal pour itérer (« essaie le seed 42 ») et reproduire un rendu validé.
- **Boucles sans raccord** : avec `loop: true`, la queue de réverbération/délai est repliée au début du morceau — le raccord est inaudible, parfait en fond de jeu continu. Les ambiances sont **toujours** bouclées parfaitement (crossfade circulaire intégré).
- **Options techniques** : `sampling_rate` (22050 / 44100 / 48000) et `mono` (vrai WAV 1 canal, taille moitié) sur les trois outils de rendu.
- **Zéro dépendance** : `npm install` inutile. Un seul fichier de serveur, `node src/index.js`.
- **19 styles musicaux**, **32 effets sonores** et **11 ambiances** prêts à l'emploi.

## Installation

Aucune dépendance. Node.js ≥ 18 suffit.

Via npm (recommandé) :

```bash
npm install -g @plagnito/soundmcp
```

Ou directement via `npx -y @plagnito/soundmcp` (télécharge et lance à la volée). Depuis les sources :

```bash
git clone https://github.com/Plagnito/soundmcp.git
node soundmcp/src/index.js   # démarre le serveur MCP sur stdio
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
        "command": ["npx", "-y", "@plagnito/soundmcp"]
      }
    }
  }
}
```

Ou en une commande : `opencode mcp add soundmcp -- npx -y @plagnito/soundmcp`

Avec les sources en local, utilise plutôt `"command": ["node", "D:/chemin/soundmcp/src/index.js"]` ; avec `npm install -g @plagnito/soundmcp`, `"command": "soundmcp"` fonctionne aussi.

## Brancher dans Claude Code

```bash
claude mcp add soundmcp -- npx -y @plagnito/soundmcp
```

Ou dans `.mcp.json` du projet :

```json
{
  "mcpServers": {
    "soundmcp": {
      "command": "npx",
      "args": ["-y", "@plagnito/soundmcp"]
    }
  }
}
```

## Les 4 outils MCP

### `list_styles`

Liste les styles musicaux, les ambiances et les effets sonores avec leurs usages et tempos. **À consulter d'abord** : chaque style a un tempo naturel, une durée par défaut et des cas d'usage recommandés.

### `create_music`

| Paramètre | Type | Défaut | Description |
|---|---|---|---|
| `style` *(requis)* | string | — | Un des 19 styles (voir ci-dessous) |
| `duration_seconds` | nombre (5–600) | selon style | Durée cible, arrondie à des mesures entières |
| `tempo` | nombre (40–220) | selon style | BPM ; laisser le style choisir sinon |
| `key` | string | selon style | Tonalité EN ou FR : `"A minor"`, `"la mineur"`, `"F# dorien"`, `"C majeur"`… |
| `seed` | entier ≥ 0 | aléatoire | Graine déterministe |
| `loop` | booléen | `true` (majorité) | Boucle sans raccord pour fond de jeu |
| `format` | `wav` \| `midi` \| `both` | `wav` | WAV prêt à l'emploi, MIDI éditable dans un DAW, ou les deux |
| `sampling_rate` | 22050 \| 44100 \| 48000 | `44100` | Fréquence d'échantillonnage du WAV (22050 = taille moitié) |
| `mono` | booléen | `false` | WAV 1 canal (taille encore moitié, utile en streaming web) |
| `output_dir` | string | `<projet>/output` | Dossier de sortie |
| `title` | string | — | Titre (sert aussi de nom de fichier) |

Retour : résumé musical complet (tonalité, tempo, progression, structure, seed) + chemins des fichiers.

### `create_sfx`

| Paramètre | Type | Défaut | Description |
|---|---|---|---|
| `kind` *(requis)* | string | — | Un des 32 effets (voir ci-dessous) |
| `seed` | entier ≥ 0 | aléatoire | Graine déterministe |
| `volume` | nombre (0.05–1) | `1` | Volume relatif |
| `sampling_rate` | 22050 \| 44100 \| 48000 | `44100` | Fréquence d'échantillonnage du WAV |
| `mono` | booléen | `false` | WAV 1 canal (taille moitié) |
| `output_dir` | string | `<projet>/output` | Dossier de sortie |

### `create_ambience`

Génère une **ambiance d'environnement en boucle parfaite** : les derniers instants fondent dans les premiers (crossfade circulaire intégré au fichier), le fond sonore tourne en continu sans aucun raccord audible. La sortie est toujours un WAV bouclé — `loop` n'est pas un paramètre.

| Paramètre | Type | Défaut | Description |
|---|---|---|---|
| `kind` *(requis)* | string | — | Une des 11 ambiances (voir ci-dessous) |
| `duration_seconds` | nombre (5–600) | `60` | Durée de la boucle ; plus longue = événements moins répétitifs |
| `seed` | entier ≥ 0 | aléatoire | Graine déterministe |
| `volume` | nombre (0.05–1) | `1` | Volume relatif |
| `sampling_rate` | 22050 \| 44100 \| 48000 | `44100` | Fréquence d'échantillonnage du WAV |
| `mono` | booléen | `false` | WAV 1 canal (taille moitié) |
| `output_dir` | string | `<projet>/output` | Dossier de sortie |

## Les 19 styles

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
| `rock` | Guitares saturées en power chords, riff mémorable | Boss classiques, courses, entraînement |
| `jazz` | Quartet jazzy : accords 7e/9e, walking bass | Bar chic, casino, interrogation |
| `horror` | Nappes sombres, cloches fantomatiques, bourdon grave | Peur, vide, chose qui vient |
| `hiphop` | Boom-bap assuré : kick qui claque, basse ronde | Victoires urbaines, menus feutrés |
| `space` | Nappes lydiennes cristallines, carillons flottants | Cosmos, menus majestueux |

## Les 32 effets sonores

`jump`, `coin`, `pickup`, `hit`, `damage`, `explosion`, `whoosh`, `laser`, `powerup`, `levelup`, `heal`, `click`, `hover`, `error`, `success`, `footstep`, `door`, `splash`, `heartbeat`, `alarm`, `sword`, `bubble`, `magic`, `teleport`, `bowShoot`, `gunShoot`, `thunder`, `questComplete`, `menuOpen`, `chestOpen`, `ghost`, `forge`

## Les 11 ambiances

| Ambiance | Contenu |
|---|---|
| `rain` | Pluie fine sur un feuillage : souffle grave doux, sizzle des gouttes, pluches éparses |
| `storm` | Orage : pluie dense, vent qui se lève, coups de tonnerre espacés |
| `wind` | Vent : souffle ample qui va et vient, sifflement léger sur les crêtes |
| `forest` | Forêt de jour : brise dans les feuilles, oiseaux épars |
| `campfire` | Feu de camp : ronron chaud, crépitements vifs, petits éclats occasionnels |
| `ocean` | Océan : longues vagues qui montent et retombent, écume sur le sable |
| `river` | Rivière : clapotis continu de l'eau qui court, remous et petites vagues |
| `cave` | Grotte : gravité sourde, gouttes d'eau qui résonnent avec leur écho |
| `spaceship` | Vaisseau : hum grave des moteurs, souffle de ventilation, bips rares |
| `cafe` | Café : brouhaha de conversations, tintements de tasses, mouvement feutré |
| `night` | Nuit calme : très bas, grillons stridulants, chouette au loin, brise légère |

## Utilisation en ligne de commande

Le même moteur est exposé en CLI, pratique pour tester sans client MCP :

```bash
node src/cli.js list                                   # styles + SFX + ambiances
node src/cli.js music lofi --dur 24 --seed 7           # musique lo-fi de 24 s
node src/cli.js music epic --seed 42 --midi            # + export MIDI GM
node src/cli.js music fantasy --key "ré mineur"        # tonalité en français
node src/cli.js music upbeat --dur 30 --no-loop        # avec fondu de fin
node src/cli.js music ambient --sr 22050 --mono        # léger (taille ÷4)
node src/cli.js sfx coin                               # effet sonore
node src/cli.js sfx explosion --seed 3                 # variante déterministe
node src/cli.js ambience ocean --dur 60 --seed 11      # boucle parfaite de 60 s
node src/cli.js ambience cave --dur 12 --sr 22050 --mono
```

Options : `--dur`, `--bpm`, `--key`, `--seed`, `--midi`, `--both`, `--loop/--no-loop`, `--sr`, `--mono`, `--out`, `--title`, `--json`.

## Astuces

- **Itérer sur un rendu** : gardez le style/la tonalité et changez uniquement le `seed` jusqu'à obtenir le morceau parfait ; le seed retenu reproduit exactement ce rendu.
- **Boucle de jeu** : `loop: true` (défaut pour la plupart des styles) — la queue de réverbération est repliée au début, le raccord est inaudible. La durée du WAV correspond exactement au nombre de mesures.
- **Ambiance en continu** : `create_ambience` sort toujours une boucle parfaite (crossfade intégré). Pour un fond d'environnement de longue durée, une boucle de 60–120 s suffit et les événements restent peu répétitifs.
- **Fichiers légers** : `sampling_rate: 22050` divise la taille par 2, `mono: true` encore par 2 (vrai WAV 1 canal) — combinés, un fond sonore de 60 s passe de ~10 Mo à ~2,6 Mo.
- **Fond sonore long** : une boucle de 30–60 s en `loop` suffit pour des heures de jeu, sans fichier volumineux.
- **Piste pour DAW** : `format: "midi"` donne un fichier GM à 5 pistes (nappe, arpège, mélodie, basse, batterie) réarrangeable dans n'importe quel DAW.
- **Cohérence de palette** : même `key` + `tempo` proches à travers les styles = univers sonore homogène.

## Tests

```bash
npm test   # ~660 vérifications : en-têtes WAV (stéréo et mono), bouclage exact, couture des ambiances, déterminisme, RMS, MIDI, 32 SFX, 19 styles, 11 ambiances…
```

## Architecture

```
src/
├── index.js      Serveur MCP stdio (JSON-RPC 2.0, newline-délimité)
├── tools.js      Catalogue d'outils partagé (MCP + CLI)
├── cli.js        Interface ligne de commande
├── composer.js   Composition : structure, accords, motifs, bus
├── theory.js     Gammes, accords, degrés, parsing tonalité EN/FR
├── styles.js     Les 19 styles (tempo, pools de tonalités, effets)
├── dsp.js        Synthèse des instruments, réverbération, délai, master, WAV
├── midi.js       Export MIDI GM (5 pistes, PPQ 480)
├── ambience.js   Moteur d'ambiances (couches + événements + crossfade circulaire)
├── sfx.js        Les 32 effets sonores
└── rng.js        PRNG mulberry32 + hachage déterministe

scripts/smoke.js  Suite de tests (~660 vérifications)
output/           Fichiers générés
```

## Licence

MIT
