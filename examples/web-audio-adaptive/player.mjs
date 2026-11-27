const SEGMENTS = ['intro', 'loop', 'outro'];
const LEAD_TIME = 0.025;

async function checkedFetch(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Could not load ' + url.pathname + ' (HTTP ' + response.status + ').');
  return response;
}

export async function loadAdaptivePack(context, url) {
  const manifestUrl = new URL(url, globalThis.location?.href);
  const manifest = await (await checkedFetch(manifestUrl)).json();
  const { sample_rate: rate, channels } = manifest;
  if (manifest.type !== 'soundmcp-adaptive' || manifest.version !== 1 ||
      !Number.isSafeInteger(rate) || rate <= 0 || ![1, 2].includes(channels)) {
    throw new Error('Expected a SoundMCP adaptive manifest v1.');
  }
  let nextFrame = 0;
  const entries = SEGMENTS.map((name) => {
    const entry = manifest.segments?.[name];
    if (!entry || typeof entry.file !== 'string' || !/^[a-z0-9][a-z0-9._-]*\.wav$/i.test(entry.file) ||
        !Number.isSafeInteger(entry.frames) || entry.frames <= 0 || entry.start_sample !== nextFrame ||
        entry.end_sample_exclusive !== nextFrame + entry.frames) {
      throw new Error('Invalid ' + name + ' segment in the manifest.');
    }
    nextFrame += entry.frames;
    return [name, entry];
  });
  if (nextFrame !== manifest.total_frames) throw new Error('The segment lengths do not match the manifest.');
  const buffers = await Promise.all(entries.map(async ([name, entry]) => {
    const response = await checkedFetch(new URL(entry.file, manifestUrl));
    const buffer = await context.decodeAudioData(await response.arrayBuffer());
    const expectedFrames = entry.frames * buffer.sampleRate / rate;
    if (buffer.numberOfChannels !== channels || Math.abs(buffer.length - expectedFrames) > 1) {
      throw new Error('Decoded ' + name + ' audio does not match the manifest.');
    }
    return [name, buffer];
  }));
  return Object.fromEntries(buffers);
}

export class AdaptiveMusicPlayer {
  constructor(context, buffers, destination = context.destination) {
    this.context = context;
    this.buffers = buffers;
    this.gain = context.createGain();
    this.gain.connect(destination);
    this.session = null;
  }

  source(buffer) {
    const node = this.context.createBufferSource();
    node.buffer = buffer;
    node.connect(this.gain);
    node.addEventListener('ended', () => node.disconnect(), { once: true });
    return node;
  }

  play() {
    if (this.session) return false;
    const intro = this.source(this.buffers.intro);
    const loop = this.source(this.buffers.loop);
    const start = this.context.currentTime + LEAD_TIME;
    const loopAt = start + this.buffers.intro.duration;
    loop.loop = true;
    this.session = { intro, loop, loopAt };
    intro.start(start);
    loop.start(loopAt);
    return true;
  }

  exitAfterLoop() {
    const session = this.session;
    if (!session) return null;
    if (session.outro) return session.exitAt;
    const duration = this.buffers.loop.duration;
    const time = this.context.currentTime + LEAD_TIME;
    const turns = Math.max(1, Math.ceil((time - session.loopAt) / duration));
    const exitAt = session.loopAt + turns * duration;
    const outro = this.source(this.buffers.outro);
    Object.assign(session, { outro, exitAt });
    outro.addEventListener('ended', () => {
      if (this.session === session) this.session = null;
    }, { once: true });
    session.loop.stop(exitAt);
    outro.start(exitAt);
    return exitAt;
  }

  stop() {
    const session = this.session;
    if (!session) return;
    this.session = null;
    for (const node of [session.intro, session.loop, session.outro]) {
      if (node) node.stop();
    }
  }

  setVolume(volume) {
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error('Volume must be between 0 and 1.');
    this.gain.gain.setTargetAtTime(volume, this.context.currentTime, 0.02);
  }

  dispose() {
    this.stop();
    this.gain.disconnect();
  }
}
