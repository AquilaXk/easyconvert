import json, sys, pdfplumber
from pdfplumber import table as T
IN = sys.argv[1].rstrip('/') + '/'
KEYS = ['x0','x1','top','bottom','width','height','doctop','y0','y1','orientation','object_type']
def slim(o): return {k:o[k] for k in KEYS if k in o}
cases = [
 ('govdocs1-001135', 2, {}, 'lines'),
 ('govdocs1-000012', 1, {}, 'lines'),
 ('govdocs1-000145', 4, {}, 'lines'),
 ('govdocs1-000145', 4, {'vertical_strategy':'text','horizontal_strategy':'lines'}, 'mixed'),
 ('govdocs1-000580', 1, {'vertical_strategy':'text','horizontal_strategy':'text'}, 'text'),
 ('govdocs1-000341', 4, {'snap_tolerance':5,'intersection_tolerance':4}, 'tolerance'),
]
out = []
for name, pno, settings, tag in cases:
    with pdfplumber.open(f'{IN}{name}.pdf') as pdf:
        page = pdf.pages[pno-1]
        needs_words = 'text' in (settings.get('vertical_strategy'), settings.get('horizontal_strategy'))
        tf = T.TableFinder(page, settings)
        words = [slim(w) | {'text': w['text']} for w in page.extract_words(**(tf.settings.text_settings))] if needs_words else None
        out.append(dict(name=f'{name} p{pno} {tag}', pdf=name, page=pno, settings=settings,
            bbox=list(page.bbox), edges=[slim(e) for e in page.edges], words=words,
            expected=dict(edges=[slim(e) for e in tf.edges], intersections=len(tf.intersections), cells=[list(c) for c in tf.cells],
                          tables=[[list(c) for c in t.cells] for t in tf.tables],
                          rows=[[[list(c) if c else None for c in r.cells] for r in t.rows] for t in tf.tables[:2]],
                          columns=[[[list(c) if c else None for c in r.cells] for r in t.columns] for t in tf.tables[:1]])))
        print(name, pno, tag, len(page.edges), len(tf.edges), len(tf.cells), len(tf.tables), file=sys.stderr)
json.dump(out, open(sys.argv[2],'w'), separators=(',',':'))
