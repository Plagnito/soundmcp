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
