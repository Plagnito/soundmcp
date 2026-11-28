# SoundMCP production workflows

[Français](workflows.md)

## MCP toolsets

Set `SOUNDMCP_TOOLSET` in your MCP client’s environment and restart the server. The default is `full`. Advanced toolsets expose delivery inventory, parameter examples, and conflict policies where supported.

| Toolset | Tools | Use |
| --- | ---: | --- |
| `full` | 18 | Catalog compatible with 2.4.1 clients |
| `studio` | 18 | Full catalog with advanced operations |
| `music` | 11 | Music composition, audition, editing, analysis, and delivery |
| `sound` | 9 | Timbres, effects, ambience, and inventory |
| `audition` | 17 | Combines `play_sound` and `compare_sounds` in `audition_sound` |
| `patches` | 17 | Combines `design_sound` and `vary_sound` in `design_timbre` |
| `presets` | 17 | Combines `create_sfx` and `create_ambience` in `render_preset` |
| `compact` | 15 | Applies all three combinations |

Each toolset fixes the advertised list at startup. Calls using established tool names still work. To migrate a client, change the toolset, refresh `tools/list`, and add the corresponding `mode` to the calls you want the client to discover.

| Tool | Mode | Existing call |
| --- | --- | --- |
| `audition_sound` | `phrase` | `play_sound` with an instrument or patch |
| `audition_sound` | `catalog` | `play_sound` with a list of `sounds` IDs |
| `audition_sound` | `comparison` | `compare_sounds` with a source per take |
| `design_timbre` | `create` / `vary` | `design_sound` / `vary_sound` |
| `render_preset` | `effect` / `ambience` | `create_sfx` / `create_ambience` |

## Audition, compare, and measure

- `play_sound` with `{"instrument":"piano","notes":[{"at":0,"pitch":"C4"}]}` plays a phrase in one WAV. With `{"sounds":["piano","harp"]}`, `markers[].from` gives the start of each catalog example in seconds.
- `compare_sounds` with `{"sounds":[{"instrument":"clarinet"},{"instrument":"flute"}],"notes":[{"at":0,"pitch":"A4","duration":0.8}],"blind":true,"seed":7}` makes two separate loudness-matched WAVs. Keep the same sources and seed to reproduce the order. Open `reveal_path` after the choice.
- `analyze_music` with `{"wav_path":"master.wav"}` measures the delivered render. With `project_path`, pass the resulting `suggestedEdits` to `edit_music.edits`. To rewrite notes, check the chords with `inspect_score` first.
- `calibrate_sound` measures three velocities per pitch. For bass, choose pitches that span the played line, for example `{"patch_path":"bass.soundmcp-patch.json","role":"bass","notes":["C2","G2","C3"],"seed":7}`. For a melody around C4, start with `role="mel"` and `["C3","C4","C5"]`. Apply `calibration_path` in `calibration_paths` with the same patch and part. Keep the seed to reproduce the measurement.
- `learn_music_preference` records an explicit A/B choice after an `accompaniment` or `breath` comparison. It replaces the preference for that criterion and keeps the others. Reuse `profile_path` with `draft_music`. For an invalid manifest, rerun the comparison and ask the listener to choose again.

## Compose, edit, and deliver

These are four inputs for `draft_music`. For the last two, substitute a real input path and select a bar range in the project.

| Intent | Arguments |
| --- | --- |
| Two takes of a theme | `{"brief":"20 seconds, soft piano and quiet tension","variants":2}` |
| Three distinct tracks | `{"briefs":["Calm piano jazz","Guitar lofi","Slow strings in a minor key"]}` |
| Develop a MIDI motif | `{"brief":"Bright village theme","midi_motif":{"path":"theme.mid"}}` |
| Develop an excerpt | `{"brief":"Develop this passage for a nighttime scene","source_excerpt":{"project_path":"draft.soundmcp.json","region":{"start_bar":5,"bars":4}}}` |

To render directly from a style, call `create_music` with `{"style":"lofi","format":"wav"}`. Add `"stems":true` for separate parts. For MIDI and an editable project as well, use `{"style":"lofi","format":"both","save_project":true}`.

1. Read bar 2 with `inspect_score` and `{"project_path":"draft.soundmcp.json","start_bar":2,"bars":1,"part":"mel"}`.
2. Send the edit to `edit_music` with `{"project_path":"draft.soundmcp.json","edits":[{"type":"write_measure","bar":2,"part":"mel","notes":[{"beat":0,"pitch":"C4","duration":1},{"beat":1,"pitch":"E4","duration":1}]}]}`. Edits apply in list order. If you supply `mix`, it runs before the copy is exported.
3. Audition `versions[0].project_path` with `preview_music`. Give that project to `finish_music` for the master.

`finish_music` accepts `format="wav"`, `"midi"`, or `"both"`. WAV with `stems=true` adds individual parts. To deliver an adaptive loop, call `compare_music_choices` with `criterion="loop"`, let the listener choose, and pass the chosen take’s `adaptive` object and source project to `finish_music`. The Web Audio or Godot player opens `adaptive.manifest_path` next to its three WAVs. MCP clients can also discover the `adaptive_loop` and `blind_timbres` workflows through `prompts/list`.

## Reopen a delivery

Registered outputs return `managed_outputs.render_id`. Get the delivery with `manage_outputs` in an advanced toolset, `action="get"`, the original `output_dir`, and the `render_id`. Each file has its original `path` and live `current_path`. Use `file_id` to get one file. `source` and `related_render_ids` can lead back to the project or to variants in the same inventory.

- `action="list"` combines `state`, `file_type`, and `render_id`. Filterable types are `project`, `wav`, `midi`, and `json`.
- `action="archive"` or `"restore"` with `render_id` moves the files together, preserving their relative manifest paths. Retry the same action after an interruption. `DESTINATION_OCCUPIED` means the conflicting destination must be freed before resuming.
- Render tools can return `resource_link` items. A modern client can use `resources/read` on a registered file’s URI. Resources are limited to 16 MiB. Larger projects and long WAVs are available by their local paths.
- `create_music`, `create_sfx`, and `create_ambience` accept `on_conflict="replace"` for the usual behavior, `"unique"` for a separate folder, or `"reuse"` to return an identical active render. If there is no reusable render, `reuse` writes to a separate folder.
- Tool errors include a stable code and, where applicable, a localized recovery hint in `_meta["soundmcp/error"]`.

## Release checks

```bash
npm test
npm run check:release -- tmp/release-check
SOUNDMCP_SCHEMA_OBSERVATIONS=tmp/schema-observations.json node scripts/workflow-quality.js
python scripts/verify-tool-schemas.py tmp/release-check/toolsets tmp/schema-observations.json
```

On PowerShell, set `$env:SOUNDMCP_SCHEMA_OBSERVATIONS = "tmp/schema-observations.json"` before the test. The Python checks use `jsonschema`. The release check builds the npm package, installs it offline, starts the installed server, and records the package integrity, Git commit, bank manifests, and sixteen tool listings.

The routing benchmark measures correct first tool, valid arguments, and attempts without executing model responses. Use a model already installed in Ollama.

```bash
python scripts/route-bench.py --model <installed-model> --profiles full compact
python scripts/compare-tdqs.py --reference reference-1.json reference-2.json --candidate candidate-1.json candidate-2.json --minimum 4.4
```

Submit the `tools/list` exports to the same TDQS evaluator in the same language. Compare the full toolset to the reference, then score the three individual combinations and the compact toolset. The report compares the lowest tool score, the four coherence dimensions, and the results across runs.

The `Dockerfile` runs the stdio server as the `node` user with its sample banks. For Glama, associate the build with the release commit and compare it with `git_commit` and the SHA-512 in the release manifest. [TDQS](https://tdqs.dev/cli) · [Glama indexing](https://glama.ai/mcp/methodology)
