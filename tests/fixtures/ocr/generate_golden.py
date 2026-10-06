#!/usr/bin/env python3
"""Renders the OCR golden pages from known text.

Ground truth is the text drawn onto the page, so the expected output never comes from the OCR
engine under test. The set holds two-column and borderless-table pages, plus single-column
English, Korean and Japanese pages degraded four ways (shaded, 72 dpi, 3 degree skew, noise).
Re-run to regenerate the images:

    python3 tests/fixtures/ocr/generate_golden.py

Requires Pillow and numpy plus the Liberation Serif, WenQuanYi Zen Hei (Korean) and IPAGothic
(Japanese) fonts. Output is deterministic (fixed seeds). The single-column pages are cropped to
their text block so the committed files stay small.
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

# Single-column degradation pages (one text block, cropped).
SC_PAGE_W = 2000
SC_MARGIN = 90
SC_LINE_SPACING = 1.35
CJK_LINE_SPACING = 1.5
DPI_72 = 72
SHADE_DARKEST = 0.35  # background level at the dark edge, relative to white
SHADE_CONTRAST = 0.85
SHADE_OFFSET = 20
KOREAN_FONT_PATH = '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc'
JAPANESE_FONT_PATH = '/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf'
# Automatic page segmentation reads Korean reliably from about 13 pt up, and only on pages with
# enough lines; the sizes and the longer Korean text were picked so the clean page is solvable.
KOREAN_FONT_PT = 14
JAPANESE_FONT_PT = 11

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


ENGLISH_PAGES = {
    'en_a': (
        "The committee reviewed the quarterly report on March 14, 2025, and approved a budget of "
        "$1,284,500 for the regional water project. Delays at the northern pumping station were "
        "attributed to supplier shortages; the contractor expects to finish the remaining 37 percent "
        "of the pipeline before the end of October. Members asked for an independent audit of "
        "invoices numbered 4471 through 4529."
    ),
    'en_b': (
        "Please return the signed lease agreement by Friday. The monthly rent of 2,150 euros is due "
        "on the first business day; a late fee of 4.5% applies after the fifth day. Tenants must "
        "notify the landlord in writing at least 60 days before moving out. Contact: Ms. Elena "
        "Vasquez, Building C, Room 312, telephone +34 91 555 0172."
    ),
    'en_c': (
        "Our new firmware release, version 3.8.2, fixes a race condition in the USB driver and "
        "reduces idle power consumption by roughly 12 milliwatts. Users who installed build 3.8.0 "
        "should update immediately, because a checksum error could corrupt configuration files "
        "stored in flash. The update takes about four minutes and must not be interrupted."
    ),
}
KOREAN_PAGES = {
    'ko_a': (
        "위원회는 2025년 3월 14일 분기 보고서를 검토하고 지역 상수도 사업에 대한 예산을 승인했다. "
        "북부 양수장의 공사 지연은 자재 공급 부족 때문이었으며 시공사는 10월 말까지 남은 관로 "
        "공사를 마칠 것으로 예상한다. 위원들은 송장 번호 4471번부터 4529번까지에 대한 "
        "독립적인 감사를 요청했다. 서명한 임대차 계약서는 금요일까지 제출해 주시기 바랍니다. "
        "월세는 첫째 영업일까지 납부해야 하며 다섯째 날이 지나면 연체료가 부과됩니다. "
        "세입자는 이사하기 최소 60일 전에 집주인에게 서면으로 알려야 한다."
    ),
}
JAPANESE_PAGES = {
    'ja_a': (
        "委員会は二〇二五年三月十四日に四半期報告書を審査し、地域の水道事業に対する予算を承認した。"
        "北部の揚水場で発生した遅れは資材の供給不足によるものであり、請負業者は十月末までに"
        "残りの配管工事を終える見込みである。委員は請求書の独立した監査を求めた。"
    ),
    'ja_b': (
        "光合成は光のエネルギーをブドウ糖に蓄えられた化学エネルギーに変える過程である。"
        "明反応では水が分解されて酸素が放出され、ATPとNADPHが作られる。"
        "カルビン回路は酵素ルビスコを使って二酸化炭素を固定する。"
        "二十二か所の測定地点で平均同化速度は毎秒毎平方メートル十八・六マイクロモルであり、"
        "七月に河口の三角州付近で最も高かった。"
    ),
}

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


def wrap_cjk(draw, text, f, max_width):
    """Breaks between any two characters; CJK text has no spaces to break on."""
    lines, current = [], ''
    for ch in text:
        if draw.textlength(current + ch, font=f) <= max_width:
            current += ch
        else:
            lines.append(current)
            current = ch
    lines.append(current)
    return lines


def render_single_column(text, f, wrap_fn, line_spacing):
    """Draws wrapped text on a page cropped to the text block plus a margin on every side."""
    measure = ImageDraw.Draw(Image.new('L', (1, 1)))
    lines = wrap_fn(measure, text, f, SC_PAGE_W - 2 * SC_MARGIN)
    line_height = int(f.size * line_spacing)
    img = Image.new('L', (SC_PAGE_W, 2 * SC_MARGIN + len(lines) * line_height), 255)
    draw = ImageDraw.Draw(img)
    for index, line in enumerate(lines):
        draw.text((SC_MARGIN, SC_MARGIN + index * line_height), line, font=f, fill=0)
    return img


def shade(img):
    """A brightness ramp across the page, as from uneven illumination of a scanned or photographed sheet."""
    a = np.array(img).astype('float32')
    w = a.shape[1]
    ramp = SHADE_DARKEST + (1 - SHADE_DARKEST) * (np.arange(w, dtype='float32') / w)
    a = a / 255 * (255 * ramp[None, :])
    a = a * SHADE_CONTRAST + SHADE_OFFSET
    return Image.fromarray(a.clip(0, 255).astype('uint8'))


def degradations(page):
    """The degraded variants of one rendered page, each with the dpi to record in the file."""
    scaled = (page.width * DPI_72 // RENDER_DPI, page.height * DPI_72 // RENDER_DPI)
    return {
        'clean300': (page, RENDER_DPI),
        'shade': (shade(page), RENDER_DPI),
        'dpi72': (page.resize(scaled, Image.LANCZOS), DPI_72),
        'skew3': (page.rotate(SKEW_DEGREES, resample=Image.BICUBIC, expand=True, fillcolor=255), RENDER_DPI),
        'noise': (add_noise(page), RENDER_DPI),
    }


def write_single_column_set(out, name, page, truth):
    with open(os.path.join(out, f'{name}.gt.txt'), 'w') as fh:
        fh.write(truth + '\n')
    for variant, (img, dpi) in degradations(page).items():
        img.save(os.path.join(out, f'{name}__{variant}.png'), dpi=(dpi, dpi), optimize=True)


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

    english = font(RENDER_DPI)
    for name, text in ENGLISH_PAGES.items():
        write_single_column_set(out, name, render_single_column(text, english, wrap, SC_LINE_SPACING), text)
    for pages, font_path, font_pt in (
        (KOREAN_PAGES, KOREAN_FONT_PATH, KOREAN_FONT_PT),
        (JAPANESE_PAGES, JAPANESE_FONT_PATH, JAPANESE_FONT_PT),
    ):
        cjk = ImageFont.truetype(font_path, int(round(font_pt * RENDER_DPI / 72)))
        for name, text in pages.items():
            write_single_column_set(out, name, render_single_column(text, cjk, wrap_cjk, CJK_LINE_SPACING), text)


if __name__ == '__main__':
    main()
