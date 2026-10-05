# Camera RAW samples

`manifest.json` lists one real camera-RAW file per format (arw, cr2, cr3, dng, nef, raw, 3fr, crw,
dcr, erf, mos, mrw, orf, pef, raf, rw2, x3f). All of them are public-domain (CC0) samples. They are
too large to commit, so they are fetched on demand with `npm run fixtures:raw` into
`tests/fixtures/raw/.cache/` (gitignored) and verified by byte size and SHA-256 against the manifest.

The conformance suite probes the RAW pairs with these files. Locally, a missing sample skips the
RAW checks; with `ORACLE_STRICT_MODE=1` (CI) a missing sample fails them.

`variants.json` lists further public-domain (CC0) samples whose sensor-data encoding differs from the
`manifest.json` sample of the same format: older and newer Sigma X3F generations (`x3f-sd14`,
`x3f-merrill`, `x3f-quattro`) and two more Raspberry Pi sensors (`raw-imx219`, `raw-imx477`). They
are cached as `<format>-<variant>.<format>`. `npm run fixtures:raw -- x3f-sd14 raw-imx477` fetches only
the named samples.
