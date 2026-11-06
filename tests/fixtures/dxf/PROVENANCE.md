# DXF test documents

| File | Origin | Licence | SHA-256 |
| --- | --- | --- | --- |
| `ezdxf-ascii-r12.dxf` | `integration_tests/data/ASCII_R12.dxf` in https://github.com/mozman/ezdxf at commit c498560bb491c357deda538360ed0c8fdb11f5a7 (a release 12 drawing, `$ACADVER` AC1009, no `$DWGCODEPAGE`, with Latin-1 letters written as single bytes and Greek letters written as `\U+XXXX`) | MIT (Copyright Manfred Moitzi) | b476d3e53fe24c1db3c701d20b2bebd774f7bd7966b12d81891505b9b29e4d21 |

The file is an unmodified copy. The MIT licence text is at https://github.com/mozman/ezdxf/blob/master/LICENSE.
`tests/cad-dxf-text-escapes.test.ts` checks the `SHA-256` column, so a changed file fails the suite.
