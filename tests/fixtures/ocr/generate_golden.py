#!/usr/bin/env python3
"""Renders the two-column OCR golden pages from known text.

Ground truth is the text drawn onto the page, so the expected output never comes from the OCR
engine under test. Re-run to regenerate the images:

    python3 tests/fixtures/ocr/generate_golden.py

Requires Pillow and numpy plus the Liberation Serif font. Output is deterministic (fixed seeds).
"""
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONT_PATH = '/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf'
FONT_PT = 11
RENDER_DPI = 300
PAGE_W, PAGE_H = 2550, 2000  # letter width at 300 dpi, cropped to the text block
MARGIN = 300
GUTTER = 150
LINE_SPACING = 1.35
SKEW_DEGREES = 3
NOISE_SIGMA = 28
NOISE_BLUR_RADIUS = 1.2
SALT_PEPPER_RATE = 0.004
DPI_150 = 150
TABLE_FONT_PATH = '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'
TABLE_FONT_PT = 12
TABLE_PAGE_W, TABLE_PAGE_H = 2550, 1200
TABLE_COLUMN_WIDTHS = [700, 300, 500, 500]
TABLE_ROW_HEIGHT = 130

LEFT_COLUMN = [
    "The committee reviewed the quarterly report on March 14, 2025, and approved a budget of "
    "$1,284,500 for the regional water project. Delays at the northern pumping station were "
    "attributed to supplier shortages; the contractor expects to finish the remaining 37 percent "
    "of the pipeline before the end of October.",
    "Members asked for an independent audit of invoices numbered 4471 through 4529. The chair "
    "noted that two bids exceeded the engineering estimate by more than 9 percent and requested "
    "a written explanation from each vendor within ten working days.",
]
RIGHT_COLUMN = [
    "Photosynthesis converts light energy into chemical energy stored in glucose. In the "
    "light-dependent reactions, water is split and oxygen is released, while ATP and NADPH are "
    "produced. The Calvin cycle then fixes carbon dioxide using the enzyme RuBisCO.",
    "Field measurements at 22 sites showed a mean assimilation rate of 18.6 micromoles per "
    "square metre per second, with the highest readings recorded near the river delta in July.",
]


TABLE_ROWS = [
    ["Item", "Qty", "Unit price", "Total"],
    ["Copper pipe", "120", "4.50", "540.00"],
    ["Valve DN50", "16", "38.20", "611.20"],
    ["Pump seal kit", "8", "72.00", "576.00"],
    ["Gasket set", "40", "6.75", "270.00"],
    ["Sensor probe", "12", "91.30", "1095.60"],
]


def font(dpi):
    return ImageFont.truetype(FONT_PATH, int(round(FONT_PT * dpi / 72)))


def wrap(draw, text, f, max_width):
    lines, current = [], ''
    for word in text.split():
        candidate = (current + ' ' + word).strip()
        if draw.textlength(candidate, font=f) <= max_width:
            current = candidate
        else:
            lines.append(current)
            current = word
    lines.append(current)
    return lines


def render_two_columns():
    img = Image.new('L', (PAGE_W, PAGE_H), 255)
    draw = ImageDraw.Draw(img)
    f = font(RENDER_DPI)
    line_height = int(f.size * LINE_SPACING)
    column_width = (PAGE_W - 2 * MARGIN - GUTTER) // 2
    for index, paragraphs in enumerate((LEFT_COLUMN, RIGHT_COLUMN)):
        x = MARGIN + index * (column_width + GUTTER)
        y = MARGIN
        for paragraph in paragraphs:
            for line in wrap(draw, paragraph, f, column_width):
                draw.text((x, y), line, font=f, fill=0)
                y += line_height
            y += line_height
    return img


def render_borderless_table():
    """A table without ruling lines: columns are only separated by white space."""
    img = Image.new('L', (TABLE_PAGE_W, TABLE_PAGE_H), 255)
    draw = ImageDraw.Draw(img)
    f = ImageFont.truetype(TABLE_FONT_PATH, int(round(TABLE_FONT_PT * RENDER_DPI / 72)))
    for r, row in enumerate(TABLE_ROWS):
        x = MARGIN
        for c, cell in enumerate(row):
            draw.text((x, MARGIN + r * TABLE_ROW_HEIGHT), cell, font=f, fill=0)
            x += TABLE_COLUMN_WIDTHS[c]
    return img


def add_noise(img):
    a = np.array(img).astype('float32')
    a += np.random.default_rng(1).normal(0, NOISE_SIGMA, a.shape)
    m = np.random.default_rng(2).random(a.shape)
    a[m < SALT_PEPPER_RATE] = 0
    a[m > 1 - SALT_PEPPER_RATE] = 255
    noisy = Image.fromarray(a.clip(0, 255).astype('uint8'))
    return noisy.filter(ImageFilter.GaussianBlur(NOISE_BLUR_RADIUS))


def main():
    out = os.path.dirname(os.path.abspath(__file__))
    page = render_two_columns()
    truth = '\n\n'.join(LEFT_COLUMN + RIGHT_COLUMN)
    with open(os.path.join(out, 'twocol.gt.txt'), 'w') as fh:
        fh.write(truth + '\n')
    scaled = (PAGE_W * DPI_150 // RENDER_DPI, PAGE_H * DPI_150 // RENDER_DPI)
    variants = {
        'clean300': (page, RENDER_DPI),
        'skew3': (page.rotate(SKEW_DEGREES, resample=Image.BICUBIC, expand=True, fillcolor=255), RENDER_DPI),
        'noise': (add_noise(page), RENDER_DPI),
        'dpi150': (page.resize(scaled, Image.LANCZOS), DPI_150),
    }
    for name, (img, dpi) in variants.items():
        img.save(os.path.join(out, f'twocol__{name}.png'), dpi=(dpi, dpi), optimize=True)
    render_borderless_table().save(os.path.join(out, 'table_borderless.png'), dpi=(RENDER_DPI, RENDER_DPI), optimize=True)
    with open(os.path.join(out, 'table_borderless.gt.txt'), 'w') as fh:
        fh.write('\n'.join(' '.join(row) for row in TABLE_ROWS) + '\n')


if __name__ == '__main__':
    main()
