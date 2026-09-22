"""
Emotion inference over one audio file.

This is a **faithful port** of `Music2emo.predict()`, not a simplification, and
that distinction was learned the hard way: the emotion head's input is not just
MERT features. `FeedforwardModelMTAttnCK.forward` consumes four tensors —
`x_mert` (1536), `x_chord_root`, `x_chord_attr` and `x_key` — whose construction
runs through a BTC chord recogniser, a music21 key analysis and a key-relative
chord re-spelling. Feeding zeros for the chord tensors would still run, but it
would no longer be this model's behaviour, and every valence/arousal number the
project measured on the real library would stop being comparable.

Faithfulness is therefore a test, not an aspiration: `tests/differential_test.py`
runs this module and upstream's `predict()` on the same file and requires the
numbers to agree.

Why not call `predict()` directly: it crashes deterministically on ~5% of a real
library. Measured on 60 tracks, three files died with
    IndexError: too many indices for tensor of dimension 2
inside the vendored `mert.py` feature extraction. Cause: `split_audio` cuts
30-second segments, so a 60.12 s track yields [720000, 720000, 2915] samples; the
2915-sample tail (0.12 s) produces exactly ONE frame at 24 kHz, and `.squeeze()`
then collapses both the batch and frame axes. The three failures' remainders were
2915 samples each; the smallest remainder among the 57 successes was 7392. So
`split_segments` drops any trailing remainder under 0.5 s, which on a three-minute
track is inaudible and removes the whole failure class.

Upstream line references are to `Music2Emotion-main/music2emo.py` unless stated.
"""
from __future__ import annotations

import hashlib
import importlib.metadata
import json
import time
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
import torch

TARGET_SR = 24000          # music2emo.py:79 resample_rate
SEGMENT_SECONDS = 30       # music2emo.py:78 segment_duration
MIN_TRAILING_SAMPLES = 12000   # 0.5 s at 24 kHz; measured safe boundary is 0.31 s
MAX_CHORD_SEQUENCE = 100   # music2emo.py:466
MOOD_TAG_OFFSET = 127      # music2emo.py:502 tag_list[127:]
MOOD_PREFIX = 'mood/theme---'  # music2emo.py:503

PITCH_CLASS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']  # :44
PITCH_NUM = {name: index for index, name in enumerate(PITCH_CLASS)}              # :46
MINOR_MAJOR = {'D-': 'C#', 'E-': 'D#', 'G-': 'F#', 'A-': 'G#', 'B-': 'A#'}       # :51
MINOR_MAJOR2 = {'Db': 'C#', 'Eb': 'D#', 'Gb': 'F#', 'Ab': 'G#', 'Bb': 'A#'}      # :54
SHIFT_MAJOR = PITCH_NUM                                                          # :58
SHIFT_MINOR = {'A': 0, 'A#': 1, 'B': 2, 'C': 3, 'C#': 4, 'D': 5,
               'D#': 6, 'E': 7, 'F': 8, 'F#': 9, 'G': 10, 'G#': 11}             # :63


def checksum(path: Path) -> str:
    """SHA-256 of the exact bytes, for binding a result to its input."""
    with path.open('rb') as stream:
        return 'sha256:' + hashlib.file_digest(stream, 'sha256').hexdigest()


# ─────────────────────────── MERT side (music2emo.py:243-282) ───────────────────────────

def split_segments(waveform: torch.Tensor, sample_rate: int) -> tuple[list[torch.Tensor], int]:
    """Cut 30-second segments, dropping a trailing remainder too short to be safe.

    @returns (segments, dropped_samples). The dropped count is reported rather than
      swallowed so a caller can see audio was discarded.
    """
    step = SEGMENT_SECONDS * sample_rate
    total = waveform.size(0)
    segments: list[torch.Tensor] = []
    dropped = 0
    start = 0
    while start < total:
        end = min(start + step, total)
        chunk = waveform[start:end]
        if chunk.size(0) < step and chunk.size(0) < MIN_TRAILING_SAMPLES:
            # Too short to yield more than one frame, where upstream's squeeze
            # collapses the frame axis and the three-index read raises IndexError.
            dropped = chunk.size(0)
            break
        segments.append(chunk)
        start = end
    return segments, dropped


def mert_embedding(extractor, segments: list[torch.Tensor], sample_rate: int) -> np.ndarray:
    """Layer-5+6 embedding per segment, averaged across segments (music2emo.py:265-277).

    Shape bookkeeping is the whole difficulty here, and it bites twice:
      - `hidden_states` yields 13 entries (embedding + 12 layers) of (1, frames, 768).
      - `squeeze()` drops the batch axis, leaving (13, frames, 768).
      - `[1:]` drops the embedding entry, `mean(dim=1)` averages over frames — note
        frames are axis 1 in that 3-D form, not axis 2 — and the two picked layers
        are concatenated by `np.concatenate` later, giving 1536.
    The first version of this function called `mean(dim=2)` and then `.squeeze()`,
    which averaged over *layers* and collapsed the batch axis, producing (12, 768)
    instead of (1536,). The shape assertion in `analyse` caught it.
    """
    per_segment: list[np.ndarray] = []
    for segment in segments:
        batch = extractor.processor(segment.float(), sampling_rate=sample_rate, return_tensors='pt')
        with torch.no_grad():
            outputs = extractor.model(**batch, output_hidden_states=True)
        stacked = torch.stack(outputs.hidden_states)
        squeezed = stacked.squeeze()
        # Refuse to guess when the axes collapsed: an explicit error beats a
        # silently wrong number. This replaces the crash upstream raises here.
        if squeezed.ndim != 3:
            raise ValueError(f'EMBEDDING_SHAPE_COLLAPSED:{tuple(stacked.shape)}')
        without_embedding = squeezed[1:, :, :]          # (12, frames, 768)
        per_segment.append(without_embedding.mean(dim=1).cpu().detach().numpy())
    mean_over_segments = np.mean(np.array(per_segment), axis=0)   # (12, 768)
    # Layers 5 and 6 of the 12 kept, concatenated — the 1536 the head expects.
    return np.concatenate([mean_over_segments[5], mean_over_segments[6]])


# ─────────────────────── Chord side (music2emo.py:284-338, utils/mir_eval_modules.py:32) ───────────────────────

def audio_cqt_features(audio_path: Path, config: dict) -> tuple[np.ndarray, float]:
    """Log-CQT frames in 10-second blocks (utils/mir_eval_modules.py:32-66)."""
    import librosa

    mp3, feature_cfg, model_cfg = config['mp3'], config['feature'], config['model']
    waveform, sr = librosa.load(str(audio_path), sr=mp3['song_hz'], mono=True)
    block = int(sr * mp3['inst_len'])
    cursor = 0
    feature: np.ndarray | None = None
    while cursor + block <= len(waveform):
        chunk = librosa.cqt(waveform[int(cursor):int(cursor + block)], sr=sr,
                            n_bins=feature_cfg['n_bins'], bins_per_octave=feature_cfg['bins_per_octave'],
                            hop_length=feature_cfg['hop_length'])
        feature = chunk if feature is None else np.concatenate((feature, chunk), axis=1)
        cursor = int(cursor + block)
    if cursor < len(waveform):
        chunk = librosa.cqt(waveform[cursor:], sr=sr, n_bins=feature_cfg['n_bins'],
                            bins_per_octave=feature_cfg['bins_per_octave'],
                            hop_length=feature_cfg['hop_length'])
        feature = chunk if feature is None else np.concatenate((feature, chunk), axis=1)
    if feature is None:
        raise ValueError('CQT_NO_FRAMES')
    feature = np.log(np.abs(feature) + 1e-6)
    return feature, mp3['inst_len'] / model_cfg['timestep']


def recognise_chords(audio_path: Path, checkpoint_path: Path, config: dict,
                     vendored_dir: Path) -> str:
    """Run the BTC recogniser and return the `.lab` body (music2emo.py:299-338)."""
    import sys
    if str(vendored_dir) not in sys.path:
        sys.path.insert(0, str(vendored_dir))
    from btc_model import BTC_model
    from mir_eval_modules import idx2voca_chord

    feature, feature_per_second = audio_cqt_features(audio_path, config)
    checkpoint = torch.load(str(checkpoint_path), map_location='cpu', weights_only=False)
    mean, std = checkpoint['mean'], checkpoint['std']
    model = BTC_model(config=config['model'])
    model.load_state_dict(checkpoint['model'])
    model.eval()

    normalised = (feature.T - mean) / std
    timestep = config['model']['timestep']
    pad = timestep - (normalised.shape[0] % timestep)
    normalised = np.pad(normalised, ((0, pad), (0, 0)), mode='constant', constant_values=0)
    instances = normalised.shape[0] // timestep
    idx_to_chord = idx2voca_chord()

    start_time = 0.0
    lines: list[str] = []
    with torch.no_grad():
        tensor = torch.tensor(normalised, dtype=torch.float32).unsqueeze(0)
        for t in range(instances):
            attended, _ = model.self_attn_layers(tensor[:, timestep * t:timestep * (t + 1), :])
            prediction, _ = model.output_layer(attended)
            prediction = prediction.squeeze()
            for i in range(timestep):
                if t == 0 and i == 0:
                    prev_chord = prediction[i].item()
                    continue
                if prediction[i].item() != prev_chord:
                    lines.append('%.3f %.3f %s\n' % (start_time, feature_per_second * (timestep * t + i),
                                                     idx_to_chord[prev_chord]))
                    start_time = feature_per_second * (timestep * t + i)
                    prev_chord = prediction[i].item()
                if t == instances - 1 and i + pad == timestep:
                    if start_time != feature_per_second * (timestep * t + i):
                        lines.append('%.3f %.3f %s\n' % (start_time, feature_per_second * (timestep * t + i),
                                                         idx_to_chord[prev_chord]))
                    break
    return ''.join(lines)


def key_from_lab(lab_body: str, work_dir: Path) -> tuple[str, str]:
    """Re-spell the `.lab` as a MIDI skeleton and read its key (music2emo.py:348-404).

    @param work_dir - Per-call scratch directory; the `.lab` and `.midi` are written
      here so two concurrent analyses cannot overwrite each other's intermediates.
    @returns (key_signature, key_type) with `"None"` for an unreadable analysis.
    """
    import mir_eval
    import pretty_midi as pm
    from music21 import converter

    work_dir.mkdir(parents=True, exist_ok=True)
    lab_path = work_dir / 'chords.lab'
    lab_path.write_text(lab_body, encoding='utf-8')

    starts, ends, pitches = [], [], []
    intervals, chords = mir_eval.io.load_labeled_intervals(str(lab_path))
    for pitch in range(12):
        for index, (interval, chord) in enumerate(zip(intervals, chords)):
            root_num, relative_bitmap, _ = mir_eval.chord.encode(chord)
            tmp_label = mir_eval.chord.rotate_bitmap_to_root(relative_bitmap, root_num)[pitch]
            if index == 0:
                start_time, label = interval[0], tmp_label
                continue
            if tmp_label != label:
                if label == 1.0:
                    starts.append(start_time), ends.append(interval[0]), pitches.append(pitch + 48)
                start_time, label = interval[0], tmp_label
            if index == (len(intervals) - 1) and label == 1.0:
                starts.append(start_time), ends.append(interval[1]), pitches.append(pitch + 48)

    midi = pm.PrettyMIDI()
    instrument = pm.Instrument(program=0)
    for start, end, pitch in zip(starts, ends, pitches):
        instrument.notes.append(pm.Note(velocity=120, pitch=pitch, start=start, end=end))
    midi.instruments.append(instrument)
    midi_path = work_dir / 'chords.midi'
    midi.write(str(midi_path))

    try:
        signature = str(converter.parse(str(midi_path)).analyze('key'))
        parts = signature.split()
        key_signature = parts[0].replace('-', 'b')
        key_type = parts[1] if len(parts) > 1 else 'major'
    except Exception:  # noqa: BLE001 - upstream treats any analysis failure as "None"
        key_signature, key_type = 'None', 'major'
    return key_signature, key_type


def normalize_chords(lab_body: str, key: str, key_type: str = 'major') -> list[str]:
    """Re-spell chords relative to the tonic (music2emo.py:82-136)."""
    if key == 'None':
        shift = 0
    else:
        key = key[0].upper() + key[1:] if len(key) > 1 else key[0].upper()
        key = MINOR_MAJOR2.get(key, key)
        shift = SHIFT_MAJOR[key] if key_type == 'major' else SHIFT_MINOR[key]

    converted: list[str] = []
    for line in lab_body.splitlines():
        if not line.strip():
            continue
        parts = line.split()
        start_time, end_time, chord = parts[0], parts[1], parts[2]
        if chord in ('N', 'X'):
            spelled = chord
        elif ':' in chord:
            pitch, attr = chord.split(':')[0], chord.split(':')[1]
            spelled = PITCH_CLASS[(PITCH_NUM[pitch] - shift) % 12] + ':' + attr
        else:
            spelled = PITCH_CLASS[(PITCH_NUM[chord] - shift) % 12]
        converted.append(f'{start_time} {end_time} {spelled}\n')
    return converted


def encode_chords(normalized: list[str], data_dir: Path) -> tuple[np.ndarray, np.ndarray]:
    """Encode re-spelled chords to (root, attribute) index sequences (music2emo.py:433-452)."""
    chord_root = json.loads((data_dir / 'chord_root.json').read_text(encoding='utf-8'))
    chord_attr = json.loads((data_dir / 'chord_attr.json').read_text(encoding='utf-8'))
    roots, attrs = [], []
    for line in normalized:
        chord = line.split()[2]
        pieces = chord.split(':')
        if len(pieces) == 1:
            root_name = 'N' if pieces[0] == 'X' else pieces[0]
            roots.append(chord_root[root_name])
            attrs.append(0 if root_name in ('N', 'X') else 1)
        else:
            roots.append(chord_root[pieces[0]])
            attrs.append(chord_attr[pieces[1]])
    # Pad or truncate to the trained sequence length, as upstream does.
    roots_arr = np.array(roots, dtype=np.int64)
    attrs_arr = np.array(attrs, dtype=np.int64)
    if len(roots_arr) > MAX_CHORD_SEQUENCE:
        return roots_arr[:MAX_CHORD_SEQUENCE], attrs_arr[:MAX_CHORD_SEQUENCE]
    pad = MAX_CHORD_SEQUENCE - len(roots_arr)
    return (np.concatenate([roots_arr, [0] * pad]),
            np.concatenate([attrs_arr, [0] * pad]))


# ─────────────────────────────────── Assembly ───────────────────────────────────

def analyse(audio_path: Path, data_dir: Path, weights_path: Path,
            source_sha256: str | None = None) -> dict:
    """Run one file end to end and return a JSON-serialisable emotion result."""
    import sys

    import torchaudio
    import yaml

    if not audio_path.is_absolute() or not audio_path.is_file():
        raise ValueError('AUDIO_INVALID_SOURCE')
    actual = checksum(audio_path)
    if source_sha256 is not None and actual != source_sha256:
        raise ValueError('AUDIO_SOURCE_CHANGED')

    data_dir = data_dir.resolve()
    vendored = Path(__file__).resolve().parent / 'vendored'
    if str(vendored) not in sys.path:
        sys.path.insert(0, str(vendored))

    config = yaml.safe_load((data_dir / 'run_config.yaml').read_text(encoding='utf-8'))
    config['feature']['large_voca'] = True
    config['model']['num_chords'] = 170
    started = time.monotonic()

    # ── MERT features ──
    # This mirrors music2emo.py:247-251 exactly, including the specific resampler:
    # upstream uses `torchaudio.transforms.Resample` (music2emo.py:143), whose kernel
    # and edge handling differ from `torchaudio.functional.resample`. The first
    # version of this function used the latter, and the differential test caught the
    # consequence — waveforms that were merely *close* rather than identical, which
    # MERT's transformer amplified from ~1e-6 to as much as 2.7e-1 on some inputs
    # while leaving others at 1e-6. A model this sensitive has no tolerance for a
    # "equivalent" resampler.
    waveform, sample_rate = torchaudio.load(str(audio_path))
    if waveform.shape[0] > 1:
        waveform = waveform.mean(dim=0).unsqueeze(0)
    waveform = waveform.squeeze()
    if sample_rate != TARGET_SR:
        waveform = torchaudio.transforms.Resample(sample_rate, TARGET_SR)(waveform)
    segments, dropped = split_segments(waveform, TARGET_SR)
    if not segments:
        raise ValueError('AUDIO_TOO_SHORT')

    from mert import FeatureExtractorMERT
    extractor = FeatureExtractorMERT(model_name='m-a-p/MERT-v1-95M',
                                     device=torch.device('cpu'), sr=TARGET_SR)
    mert = mert_embedding(extractor, segments, TARGET_SR)
    if mert.shape != (1536,):
        raise ValueError(f'MERT_EMBEDDING_SHAPE:{tuple(mert.shape)}')

    # ── Chord and key features ──
    lab_body = recognise_chords(audio_path, data_dir / 'btc_model_large_voca.pt', config, vendored)
    # Private OS temp storage supports read-only installs and concurrent workers.
    # TemporaryDirectory's finally cleanup also runs when key analysis raises.
    with TemporaryDirectory(prefix='dsh-bgm-') as scratch:
        key_signature, key_type = key_from_lab(lab_body, Path(scratch))
    normalized = normalize_chords(lab_body, key_signature, key_type)
    roots, attrs = encode_chords(normalized, data_dir)
    # Upstream's key-mode feature is dead: `music2emo.py:402-412` sanitizes the
    # signature first (`A-` -> `Ab`), then reads `mode = key_signature.split()[-1]`,
    # which yields the tonic (`'a'`, `'Ab'`, `'C'`) and never the word "major" or
    # "minor". `mode_to_idx.get(mode, 0)` therefore always falls through to 0, so
    # `x_key` is the constant tensor([0]) for every input. Verified by capturing the
    # tensor upstream's head actually receives: hash af5570f5a1810b7a == tensor([0]).
    #
    # This pipeline reproduces that constant on purpose. Feeding the real mode would
    # make the model behave differently from every measurement this project took, and
    # the caller-facing valence/arousal targets are calibrated against those numbers.
    # Fixing the upstream bug is a separate decision that would require re-measuring
    # the whole library.
    mode = 0

    # ── Emotion head ──
    from model_linear_mt_attn_ck import FeedforwardModelMTAttnCK
    head = FeedforwardModelMTAttnCK(input_size=768 * 2, output_size_classification=56,
                                    output_size_regression=2)
    checkpoint = torch.load(str(weights_path), map_location='cpu', weights_only=False)
    state = {key.replace('model.', ''): value for key, value in checkpoint['state_dict'].items()}
    head.load_state_dict({k: v for k, v in state.items() if k in set(head.state_dict().keys())})
    head.eval()

    with torch.no_grad():
        classification, regression = head({
            'x_mert': torch.from_numpy(mert).float().unsqueeze(0),
            'x_chord_root': torch.tensor(roots, dtype=torch.long).unsqueeze(0),
            'x_chord_attr': torch.tensor(attrs, dtype=torch.long).unsqueeze(0),
            'x_key': torch.tensor([mode], dtype=torch.long).unsqueeze(0),
        })
    # Upstream sigmoids only the classification branch (music2emo.py:497).
    probs = torch.sigmoid(classification).squeeze().tolist()
    valence, arousal = regression.squeeze().tolist()

    tag_list = np.load(str(data_dir / 'tag_list.npy'), allow_pickle=True)[MOOD_TAG_OFFSET:]
    mood_list = [str(tag).replace(MOOD_PREFIX, '') for tag in tag_list]
    moods = [mood_list[i] for i, p in enumerate(probs) if p > 0.5]

    return {
        'schema_version': 1,
        'source_sha256': actual,
        'seconds': round(waveform.size(0) / TARGET_SR, 3),
        'segments_used': len(segments),
        'dropped_trailing_samples': dropped,
        'key_signature': key_signature,
        'key_type': key_type,
        'chord_count': int(len(normalized)),
        'valence': float(valence),
        'arousal': float(arousal),
        'moods': moods,
        'elapsed_seconds': round(time.monotonic() - started, 2),
        'dependencies': {name: importlib.metadata.version(name)
                         for name in ('torch', 'transformers', 'librosa', 'music21')},
    }
