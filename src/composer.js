'use strict';

const { ui } = require('./language');

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

const { makeRng, randomSeed, hash32 } = require('./rng');
const { SCALES, SHARPS, parseKey, parseNote, degreeSemitone, chordFromDegree, chordFromSymbol, midiToFreq } = require('./theory');
const { STYLES } = require('./styles');
const { readArrangement } = require('./arrangement');
const { musicClock } = require('./music-clock');
const { applySounds } = require('./section-sounds');
const { applyOrchestralPercussion, readOrchestralPercussion } = require('./orchestral-percussion');
const { readPhrasing, lyricalMotif, transformMotif, addLyricalPhrase, addLyricalAnswers } = require('./melodic-phrasing');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Position de fader de style (0..1) → gain de bus.
 * Les styles décrivent des niveaux de mixeur (0.16 = nappe discrète, 0.7 =
 * nappe ample). On les recentre sur 0.5 = neutre et on adoucit par une racine
 * carrée : sans ça les extrêmes enterrent un pupitre ou écrasent le reste.
 */
const faderGain = (g) => (g == null ? 1 : Math.sqrt(g / 0.5));

const octaveMidi = (pc, oct) => 12 * (oct + 1) + pc;
const chordVoicing = (chord) => chord.explicit && chord.pitchClasses.length >= 5
  ? [chord.pitchClasses[0], chord.pitchClasses[1], chord.pitchClasses[3], chord.pitchClasses.at(-1)]
  : chord.pitchClasses;

/* ------------------------------ composition ------------------------------ */

/**
 * params: { style, duration_seconds, tempo, key, seed, loop, title }
 * retourne song: { events, bpm, bars, totalBeats, loop, fx, meta, endFade }
 */
function createSong(params) {
  const percussion = readOrchestralPercussion(params.orchestral_percussion);
  const styleId = params.style;
  const style = STYLES[styleId];
  if (!Object.hasOwn(STYLES, styleId)) throw new Error(ui(`Style inconnu: ${styleId}. Styles valides: ${Object.keys(STYLES).join(', ')}`, `Unknown style: ${styleId}. Valid styles: ${Object.keys(STYLES).join(', ')}`));

  const seed = params.seed === undefined ? randomSeed() : params.seed >>> 0;
  const rng = makeRng(seed);
  const phrasing = readPhrasing(params.phrasing);
  const melody = phrasing === 'lyrical' && style.melody
    ? { ...style.melody, octave: Math.min(4, style.melody.octave) }
    : style.melody;

  if (params.tempo !== undefined && !Number.isFinite(params.tempo)) throw new Error(ui('Tempo invalide.', 'Invalid tempo.'));
  if (params.duration_seconds !== undefined && !Number.isFinite(params.duration_seconds)) throw new Error(ui('Durée invalide.', 'Invalid duration.'));
  const bpm = clamp(Math.round(params.tempo ?? style.defaults.tempo), 40, 220);
  const durSec = clamp(params.duration_seconds ?? style.defaults.duration, 5, 600);
  const loop = params.loop !== undefined ? !!params.loop : !!style.defaults.loop;
  const sr = [22050, 44100, 48000].includes(params.sr) ? params.sr : 44100;
  const mono = !!params.mono;

  // tonalité
  let key = parseKey(params.key);
  if (params.key !== undefined && !key) throw new Error(ui(`Tonalité invalide : ${params.key}.`, `Invalid key: ${params.key}.`));
  if (!key) {
    const rootPc = parseNote(rng.pick(style.defaults.rootPool)) ?? rng.int(0, 11);
    const scaleId = rng.pick(style.defaults.scalePool);
    key = { root: rootPc, scaleId };
  }
  const scale = SCALES[key.scaleId];

  const pool = style.progressions[key.scaleId] || style.progressions[Object.keys(style.progressions)[0]];
  const progA = rng.pick(pool);
  let progB = rng.pick(pool);
  if (pool.length > 1 && progB === progA) progB = pool[(pool.indexOf(progA) + 1) % pool.length];
  const targetBars = clamp(Math.round(durSec * bpm / 240), 1, Math.floor(600 * bpm / 240));
  const { sections, motif, custom } = readArrangement(params.arrangement, targetBars, loop, progA, progB);
  const bars = sections.reduce((sum, section) => sum + section.bars, 0);
  const totalBeats = bars * 4;
  const clock = musicClock({ bars, totalBeats, bpm, meta: { sections: sections.map((section, index) => ({ ...section,
    startBar: 1 + sections.slice(0, index).reduce((sum, previous) => sum + previous.bars, 0) })) } });
  if (clock.seconds > 600 + 1e-8) throw new Error(ui('La durée des sections dépasse 600 secondes.', 'Section durations exceed 600 seconds.'));

  /* ------- événements ------- */
  const events = [];
  let seedIdx = 0;
  const seventhOn = rng.chance(style.seventh);
  const degrees = sections.flatMap(({ bars: length, prog, key: local }) => Array.from({ length }, (_, b) => ({
    spec: prog[b % prog.length], key: local || key,
  })));
  if (!loop && !custom) {
    degrees[bars - 1].spec = 0;
    if (bars > 1) degrees[bars - 2].spec = 4;
  }
  const chordInKey = (spec, local, ninth = false) => typeof spec === 'string' ? chordFromSymbol(spec)
    : chordFromDegree(48 + local.root, SCALES[local.scaleId], spec, { seventh: seventhOn, ninth });
  const harmony = degrees.map(({ spec, key: local }, bar) => {
    const ninth = (loop || bar < bars - 2) && rng.chance((style.ninthColor || 0) * 0.4);
    const changes = Array.isArray(spec) ? spec : [{ beat: 0, chord: spec }];
    return changes.map((change) => ({ beat: change.beat, chord: chordInKey(change.chord, local, ninth) }));
  });
  const motifs = new Map();
  const push = (ev) => {
    ev.t = Math.max(0, ev.t);
    ev.seedIdx = hash32(seed, seedIdx++);
    if (ev.midi !== undefined) ev.freq = midiToFreq(ev.midi);
    events.push(ev);
    return ev;
  };
  const humanize = (t, vel) => {
    let tt = t;
    if (style.swing > 0) {
      // swing sur les croches décalées (slots impairs d'une grille binaire)
      const slotFloat = (tt * 2) % 2;
      if (Math.abs(slotFloat - 1) < 1e-6) tt += style.swing * 0.29;
    }
    tt += rng.f(-0.008, 0.008);
    return [tt, clamp(vel * rng.f(0.93, 1.07), 0.05, 1)];
  };

  let prevVoicing = null;
  let previousPad = [], previousChord;
  let previousLead;
  let barIdx = 0;

  for (const section of sections) {
    const fromBar = barIdx;
    const secBars = section.bars;
    const lastSection = section === sections[sections.length - 1];
    const has = (part) => section.parts.includes(part);
    const intensity = section.energy;
    const customMotif = section.motif ?? motif;
    const localKey = section.key ?? key;
    const localScale = SCALES[localKey.scaleId];
    previousPad = [];
    for (let b = 0; b < secBars; b++, barIdx++) {
      const absBar = barIdx;
      const beat0 = absBar * 4;
      const isLoopLastBar = loop && absBar === bars - 1;
      const finalHold = !custom && !loop && absBar === bars - 1;
      const breakdown = section.breakdown && secBars >= 4;
      const changes = harmony[absBar];
      const nextBar = harmony[absBar + 1] ?? (loop ? harmony[0] : changes);

      // Pour les mesures à accord unique, la batterie conserve son placement dans la génération.
      const addBarDrums = () => {
        if (!style.drums || !has('drum') || (breakdown && b < 2)) return;
        const meter = section.meter;
        if (meter && meter.join('/') !== '4/4') {
          addMeterDrums(push, humanize, style.drums, beat0, meter, intensity, finalHold);
          return;
        }
        addDrums(push, humanize, style, absBar, { seed, isLoopLastBar, finalHold, intensity,
          entrance: (b === 0 && absBar > 0) || (breakdown && b === 2), transition: b === secBars - 1 && !lastSection });
      };

      for (const [i, change] of changes.entries()) {
        const { chord, beat } = change;
        const nextChange = changes[i + 1];
        const nextChord = nextChange?.chord ?? nextBar[0].chord;
        const onset = beat0 + beat;
        const stop = beat0 + (nextChange?.beat ?? 4);
        const clippedPush = changes.length === 1 ? push : (event) => {
          event.t = Math.max(onset, event.t);
          if (stop - event.t < 0.03) return;
          push({ ...event, dur: Math.min(event.dur, stop - event.t) });
        };

        if (style.pad && has('pad')) {
          const end = finalHold ? stop + 0.6 : stop - Math.min(0.13, (stop - onset) * 0.1);
          if (previousPad.length && previousChord === chord.name) {
            for (const ev of previousPad) ev.dur = end - ev.t;
          } else {
            const low = octaveMidi(localKey.root, style.pad.octave) - 2;
            prevVoicing = voiceChord(chordVoicing(chord), prevVoicing, low, low + 26);
            const [t, vel] = humanize(onset, 0.52 * Math.sqrt(intensity));
            const pans = [-0.11, 0.18, -0.21, 0.25];
            const vels = [0.55, 0.5, 0.45, 0.38];
            previousPad = prevVoicing.map((midi, vi) => {
              const attack = Math.max(changes.length === 1 ? 0 : onset, t + vi * 0.004);
              return push({ t: attack, beat: onset, dur: end - attack, midi, vel: vel * vels[vi], inst: style.pad.inst,
                pan: pans[vi], bus: 'pad', gain: faderGain(style.pad.gain) });
            });
          }
          previousChord = chord.name;
        }

        if (style.bass && has('bass')) {
          addBass(clippedPush, humanize, style, onset, chord, nextChord, { isLoopLastBar, finalHold, rng, intensity });
        }

        if (i === 0) addBarDrums();

        if (style.arp?.enabled && has('arp') && !finalHold) {
          const config = phrasing === 'lyrical' && b % 4 >= 2 && ['up', 'updown', 'broken'].includes(style.arp.pattern)
            ? { ...style, arp: { ...style.arp, pattern: style.arp.pattern === 'broken' ? 'updown' : 'broken' } } : style;
          addArp(clippedPush, humanize, config, onset, chord, localKey.root, rng, isLoopLastBar && !custom, intensity, custom);
        }
      }

      /* ---- mélodie (générée par phrases de 2 mesures) ---- */
      if (melody && has('mel') && b % 2 === 0) {
        if (!customMotif && !motifs.has(section.theme)) {
          const themeRng = makeRng(hash32(seed, section.theme.charCodeAt(0)));
          motifs.set(section.theme, phrasing === 'lyrical' ? lyricalMotif(themeRng, section.theme) : buildMotif(themeRng, melody, 4 * melody.grid));
        }
        const phrase = {
          startBar: absBar, length: Math.min(2, secBars - b), harmony, scale: localScale, key: localKey,
          motif: customMotif || motifs.get(section.theme), exact: Boolean(customMotif), themeTreatment: section.theme_treatment, withAnswer: has('counter'),
          variation: (section.variation ?? 0) + b / 2, intensity, outro: section.outro,
          final: !loop && absBar + 2 >= bars, loopEnd: loop && absBar + 2 >= bars,
        };
        previousLead = phrasing === 'lyrical' && !customMotif
          ? addLyricalPhrase(push, humanize, melody, { ...phrase, previous: previousLead })
          : addMelodyPhrase(push, humanize, melody, { ...phrase, motif: transformMotif(phrase.motif, phrase.themeTreatment, localKey) });
      }
      if (phrasing !== 'lyrical' && has('counter') && !finalHold) {
        const pulses = section.meter?.[0] ?? 4;
        const positions = [beat0 + 4 / pulses, beat0 + 4 * (pulses - 1) / pulses];
        for (const [i, beat] of [...new Set(positions)].entries()) {
          const leadNearby = events.some((e) => e.bus === 'mel' && e.beat >= beat - 0.17 && e.beat < beat + 0.35);
          if (leadNearby && i === 0) continue;
          const chord = changes.reduce((active, change) => change.beat <= beat - beat0 ? change.chord : active, changes[0].chord);
          const midi = 53 + ((chord.notes[i + 1] - 53 + 24) % 12);
          const [t, vel] = humanize(beat, 0.35 * Math.sqrt(intensity));
          push({ t, beat, dur: Math.min(0.95, beat0 + 3.92 - t), midi, vel, inst: 'clarinet', pan: -0.24, bus: 'counter', articulation: 'legato' });
        }
      }
    }
    if (phrasing === 'lyrical' && has('counter')) {
      const lead = events.filter((event) => event.bus === 'mel' && event.t < barIdx * 4 && event.t + event.dur > fromBar * 4)
        .sort((a, b) => a.t - b.t);
      addLyricalAnswers(push, lead, section, fromBar, harmony);
    }
  }
  if (phrasing === 'lyrical') {
    const supportGain = { arp: 0.75, counter: 0.78, drum: 0.9 };
    let start = 0;
    const leadSections = sections.map((section) => {
      const from = start;
      start += section.bars * 4;
      return section.parts.includes('mel') ? { from, to: start } : null;
    }).filter(Boolean);
    for (const event of events) {
      const gain = supportGain[event.bus];
      const beat = event.beat ?? event.t;
      if (gain && leadSections.some(({ from, to }) => beat >= from && beat < to)) event.gain = (event.gain ?? 1) * gain;
    }
  }

  const takes = new Map();
  for (const event of [...events].sort((a, b) => a.t - b.t)) {
    event.take = takes.get(event.inst) ?? (seed & 1);
    takes.set(event.inst, event.take + 1);
  }

  const fx = {
    room: style.fx.room, damp: style.fx.damp,
    wet: style.fx.wet, delay: style.fx.delay,
    delayBeats: style.fx.delayBeats, delayFb: style.fx.delayFb,
  };

  // noms d'accords pour les métadonnées
  const primary = custom ? sections.find((s) => s.theme === 'A' && s.parts.includes('mel')) ?? sections[0] : { prog: progA };
  const secondary = custom ? sections.find((s) => s.theme === 'B') ?? { prog: [] } : { prog: progB };
  const names = (section, field) => section.prog.map((spec) => {
    const changes = Array.isArray(spec) ? spec : [{ chord: spec }];
    return changes.map((change) => chordInKey(change.chord, section.key ?? key)[field]).join(' / ');
  });

  const keyLabel = `${SHARPS[key.root].toLowerCase()} ${scale.label}`;
  const actualDur = Math.round(clock.seconds * 100) / 100;
  let sectionStart = 0;
  const styleParts = { pad: style.pad, arp: style.arp?.enabled, bass: style.bass, drum: style.drums, mel: style.melody, counter: true };

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
    progression: names(primary, 'name').join(' – '),
    progressionRomans: names(primary, 'roman').join(' – '),
    progressionB: names(secondary, 'name').join(' – '),
    instrumental: true,
    ...(phrasing === 'lyrical' ? { phrasing } : {}),
    sections: sections.map((s) => {
      const start = sectionStart;
      sectionStart += s.bars;
      const orchestral = s.orchestral_percussion ?? (s.parts.includes('drum') ? percussion : undefined);
      return { name: s.name, bars: s.bars, startBar: start + 1, theme: s.theme, energy: s.energy,
        ...(s.theme_treatment ? { theme_treatment: s.theme_treatment } : {}),
        ...(s.variation ? { variation: s.variation } : {}),
        ...((s.motif ?? motif) ? { motif: s.motif ?? motif } : {}),
        parts: s.parts.filter((part) => Boolean(styleParts[part])),
        ...(s.tempo !== undefined ? { tempo: s.tempo } : {}), ...(s.meter ? { meter: s.meter } : {}),
        ...(s.color ? { color: s.color } : {}), ...(s.instruments ? { instruments: s.instruments } : {}),
        ...(s.textures ? { textures: s.textures } : {}),
        ...(orchestral !== undefined ? { orchestral_percussion: orchestral } : {}),
        ...(s.key ? { key: `${SHARPS[s.key.root]} ${SCALES[s.key.scaleId].labelEn}` } : {}),
        chords: harmony.slice(start, sectionStart).map((changes) => changes.map(({ chord }) => chord.name).join(' → ')),
        harmony: harmony.slice(start, sectionStart).map((changes) => changes.map(({ beat, chord }) => ({ beat, chord: chord.name }))) };
    }),
    idealFor: style.use,
    title: params.title || null,
  };

  const song = applyOrchestralPercussion(applySounds({
    events,
    bpm,
    bars,
    totalBeats,
    loop,
    sr,
    mono,
    palette: params.palette ?? 'synth',
    bankVersion: 2,
    ...(params.patches && Object.keys(params.patches).length ? { patches: params.patches } : {}),
    fx,
    meta,
    endFade: !loop ? 1.4 : 0,
  }, params.sound_design));
  if (!song.events.length) throw new Error(ui('L’arrangement ne produit aucune note avec ce style.', 'The arrangement produces no notes in this style.'));
  return song;
}

/* ------------------------------ conduite de voix ------------------------------ */

/**
 * Choisit un renversement de l'accord en évaluant plusieurs candidats.
 * Critères (comme un arrangeur humain) :
 *  - mouvement minimal depuis la nappe précédente (voix communes gratuites) ;
 *  - pas de saut > 9 demi-tons si évitable ;
 *  - espacement naturel : serré en haut, large en bas ;
 *  - pas de seconde/tierce collée dans le grave (boue) ;
 *  - registre centré, sans dérive cumulative.
 */
function voiceChord(pcs, prev, low, high) {
  const uniq = [];
  for (const pc of pcs) {
    const p = ((pc % 12) + 12) % 12;
    if (!uniq.includes(p)) uniq.push(p);
  }
  if (!uniq.length) return prev ? [...prev] : [low];

  const positions = uniq.map((pc) => {
    const out = [];
    for (let m = low; m <= high; m++) if ((((m % 12) + 12) % 12) === pc) out.push(m);
    return out;
  });

  const nVoices = 4;
  // options par hauteur : sauter, prendre une note, ou doubler à l'octave
  const opts = positions.map((ms) => {
    const list = [null];
    for (const m of ms) list.push([m]);
    for (const m of ms) if (m + 12 <= high) list.push([m, m + 12]);
    return list;
  });
  const combos = [];
  const walk = (idx, chosen) => {
    if (chosen.length > nVoices) return;
    if (idx === opts.length) {
      if (chosen.length === nVoices) combos.push([...chosen].sort((a, b) => a - b));
      return;
    }
    if (chosen.length + 2 * (opts.length - idx) < nVoices) return;
    for (const o of opts[idx]) {
      if (!o) walk(idx + 1, chosen);
      else if (chosen.length + o.length <= nVoices) walk(idx + 1, [...chosen, ...o]);
    }
  };
  walk(0, []);
  if (!combos.length) {
    // repli : une note par pc, la plus proche du centre
    const center = (low + high) / 2;
    return uniq.map((pc) => {
      let best = low, bd = 1e9;
      for (const m of positions[uniq.indexOf(pc)]) {
        const d = Math.abs(m - center);
        if (d < bd) { bd = d; best = m; }
      }
      return best;
    }).sort((a, b) => a - b);
  }

  const center = (low + high) / 2;
  const prevSorted = prev && prev.length ? [...prev].sort((a, b) => a - b) : null;

  const score = (v) => {
    let s = 0;
    const vCenter = (v[0] + v[v.length - 1]) / 2;
    s += Math.abs(vCenter - center) * 0.12;
    // un accord de 3-4 sons doit rester complet (pas de quinte creuse)
    for (let i = 0; i < uniq.length; i++) {
      if (!v.some((m) => m % 12 === uniq[i])) s += i === 2 && uniq.length === 5 ? 3 : 22;
    }
    for (let i = 1; i < v.length; i++) {
      const gap = v[i] - v[i - 1];
      if (gap < 2) s += 7;
      else if (gap > 12) s += (gap - 12) * 0.7;
    }
    // limite d'intervalle grave : pas de tierce/seconde sous le do central
    if (v[0] < 60 && v.length > 1) {
      const g = v[1] - v[0];
      if (g < 5) s += (5 - g) * 2.4;
    }
    if (prevSorted) {
      const used = new Set();
      let move = 0, big = 0, common = 0;
      for (const p of prevSorted) {
        let best = -1, bd = 1e9;
        for (let i = 0; i < v.length; i++) {
          if (used.has(i)) continue;
          const d = Math.abs(v[i] - p);
          if (d < bd) { bd = d; best = i; }
        }
        if (best >= 0) {
          used.add(best);
          move += bd;
          if (bd > 9) big += bd - 9;
          if (bd === 0) common += 1;
        }
      }
      s += move * 0.85 + big * 2.6 - common * 1.3;
      const pCenter = (prevSorted[0] + prevSorted[prevSorted.length - 1]) / 2;
      s += Math.abs(vCenter - pCenter) * 0.45;
    }
    return s;
  };

  let best = combos[0], bestScore = Infinity;
  for (const v of combos) {
    const sc = score(v);
    if (sc < bestScore) { bestScore = sc; best = v; }
  }
  return best;
}

/* ------------------------------ basse ------------------------------ */

function addBass(push, humanize, style, beat0, chord, nextChord, ctx) {
  const cfg = style.bass;
  const base = octaveMidi(0, cfg.octave);
  const inRegister = (midi) => base + (midi % 12);
  const inst = cfg.inst || 'bass';
  const [rootM, thirdM, fifthM] = chord.notes.map(inRegister);
  const bassMidi = chord.bassPc === undefined ? rootM : inRegister(chord.bassPc);
  const nextRoot = inRegister(nextChord.bassPc ?? nextChord.notes[0]);

  const add = (t, dur, midi, vel) => {
    const [tt, v] = humanize(t, vel * Math.sqrt(ctx.intensity));
    push({ t: tt, beat: t, dur, midi, vel: v, inst, pan: 0, bus: 'bass', gain: faderGain(cfg.gain) });
    if (cfg.sub && midi >= 40) {
      push({ t: tt, beat: t, dur, midi: midi - 12, vel: v * 0.58, inst: 'sub', pan: 0, bus: 'bass', gain: faderGain(cfg.gain) });
    }
  };

  if (ctx.finalHold) {
    add(beat0, 3.6, bassMidi, 0.77);
    return;
  }
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
      const pickup = nextRoot !== bassMidi && ctx.rng.chance(0.3);
      for (let q = 0; q < 4; q++) {
        const m = q === 3 && ctx.rng.chance(0.35) ? fifthM : bassMidi;
        add(beat0 + q, q === 3 && pickup ? 0.4 : 0.85, m, q === 0 ? 0.85 : 0.65);
      }
      if (pickup) add(beat0 + 3.5, 0.34, nextRoot - 1, 0.42);
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
      add(beat0 + 3, 0.81, nextRoot + (ctx.rng.chance(0.5) ? -1 : 1), 0.5);
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

const DRUM_PAN = { kick: 0, snare: 0, hat: 0.21, ohat: 0.26, clap: 0.05, shaker: -0.27, tom: -0.15, crash: -0.23, ride: -0.24 };

function addMeterDrums(push, humanize, kit, start, [beats, unit], energy, finalHold) {
  const compound = unit === 8 && beats % 3 === 0;
  for (let p = 0; p < (finalHold ? 1 : beats); p++) {
    const beat = start + p * 4 / beats;
    const drum = p === 0 ? (kit.kick ? 'kick' : 'shaker')
      : (p === (compound ? 3 : beats - 1) && kit.snare ? 'snare' : kit.ride ? 'ride' : kit.shaker ? 'shaker' : 'hat');
    const [t, vel] = humanize(beat, (p === 0 ? 0.78 : drum === 'snare' ? 0.5 : 0.24) * energy);
    push({ t, beat, dur: 0, vel, drum, inst: drum, pan: DRUM_PAN[drum], bus: 'drum', kit: kit.kit });
  }
}

function addDrums(push, humanize, style, absBar, { seed, isLoopLastBar, finalHold, intensity, entrance, transition }) {
  const d = style.drums;
  const stepEvents = new Map();
  const addStep = (inst, step, vel) => {
    if (finalHold && step !== 0) return;
    const id = `${inst}:${step}`;
    if (!stepEvents.has(id) || stepEvents.get(id).vel < vel) stepEvents.set(id, { inst, step, vel });
  };

  const applyConfig = (key, cfg) => {
    if (!cfg) return;
    if (Array.isArray(cfg)) {
      for (const [st, v] of cfg) addStep(key, st, v);
      return;
    }
    if (cfg.prob !== undefined && !deterministicChance(key, cfg.prob)) return;
    if (cfg.step !== undefined && cfg.steps === undefined) {
      // frappe unique : { step, vel, prob? }
      addStep(key, cfg.step, cfg.vel ?? 0.3);
      return;
    }
    if (cfg.steps) {
      if (cfg.every !== undefined && absBar % cfg.every !== 0) return;
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
  function deterministicChance(inst, p) {
    return hash32(seed ^ absBar, parseInt(inst, 36)) / 4294967296 < p;
  }

  const instMap = { kick: 'kick', snare: 'snare', hat: 'hat', open: 'ohat', clap: 'clap', shaker: 'shaker', tom: 'tom', ride: 'ride' };

  for (const key of Object.keys(instMap)) applyConfig(key, d[key]);
  if (d.ghostKick && deterministicChance('gk', d.ghostKick.prob)) {
    addStep('kick', d.ghostKick.step, d.ghostKick.vel);
  }
  if (d.ride && absBar % 2 === 1 && !finalHold) addStep('snare', 10, 0.21);
  if (d.fill && !isLoopLastBar && (transition || (absBar + 1) % (d.fill.every || 8) === 0)) {
    for (const [st, v] of d.fill.steps) addStep(d.fill.inst || 'snare', st, v * intensity);
  }
  if (entrance && intensity >= 0.8 && (d.open || d.kit === 'acoustic')) addStep('crash', 0, 0.52);

  for (const e of stepEvents.values()) {
    const drum = instMap[e.inst] || e.inst;
    let vel = e.vel;
    // accents naturels : charley sur les temps, caisse sur le contretemps
    if (drum === 'hat' && e.step % 4 === 0) vel *= 1.14;
    if (drum === 'snare' && e.step % 8 === 4) vel *= 1.06;
    // dynamique de section : intro/breakdown plus doux, montée vers la fin
    const dyn = drum === 'kick' || drum === 'snare' ? intensity : 0.82 + intensity * 0.18;
    const beat = absBar * 4 + e.step * 0.25;
    const [tt, v] = humanize(beat, clamp(vel * dyn, 0.05, 1));
    push({ t: tt, beat, dur: 0, vel: v, drum, inst: drum, pan: DRUM_PAN[drum] || 0, bus: 'drum', kit: d.kit,
      ...(drum === 'snare' && e.vel < 0.28 ? { articulation: 'ghost' } : {}) });
  }
}

/* ------------------------------ arpèges ------------------------------ */

function addArp(push, humanize, style, beat0, chord, rootPc, rng, isLoopLastBar, intensity, custom) {
  const cfg = style.arp;
  if (!rng.chance(custom ? cfg.probPerBar : cfg.probPerBar * (0.55 + intensity * 0.45))) return;
  const grid = cfg.grid; // 2 = noires, 1 = croches
  const slots = 8 / grid; // notes par mesure
  const base = 12 * (cfg.octave + 1) + rootPc;
  const pcs = chord.pitchClasses;
  const notes = pcs.map((pc) => {
    let m = base + ((pc - rootPc + 12) % 12);
    while (m > base + 14) m -= 12;
    while (m < base - 2) m += 12;
    return m;
  }).sort((a, b) => a - b);

  // alternance de direction d'une mesure à l'autre : évite l'effet mécanique
  const bar = Math.round(beat0 / 4);
  const flip = bar % 2 === 1;
  if (cfg.pattern === 'comp' || cfg.pattern === 'power') {
    const power = cfg.pattern === 'power';
    const lower = 12 * (cfg.octave + 1) + chord.pitchClasses[0];
    const pitches = chordVoicing(chord).map((pc) => lower + ((pc - lower % 12 + 12) % 12));
    if (pitches.length === 5) pitches.splice(2, 1);
    const voicing = power ? [lower, lower + 7, lower + 12] : pitches.sort((a, b) => a - b);
    const hits = power ? (flip ? [0, 1.5, 2, 3] : [0, 1, 2.5]) : (flip ? [0.5, 2.5] : [1, 2.5, 3.5]);
    for (const beat of hits) {
      const [t, vel] = humanize(beat0 + beat, (beat === 0 ? 0.58 : 0.44) * Math.sqrt(intensity));
      for (const [i, midi] of voicing.entries()) {
        push({ t: t + i * (power ? 0.013 : 0.006), beat: beat0 + beat, dur: beat >= 3 ? 0.32 : 0.62, midi, vel: vel / Math.sqrt(voicing.length),
          inst: cfg.inst, pan: -0.21 + i * 0.15, bus: 'arp', gain: faderGain(cfg.gain),
          ...(power && (beat % 1 || beat === 3) ? { articulation: 'mute' } : {}) });
      }
    }
    return;
  }

  let seq;
  if (cfg.pattern === 'up') seq = null; // continu ascendant (ou descendant si flip)
  else if (cfg.pattern === 'broken') seq = flip ? [2, 0, 1, 0] : [0, 2, 1, 2];
  else seq = flip ? [2, 1, 0, 1] : [0, 1, 2, 1]; // updown par défaut

  for (let k = 0; k < slots; k++) {
    if (isLoopLastBar && k === slots - 1) break;
    let midi, vel;
    if (cfg.pattern === 'up') {
      const idx = flip ? (notes.length - 1 - (k % notes.length) + notes.length) % notes.length : k % notes.length;
      const oct = (Math.floor(k / notes.length) % 2) * 12;
      midi = notes[idx] + oct;
      vel = 0.42 + (k % notes.length === 0 ? 0.12 : 0);
    } else {
      const s = seq[k % seq.length];
      midi = notes[s % notes.length] + (s >= notes.length ? 12 : 0);
      vel = 0.4 + (k % 2 === 0 ? 0.1 : 0);
    }
    // accent de début de mesure + dynamique de section
    if (k === 0) vel += 0.06;
    vel *= 0.78 + intensity * 0.22;
    const t = beat0 + k * grid * 0.5;
    const [tt, v] = humanize(t, vel);
    push({
      t: tt, beat: t, dur: grid * 0.5 * (cfg.inst === 'ks' ? 1.1 : 0.85), midi,
      vel: v, inst: cfg.inst, pan: k % 2 === 0 ? -0.25 : 0.25, bus: 'arp', gain: faderGain(cfg.gain),
    });
  }
}

/* ------------------------------ mélodie ------------------------------ */

/**
 * Construit un motif de 2 mesures : rythme (avec respirations) + degrés
 * d'échelle dessinant un contour (arche, descente, montée, vague).
 * La densité du style pilote le nombre de notes.
 */
function buildMotif(rng, m, slotsPerBar) {
  const phraseSlots = slotsPerBar * 2;
  const density = clamp(m.density ?? 0.5, 0.05, 1);
  const target = clamp(Math.round(2 + density * 9), 2, 11);
  const rhythm = [];
  let cur = 0;

  while (rhythm.length < target) {
    let lenSlots = rng.weighted([1, 1, 1, 2, 2, 3, 4], (w) => (w === 1 ? 6 : w === 2 ? 3 : w === 3 ? 1.4 : 0.7));
    if (cur + lenSlots > phraseSlots - 2) lenSlots = phraseSlots - 2 - cur;
    if (lenSlots < 1) break;
    rhythm.push({ off: cur, len: lenSlots });
    cur += lenSlots;
    if (cur >= phraseSlots - 2) break;
    // respiration : plus probable en fin de mesure
    const atBar = cur % slotsPerBar === 0;
    if (rng.chance((m.restProb ?? 0.3) * (atBar ? 0.9 : 0.3))) cur += rng.chance(0.5) ? 1 : 2;
  }
  // cadence : garantir une note de résolution en fin de phrase
  const last = rhythm[rhythm.length - 1];
  if (last && last.off + last.len < phraseSlots - 4) {
    rhythm.push({ off: phraseSlots - 3, len: 3 });
  }

  // contour + degrés (marche par degrés, sauts compensés)
  const contour = rng.pick(['arch', 'arch', 'desc', 'asc', 'wave']);
  const degs = [rng.pick([0, 0, 2, 4])];
  let prevStep = 0;
  for (let i = 1; i < rhythm.length; i++) {
    const pos = rhythm.length > 1 ? i / (rhythm.length - 1) : 0;
    const bias = contour === 'arch' ? (pos < 0.5 ? 1 : -1)
      : contour === 'asc' ? 1
      : contour === 'desc' ? -1
      : (i % 2 ? 1 : -1);
    let step;
    if (Math.abs(prevStep) >= 3 && rng.chance(0.7)) step = -Math.sign(prevStep);
    else step = rng.weighted([-2, -1, -1, 1, 1, 2, 3, -3], (w) => (Math.abs(w) === 1 ? 5 : Math.abs(w) === 2 ? 3 : 0.8));
    let d = degs[i - 1] + step + (rng.chance(0.3) ? bias : 0);
    d = clamp(d, -3, 7);
    degs.push(d);
    prevStep = step;
  }
  return rhythm.map(({ off, len }, i) => ({ beat: off / m.grid, duration: len / m.grid, degree: degs[i] + 1 }));
}

/** Installe un motif récurrent sur les accords locaux, avec une réponse et une cadence. */
function addMelodyPhrase(push, humanize, m, ctx) {
  const beats = ctx.length * 4;
  const melBase = octaveMidi(ctx.key.root, m.octave) - (ctx.key.root > 7 ? 12 : 0);
  let notes = ctx.motif.filter((note) => note.beat < beats);
  if (!ctx.exact && ctx.final && !notes.some((note) => note.beat >= beats - 3)) {
    notes.push({ beat: beats - 3, duration: 2.25, degree: 1 });
  }
  if (!ctx.exact && ctx.outro) notes = notes.filter((_, i) => i % 2 === 0 || i === notes.length - 1);

  const nearest = (degree, choices) => choices
    .map((d) => d + 7 * Math.round((degree - d) / 7))
    .reduce((a, b) => Math.abs(b - degree) < Math.abs(a - degree) ? b : a);

  let prevDegree, prevMidi;
  for (const [i, note] of notes.entries()) {
    const last = i === notes.length - 1;
    const variant = ctx.variation % 4;
    const offbeat = note.beat % 1 !== 0;
    const followingBeat = notes[i + 1]?.beat ?? beats;
    // Une réponse garde les points d'appui et déplace légèrement ses levées.
    const offset = !ctx.exact && variant === 2 && offbeat ? Math.min(0.125, Math.max(0, followingBeat - note.beat - 0.12)) : 0;
    const beat = note.beat + offset;
    const bar = ctx.harmony[ctx.startBar + Math.floor(beat / 4)];
    let { chord } = bar[0];
    for (const change of bar) {
      if (change.beat > beat % 4) break;
      chord = change.chord;
    }
    const tones = [chord.deg, chord.deg + 2, chord.deg + 4];
    let degree = (note.degree ?? 1) - 1;
    if (!ctx.exact) {
      if (variant === 3 && i > 0) degree = 2 * (notes[0].degree - 1) - degree;
      if (variant === 1 && (i > 0 || ctx.variation === 1)) degree += 2;
      if (last && !chord.explicit) {
        const goal = ctx.final || ctx.loopEnd || variant % 2 ? chord.deg : chord.deg + 4;
        degree = nearest(prevDegree ?? degree, [goal]);
      } else if (!chord.explicit && !offbeat) {
        degree = nearest(degree, tones);
      } else if (degree === prevDegree) {
        const direction = (notes[i + 1]?.degree ?? note.degree) < note.degree ? -1 : 1;
        degree += direction;
      }
    }
    prevDegree = degree;
    let midi = note.midi ?? (melBase + degreeSemitone(ctx.scale, degree));
    if (!ctx.exact && chord.explicit && (last || !offbeat)) {
      const base = last ? prevMidi ?? midi : midi;
      const choices = last ? [chord.pitchClasses[0]] : chord.pitchClasses;
      midi = choices.map((pc) => pc + Math.round((base - pc) / 12) * 12)
        .reduce((a, b) => Math.abs(base - a) > Math.abs(base - b) ? b : a);
    }
    prevMidi = midi;
    const arch = 0.9 + 0.12 * Math.sin(Math.PI * i / Math.max(1, notes.length - 1));
    const accent = beat % 2 === 0 ? 0.9 : offbeat ? 0.68 : 0.78;
    const onset = ctx.startBar * 4 + beat;
    const strength = (note.velocity ?? accent * arch) * Math.sqrt(ctx.intensity);
    const [t, vel] = note.midi === undefined ? humanize(onset, strength) : [onset, strength];
    let duration = note.duration * (ctx.exact ? 1 : m.legato || 1);
    if (!ctx.exact && last) duration = Math.max(duration, ctx.final ? 2.25 : 0.85);
    const available = ctx.startBar * 4 + followingBeat - t;
    if (note.midi === undefined && available < 0.035) continue;
    let articulation = note.articulation;
    if (!articulation && m.inst === 'guitar' && i === 0 && duration >= 0.74) articulation = 'slide';
    if (!articulation && m.inst === 'brass' && duration >= 1.55) articulation = 'swell';
    if (!articulation && m.inst === 'flute' && i > 0 && note.beat - notes[i - 1].beat - notes[i - 1].duration < 0.17) articulation = 'legato';
    push({ t, beat: ctx.startBar * 4 + beat, dur: Math.min(duration, available), midi, vel, inst: m.inst,
      pan: 0.035, bus: 'mel', vib: m.vibrato || 0, ...(articulation ? { articulation } : {}) });
  }
  return prevMidi;
}

module.exports = { createSong };
