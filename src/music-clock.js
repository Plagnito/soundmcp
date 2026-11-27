'use strict';

const { ui } = require('./language');

const COMMON_METER = [4, 4];

function isMeter(meter) {
  return Array.isArray(meter) && meter.length === 2 && Number.isInteger(meter[0]) &&
    meter[0] >= 2 && meter[0] <= 12 && [2, 4, 8, 16].includes(meter[1]);
}

// Les événements historiques utilisent quatre unités par mesure. Cette horloge
// conserve ce repère, puis convertit en noires MIDI et en secondes de lecture.
function musicClock(song) {
  const sections = song.meta?.sections ?? [];
  const spb = 60 / song.bpm;
  if (!sections.some((s) => s.meter || s.tempo !== undefined)) {
    return { at: (beat) => beat * spb, quarter: (beat) => beat, seconds: song.totalBeats * spb, changes: [] };
  }
  let time = 0, quarters = 0;
  const changes = [];
  const measures = Array.from({ length: song.bars + 1 }, () => ({ meter: COMMON_METER, tempo: song.bpm }));
  for (const section of sections) {
    const { meter = COMMON_METER, tempo = song.bpm } = section;
    if (!isMeter(meter) || !Number.isFinite(tempo) || tempo < 40 || tempo > 220 ||
        !Number.isInteger(section.startBar) || !Number.isInteger(section.bars) || section.startBar < 1 ||
        section.bars < 1 || section.startBar + section.bars - 1 > song.bars) throw new Error(ui('Grille de tempo ou de mesure invalide.', 'Invalid tempo or time signature grid.'));
    for (let b = section.startBar - 1; b < section.startBar + section.bars - 1; b++) measures[b] = { meter, tempo };
  }
  measures[song.bars] = { ...measures[song.bars - 1] };
  for (const [i, measure] of measures.entries()) {
    const previous = measures[i - 1];
    if (i < song.bars && (!previous || measure.tempo !== previous.tempo || measure.meter.join('/') !== previous.meter.join('/'))) {
      changes.push({ beat: i * 4, quarter: quarters, seconds: time, tempo: measure.tempo, meter: measure.meter });
    }
    measure.time = time;
    measure.quarters = quarters;
    measure.rate = measure.meter[0] / measure.meter[1];
    time += measure.rate * 4 * 60 / measure.tempo;
    quarters += measure.rate * 4;
  }
  const position = (beat) => {
    const index = Math.max(0, Math.min(song.bars, Math.floor(beat / 4)));
    return [measures[index], beat - index * 4];
  };
  return { seconds: measures[song.bars].time, changes,
    at(beat) { const [m, offset] = position(beat); return m.time + offset * m.rate * 60 / m.tempo; },
    quarter(beat) { const [m, offset] = position(beat); return m.quarters + offset * m.rate; } };
}

module.exports = { COMMON_METER, isMeter, musicClock };
