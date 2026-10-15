# Word symbol-font fixture

`symbol-fonts.doc` is a Word 97-2003 document written by the office suite (headless export from a flat OpenDocument text file), not by the converter, so its character formatting is an input the reader has not shaped. `build-symbol-fonts-doc.mjs` holds the source runs and regenerates the file (`node tests/fixtures/word-symbol-fonts/build-symbol-fonts-doc.mjs`, needs `soffice` on PATH). Another office-suite release can change the bytes; commit the new file together with its hash.

Each paragraph is "Run N: <characters> end"; the characters of a run sit at U+F000 plus their code in the font. The expected text is written by hand in `tests/doc-symbol-fonts.test.ts` from the Adobe Symbol and Unicode pictographic charts; it is never produced from the reader's output.

| Run | Font | Characters (code in the font) | Becomes |
| --- | --- | --- | --- |
| 1 | Symbol | B7, 61, 62, E5 | bullet U+2022, alpha U+03B1, beta U+03B2, summation U+2211 |
| 2 | Wingdings | FC, 6C, A7 | check mark U+2713, black circle U+26AB, black small square U+25AA |
| 3 | Wingdings 2 | 52, 54 | ballot box with check U+2611, ballot box with x U+2612 |
| 4 | Wingdings 3 | 70, 71 | up triangle U+25B2, down triangle U+25BC |
| 5 | Webdings | 61 | heavy check mark U+2714 |

| File | SHA-256 |
| --- | --- |
| `symbol-fonts.doc` | ba748a0b73e383c39aa4979fec71183274de5b58ff082a35a041405638ea3735 |
