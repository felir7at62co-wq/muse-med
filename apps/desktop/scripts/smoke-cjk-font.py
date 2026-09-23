"""Check bundled libass font selection and visible Chinese subtitle/watermark pixels without ASR."""
import argparse
import importlib.util
import os
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ffmpeg', required=True)
    parser.add_argument('--fonts', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--ass', help='Use an ASS file emitted by the TypeScript renderer instead of Python')
    args = parser.parse_args()
    fonts = Path(args.fonts).resolve()
    assert (fonts / 'NotoSansCJKsc-Regular.otf').is_file(), 'bundled CJK font missing'
    work = Path(args.output).resolve()
    work.mkdir(parents=True, exist_ok=True)
    os.environ['MUSE_FONTS_DIR'] = str(fonts)
    os.environ['MUSE_FONT_FAMILY'] = 'Noto Sans CJK SC'
    source = Path(__file__).resolve().parents[3] / 'packages/drama/skills/skills/tweet-drama-background-render/scripts/render_episode.py'
    spec = importlib.util.spec_from_file_location('font_smoke_renderer', source)
    renderer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(renderer)
    srt, ass = work / 'chinese.srt', work / 'chinese.ass'
    srt.write_text('1\n00:00:00,000 --> 00:00:01,000\n简体字幕测试\n', encoding='utf-8')
    if args.ass:
        ass.write_bytes(Path(args.ass).read_bytes())
    else:
        renderer.write_ass(srt, ass)
    text = ass.read_text(encoding='utf-8')
    assert 'Style: Default,Noto Sans CJK SC,68,' in text
    assert 'Style: Watermark,Noto Sans CJK SC,44,' in text
    command = [str(Path(args.ffmpeg).resolve()), '-hide_banner', '-loglevel', 'verbose', '-y', '-f', 'lavfi', '-i',
               'color=c=black:s=1080x1920:r=1:d=1', '-vf', renderer.subtitle_filter(ass),
               '-frames:v', '1', '-threads', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', 'chinese.gray']
    result = subprocess.run(command, cwd=work, capture_output=True, text=True, encoding='utf-8', errors='replace')
    (work / 'ffmpeg-fonts.log').write_text(result.stderr, encoding='utf-8')
    assert result.returncode == 0, result.stderr
    assert 'NotoSansCJKsc-Regular.otf' in result.stderr, 'bundled font was not loaded'
    selected = [line for line in result.stderr.splitlines() if 'fontselect:' in line and '->' in line]
    assert selected and all('NotoSansCJKsc-Regular' in line.split('->')[1] for line in selected), selected
    assert 'glyph' not in result.stderr.lower(), 'unexpected glyph fallback or missing glyph'
    pixels = (work / 'chinese.gray').read_bytes()
    width, height = renderer.WIDTH, renderer.HEIGHT
    assert len(pixels) == width * height
    # Separate design-coordinate bands verify the subtitle and bottom-right watermark independently.
    subtitle = pixels[int(height * .65) * width:int(height * .80) * width]
    watermark = pixels[int(height * .88) * width:]
    assert sum(p > 180 for p in subtitle) > 100, 'subtitle glyphs absent'
    assert sum(p > 180 for p in watermark) > 100, 'watermark glyphs absent'
    subprocess.run([str(Path(args.ffmpeg).resolve()), '-v', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'gray',
                    '-video_size', f'{width}x{height}', '-i', 'chinese.gray', '-frames:v', '1', 'chinese.png'], cwd=work, check=True)
    print(f'CJK font smoke passed: {work / "chinese.png"}')


if __name__ == '__main__':
    main()
