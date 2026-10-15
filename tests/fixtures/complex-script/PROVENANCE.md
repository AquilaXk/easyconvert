# Complex-script paragraphs

`samples.json` holds six paragraphs (Arabic, Hebrew, Hindi, Thai, Korean, Japanese) written for this repository; no
third-party text. Each one is two to three sentences, long enough to break over several lines on an A4 page, and the
Arabic and Hebrew ones also carry a number and a Latin word to exercise bidi reordering. `rtl` marks right-to-left
paragraphs; `referenceFamily` is the installed family the LibreOffice reference rendering sets the text in (the family
the in-process writer picks for the script on a machine with the Noto fonts).

The text is the expected output of text extraction: tests and the bench compare what a PDF reader returns against
these strings, never against the output of the converter under test.
