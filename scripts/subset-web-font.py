"""Subset Pretendard Variable (SIL OFL 1.1) into the two web fonts of the interface: Latin and Hangul.

The page draws Latin and Hangul in one family: Pretendard's Latin is Inter-derived, and its Hangul is the Source Han Sans
set. Both files are cut from the same source with the same weight axis (400 to 700) and the same family name, so they
draw as one face. The Hangul file holds the syllables and jamo of messages/ko.json, messages/en.json and the legal texts the
pages render (docs/legal/*.en.md and *.ko.md) that lie in the unicode-range the layout declares for it. The Latin file holds ASCII, Latin-1, the general punctuation and arrow blocks,
every other non-ASCII character of the messages, and the syllables of the language name that every page shows
(src/components/LanguageSwitcher.tsx). The font chain asks the Hangul family only for a character the Latin family lacks,
so an English page loads the Latin file alone and a Korean page loads both. A file name or other text the messages do not
hold falls back to the system sans stack. tests/web-font-licenses.test.ts fails when the messages use a character the
files lack; rerun this script then.

OFL 1.1 clause 3 bars a modified version from the Reserved Font Name "Pretendard", and a subset is a modified version, so
each file carries its own family name (EasyConvert Sans) and keeps the original copyright line.

Usage (the tool versions below are required; the output bytes depend on them):
  python3 -m venv venv && venv/bin/pip install fonttools==4.68.0 brotli==1.2.1
  venv/bin/python scripts/subset-web-font.py <PretendardVariable.ttf>
The source is dist/public/variable/PretendardVariable.ttf of the npm package pretendard@1.3.9
(https://registry.npmjs.org/pretendard/-/pretendard-1.3.9.tgz, sha256 0ffc240cee83be02520fb4ac1b2a0a51052b9d13506ade0ba90c591dbbb3bd53).
The script writes both files and src/app/fonts/EasyConvertSans.sha256, the sha256 of each output.
"""
import hashlib
import json
import pathlib
import sys
from importlib import metadata

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

PINNED_TOOLS = {'fonttools': '4.68.0', 'brotli': '1.2.1'}
ROOT = pathlib.Path(__file__).resolve().parent.parent
MESSAGES = [ROOT / 'messages' / 'ko.json', ROOT / 'messages' / 'en.json']
LEGAL_TEXTS = sorted(path for locale in ('en', 'ko') for path in (ROOT / 'docs' / 'legal').glob(f'*.{locale}.md'))
FONT_DIR = ROOT / 'src' / 'app' / 'fonts'
OUTPUTS = {'latin': FONT_DIR / 'EasyConvertSans-latin.woff2', 'hangul': FONT_DIR / 'EasyConvertSans-hangul.woff2'}
CHECKSUMS = FONT_DIR / 'EasyConvertSans.sha256'
WEIGHTS = (400, 700)
FAMILY = 'EasyConvert Sans'
FIXED_RANGES = [(0x20, 0x7E), (0xA0, 0xFF), (0x2000, 0x206F), (0x2190, 0x21FF)]
# The unicode-range of the Hangul @font-face in src/app/[locale]/layout.tsx: Hangul Jamo, Compatibility Jamo, Syllables.
HANGUL_RANGES = [(0x1100, 0x11FF), (0x3130, 0x318F), (0xAC00, 0xD7A3)]
# The Korean name in the language switcher, drawn on every page in either language: the Latin file draws it, so an English
# page never needs the Hangul file for it.
LANGUAGE_NAME_SYLLABLES = '한국어'


def check_tools() -> None:
    for name, wanted in PINNED_TOOLS.items():
        found = metadata.version(name)
        if found != wanted:
            sys.exit(f'{name} {found} is installed, {wanted} is required (see the usage above)')


def message_strings(node):
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for value in node.values():
            yield from message_strings(value)


def is_hangul(char: str) -> bool:
    return any(low <= ord(char) <= high for low, high in HANGUL_RANGES)


def subset_texts() -> dict:
    chars = {ch for path in MESSAGES for text in message_strings(json.loads(path.read_text(encoding='utf-8'))) for ch in text}
    chars.update(ch for path in LEGAL_TEXTS for ch in path.read_text(encoding='utf-8') if ch not in '\n\t')
    chars.update(chr(code) for low, high in FIXED_RANGES for code in range(low, high + 1))
    return {
        'latin': ''.join(sorted({ch for ch in chars if not is_hangul(ch)} | set(LANGUAGE_NAME_SYLLABLES))),
        'hangul': ''.join(sorted(ch for ch in chars if is_hangul(ch))),
    }


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


def build(source: str, text: str, output: pathlib.Path) -> None:
    font = TTFont(source, recalcTimestamp=False)
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
    font.save(output)


def main(source: str) -> None:
    check_tools()
    texts = subset_texts()
    lines = []
    for script, output in OUTPUTS.items():
        build(source, texts[script], output)
        digest = hashlib.sha256(output.read_bytes()).hexdigest()
        lines.append(f'{digest}  {output.name}')
        print(f'{output.relative_to(ROOT)}: {output.stat().st_size} bytes, {len(texts[script])} characters, sha256 {digest}')
    CHECKSUMS.write_text('\n'.join(lines) + '\n', encoding='utf-8')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
