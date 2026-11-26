"""Reconstitue la banque instrumentale à partir des dépôts CC0 épinglés."""
import argparse
import array
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

SOURCES = {
    'VCSL': ('sgossner/VCSL', 'c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e'),
    'VSCO-2-CE': ('sgossner/VSCO-2-CE', '440300901dfe9275fd84e0b7763af1f8443ae62e'),
    'virtuosity_drums': ('sfzinstruments/virtuosity_drums', '9f04cf9a734527edfbb0a4eee1f674e45bbf71bc'),
    'shinyguitar': ('sfzinstruments/karoryfer.shinyguitar', '57243cca85277dbcc120ce17c6178032f93c80f3'),
}
ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / 'output' / 'sample-sources'
BANK = ROOT / 'banks' / 'studio'
RATE = 44100


def obtain(url, target):
    if target.is_file():
        return target.read_bytes()
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=30) as response:
                data = response.read()
            target.write_bytes(data)
            return data
        except OSError:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def paths(source):
    repo, commit = SOURCES[source]
    data = obtain(f'https://api.github.com/repos/{repo}/git/trees/{commit}?recursive=1', CACHE / f'{source}.json')
    tree = json.loads(data)
    if tree['sha'] != commit or tree.get('truncated'):
        raise ValueError(f'Index incomplet : {source}')
    return [item['path'] for item in tree['tree'] if item['type'] == 'blob']


def midi_pitch(name, offset=0):
    letter, accidental, octave = re.fullmatch(r'([A-Ga-g])([#b]?)(\d)', name).groups()
    return (int(octave) + 1) * 12 + dict(C=0, D=2, E=4, F=5, G=7, A=9, B=11)[letter.upper()] + {'': 0, '#': 1, 'b': -1}[accidental] + offset


def select_samples():
    keys = set(paths('VCSL'))
    for note, midi in [('C2', 36), ('F#2', 42), ('C3', 48), ('F#3', 54), ('C4', 60), ('F#4', 66),
                       ('C5', 72), ('F#5', 78), ('C6', 84), ('F#6', 90), ('C7', 96)]:
        for layer, velocity in [(2, .29), (3, .59), (4, .84)]:
            path = f'Chordophones/Zithers/Grand Piano, Steinway B/NoSus/JHPiano_NoSus_Close_{note}_vl{layer}_rr1.wav'
            if path in keys:
                yield ('piano','VCSL',path,midi,velocity,1,2,2.8)

    for path in paths('VSCO-2-CE'):
        match = re.match(r'Strings/Solo Contrabass/Pizz/BKCtbss_Pizz_([A-G]#?)(\d)_v(1|3)_rr(1|2)\.wav$', path)
        if match:
            note, octave, layer, variant = match.groups()
            midi = 12 * (int(octave) + 2) + ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'].index(note)
            yield ('upright','VSCO-2-CE',path,midi,.32 if layer == '1' else .82,int(variant),1,1.65)

    drum_paths = paths('virtuosity_drums')
    mapping = {
        'kick': ('kick','snon',.72), 'snare': ('snare','center',1.0),
        'snare-ghost': ('snare','crossstick',.7), 'hat': ('hh','closed',.48),
        'ohat': ('hh','open',1.15), 'ride': ('ride','ride',1.7),
        'crash': ('crash','crash',2.4), 'tom': ('ltom','center',1.2),
    }
    for name, (group, hit, length) in mapping.items():
        pattern = re.compile(rf'Samples/mid/{group}/mid_{group}_{hit}_vl(\d+)(?:_rr([12]))?\.flac$')
        hits = []
        for path in drum_paths:
            match = pattern.fullmatch(path)
            if match:
                hits.append((int(match[1]), int(match[2] or 1), path))
        layers = sorted({layer for layer, _, _ in hits})
        chosen = dict(zip([layers[0], layers[len(layers)//2], layers[-1]], [.22, .56, .86]))
        for layer, variant, path in hits:
            if layer in chosen:
                yield (name,'virtuosity_drums',path,None,chosen[layer],variant,2,length)
        # Les séries monoprises très denses offrent une attaque voisine pour chaque couche.
        if len(layers) >= 8 and all(variant == 1 for _, variant, _ in hits):
            for layer, velocity in chosen.items():
                nearby = min((candidate for candidate in layers if candidate not in chosen), key=lambda candidate: abs(candidate - layer))
                path = next(path for candidate, _, path in hits if candidate == nearby)
                yield (name,'virtuosity_drums',path,None,velocity,2,2,length)

    orchestra = {
        'strings': ('VlnEns_susVib', ['G2','D3','A3','E4','B4','D5'], {1:.32,2:.8}, 2.3),
        'strings-pizz': ('VlnEns_Pizz', ['G2','D3','A3','E4','B4','D5'], {1:.32,2:.8}, 1.15),
        'flute': ('LDFlute_susNV', ['C3','E3','A3','E4','A4','E5','C6'], {1:.33,3:.82}, 2.15),
        'flute-staccato': ('LDFlute_stac', ['C4','A4','C5','A5'], {1:.4,3:.82}, .65),
        'clarinet': ('DCClar_susLong', ['D2','A#2','D3','A#3','D4','A#4','D5'], {1:.33,3:.82}, 2.2),
        'brass': ('MOHorn_sus', ['C1','G1','D2','A2','C3','D4','F4'], {1:.33,3:.83}, 2.15),
        'brass-staccato': ('MOHorn_stac', ['G1','D2','A2','D4'], {1:.4,3:.83}, .7),
    }
    for path in paths('VSCO-2-CE'):
        file = Path(path).name
        for inst, (prefix, pitches, layers, length) in orchestra.items():
            match = re.fullmatch(rf'{prefix}_([A-G]#?\d)_v(\d)(?:_(?:rr)?([12]))?(?:_sum)?\.wav', file)
            if match and match[1] in pitches and int(match[2]) in layers:
                yield (inst,'VSCO-2-CE',path,midi_pitch(match[1],12),layers[int(match[2])],int(match[3] or 1),1,length)

    guitars = paths('shinyguitar')
    for path in guitars:
        match = re.fullmatch(r'Samples/acoustic/(e2|a2|eb3|a3|eb4|a4|eb5|a5)_vl(1|4)_rr(1|2)_1.wav', path)
        if match:
            yield ('acoustic-guitar','shinyguitar',path,midi_pitch(match[1]),.3 if match[2]=='1' else .84,int(match[3]),1,1.8)
    for path in guitars:
        match = re.fullmatch(r'Samples/electric/(e2|a2|eb3|a3|eb4|a4|eb5|a5)_vl(1|4)_rr(1|2)_2.wav', path)
        if match:
            yield ('electric-guitar','shinyguitar',path,midi_pitch(match[1]),.3 if match[2]=='1' else .84,int(match[3]),1,2.3)


def select_extension():
    harp_notes = set('D2 F2 A2 C3 E3 G3 B3 D4 F4 A4 C5 E5 G5 B5 D6 F6 A6'.split())
    harp_pattern = re.compile(r'Chordophones/Composite Chordophones/Concert Harp/KSHarp_([A-G]\d)_(mf|f)[1-3]\.wav')
    vibes_pattern = re.compile(r'Idiophones/Struck Idiophones/Vibraphone/(?:Soft|Hard) Mallets/'
                               r'Vibes_(soft|hard)_([A-G]\d)_v([123])_rr[12]_Main\.wav')
    vibe_layers = {('soft', '1'): .29, ('soft', '2'): .56, ('hard', '3'): .88}
    # Les étiquettes du vibraphone et des violoncelles placent le do médian en C3 au lieu de C4.
    for path in sorted(paths('VCSL')):
        harp = harp_pattern.fullmatch(path)
        if harp and harp[1] in harp_notes:
            yield ('harp', 'VCSL', path, midi_pitch(harp[1]), .46 if harp[2] == 'mf' else .85, 1, 2, 2.7)
        vibes = vibes_pattern.fullmatch(path)
        if vibes and (vibes[1], vibes[3]) in vibe_layers:
            yield ('vibraphone', 'VCSL', path, midi_pitch(vibes[2], 12), vibe_layers[vibes[1], vibes[3]], 1, 2, 2.45)

    bow_pattern = re.compile(r'Strings/Cello Section/susvib/susvib_([A-G]\d)_v(1|3)_([12])\.wav')
    short_pattern = re.compile(r'Strings/Cello Section/(pizzT|spic)/\1_([A-G]\d)_v(1|2)_RR([12])\.wav')
    short_notes = set('C1 G1 D2 A2 E3 B3 F4'.split())
    for path in sorted(paths('VSCO-2-CE')):
        bow = bow_pattern.fullmatch(path)
        if bow:
            yield ('cello', 'VSCO-2-CE', path, midi_pitch(bow[1], 12), .35 if bow[2] == '1' else .81, int(bow[3]), 1, 2.6)
        short = short_pattern.fullmatch(path)
        if short and short[2] in short_notes:
            name, seconds = ('cello-pizz', 1.18) if short[1] == 'pizzT' else ('cello-staccato', .72)
            yield (name, 'VSCO-2-CE', path, midi_pitch(short[2], 12), .34 if short[3] == '1' else .82, int(short[4]), 1, seconds)


def encode(file, channels, length):
    data = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(file), '-t', str(length + .22),
                                    '-ar', str(RATE), '-ac', str(channels), '-f', 's16le', '-'])
    samples = array.array('h', data)
    if sys.byteorder == 'big':
        samples.byteswap()
    peak = max(abs(value) for value in samples)
    if not peak:
        raise ValueError(f'Prise silencieuse : {file.name}')
    start = max(0, next(i for i, value in enumerate(samples) if abs(value) > peak * .008) // channels - 24)
    frames = min(round(length * RATE), len(samples) // channels - start)
    scale = .87 * 32767 / peak
    tail = min(round(.075 * RATE), frames)
    out = array.array('h')
    for frame in range(frames):
        gain = scale * min(1, frame / 12, (frames - frame - 1) / tail)
        base = (start + frame) * channels
        out.extend(round(samples[base + channel] * gain) for channel in range(channels))
    if sys.byteorder == 'big':
        out.byteswap()
    return out.tobytes(), frames


def tuning_cents(data, channels, root, instrument):
    """Estime le décalage dans le voisinage de la hauteur documentée."""
    samples = array.array('h', data)
    if sys.byteorder == 'big':
        samples.byteswap()
    frequency = 440 * 2 ** ((root - 69) / 12)
    stride = max(1, min(12, int(RATE / (18 * frequency))))
    frames = len(samples) // channels
    start = min(round(.1 * RATE), frames // 6)
    stop = min(frames, start + round(.4 * RATE))
    window = [sum(samples[frame * channels:(frame + stride) * channels]) / (stride * channels)
              for frame in range(start, stop - stride, stride)]
    if len(window) < 3:
        return 0
    mean = sum(window) / len(window)
    window = [(sample - mean) * (.5 - .5 * math.cos(math.tau * i / (len(window) - 1)))
              for i, sample in enumerate(window)]

    def power(hz):
        factor = 2 * math.cos(math.tau * hz * stride / RATE)
        a = b = 0
        for sample in window:
            a, b = sample + factor * a - b, a
        return max(0, a*a + b*b - factor*a*b)

    # Une lame de vibraphone a des modes supérieurs inharmoniques. Seule sa fondamentale donne la note.
    partials = (1,) if instrument == 'vibraphone' else (1, 2, 3)
    grid = range(-60, 61, 5)
    matches = [sum(power(frequency * 2 ** (cents / 1200) * harmonic) for harmonic in partials) for cents in grid]
    index = max(range(len(matches)), key=matches.__getitem__)
    if index in (0, len(matches) - 1) or not matches[index]:
        return 0
    previous, score, following = matches[index - 1:index + 2]
    curve = previous - 2 * score + following
    offset = .5 * (previous - following) / curve if curve < 0 else 0
    return round(grid[index] + 5 * offset, 2)


def write_atomically(file, data):
    temporary = file.with_name(f'.{file.name}.{uuid.uuid4().hex}.tmp')
    try:
        temporary.write_bytes(data)
        os.replace(temporary, file)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--extension', action='store_true', help='Construire le supplément harpe, vibraphone et violoncelles.')
    args = parser.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    BANK.mkdir(parents=True, exist_ok=True)
    entries, packed = [], bytearray()
    for inst, source, path, midi, velocity, variant, channels, length in (select_extension() if args.extension else select_samples()):
        repo, commit = SOURCES[source]
        url = f'https://raw.githubusercontent.com/{repo}/{commit}/{urllib.parse.quote(path)}'
        original = CACHE / f'{source}-{Path(path).name}'
        obtain(url, original)
        data, frames = encode(original, channels, length)
        entry = dict(instrument=inst, source=source, path=path, root=midi, velocity=velocity,
                     variant=variant, offset=len(packed), frames=frames, channels=channels)
        if args.extension:
            entry['tuning_cents'] = tuning_cents(data, channels, midi, inst)
        entries.append(entry)
        packed.extend(data)
        if len(entries) % 12 == 0:
            print(f'{len(entries)} prises prêtes', flush=True)
    used = {entry['source'] for entry in entries}
    payload = dict(version=1 if args.extension else 3, rate=RATE, sha256=hashlib.sha256(packed).hexdigest(), samples=entries,
                   sources={name: dict(repository=repo, commit=commit, **({'license': 'CC0-1.0'} if args.extension else {}))
                            for name, (repo, commit) in SOURCES.items() if name in used})
    write_atomically(BANK / ('extension.pcm' if args.extension else 'studio.pcm'), packed)
    write_atomically(BANK / ('extension.json' if args.extension else 'manifest.json'), (json.dumps(payload, indent=2) + '\n').encode('utf-8'))
    print(f'{len(entries)} prises, {len(packed) / 1048576:.2f} Mio')


if __name__ == '__main__':
    main()
