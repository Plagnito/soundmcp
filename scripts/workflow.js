'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createSong } = require('../src/composer');
const { musicClock } = require('../src/music-clock');
const { interpretBrief, arrange } = require('../src/arranger');
const { editSong, readProject, sliceSong, writeProject } = require('../src/music-project');
const { renderMidiBuffer } = require('../src/midi');
const { renderSong, writeWav, readWavInfo } = require('../src/dsp');
const { renderSamples, loadBank } = require('../src/sample-bank');
const { callTool } = require('../src/tools');
const { reportOverlaps } = require('../src/score-diagnostics');
const { chordFromSymbol } = require('../src/theory');
const { applyBuilds, validateBuilds } = require('../src/build-shaping');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soundmcp-workflow-'));
  const full = '18 secondes, exploration nocturne, piano feutré et cordes pizzicato, tension progressive, fin calme, sans batterie.';
  const plan = interpretBrief(full);
  assert.equal(plan.style, 'mystery');
  assert.equal(plan.energy, 'rising');
  assert(plan.quietEnd && plan.pizzicato);
  assert.deepEqual(plan.instruments, ['piano', 'strings']);
  assert.deepEqual(plan.excluded, ['drum']);
  assert.equal(interpretBrief('1 min 30, jazz').duration, 90);
  const folk = interpretBrief('30 seconds of folk for a tavern in 6/8, flute and acoustic guitar at 100 BPM.');
  assert.equal(folk.style, 'village');
  assert.deepEqual(folk.meter, [6, 8]);
  assert.equal(folk.tempo, 100);
  const solo = arrange(interpretBrief('18 secondes, piano seul'), 51, 1, 'Solo');
  assert.deepEqual(solo.meta.instruments, ['piano']);
  assert.equal(interpretBrief('Fais une musique').style, 'menu');
  assert.equal(interpretBrief('Fais une musique').phrasing, 'lyrical');
  assert.equal(interpretBrief(full).phrasing, 'style');
  const rock = interpretBrief('Rock intense avec guitare saturée, fin calme, sans boucle.');
  assert.equal(rock.energy, 'strong');
  assert.equal(rock.loop, false);
  assert.deepEqual(rock.instruments, ['guitar']);
  assert.equal(rock.phrasing, 'style');

  const theme = [{ beat: 0, duration: 1, degree: 1 }, { beat: 1.5, duration: 1, degree: 3 }, { beat: 4, duration: 2, degree: 6 }];
  const made = arrange(interpretBrief('42 secondes, thème de menu sans batterie.', { key: 'D minor', tempo: 100,
    motif: theme, reprise_treatment: 'sequence' }), 41, 0, 'Thème auroral');
  const sectionNotes = (s, name) => {
    const { startBar } = s.meta.sections.find((entry) => entry.name === name);
    const first = (startBar - 1) * 4;
    return s.events.filter((e) => e.bus === 'mel' && e.beat >= first && e.beat < first + 8)
      .map(({ midi, beat }) => [beat - first, midi % 12]);
  };
  assert.deepEqual(sectionNotes(made, 'Reprise'), [[0, 2], [1.5, 5], [4, 5], [5.5, 9]]);
  const themeSection = made.meta.sections.find(({ name }) => name === 'Thème');
  assert(chordFromSymbol(themeSection.chords[1]).pitchClasses.includes(10));
  const restyled = editSong(made, [{ type: 'replace_section', section: 'Reprise', replacement: { energy: .82 } }]);
  assert.deepEqual(sectionNotes(restyled, 'Reprise'), sectionNotes(made, 'Reprise'));
  const taller = createSong({ style: 'menu', key: 'D minor', seed: 2, arrangement: { motif: theme,
    sections: [{ name: 'Ample', bars: 2, parts: ['mel'], theme_treatment: 'augmentation' }] } });
  assert.deepEqual(sectionNotes(taller, 'Ample'), [[0, 2], [3, 5]]);
  const example = { bars: 1, bpm: 120, totalBeats: 4, meta: { sections: [{ startBar: 1, bars: 1, meter: [6, 8], tempo: 90 }] },
    events: [{ bus: 'mel', inst: 'piano', midi: 72, t: 0, dur: 3, vel: .7 },
      { bus: 'pad', inst: 'strings', midi: 71, t: .5, dur: 1.6, vel: .55 },
      { bus: 'arp', inst: 'harp', midi: 59, t: 1.7, dur: .4, vel: .55, articulation: 'staccato' },
      { bus: 'bass', inst: 'cello', midi: 60, t: .08, dur: 3, vel: .53 }] };
  const checked = reportOverlaps(example, musicClock(example));
  assert.equal(checked.total, 1);
  assert.deepEqual(checked.examples[0], { bar: 1, seconds: .25, overlapSeconds: .8, semitones: 1,
    melody: { part: 'mel', instrument: 'piano', pitch: 72, bar: 1 }, backing: { part: 'pad', instrument: 'strings', pitch: 71, bar: 1 } });

  const baseBuild = createSong({ style: 'epic', key: 'E minor', tempo: 112, seed: 554, loop: false, palette: 'synth',
    arrangement: { sections: [{ name: 'Approche', bars: 2, meter: [6, 8], tempo: 94 },
      { name: 'Montée', bars: 2, tempo: 116 }, { name: 'Arrivée', bars: 2, tempo: 127 }] } });
  const buildProject = writeProject(path.join(dir, 'arrivee.soundmcp.json'), baseBuild, 24).path;
  const buildComparison = (await callTool('compare_music_choices', { project_path: buildProject, criterion: 'build', section: 'Arrivée', before_bars: 3,
    after_bars: 2, seed: 2, output_dir: dir })).structuredContent;
  assert.equal(buildComparison.criterion, 'build');
  assert.equal(buildComparison.region.arrivalBar, 5);
  assert.equal(buildComparison.levelMatching, 'arrival');
  assert(Math.abs(buildComparison.files[0].arrivalLufs - buildComparison.files[1].arrivalLufs) <= .04);
  assert(!fs.readFileSync(buildComparison.files[0].path).equals(fs.readFileSync(buildComparison.files[1].path)));
  const builds = buildComparison.files.map(({ project_path }) => readProject(project_path).song);
  assert.deepEqual(builds[0].events, builds[1].events);
  assert.deepEqual(renderMidiBuffer(builds[0]), renderMidiBuffer(builds[1]));
  const selectedBuild = builds.find((song) => song.builds[0].contour === 'progressive');
  const clippedBuild = sliceSong(selectedBuild, 3, 3);
  validateBuilds(clippedBuild.builds, clippedBuild.totalBeats);
  const envelope = (song, bus = 'pad') => {
    const rate = 4000, clock = musicClock(song);
    const L = new Float32Array(Math.round(rate * clock.seconds)).fill(1);
    applyBuilds(L, L.slice(), bus, song.builds, clock, rate);
    return L;
  };
  const absolute = envelope(selectedBuild);
  const relative = envelope(clippedBuild);
  const offsetBuild = Math.round(musicClock(selectedBuild).at(8) * 4000);
  for (let i = 0; i < relative.length; i += 147) assert(Math.abs(absolute[offsetBuild + i] - relative[i]) < .0006);
  assert(envelope(selectedBuild, 'mel').every((value) => value === 1));
  const cleared = editSong(selectedBuild, [{ type: 'shape_build', arrival_bar: 5, before_bars: 3, contour: 'flat' }]);
  assert.equal(cleared.builds, undefined);
  assert.equal(cleared.events, selectedBuild.events);
  const shortBuild = (await callTool('draft_music', { brief: 'Un piano instrumental, très lent.', duration_seconds: 5, tempo: 45,
    variants: 1, palette: 'synth', build_contour: 'progressive', output_dir: dir })).structuredContent.candidates[0];
  assert.equal(readProject(shortBuild.project_path).song.bars, 1);
  assert(shortBuild.warnings.includes('La montée demande au moins deux mesures.'));

  const warm = (await callTool('draft_music', { brief: '31 secondes, une mélodie lumineuse et chaleureuse, sans batterie, en D majeur.',
    style: 'menu', tempo: 96, variants: 1, palette: 'synth', output_dir: dir, seed: 525711 })).structuredContent;
  assert.equal(warm.plan.phrasing, 'lyrical');
  const warmSong = readProject(warm.candidates[0].project_path).song;
  assert.equal(warmSong.meta.phrasing, 'lyrical');
  assert.equal(warmSong.palette, 'synth');
  assert(warmSong.meta.sections.some((section) => section.chords.includes('Dmaj7')));
  const lead = warmSong.events.filter((event) => event.bus === 'mel');
  const rhythmOf = (name) => {
    const bar = warmSong.meta.sections.find((section) => section.name === name).startBar;
    const start = (bar - 1) * 4;
    return lead.filter((note) => note.beat >= start && note.beat < start + 8).map((note) => note.beat - start);
  };
  assert.deepEqual(rhythmOf('Thème').filter((beat) => beat < 4), rhythmOf('Reprise').filter((beat) => beat < 4));
  assert(rhythmOf('Reprise').length > rhythmOf('Thème').length);
  assert(rhythmOf('Introduction').length < rhythmOf('Thème').length);
  const reprise = warmSong.meta.sections.find((section) => section.name === 'Reprise');
  assert.equal(reprise.instruments.mel, 'flute');
  assert(lead.some((note) => note.beat >= (reprise.startBar - 1) * 4 && note.inst === 'flute'));
  const answers = warmSong.events.filter((event) => event.bus === 'counter');
  assert(answers.length > 0);
  assert(answers.every((answer) => !lead.some((note) => note.t < answer.t + answer.dur && note.t + note.dur > answer.t)));
  assert(lead.slice(1).every((event, i) => Math.abs(event.midi - lead[i].midi) <= 7));
  assert.equal(warm.candidates[0].preview.clippedFrames, 0);
  assert.equal(warm.plan.autoMix, true);
  assert.equal(warm.candidates[0].mix.length, warmSong.meta.sections.length);
  assert(warm.candidates[0].mix.some((section) => Object.values(section.gain_db).some((db) => db !== 0)));
  assert.equal(interpretBrief('Chaleureux et mélodique', { phrasing: 'style' }).phrasing, 'style');
  const exact = createSong({ style: 'menu', key: 'C major', tempo: 100, loop: true, seed: 4, phrasing: 'lyrical',
    arrangement: { sections: [{ bars: 1, parts: ['mel'], progression: ['C'], motif: [{ beat: 0.5, degree: 2, duration: 0.5 }] }] } });
  assert(exact.events.some((event) => event.beat === 0.5 && event.midi === 62));

  const sound = (await callTool('design_sound', { title: 'Calibration douce', output_dir: dir, seed: 1,
    patch: { layers: [{ wave: 'sine', gain: 0.28, envelope: { sustain: 0.5 } }] },
  })).structuredContent;
  const calibration = (await callTool('calibrate_sound', { patch_path: sound.patch_path, role: 'mel', notes: ['C3', 'C4', 'C5'],
    output_dir: dir, seed: 1 })).structuredContent;
  assert.equal(calibration.probes.length, 9);
  assert(calibration.probes.every((probe) => probe.attackMs !== null));
  assert(calibration.points.some((point) => point.gain_db !== 0));
  const calibrated = (await callTool('create_music', { style: 'menu', duration_seconds: 8, loop: false, seed: 9,
    patch_paths: [sound.patch_path], patch_roles: { mel: sound.id }, calibration_paths: [calibration.calibration_path],
    format: 'midi', save_project: true, output_dir: dir })).structuredContent;
  const calibratedPath = calibrated.files.find((file) => file.format === 'project').path;
  const calibratedSong = readProject(calibratedPath).song;
  assert(calibratedSong.events.some((e) => e.inst === sound.id && e.calibrationDb !== 0));

  const warmPath = warm.candidates[0].project_path;
  const source = fs.readFileSync(warmPath);
  const mixed = (await callTool('mix_music', { project_path: warmPath, section: 'Thème', mix_strength: 0.6, output_dir: dir })).structuredContent;
  assert.equal(mixed.mix.length, 1);
  assert.equal(mixed.mix[0].name, 'Thème');
  assert(mixed.files.some((file) => file.format === 'project'));
  assert.deepEqual(fs.readFileSync(warmPath), source);
  const comparison = (await callTool('compare_music_choices', { project_path: warmPath, criterion: 'accompaniment', section: 'Thème',
    seed: 1, output_dir: dir })).structuredContent;
  assert(comparison.files.every((file) => file.option === undefined));
  assert(Math.abs(comparison.files[0].integratedLufs - comparison.files[1].integratedLufs) < 0.1);
  const manifest = JSON.parse(fs.readFileSync(comparison.comparison_path, 'utf8'));
  const normal = readProject(manifest.takes.find((take) => take.option === 'normal').project_path).song;
  const discreet = manifest.takes.find((take) => take.option === 'discreet');
  const changed = readProject(discreet.project_path).song;
  assert.deepEqual(normal.events.filter((event) => event.bus === 'mel'), changed.events.filter((event) => event.bus === 'mel'));
  assert(normal.events.some((event, i) => changed.events[i].gain < (event.gain ?? 1)));
  const profile = path.join(dir, 'preferences.soundmcp.json');
  const remembered = (await callTool('learn_music_preference', { comparison_path: comparison.comparison_path,
    chosen: discreet.label, profile_path: profile })).structuredContent;
  assert.equal(remembered.choices.accompaniment, 'discreet');
  const next = (await callTool('draft_music', { brief: '15 secondes, mélodie lumineuse', style: 'menu', variants: 1,
    seed: 33, profile_path: profile, output_dir: dir, palette: 'synth', auto_mix: false })).structuredContent;
  assert.equal(next.plan.preferences.accompaniment, 'discreet');
  assert(readProject(next.candidates[0].project_path).song.history.some((item) => item.action === 'preference'));

  const assets = loadBank().instruments;
  for (const inst of ['strings', 'strings-pizz', 'flute', 'clarinet', 'brass', 'acoustic-guitar']) assert(assets.get(inst).length >= 4, inst);
  const arco = new Float32Array(132300), pizz = new Float32Array(arco.length);
  const note = { inst: 'strings', midi: 69, vel: 0.72, pan: 0 };
  assert(renderSamples(arco, new Float32Array(arco.length), 0, note, 44100, 2.85, 0));
  assert(renderSamples(pizz, new Float32Array(pizz.length), 0, { ...note, articulation: 'pizzicato' }, 44100, 2.85, 0));
  assert(arco.slice(110250, 115000).some((x) => Math.abs(x) > 0.002));
  assert(pizz.slice(110250, 115000).every((x) => x === 0));

  const meters = createSong({ style: 'jazz', key: 'C major', tempo: 120, seed: 3, sr: 22050, loop: true,
    arrangement: { sections: [{ name: 'Valse', bars: 2, meter: [3, 4], progression: [1, 5] },
      { name: 'Six croches', bars: 2, meter: [6, 8], tempo: 90, progression: [1, 4], parts: ['mel', 'bass', 'drum', 'counter'] }] } });
  const clock = musicClock(meters);
  assert.equal(clock.seconds, 7);
  assert.equal(clock.quarter(8), 6);
  assert.equal(clock.at(10), 4);
  const midi = renderMidiBuffer(meters);
  assert(midi.includes(Buffer.from([0xff, 0x58, 0x04, 3, 2, 24, 8])));
  assert(midi.includes(Buffer.from([0xff, 0x58, 0x04, 6, 3, 24, 8])));
  const clockAudio = renderSong(meters);
  assert.equal(clockAudio.samples, 154350);

  const edits = [{ type: 'write_measure', bar: 3, part: 'counter', instrument: 'clarinet', notes: [
    { beat: 3, pitch: 'Bb4', duration: 1.5, articulation: 'legato', expression: [0.55, 1.15] },
  ] }];
  const edited = editSong(meters, edits);
  const relevant = edited.events.filter((e) => e.bus === 'counter' && e.beat >= 8 && e.beat < 12);
  assert.equal(relevant.length, 1);
  assert.equal(relevant[0].midi, 70);
  assert.equal(relevant[0].beat, 10);
  assert.deepEqual(edited.events.filter((e) => e.bus !== 'counter'), meters.events.filter((e) => e.bus !== 'counter'));
  assert.equal(edited.history.at(-1).edits[0].bar, 3);

  const { structuredContent: draft } = await callTool('draft_music', { brief: full, title: 'Test du brief', seed: 0, output_dir: dir });
  assert.equal(draft.candidates.length, 3);
  const projects = draft.candidates.map((c) => c.project_path);
  const rhythms = projects.map((file) => readProject(file).song.events.filter((e) => e.bus === 'mel').map((e) => `${e.beat}:${e.midi}`).join(','));
  assert.equal(new Set(rhythms).size, 3);
  const lufs = draft.candidates.map((c) => c.preview.integratedLufs);
  assert(Math.max(...lufs) - Math.min(...lufs) < 0.2);
  assert(draft.candidates.every((candidate) => candidate.music.instruments.includes('piano') && !candidate.music.instruments.includes('drum')));

  const { structuredContent: blind } = await callTool('preview_music', { project_paths: projects.slice(0, 2), section: 'Thème',
    max_seconds: 8, blind: true, seed: 4, output_dir: dir });
  assert.deepEqual(blind.files.map((f) => f.label), ['A', 'B']);
  assert(blind.files.every((f) => f.source === undefined && f.title === undefined));
  assert.equal(JSON.parse(fs.readFileSync(blind.reveal_path, 'utf8')).length, 2);

  const { structuredContent: final } = await callTool('finish_music', { project_path: projects[0], output_dir: dir, sampling_rate: 22050,
    editions: ['loop', 'calm', 'intense', 'transition'], cuts: [15], stems: true });
  assert.equal(final.audio.durationSeconds, 18);
  assert.equal(final.audio.bits, 24);
  assert(final.files.some((file) => file.format === 'midi'));
  assert(final.files.some((file) => file.stem === 'mel'));
  assert.equal(new Set(final.editions.map((edition) => edition.samples)).size, 1);
  const transition = final.editions.find((edition) => edition.id === 'transition');
  assert.equal(transition.to, 'intense');
  assert.equal(transition.from, 'calm');
  assert.equal(final.cuts[0].sections.at(-1), 'Cadence');
  assert.equal(readWavInfo(final.cuts[0].files.find((file) => file.format === 'wav').path).duration, 15);
  const measured = (await callTool('analyze_music', { wav_path: final.files.find((f) => f.format === 'wav').path })).structuredContent;
  assert.equal(measured.clippedFrames, 0);
  assert(measured.integratedLufs < -5 && measured.integratedLufs > -27);
  const technical = (await callTool('analyze_music', { project_path: projects[0] })).structuredContent;
  assert.equal(technical.briefCheck.durationErrorSeconds, 0);
  assert(Number.isInteger(technical.harmonicOverlaps.total));
  assert(technical.formDynamics.rmsDifferenceDb >= 0);
  assert.deepEqual(technical.briefCheck.missingInstruments, []);
  assert.equal(technical.history[0].action, 'brief');

  const testWav = path.join(dir, 'saturation.wav');
  const overload = new Float32Array(8820).fill(1.1);
  writeWav(testWav, overload, undefined, 22050, true, 32);
  const saturation = (await callTool('analyze_music', { wav_path: testWav })).structuredContent;
  assert.equal(saturation.clippedFrames, overload.length);
  console.log('Atelier : brief FR/EN, trois prises, mesure et tempo variables, partition éditable, préécoute, analyse, master et éditions vérifiés.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
