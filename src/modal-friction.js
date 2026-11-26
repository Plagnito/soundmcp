'use strict';

const { makeRng } = require('./rng');

const TAU = 2 * Math.PI;
const T60 = Math.log(1000);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const blend = (a, b, t) => a + (b - a) * t;
const smoothing = (rate, seconds) => 1 - Math.exp(-1 / (rate * seconds));

function renderFriction(L, R, notes, sr, modal) {
  const { friction, contact } = modal;
  const first = notes[0], last = notes.at(-1);
  const longest = Math.max(...modal.modes.map((mode) => mode.decay_seconds));
  const end = Math.min(L.length, last.start + Math.ceil((last.duration + longest) * sr));
  const rng = makeRng(first.event.seedIdx);
  const scale = 0.62 / Math.max(1, Math.hypot(...modal.modes.map((mode) => mode.gain)));
  const modes = modal.modes.map((mode) => {
    const angle = rng.f(0, TAU);
    const loss = T60 / (mode.decay_seconds * sr);
    const undamped = Math.exp(-loss);
    return { ...mode, loss, absorption: 5 + 2 * Math.sqrt(mode.ratio), x: 0, y: 0,
      carrierX: Math.cos(angle), carrierY: Math.sin(angle), noiseDrive: Math.sqrt(1 - undamped * undamped),
      tonalDrive: 1 - undamped };
  });
  const settle = smoothing(sr, 0.018);
  const engage = smoothing(sr, friction.attack_seconds / 4);
  const letGo = smoothing(sr, 0.018);
  const flutter = smoothing(sr, 0.024);
  let grain = 0, drift = 0, contactPhase = rng.f(0, TAU), gate = 0;
  let frequency = first.event.freq, pan = first.event.pan, pressure = 0;
  let damping = first.event.gesture?.damping ?? modal.damping;
  let position = first.event.gesture?.position ?? 0.34;
  let hardness = first.event.gesture?.hardness ?? first.event.timbre ?? 0.5;
  let grainSpeed = 0;

  for (const [index, note] of notes.entries()) {
    const { event, start, duration } = note;
    const following = notes[index + 1];
    const stop = following?.start ?? end;
    const from = frequency;
    const slide = index ? Math.min(stop - start, sr * (event.gesture?.glide_ms ??
      (event.articulation === 'slide' ? 86 : 13)) / 1000) : 0;
    const velocity = clamp(event.vel, 0, 1) * (event.gain ?? 1);
    const [pressureFrom, pressureTo] = event.expression ?? [1, 1];
    const targetDamping = Math.max(modal.damping, event.gesture?.damping ?? 0, event.articulation === 'mute' ? 0.87 : 0);
    const targetPosition = event.gesture?.position ?? 0.34;
    const targetHardness = event.gesture?.hardness ?? event.timbre ?? 0.5;
    const held = Math.round(duration * sr);

    for (let frame = start; frame < stop; frame++) {
      const elapsed = frame - start;
      const rubbing = elapsed < held || Boolean(following);
      const progress = Math.min(1, elapsed / Math.max(1, held));
      gate += ((rubbing ? 1 : 0) - gate) * (rubbing ? engage : letGo);
      pressure += settle * (velocity * blend(pressureFrom, pressureTo, progress) - pressure);
      if ((elapsed & 15) === 0) {
        const travel = slide ? Math.min(1, elapsed / slide) : 1;
        frequency = travel < 1 ? from * (event.freq / from) ** (travel * travel * (3 - 2 * travel)) : event.freq;
        const step = Math.min(1, settle * 16);
        pan += step * (event.pan - pan);
        damping += step * (targetDamping - damping);
        position += step * (targetPosition - position);
        hardness += step * (targetHardness - hardness);
        grainSpeed = 1 - Math.exp(-TAU * (680 + hardness * 8400) / sr);
        for (const mode of modes) {
          const rate = frequency * mode.ratio / sr;
          const angle = TAU * Math.min(rate, 0.49);
          mode.cos = Math.cos(angle);
          mode.sin = Math.sin(angle);
          mode.decay = Math.exp(-mode.loss * (1 + damping * mode.absorption));
          const brightness = 1 / (1 + (mode.ratio - 1) ** 2 * 0.05 * (1 - hardness) ** 2);
          mode.weight = mode.gain * Math.sin(Math.PI * mode.position_node * position) * brightness;
          const anglePan = (clamp(pan + mode.pan, -1, 1) + 1) * Math.PI / 4;
          const band = clamp((0.46 - rate) / 0.05, 0, 1);
          mode.left = Math.cos(anglePan) * band;
          mode.right = Math.sin(anglePan) * band;
        }
      }

      const white = rng.f(-1, 1);
      grain += grainSpeed * (white - grain);
      drift += flutter * (white - drift);
      contactPhase += (TAU * friction.motion_hz / sr) * (1 + clamp(drift * 6, -0.4, 0.4));
      if (contactPhase >= TAU) contactPhase -= TAU;
      const motion = 0.91 + friction.roughness * (0.14 * Math.sin(contactPhase) + clamp(drift * 3, -0.1, 0.1));
      const excitation = gate * pressure * friction.amount * motion;
      const rasp = blend(grain, white, hardness * 0.56);
      let left = rasp * excitation * contact * friction.roughness * 0.16 * Math.sqrt(0.5 * (1 - pan));
      let right = rasp * excitation * contact * friction.roughness * 0.16 * Math.sqrt(0.5 * (1 + pan));
      for (const mode of modes) {
        const carrierX = mode.carrierX * mode.cos - mode.carrierY * mode.sin;
        mode.carrierY = mode.carrierX * mode.sin + mode.carrierY * mode.cos;
        mode.carrierX = carrierX;
        const force = excitation * mode.weight;
        const periodic = force * (1 - friction.roughness) * mode.tonalDrive;
        const irregular = force * rasp * friction.roughness * mode.noiseDrive;
        const x = mode.decay * (mode.x * mode.cos - mode.y * mode.sin) + periodic * carrierX + irregular;
        mode.y = mode.decay * (mode.x * mode.sin + mode.y * mode.cos) + periodic * mode.carrierY;
        mode.x = x;
        left += x * mode.left;
        right += x * mode.right;
      }
      const fade = Math.min(1, (end - 1 - frame) / (sr * 0.018));
      L[frame] += left * scale * fade;
      R[frame] += right * scale * fade;
    }
  }
}

module.exports = { renderFriction };
