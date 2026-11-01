"""Subset Noto Serif KR (OFL) to the Hangul the Korean messages use, as the display font's Hangul companion.

The display face (Instrument Serif) has no Hangul, so Korean headings take their Hangul glyphs from this subset. It holds
the Hangul syllables and the non-ASCII marks of messages/ko.json at weight 400, so a Korean page downloads tens of
kilobytes instead of the whole font. tests/web-font-licenses.test.ts fails when the messages use a syllable the subset
lacks; rerun this script then.

Usage (fontTools and brotli: `pip install fonttools brotli`):
  python3 scripts/subset-hangul-display-font.py <NotoSerifKR[wght].ttf>
The source is https://github.com/google/fonts/raw/main/ofl/notoserifkr/NotoSerifKR%5Bwght%5D.ttf
"""
import json
import pathlib
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = pathlib.Path(__file__).resolve().parent.parent
MESSAGES = ROOT / 'messages' / 'ko.json'
OUTPUT = ROOT / 'src' / 'app' / 'fonts' / 'NotoSerifKR-hangul-display.woff2'
COVERAGE = ROOT / 'src' / 'app' / 'fonts' / 'NotoSerifKR-hangul-display.txt'
WEIGHT = 400


def message_strings(node):
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for value in node.values():
            yield from message_strings(value)


def subset_text() -> str:
    chars = {ch for text in message_strings(json.loads(MESSAGES.read_text(encoding='utf-8'))) for ch in text}
    return ''.join(sorted(ch for ch in chars if ord(ch) > 0x7F))


def main(source: str) -> None:
    text = subset_text()
    font = instancer.instantiateVariableFont(TTFont(source), {'wght': WEIGHT})
    options = subset.Options()
    options.flavor = 'woff2'
    options.layout_features = ['*']
    subsetter = subset.Subsetter(options)
    subsetter.populate(text=text)
    subsetter.subset(font)
    font.flavor = 'woff2'
    font.save(OUTPUT)
    COVERAGE.write_text(text + '\n', encoding='utf-8')
    print(f'{OUTPUT.relative_to(ROOT)}: {OUTPUT.stat().st_size} bytes, {len(text)} characters')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
