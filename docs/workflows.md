# Parcours de production SoundMCP

[English](workflows.en.md)

## Profils MCP

Règle `SOUNDMCP_TOOLSET` dans `env` de ton client MCP et redémarre le serveur. Le profil `full` est utilisé par défaut. Les profils avancés ajoutent l’inventaire par livraison, les exemples de paramètres et les politiques de collision aux outils concernés.

| Profil | Outils | Usage |
| --- | ---: | --- |
| `full` | 18 | Catalogue compatible avec les clients de la version 2.4.1 |
| `studio` | 18 | Catalogue complet avec les opérations avancées |
| `music` | 11 | Composition, audition, retouche, analyse et livraison musicales |
| `sound` | 9 | Timbres, effets, ambiances et inventaire |
| `audition` | 17 | Regroupe `play_sound` et `compare_sounds` dans `audition_sound` |
| `patches` | 17 | Regroupe `design_sound` et `vary_sound` dans `design_timbre` |
| `presets` | 17 | Regroupe `create_sfx` et `create_ambience` dans `render_preset` |
| `compact` | 15 | Combine les trois regroupements |

Chaque profil fixe la liste annoncée au démarrage. Les appels qui utilisent déjà les noms historiques restent utilisables. Pour migrer un client, change le profil, actualise `tools/list` et ajoute le `mode` correspondant aux appels que tu veux faire découvrir au client.

| Outil | Mode | Ancien appel |
| --- | --- | --- |
| `audition_sound` | `phrase` | `play_sound` avec instrument ou patch |
| `audition_sound` | `catalog` | `play_sound` avec une liste d’identifiants `sounds` |
| `audition_sound` | `comparison` | `compare_sounds` avec une source par prise |
| `design_timbre` | `create` / `vary` | `design_sound` / `vary_sound` |
| `render_preset` | `effect` / `ambience` | `create_sfx` / `create_ambience` |

## Écouter, comparer et mesurer

- `play_sound` avec `{"instrument":"piano","notes":[{"at":0,"pitch":"C4"}]}` joue une phrase dans un WAV. Avec `{"sounds":["piano","harp"]}`, `markers[].from` indique en secondes le début de chaque exemple du nuancier.
- `compare_sounds` avec `{"sounds":[{"instrument":"clarinet"},{"instrument":"flute"}],"notes":[{"at":0,"pitch":"A4","duration":0.8}],"blind":true,"seed":7}` produit deux WAV séparés à sonie égale. Garde les mêmes sources et la même graine pour reproduire l’ordre. Ouvre `reveal_path` après le choix.
- `analyze_music` avec `{"wav_path":"master.wav"}` mesure le rendu livré. Avec `project_path`, les `suggestedEdits` du diagnostic peuvent être transmis à `edit_music.edits`. Pour écrire des notes, commence par consulter les accords avec `inspect_score`.
- `calibrate_sound` mesure trois forces par hauteur. Pour une basse, choisis des hauteurs qui couvrent la ligne réelle, par exemple `{"patch_path":"basse.soundmcp-patch.json","role":"bass","notes":["C2","G2","C3"],"seed":7}`. Pour une mélodie autour de C4, `role="mel"` et `["C3","C4","C5"]` constituent un point de départ. Réutilise le même patch et le même pupitre avec `calibration_path` dans `calibration_paths`. Reprends aussi la graine pour reproduire les mesures.
- `learn_music_preference` enregistre un choix A/B explicite après une comparaison `accompaniment` ou `breath`. La préférence du seul critère choisi est remplacée. Reprends `profile_path` dans `draft_music`. Si le manifeste est invalide, relance la comparaison et demande un nouveau choix à l’auditeur.

## Composer, retoucher et livrer

Voici quatre entrées pour `draft_music`. Pour les deux dernières, remplace le chemin par celui d’un fichier existant et choisis une plage présente dans le projet.

| Idée | Paramètres |
| --- | --- |
| Deux prises d’un thème | `{"brief":"20 secondes, piano feutré et tension douce","variants":2}` |
| Trois morceaux distincts | `{"briefs":["Jazz au piano","Lofi à la guitare","Cordes lentes en mineur"]}` |
| Développement d’un motif MIDI | `{"brief":"Thème lumineux de village","midi_motif":{"path":"theme.mid"}}` |
| Développement d’un extrait | `{"brief":"Reprends ce passage dans une ambiance nocturne","source_excerpt":{"project_path":"esquisse.soundmcp.json","region":{"start_bar":5,"bars":4}}}` |

Pour rendre directement depuis un style, utilise `create_music` avec `{"style":"lofi","format":"wav"}`. Ajoute `"stems":true` pour séparer les pupitres. Pour récupérer aussi le MIDI et le projet éditable, passe `{"style":"lofi","format":"both","save_project":true}`.

1. Lis la mesure 2 avec `inspect_score` et `{"project_path":"esquisse.soundmcp.json","start_bar":2,"bars":1,"part":"mel"}`.
2. Fournis l’édition à `edit_music` avec `{"project_path":"esquisse.soundmcp.json","edits":[{"type":"write_measure","bar":2,"part":"mel","notes":[{"beat":0,"pitch":"C4","duration":1},{"beat":1,"pitch":"E4","duration":1}]}]}`. Les retouches suivent l’ordre de la liste. Si tu fournis `mix`, il est appliqué avant l’export de la copie.
3. Écoute `versions[0].project_path` dans `preview_music`. Pour le master, appelle `finish_music` avec ce même projet.

`finish_music` accepte `format="wav"`, `"midi"` ou `"both"`. Avec WAV, `stems=true` ajoute les pupitres. Pour une boucle adaptative, appelle `compare_music_choices` avec `criterion="loop"`, fais choisir une prise, puis passe son objet `adaptive` à `finish_music` avec le projet source. Le lecteur Web Audio ou Godot ouvre `adaptive.manifest_path` à côté de ses trois WAV. Le client MCP peut également proposer directement les parcours `adaptive_loop` et `blind_timbres` via `prompts/list`.

## Reprendre une livraison

Les sorties enregistrées portent un `managed_outputs.render_id`. Récupère la livraison avec `manage_outputs` dans un profil avancé, `action="get"`, le même `output_dir` et le `render_id`. Le résultat donne les fichiers, leur chemin d’origine `path` et leur emplacement réel `current_path`. Avec un `file_id`, le même appel cible un fichier. `source` et `related_render_ids` aident à remonter au projet ou à retrouver les variantes inscrites dans le même inventaire.

- `action="list"` combine `state`, `file_type` et `render_id`. Les formats filtrables sont `project`, `wav`, `midi` et `json`.
- `action="archive"` ou `"restore"` avec `render_id` agit sur les fichiers de la livraison. Les éléments liés par le manifeste conservent leurs chemins relatifs. Si le déplacement s’interrompt, relance la même action. Si une destination est occupée, le code `DESTINATION_OCCUPIED` indique qu’il faut libérer ce chemin avant la reprise.
- Les outils de rendu peuvent retourner des liens `resource_link`. Un client moderne peut appeler `resources/read` sur l’URI d’un fichier enregistré localement. Les ressources sont limitées à 16 Mio. Les projets volumineux et les longs WAV restent disponibles via leur chemin.
- `create_music`, `create_sfx` et `create_ambience` acceptent `on_conflict="replace"` pour le comportement historique, `"unique"` pour un dossier séparé ou `"reuse"` pour récupérer un rendu actif identique. En l’absence de rendu réutilisable, `reuse` écrit dans un nouveau dossier.
- Les erreurs d’outil incluent le code et, lorsqu’une reprise est possible, un conseil localisé dans `_meta["soundmcp/error"]`.

## Contrôler une version

```bash
npm test
npm run check:release -- tmp/release-check
SOUNDMCP_SCHEMA_OBSERVATIONS=tmp/schema-observations.json node scripts/workflow-quality.js
python scripts/verify-tool-schemas.py tmp/release-check/toolsets tmp/schema-observations.json
```

Sur PowerShell, règle `$env:SOUNDMCP_SCHEMA_OBSERVATIONS = "tmp/schema-observations.json"` avant le test. Les vérifications Python utilisent `jsonschema`. Le contrôle de release construit le paquet npm, l’installe hors ligne, démarre son serveur et associe l’intégrité du paquet, le commit Git, les manifestes de banques et les seize catalogues au même dossier.

L’outil de benchmark mesure le bon premier appel, les arguments valides et le nombre de tentatives sans exécuter les réponses du modèle. Il fonctionne avec un modèle Ollama déjà installé.

```bash
python scripts/route-bench.py --model <modele-installe> --profiles full compact
python scripts/compare-tdqs.py --reference reference-1.json reference-2.json --candidate candidat-1.json candidat-2.json --minimum 4.4
```

Soumets les exports de `tools/list` au même évaluateur TDQS dans la même langue. Compare le profil complet à la référence, puis mesure les trois regroupements seuls et le profil compact. Le script indique le minimum par outil, les quatre axes de cohérence et les résultats de chaque répétition.

Le `Dockerfile` lance le serveur stdio avec l’utilisateur `node` et les banques embarquées. Pour Glama, rattache le build au commit de la release et compare-le au `git_commit` et au SHA-512 du manifeste de contrôle. [TDQS](https://tdqs.dev/cli) · [Indexation Glama](https://glama.ai/mcp/methodology)
