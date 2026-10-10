#!/usr/bin/env python3
"""Authors an EPUB 3 with ebooklib, a package writer that shares nothing with the converter.

The book holds two chapters: the first has a heading, an inline-formatted paragraph with a link, an ordered list with a
nested bullet list and a picture; the second has a heading, a sub heading and a table with a merged cell. The expected
structure is written out in tests/epub-structure.test.ts from this content.

Usage: author_epub.py OUTPUT.epub PICTURE.png
"""
import sys

from ebooklib import epub


def main(output, picture_path):
    book = epub.EpubBook()
    book.set_identifier('urn:uuid:0f0e8a52-7a31-4c1f-9e4b-6a6f2b7d9c10')
    book.set_title('Authored Handbook')
    book.set_language('en')
    book.add_author('Fixture Author')

    with open(picture_path, 'rb') as handle:
        picture = epub.EpubImage(uid='pic', file_name='images/pic.png', media_type='image/png', content=handle.read())
    book.add_item(picture)

    one = epub.EpubHtml(title='Opening', file_name='opening.xhtml', lang='en')
    one.content = (
        '<h1 id="opening">Opening</h1>'
        '<p>Plain text with <strong>strong</strong> and <em>emphasis</em> and <a href="https://example.org/a">a link</a>.</p>'
        '<ol><li>First step<ul><li>Detail one</li><li>Detail two</li></ul></li><li>Second step</li></ol>'
        '<p><img src="images/pic.png" alt="Small picture"/></p>'
    )
    two = epub.EpubHtml(title='Data', file_name='data.xhtml', lang='en')
    two.content = (
        '<h1 id="data">Data</h1><h2 id="table">Table</h2>'
        '<table><thead><tr><th>Name</th><th colspan="2">Values</th></tr></thead>'
        '<tbody><tr><td rowspan="2">Alpha</td><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table>'
    )
    book.add_item(one)
    book.add_item(two)
    book.toc = (epub.Link('opening.xhtml', 'Opening', 'opening'), epub.Link('data.xhtml', 'Data', 'data'))
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())
    book.spine = ['nav', one, two]
    epub.write_epub(output, book)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
