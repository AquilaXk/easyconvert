#!/usr/bin/env python3
"""Renders the bordered-table pages of tests/fixtures/ocr-tables from known text.

    python3 tests/fixtures/ocr-tables/generate_bordered_tables.py

Each page is a table with ruling lines whose cells are the ground truth in <name>.gt.txt (one row a line, cells joined by one space,
the order a person reads them in). The pages differ in typeface, size, resolution, rule width, shading, row count and in how the scan
is degraded (noise, blur, a bitonal copy, a small turn), because the engine that fails on a grid does not fail on all of them alike
(docs/policy-decisions.md, entries 302 and 317). Needs Pillow, numpy, DejaVu and Liberation fonts. The output is deterministic.
"""
import os
import random

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONTS = {
    'sans': '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    'serif': '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf',
    'liberation': '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
}

INVOICE = [
    ['Item', 'Qty', 'Unit price', 'Total'],
    ['Steel bracket 40 mm', '120', '$2.35', '$282.00'],
    ['Hex bolt M8 x 30', '1,500', '$0.12', '$180.00'],
    ['Gasket, rubber (set)', '48', '$7.90', '$379.20'],
    ['Cable tie 200 mm', '2,000', '$0.03', '$60.00'],
    ['Shipping and handling', '1', '$45.50', '$45.50'],
    ['Total due (net 30)', '', '', '$946.70'],
]
SCHEDULE = [
    ['Date', 'Meeting', 'Room', 'Chair', 'Status'],
    ['March 3', 'Budget review', 'B204', 'Hughes', 'Open'],
    ['March 10', 'Safety committee', 'A110', 'Okafor', 'Closed'],
    ['March 17', 'Vendor selection', 'C301', 'Lindqvist', 'Open'],
    ['March 24', 'Annual audit planning', 'B204', 'Moreau', 'Pending'],
    ['April 7', 'Staff training day', 'Hall 2', 'Tanaka', 'Open'],
    ['April 14', 'Facilities walkthrough', 'A110', 'Silva', 'Closed'],
    ['April 21', 'Quarterly results', 'C301', 'Hughes', 'Pending'],
]
SPECS = [
    ['Model', 'Voltage', 'Current', 'Power', 'Weight'],
    ['TX-100', '12 V', '2.5 A', '30 W', '0.8 kg'],
    ['TX-200', '24 V', '4.0 A', '96 W', '1.4 kg'],
    ['TX-350', '24 V', '6.5 A', '156 W', '2.1 kg'],
    ['TX-500', '48 V', '5.2 A', '250 W', '2.9 kg'],
]
CENSUS = [
    ['County', 'Population', 'Households', 'Median age', 'Area (sq mi)', 'Density'],
    ['Adams', '18,420', '6,915', '41.2', '353', '52.2'],
    ['Brooks', '9,877', '3,640', '44.8', '402', '24.6'],
    ['Carver', '52,310', '19,882', '36.5', '287', '182.3'],
    ['Dunmore', '27,045', '10,317', '39.9', '511', '52.9'],
    ['Easton', '6,512', '2,466', '47.3', '620', '10.5'],
    ['Fulton', '33,998', '12,704', '38.1', '299', '113.7'],
]
LEDGER = [
    ['Account', 'Debit', 'Credit'],
    ['Cash at bank', '14,250.00', ''],
    ['Accounts receivable', '8,310.45', ''],
    ['Inventory', '21,075.10', ''],
    ['Accounts payable', '', '9,842.30'],
    ['Long-term loan', '', '25,000.00'],
    ['Owner equity', '', '8,793.25'],
    ['Totals', '43,635.55', '43,635.55'],
]

# name, rows, font, pt, dpi, rule px, shade header, degradation, turn degrees, column padding
PAGES = [
    ('t01_invoice_plain', INVOICE, 'sans', 12, 300, 4, False, 'clean', 0.0, 24),
    ('t02_invoice_shaded', INVOICE, 'sans', 12, 300, 4, True, 'clean', 0.0, 24),
    ('t03_invoice_noisy', INVOICE, 'sans', 12, 300, 4, False, 'noise', 0.0, 24),
    ('t04_invoice_150dpi', INVOICE, 'sans', 12, 150, 2, False, 'clean', 0.0, 12),
    ('t05_invoice_turned', INVOICE, 'sans', 12, 300, 4, False, 'clean', 2.0, 24),
    ('t06_schedule_serif', SCHEDULE, 'serif', 11, 300, 3, False, 'clean', 0.0, 20),
    ('t07_schedule_scan', SCHEDULE, 'liberation', 10, 200, 3, False, 'scan', 0.0, 16),
    ('t08_schedule_bitonal', SCHEDULE, 'sans', 10, 200, 2, True, 'bitonal', 0.0, 16),
    ('t09_specs_large', SPECS, 'sans', 14, 300, 5, False, 'clean', 0.0, 30),
    ('t10_specs_thin_rules', SPECS, 'serif', 12, 300, 2, False, 'clean', 0.0, 22),
    ('t11_census_dense', CENSUS, 'liberation', 9, 300, 3, True, 'clean', 0.0, 14),
    ('t12_census_scan', CENSUS, 'sans', 10, 200, 2, False, 'scan', 0.0, 14),
    ('t13_ledger_plain', LEDGER, 'serif', 12, 300, 4, False, 'clean', 0.0, 26),
    ('t14_ledger_blur', LEDGER, 'liberation', 11, 150, 2, False, 'blur', 0.0, 12),
    ('t15_ledger_turned_noise', LEDGER, 'sans', 11, 300, 3, True, 'noise', -1.5, 22),
    ('t16_specs_bitonal_150', SPECS, 'liberation', 12, 150, 2, False, 'bitonal', 0.0, 12),
]


def render(rows, font_key, pt, dpi, rule, shade, degrade, turn, pad, seed):
    rng = random.Random(seed)
    px = round(pt * dpi / 72)
    font = ImageFont.truetype(FONTS[font_key], px)
    columns = len(rows[0])
    widths = [max(font.getlength(row[c]) for row in rows) + 2 * pad for c in range(columns)]
    row_h = round(px * 2.3)
    margin = round(dpi * 0.7)
    w = int(sum(widths)) + 2 * margin
    h = row_h * len(rows) + 2 * margin
    image = Image.new('L', (w, h), 255)
    draw = ImageDraw.Draw(image)
    y = margin
    for r, row in enumerate(rows):
        x = margin
        for width, cell in zip(widths, row):
            box = [x, y, x + width, y + row_h]
            if shade and r == 0:
                draw.rectangle(box, fill=208)
            draw.rectangle(box, outline=0, width=rule)
            draw.text((x + pad, y + (row_h - px) // 2 - px // 8), cell, font=font, fill=0)
            x += width
        y += row_h
    if turn:
        image = image.rotate(turn, resample=Image.BICUBIC, expand=True, fillcolor=255)
    if degrade in ('noise', 'scan'):
        arr = np.asarray(image, dtype=np.float32)
        noise = np.random.default_rng(seed).normal(0, 14 if degrade == 'noise' else 7, arr.shape)
        image = Image.fromarray(np.clip(arr + noise, 0, 255).astype(np.uint8))
    if degrade in ('scan', 'blur'):
        image = image.filter(ImageFilter.GaussianBlur(0.9 if degrade == 'blur' else 0.6))
    if degrade == 'bitonal':
        image = image.point(lambda v: 255 if v > 150 else 0).convert('1')
    return image


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    for seed, (name, rows, font_key, pt, dpi, rule, shade, degrade, turn, pad) in enumerate(PAGES):
        image = render(rows, font_key, pt, dpi, rule, shade, degrade, turn, pad, seed)
        if degrade in ('noise', 'scan'):
            # A noisy scan is stored the way a scanner stores it, as a JPEG; as a PNG it would take 1 MB.
            image.save(os.path.join(here, name + '.jpg'), dpi=(dpi, dpi), quality=82, subsampling=0)
        else:
            image.save(os.path.join(here, name + '.png'), dpi=(dpi, dpi), optimize=True)
        with open(os.path.join(here, name + '.gt.txt'), 'w', encoding='utf8') as out:
            out.write('\n'.join(' '.join(cell for cell in row if cell) for row in rows))


if __name__ == '__main__':
    main()
