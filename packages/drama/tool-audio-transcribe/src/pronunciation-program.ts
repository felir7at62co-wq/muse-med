/** Run the package-owned preprocessing and pronunciation contrast in the verified local interpreter. */
export const pronunciationProgram = String.raw`
import importlib.metadata
import json
from pathlib import Path
import re
import sys

library, model_dir, request, *pcm_files = sys.argv[1:]

def deny_network(event, args):
    if event.startswith("socket.") and event not in {"socket.__new__", "socket.gethostname"}:
        raise RuntimeError("Network is disabled for local speech")

sys.addaudithook(deny_network)
sys.path.insert(0, library)
versions = {d.metadata["Name"].lower().replace("_", "-"): d.version
            for d in importlib.metadata.distributions(path=[library])}
if sys.version_info[:2] != (3, 13):
    raise RuntimeError("Local speech requires CPython 3.13")
for name, version in {"numpy": "2.5.5", "onnxruntime": "1.32.0", "kaldi-native-fbank": "1.23.3"}.items():
    if versions.get(name) != version:
        raise RuntimeError("Local speech dependency version differs")

import kaldi_native_fbank as knf
import numpy as np
import onnxruntime as ort

model = Path(model_dir)
vocab = json.loads((model / "vocab_pinyin.json").read_text(encoding="utf-8"))
tokens, target_index, alternative = json.loads(request)
expected = [vocab[token] for token in tokens]
contrast = expected.copy()
contrast[target_index] = vocab[alternative]
normalization = (model / "am.mvn").read_text(encoding="utf-8")

def normalization_vector(tag):
    match = re.search(r"<" + tag + r">\s+560\s+560\s+<LearnRateCoef>\s+\S+\s+\[([^\]]+)\]", normalization)
    if match is None:
        raise ValueError("Missing audio normalization data")
    values = np.fromstring(match[1], dtype=np.float32, sep=" ")
    if values.size != 560 or not np.isfinite(values).all():
        raise ValueError("Invalid audio normalization data")
    return values

shift = normalization_vector("AddShift")
scale = normalization_vector("Rescale")

def features(wave):
    options = knf.FbankOptions()
    frames = options.frame_opts
    frames.samp_freq = 16000
    frames.dither = 0.0
    frames.window_type = "hamming"
    frames.frame_length_ms = 25.0
    frames.frame_shift_ms = 10.0
    frames.snip_edges = True
    frames.remove_dc_offset = True
    frames.preemph_coeff = 0.97
    options.mel_opts.num_bins = 80
    options.mel_opts.low_freq = 20.0
    options.mel_opts.high_freq = 0.0
    options.energy_floor = 0.0
    options.use_energy = False
    extractor = knf.OnlineFbank(options)
    extractor.accept_waveform(16000, (wave * (32768.0 / (np.max(np.abs(wave)) + 1e-8))).tolist())
    extractor.input_finished()
    size = extractor.num_frames_ready
    matrix = np.asarray([extractor.get_frame(i) for i in range(size)], dtype=np.float32)
    # The SenseVoice frontend stacks seven frames, advances six and repeats edge frames.
    indices = np.arange((size + 5) // 6)[:, None] * 6 + np.arange(7)[None, :] - 3
    return (matrix[indices.clip(0, size - 1)].reshape((-1, 560)) + shift) * scale

def log_ctc(log_probs, symbols):
    ids = np.zeros(2 * len(symbols) + 1, dtype=np.int64)
    ids[1::2] = symbols
    can_skip = (ids[2:] != 0) & (ids[2:] != ids[:-2])
    forward = np.full(ids.size, -np.inf, dtype=np.float64)
    forward[0] = 0
    for timestep in log_probs:
        single = np.r_[-np.inf, forward[:-1]]
        double = np.full_like(forward, -np.inf)
        double[2:] = np.where(can_skip, forward[:-2], -np.inf)
        forward = np.logaddexp(np.logaddexp(forward, single), double) + timestep[ids]
    return np.logaddexp(forward[-1], forward[-2])

options = ort.SessionOptions()
options.intra_op_num_threads = 2
options.inter_op_num_threads = 1
engine = ort.InferenceSession(str(model / "sensevoice_dual_int8.onnx"), sess_options=options,
                              providers=["CPUExecutionProvider"])

def observe(filename):
    wav = np.fromfile(filename, dtype="<i2").astype(np.float32) / 32768.0
    if not np.any(wav):
        return None
    acoustic = features(wav)
    output, lengths = engine.run(["pinyin_log_probs", "encoder_lens"],
                                 {"feats": acoustic[None, :, :],
                                  "feats_lens": np.asarray([len(acoustic)], dtype=np.int32)})
    if output.ndim != 3 or output.shape[1:] != (1, 1191) or lengths.tolist() != [len(acoustic)]:
        raise ValueError("Unexpected acoustic model result shape")
    log_probs = output[:, 0, :]
    if len(log_probs) != len(acoustic) or not np.isfinite(log_probs).all():
        raise ValueError("Invalid acoustic model result")
    greedy = []
    frames = []
    previous = 0
    for frame, value in enumerate(np.argmax(log_probs, axis=1).tolist()):
        if value and value != previous:
            greedy.append(value)
            frames.append(frame)
        previous = value
    matches = []
    for i in range(len(greedy) - len(expected) + 1):
        phrase = greedy[i:i+len(expected)]
        if phrase == expected:
            matches.append((tokens[target_index], frames[i+target_index]))
        elif phrase == contrast:
            matches.append((alternative, frames[i+target_index]))
    if len(matches) != 1:
        return None
    anchor, frame = matches[0]
    margin = log_ctc(log_probs, contrast) - log_ctc(log_probs, expected)
    if not np.isfinite(margin):
        return None
    return {"anchor": anchor, "frame": frame, "margin": round(float(margin), 5)}

print(json.dumps([observe(file) for file in pcm_files], allow_nan=False))
`
