"""Subset Pretendard Variable (SIL OFL 1.1) into the one web font of the interface.

The page draws Latin and Hangul in one family: Pretendard's Latin is Inter-derived, and its Hangul is the Source Han Sans
set. The subset keeps the weight axis from 400 to 700, ASCII, Latin-1, the general punctuation and arrow blocks, and every
non-ASCII character of messages/ko.json and messages/en.json, so a Korean page downloads tens of kilobytes instead of
the 6.7 MB family. A file name or other text the messages do not hold falls back to the system sans stack.
tests/web-font-licenses.test.ts fails when the messages use a character the subset lacks; rerun this script then.

OFL 1.1 clause 3 bars a modified version from the Reserved Font Name "Pretendard", and a subset is a modified version, so
the file carries its own family name (EasyConvert Sans) and keeps the original copyright line.

Usage (fontTools and brotli: `pip install fonttools brotli`):
  python3 scripts/subset-web-font.py <PretendardVariable.ttf>
The source is dist/public/variable/PretendardVariable.ttf of the npm package pretendard@1.3.9
(https://registry.npmjs.org/pretendard/-/pretendard-1.3.9.tgz, sha256 0ffc240cee83be02520fb4ac1b2a0a51052b9d13506ade0ba90c591dbbb3bd53).
"""
import json
import pathlib
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = pathlib.Path(__file__).resolve().parent.parent
MESSAGES = [ROOT / 'messages' / 'ko.json', ROOT / 'messages' / 'en.json']
OUTPUT = ROOT / 'src' / 'app' / 'fonts' / 'EasyConvertSans-subset.woff2'
COVERAGE = ROOT / 'src' / 'app' / 'fonts' / 'EasyConvertSans-subset.txt'
WEIGHTS = (400, 700)
FAMILY = 'EasyConvert Sans'
FIXED_RANGES = [(0x20, 0x7E), (0xA0, 0xFF), (0x2000, 0x206F), (0x2190, 0x21FF)]


def message_strings(node):
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for value in node.values():
            yield from message_strings(value)


def subset_text() -> str:
    chars = {ch for path in MESSAGES for text in message_strings(json.loads(path.read_text(encoding='utf-8'))) for ch in text}
    chars.update(chr(code) for low, high in FIXED_RANGES for code in range(low, high + 1))
    return ''.join(sorted(chars))


def rename(font: TTFont) -> None:
    names = font['name']
    names.names = [n for n in names.names if n.nameID not in (16, 17, 21, 22, 25)]
    for record in names.names:
        if record.nameID in (264, 266, 268):
            record.string = record.toUnicode().replace('PretendardVariable', FAMILY.replace(' ', ''))
        elif record.nameID in (1, 4):
            record.string = FAMILY
        elif record.nameID == 6:
            record.string = FAMILY.replace(' ', '') + '-Regular'
        elif record.nameID == 3:
            record.string = FAMILY.replace(' ', '') + ';subset of Pretendard Variable 1.3.9'


def main(source: str) -> None:
    text = subset_text()
    font = TTFont(source)
    options = subset.Options()
    options.flavor = 'woff2'
    options.layout_features = ['*']
    options.name_IDs = [0, 1, 2, 3, 4, 6, 13, 14]
    subsetter = subset.Subsetter(options)
    subsetter.populate(text=text)
    subsetter.subset(font)
    font = instancer.instantiateVariableFont(font, {'wght': WEIGHTS})
    rename(font)
    font.flavor = 'woff2'
    font.save(OUTPUT)
    drawn = font.getBestCmap()
    COVERAGE.write_text(''.join(ch for ch in text if ord(ch) > 0x7F and ord(ch) in drawn) + '\n', encoding='utf-8')
    print(f'{OUTPUT.relative_to(ROOT)}: {OUTPUT.stat().st_size} bytes, {len(text)} characters')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
