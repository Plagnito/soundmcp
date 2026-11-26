"""Construit le supplément de cuivres et de percussions orchestrales CC0."""
import array
import hashlib
import json
import math
import runpy
import statistics
import sys
import urllib.parse
from pathlib import Path


studio = runpy.run_path(str(Path(__file__).with_name('build-studio-bank.py')))
CACHE = studio['CACHE']
BANK = studio['BANK']
RATE = studio['RATE']
SOURCES = studio['SOURCES']
TIMPANI_CENTERS = {42: 89.8, 47: 121.5, 50: 142.6, 52: 169.4, 54: 190.4}


def select():
    brass = {
        'Sum_SHTrumpet_sus': ('Trumpet/sus', 'trumpet', 'F2 D#3 G3 A#3 D4 F4 A4 C5', (1, 3), 2.55, 'rr1'),
        'Sum_SHTrumpet_stac': ('Trumpet/stac', 'trumpet-staccato', 'A#3 D4 F4 A4', (2, 3), .64, 'rr1'),
        'tenortbn_sus': ('Tenor Trombone/sus', 'trombone', 'A#1 D2 F2 C3 D#3 F3', (1, 2), 2.55, '1'),
        'tenortbn_stac': ('Tenor Trombone/stac', 'trombone-staccato', 'A#1 F2 A#2 D3', (2, 3), .69, 'rr1'),
        'Tuba3_sus': ('Tuba/sus', 'tuba', 'A#0 D#1 F1 A#1 D2', (1, 2), 2.45, 'rr1_Mid'),
    }
    for prefix, (folder, instrument, notes, layers, length, microphone) in brass.items():
        for note in notes.split():
            for i, layer in enumerate(layers):
                path = f'Brass/{folder}/{prefix}_{note}_v{layer}_{microphone}.wav'
                yield ('VSCO-2-CE', path, instrument, studio['midi_pitch'](note, 12), [.33, .80][i], 1, 1, length)

    for drum, root in enumerate([42, 47, 50, 52, 54], 1):
        for layer, velocity in [(1, .32), (3, .84)]:
            for take in (1, 2):
                path = f'Percussion/Timpani/Timpani{drum}_Hit_v{layer}_rr{take}_Sum.wav'
                yield ('VSCO-2-CE', path, 'timpani', root, velocity, take, 2, 1.62)
        path = f'Percussion/Timpani/Rolls/Timpani{drum}_Roll_v3_rr1_Sum.wav'
        yield ('VSCO-2-CE', path, 'timpani-roll', root, .65, 1, 2, 3.65)

    drums = 'Membranophones/Struck Membranophones'
    metals = 'Idiophones/Struck Idiophones'
    for filename, velocity, take in [('mf1', .39, 1), ('mf2', .39, 2), ('f', .83, 1), ('ff', .83, 2)]:
        yield ('VCSL', f'{drums}/Bass Drum 2/bassdrum_hit_{filename}.wav', 'concert-bass-drum', None, velocity, take, 2, 2.08)
    for layer, velocity in [(1, .29), (3, .86)]:
        for take in (1, 2):
            suffix = 3 if layer == 3 and take == 2 else take
            path = f'{drums}/Snare Drum, Rope Tension/Low/RopeSnare_low_sn_Main_vl{layer}_rr{suffix}.wav'
            yield ('VCSL', path, 'concert-snare', None, velocity, take, 2, .79)
    for layer, velocity in [(2, .35), (3, .83)]:
        for take in (1, 2):
            path = f'{drums}/Frame Drum/HDrumL_Hit_v{layer}_rr{take}_Sum.wav'
            yield ('VCSL', path, 'frame-drum', None, velocity, take, 2, 1.12)
    for name, velocity in [('gong_mf', .42), ('gong_fff', .87)]:
        yield ('VCSL', f'{metals}/Gong 1/{name}.wav', 'gong', None, velocity, 1, 2, 4.0)
    for name, velocity in [('susCymb1_cresc_2s', .40), ('susCymb1_cresc_4s', .82)]:
        yield ('VCSL', f'{metals}/Suspended Cymbal 1/{name}.wav', 'cymbal-swell', None, velocity, 1, 2, 5.1)
    for name, velocity, take in [('mf_rr1', .40, 1), ('mf_rr2', .40, 2), ('ff_rr1', .86, 1)]:
        yield ('VSCO-2-CE', f'Percussion/cymbal-crash1_{name}.wav', 'orchestral-cymbals', None, velocity, take, 2, 3.3)


def peak_marker(data, channels):
    values = array.array('h', data)
    if sys.byteorder == 'big':
        values.byteswap()
    width = round(.035 * RATE) * channels
    positions = range(0, len(values) - width, width)
    peak = max(positions, key=lambda start: sum(value * value for value in values[start:start + width]))
    return (peak + width // 2) // channels


def membrane_tuning(data, channels, root, roll):
    # Les modes dominants d'une timbale ne suivent pas les harmoniques d'une corde.
    # On cherche son mode d'accord dans une bande mesurée sur chaque fût.
    raw = array.array('h', data)
    if sys.byteorder == 'big':
        raw.byteswap()
    center = TIMPANI_CENTERS[root]
    stride = 8
    pitches = [center * (1 + delta * .002) for delta in range(-23, 24)]
    considered = [(.19, .80), (.49, 1.06), (.81, 1.44)] if roll else [(.075, .48), (.20, .69), (.32, .85)]
    peaks = []
    for start, stop in considered:
        points = [sum(raw[frame * channels:(frame + stride) * channels]) for frame in
                  range(round(start * RATE), min(round(stop * RATE), len(raw) // channels) - stride, stride)]
        if len(points) < 4:
            continue
        mean = sum(points) / len(points)
        window = [(value - mean) * (.5 - .5 * math.cos(math.tau * index / (len(points) - 1)))
                  for index, value in enumerate(points)]

        def power(hz):
            factor = 2 * math.cos(math.tau * hz * stride / RATE)
            a = b = 0
            for value in window:
                a, b = value + factor * a - b, a
            return a*a + b*b - factor*a*b

        peaks.append(max(pitches, key=power))
    observed = statistics.median(peaks) if peaks else center
    expected = 440 * 2 ** ((root - 69) / 12)
    return round(1200 * math.log2(observed / expected), 2)


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    BANK.mkdir(parents=True, exist_ok=True)
    available = {source: set(studio['paths'](source)) for source in ('VCSL', 'VSCO-2-CE')}
    samples = []
    pcm = bytearray()
    for source, path, instrument, root, velocity, variant, channels, length in select():
        if path not in available[source]:
            raise ValueError(f'Prise absente de la révision : {source}/{path}')
        repo, commit = SOURCES[source]
        url = f'https://raw.githubusercontent.com/{repo}/{commit}/{urllib.parse.quote(path)}'
        original = CACHE / f'{source}-{Path(path).name}'
        wav = studio['obtain'](url, original)
        if wav[:4] != b'RIFF' or wav[8:12] != b'WAVE':
            raise ValueError(f'Format de prise inattendu : {original}')
        data, frames = studio['encode'](original, channels, length)
        row = dict(instrument=instrument, source=source, path=path, root=root, velocity=velocity, variant=variant,
                   offset=len(pcm), frames=frames, channels=channels)
        if root is not None:
            row['tuning_cents'] = (membrane_tuning(data, channels, root, instrument == 'timpani-roll')
                                   if instrument.startswith('timpani') else studio['tuning_cents'](data, channels, root, instrument))
        if instrument == 'cymbal-swell':
            row['peakFrame'] = peak_marker(data, channels)
        samples.append(row)
        pcm.extend(data)
        if len(samples) % 12 == 0:
            print(f'{len(samples)} prises prêtes', flush=True)
    digest = hashlib.sha256(pcm).hexdigest()
    manifest = dict(version=1, rate=RATE, sha256=digest, samples=samples,
                    sources={source: dict(repository=SOURCES[source][0], commit=SOURCES[source][1], license='CC0-1.0')
                             for source in available})
    studio['write_atomically'](BANK / 'cinematic.pcm', pcm)
    studio['write_atomically'](BANK / 'cinematic.json', (json.dumps(manifest, indent=2) + '\n').encode('utf-8'))
    print(f'{len(samples)} prises, {len(pcm) / math.pow(1024, 2):.1f} Mio')


if __name__ == '__main__':
    main()
