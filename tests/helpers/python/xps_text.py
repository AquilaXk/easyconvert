"""Text of the pages of an XPS or OpenXPS file, read by MuPDF (PyMuPDF): argv[1] is the file, the output is a JSON list with the text of each page."""
import json
import sys

try:
    import pymupdf as mupdf
except ImportError:
    import fitz as mupdf

document = mupdf.open(sys.argv[1], filetype="xps")
print(json.dumps([page.get_text() for page in document]))
