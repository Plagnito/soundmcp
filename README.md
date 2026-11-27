# SoundMCP 🎵

[English guide](README.en.md)

SoundMCP compose des instrumentaux sans voix et génère des effets sonores et des ambiances pour les jeux et les médias. Le moteur tourne en local avec Node.js.

Les 19 styles combinent motifs mélodiques, progressions d’accords et instruments de synthèse. La palette `studio` intègre 537 prises instrumentales, dont des cordes, cuivres, bois, claviers, guitares et percussions orchestrales. Le mix assemble les pupitres avec égalisation, réverbération stéréo, délai et compression liée. [Crédits et licences de la banque](banks/studio/CREDITS.md)

## Ce que ça produit

| Sortie | Format | Usage |
|---|---|---|
| Musique | WAV 16 ou 24 bits, MIDI multipiste, pupitres WAV 32 bits flottant | Piste finale, boucle de jeu, édition et mixage |
| Effets sonores (SFX) | WAV stéréo 44,1 kHz 16 bits | Saut, pièce, dégât, explosion, arc, marteau de forge… |
| Ambiances | WAV 44,1 kHz 16 bits, boucle parfaite | Pluie, orage, océan, grotte, feu de camp, vaisseau… |

Points clés :

- Conservez la version du moteur, le `seed` et les paramètres pour reproduire le rendu.
- `loop: true` ramène les queues de réverbération et de délai au début du morceau. `loop: false` produit une fin et laisse décroître les effets.
- Les trois outils de rendu proposent `sampling_rate` (22050, 44100 ou 48000) et `mono`.
- Le serveur tourne sans dépendance externe avec `node src/index.js`.

## Installation

Node.js ≥ 18 suffit. Les banques Studio sont incluses et décompressées sans perte par Node.js quand le moteur en a besoin. Le rendu fonctionne en local après l’installation.

[Notes de version](CHANGELOG.md)

Pour afficher SoundMCP en anglais, définissez `SOUNDMCP_LANG=en` dans l’environnement du serveur ou du CLI. Les briefs et tonalités acceptent les deux langues.

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

## Outils MCP

### Du brief au master

1. **`draft_music`** prend une phrase courte en français ou en anglais et rend jusqu’à trois esquisses à volume comparable. Chaque `candidate` fournit un `preview_path` et le `project_path` de la partition complète. Le champ `plan` montre le style, le tempo, la durée, les instruments et la dynamique retenus. `firstToPreview` indique quel fichier écouter en premier d’après les contrôles techniques.
2. **`preview_music`** joue une section ou une plage de mesures. Avec jusqu’à trois `project_paths`, l’outil aligne les niveaux sur la sonie intégrée. `blind: true` mélange l’ordre et fournit une clé dans un fichier séparé.
3. **`analyze_music`** accepte `project_path` ou `wav_path`. Il mesure la sonie intégrée, les crêtes échantillon, le RMS, la corrélation stéréo et la saturation. Pour un projet, `formDynamics` indique l’écart de niveau entre les sections extrêmes. `harmonicOverlaps` localise les secondes et neuvièmes mineures tenues au moins 220 ms entre la mélodie et l’accompagnement, d’après les durées réellement jouées. Les mesures, notes et pupitres permettent de réécouter chaque passage avant une retouche.
4. **`finish_music`** lit le projet retenu. Le rendu par défaut inclut le master 48 kHz/24 bits, le MIDI, les stems et le projet. `cuts: [15,30,60]` crée des éditions WAV à durée exacte qui reprennent le thème et disposent de leur propre cadence. Le MIDI couvre la partition, puis le WAV conserve l’espace prévu pour les queues d’effets.

`inspect_score` donne les accords et les notes avant de reprendre une mesure dans `edit_music`. Passez `project_path`, `start_bar`, `bars` et éventuellement `part`. Les champs `beat` et `duration` suivent la même unité que `write_measure`. Les champs `played` indiquent le placement et la vélocité après phrasé. Lorsque `next_offset` contient un nombre, utilisez-le dans `offset` pour lire les événements suivants.

#### Écouter dans un client MCP

Passe `inline_audio: true` à `draft_music`, `preview_music` ou `compare_music_choices` pour recevoir jusqu’à huit secondes de WAV mono par prise dans les clients qui affichent les résultats audio MCP. Les extraits intégrés sont à sonie alignée et les WAV complets restent accessibles par chemin. Dans une comparaison de montées, l’extrait intégré se concentre sur l’arrivée. Pour mémoriser un choix admissible, passe ensuite la lettre choisie et `comparison_path` à `learn_music_preference`.

Un brief suffit pour démarrer.

```json
{
  "brief": "75 secondes pour une exploration nocturne. Piano feutré, cordes pizzicato, montée progressive, fin calme, sans batterie."
}
```

L’interprétation locale repose sur des intentions et des termes reconnus. Pour une contrainte stricte, passez `duration_seconds`, `tempo`, `meter`, `style`, `key`, `energy`, `instruments` ou `without` explicitement. La composition instrumentale est imposée par le moteur. Une boucle longue peut être arrondie à une mesure complète.

#### Composer une collection

Passez trois à six `briefs` à `draft_music` pour obtenir un morceau par brief. Donnez à chaque morceau son rythme, sa couleur ou son instrumentation. Les paramètres fournis en dehors de `briefs` s’appliquent à toute la collection.

```json
{
  "title": "Traversée",
  "briefs": [
    "Village folk en do majeur, 84 BPM, en 6/8",
    "Forêt nocturne en ré mineur, 66 BPM, sans batterie",
    "Poursuite rock en mi mineur, 148 BPM, énergie intense"
  ],
  "instruments": ["piano"],
  "duration_seconds": 25
}
```

Le manifeste `report_path` relie chaque brief à sa préécoute et à son `project_path`. Pour refaire un morceau, reprenez `shared_options`, ajustez son `brief` et envoyez-le avec son `seed` et `variants: 1`. Cette génération fournit un projet indépendant. Passez à `finish_music` le `project_path` de chaque morceau à livrer.

`draft_music` propose un phrasé chantant pour les briefs généraux et certaines demandes mélodiques. Ce mode conserve le rythme du thème au fil des accords, favorise les intervalles proches et atténue les accompagnements dans les sections mélodiques. Passez `phrasing: "lyrical"` pour le choisir dans `draft_music` ou `create_music`. `phrasing: "style"` sélectionne le phrasé du genre. Le réglage est conservé dans la partition. Pour une esquisse à partir de timbres synthétisés, utilisez `palette: "synth"` et éventuellement `patch_paths` et `patch_roles`.

Le phrasé chantant peut annoncer le thème par un fragment, varier le rythme de sa réponse et prolonger la reprise sur un autre instrument. Dans un arrangement explicite, `theme_treatment` choisit le traitement de la section. `fragment` garde la première cellule, `reprise` ajoute une levée si la fin du motif laisse la place, `augmentation` double les durées de la cellule et `sequence` répète cette cellule une tierce diatonique plus haut. `instruments.mel` choisit l’instrument de la mélodie. Les motifs et leurs traitements sont conservés lors d’une retouche de section.

Pour partir d’une phrase écrite à la main, passe `motif` à `draft_music`. Les esquisses arrangent les accords autour de ses notes d’appui, elles annoncent le motif en introduction et le développent dans la reprise. Choisis `reprise_treatment` pour imposer le type de développement. Le motif s’écrit sur deux mesures, avec quatre unités internes par mesure, y compris en 6/8 ou en 7/8.

#### Harmoniser une mélodie MIDI

Passe un fichier MIDI de ton DAW à `draft_music`. Le thème reprend ses hauteurs absolues, y compris les notes chromatiques, ainsi que les attaques et les durées exprimées dans la mesure. SoundMCP harmonise la mélodie et compose une introduction, une reprise et une cadence selon la forme retenue. L’esquisse reste éditable avec `edit_music` après avoir déplacé le fichier source.

```json
{
  "brief": "30 secondes de jazz nocturne en do mineur, clarinette et contrebasse",
  "midi_motif": { "path": "melodie.mid", "track": 2, "start_bar": 1, "bars": 2 },
  "variants": 2,
  "seed": 94
}
```

L’import lit une seule ligne monophonique de 24 notes au plus, sur une ou deux mesures de même signature, dans un SMF de type 0 ou 1 en ticks par noire. `track` et `channel` sont numérotés à partir de 1. Par défaut, la première piste et le premier canal contenant une ligne non percussive dans la plage sont retenus. L’import reprend le tempo au début du passage, arrondi au BPM, et sa signature si le brief et les paramètres ne les précisent pas. Si tu imposes une autre signature, les positions restent proportionnelles dans la mesure. Les tenues sont bornées par la plage sélectionnée. L’import porte sur les notes, leur vélocité et leur placement. La pédale, les changements de programme et le pitch bend restent propres au MIDI source.

Dans `draft_music`, `instrument_roles` permet de préciser les pupitres de l’esquisse. Par exemple, `{"mel":"cello","pad":"strings","arp":"harp"}` donne le thème au violoncelle, la nappe aux cordes et les arpèges à la harpe. Les autres pupitres suivent les timbres suggérés et le style.

#### Livrer une musique adaptative

Passe `adaptive` à `finish_music` pour produire une introduction, une boucle et une sortie. Garde une mesure ou plus de chaque côté de la région. Cette région peut coexister avec les éditions alignées. Le rendu continu sert à préparer les trois WAV et les fondus de raccord conservent leurs longueurs.

```json
{
  "project_path": "traversee.soundmcp.json",
  "format": "wav",
  "stems": false,
  "adaptive": { "loop_region": { "start_bar": 3, "bars": 8 }, "crossfade_ms": 25 }
}
```

`adaptive.manifest_path` pointe vers un manifeste portable. Déplace le manifeste et les trois WAV ensemble. Les bornes `start_sample` et `end_sample_exclusive` utilisent des trames, communes aux deux canaux en stéréo. La [scène de démonstration Godot](examples/godot-adaptive/) lit le manifeste, enchaîne l’introduction et la boucle, puis joue la sortie à la fin d’un tour sur demande.

### Équilibrer et comparer

- `calibrate_sound` mesure un patch à trois vélocités dans plusieurs registres. Le rapport donne les niveaux, le temps d’attaque et la tenue. Réutilisez son `calibration_path` dans `calibration_paths` avec le même patch et le même pupitre pour appliquer la courbe de gain, dans `draft_music`, `create_music` ou `edit_music`.
- Les esquisses `lyrical` mesurent le niveau des pupitres sur un passage par section, puis appliquent des corrections bornées en prenant la mélodie comme repère lorsqu’elle est présente. `auto_mix: false` désactive cette correction. Dans `edit_music`, `mix` applique le même équilibrage après les retouches. Passe `mix: {}` pour traiter le projet entier ou indique `section` et `strength` pour régler la portée et l’intensité.
- `compare_music_choices` rend deux prises anonymes au même niveau. `criterion: "accompaniment"` compare deux niveaux d’accompagnement. `criterion: "breath"` compare deux durées de notes mélodiques sur les mêmes attaques. Après le choix de l’auditeur, transmettez `comparison_path` et `chosen: "A"` ou `"B"` à `learn_music_preference`. Le profil reste dans un fichier local et s’applique aux prochaines esquisses. `profile_path` choisit un autre profil et `use_preferences: false` permet de composer sans en tenir compte.
- Pour comparer deux montées, appelle `compare_music_choices` avec `criterion: "build"`, un `project_path` et une `section` ou une `arrival_bar`. `progressive` fait entrer progressivement les pupitres d’accompagnement. `break` ménage une respiration juste avant l’arrivée. L’outil livre les deux projets complets et deux WAV anonymes dont le niveau est aligné sur les premières mesures de la reprise quand elles contiennent un signal mesurable. `reveal_path` donne l’ordre des prises.
- Pour appliquer une montée à la création, passe `build_contour: "progressive"` ou `"break"` à `draft_music`. La montée prépare la reprise si elle existe ou la section la plus intense après l’ouverture. Pour choisir le point d’arrivée et doser l’effet dans un projet existant, passe une retouche `{"type":"shape_build","arrival_bar":17,"before_bars":3,"contour":"break","amount":0.8}` à `edit_music`. `flat` retire l’effet sur la plage visée. Les courbes suivent le tempo de la partition et sont appliquées au WAV et aux stems.

Le profil par défaut est `~/.soundmcp/preferences.soundmcp.json`. La variable `SOUNDMCP_PROFILE_PATH` peut lui donner un autre emplacement permanent.

### Faire évoluer les timbres

La catégorie `sounds` de `list_catalog` donne les identifiants des sons et des couleurs de mix. Avec `sounds`, `play_sound` enchaîne jusqu’à douze extraits dans un WAV à sonie comparable, avec un repère par son. Les trois guitares électriques partent de prises enregistrées et proposent un jeu clair, saturé ou à attaque progressive. Les autres sons incluent clavier sur bande, verre frappé, métal frotté, nappe granulaire et grave pulsé. Le pupitre audio `texture` porte les souffles, raclements, impacts et montées inversées.

Pour écouter les prises de harpe de concert, de vibraphone et de violoncelles, appelle `play_sound` avec `{"sounds":["harp","vibraphone","cello"]}`. Ces noms fonctionnent aussi dans les instruments d’une section. Dans `draft_music`, tu peux écrire « harpe, vibraphone et violoncelles pizzicato » ou demander des « violoncelles spiccato ». Pour une note de violoncelle, `articulation: "staccato"` sélectionne les prises de spiccato.

Le piano à queue, la contrebasse, l’ensemble de violons, la flûte, la clarinette, le cor et la guitare acoustique figurent aussi dans le nuancier. Pour écouter la clarinette, la flûte et le violoncelle à la suite, passe `{"sounds":["clarinet","flute","cello"]}` à `play_sound`.

Les percussions orchestrales se règlent avec `orchestral_percussion` dans `draft_music` ou dans chaque section d’un arrangement. `march` privilégie des appuis réguliers. `drive` ajoute des contretemps, des roulements et des accents de gong. `none` coupe le kit de la section. Dans `create_music`, un réglage global sert de valeur par défaut pour les sections où le pupitre `drum` est demandé. Les timbales suivent la note de basse de l’accord, y compris dans les renversements. Le rythme groupe le 7/8 en 2+2+3.

`play_sound` permet d’écouter `trumpet`, `trombone`, `tuba`, `timpani`, `timpani-roll`, `concert-bass-drum`, `concert-snare`, `frame-drum`, `gong`, `cymbal-swell` et `orchestral-cymbals`. Dans `edit_music`, la retouche de type `write_measure` accepte ces sons de percussion sur le pupitre `texture`. Dans une section, `textures` accepte `midi`. La durée de `cymbal-swell` commande le moment où le crescendo atteint son pic.

`draft_music` et `create_music` acceptent `sound_design: "evolving"`, qui fait varier instruments, textures et traitement selon les sections. Dans un brief, « textures évolutives » active ce mode. Pour un contrôle précis, affectez les sons à une section.

```json
{
  "name": "Ouverture filtrée",
  "bars": 4,
  "parts": ["mel", "pad", "bass"],
  "instruments": { "mel": "electric-clean", "pad": "granular-pad", "bass": "sub-pulse" },
  "color": "radio",
  "textures": [
    { "sound": "tape-air", "bar": 1, "duration": 12, "level": 0.30 },
    { "sound": "reverse-swell", "bar": 4, "beat": 1.5, "duration": 2.5, "level": 0.44 }
  ]
}
```

`color` accepte `natural`, `radio`, `warm`, `rough` et `wide`. Les changements sont lissés dans le rendu et sont également appliqués aux stems. Les mesures de texture sont relatives à la section et les temps commencent à zéro. Les textures seules restent dans le WAV et leur stem. Le MIDI conserve les pupitres à hauteurs instrumentales.

### Créer ses propres sons

`design_sound` synthétise un son à partir d’une description ou d’un `patch`. Le retour contient une préécoute WAV, la définition du son et un identifiant `custom-…`. Un patch définit des oscillateurs, les résonances d’un matériau ou un guide d’onde pour des cordes pincées. Les trois méthodes génèrent tout le signal.

```json
{
  "title": "Cloche brisée",
  "note": "D5",
  "patch": {
    "layers": [
      { "wave": "sine", "gain": 0.65, "envelope": { "attack": 0.01, "decay": 0.42, "sustain": 0.16, "release": 0.57 } },
      { "wave": "sine", "ratio": 2.7, "gain": 0.28, "fm": { "ratio": 2.1, "index": 1.35 } },
      { "wave": "pink", "gain": 0.15 }
    ],
    "filter": { "type": "lowpass", "frequency": 2500, "q": 1.2 },
    "lfos": [{ "target": "cutoff", "rate": 0.8, "depth": 0.6 }],
    "effects": { "delay": { "time_ms": 265, "feedback": 0.32, "mix": 0.22 } }
  }
}
```

Les enveloppes s’expriment en secondes et le désaccord en cents. Les modulations utilisent des hertz pour la vitesse, des cents pour la profondeur de `pitch`, des octaves pour `cutoff` et une amplitude relative pour `gain`, `pan` et `pulse`. `pitch_drop` fait décroître un décalage initial de hauteur. On peut ajouter FM, saturation, chorus, délai et réduction de résolution.

Pour utiliser le son dans `draft_music`, `create_music` ou `edit_music`, passez son `patch_path` dans `patch_paths`. Utilisez son `id` dans `patch_roles` pour un pupitre entier, dans `instruments` pour une section ou dans `write_measure.instrument` pour une mesure. Les projets sauvegardés intègrent les réglages. Le MIDI conserve les notes et des programmes instrumentaux de substitution. Les stems WAV conservent le son personnalisé.

### Jouer et comparer les sons personnels

- `play_sound` joue une phrase avec un `instrument` intégré, un `patch` ou un `patch_path`. `at` et `duration` s’expriment en secondes. Des notes au même instant forment un accord. Le WAV est livré avec ses mesures audio.
- `vary_sound` accepte le même patch et les directions `brighter`, `darker`, `shorter` et `longer`. `amount` règle l’intensité de la transformation. Il renvoie le son de départ et jusqu’à quatre nouveaux patches avec leurs préécoutes à sonie comparable.
- `compare_sounds` accepte deux à quatre entrées dans `sounds`, chacune avec `instrument`, `patch` ou `patch_path`. Le jeu et la graine sont communs. Avec `blind: true`, les WAV portent des lettres et la clé est dans un fichier séparé. Les gestes de contact s’appliquent aux sons modaux et aux cordes à guide d’onde.

Les intégrations peuvent encore appeler directement `list_styles`, `list_sounds`, `preview_sounds`, `compare_builds` et `mix_music`. Le catalogue `tools/list` présente leurs fonctionnalités dans `list_catalog`, `play_sound`, `compare_music_choices` et `edit_music`.

Avec MCP `2025-06-18`, `tools/list` expose les schémas de sortie et les annotations sur les effets de chaque outil. Les sessions qui négocient `2024-11-05` ou `2025-03-26` reçoivent aussi le résultat structuré sous forme de JSON dans un bloc texte, après le résumé habituel.

```json
{
  "patch_path": "output/verre-magnetique.soundmcp-patch.json",
  "notes": [
    { "at": 0.08, "pitch": "A4", "duration": 0.65, "velocity": 0.74, "gesture": { "position": 0.23 } },
    { "at": 0.73, "pitch": "C5", "duration": 0.5, "articulation": "slide", "gesture": { "glide_ms": 85 } }
  ],
  "tail_seconds": 1.5
}
```

### Synthétiser un matériau et le jouer

Un patch modal décrit jusqu’à douze résonances. `ratio` est la fréquence relative à la note. `decay_seconds` est le temps d’atténuation de 60 dB sans amortissement supplémentaire. `position_node` définit la sensibilité de chaque résonance au point de contact. Des rapports non entiers conviennent au verre ou au métal. Le bruit de contact est généré par `contact`.

```json
{
  "title": "Verre pincé",
  "note": "A4",
  "velocity": 0.68,
  "gesture": { "position": 0.23, "hardness": 0.72, "damping": 0.06 },
  "patch": {
    "modal": {
      "modes": [
        { "ratio": 1, "gain": 0.88, "decay_seconds": 2.6, "position_node": 1 },
        { "ratio": 2.31, "gain": 0.38, "decay_seconds": 1.3, "position_node": 2 },
        { "ratio": 4.91, "gain": 0.23, "decay_seconds": 0.54, "position_node": 3 }
      ],
      "contact": 0.16
    }
  }
}
```

Dans `write_measure`, attribuez `gesture` aux notes d’un instrument modal. `position` et `hardness` modifient l’impact, `damping` étouffe la vibration, et `expression` règle son intensité au début et à la fin de la note. Sur une note monodique voisine du même instrument, `slide` et `legato` prolongent la vibration en cours. `gesture.glide_ms` fixe le temps de glissé jusqu’à 6 000 ms, dans la limite de la tenue. Les accords et les notes isolées déclenchent des résonances indépendantes.

Pour faire grincer une surface ou tenir une nappe rugueuse, ajoutez `"friction": {"amount": 0.8, "roughness": 0.55, "motion_hz": 2.4, "attack_seconds": 0.12}` dans `patch.modal` ou utilisez le brief « métal frotté ». La source continue d’exciter les résonances pendant la note. `roughness` équilibre la vibration tonale et le grain, et `motion_hz` règle la vitesse des variations du contact. `expression` fait évoluer la pression pendant la tenue. Au relâchement, le frottement s’arrête et les modes résonnent selon leur décroissance.

`draft_music`, `create_music` et `edit_music` acceptent par exemple `"performance": {"amount": 0.8, "parts": ["mel", "bass"]}` pour varier les appuis, le rythme et les fins de phrases. Avec `"room": {"amount": 0.6, "distance": {"mel": 0.14, "pad": 0.82}}`, les deux pupitres partagent une pièce tandis que la nappe recule. Ces réglages sont stockés avec le projet et `null` les retire lors d’une retouche. Pour comparer jusqu’à trois versions complètes de 45 secondes ou moins au même niveau, utilisez `preview_music` avec `full: true` et `blind: true`.

### Créer une corde pincée

Dans `design_sound`, utilisez un brief comme « corde pincée douce en nylon » ou définissez `patch.waveguide`. Le guide d’onde simule la vibration après le pincement. `brightness` règle la perte d’aigus, `stiffness` la dispersion des harmoniques et `decay_seconds` la décroissance visée de la corde libre. `body` ajoute une résonance de caisse dont la fréquence est en hertz. `release_damping` détermine l’amortissement après relâchement de la note.

```json
{
  "title": "Corde pincée",
  "note": "A3",
  "patch": {
    "waveguide": {
      "brightness": 0.63,
      "decay_seconds": 3.4,
      "stiffness": 0.26,
      "contact": 0.16,
      "release_damping": 0.24,
      "body": { "frequency": 184, "resonance": 2.2, "mix": 0.34 }
    }
  },
  "gesture": { "position": 0.22, "hardness": 0.75, "damping": 0.04 }
}
```

Dans `play_sound` et `write_measure`, utilisez `gesture.position` autour de 0.5 pour pincer vers le milieu, ou rapprochez-le d’une extrémité pour modifier les harmoniques. `gesture.hardness` agit sur l’attaque et `gesture.damping` étouffe la corde. `slide` ou `legato` conserve la vibration en cours quand la note rejoint une voix monodique compatible.

Après la sélection, transmettez le `project_path` et les options de livraison.

```json
{
  "project_path": "output/esquisse-2.soundmcp.json",
  "editions": ["loop", "calm", "intense", "transition"],
  "loop_region": { "start_bar": 5, "bars": 8 },
  "cuts": [15, 30, 60]
}
```

`transition` commence sur l’équilibre calme et monte vers l’intense sur les deux dernières mesures. Le manifeste commun indique sa montée en échantillons et l’alignement des quatre fichiers. Dans un moteur de jeu, enchaînez la transition une fois et raccordez-la à la boucle intense au même point de la grille.

### `list_catalog`

Cherche les styles avec `category: "music"`, les effets avec `"sfx"`, les boucles d’ambiance avec `"ambiences"` ou les timbres avec `"sounds"`.

### `manage_outputs`

Les nouvelles générations retournent `managed_outputs` avec le dossier et les identifiants de leurs fichiers. Utilise `action: "list"` et le même `output_dir` pour retrouver les fichiers actifs ou archivés, avec `offset` et `limit` pour parcourir les résultats.

Avec `action: "list"`, `file_type: "project"` et `state: "active"`, l’inventaire retourne les projets musicaux prêts à rouvrir. Passe leur `path` comme `project_path` à `preview_music`, `inspect_score` ou `edit_music`. Après une retouche, `versions[].project_path` permet d’enchaîner directement sur la préécoute ou le master.

`action: "archive"` déplace un `file_id` vers l’archive locale du dossier de sortie. `action: "restore"` remet le fichier à sa place si le chemin est disponible. Le rangement est réversible et les générations enregistrées par cette version apparaissent dans l’inventaire.

### Reprendre un effet ou une ambiance

Réutilise `create_sfx` ou `create_ambience` avec le `file_id` du WAV dans `source_file_id` et son dossier dans `source_output_dir`. Indique les seuls réglages à modifier, par exemple `duration_seconds: 20` et `volume: 0.7` pour une boucle de pluie. Les autres réglages, dont la graine, sont repris du rendu enregistré. Chaque variante est écrite dans un nouveau sous-dossier et renvoie ses réglages dans `render_settings`. Cette reprise s’applique aux effets et ambiances générés avec une version qui enregistre ces réglages.

Pour créer une famille d’effets, ajoute `variants` à `create_sfx`. Pars d’un `kind` ou de l’identifiant d’un effet déjà rendu. Un appel comme celui-ci produit six WAV numérotés.

```json
{
  "kind": "footstep",
  "seed": 44,
  "attack_ms": 16,
  "variants": { "count": 6, "pitch_spread": 0.7, "attack_spread_ms": 8 }
}
```

Chaque entrée de `variants` renvoie la graine et les réglages de sa prise. Retrouve son `file_id` dans `managed_outputs.files` à partir de son chemin WAV pour la reproduire ou la retoucher séparément. `pitch_semitones` règle la hauteur centrale. `attack_ms` ajoute un fondu d’attaque. Les écarts de la famille restent bornés par `pitch_spread` et `attack_spread_ms`.

### `create_music`

| Paramètre | Type | Défaut | Description |
|---|---|---|---|
| `style` *(requis)* | string | — | Un des 19 styles (voir ci-dessous) |
| `duration_seconds` | nombre (5–600) | selon style | Durée musicale cible, arrondie à la mesure la plus proche. Les sections explicites fixent la durée lorsqu’elles sont fournies. |
| `tempo` | nombre (40–220) | selon style | BPM ; laisser le style choisir sinon |
| `key` | string | selon style | Tonalité EN ou FR : `"A minor"`, `"la mineur"`, `"F# dorien"`, `"C majeur"`… |
| `seed` | entier de 0 à 4294967295 | aléatoire | Graine déterministe |
| `loop` | booléen | selon le style, `false` avec `editions` | Active le bouclage du master |
| `format` | `wav` \| `midi` \| `both` | `wav` | WAV prêt à l'emploi, MIDI éditable dans un DAW, ou les deux |
| `sampling_rate` | 22050 \| 44100 \| 48000 | `44100` | Fréquence d'échantillonnage du WAV (22050 = taille moitié) |
| `bit_depth` | 16 \| 24 | `16` | Profondeur du master WAV |
| `stems` | booléen | `false` | Pupitres séparés en WAV 32 bits flottant avec les effets, avant mastering. Requiert `wav` ou `both`. |
| `palette` | `studio` \| `synth` | `studio` | Prises instrumentales pour les instruments disponibles, ou synthèse pour tous les instruments. |
| `arrangement` | objet | automatique | Sections, progression, pupitres et motif mélodique |
| `save_project` | booléen | `false` | Enregistre la partition, les nuances et les prises utilisées pour une retouche ultérieure. |
| `editions` | liste de `loop`, `calm`, `intense`, `transition` | — | Éditions alignées dérivées de la même partition. |
| `loop_region` | objet | première section mélodique exploitable | `start_bar` (à partir de 1) et `bars` fixent la plage commune des éditions. |
| `mono` | booléen | `false` | WAV 1 canal (taille encore moitié, utile en streaming web) |
| `output_dir` | string | `<projet>/output` | Dossier de sortie |
| `title` | string | — | Titre (sert aussi de nom de fichier) |

La réponse liste les fichiers, les accords par mesure et les sections. Pour le WAV, elle donne aussi la durée du fichier, la crête et le RMS en dBFS, la dynamique crête/RMS et la corrélation stéréo. Un morceau avec fin ajoute une queue d’effets à la durée musicale.

Pour une piste terminée, choisissez `loop: false`, `sampling_rate: 48000` et `bit_depth: 24`. `format: "both"` ajoute un MIDI avec un programme instrumental par piste, des marqueurs de sections et un canal dédié à la percussion. Les pupitres WAV partent tous du même instant et s’additionnent à gain unitaire pour retrouver le signal avant mastering.

#### Composer avec un arrangement explicite

Chaque section fixe un nombre de mesures et peut préciser une progression, un thème (`A`, `B` ou `C`), une énergie de `0.25` à `1` et les pupitres actifs du style. `pad` correspond aux accords tenus, `arp` à l’accompagnement, `bass` à la basse, `drum` à la batterie, `mel` à la mélodie et `counter` à la contre-mélodie. Les champs `key`, `tempo` et `meter` peuvent varier par section. `meter: [6,8]` désigne six croches et le tempo reste exprimé en noires par minute. Le rendu WAV et le MIDI suivent la même grille. Pour un thème généré, `variation` démarre sur l’une des quatre variantes de rythme et de contour (0 à 3).

Une entrée de `progression` représente une mesure. `1` désigne la tonique de la section. Un symbole comme `Dm9`, `G13`, `Cmaj7/E`, `A7b9` ou `Gm7b5` fixe l’accord indépendamment de la gamme. Une liste comme `[{"beat":0,"chord":"Dm9"},{"beat":2,"chord":"G13"}]` joue les deux accords dans la même mesure. Le premier changement commence au temps 0. La progression se répète jusqu’à la fin de la section.

Un `motif` est une suite de notes sur huit temps. `beat` compte à partir de zéro, `duration` s’exprime en temps et `degree: 8` désigne la tonique une octave plus haut. Chaque section peut définir un motif qui remplace le motif commun. La guitare gère `mute` et `slide`, les vents `legato` et `swell`, et `staccato` raccourcit les notes. Les styles ajoutent aussi des articulations adaptées au jeu, dont les notes fantômes dans le jazz.

Avec la palette `studio`, indiquez `legato` sur la note d’arrivée pour lier deux notes de hauteur différente qui se suivent dans une même voix de clarinette, de flûte ou de violoncelle. Les notes répétées, les accords et les respirations gardent leur articulation.

```json
{
  "sections": [
    { "name": "Introduction", "bars": 2, "progression": [1, 4], "parts": ["pad", "arp"], "energy": 0.55 },
    { "name": "Thème", "bars": 4, "progression": [1, 4, 5, 1], "theme": "A" },
    { "name": "Finale", "bars": 2, "progression": [5, 1], "parts": ["pad", "mel"], "energy": 0.65,
      "motif": [{ "beat": 0, "degree": 5, "duration": 2 }, { "beat": 4, "degree": 1, "duration": 3 }] }
  ]
}
```

Passez cet objet sous `arrangement` via MCP ou enregistrez-le dans `arrangement.json` pour le CLI.

### `edit_music`

Fournissez `project_path` depuis le résultat de `create_music` avec `save_project: true`. Chaque retouche cible le nom unique ou le numéro d’une section. `gain` prend un pupitre (`part`) et un `db` de −60 à +12. `mute` coupe un pupitre de la section. `replace_section` régénère une section de la même longueur, sur les accords existants ou avec une nouvelle progression. Les autres événements gardent leurs notes, leur placement, leur articulation et leur prise. Le mastering est recalculé pour le nouveau mix.

```json
{
  "project_path": "output/bleu-de-minuit.soundmcp.json",
  "edits": [{ "type": "gain", "section": "Pont", "part": "drum", "db": -6 }],
  "ending_variants": 3,
  "format": "both"
}
```

Avec `ending_variants`, SoundMCP rend un fichier et un projet par fin. Le fichier projet source peut être rouvert pour une nouvelle retouche. Les éditions `loop`, `calm` et `intense` partagent la grille, les accords et la longueur de leur région. Le fichier `-editions.json` donne les mesures source, le tempo et le nombre d’échantillons pour synchroniser les transitions.

Pour écrire une mesure, utilisez `write_measure` avec un numéro de mesure absolu à partir de 1. La liste remplace les événements du pupitre dans la mesure. Une liste vide le met en silence. Les autres mesures gardent leurs événements. `beat` compte à partir de zéro dans l’unité du dénominateur, donc `beat: 3` désigne la quatrième croche en 6/8.

```json
{
  "type": "write_measure",
  "bar": 9,
  "part": "counter",
  "instrument": "clarinet",
  "notes": [{ "beat": 3, "pitch": "Bb4", "duration": 1.5, "articulation": "legato", "expression": [0.55, 1.1] }]
}
```

`pitches` accepte un accord, `degree` place une note dans la gamme de la section et `hit` indique une percussion. Les articulations détaillées et les courbes d’expression sont conservées dans le projet et appliquées au rendu audio des instruments concernés.

`write_measure` accepte aussi `pan` (−1 à 1) et `timbre` (0 à 1). `timbre` agit sur la brillance, le grain ou la saturation selon l’instrument. Pour les événements du pupitre `texture`, la hauteur est facultative.

### `create_sfx`

| Paramètre | Type | Défaut | Description |
|---|---|---|---|
| `kind` ou `source_file_id` | string | — | Identifiant du catalogue ou d’un effet déjà rendu |
| `seed` | entier ≥ 0 | aléatoire | Graine déterministe |
| `volume` | nombre (0.05–1) | `1` | Volume relatif |
| `sampling_rate` | 22050 \| 44100 \| 48000 | `44100` | Fréquence d'échantillonnage du WAV |
| `mono` | booléen | `false` | WAV 1 canal (taille moitié) |
| `output_dir` | string | `<projet>/output` | Dossier de sortie |
| `pitch_semitones` | nombre (−6 à 6) | `0` | Décalage de la hauteur lors d’une création |
| `attack_ms` | nombre (0 à 100) | `0` | Fondu d’attaque ajouté lors d’une création |
| `variants` | objet | — | Famille de 2 à 12 prises avec `count`, `pitch_spread` et `attack_spread_ms` |

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
node src/cli.js music epic --seed 42 --both --no-loop --sr 48000 --bits 24 --stems
node src/cli.js music village --key "G mixolydian" --arrangement arrangement.json --both
node src/cli.js music jazz --palette studio --project --editions loop,calm,intense --sr 48000 --bits 24
node src/cli.js draft "75 secondes, exploration nocturne, piano et cordes, fin calme" --seed 42
node src/cli.js draft "44 secondes, ambiance sombre, textures évolutives" --seed 42
node src/cli.js sounds
node src/cli.js sound-preview electric-clean,electric-drive,granular-pad,bowed-metal,reverse-swell
node src/cli.js design-sound "verre métallique qui gonfle, avec du grain et un écho" --note D5 --seed 42
node src/cli.js design-sound --definition cloche-brisee.soundmcp-patch.json --note F5
node src/cli.js preview esquisse-1.soundmcp.json esquisse-2.soundmcp.json --section Thème --blind
node src/cli.js finish esquisse-2.soundmcp.json --cuts 15,30,60 --editions loop,calm,intense,transition
node src/cli.js analyze esquisse-2.soundmcp.json
node src/cli.js edit output/bleu-de-minuit.soundmcp.json --edits retouches.json --ending-variants 3 --both
node src/cli.js music fantasy --key "ré mineur"        # tonalité en français
node src/cli.js music upbeat --dur 30 --no-loop        # avec fondu de fin
node src/cli.js music ambient --sr 22050 --mono        # léger (taille ÷4)
node src/cli.js sfx coin                               # effet sonore
node src/cli.js sfx explosion --seed 3                 # variante déterministe
node src/cli.js ambience ocean --dur 60 --seed 11      # boucle parfaite de 60 s
node src/cli.js ambience cave --dur 12 --sr 22050 --mono
```

L’aide `node src/cli.js help` donne la liste des options.

## Astuces

- Pour explorer des variations, gardez le style et la tonalité, puis changez le `seed`. Conservez le `seed` du rendu retenu.
- **Boucle de jeu** : `loop: true` (défaut pour la plupart des styles) — la queue de réverbération est repliée au début, le raccord est inaudible. La durée du WAV correspond exactement au nombre de mesures.
- **Ambiance en continu** : `create_ambience` sort toujours une boucle parfaite (crossfade intégré). Pour un fond d'environnement de longue durée, une boucle de 60–120 s suffit et les événements restent peu répétitifs.
- **Fichiers légers** : `sampling_rate: 22050` divise la taille par 2, `mono: true` encore par 2 (vrai WAV 1 canal) — combinés, un fond sonore de 60 s passe de ~10 Mo à ~2,6 Mo.
- **Fond sonore long** : une boucle de 30–60 s en `loop` suffit pour des heures de jeu, sans fichier volumineux.
- Pour retravailler l’interprétation dans un DAW, ouvrez le MIDI. Pour retravailler le mix de SoundMCP, ouvrez les pupitres WAV.
- **Cohérence de palette** : même `key` + `tempo` proches à travers les styles = univers sonore homogène.

## Tests

```bash
npm test
```

### Banc d’écoute

Depuis le dépôt, lance `npm run bench` pour calculer les dix briefs fixes de `scripts/listening-cases.json`. Le dossier imprimé contient `manifest.json`, les WAV d’écoute, les projets et les mesures. Garde ensemble `manifest.json` et le dossier `audio` pour rendre la référence portable.

```sh
npm run bench -- --output output/banc-ecoute --against chemin/vers/manifest.json
```

Avec `--against`, les prises sont alignées en sonie et présentées sous les lettres A et B dans `ab.json` et `ab/`. Écoute en te concentrant sur le critère indiqué par cas, puis ouvre `reveal.json` pour révéler l’ancienne et la nouvelle version. Les mesures et avertissements restent dans le manifeste.

## Architecture

```
src/
├── index.js      Serveur MCP stdio (JSON-RPC 2.0, newline-délimité)
├── tools.js      Catalogue d'outils partagé (MCP + CLI)
├── cli.js        Interface ligne de commande
├── arrangement.js Sections et validation des motifs
├── composer.js   Composition : structure, accords, motifs, bus
├── theory.js     Gammes, accords, degrés, parsing tonalité EN/FR
├── styles.js     Les 19 styles (tempo, pools de tonalités, effets)
├── dsp.js        Synthèse des instruments, réverbération, délai, master, WAV
├── instrument-voices.js Modèles de cordes et d’instruments à vent
├── midi.js       Export MIDI GM multipiste (PPQ 480)
├── ambience.js   Moteur d'ambiances (couches + événements + crossfade circulaire)
├── sfx.js        Les 32 effets sonores
└── rng.js        PRNG mulberry32 + hachage déterministe

scripts/smoke.js  Suite de tests (~660 vérifications)
scripts/quality.js Arrangement, raccords musicaux, MIDI instrumental et exports de production
scripts/studio.js Prises, articulations, accords, retouches et alignement des éditions
scripts/workflow.js Brief, partition à tempo variable, préécoute, analyse et livraison
scripts/sound-design.js Guitares, textures, timbres par section et nuancier
scripts/custom-synth.js Synthèse et fichier de son personnel, import et réutilisation
output/           Fichiers générés
```

La banque Studio est incluse dans `banks/studio`. `python scripts/build-studio-bank.py` reconstruit la banque de base. `python scripts/build-studio-bank.py --extension` reconstruit les 150 prises de harpe, de vibraphone et de violoncelles. `python scripts/build-cinematic-bank.py` reconstruit les 98 prises de cuivres et de percussions orchestrales. Ces opérations requièrent FFmpeg et un accès à GitHub lorsque les sources sont absentes du cache. Exécutez `node scripts/pack-studio-banks.js` depuis le dépôt après la reconstruction des trois banques pour produire les fichiers compressés et vérifier leur décodage bit pour bit.

La mesure de sonie intégrée applique la pondération K et les portes de niveau de la recommandation BS.1770. Les coefficients à fréquence variable sont documentés dans libebur128. [UIT-R BS.1770](https://www.itu.int/rec/R-REC-BS.1770) · [libebur128](https://github.com/jiixyj/libebur128/blob/master/ebur128/ebur128.c)

## Licence

MIT
