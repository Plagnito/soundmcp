'use strict';

/**
 * Compositeur procédural : transforme un style + paramètres en un « song »
 * (liste d'événements musicaux) prêt à être rendu par dsp.js.
 *
 * Principes pour que ça sonne bien :
 *  - accords construits sur la gamme (toujours consonants) ;
 *  - progressions éprouvées (I–V–vi–IV, i–VI–III–VII…) ;
 *  - renversements des nappes avec conduite de voix (mouvement minimal) ;
 *  - mélodie en motifs : une cellule de 3-5 notes, répétée/variaitée/transposée ;
 *  - notes fortes calées sur les accords, notes de passage entre ;
 *  - swing et humanisation légères pour un rendu vivant.
 */

const { makeRng, randomSeed } = require('./rng');
const { SCALES, SHARPS, parseKey, parseNote, degreeSemitone, chordFromDegree, midiToFreq } = require('./theory');
const { STYLES } = require('./styles');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const octaveMidi = (pc, oct) => 12 * (oct + 1) + pc;

/* ------------------------------ composition ------------------------------ */

/**
 * params: { style, duration_seconds, tempo, key, seed, loop, title }
 * retourne song: { events, bpm, bars, totalBeats, loop, fx, meta, endFade }
 */
function createSong(params) {
  const styleId = params.style;
  const style = STYLES[styleId];
  if (!style) throw new Error(`Style inconnu: ${styleId}. Styles valides: ${Object.keys(STYLES).join(', ')}`);

  const seed = (params.seed >>> 0) || randomSeed();
  const rng = makeRng(seed);

  const bpm = clamp(Math.round(params.tempo ?? style.defaults.tempo), 40, 220);
  const durSec = clamp(params.duration_seconds ?? style.defaults.duration, 5, 600);
  const loop = params.loop !== undefined ? !!params.loop : !!style.defaults.loop;
  const sr = [22050, 44100, 48000].includes(params.sr) ? params.sr : 44100;
  const mono = !!params.mono;

  // tonalité
  let key = parseKey(params.key);
  if (!key) {
    const rootPc = parseNote(rng.pick(style.defaults.rootPool)) ?? rng.int(0, 11);
    const scaleId = rng.pick(style.defaults.scalePool);
    key = { root: rootPc, scaleId };
  }
  const scale = SCALES[key.scaleId];
  const rootMidi = 48 + key.root; // tonique à l'octave 3

  // mesures (4 temps)
  let bars = Math.max(4, Math.round((durSec * bpm) / 240));
  bars = Math.round(bars / 4) * 4;
  const totalBeats = bars * 4;

  /* ------- sections ------- */
  const pool = style.progressions[key.scaleId] || style.progressions[Object.keys(style.progressions)[0]];
  const progA = rng.pick(pool);
  let progB = rng.pick(pool);
  if (pool.length > 1 && progB === progA) progB = pool[(pool.indexOf(progA) + 1) % pool.length];

  const chunks = [];
  let coreBars = bars;
  let introBars = 0, outroBars = 0;
  if (!loop && bars >= 12) { introBars = 4; outroBars = 4; coreBars = bars - 8; }

  const nChunks = Math.max(1, Math.round(coreBars / 4));
  const chunkLen = coreBars / nChunks;
  const labels = ['A', "A'", 'B', "A''", 'B2', "A'''"];
  for (let i = 0; i < nChunks; i++) {
    const label = labels[Math.min(i, labels.length - 1)];
    chunks.push({ name: label, bars: chunkLen, prog: label === 'B' || label === 'B2' ? progB : progA });
  }
  const sections = [];
  if (introBars) sections.push({ name: 'intro', bars: introBars, prog: progA, texture: 'light', melodyOn: false });
  for (const c of chunks) {
    sections.push({ name: c.name, bars: c.bars, prog: c.prog, texture: 'full', melodyOn: true });
  }
  if (outroBars) sections.push({ name: 'outro', bars: outroBars, prog: progA, texture: 'none', melodyOn: false });

  /* ------- événements ------- */
  const events = [];
  let seedIdx = 0;
  const seventhOn = rng.chance(style.seventh);
  const push = (ev) => {
    ev.seedIdx = seedIdx++;
    ev.freq = midiToFreq(ev.midi);
    events.push(ev);
  };
  const humanize = (t, vel) => {
    let tt = t;
    if (style.swing > 0) {
      // swing sur les croches décalées (slots impairs d'une grille binaire)
      const slotFloat = (tt * 2) % 2;
      if (Math.abs(slotFloat - 1) < 1e-6) tt += (style.swing / 6);
    }
    tt += rng.f(-0.008, 0.008);
    return [tt, clamp(vel * rng.f(0.93, 1.07), 0.05, 1)];
  };

  let prevVoicing = null;
  let melodyState = null; // motif courant
  let barIdx = 0;

  for (const section of sections) {
    const secBars = Math.round(section.bars);
    const secStart = barIdx;
    const lastSection = section === sections[sections.length - 1];
    const seventhSec = rng.chance(style.seventh);
    for (let b = 0; b < secBars; b++, barIdx++) {
      const absBar = barIdx;
      const beat0 = absBar * 4;
      const progDeg = section.prog[b % section.prog.length];
      const nextDeg = section.prog[(b + 1) % section.prog.length];
      const isLastBarOfSong = absBar === bars - 1;
      const isLoopLastBar = loop && isLastBarOfSong;
      const finalHold = !loop && lastSection && b === secBars - 1;

      const ninth = rng.chance((style.ninthColor || 0) * 0.4);
      const chord = chordFromDegree(rootMidi, scale, progDeg, { seventh: seventhSec, ninth });

      /* ---- nappe (avec conduite de voix) ---- */
      if (style.pad) {
        const pcs = chord.pitchClasses;
        const low = octaveMidi(key.root, style.pad.octave) - 2;
        const high = low + 26;
        const voicing = voiceChord(pcs, prevVoicing, low, high);
        prevVoicing = voicing;
        let padDur = 3.8;
        // si l'accord suivant (même section) est identique, nappe tenue sur 2 mesures
        const nextChordSame = b + 1 < secBars &&
          chordFromDegree(rootMidi, scale, nextDeg, { seventh: seventhSec }).pitchClasses.join() === pcs.join();
        if (nextChordSame) padDur = 7.8;
        if (finalHold) padDur = 7.8;
        if (isLoopLastBar) padDur = 3.9;
        const [t, vel] = humanize(beat0, 0.52 * (section.texture === 'light' ? 0.85 : 1));
        push({ t, dur: padDur, midi: voicing[0], vel: vel * 0.55, inst: style.pad.inst, pan: 0, bus: 'pad' });
        push({ t: t + 0.004, dur: padDur, midi: voicing[1] ?? voicing[0], vel: vel * 0.5, inst: style.pad.inst, pan: 0.1, bus: 'pad' });
        if (voicing[2]) push({ t: t + 0.002, dur: padDur, midi: voicing[2], vel: vel * 0.45, inst: style.pad.inst, pan: -0.1, bus: 'pad' });
      }

      /* ---- basse ---- */
      if (style.bass) {
        addBass(push, humanize, style, absBar, beat0, chord, rootMidi, scale, progDeg, nextDeg, {
          texture: section.texture, isLoopLastBar, finalHold, seventhSec, rng,
        });
      }

      /* ---- batterie ---- */
      if (style.drums && section.texture !== 'none') {
        addDrums(push, humanize, style, absBar, secStart, b, secBars, bars, section, isLoopLastBar);
      }

      /* ---- arpèges ---- */
      if (style.arp && style.arp.enabled && section.texture !== 'none') {
        addArp(push, humanize, style, beat0, chord, key.root, rng, section, isLoopLastBar);
      }

      /* ---- mélodie (générée par phrases de 2 mesures) ---- */
      if (style.melody && section.melodyOn && section.texture !== 'none' && b % 2 === 0) {
        melodyState = addMelodyPhrase(push, humanize, style, rng, {
          startBar: absBar, secStart, secBars, b, prog: section.prog, rootMidi, scale, key,
          chordAt: (deg) => chordFromDegree(rootMidi, scale, deg, { seventh: seventhSec }),
          seventhSec, isLoopLastPhrase: isLoopLastBar && b + 2 >= secBars,
          motif: melodyState,
          phraseIndex: b / 2,
        });
      }
    }
  }

  const fx = {
    room: style.fx.room, damp: style.fx.damp,
    wet: style.fx.wet, delay: style.fx.delay,
    delayBeats: style.fx.delayBeats, delayFb: style.fx.delayFb,
  };

  // noms d'accords pour les métadonnées
  const progNames = progA.map((deg) => chordFromDegree(rootMidi, scale, deg, { seventh: seventhOn }).name);
  const progRomans = progA.map((deg) => chordFromDegree(rootMidi, scale, deg, { seventh: seventhOn }).roman);
  const progNamesB = progB.map((deg) => chordFromDegree(rootMidi, scale, deg, { seventh: seventhOn }).name);

  const keyLabel = `${SHARPS[key.root].toLowerCase()} ${scale.label}`;
  const actualDur = Math.round(totalBeats * (60 / bpm) * 100) / 100;

  const meta = {
    style: styleId,
    styleLabel: style.label,
    description: style.desc,
    key: `${SHARPS[key.root]} ${scale.labelEn}`,
    keyFr: keyLabel,
    tempo: bpm,
    bars,
    durationSeconds: actualDur,
    loop,
    seed,
    progression: progNames.join(' – '),
    progressionRomans: progRomans.join(' – '),
    progressionB: progNamesB.join(' – '),
    sections: sections.map((s) => ({ name: s.name, bars: Math.round(s.bars) })),
    idealFor: style.use,
    title: params.title || null,
  };

  return {
    events,
    bpm,
    bars,
    totalBeats,
    loop,
    sr,
    mono,
    fx,
    meta,
    endFade: !loop ? 1.8 : 0,
  };
}

/* ------------------------------ conduite de voix ------------------------------ */

function voiceChord(pcs, prev, low, high) {
  const cands = (pc) => {
    const out = [];
    for (let m = low; m <= high; m++) if (((m % 12) + 12) % 12 === ((pc % 12) + 12) % 12) out.push(m);
    return out;
  };
  if (!prev || !prev.length) {
    return pcs.map((pc) => {
      const cs = cands(pc);
      // choix centré
      const target = low + 8;
      cs.sort((a, b) => Math.abs(a - target) - Math.abs(b - target));
      return cs[0];
    }).sort((a, b) => a - b);
  }
  const used = new Set();
  const out = [];
  const prevSorted = [...prev].sort((a, b) => a - b);
  for (const p of prevSorted) {
    let best = null, bestD = 1e9;
    for (const pc of pcs) {
      for (const c of cands(pc)) {
        if (used.has(c)) continue;
        const d = Math.abs(c - p);
        if (d < bestD) { bestD = d; best = c; }
      }
    }
    if (best !== null) { used.add(best); out.push(best); }
  }
  // accord plus riche que la nappe précédente : ajouter les pcs manquants
  for (const pc of pcs) {
    const cs = cands(pc).filter((c) => !used.has(c));
    if (cs.length && out.length < pcs.length) {
      const target = out.length ? (out[out.length - 1] + low) / 2 : low + 8;
      cs.sort((a, b) => Math.abs(a - target) - Math.abs(b - target));
      used.add(cs[0]); out.push(cs[0]);
    }
  }
  return out.sort((a, b) => a - b);
}

/* ------------------------------ basse ------------------------------ */

function addBass(push, humanize, style, absBar, beat0, chord, rootMidi, scale, progDeg, nextDeg, ctx) {
  const cfg = style.bass;
  const base = 12 * (cfg.octave + 1) + (((rootMidi % 12) + 12) % 12);
  const inst = 'bass';
  const rootM = chord.notes[0];
  const bassMidi = rootM - 12 + ((rootM - 12 < base - 6) ? 12 : 0); // autour de l'octave voulue
  const fifthM = chord.notes[2] - 12 + ((chord.notes[2] - 12 < base - 6) ? 12 : 0);
  const thirdM = chord.notes[1] - 12 + ((chord.notes[1] - 12 < base - 6) ? 12 : 0);

  const add = (t, dur, midi, vel, instOv) => {
    const [tt, v] = humanize(t, vel);
    push({ t: tt, dur, midi, vel: v, inst: instOv || inst, pan: 0, bus: 'bass' });
    if (cfg.sub && (instOv || inst) === 'bass') {
      push({ t: tt, dur, midi: midi - 12, vel: v * 0.7, inst: 'sub', pan: 0, bus: 'bass' });
    }
  };

  const rootOnly = () => add(beat0, 3.7, bassMidi, 0.85);

  switch (cfg.style) {
    case 'sustain':
      rootOnly();
      break;
    case 'epic':
      add(beat0, 3.6, bassMidi, 0.9);
      break;
    case 'sparse':
      rootOnly();
      if (ctx.rng.chance(0.5) && !ctx.isLoopLastBar) add(beat0 + 2.5, 1.2, ctx.rng.chance(0.5) ? fifthM : bassMidi, 0.6);
      break;
    case 'quarters': {
      for (let q = 0; q < 4; q++) {
        const m = q === 3 && ctx.rng.chance(0.35) ? fifthM : bassMidi;
        add(beat0 + q, 0.85, m, q === 0 ? 0.85 : 0.65);
      }
      break;
    }
    case 'eighths': {
      for (let e = 0; e < 8; e++) {
        add(beat0 + e * 0.5, 0.42, bassMidi, e % 2 === 0 ? 0.85 : 0.6);
      }
      break;
    }
    case 'octave': {
      for (let e = 0; e < 8; e++) {
        const m = e % 2 === 0 ? bassMidi : bassMidi + 12;
        add(beat0 + e * 0.5, 0.42, m, e % 2 === 0 ? 0.85 : 0.7);
      }
      break;
    }
    case 'walk': {
      const seq = [bassMidi, ctx.rng.chance(0.6) ? fifthM : bassMidi, thirdM];
      for (let q = 0; q < 3; q++) add(beat0 + q, 0.9, seq[q], q === 0 ? 0.85 : 0.6);
      // note d'approche vers la tonique suivante
      const nextRootDeg = nextDeg;
      const appr = rootMidi + degreeSemitone(scale, nextRootDeg) - 12;
      const below = appr - 1;
      add(beat0 + 3, 0.9, ctx.rng.chance(0.5) ? below : appr + 1, 0.5);
      break;
    }
    case 'lofi': {
      add(beat0, 1.8, bassMidi, 0.85);
      if (!ctx.isLoopLastBar) {
        add(beat0 + 2.5, 1.2, ctx.rng.chance(0.4) ? fifthM : bassMidi, 0.6);
        if (ctx.rng.chance(0.3)) add(beat0 + 3.75, 0.22, bassMidi + (ctx.rng.chance(0.5) ? 1 : -1) * 1, 0.4);
      }
      break;
    }
    default:
      rootOnly();
  }
}

/* ------------------------------ batterie ------------------------------ */

const DRUM_PAN = { kick: 0, snare: 0, hat: 0.15, ohat: 0.2, clap: 0.05, shaker: 0.25, tom: -0.15 };

function addDrums(push, humanize, style, absBar, secStart, b, secBars, totalBars, section, isLoopLastBar) {
  const d = style.drums;
  const gBar = absBar - secStart; // barre dans la section
  const level = section.texture;

  const stepEvents = [];
  const addStep = (inst, step, vel) => {
    stepEvents.push({ inst, step, vel });
  };

  const applyConfig = (key, cfg) => {
    if (!cfg) return;
    if (Array.isArray(cfg)) {
      for (const [st, v] of cfg) addStep(key, st, v);
      return;
    }
    if (cfg.prob !== undefined && !deterministicChance(absBar, key, cfg.prob)) return;
    if (cfg.step !== undefined && cfg.steps === undefined) {
      // frappe unique : { step, vel, prob? }
      addStep(key, cfg.step, cfg.vel ?? 0.3);
      return;
    }
    if (cfg.every !== undefined && (absBar % cfg.every) !== 0) return;
    if (cfg.steps) {
      for (const [st, v] of cfg.steps) addStep(key, st, v);
      return;
    }
    if (Array.isArray(cfg.vel) || typeof cfg.vel === 'number') {
      const every = cfg.every || 2;
      const vels = Array.isArray(cfg.vel) ? cfg.vel : [cfg.vel];
      for (let st = 0; st < 16; st += every) addStep(key, st, vels[(st / every) % vels.length]);
    }
  };

  // chance déterministe par mesure pour les éléments probables
  function deterministicChance(bar, key2, p) {
    let h = Math.imul(bar * 31 + key2.length * 7, 2654435761) >>> 0;
    h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995) >>> 0;
    return ((h >>> 0) % 1000) / 1000 < p;
  }

  const instMap = { kick: 'kick', snare: 'snare', hat: 'hat', open: 'ohat', clap: 'clap', shaker: 'shaker', tom: 'tom' };

  for (const key of Object.keys(instMap)) {
    if (key === 'hat' && level === 'light') {
      // version allégée : charley sur les temps
      for (let q = 0; q < 4; q++) addStep('hat', q * 4, 0.22);
      continue;
    }
    applyConfig(key, d[key]);
  }
  if (d.ghostKick && level === 'full' && deterministicChance(absBar, 'gk', d.ghostKick.prob)) {
    addStep('kick', d.ghostKick.step, d.ghostKick.vel);
  }
  if (level === 'light') {
    if (d.kick) {
      const first = Array.isArray(d.kick) ? d.kick[0] : null;
      if (first) addStep('kick', first[0], (first[1]) * 0.7);
    }
  }
  // fill de fin de groupe
  if (d.fill && level === 'full' && !isLoopLastBar) {
    const every = d.fill.every || 8;
    if ((absBar + 1) % every === 0) {
      for (const [st, v] of d.fill.steps) addStep(d.fill.inst || 'snare', st, v);
    }
  }

  for (const e of stepEvents) {
    const drum = instMap[e.inst] || e.inst;
    const [tt, v] = humanize((absBar * 4) + e.step * 0.25, e.vel);
    push({ t: tt, dur: 0, vel: v, drum, inst: drum, pan: DRUM_PAN[drum] || 0, bus: 'drum' });
  }
}

/* ------------------------------ arpèges ------------------------------ */

function addArp(push, humanize, style, beat0, chord, rootPc, rng, section, isLoopLastBar) {
  const cfg = style.arp;
  if (!rng.chance(cfg.probPerBar)) return;
  const grid = cfg.grid; // 2 = croches, 1 = doubles-croches
  const slots = 8 / grid; // notes par mesure
  const base = 12 * (cfg.octave + 1) + rootPc;
  const pcs = chord.pitchClasses;
  const notes = pcs.map((pc) => {
    let m = base + ((pc - rootPc + 12) % 12);
    while (m > base + 14) m -= 12;
    while (m < base - 2) m += 12;
    return m;
  }).sort((a, b) => a - b);

  let seq;
  if (cfg.pattern === 'up') seq = null; // continu ascendant
  else if (cfg.pattern === 'broken') seq = [0, 2, 1, 2];
  else seq = [0, 1, 2, 1]; // updown par défaut

  for (let k = 0; k < slots; k++) {
    if (isLoopLastBar && k === slots - 1) break;
    let midi, vel;
    if (cfg.pattern === 'up') {
      const idx = k % notes.length;
      const oct = Math.floor(k / notes.length) * 12;
      midi = notes[idx] + oct;
      vel = 0.42 + (k % notes.length === 0 ? 0.12 : 0);
    } else {
      const s = seq[k % seq.length];
      midi = notes[s % notes.length] + (s >= notes.length ? 12 : 0);
      vel = 0.4 + (k % 2 === 0 ? 0.1 : 0);
    }
    const t = beat0 + k * grid * 0.5;
    const [tt, v] = humanize(t, vel);
    push({
      t: tt, dur: grid * 0.5 * (cfg.inst === 'ks' ? 1.1 : 0.85), midi,
      vel: v, inst: cfg.inst, pan: k % 2 === 0 ? -0.25 : 0.25, bus: 'arp',
    });
  }
}

/* ------------------------------ mélodie ------------------------------ */

/**
 * Génère une phrase de 2 mesures à partir d'un motif (ou en crée un).
 * Retourne l'état (motif) pour la phrase suivante.
 */
function addMelodyPhrase(push, humanize, style, rng, ctx) {
  const m = style.melody;
  const grid = m.grid; // 2 = croches
  const slotsPerBar = 4 * grid;
  const phraseSlots = slotsPerBar * 2;
  const melBase = 12 * (m.octave + 1) + ctx.key.root + (ctx.melOctOffset || 0) * 12;

  // --- motif (rythme + degrés) ---
  let motif = ctx.motif;
  if (!motif) {
    const len = m.motifLen || 4;
    const rhythm = [];
    let cur = 0;
    for (let i = 0; i < len; i++) {
      let lenSlots;
      if (i === len - 1) lenSlots = Math.max(2, Math.min(6, phraseSlots * 0.75 - cur));
      else lenSlots = rng.weighted([1, 1, 1, 2, 2, 3, 4], (w) => w === 1 ? 5 : w === 2 ? 3 : w === 3 ? 1.5 : 1);
      if (cur + lenSlots > phraseSlots - 2) lenSlots = Math.max(1, phraseSlots - 2 - cur);
      rhythm.push({ off: cur, len: lenSlots });
      cur += lenSlots + (rng.chance(m.restProb * 0.5) ? 1 : 0);
      if (cur >= phraseSlots - 3) break;
    }
    const startDeg = rng.pick([0, 4, 2, 5]);
    const degs = [startDeg];
    for (let i = 1; i < rhythm.length; i++) {
      const step = rng.weighted(
        [-2, -1, -1, 1, 1, 2, 3, -3, 4, -4],
        (w) => Math.abs(w) <= 1 ? 4 : Math.abs(w) === 2 ? 3 : Math.abs(w) === 3 ? 1.2 : 0.7,
      );
      let d = degs[i - 1] + step;
      if (d < -2) d += rng.int(1, 3);
      if (d > 9) d -= rng.int(1, 3);
      degs.push(d);
    }
    motif = { rhythm, degs, variation: 0 };
  } else {
    // variation de la phrase : transposition ou mouvement miroir
    motif.variation = (motif.variation + 1) % 3;
    if (motif.variation === 1) motif = { ...motif, degShift: rng.pick([1, 2, -1, -2, 0]) };
    if (motif.variation === 2) motif = { ...motif, mirror: true };
  }

  const degShift = motif.degShift || 0;
  const mirror = !!motif.mirror;
  const chordToneDegs = (deg) => [deg, deg + 2, deg + 4];

  const snapToChord = (noteDeg, barDeg) => {
    const cands = [];
    for (const cd of chordToneDegs(barDeg)) {
      for (let oct = -2; oct <= 2; oct++) cands.push(cd + oct * 7);
    }
    let best = noteDeg, bestD = 1e9;
    for (const c of cands) {
      const d = Math.abs(c - noteDeg);
      if (d < bestD) { bestD = d; best = c; }
    }
    return bestD <= 2 ? best : noteDeg;
  };

  const isPhraseEnd = ctx.isLoopLastPhrase || (!ctx.isLoopLastPhrase && ctx.b + 2 >= ctx.secBars && rng.chance(0.6));

  const rhythm = motif.rhythm;
  for (let i = 0; i < rhythm.length; i++) {
    const { off, len } = rhythm[i];
    let deg = motif.degs[i];
    if (mirror) deg = 4 - deg; // inversion autour du 3e degré
    deg += degShift;

    // position absolue
    const barAbs = ctx.startBar + Math.floor(off / slotsPerBar);
    const barInPhrase = Math.floor(off / slotsPerBar);
    const barDeg = ctx.prog[(barAbs - ctx.secStart) % ctx.prog.length];
    const beatInBar = (off % slotsPerBar) / grid;
    const onBeat = (off % grid) === 0 && (beatInBar % 1) === 0 && (off % (grid * 2)) === 0;

    if (onBeat || rng.chance(0.35)) deg = snapToChord(deg, barDeg);

    // fin de phrase : résolution vers la tonique
    if (isPhraseEnd && i === rhythm.length - 1) {
      deg = barDeg + (rng.chance(0.7) ? 0 : 4); // tonique ou quinte
    }

    let midi = melBase + degreeSemitone(ctx.scale, deg);
    // clamp du registre
    while (midi > melBase + 17) midi -= 12;
    while (midi < melBase - 7) midi += 12;

    const t = (barAbs * 4) + beatInBar;
    let dur = len / grid;
    dur *= m.legato || 1;
    // accent sur les temps forts, plus doux en fin de phrase
    let vel = (off % (grid * 2) === 0 ? 0.9 : 0.72) * (isPhraseEnd && i === rhythm.length - 1 ? 0.9 : 1);
    const [tt, v] = humanize(t, vel);
    push({
      t: tt, dur, midi, vel: v, inst: m.inst, pan: rng.f(-0.12, 0.12),
      bus: 'mel', vib: m.vibrato || 0,
    });
  }

  return motif;
}

module.exports = { createSong };
