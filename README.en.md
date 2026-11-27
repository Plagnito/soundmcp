# SoundMCP

[Documentation française](README.md) · [Changelog](CHANGELOG.md)

SoundMCP composes instrumental music and generates sound effects and looping ambiences for games and media. It runs locally on Node.js 18 or later. The Studio palette includes recorded instruments.

## Run in English

Set `SOUNDMCP_LANG=en` before starting the server or CLI and restart any running MCP server to apply it. Regional values such as `en-GB` and `en-US` also work. French is the default.

For an MCP client that uses `mcpServers`, add an `env` entry to the SoundMCP configuration. For a source checkout, replace the command with `node` and give the full path to `src/index.js` as the argument.

```json
{
  "mcpServers": {
    "soundmcp": {
      "command": "npx",
      "args": ["-y", "@plagnito/soundmcp"],
      "env": {
        "SOUNDMCP_LANG": "en"
      }
    }
  }
}
```

For the CLI, run these commands from a source checkout.

```bash
SOUNDMCP_LANG=en node src/cli.js help
SOUNDMCP_LANG=en node src/cli.js list
```

```powershell
$env:SOUNDMCP_LANG = 'en'
node src/cli.js help
node src/cli.js list
```

## Make music

1. Call `draft_music` with a brief such as “30 seconds for nighttime exploration, with a quiet flute and harp in D Lydian.” Add a `seed` to reproduce the arrangement. Use `instrument_roles` to assign a particular instrument to the melody, pad, arpeggio, bass, or countermelody.
2. Choose a candidate and use its `project_path` with `preview_music` or `inspect_score`. Set `inline_audio: true` for a short clip if your MCP client supports it.
3. Call `edit_music` for changes, or compare two arrangement choices at matched loudness with `compare_music_choices`.
4. Call `finish_music` with the chosen `project_path`. Use `format: "both"` for WAV and MIDI, `stems: true` for separate parts, and `bit_depth: 24` with `sampling_rate: 48000` for a production master. For game music, `adaptive` can export intro, loop, and outro WAVs with a manifest.

Briefs and key names accept English and French in either display language. For a stored project, use the section name from `inspect_score` or its one-based index. The aliases `Intro`, `Theme`, `Bridge`, and `Outro` work with the default draft sections.

To render directly from a style, use `create_music` or the CLI.

```bash
node src/cli.js music ambient --dur 30 --key "D lydian" --seed 7 --no-loop --both --project
```

## Make sound effects and ambiences

- Use `list_catalog` with `category` set to `music`, `sfx`, `ambiences`, or `sounds` to find IDs.
- Use `create_sfx` for a one-shot effect and `create_ambience` for a seamless background loop. For multiple takes of an effect, set `variants.count` from 2 to 12.
- Use `design_sound` to create an editable patch. Audition it with `play_sound` or use `compare_sounds` to compare patches at matched loudness.
- Use `manage_outputs` with the render's `output_dir` to find registered files. Pass the relevant `file_id` back as `source_file_id` to revise a saved effect or ambience.

```bash
node src/cli.js sfx footstep --seed 7 --variants 4
node src/cli.js ambience rain --dur 30 --seed 7
```

The MCP tool catalog includes English parameter and result descriptions when English is enabled. The [French reference](README.md) contains more arrangement and synthesis examples.

## License

[MIT](LICENSE) · [Studio sample credits and licenses](banks/studio/CREDITS.md)
