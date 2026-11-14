#!/usr/bin/env python3
"""Renders table_ruled.png, a table with ruling lines, from known text (the cells drawn are the ground truth in table_ruled.gt.txt).

    python3 tests/fixtures/ocr/generate_ruled_table.py

Requires Pillow and the DejaVu Sans font. Tesseract reads this page as a few confident words and loses the rest, which is what the
English second reading of the ONNX engine is tested on (docs/policy-decisions.md, entry 299).
"""
import os

from PIL import Image, ImageDraw, ImageFont

FONT_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
FONT_PX = 50  # 12 pt at 300 dpi
COLUMN_WIDTHS = [800, 300, 500, 500]
ROW_HEIGHT = 140
MARGIN = 200
ROWS = [
    ['Item', 'Qty', 'Unit price', 'Total'],
    ['Steel bracket 40 mm', '120', '$2.35', '$282.00'],
    ['Hex bolt M8 x 30', '1,500', '$0.12', '$180.00'],
    ['Gasket, rubber (set)', '48', '$7.90', '$379.20'],
    ['Cable tie 200 mm', '2,000', '$0.03', '$60.00'],
    ['Shipping and handling', '1', '$45.50', '$45.50'],
    ['Total due (net 30)', '', '', '$946.70'],
]

font = ImageFont.truetype(FONT_PATH, FONT_PX)
image = Image.new('L', (sum(COLUMN_WIDTHS) + 2 * MARGIN, ROW_HEIGHT * len(ROWS) + 2 * MARGIN), 255)
draw = ImageDraw.Draw(image)
y = MARGIN
for row in ROWS:
    x = MARGIN
    for width, cell in zip(COLUMN_WIDTHS, row):
        draw.rectangle([x, y, x + width, y + ROW_HEIGHT], outline=0, width=4)
        draw.text((x + 24, y + (ROW_HEIGHT - FONT_PX) // 2 - 6), cell, font=font, fill=0)
        x += width
    y += ROW_HEIGHT
here = os.path.dirname(os.path.abspath(__file__))
image.save(os.path.join(here, 'table_ruled.png'), dpi=(300, 300))
with open(os.path.join(here, 'table_ruled.gt.txt'), 'w', encoding='utf8') as out:
    out.write('\n'.join(' '.join(row) for row in ROWS))
