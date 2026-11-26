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
