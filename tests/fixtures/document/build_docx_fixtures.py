#!/usr/bin/env python3
"""Authors the WordprocessingML golden documents in this directory.

The packages are written with `zipfile` from XML strings that follow ECMA-376 Part 1 (17.3 paragraphs, 17.4 tables,
17.7 styles, 17.9 numbering, 17.11 footnotes and endnotes, 20.4 DrawingML pictures). Nothing here imports or reuses
the converter, so the documents are an input the reader has not shaped. `PROVENANCE.md` lists what each file holds;
`expected/*.json` are written by hand from the content below, not generated from the reader's output.

Run:  python3 build_docx_fixtures.py          (needs Pillow for the two pictures)
"""
import io
import os
import zipfile

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
NS = (
    f'xmlns:w="{W}" xmlns:r="{R}" '
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'
)
REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
FIXED_TIME = (2024, 1, 2, 3, 4, 5)


def esc(text):
    return text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def run(text, bold=False, italic=False, underline=False, style=None, size=None):
    props = ''
    if style:
        props += f'<w:rStyle w:val="{style}"/>'
    if bold:
        props += '<w:b/>'
    if italic:
        props += '<w:i/>'
    if underline:
        props += '<w:u w:val="single"/>'
    if size:
        props += f'<w:sz w:val="{size}"/>'
    rpr = f'<w:rPr>{props}</w:rPr>' if props else ''
    return f'<w:r>{rpr}<w:t xml:space="preserve">{esc(text)}</w:t></w:r>'


def para(content, style=None, num=None, extra=''):
    ppr = ''
    if style:
        ppr += f'<w:pStyle w:val="{style}"/>'
    if num:
        ppr += f'<w:numPr><w:ilvl w:val="{num[1]}"/><w:numId w:val="{num[0]}"/></w:numPr>'
    ppr += extra
    ppr = f'<w:pPr>{ppr}</w:pPr>' if ppr else ''
    if isinstance(content, str) and not content.startswith('<'):
        content = run(content)
    return f'<w:p>{ppr}{content}</w:p>'


def cell(text, span=1, vmerge=None, fill=None):
    props = ''
    if span > 1:
        props += f'<w:gridSpan w:val="{span}"/>'
    if vmerge == 'restart':
        props += '<w:vMerge w:val="restart"/>'
    elif vmerge == 'continue':
        props += '<w:vMerge/>'
    if fill:
        props += f'<w:shd w:val="clear" w:color="auto" w:fill="{fill}"/>'
    tcpr = f'<w:tcPr><w:tcW w:w="2400" w:type="dxa"/>{props}</w:tcPr>'
    body = para(text) if text != '' else '<w:p/>'
    return f'<w:tc>{tcpr}{body}</w:tc>'


def row(cells, header=False):
    trpr = '<w:trPr><w:tblHeader/></w:trPr>' if header else ''
    return f'<w:tr>{trpr}{"".join(cells)}</w:tr>'


def table(rows, columns):
    grid = ''.join('<w:gridCol w:w="2400"/>' for _ in range(columns))
    return (
        '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>'
        f'<w:tblGrid>{grid}</w:tblGrid>{"".join(rows)}</w:tbl>'
    )


def picture(rid, pic_id, name, alt, cx, cy):
    return (
        '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
        f'<wp:extent cx="{cx}" cy="{cy}"/><wp:docPr id="{pic_id}" name="{name}" descr="{esc(alt)}"/>'
        '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        f'<pic:pic><pic:nvPicPr><pic:cNvPr id="{pic_id}" name="{name}"/><pic:cNvPicPr/></pic:nvPicPr>'
        f'<pic:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
        f'<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>'
        '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
    )


def styles_xml():
    def heading(n, size):
        return (
            f'<w:style w:type="paragraph" w:styleId="Heading{n}"><w:name w:val="heading {n}"/><w:basedOn w:val="Normal"/>'
            f'<w:next w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="{n - 1}"/></w:pPr>'
            f'<w:rPr><w:b/><w:sz w:val="{size}"/></w:rPr></w:style>'
        )

    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:styles xmlns:w="{W}">'
        '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault></w:docDefaults>'
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
        '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>'
        '<w:rPr><w:b/><w:sz w:val="48"/></w:rPr></w:style>'
        + heading(1, 32)
        + heading(2, 28)
        + heading(3, 24)
        + '<w:style w:type="paragraph" w:styleId="MyHeading"><w:name w:val="My Heading"/><w:basedOn w:val="Heading2"/></w:style>'
        '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style>'
        '<w:style w:type="paragraph" w:styleId="ListNumber"><w:name w:val="List Number"/><w:basedOn w:val="Normal"/>'
        '<w:pPr><w:numPr><w:numId w:val="4"/></w:numPr></w:pPr></w:style>'
        '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/>'
        '<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>'
        '<w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style>'
        '<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/>'
        '<w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>'
        '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/>'
        '<w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/>'
        '<w:left w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/>'
        '<w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr></w:style>'
        '</w:styles>'
    )


def lvl(ilvl, fmt, text, start=1, restart=None, extra=''):
    restart_xml = f'<w:lvlRestart w:val="{restart}"/>' if restart is not None else ''
    return (
        f'<w:lvl w:ilvl="{ilvl}"><w:start w:val="{start}"/><w:numFmt w:val="{fmt}"/>{restart_xml}'
        f'<w:lvlText w:val="{text}"/><w:lvlJc w:val="left"/>{extra}</w:lvl>'
    )


def numbering_xml():
    outline = (
        '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="multilevel"/>'
        + lvl(0, 'decimal', '%1.')
        + lvl(1, 'lowerLetter', '%2.')
        + lvl(2, 'lowerRoman', '%3.')
        + lvl(3, 'decimal', '%1.%2.%3.%4')
        + '</w:abstractNum>'
    )
    bullets = (
        '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>'
        + lvl(0, 'bullet', '', extra='<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr>')
        + lvl(1, 'bullet', 'o', extra='<w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New" w:hint="default"/></w:rPr>')
        + '</w:abstractNum>'
    )
    legal = (
        '<w:abstractNum w:abstractNumId="2"><w:multiLevelType w:val="multilevel"/>'
        + lvl(0, 'upperRoman', '%1)', start=3)
        + lvl(1, 'decimal', '%1.%2', restart=1)
        + '</w:abstractNum>'
    )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:numbering xmlns:w="{W}">'
        + outline
        + bullets
        + legal
        + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
        '<w:num w:numId="2"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>'
        '<w:num w:numId="3"><w:abstractNumId w:val="1"/></w:num>'
        '<w:num w:numId="4"><w:abstractNumId w:val="2"/></w:num>'
        '<w:num w:numId="5"><w:abstractNumId w:val="2"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="7"/></w:lvlOverride></w:num>'
        '</w:numbering>'
    )


def footnotes_xml():
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:footnotes {NS}>'
        '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>'
        '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>'
        '<w:footnote w:id="1"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>'
        '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r>'
        '<w:r><w:t xml:space="preserve"> Flow figures are monthly means.</w:t></w:r></w:p></w:footnote>'
        '</w:footnotes>'
    )


def endnotes_xml():
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:endnotes {NS}>'
        '<w:endnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:endnote>'
        '<w:endnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:endnote>'
        '<w:endnote w:id="1"><w:p><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:endnoteRef/></w:r>'
        '<w:r><w:t xml:space="preserve"> Calibration certificates are on file.</w:t></w:r></w:p></w:endnote>'
        '</w:endnotes>'
    )


def png_bytes():
    image = Image.new('RGB', (48, 32), (200, 40, 40))
    for x in range(48):
        for y in range(8):
            image.putpixel((x, y), (40, 40, 200))
    out = io.BytesIO()
    image.save(out, 'PNG')
    return out.getvalue()


def jpeg_bytes():
    image = Image.new('RGB', (64, 48), (30, 160, 60))
    for x in range(64):
        for y in range(48):
            if (x // 8 + y // 8) % 2 == 0:
                image.putpixel((x, y), (240, 240, 60))
    out = io.BytesIO()
    image.save(out, 'JPEG', quality=90, subsampling=0)
    return out.getvalue()


def package(path, body, rels_extra='', parts=None, with_notes=False, section_last=''):
    parts = parts or {}
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
        '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        + (
            '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>'
            '<Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/>'
            if with_notes
            else ''
        )
        + '</Types>'
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        f'<Relationship Id="rId1" Type="{REL}/officeDocument" Target="word/document.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
        '</Relationships>'
    )
    doc_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        f'<Relationship Id="rIdStyles" Type="{REL}/styles" Target="styles.xml"/>'
        f'<Relationship Id="rIdNumbering" Type="{REL}/numbering" Target="numbering.xml"/>'
        + (
            f'<Relationship Id="rIdFootnotes" Type="{REL}/footnotes" Target="footnotes.xml"/>'
            f'<Relationship Id="rIdEndnotes" Type="{REL}/endnotes" Target="endnotes.xml"/>'
            if with_notes
            else ''
        )
        + rels_extra
        + '</Relationships>'
    )
    core = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        '<dc:title>Pump Station Handbook</dc:title><dc:creator>Fixture Author</dc:creator><dc:language>en-US</dc:language>'
        '</cp:coreProperties>'
    )
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:document {NS}><w:body>{body}'
        + (section_last or '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>')
        + '</w:body></w:document>'
    )
    files = {
        '[Content_Types].xml': content_types,
        '_rels/.rels': rels,
        'word/document.xml': document,
        'word/_rels/document.xml.rels': doc_rels,
        'word/styles.xml': styles_xml(),
        'word/numbering.xml': numbering_xml(),
        'docProps/core.xml': core,
    }
    if with_notes:
        files['word/footnotes.xml'] = footnotes_xml()
        files['word/endnotes.xml'] = endnotes_xml()
    files.update(parts)
    with zipfile.ZipFile(os.path.join(HERE, path), 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, data in files.items():
            info = zipfile.ZipInfo(name, FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)


def rich_structure():
    link = (
        '<w:hyperlink r:id="rIdLink" w:history="1">'
        + run('the maintenance portal', style='Hyperlink')
        + '</w:hyperlink>'
    )
    footnote_ref = '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r>'
    endnote_ref = '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:endnoteReference w:id="1"/></w:r>'
    body = ''.join(
        [
            para('Pump Station Handbook', style='Title'),
            para('1 Overview', style='Heading1'),
            para(
                run('Every station is ')
                + run('inspected', bold=True)
                + run(' twice a year, ')
                + run('logged', italic=True)
                + run(' and ')
                + run('signed off', underline=True)
                + run('; see ')
                + link
                + run('.')
                + footnote_ref
            ),
            para('Scope', style='Heading2'),
            para('Inspect pumps', style='ListParagraph', num=(1, 0)),
            para('Check valves', style='ListParagraph', num=(1, 0)),
            para('Isolate line', style='ListParagraph', num=(1, 1)),
            para('Drain line', style='ListParagraph', num=(1, 1)),
            para('Record level', style='ListParagraph', num=(1, 2)),
            para('Close out', style='ListParagraph', num=(1, 0)),
            para('A paragraph that ends the first list.'),
            para('Restart item one', style='ListParagraph', num=(2, 0)),
            para('Restart item two', style='ListParagraph', num=(2, 0)),
            para('Bearings', style='ListParagraph', num=(3, 0)),
            para('Seals', style='ListParagraph', num=(3, 1)),
            para('Gaskets', style='ListParagraph', num=(3, 0)),
            para('Roman list from three', style='ListNumber'),
            para('Second roman item', style='ListNumber'),
            para('Readings', style='Heading2'),
            table(
                [
                    row([cell('Station'), cell('Flow rate', span=2)], header=True),
                    row([cell('East'), cell('12.5'), cell('13.1')]),
                    row([cell('North', vmerge='restart'), cell('9.8'), cell('10.2')]),
                    row([cell('', vmerge='continue'), cell('11.0'), cell('11.4')]),
                ],
                3,
            ),
            para('Table notes'),
            para(run('Noted in the log.') + endnote_ref),
            '<w:p><w:r><w:br w:type="page"/></w:r></w:p>',
            para('2 Images', style='Heading1'),
            para(
                picture('rIdJpeg', 1, 'photo', 'Green checker photo', 1270000, 952500)
                + run(' and ')
                + picture('rIdPng', 2, 'diagram', 'Red and blue bars', 960000, 640000)
            ),
            para('Sub heading by inheritance', style='MyHeading'),
            para('Last paragraph of section one.', extra='<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>'),
            para('Second section text.'),
        ]
    )
    rels = (
        f'<Relationship Id="rIdLink" Type="{REL}/hyperlink" Target="https://example.org/portal" TargetMode="External"/>'
        f'<Relationship Id="rIdJpeg" Type="{REL}/image" Target="media/photo.jpeg"/>'
        f'<Relationship Id="rIdPng" Type="{REL}/image" Target="media/diagram.png"/>'
    )
    package(
        'rich-structure.docx',
        body,
        rels_extra=rels,
        parts={'word/media/photo.jpeg': jpeg_bytes(), 'word/media/diagram.png': png_bytes()},
        with_notes=True,
    )


def merged_tables():
    body = ''.join(
        [
            para('Merged cells', style='Heading1'),
            table(
                [
                    row([cell('A1', span=2), cell('C1', vmerge='restart')]),
                    row([cell('A2'), cell('B2'), cell('', vmerge='continue')]),
                    row([cell('A3', vmerge='restart'), cell('B3', span=2)]),
                    row([cell('', vmerge='continue'), cell('B4'), cell('C4')]),
                ],
                3,
            ),
        ]
    )
    package('merged-tables.docx', body)


if __name__ == '__main__':
    rich_structure()
    merged_tables()
