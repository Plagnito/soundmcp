# SoundMCP adaptive music in a browser

The demo plays a `soundmcp-adaptive` v1 pack from `finish_music`. It decodes the three WAVs before playback and schedules intro, loop, and outro on the Web Audio clock. A gain control changes music volume independently of other audio.

## Try it

Generate the example pack and start the local server.

```bash
node examples/godot-adaptive/prepare-demo.js
node examples/web-audio-adaptive/serve.js
```

Open `http://127.0.0.1:8787/`, select **Play**, then request an exit while the loop runs. The outro starts at the next schedulable loop boundary. A request in the last 25 ms schedules it for the following boundary.

To use your own pack, pass the manifest path and keep the three WAVs beside it. An optional second argument specifies the port.

```bash
node examples/web-audio-adaptive/serve.js path/to/track-adaptive.json
```

## Use it in a game

Copy `player.mjs` into your game project and serve your manifest and WAVs alongside it. Start or resume the context inside the game’s first audio gesture. Use the pack’s sample rate when creating the context if you want to preserve its original sample boundaries.

```js
import { AdaptiveMusicPlayer, loadAdaptivePack } from './player.mjs';

const musicBus = audioContext.createGain();
musicBus.connect(audioContext.destination);
const pack = await loadAdaptivePack(audioContext, '/music/track-adaptive.json');
const music = new AdaptiveMusicPlayer(audioContext, pack, musicBus);

music.setVolume(0.7);
music.play();

// On a later scene transition
music.exitAfterLoop();
```

Route ambience and effects through their own gain nodes. Use `music.stop()` for an immediate stop, or `music.dispose()` to disconnect the player after it is no longer needed.
