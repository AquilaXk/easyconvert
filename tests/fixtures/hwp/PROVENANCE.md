# HWP 5.0 test documents

Real documents written by the Hangul word processor, used to check the HWP reader against text and table grids found
by a separate reader (`reference-extract.py`). None of them was produced by this repository.

| File | Origin | Licence | SHA-256 |
| --- | --- | --- | --- |
| `blank.hwp` | `sample_hwp/blank.hwp` in https://github.com/neolord0/hwplib at commit 6746c27f17ebf5277493206284aa32044a1839c4 | Apache-2.0 | ed637bb8ac8cd41c616bb02d707f2d32506291456290c2286fc215d4ec21ce4e |
| `changing-paragraph-text.hwp` | `sample_hwp/changing-paragraph-text.hwp`, same repository and commit | Apache-2.0 | 42ebd913a044ef1dcb207990727b04c51e261e37bc045583e6035e120f39db01 |
| `merging-cell.hwp` | `sample_hwp/merging-cell.hwp`, same repository and commit | Apache-2.0 | e1f32a60c05bb79fd6c669832c94e594b6432c29442cd8ec417d327e76f7c43c |
| `distribution.hwp` | `sample_hwp/distribution.hwp`, same repository and commit (a distribution-protected document) | Apache-2.0 | 76377f4c2a10981f382a4ba65ea3b2c9b771a28c6cc55c110ca8ead14f7cb01a |
| `noori.hwp` | `website/static/files/noori.hwp` in https://github.com/hahnlee/hwp.js at commit b631063e9149737a909f78c25667ad9ecf116c3a (a press release of the Korean Ministry of Science and ICT) | Apache-2.0 | d4b9f0d59bafa4b550db142ef3b50f570ffee7cdcbd9a290eac26779172f262a |
| `basics-report.hwp` | `packages/parser/src/__tests__/data/basicsReport.hwp`, same repository and commit | Apache-2.0 | 6458ad26537739d68b93bf264c9d0c08b05b47e7fdff59b81f14586c31740ced |

The Apache-2.0 licence text is at https://www.apache.org/licenses/LICENSE-2.0. The files are unmodified copies.

The `SHA-256` column is checked by `tests/hwp-real-documents.test.ts` ("fixture provenance"), so a changed file fails
the suite.

## Goldens

`<name>.reference.json` is the output of `reference-extract.py` for `<name>.hwp`. The script reads the OLE2 container
with the `olefile` package and walks the records as the Hancom "Hangul Document File Format 5.0" specification lays them
out (control characters of 8 UTF-16 units, table cell addresses in the cell list headers, captions before the table
record). It shares no code with the converter. To regenerate a golden:

    pip install olefile
    python3 reference-extract.py blank.hwp > blank.reference.json

`tests/helpers/hwp-reference.ts` repeats the same walk in TypeScript (reading the container with 7-Zip) for files the
converter writes.
