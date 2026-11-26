'use strict';

const { makeRng } = require('./rng');
const { renderFriction } = require('./modal-friction');

const TAU = 2 * Math.PI;
const SILENCE = Math.log(1000);
const clamp = (x, min, max) => Math.min(max, Math.max(min, x));

function renderModal(L, R, notes, sr, modal) {
  if (modal.friction) return renderFriction(L, R, notes, sr, modal);
  const first = notes[0], last = notes.at(-1);
  const scale = 0.64 / Math.max(1, Math.hypot(...modal.modes.map((mode) => mode.gain)));
  const tail = Math.max(...modal.modes.map((mode) => mode.decay_seconds));
  const end = Math.min(L.length, last.start + Math.ceil(tail * sr));
  const rng = makeRng(first.event.seedIdx);
  const hit = clamp(first.event.vel, 0, 1);
  const hardness = first.event.gesture?.hardness ?? clamp((first.event.timbre ?? 0.5) * 0.36 + hit * 0.62, 0, 1);
  const position = first.event.gesture?.position ?? 0.34;
  const contactLength = Math.max(4, Math.round(sr * (0.004 + (1 - hardness) * 0.015)));
  const contactSpeed = 1 - Math.exp(-TAU * (800 + hardness * 7800) / sr);
  const attack = 0.0008 + (1 - hardness) * 0.0035;
  const modes = modal.modes.map((mode) => {
    const positionGain = Math.sin(Math.PI * mode.position_node * position);
    const brightness = 1 / (1 + (mode.ratio - 1) ** 2 * 0.045 * (1 - hardness) ** 2);
    return { ...mode, phase: 0, energy: mode.gain * positionGain * brightness,
      loss: SILENCE / (mode.decay_seconds * sr), absorption: 5 + Math.sqrt(mode.ratio) * 2 };
  });
  const settle = 1 - Math.exp(-1 / (0.014 * sr));
  let noise = 0, previousNoise = 0, damping = modal.damping;
  let volume = hit * (first.event.gain ?? 1) * (first.event.expression?.[0] ?? 1);
  let pan = first.event.pan, frequency = first.event.freq;

  for (const [index, note] of notes.entries()) {
    const { event, start, duration } = note;
    const next = notes[index + 1]?.start ?? end;
    const from = frequency;
    const glide = index ? Math.min((next - start) / sr, (event.gesture?.glide_ms ??
      (event.articulation === 'slide' ? 86 : 13)) / 1000) : 0;
    const [pressureFrom, pressureTo] = event.expression ?? [1, 1];
    const targetDamping = Math.max(modal.damping, event.gesture?.damping ?? 0, event.articulation === 'mute' ? 0.87 : 0);
    const targetVolume = clamp(event.vel, 0, 1) * (event.gain ?? 1);
    for (let frame = start; frame < next; frame++) {
      const t = (frame - start) / sr;
      const travel = glide > 0 ? Math.min(1, t / glide) : 1;
      const curve = travel * travel * (3 - 2 * travel);
      frequency = travel < 1 ? from * (event.freq / from) ** curve : event.freq;
      const progress = Math.min(1, t / Math.max(0.01, duration));
      volume += settle * (targetVolume * (pressureFrom + (pressureTo - pressureFrom) * progress) - volume);
      const damped = event.articulation === 'staccato' && t > duration ? Math.max(0.7, targetDamping) : targetDamping;
      damping += settle * (damped - damping);
      pan += settle * (event.pan - pan);
      let left = 0, right = 0;
      const age = (frame - first.start) / sr;
      const onset = Math.min(1, age / attack);
      for (const mode of modes) {
        const rate = frequency * mode.ratio / sr;
        mode.phase += Math.min(0.49, rate);
        if (mode.phase >= 1) mode.phase -= 1;
        mode.energy *= Math.exp(-mode.loss * (1 + damping * mode.absorption));
        const band = clamp((0.46 - rate) / 0.055, 0, 1);
        const signal = Math.sin(TAU * mode.phase) * mode.energy * onset * onset * band;
        const angle = (clamp(pan + mode.pan, -1, 1) + 1) * Math.PI / 4;
        left += signal * Math.cos(angle);
        right += signal * Math.sin(angle);
      }
      if (frame - first.start < contactLength && modal.contact > 0) {
        const white = rng.f(-1, 1);
        noise += contactSpeed * (white - noise);
        const shape = Math.sin(Math.PI * (frame - first.start) / contactLength) ** 2;
        const transient = (noise - previousNoise * 0.55) * shape * modal.contact * (0.42 + hardness * 0.7);
        previousNoise = noise;
        left += transient * Math.sqrt((1 - pan) * 0.5);
        right += transient * Math.sqrt((1 + pan) * 0.5);
      }
      const fade = Math.min(1, (end - 1 - frame) / (0.014 * sr));
      L[frame] += left * volume * scale * fade;
      R[frame] += right * volume * scale * fade;
    }
  }
}

module.exports = { renderModal };
