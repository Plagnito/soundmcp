import assert from 'node:assert/strict';
import test from 'node:test';
import { AdaptiveMusicPlayer } from './player.mjs';

function contextAt(sampleRate) {
  const sources = [];
  return {
    sampleRate, currentTime: 0, sources,
    createGain() { return { connect() {} }; },
    createBufferSource() {
      const source = {
        connect() {},
        addEventListener() {},
        start(when) { this.started = when; },
        stop(when) { this.stopped = when; },
      };
      sources.push(source);
      return source;
    },
  };
}

function assertFrame(seconds, rate, expected) {
  assert.ok(Math.abs(seconds * rate - expected) < 1e-7, 'expected an integer frame');
}

for (const rate of [22050, 44100, 48000]) {
  test('schedules adaptive music on whole frames at ' + rate + ' Hz', () => {
    const context = contextAt(rate);
    const intro = { length: 1135 };
    const loop = { length: 4097 };
    const outro = { length: 802 };
    const player = new AdaptiveMusicPlayer(context, { intro, loop, outro });
    assert.equal(player.play(), true);
    assert.equal(player.play(), false);
    const [introSource, loopSource] = context.sources;
    const start = Math.ceil(rate * 0.025);
    const loopStart = start + intro.length;
    assertFrame(introSource.started, rate, start);
    assertFrame(loopSource.started, rate, loopStart);
    assert.equal(loopSource.loop, true);

    context.currentTime = (loopStart + loop.length - 20) / rate;
    const exit = player.exitAfterLoop();
    const exitFrame = loopStart + 2 * loop.length;
    assertFrame(exit, rate, exitFrame);
    assertFrame(loopSource.stopped, rate, exitFrame);
    assertFrame(context.sources[2].started, rate, exitFrame);
    assert.equal(player.exitAfterLoop(), exit);
    assert.equal(context.sources.length, 3);
  });
}
