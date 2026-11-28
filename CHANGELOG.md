# SoundMCP 2.5.0

- Huit profils MCP permettent d’adapter le catalogue à la musique, aux sons ou aux deux. Le profil par défaut conserve les 18 outils et leurs définitions évaluées. Choisissez un autre profil avec `SOUNDMCP_TOOLSET` et redémarrez le serveur.
- Chaque livraison reçoit un `render_id`. Dans les profils avancés, `manage_outputs` retrouve un fichier ou une livraison et peut archiver ou restaurer l’ensemble en conservant les liens entre le manifeste et les WAV.
- Les clients MCP compatibles peuvent ouvrir les fichiers via les liens de ressources et lancer les parcours guidés pour comparer des timbres à l’aveugle ou livrer une boucle adaptative.
- Les rendus de musique, d’effets et d’ambiances peuvent créer une sortie distincte ou reprendre un rendu identique avec `on_conflict`. L’inventaire indique la source et les chemins actuels.
- Le paquet inclut les guides de production et la provenance des banques Studio. Les contrôles vérifient l’installation npm hors ligne, les schémas MCP et l’image Docker.

[Guide français](https://github.com/Plagnito/soundmcp/blob/v2.5.0/docs/workflows.md) · [English guide](https://github.com/Plagnito/soundmcp/blob/v2.5.0/docs/workflows.en.md) · [Rapport TDQS du profil par défaut](https://tdqs.dev/reports/e9g7q2s5tc)

---

# SoundMCP 2.4.1

- Le catalogue associe chaque identifiant à son paramètre de rendu. Les descriptions MCP en français et en anglais précisent le choix du moteur de synthèse et la création de variantes.
- L’étalonnage renvoie la graine utilisée pour reproduire les mesures. Ses conseils suivent la langue configurée.
- La préécoute vérifie tous les passages avant de lancer le rendu et indique quel projet est en erreur. Les schémas précisent les résultats de préécoute, de lecture de partition et de livraison adaptative.
- Répéter le même choix A/B laisse le profil de préférences intact. L’archivage et la restauration indiquent le chemin d’origine et, le cas échéant, le chemin du fichier archivé.

---

# SoundMCP 2.4.0

- `compare_music_choices` classe les points de reprise d’un projet et livre des comparaisons à sonie alignée sur deux tours de boucle. La prise choisie se transmet à `finish_music`.
- `draft_music` peut développer un extrait en reprenant sa mélodie, ses timbres et ses accords. Le CLI prend en charge les deux workflows.
- Un lecteur Web Audio enchaîne l’introduction, la boucle et la sortie sur des trames audio entières, avec un gain de musique dédié. Les exemples Web Audio et Godot sont inclus dans le paquet npm.

---

# SoundMCP 2.3.0

- `SOUNDMCP_LANG=en` affiche en anglais le catalogue MCP, l’aide CLI, les messages de rendu et les erreurs de validation. Un guide d’utilisation en anglais est inclus.
- Les sélecteurs `Intro`, `Theme`, `Bridge` et `Outro` permettent de retrouver les sections par défaut des projets existants.

---

# SoundMCP 2.2.0

- Les esquisses et comparaisons musicales peuvent ajouter des extraits audio MCP courts à sonie alignée.
- `create_sfx` peut générer une famille de prises numérotées, avec des écarts de hauteur et d’attaque reproductibles. Chaque prise est récupérable par son identifiant.
- `finish_music` peut exporter une introduction, une boucle et une sortie avec un manifeste dont les bornes sont exprimées en échantillons. Le dépôt inclut une scène Godot.
- `draft_music` peut importer une mélodie MIDI monophonique sur une ou deux mesures et composer son accompagnement en conservant ses hauteurs et son rythme.
- `instrument_roles` choisit les timbres de chaque pupitre dans les esquisses, y compris le timbre de la mélodie pendant la reprise.
- Le banc d’écoute fournit dix briefs fixes et une comparaison A/B à sonie alignée avec une référence enregistrée.

---

# SoundMCP 2.1.1

- Les définitions MCP de `create_sfx` et `create_ambience` précisent comment reprendre un rendu par son identifiant, quels réglages sont hérités et dans quels cas un WAV existant est écrasé.
- Les définitions de sept autres outils précisent les paramètres à combiner pour les esquisses, les comparaisons, les retouches et les exports. Elles expliquent aussi comment retrouver un projet et mémoriser une préférence musicale.
- Les schémas de sortie documentent les mesures audio, les comparaisons à l’aveugle et les chemins des fichiers archivés.

---

# SoundMCP 2.1.0

- `draft_music` accepte `briefs` pour composer trois à six morceaux distincts en un appel. La collection regroupe les préécoutes, les projets éditables et les réglages utiles pour reprendre chaque morceau séparément.
- `create_sfx` et `create_ambience` reprennent un rendu enregistré à partir de son `file_id`. Chaque variante hérite des réglages de la source et produit un nouveau WAV. Les rendus 2.1.0 enregistrent les réglages nécessaires à cette reprise.
- `manage_outputs` filtre les projets musicaux éditables et leur état. `create_music` avec `save_project`, `edit_music` et `finish_music` renvoient le chemin du projet directement dans `project_path`.
- Les 18 outils ont un titre explicite. Les schémas précisent les paramètres et les combinaisons valides pour la synthèse, les comparaisons, les retouches et les exports.

---

# SoundMCP 2.0.0

SoundMCP compose des instrumentaux, des effets sonores et des ambiances en local. Le catalogue MCP passe de 21 à 18 outils et les nouvelles sorties peuvent être retrouvées, archivées et restaurées.

## Migration des intégrations MCP

Actualisez `tools/list` dans votre client pour retrouver les outils regroupés. Les cinq anciens noms restent acceptés dans les appels directs.

| Ancien appel | Appel à utiliser dans le catalogue 2.0 |
| --- | --- |
| `list_styles` | `list_catalog` avec `category` égal à `music`, `sfx` ou `ambiences` |
| `list_sounds` | `list_catalog` avec `category` égal à `sounds` |
| `preview_sounds` | `play_sound` avec les identifiants dans `sounds` |
| `compare_builds` | `compare_music_choices` avec `criterion` égal à `build` |
| `mix_music` | `edit_music` avec `mix`, qui accepte `section` et `strength` |

## Ce qui change

- `play_sound` joue une phrase sur les instruments Studio et les sons personnels. `compare_sounds` joue la même phrase avec plusieurs timbres à sonie égale.
- `manage_outputs` agit sur les fichiers enregistrés lors des nouveaux rendus. L’archivage est réversible et une restauration refuse d’écraser un fichier déjà présent.
- Les clients MCP `2025-06-18` reçoivent les schémas de sortie des 18 outils et des indications sur leurs effets sur les fichiers. Les clients `2024-11-05` et `2025-03-26` reçoivent aussi les résultats structurés dans un bloc texte JSON.
- Les effets sonores et les ambiances conservent désormais `seed: 0` et reproduisent le même WAV à paramètres identiques.

## Installation

Node.js 18 ou plus récent.

```sh
npx -y @plagnito/soundmcp@2.0.0
```

---

# SoundMCP 1.17.0

SoundMCP compose des instrumentaux sans voix et produit des effets sonores et des ambiances sur votre machine. La 1.17.0 enrichit le travail sur la partition et l’interprétation et rend les banques Studio plus légères à installer.

## De l’esquisse au master

- `draft_music` interprète un brief en français ou en anglais et propose jusqu’à trois esquisses accompagnées de préécoutes au même niveau sonore.
- `inspect_score` affiche la partition, les accords et le placement joué. `edit_music` permet de réécrire une mesure ou de reprendre un pupitre, une section, une montée ou la fin du morceau.
- Les arrangements peuvent changer de tonalité, de tempo et de mesure en cours de morceau. `finish_music` livre le WAV, le MIDI, les stems et le projet éditable et peut créer des versions courtes à durée exacte.

## Interprétation et synthèse

- La palette Studio contient 537 prises, dont des bois, des cordes, des cuivres, du piano, de la harpe, du vibraphone et des percussions. Les notes liées de clarinette, de flûte et de violoncelle bénéficient d’un fondu entre les hauteurs.
- `design_sound`, `play_sound`, `vary_sound` et `compare_sounds` permettent de créer, jouer et comparer des sons personnels. Le moteur propose notamment la synthèse modale, le frottement et la corde pincée à guide d’onde.
- `mix_music` affine la balance d’un morceau ou d’une section. `compare_builds` et `compare_music_choices` permettent d’écouter deux prises anonymes dont le niveau est aligné.

Les styles, effets sonores et ambiances existants restent accessibles. Le paquet comprend les banques compressées sans perte et leurs [crédits CC0](banks/studio/CREDITS.md). Le code de SoundMCP est sous [licence MIT](LICENSE).

## Installation

Node.js 18 ou plus récent.

```sh
npx -y @plagnito/soundmcp@1.17.0
```
