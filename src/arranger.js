'use strict';

const { ui } = require('./language');

const { createSong } = require('./composer');
const { STYLES } = require('./styles');
const { parseKey, SHARPS, SCALES, chordFromDegree, chordFromSymbol, degreeSemitone, midiToFreq } = require('./theory');
const { isMeter, COMMON_METER, musicClock } = require('./music-clock');
const { makeRng, hash32 } = require('./rng');
const { applySounds, SOUND_DESIGNS, SOUND_PARTS } = require('./section-sounds');
const { SOUNDS } = require('./texture-voices');
const { readPhrasing, THEME_TREATMENTS, transformMotif } = require('./melodic-phrasing');
const { validateMotif } = require('./arrangement');
const { readOrchestralPercussion } = require('./orchestral-percussion');

const STYLES_BY_HINT = [
  ['chiptune', /\b(chiptune|8 bits?|retrogaming|console retro|retro arcade)\b/], ['jazz', /\b(jazz|jazzy|swing|combo)\b/],
  ['lofi', /\b(lo fi|lofi|chillhop|etude|study beat)\b/], ['hiphop', /\b(hip hop|hiphop|boom bap|rap instrumental)\b/],
  ['rock', /\b(rock|metal|guitare saturee|distorted guitar)\b/], ['space', /\b(espace|spatial|galaxie|cosmic|space|orbital)\b/],
  ['horror', /\b(horreur|horror|cauchemar|nightmare)\b/], ['victory', /\b(victoire|victory|triomphal|triomphale|triumphant)\b/],
  ['combat', /\b(combat|battle|boss fight|bataille)\b/], ['epic', /\b(epique|epic|heroique|heroic|orchestral|cinematique)\b/],
  ['suspense', /\b(suspense|poursuite|chase|urgence)\b/], ['village', /\b(village|taverne|tavern|bourg|folk)\b/],
  ['fantasy', /\b(fantasy|medieval|feerique|magique|sylvestre)\b/], ['dungeon', /\b(donjon|dungeon|catacombes)\b/],
  ['menu', /\b(menu|ecran titre|title screen)\b/], ['upbeat', /\b(joyeux|joyeuse|joyful|upbeat|dansant|dansante)\b/],
  ['mystery', /\b(nocturne|nighttime|mystere|mysterieux|mysterious|tension|infiltration)\b/],
  ['sad', /\b(melancolie|melancolique|triste|nostalgique|nostalgic|melancholy|sad)\b/],
  ['ambient', /\b(ambient|ambiant|calme|calm|paisible|peaceful|meditation|aerien|ethereal)\b/],
];

const INSTRUMENT_HINTS = {
  piano: 'piano|steinway|clavier acoustique', strings: 'cordes|strings|violons?|violins?',
  cello: 'violoncelles?|cellos?', harp: 'harpes?|harps?', vibraphone: 'vibraphones?|vibraharps?',
  trumpet: 'trompettes?|trumpets?', trombone: 'trombones?', tuba: 'tubas?',
  flute: 'flutes?', clarinet: 'clarinettes?|clarinets?|bois|woodwinds?', brass: 'cuivres?|brass|french horn|cor(?:s)?',
  guitar: 'guitares? (?:saturees?|electriques?)|(?:distorted|electric) guitars?',
  'acoustic-guitar': 'guitares?(?: acoustiques?)?(?! (?:saturees?|electriques?))|(?:acoustic )?guitars?', upright: 'contrebasse|double bass|upright bass',
  'electric-clean': 'guitares? claires?|clean electric guitars?', 'electric-drive': 'drive de guitare|amped guitars?',
  'electric-swell': 'guitare en volume progressif|volume swells?', 'tape-keys': 'clavier sur bande|tape keys',
  'glass-keys': 'verre frappe|glass keys', 'bowed-metal': 'metal frotte|bowed metal',
  'granular-pad': 'nappes? granulaires?|granular pads?', 'sub-pulse': 'grave pulse|sub pulse',
  drum: 'batterie|percussions?|drums?|kit',
};
const PLAYABLE = Object.keys(INSTRUMENT_HINTS);
const ROLE_FALLBACK = { pad: ['strings', 'padwarm'], mel: ['piano', 'flute', 'tri'], arp: ['acoustic-guitar', 'piano', 'tri'], bass: ['upright', 'bass'], counter: ['clarinet', 'flute', 'tri'] };
const LABELS = { ...Object.fromEntries(Object.entries(SOUNDS).map(([id, spec]) => [id, spec[0].toLowerCase()])),
  piano: 'piano', strings: 'cordes', flute: 'flûte', clarinet: 'clarinette', brass: 'cuivres', guitar: 'guitare électrique',
  'acoustic-guitar': 'guitare acoustique', upright: 'contrebasse', drum: 'batterie' };
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const normalize = (value) => value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[-–]/g, ' ');
const MELODIC_STYLES = new Set(['ambient', 'menu', 'lofi', 'village', 'fantasy', 'sad', 'jazz', 'upbeat']);
const MELODIC_HINT = /\b(agreable|plaisant(?:e)?|chaleureu(?:x|se)|chantant(?:e)?|melodique|lumineu(?:x|se)|pleasant|warm|lyrical|melodic|bright)\b/;

function interpretBrief(input, options = {}) {
  if (typeof input !== 'string' || !input.trim() || input.length > 1600) throw new Error(ui('brief attend une phrase de 1 à 1600 caractères.', 'brief must contain 1 to 1600 characters.'));
  const text = normalize(input).replace(/♯/g, '#').replace(/♭/g, 'b');
  const matches = STYLES_BY_HINT.filter(([, re]) => re.test(text)).map(([id]) => id);
  const style = options.style ?? matches[0] ?? options.development?.style ?? 'menu';
  if (!Object.hasOwn(STYLES, style)) throw new Error(ui(`Style inconnu : ${style}.`, `Unknown style: ${style}.`));
  const profile = STYLES[style];
  const length = /\b(\d+(?:[.,]\d+)?)\s*(min(?:ute)?s?|secondes?|seconds?|secs?|s)\b/.exec(text);
  const mixedLength = /\b(\d+)\s*(?:min(?:ute)?s?)\s+(\d{1,2})\s*(?:s|secondes?|seconds?)?\b/.exec(text);
  const duration = options.duration_seconds ?? (mixedLength ? Number(mixedLength[1]) * 60 + Number(mixedLength[2])
    : length ? Number(length[1].replace(',', '.')) * (length[2].startsWith('min') ? 60 : 1) : 60);
  if (!Number.isFinite(duration) || duration < 5 || duration > 600) throw new Error(ui('La durée attendue est de 5 à 600 secondes.', 'Duration must be between 5 and 600 seconds.'));
  const met = /\b(\d{1,2})\/(2|4|8|16)\b/.exec(text);
  const midi = options.midiImport;
  const meter = options.meter ?? (met ? met.slice(1).map(Number) : midi?.meter ?? options.development?.meter ?? COMMON_METER);
  if (!isMeter(meter)) throw new Error(ui('La mesure doit être une paire comme [3,4] ou [6,8].', 'The time signature must be a pair such as [3,4] or [6,8].'));
  const bpm = /\b(\d{2,3})\s*bpm\b/.exec(text);
  const tempo = options.tempo ?? (bpm ? Number(bpm[1]) : midi?.tempo ?? options.development?.tempo ?? profile.defaults.tempo);
  if (!Number.isFinite(tempo) || tempo < 40 || tempo > 220) throw new Error(ui('Le tempo attendu est de 40 à 220 BPM.', 'Tempo must be between 40 and 220 BPM.'));
  const keyHint = /\b(?:en|in)\s+([a-g][#b]?|do|re|mi|fa|sol|la|si)\s+(mineur harmonique|harmonic minor|mineur|majeur|minor|major|dorien|dorian|lydien|lydian|mixolydien|mixolydian|phrygien|phrygian)\b/.exec(text);
  const key = options.key ?? keyHint?.slice(1).join(' ') ?? options.development?.key;
  if (key !== undefined && !parseKey(key)) throw new Error(ui(`Tonalité inconnue : ${key}.`, `Unknown key: ${key}.`));
  const named = [], barred = [];
  const explicitGuitar = ['electric-clean', 'electric-drive', 'electric-swell'].map((id) => INSTRUMENT_HINTS[id]).join('|');
  for (const [inst, pattern] of Object.entries(INSTRUMENT_HINTS)) {
    const excludedGuitar = inst === 'acoustic-guitar' ? `${INSTRUMENT_HINTS.guitar}|${explicitGuitar}` : explicitGuitar;
    const matchingText = ['guitar', 'acoustic-guitar'].includes(inst) ? text.replace(new RegExp(`\\b(?:${excludedGuitar})\\b`, 'g'), '') : text;
    if (!new RegExp(`\\b(?:${pattern})\\b`).test(matchingText)) continue;
    if (new RegExp(`\\b(?:sans|without|no)\\s+(?:(?:de|d)\\s+)?(?:${pattern})\\b`).test(matchingText)) barred.push(inst);
    else named.push(inst);
  }
  for (const [field, supplied] of [['instruments', options.instruments], ['without', options.without]]) {
    if (supplied !== undefined && (!Array.isArray(supplied) || supplied.length > PLAYABLE.length || supplied.some((name) => !PLAYABLE.includes(name)))) {
      throw new Error(ui(`${field} accepte : ${PLAYABLE.join(', ')}.`, `${field} accepts: ${PLAYABLE.join(', ')}.`));
    }
  }
  const excluded = [...new Set([...barred, ...(options.without ?? [])])];
  const instruments = [...new Set(options.instruments ?? named)].filter((name) => !excluded.includes(name));
  const instrumentRoles = options.instrument_roles;
  if (instrumentRoles !== undefined && (!instrumentRoles || typeof instrumentRoles !== 'object' || Array.isArray(instrumentRoles) ||
      !Object.keys(instrumentRoles).length || Object.entries(instrumentRoles).some(([part, instrument]) =>
        !SOUND_PARTS.includes(part) || instrument === 'drum' || !PLAYABLE.includes(instrument)))) {
    throw new Error(ui(
      'instrument_roles attend des pupitres mélodiques et des timbres jouables du catalogue.',
      'instrument_roles requires melodic parts and playable instruments from the catalog.',
    ));
  }
  if (instrumentRoles && Object.values(instrumentRoles).some((instrument) => excluded.includes(instrument))) {
    throw new Error(ui('Un timbre assigné dans instrument_roles est exclu par le brief ou without.', 'An instrument assigned in instrument_roles is excluded by the brief or without.'));
  }
  const quietEnding = /\b(?:fin|ending|outro)\s+(?:calme|douce|quiet|soft|paisible)\b/;
  const body = text.replace(quietEnding, '');
  const energy = options.energy ?? (/\b(progressive?|montee|crescendo|grandit|builds?|rising)\b/.test(body) ? 'rising'
    : /\b(intense|nerveux|energetique|energetic)\b/.test(body) ? 'strong' : /\b(calme|calm|minimal|feutre|paisible|soft)\b/.test(body) ? 'gentle' : 'balanced');
  if (!['rising', 'gentle', 'strong', 'balanced'].includes(energy)) throw new Error(ui('energy attend rising, gentle, strong ou balanced.', 'energy must be rising, gentle, strong, or balanced.'));
  const loop = options.loop ?? (/\b(boucle|loop|looping|bouclable)\b/.test(text) && !/\b(sans|no|without) (?:de )?(?:boucle|loop|looping)\b/.test(text));
  const solo = instruments.length === 1 && /\b(seule?|only|unaccompanied)\b/.test(text);
  const quietEnd = quietEnding.test(text);
  const slowEnd = /\b(ralenti[rt]?|slows? down|ritardando)\b/.test(text);
  const pizzicato = /\b(pizzicato|pizz)\b/.test(text);
  const spiccato = /\b(spiccato|staccato)\b/.test(text);
  const soundDesign = options.sound_design ?? (/\b(textures? evolutives?|design sonore|evolving textures?|sound design|industriel(?:le)?|industrial|collage sonore)\b/.test(text) ? 'evolving' : 'classic');
  if (!SOUND_DESIGNS.includes(soundDesign)) throw new Error(ui('sound_design attend classic ou evolving.', 'sound_design must be classic or evolving.'));
  const percussion = readOrchestralPercussion(options.orchestral_percussion) ??
    (/\b(timbales?|timpani|percussions? orchestrales?|orchestral percussion)\b/.test(text) ? 'drive' : undefined);
  const use = /\b(jeu|game|exploration|combat|battle|boucle|loop)\b/.test(text) ? 'jeu'
    : /\b(film|video|trailer|bande annonce)\b/.test(text) ? 'image' : 'écoute';
  const neutral = !options.style && !matches.length;
  const phrasing = readPhrasing(options.phrasing ?? (neutral || (MELODIC_STYLES.has(style) && MELODIC_HINT.test(body)) ? 'lyrical' : 'style'));
  if (options.motif !== undefined) validateMotif(options.motif);
  if (options.reprise_treatment !== undefined && !THEME_TREATMENTS.includes(options.reprise_treatment)) {
    throw new Error(ui(`reprise_treatment attend ${THEME_TREATMENTS.join(', ')}.`, `reprise_treatment must be one of ${THEME_TREATMENTS.join(', ')}.`));
  }
  return { brief: input.trim(), style, duration, tempo: Math.round(tempo), meter, key, energy, instruments, excluded,
    ...(instrumentRoles ? { instrumentRoles: { ...instrumentRoles } } : {}),
    loop: Boolean(loop), quietEnd, slowEnd, solo, pizzicato, spiccato, use, instrumental: true, soundDesign, phrasing,
    ...(midi ? { motif: midi.motif, midi_source: midi.source } : options.motif === undefined ? {} : { motif: options.motif }),
    ...(options.reprise_treatment === undefined ? {} : { repriseTreatment: options.reprise_treatment }),
    ...(percussion !== undefined && !excluded.includes('drum') && !solo ? { orchestralPercussion: percussion } : {}),
    ...(neutral ? { assumptions: ['Style déduit par défaut : thème de menu.'] } : {}) };
}

function chooseInstruments(plan, profile) {
  const choices = { ...plan.instrumentRoles };
  const instruments = plan.instruments.filter((inst) => inst !== 'drum');
  const assign = (role, inst) => { if (!choices[role] && !Object.values(choices).includes(inst)) choices[role] = inst; };
  for (const inst of instruments) {
    if (inst === 'strings' || SOUNDS[inst]?.[2] === 'pad') assign('pad', inst);
    else if (inst === 'upright' || SOUNDS[inst]?.[2] === 'bass') assign('bass', inst);
    else if ((inst === 'acoustic-guitar' || SOUNDS[inst]?.[2] === 'arp') && profile.arp?.enabled) assign('arp', inst);
    else if (!choices.mel) assign('mel', inst);
    else assign('counter', inst);
  }
  if (plan.solo && instruments.length) {
    choices.mel = plan.instrumentRoles?.mel ?? instruments[0];
    if (profile.arp?.enabled && !['cello', 'flute', 'clarinet', 'brass', 'upright', 'trumpet', 'trombone', 'tuba'].includes(instruments[0])) {
      choices.arp = plan.instrumentRoles?.arp ?? instruments[0];
    }
  }
  return choices;
}

function orchestra(song, assignments, plan) {
  const sections = song.meta.sections;
  const events = song.events.flatMap((event) => {
    if (event.bus === 'drum') return plan.excluded.includes('drum') ? [] : [event];
    if (event.bus === 'texture') return [event];
    const section = sections.find((s) => (event.beat ?? event.t) < (s.startBar + s.bars - 1) * 4);
    const source = event.inst === 'nylon' ? 'acoustic-guitar' : event.inst;
    const local = plan.phrasing === 'lyrical' ? section?.instruments?.[event.bus] : undefined;
    let inst = event.inst === 'sub' && !plan.solo && !plan.instrumentRoles?.[event.bus]
      ? 'sub' : local ?? assignments[event.bus] ?? source;
    if (plan.excluded.includes(inst)) inst = ROLE_FALLBACK[event.bus].find((name) => !plan.excluded.includes(name));
    if (!inst) return [];
    let articulation = event.articulation;
    if (inst === 'strings') articulation = plan.pizzicato && section?.name !== 'Reprise' ? 'pizzicato' : 'legato';
    if (inst === 'cello') articulation = plan.pizzicato ? 'pizzicato' : plan.spiccato ? 'staccato' : 'legato';
    if (inst === 'brass' && event.dur >= 1.35) articulation = 'swell';
    let midi = event.midi;
    if (!(event.bus === 'mel' && section?.name === 'Thème' && plan.sourceExcerpt?.preserve.includes('motif'))) {
      const high = inst === 'piano' && event.bus === 'mel' ? 83
        : { 'acoustic-guitar': 76, cello: 77, trumpet: 84, trombone: 70, tuba: 58 }[inst];
      if (high !== undefined) while (midi > high) midi -= 12;
    }
    return [{ ...event, inst, midi, freq: midiToFreq(midi), articulation,
      ...(inst === 'brass' && section?.energy > 0.8 ? { expression: [0.82, 1.08] } : {}) }];
  });
  return { ...song, events, instrumentAssignments: assignments };
}

function colorProgression(pattern, key) {
  const scale = SCALES[key.scaleId];
  return pattern.map((degree) => {
    if (degree === 5) return degree;
    const chord = chordFromDegree(48 + key.root, scale, degree - 1, { seventh: true });
    if (chord.quality === 'maj' && chord.notes[3] - chord.notes[0] === 11) return chord.name;
    if (chord.quality === 'min' && chord.notes[3] - chord.notes[0] === 10) return chord.name;
    return degree;
  });
}

function harmonizeMotif(motif, progression, key, bars) {
  const scale = SCALES[key.scaleId];
  const chordFor = (symbol) => typeof symbol === 'string' ? chordFromSymbol(symbol)
    : chordFromDegree(48 + key.root, scale, symbol - 1);
  const diatonic = [1, 4, 5, 6, 2, 3, 7].map((symbol) => ({ symbol, chord: chordFor(symbol) }));
  const melody = motif.map((note) => ({ ...note, pc: ((note.midi ?? (key.root + degreeSemitone(scale, note.degree - 1))) + 120) % 12 }));
  let previous;
  return Array.from({ length: bars }, (_, bar) => {
    const expected = progression[bar % progression.length];
    if (Array.isArray(expected)) return expected;
    const from = bar % 2 * 4;
    const notes = melody.flatMap(({ beat, duration, pc }) => {
      const time = Math.min(from + 4, beat + duration) - Math.max(from, beat);
      return time > 0 ? [{ pc, weight: time + (beat === from ? .30 : 0) }] : [];
    });
    if (!notes.length) { previous = chordFor(expected).name; return expected; }
    const candidates = [{ symbol: expected, chord: chordFor(expected) }, ...diatonic];
    const score = ({ symbol, chord }) => notes.reduce((sum, note) => sum + (chord.pitchClasses.includes(note.pc) ? note.weight : 0),
      (symbol === expected ? .32 : 0) - (chord.name === previous ? .27 : 0));
    const selected = candidates.reduce((best, candidate) => score(candidate) > score(best) ? candidate : best);
    previous = selected.chord.name;
    return selected.symbol;
  });
}

function arrange(plan, seedBase, variant, title) {
  const profile = STYLES[plan.style];
  const seed = hash32(seedBase, 508 + variant);
  const rng = makeRng(seed);
  const scaleId = parseKey(plan.key)?.scaleId ?? rng.pick(profile.defaults.scalePool);
  const key = plan.key ?? `${rng.pick(profile.defaults.rootPool)} ${SCALES[scaleId].labelEn}`;
  const lyrical = plan.phrasing === 'lyrical';
  const beats = plan.meter[0] * 4 / plan.meter[1];
  const perBar = 60 * beats / plan.tempo;
  const slower = clamp(Math.round(plan.tempo * 0.84), 40, 220);
  const assignments = chooseInstruments(plan, profile);
  const alternateLead = lyrical && !plan.solo && !plan.instrumentRoles?.mel ? [
    assignments.counter, assignments.arp, ...(plan.instruments.length ? [] : ['flute', 'clarinet', 'tri']),
  ].find((inst) => inst && inst !== (assignments.mel ?? profile.melody?.inst) && !plan.excluded.includes(inst)) : undefined;
  const active = ['pad', 'arp', 'bass', 'mel', ...(assignments.counter ? ['counter'] : []), ...(profile.drums && !plan.excluded.includes('drum') ? ['drum'] : [])];
  const solo = plan.solo ? ['mel', ...(assignments.arp ? ['arp'] : [])] : active;
  if (plan.instruments.includes('drum') && !profile.drums && !plan.solo) solo.push('drum');
  const isMinor = ['minor', 'harmonicMinor', 'dorian', 'phrygian'].includes(scaleId);
  const mainPattern = (isMinor ? [[1, 6, 3, 7], [1, 4, 6, 5], [6, 7, 1, 5]] : [[1, 4, 6, 5], [1, 6, 2, 5], [6, 4, 1, 5]])[variant % 3];
  const contrastPattern = isMinor ? [4, 6, 1, 5] : [2, 4, 6, 5];
  const tonalKey = parseKey(key);
  const main = plan.sourceProgression ?? (lyrical ? colorProgression(mainPattern, tonalKey) : mainPattern);
  const contrast = lyrical ? colorProgression(contrastPattern, tonalKey) : contrastPattern;
  const sourceBars = plan.sourceExcerpt ? Math.max(plan.sourceProgression?.length ?? 0,
    plan.motif ? Math.ceil(Math.max(...plan.motif.map((note) => note.beat + note.duration)) / 4) : 0) : 0;
  const energies = { gentle: [0.46, 0.65, 0.53, 0.72], strong: [0.68, 0.86, 0.76, 1], balanced: [0.58, 0.79, 0.63, 0.94], rising: [0.4, 0.65, 0.76, 1] }[plan.energy];
  const form = (bars) => {
    const sections = [];
    const push = (name, count, progression, parts, energy, theme = 'A', extra = {}) => {
      const meter = plan.meter.join('/') === '4/4' ? undefined : plan.meter;
      const percussion = name === 'Pont' || name === 'Cadence' && plan.quietEnd ? 'none' : plan.orchestralPercussion;
      for (let i = 0; i < count; i += 64) {
        const bars = Math.min(64, count - i);
        const motif = theme === 'A' && !extra.motif ? plan.motif : undefined;
        const harmony = motif && !(plan.sourceProgression && progression === main)
          ? harmonizeMotif(transformMotif(motif, extra.theme_treatment, tonalKey), progression, tonalKey, bars) : progression;
        sections.push({ name, bars, progression: harmony, parts: [...new Set(parts)], energy, theme, meter,
          ...(motif ? { motif } : {}), ...extra,
          ...(plan.orchestralPercussion !== undefined ? { orchestral_percussion: percussion } : {}) });
      }
    };
    if (bars === 1) {
      push('Thème', 1, plan.loop || plan.motif ? main : [[{ beat: 0, chord: 5 }, { beat: 2, chord: 1 }]], solo, energies[1]);
      return sections;
    }
    const outro = Math.min(plan.loop ? 0 : bars >= 9 ? 2 : 1, bars - sourceBars);
    const intro = !plan.loop && bars >= 6 ? Math.min(4, Math.floor(bars / 6), bars - outro - sourceBars) : 0;
    const core = bars - intro - outro;
    const bridge = Math.min(core - sourceBars, core >= 9 ? Math.min(8, Math.floor(core / 3)) : core >= 5 ? 2 : 0);
    const themeBars = Math.max(sourceBars, core - bridge >= 6 ? Math.ceil((core - bridge) * 0.53) : core - bridge);
    const resume = core - themeBars - bridge;
    const opening = plan.solo ? solo : ['pad', 'arp', ...(plan.orchestralPercussion === 'drive' || lyrical || plan.motif || variant === 1 || plan.instruments.includes('piano') ? ['mel'] : [])];
    push('Introduction', intro, main, opening, energies[0], 'A', (lyrical || plan.motif) && !plan.solo ? { theme_treatment: 'fragment' } : {});
    push('Thème', themeBars, main, solo, energies[1], 'A', { variation: !plan.sourceExcerpt && variant === 2 ? 2 : 0 });
    const bridgeParts = plan.solo ? solo : solo.filter((p) => p !== 'drum' || plan.energy === 'strong');
    push('Pont', bridge, contrast, bridgeParts, energies[2], 'B', { variation: variant % 3 });
    const repriseTreatment = plan.repriseTreatment ?? (lyrical || plan.motif ? 'reprise' : undefined);
    push('Reprise', resume, !plan.sourceProgression && variant === 2 ? [...main.slice(0, 3), 1] : main,
      plan.solo ? solo : [...solo, 'counter'], energies[3], 'A', { variation: variant === 0 ? 1 : 2,
        ...(repriseTreatment ? { theme_treatment: repriseTreatment } : {}),
        ...(alternateLead ? { instruments: { mel: alternateLead } } : {}) });
    const cadence = outro === 1 ? [[{ beat: 0, chord: 5 }, { beat: 2, chord: 1 }]] : [5, 1];
    const notes = outro === 1 ? [{ beat: 0, degree: 5, duration: 1.35 }, { beat: 2, degree: 1, duration: 1.8 }]
      : [{ beat: 0, degree: 5, duration: 1.5 }, { beat: 2, degree: 2, duration: 1.45 }, { beat: 4, degree: 1, duration: 3.8 }];
    push('Cadence', outro, cadence, plan.solo ? solo : ['pad', 'bass', 'mel', ...(plan.quietEnd ? [] : ['arp'])],
      plan.quietEnd ? 0.48 : 0.66, 'A', { motif: notes, ...(plan.slowEnd ? { tempo: slower } : {}) });
    return sections;
  };
  const motifBars = plan.midi_source ? Math.ceil(Math.max(...plan.motif.map((note) => note.beat + note.duration)) / 4) : sourceBars;
  const minimumBars = motifBars ? motifBars + (plan.loop ? 0 : 1) : 1;
  let bars = Math.max(minimumBars, Math.floor((plan.duration - (plan.loop ? 0 : 0.9)) / perBar));
  const endExtra = !plan.loop && plan.slowEnd ? (bars >= 9 ? 2 : 1) * (60 * beats / slower - perBar) : 0;
  while (bars > minimumBars && bars * perBar + endExtra > plan.duration) bars--;
  const base = createSong({ style: plan.style, key, seed, tempo: plan.tempo, title,
    arrangement: { sections: form(bars) }, loop: plan.loop, phrasing: plan.phrasing, palette: plan.palette ?? 'studio', sr: 48000 });
  let song = orchestra(base, assignments, plan);
  if (plan.instruments.includes('drum') && !profile.drums && !plan.solo && plan.orchestralPercussion === undefined) {
    const extra = [];
    for (const section of song.meta.sections.filter((s) => ['Thème', 'Reprise'].includes(s.name))) {
      section.parts.push('drum');
      for (let i = section.startBar - 1; i < section.startBar - 1 + section.bars; i++) {
        for (const [offset, drum, vel] of [[0, 'kick', 0.62], [2, 'snare', 0.39]]) {
          const t = i * 4 + offset;
          extra.push({ t, beat: t, dur: 0, inst: drum, drum, vel: vel * section.energy, pan: 0, bus: 'drum', kit: 'acoustic', seedIdx: hash32(seed, t), take: i });
        }
      }
    }
    song = { ...song, events: song.events.concat(extra) };
  }
  song = applySounds(song, plan.soundDesign, { protect: Object.keys(assignments), solo: plan.solo });
  const actual = musicClock(song).seconds;
  if (!plan.loop) song.targetSeconds = Math.max(actual, plan.duration);
  song.history = [{ action: 'brief', variant: variant + 1, seed }];
  const instruments = [...new Set(song.events.map((event) => event.drum ? 'drum' : event.inst))];
  const mainInstruments = instruments.filter((name) => LABELS[name]).map((name) => LABELS[name]);
  const description = mainInstruments.length
    ? ui('Pupitres principaux : ', 'Main instruments: ') + `${mainInstruments.join(', ')}.` : profile.desc;
  song.meta = { ...song.meta, description, brief: plan, variant: variant + 1, instruments };
  return song;
}

module.exports = { PLAYABLE, interpretBrief, arrange, orchestra };
