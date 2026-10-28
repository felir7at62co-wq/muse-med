"""Build hash-bound cloud metadata from sampled audio, without uploading or editing source audio."""
from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sys

MODEL_ID = 'laion/clap-htsat-unfused'
REVISION = '8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a'
WEIGHTS_SHA256 = '1cd3c601bc4afe0fa87be3de4c13dd2cfadd249fac1e29acf74a9b296c3219bb'

# These are musical-response hypotheses, not claims that audio encodes a particular plot.
PROMPTS = {
    'family': ['Warm heartfelt background music for an intimate family reunion.', 'Tender emotional music about family affection.'],
    'romance': ['Romantic background music for lovers falling in love.', 'Intimate passionate music for a romantic scene.'],
    'comedy': ['Funny comic background music for a silly comedy scene.', 'Humorous quirky music for a funny situation.'],
    'suspense': ['Mysterious suspenseful background music for an investigation.', 'Quiet tense music with uncertainty and intrigue.'],
    'danger': ['Threatening ominous music for approaching danger.', 'Anxious alarming background music for a dangerous situation.'],
    'action': ['Intense rhythmic action music for fighting and chasing.', 'Aggressive battle music with driving percussion.'],
    'sadness': ['Sad sorrowful music for grief and loss.', 'Melancholic emotional music expressing regret.'],
    'hope': ['Hopeful uplifting music for a new beginning.', 'Inspiring optimistic background music.'],
    'daily_life': ['Casual relaxed background music for ordinary daily life.', 'Light simple music for everyday conversation.'],
    'epic': ['Epic cinematic trailer music with a huge orchestral climax.', 'Grand heroic triumphant music with powerful drums.'],
    'restrained': ['Subtle understated sparse music with restrained emotion.', 'Minimal quiet background music that leaves space for dialogue.'],
    'gentle': ['Gentle soft soothing music with a peaceful mood.', 'Tender calming background music.'],
    'solemn': ['Solemn dignified serious ceremonial music.', 'Grave respectful background music.'],
    'energetic': ['Fast energetic exciting music with a strong beat.', 'Lively high energy rhythmic music.'],
    'playful': ['Playful cheerful mischievous background music.', 'Light bouncy whimsical music.'],
    'dark': ['Dark oppressive brooding background music.', 'Menacing gloomy atmospheric music.'],
}
INSTRUMENTS = {
    'piano': 'Music prominently featuring acoustic piano.',
    'strings': 'Music prominently featuring orchestral strings and violins.',
    'acoustic_guitar': 'Music prominently featuring acoustic guitar.',
    'electric_guitar': 'Rock music prominently featuring electric guitar.',
    'synthesizer': 'Electronic music prominently featuring synthesizers.',
    'drums': 'Music prominently featuring rhythmic drums and percussion.',
    'brass': 'Orchestral music prominently featuring brass horns and trumpets.',
    'flute': 'Music prominently featuring a flute.',
    'chinese_plucked_strings': 'Chinese instrumental music featuring guzheng or pipa plucked strings.',
    'erhu': 'Chinese instrumental music featuring the erhu bowed string instrument.',
    'bells': 'Music prominently featuring bells, chimes or a music box.',
    'ambient_texture': 'Ambient soundscape music with sustained atmospheric textures.',
}
VOCALS = {
    'instrumental': 'Instrumental music without any human singing or speaking.',
    'singing': 'Music with a human voice singing.',
    'speech': 'Music with a person speaking or talking over it.',
}
ZH = {'family': '亲情', 'romance': '浪漫', 'comedy': '喜剧', 'suspense': '悬疑', 'danger': '危机',
      'action': '动作', 'sadness': '悲伤', 'hope': '希望', 'daily_life': '日常', 'epic': '史诗',
      'restrained': '克制', 'gentle': '温柔', 'solemn': '庄重', 'energetic': '活力', 'playful': '俏皮', 'dark': '压迫'}


def sample_starts(duration: float, window: float, count: int) -> list[float]:
    """Cover the beginning, middle and ending without pretending unsampled spans were inferred."""
    if duration <= 0 or window <= 0 or count < 1:
        raise ValueError('duration, window and sample count must be positive')
    last = max(0.0, duration - window)
    if count == 1 or last == 0:
        return [0.0]
    return sorted({round(last * i / (count - 1), 3) for i in range(count)})


def covered_seconds(windows: list[tuple[float, float]]) -> float:
    """Count the union of sampled intervals so overlapping excerpts are not double-counted."""
    total, cursor = 0.0, 0.0
    for start, end in sorted(windows):
        total += max(0.0, end - max(cursor, start))
        cursor = max(cursor, end)
    return round(total, 3)


def atomic_json(path: Path, value: object) -> None:
    """Replace only the requested metadata output after serializing finite JSON."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.part')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False)+'\n', encoding='utf-8')
    temporary.replace(path)


def main() -> None:
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog', type=Path, required=True)
    parser.add_argument('--audio-dir', type=Path, required=True)
    parser.add_argument('--model-dir', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--window-seconds', type=float, default=10)
    parser.add_argument('--samples', type=int, default=6)
    parser.add_argument('--threads', type=int, default=4)
    parser.add_argument('--limit', type=int)
    args = parser.parse_args()
    if args.window_seconds != 10 or not 1 <= args.samples <= 12 or args.threads < 1:
        parser.error('CLAP recipe uses 10-second windows, 1–12 samples and positive thread count')
    weights = args.model_dir / 'pytorch_model.bin'
    with weights.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != WEIGHTS_SHA256:
            raise ValueError('Model weights do not match the pinned revision')
    import numpy as np
    import librosa
    import soundfile as sf
    import torch
    from transformers import ClapModel, ClapProcessor

    torch.set_num_threads(args.threads)
    torch.manual_seed(0)
    processor = ClapProcessor.from_pretrained(args.model_dir, local_files_only=True)
    model = ClapModel.from_pretrained(args.model_dir, local_files_only=True, use_safetensors=False).eval()
    categories = {**PROMPTS, **{k: [v] for k, v in INSTRUMENTS.items()}, **{k: [v] for k, v in VOCALS.items()}}
    labels, texts, slices = list(categories), [], {}
    for label, prompts in categories.items():
        slices[label] = slice(len(texts), len(texts)+len(prompts))
        texts.extend(prompts)
    with torch.inference_mode():
        embedded = model.get_text_features(**processor(text=texts, return_tensors='pt', padding=True))
        text_features = torch.nn.functional.normalize(embedded, dim=-1)

    catalog = json.loads(args.catalog.read_text(encoding='utf-8'))
    selected = catalog['tracks'][:args.limit] if args.limit else catalog['tracks']
    analyzed_at = datetime.now(timezone.utc).isoformat()
    recipe = {'model_id': MODEL_ID, 'model_revision': REVISION, 'weights_sha256': WEIGHTS_SHA256,
              'window_seconds': args.window_seconds, 'samples_per_track': args.samples,
              'human_reviewed': False, 'score_meaning': 'raw cosine similarity, not calibrated confidence or suitability',
              'prompts': categories, 'libraries': {name: importlib.metadata.version(name)
              for name in ['torch', 'transformers', 'numpy', 'librosa', 'soundfile']}}
    recipe_hash = 'sha256:' + hashlib.sha256(json.dumps(recipe, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()
    recipe['sha256'] = recipe_hash
    profiles = {}
    for ordinal, track in enumerate(selected, 1):
        number = track['object_key'].rsplit('/', 1)[-1]
        source = args.audio_dir / f'{number}{Path(track["name"]).suffix.lower()}'
        with source.open('rb') as stream:
            sha256 = 'sha256:' + hashlib.file_digest(stream, 'sha256').hexdigest()
        if sha256 != track['sha256'] or source.stat().st_size != track['bytes']:
            raise ValueError(f'Source differs from the cloud catalogue: {number}')
        checkpoint = args.output_dir / 'profiles' / f'{sha256[7:]}.json'
        if checkpoint.exists():
            profile = json.loads(checkpoint.read_text(encoding='utf-8'))
            if profile.get('recipe_sha256') == recipe_hash and profile.get('source_sha256') == sha256:
                track['audio_profile'] = profile
                profiles[track['id']] = profile
                print(f'{ordinal}/{len(selected)} reused {number} {track["name"]}', flush=True)
                continue
        data, sample_rate = sf.read(source, dtype='float32', always_2d=True)
        mono = np.mean(data, axis=1)
        duration = len(mono) / sample_rate
        starts = sample_starts(duration, args.window_seconds, args.samples)
        clips, bounds = [], []
        for start in starts:
            end = min(duration, start + args.window_seconds)
            clip = mono[round(start * sample_rate):round(end * sample_rate)]
            if sample_rate != 48000:
                clip = librosa.resample(clip, orig_sr=sample_rate, target_sr=48000)
            clips.append(clip)
            bounds.append((start, end))
        inputs = processor(audio=clips, sampling_rate=48000, return_tensors='pt', padding=True)
        with torch.inference_mode():
            audio_features = torch.nn.functional.normalize(model.get_audio_features(**inputs), dim=-1)
            similarities = (audio_features @ text_features.T).cpu().numpy()
        scores = np.stack([similarities[:, slices[label]].mean(axis=1) for label in labels], axis=1)
        means = dict(zip(labels, scores.mean(axis=0).tolist()))

        def top(values: dict, subset: dict, count: int) -> list[dict]:
            return [{'tag': label, 'similarity': round(float(values[label]), 6)}
                    for label in sorted(subset, key=lambda name: values[name], reverse=True)[:count]]

        windows = []
        for (start, end), clip_scores in zip(bounds, scores):
            values = dict(zip(labels, clip_scores.tolist()))
            windows.append({'start_seconds': round(start, 3), 'end_seconds': round(end, 3),
                            'tags': top(values, PROMPTS, 3)})
        tempo_audio = librosa.resample(mono[:round(min(duration, 90)*sample_rate)], orig_sr=sample_rate, target_sr=22050)
        tempo, _ = librosa.beat.beat_track(y=tempo_audio, sr=22050, trim=False)
        tempo_value = float(np.asarray(tempo).reshape(-1)[0])
        profile = {'version': 1, 'source_sha256': sha256, 'analysis_method': 'sampled_clap_cosine_v1',
                   'model_id': MODEL_ID, 'model_revision': REVISION, 'recipe_sha256': recipe_hash, 'human_reviewed': False,
                   'analyzed_at': analyzed_at, 'duration_seconds': round(duration, 3),
                   'sample_count': len(bounds), 'sampled_seconds': covered_seconds(bounds),
                   'estimated_tempo_bpm': round(tempo_value, 2) if tempo_value > 0 else None,
                   'rms_dbfs': round(float(20 * np.log10(max(float(np.sqrt(np.mean(mono ** 2))), 1e-6))), 2),
                   'peak_dbfs': round(float(20 * np.log10(max(float(np.max(np.abs(data))), 1e-6))), 2),
                   'tags': top(means, PROMPTS, 3), 'instruments': top(means, INSTRUMENTS, 3),
                   'vocals': top(means, VOCALS, 3), 'windows': windows,
                   'tag_scores': {label: round(float(means[label]), 6) for label in PROMPTS},
                   'review_note': '自动音频抽样推断，未人工试听；相似度不是置信度，配器/人声/剧情适用性须试听核验。'}
        atomic_json(checkpoint, profile)
        track['audio_profile'] = profile
        profiles[track['id']] = profile
        print(f'{ordinal}/{len(selected)} analyzed {number} {track["name"]}: ' + ','.join(x['tag'] for x in profile['tags']), flush=True)
    if len(selected) != len(catalog['tracks']):
        atomic_json(args.output_dir / 'preview.json', {'recipe': recipe, 'tracks': selected})
        return
    atomic_json(args.output_dir / 'catalog.json', catalog)
    atomic_json(args.output_dir / 'tag-index.json', {'version': 1, 'generated_at': analyzed_at,
                'track_count': len(selected), 'recipe': recipe,
                'tracks': [{'track_id': t['id'], 'name': t['name'], 'url': t['url'], 'audio_profile': profiles[t['id']]} for t in selected]})
    lines = ['# 云端 BGM 标签索引', '', f'{len(selected)} 首自动音频抽样分析；未人工试听。标签为候选线索，相似度不是置信度。', '',
             '| 编号 | 音乐 | 音频推断标签 | 时长 | 分析覆盖 | 估计 BPM |', '|---|---|---|---|---|---|']
    for track in selected:
        p = profiles[track['id']]
        lines.append(f'| {track["object_key"].rsplit("/",1)[-1]} | {track["name"].replace("|","/")} | '
                     + '、'.join(ZH[x['tag']] for x in p['tags'])
                     + f' | {p["duration_seconds"]}s | {p["sampled_seconds"]}s | {p["estimated_tempo_bpm"]} |')
    (args.output_dir / '标签索引.md').write_text('\n'.join(lines)+'\n', encoding='utf-8')
    with (args.output_dir / 'tag-index.csv').open('w', encoding='utf-8-sig', newline='') as stream:
        writer = csv.writer(stream)
        writer.writerow(['编号', '音乐名称', '音频推断标签', '配器候选', '人声候选', '时长秒', '抽样覆盖秒', '估计BPM', '人工试听', '音频SHA256', '音频地址'])
        for track in selected:
            p = profiles[track['id']]
            writer.writerow([track['object_key'].rsplit('/', 1)[-1], track['name'], '、'.join(ZH[x['tag']] for x in p['tags']),
                             ', '.join(x['tag'] for x in p['instruments']), ', '.join(x['tag'] for x in p['vocals']),
                             p['duration_seconds'], p['sampled_seconds'], p['estimated_tempo_bpm'], '未人工试听', track['sha256'], track['url']])
    print(f'Complete: {len(selected)} verified tracks -> {args.output_dir}', flush=True)


if __name__ == '__main__':
    main()
