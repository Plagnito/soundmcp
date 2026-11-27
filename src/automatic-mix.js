'use strict';

const { ui } = require('./language');

const { renderSong } = require('./dsp');
const { localRms } = require('./music-analysis');
const { musicClock } = require('./music-clock');
const { sliceSong } = require('./music-project');

const BALANCE = { mel: 0, pad: -8, arp: -10, counter: -11, bass: -6, drum: -7, texture: -13 };
const LEADS = ['mel', 'pad', 'arp', 'counter', 'bass', 'drum', 'texture'];
const MAX_GAIN = 6;
const MAX_CUT = -8;
const MIN_SIGNAL = -56;
const round = (n) => Number(n.toFixed(2));
const beatOf = (event) => event.beat ?? event.t;
const fromDb = (db) => 10 ** (db / 20);

function sectionRange(section) {
  const from = (section.startBar - 1) * 4;
  return { from, to: from + section.bars * 4 };
}

function measurePupitres(song, section, clock) {
  const { from, to } = sectionRange(section);
  const relevant = song.events.filter((event) => beatOf(event) < to &&
    (beatOf(event) >= from || event.t + event.dur > from));
  if (!relevant.length) return {};
  const anchor = relevant.find((event) => event.bus === 'mel' && beatOf(event) >= from) ?? relevant[0];
  const start = Math.max(section.startBar, Math.min(section.startBar + section.bars - 1, Math.floor(beatOf(anchor) / 4) + 1));
  const available = section.startBar + section.bars - start;
  const bars = available > 1 && clock.at((start + 1) * 4) - clock.at((start - 1) * 4) <= 16 ? 2 : 1;
  const piece = sliceSong(song, start, bars);
  const levels = {};
  renderSong({ ...piece, builds: undefined, sr: 22050, endFade: 0, targetSeconds: musicClock(piece).seconds }, (part, L, R) => {
    const rms = localRms(L, R);
    if (rms !== null && rms >= MIN_SIGNAL) levels[part] = rms;
  });
  return levels;
}

function mixSong(song, { strength = 0.8, sectionIndex } = {}) {
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new Error(ui('mix_strength attend un nombre entre 0 et 1.', 'mix_strength must be a number between 0 and 1.'));
  if (!strength) return { song, sections: [] };
  const sections = song.meta.sections;
  const selected = sections.map((section, index) => ({ ...sectionRange(section), section, index }))
    .filter(({ index }) => sectionIndex === undefined || index === sectionIndex);
  const selectedAt = (event) => selected.find(({ from, to }) => beatOf(event) >= from && beatOf(event) < to);
  const dry = { ...song, events: song.events.map((event) => {
    if (!selectedAt(event) || !Number.isFinite(event.autoMixDb) || event.autoMixDb < MAX_CUT || event.autoMixDb > MAX_GAIN) return event;
    const { autoMixDb, ...unmixed } = event;
    return { ...unmixed, gain: (event.gain ?? 1) / fromDb(autoMixDb) };
  }) };
  const clock = musicClock(dry);
  const reports = selected.map(({ section, index }) => {
    const before = measurePupitres(dry, section, clock);
    const anchor = LEADS.find((part) => Object.hasOwn(before, part));
    const reference = before[anchor];
    const gain_db = {};
    for (const [part, level] of Object.entries(before)) {
      if (part === anchor) continue;
      const offset = anchor === 'mel' ? BALANCE[part] : Math.min(-3, BALANCE[part] - BALANCE[anchor]);
      gain_db[part] = round(Math.max(MAX_CUT, Math.min(MAX_GAIN, (reference + offset - level) * strength)));
    }
    return { section: index + 1, name: section.name, reference: anchor, measured_dbfs: before, gain_db };
  });
  const gainsBySection = new Map(reports.map((report) => [report.section - 1, report.gain_db]));
  const events = dry.events.map((event) => {
    const region = selectedAt(event);
    const db = gainsBySection.get(region?.index)?.[event.bus];
    return db ? { ...event, gain: (event.gain ?? 1) * fromDb(db), autoMixDb: db } : event;
  });
  return { song: { ...song, events, history: [...(song.history ?? []), {
    action: 'mix', strength, sections: reports.map(({ section, gain_db }) => ({ section, gain_db })),
  }].slice(-60) }, sections: reports };
}

module.exports = { mixSong };
