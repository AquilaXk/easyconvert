"""Colour and vector-shape agreement of a converted document with the PDF it was made from.

    python3 bench/pdf-colour-metrics.py <placed|unplaced> <source.pdf> <drawn.pdf>

`drawn.pdf` is the converted document (DOCX, PPTX, PPT) printed to PDF by the office suite. Both PDFs are read with the same
reader (PyMuPDF, the independent PDF oracle of the other benchmark families) and reduced to the same primitives:

  * words: the lower-cased letters and digits of each word of the text layer, with the fill colour of the span it sits in;
  * shapes: filled boxes, other filled shapes, stroked lines (rules, table borders, polyline segments) and stroked curves,
    each with its colour and its box on the page (page space, points, origin top left).

`placed` compares page against page and requires a shape to lie where the source has it (a slide holds one page); `unplaced`
compares the whole documents and requires only the kind (and a line's direction) and the colour of a shape (a Word document reflows the pages).
The output is one JSON object: the counts the caller sums over a corpus (true positives, source and drawn totals), so
precision, recall and F1 are those of the whole corpus and not a mean of per-file ratios.
"""

import json
import re
import sys

import pymupdf as fitz
import numpy as np

COLOUR_TOLERANCE = 24  # per channel, 0..255
WHITE = 0xF0  # a fill at least this light on every channel is paper
MIN_LINE_LENGTH = 4.0
THIN = 3.0  # a filled box thinner than this (points) and this many times longer than it is thick is a rule
RULE_ASPECT = 6.0
MIN_BOX_AREA = 4.0
PAGE_FILL_SHARE = 0.9
POSITION_TOLERANCE = 2.0
MATCH_OVERLAP = 0.6
SSIM_DPI = 60
NON_WORD = re.compile(r"[^0-9a-zÀ-￿]+")


def rgb255(colour):
    return tuple(int(round(v * 255)) for v in colour[:3])


def close(a, b):
    return all(abs(x - y) <= COLOUR_TOLERANCE for x, y in zip(a, b))


def is_dark(colour):
    return all(v <= COLOUR_TOLERANCE for v in colour)


def span_rgb(value):
    return ((value >> 16) & 255, (value >> 8) & 255, value & 255)


def words_of(doc):
    """(word, rgb) pairs of the text layer, one list for the document."""
    words = []
    for page in doc:
        for block in page.get_text("dict")["blocks"]:
            for line in block.get("lines", []):
                for span in line["spans"]:
                    colour = span_rgb(span["color"])
                    for token in span["text"].split():
                        word = NON_WORD.sub("", token.lower())
                        if word:
                            words.append((word, colour))
    return words


def match_words(source, drawn):
    """Greedy matches of (word, colour): the same word and a colour within tolerance. Returns (matched, matched coloured source)."""
    pool = {}
    for word, colour in drawn:
        pool.setdefault(word, []).append(colour)
    matched = 0
    coloured_matched = 0
    word_matched = 0
    for word, colour in source:
        candidates = pool.get(word)
        if not candidates:
            continue
        word_matched += 1
        for index, other in enumerate(candidates):
            if close(colour, other):
                candidates.pop(index)
                matched += 1
                if not is_dark(colour):
                    coloured_matched += 1
                break
    return matched, coloured_matched, word_matched


def box_of(rect):
    return (rect.x0, rect.y0, rect.x1, rect.y1)


def iou(a, b):
    x0, y0, x1, y1 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    if x1 <= x0 or y1 <= y0:
        return 0.0
    inter = (x1 - x0) * (y1 - y0)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def shapes_of(page):
    """Primitives of a page: dicts with kind, box and colour. Lines carry their end points."""
    width, height = page.rect.width, page.rect.height
    shapes = []
    for drawing in page.get_drawings():
        rect = drawing["rect"]
        fill = drawing.get("fill")
        stroke = drawing.get("color")
        items = drawing["items"]
        is_rect = len(items) == 1 and items[0][0] in ("re", "qu")
        if fill is not None:
            colour = rgb255(fill)
            area = rect.width * rect.height
            paper = all(v >= WHITE for v in colour)
            page_sized = area >= PAGE_FILL_SHARE * width * height
            if not paper and not page_sized:
                if is_rect or (all(i[0] == "l" for i in items) and fills_its_box(items, rect)):
                    if min(rect.width, rect.height) <= THIN and max(rect.width, rect.height) >= max(MIN_LINE_LENGTH, RULE_ASPECT * min(rect.width, rect.height)):
                        shapes.append(line_of(rect, colour))
                    elif area >= MIN_BOX_AREA:
                        shapes.append({"kind": "box", "box": box_of(rect), "colour": colour})
                elif area >= MIN_BOX_AREA:
                    shapes.append({"kind": "poly", "box": box_of(rect), "colour": colour})
        if stroke is not None:
            colour = rgb255(stroke)
            curve_box = None
            for item in items:
                if item[0] == "l":
                    add_line(shapes, item[1], item[2], colour)
                elif item[0] == "re":
                    r = item[1]
                    add_line(shapes, fitz.Point(r.x0, r.y0), fitz.Point(r.x1, r.y0), colour)
                    add_line(shapes, fitz.Point(r.x1, r.y0), fitz.Point(r.x1, r.y1), colour)
                    add_line(shapes, fitz.Point(r.x1, r.y1), fitz.Point(r.x0, r.y1), colour)
                    add_line(shapes, fitz.Point(r.x0, r.y1), fitz.Point(r.x0, r.y0), colour)
                elif item[0] == "qu":
                    q = item[1]
                    pts = [q.ul, q.ur, q.lr, q.ll]
                    for i in range(4):
                        add_line(shapes, pts[i], pts[(i + 1) % 4], colour)
                elif item[0] == "c":
                    curve_box = rect if curve_box is None else curve_box
            if curve_box is not None and fill is None:
                shapes.append({"kind": "curve", "box": box_of(rect), "colour": colour})
    return merge_boxes(merge_lines(shapes))


def fills_its_box(items, rect):
    """A closed outline of straight lines whose area is its box: a rectangle, however many points it starts or turns at."""
    points = [item[1] for item in items]
    area = 0.0
    for a, b in zip(points, points[1:] + points[:1]):
        area += a.x * b.y - b.x * a.y
    return rect.width > 0 and rect.height > 0 and abs(area) / 2 >= 0.98 * rect.width * rect.height


def line_of(rect, colour):
    if rect.width >= rect.height:
        y = (rect.y0 + rect.y1) / 2
        return {"kind": "line", "box": (rect.x0, y, rect.x1, y), "colour": colour}
    x = (rect.x0 + rect.x1) / 2
    return {"kind": "line", "box": (x, rect.y0, x, rect.y1), "colour": colour}


def add_line(shapes, p1, p2, colour):
    if ((p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2) ** 0.5 < MIN_LINE_LENGTH:
        return
    box = (min(p1.x, p2.x), min(p1.y, p2.y), max(p1.x, p2.x), max(p1.y, p2.y))
    if abs(p1.y - p2.y) <= 0.5:
        y = (p1.y + p2.y) / 2
        box = (box[0], y, box[2], y)
    elif abs(p1.x - p2.x) <= 0.5:
        x = (p1.x + p2.x) / 2
        box = (x, box[1], x, box[3])
    shapes.append({"kind": "line", "box": box, "colour": colour})


def merge_lines(shapes):
    """Axis lines of one colour that lie on the same row or column and touch or overlap become one."""
    rest = [s for s in shapes if not (s["kind"] == "line" and (s["box"][1] == s["box"][3] or s["box"][0] == s["box"][2]))]
    axis = [s for s in shapes if s["kind"] == "line" and (s["box"][1] == s["box"][3] or s["box"][0] == s["box"][2])]
    merged = []
    for s in sorted(axis, key=lambda s: (s["box"][1] != s["box"][3], round(s["box"][1] if s["box"][1] == s["box"][3] else s["box"][0]), s["box"][0], s["box"][1])):
        horizontal = s["box"][1] == s["box"][3]
        for m in merged:
            if m["horizontal"] != horizontal or not close(m["colour"], s["colour"]):
                continue
            a, b = m["box"], s["box"]
            if horizontal:
                same = abs(a[1] - b[1]) <= POSITION_TOLERANCE / 2
                touch = b[0] <= a[2] + 1.0
                if same and touch:
                    m["box"] = (min(a[0], b[0]), a[1], max(a[2], b[2]), a[3])
                    break
            else:
                same = abs(a[0] - b[0]) <= POSITION_TOLERANCE / 2
                touch = b[1] <= a[3] + 1.0
                if same and touch:
                    m["box"] = (a[0], min(a[1], b[1]), a[2], max(a[3], b[3]))
                    break
        else:
            merged.append({**s, "horizontal": horizontal})
    return rest + [{k: v for k, v in m.items() if k != "horizontal"} for m in merged]


def merge_boxes(shapes):
    """Filled boxes of one colour and height that touch are one (a highlight is cut at every font change)."""
    boxes = [s for s in shapes if s["kind"] == "box"]
    rest = [s for s in shapes if s["kind"] != "box"]
    merged = []
    for s in sorted(boxes, key=lambda s: (round(s["box"][1]), round(s["box"][3]), s["box"][0])):
        for m in merged:
            a, b = m["box"], s["box"]
            if close(m["colour"], s["colour"]) and abs(a[1] - b[1]) <= 0.3 and abs(a[3] - b[3]) <= 0.3 and b[0] <= a[2] + 0.3:
                m["box"] = (min(a[0], b[0]), a[1], max(a[2], b[2]), a[3])
                break
        else:
            merged.append(dict(s))
    return rest + merged


def orientation_of(box):
    if box[1] == box[3]:
        return "h"
    return "v" if box[0] == box[2] else "d"


def shapes_match(a, b, placed):
    if a["kind"] != b["kind"] or not close(a["colour"], b["colour"]):
        return False
    if a["kind"] == "line":
        ax, bx = a["box"], b["box"]
        if placed:
            near = lambda p, q: abs(p[0] - q[0]) <= 3 * POSITION_TOLERANCE and abs(p[1] - q[1]) <= 3 * POSITION_TOLERANCE
            forward = near(ax[:2], bx[:2]) and near(ax[2:], bx[2:])
            backward = near(ax[:2], bx[2:]) and near(ax[2:], bx[:2])
            if forward or backward:
                return True
            horizontal = ax[1] == ax[3] and bx[1] == bx[3]
            vertical = ax[0] == ax[2] and bx[0] == bx[2]
            if horizontal and abs(ax[1] - bx[1]) <= POSITION_TOLERANCE:
                overlap = min(ax[2], bx[2]) - max(ax[0], bx[0])
                return overlap >= MATCH_OVERLAP * max(ax[2] - ax[0], bx[2] - bx[0])
            if vertical and abs(ax[0] - bx[0]) <= POSITION_TOLERANCE:
                overlap = min(ax[3], bx[3]) - max(ax[1], bx[1])
                return overlap >= MATCH_OVERLAP * max(ax[3] - ax[1], bx[3] - bx[1])
            return False
        return orientation_of(ax) == orientation_of(bx)
    if placed:
        return iou(a["box"], b["box"]) >= MATCH_OVERLAP
    return True


def match_shapes(source, drawn, placed):
    """Greedy one-to-one matching; returns the number of matched pairs."""
    free = list(range(len(drawn)))
    matched = 0
    for shape in source:
        for slot, index in enumerate(free):
            if shapes_match(shape, drawn[index], placed):
                free.pop(slot)
                matched += 1
                break
    return matched


def render_gray_rgb(page, dpi, size=None):
    pix = page.get_pixmap(dpi=dpi, colorspace=fitz.csRGB, alpha=False)
    array = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3).astype(np.float64)
    return array


def box_mean(channel, win=7):
    """Mean over every win x win window (valid positions) by an integral image."""
    padded = np.pad(channel, ((1, 0), (1, 0)))
    integral = padded.cumsum(0).cumsum(1)
    total = integral[win:, win:] - integral[:-win, win:] - integral[win:, :-win] + integral[:-win, :-win]
    return total / (win * win)


def ssim_channel(a, b, win=7):
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    if a.shape[0] < win or a.shape[1] < win:
        return 1.0
    mu_a, mu_b = box_mean(a, win), box_mean(b, win)
    var_a = box_mean(a * a, win) - mu_a * mu_a
    var_b = box_mean(b * b, win) - mu_b * mu_b
    cov = box_mean(a * b, win) - mu_a * mu_b
    n = win * win
    scale = n / (n - 1)
    var_a, var_b, cov = var_a * scale, var_b * scale, cov * scale
    value = ((2 * mu_a * mu_b + c1) * (2 * cov + c2)) / ((mu_a**2 + mu_b**2 + c1) * (var_a + var_b + c2))
    return float(value.mean())


def page_ssim(source_page, drawn_page):
    """Grey SSIM and mean-of-channels SSIM of the drawn page against the source page at SSIM_DPI (the drawn page is scaled to the source's size)."""
    a = render_gray_rgb(source_page, SSIM_DPI)
    height, width = a.shape[:2]
    zoom_x = width / drawn_page.rect.width / (SSIM_DPI / 72)
    zoom_y = height / drawn_page.rect.height / (SSIM_DPI / 72)
    pix = drawn_page.get_pixmap(matrix=fitz.Matrix(SSIM_DPI / 72 * zoom_x, SSIM_DPI / 72 * zoom_y), colorspace=fitz.csRGB, alpha=False)
    b = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3).astype(np.float64)
    h, w = min(a.shape[0], b.shape[0]), min(a.shape[1], b.shape[1])
    a, b = a[:h, :w], b[:h, :w]
    grey = np.array([0.299, 0.587, 0.114])
    return ssim_channel(a @ grey, b @ grey), float(np.mean([ssim_channel(a[..., c], b[..., c]) for c in range(3)])), float(np.abs(a - b).mean() / 255)


def main():
    mode, source_path, drawn_path = sys.argv[1], sys.argv[2], sys.argv[3]
    placed = mode == "placed"
    source, drawn = fitz.open(source_path), fitz.open(drawn_path)
    source_words, drawn_words = words_of(source), words_of(drawn)
    matched, coloured_matched, word_matched = match_words(source_words, drawn_words)
    result = {
        "pages": [source.page_count, drawn.page_count],
        "words": {
            "source": len(source_words),
            "drawn": len(drawn_words),
            "matched": matched,
            "wordMatched": word_matched,
            "colouredSource": sum(1 for _, c in source_words if not is_dark(c)),
            "colouredMatched": coloured_matched,
        },
    }
    source_shapes_total = drawn_shapes_total = matched_shapes = 0
    by_kind = {}
    ssim_grey, ssim_rgb, mae = [], [], []
    pairs = [(source[i], drawn[i]) for i in range(min(source.page_count, drawn.page_count))] if placed else None
    if placed:
        for source_page, drawn_page in pairs:
            s_shapes, d_shapes = shapes_of(source_page), shapes_of(drawn_page)
            source_shapes_total += len(s_shapes)
            drawn_shapes_total += len(d_shapes)
            matched_shapes += match_shapes(s_shapes, d_shapes, True)
            for kind in {s["kind"] for s in s_shapes}:
                entry = by_kind.setdefault(kind, [0, 0])
                of_kind = [s for s in s_shapes if s["kind"] == kind]
                entry[0] += len(of_kind)
                entry[1] += match_shapes(of_kind, [d for d in d_shapes if d["kind"] == kind], True)
            g, c, m = page_ssim(source_page, drawn_page)
            ssim_grey.append(g)
            ssim_rgb.append(c)
            mae.append(m)
        # A source page the drawn document has no page for counts as a total miss.
        for index in range(drawn.page_count, source.page_count):
            s_shapes = shapes_of(source[index])
            source_shapes_total += len(s_shapes)
            ssim_grey.append(0.0)
            ssim_rgb.append(0.0)
            mae.append(1.0)
    else:
        s_shapes = [s for page in source for s in shapes_of(page)]
        d_shapes = [s for page in drawn for s in shapes_of(page)]
        source_shapes_total, drawn_shapes_total = len(s_shapes), len(d_shapes)
        matched_shapes = match_shapes(s_shapes, d_shapes, False)
        for kind in {s["kind"] for s in s_shapes}:
            of_kind = [s for s in s_shapes if s["kind"] == kind]
            by_kind[kind] = [len(of_kind), match_shapes(of_kind, [d for d in d_shapes if d["kind"] == kind], False)]
    result["shapes"] = {"source": source_shapes_total, "drawn": drawn_shapes_total, "matched": matched_shapes, "byKind": by_kind}
    if ssim_grey:
        result["ssim"] = {"grey": float(np.mean(ssim_grey)), "rgb": float(np.mean(ssim_rgb)), "mae": float(np.mean(mae))}
    print(json.dumps(result))


main()
