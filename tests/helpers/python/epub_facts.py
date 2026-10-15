#!/usr/bin/env python3
"""Reads an EPUB with ebooklib and prints what an independent reader finds as JSON: metadata, the content documents
in spine order, the images and the navigation entries. Usage: epub_facts.py FILE.epub"""
import json
import sys

from ebooklib import epub, ITEM_DOCUMENT, ITEM_IMAGE


def flatten(toc):
    entries = []
    for entry in toc:
        if isinstance(entry, tuple):
            section, children = entry
            entries.append(section.title)
            entries.extend(flatten(children))
        else:
            entries.append(entry.title)
    return entries


def main(path):
    book = epub.read_epub(path, {'ignore_ncx': False})
    documents = [item.get_name() for item in book.get_items_of_type(ITEM_DOCUMENT)]
    images = [item.get_name() for item in book.get_items_of_type(ITEM_IMAGE)]
    spine = [book.get_item_with_id(item_id[0]).get_name() for item_id in book.spine if book.get_item_with_id(item_id[0])]
    print(
        json.dumps(
            {
                'title': book.get_metadata('DC', 'title')[0][0] if book.get_metadata('DC', 'title') else None,
                'language': book.get_metadata('DC', 'language')[0][0] if book.get_metadata('DC', 'language') else None,
                'creators': [entry[0] for entry in book.get_metadata('DC', 'creator')],
                'documents': documents,
                'images': images,
                'spine': spine,
                'toc': flatten(book.toc),
            }
        )
    )


if __name__ == '__main__':
    main(sys.argv[1])
