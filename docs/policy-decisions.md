# Policy decisions

This document records the conversion and product policies of EasyConvert. Each entry gives the reason the policy is right in practice and what it costs, so a later change can weigh the same trade-offs instead of guessing.

The bar for conversion behaviour is the output of mature commercial converters: the same results users already get elsewhere, at the same or better quality and speed. An entry never relies on "another product does this" alone; it states the practical reason behind the common practice.

## Format

Each entry has:

- **Status**: Implemented (with the change that did it), Decided (with the issue that tracks it), or Superseded.
- **Decision**: what the system does.
- **Why**: the practical reason it is right.
- **Trade-offs**: what it costs and who pays.
- **Alternatives rejected**: the options weighed and why they lost.
- **Verified by**: the tests or bench rows that hold it in place.
- **Revisit when**: the facts that would change the decision.

Add an entry, or update one, in the same pull request that changes a policy.

## Contents

Image output

1. [AVIF chroma and bit depth](#1-avif-chroma-and-bit-depth)
2. [JPEG chroma and encoder tools](#2-jpeg-chroma-and-encoder-tools)
22. [Image metadata and alpha](#22-image-metadata-and-alpha)
25. [16-bit sRGB tone-curve mapping and RAW development parity](#25-16-bit-srgb-tone-curve-mapping-and-raw-development-parity)

Media and documents

3. [Lossy audio resampling and sample format](#3-lossy-audio-resampling-and-sample-format)
4. [Restricted and encrypted PDFs](#4-restricted-and-encrypted-pdfs)
5. [Document passwords](#5-document-passwords)
6. [External images in HTML](#6-external-images-in-html)
7. [Characters without a Unicode counterpart](#7-characters-without-a-unicode-counterpart)
8. [Empty documents and macros](#8-empty-documents-and-macros)
9. [Conversion warnings](#9-conversion-warnings)
10. [Archive bomb limits](#10-archive-bomb-limits)
19. [HTML character encoding](#19-html-character-encoding)
20. [Damaged office files](#20-damaged-office-files)
21. [Charts, notes and sheets in PDF](#21-charts-notes-and-sheets-in-pdf)
23. [Embedded SVG images, physical units and child clip paths](#23-embedded-svg-images-physical-units-and-child-clip-paths)
24. [WOFF/WOFF2 font compression and colour bitmap fonts](#24-woffwoff2-font-compression-and-colour-bitmap-fonts)
27. [Ebook FB2/MathML text fidelity and PDF compression structural repair](#27-ebook-fb2mathml-text-fidelity-and-pdf-compression-structural-repair)

Engines

11. [Open-source engines only, separate programs for copyleft tools](#11-open-source-engines-only-separate-programs-for-copyleft-tools)
12. [Engine choice and version pinning](#12-engine-choice-and-version-pinning)
13. [CAD input](#13-cad-input)
14. [SVG to PDF](#14-svg-to-pdf)
29. [DWG input](#29-dwg-input)
31. [Starting external programs from a small helper process](#31-starting-external-programs-from-a-small-helper-process)

Usage limits

15. [Usage is charged for successful conversions only](#15-usage-is-charged-for-successful-conversions-only)
16. [Free and anonymous limits](#16-free-and-anonymous-limits)

Quality evidence

17. [Parity gate: quality and speed against reference tools](#17-parity-gate-quality-and-speed-against-reference-tools)
18. [Public sample sets as evidence](#18-public-sample-sets-as-evidence)

Tabular data

26. [Tabular data fidelity and Parquet encodings](#26-tabular-data-fidelity-and-parquet-encodings)

Compression

28. [Zstandard level 3 match finder and literal cost floor](#28-zstandard-level-3-match-finder-and-literal-cost-floor)
29. [Archive repacking in process: deflate engine, size bound and fail-over](#29-archive-repacking-in-process-deflate-engine-size-bound-and-fail-over)

---

## 1. AVIF chroma and bit depth

- **Status**: Implemented (#749, issue #736), decided 2026-10-11. Supersedes the 2026-10-09 policy (graphics 4:4:4, at most 10 bits).
- **Decision**:
  - **Lossy output** is 4:2:0 for all content, photographs and graphics alike.
  - **Lossless output** (quality 100), and pictures with an identity colour matrix, are 4:4:4.
  - **Bit depth**: an 8-bit source is written at 8 bits. A 9- or 10-bit source is written at 10 bits. A source of 11 bits or more, 16-bit included, is written at 12 bits. HDR renditions (PQ or HLG) keep their 10 bits.
  - **Alpha and metadata**: see [22. Image metadata and alpha](#22-image-metadata-and-alpha).
- **Why**: users compare our files with the ones the leading converters give them. Those use 4:2:0 for lossy AVIF and keep high-bit-depth sources at a matching depth. Matching this keeps file sizes comparable for every content class, so a user switching to us does not get files that are suddenly larger. 4:2:0 is also the layout every AVIF decoder handles fastest. Keeping 12 bits for 16-bit sources preserves gradations and editing headroom that a 10-bit cap would throw away.
- **Trade-offs**:
  - At the same quality setting, 4:2:0 softens coloured edges in screenshots, text and line art. 4:4:4 would keep them sharp, at a larger file.
  - 12-bit AVIF needs the AV1 Professional profile. Some hardware decoders, and decoders that implement only the AVIF Baseline profile (AV1 Main), cannot open it, so a 16-bit source can produce a file that does not open on every device.
  - Measured against the reference encoder at the same constraints (BD-rate, 0 is parity, lower is better): the 11 photographs that were 1.6 to 4.9 % behind in SSIM are now between -3.1 and +0.9 %; the 16-bit class is 12 to 13 % ahead in WebP and AVIF PSNR. Photographs stay on the in-process encoder, whose speed is 1.2 to 1.4 times the reference's; the command-line encoder with edge-preserving chroma conversion took the same photographs to +1.3 to +1.7 % SSIM at 0.7 times the speed, which is why the 4:4:4 reference could not be met by encoder tuning alone. On the CI runner after the change the in-process encoder reads 0.95 of the reference's speed on `kodim23` and `photo-b` (the reference now runs at 4:2:0 as well), which #641 tracks.
  - The 4:4:4 policy it replaces was the reason for the photo SSIM gap: against a 4:4:4 reference no encoder setting tried (perceptual tuning, edge-preserving conversion, quantiser modulation, a slower speed preset) met both metrics inside the speed gate.
- **Alternatives rejected**:
  - **Graphics 4:4:4 with a 10-bit cap** (the previous policy). It gave sharper graphic edges and wider device support, but its file sizes and bit depths diverged from what users expect from converters.
  - **Always 4:4:4.** Larger photographs for no visible gain.
- **Verified by**:
  - `src/lib/conversions/image-encoder-defaults.ts` and its tests.
  - The image parity rows, where the reference encoder runs at the same chroma and bit depth and BD-rate decides.
- **Revisit when**:
  - Users report 12-bit files that do not open.
  - A caller-facing chroma or bit-depth option is added.
  - Decoder support for the Professional profile becomes universal.

## 2. JPEG chroma and encoder tools

- **Status**: Implemented (#716, #719, #722).
- **Decision**:
  - **Chroma**: below quality 90, JPEG uses 4:2:0. At 90 and above it uses 4:4:4, for all content.
  - **Photographs**: baseline scan for colour photographs, progressive scan (without a scan search) for grey photographs, no trellis quantisation.
  - **Graphics**: a quantisation table tuned for structural similarity.
  - **Classification** (#749): a picture with more than 8 bits per sample that shows thousands of tones in its thumbnail is a photograph, whatever the flat share of its background says.
- **Why**:
  - The quality-90 switch is the long-standing default of the common image toolkits, so outputs and sizes match user expectations. Above 90, users ask for fidelity and chroma resolution is visible.
  - Trellis quantisation saves about 8 % of bytes on photographs but adds a large share of the encode time. The reference encoders' defaults do not use it either, so speed parity wins.
- **Trade-offs**: below 90, coloured text in a JPEG is slightly blurred. Photographs are a few per cent larger than the slowest encoder settings would make them. A radiograph (16-bit grey, 44 % flat black) was classified as a graphic and got the graphic table, which zeroes its fine detail: SSIM BD-rate +1.7 % against the reference, -0.7 % with the photograph table. The classifier reads a second, 16-bit thumbnail only for a 16-bit picture the 8-bit one calls graphic, so the encode time did not change (24 ms either way on the 16-bit space photograph).
- **Alternatives rejected**:
  - **Always 4:4:4**: noticeably larger files at the same quality setting, with no visible gain on photographs.
  - **Trellis on**: too slow.
- **Verified by**: the JPEG parity rows, quality and speed, on the public picture sets.
- **Revisit when**: CPU budgets change enough that trellis becomes free relative to the reference.

## 3. Lossy audio resampling and sample format

- **Status**: Implemented (#718).
- **Decision**:
  - Audio that needs a rate change goes through the band-limited soxr resampler. Output for a lossy encoder uses 16-bit filter precision.
  - Lossless and PCM outputs, normalised files, and callers who ask for soxr by name keep the full 28-bit precision.
  - 16-bit output is dithered.
- **Why**:
  - At 16-bit precision the resampling error sits 83 dB below the signal. The coding noise of Opus at 64 kbit/s, and of AAC and MP3 at their usual rates, sits 25 to 40 dB below it. The resampler is therefore never what a listener hears, and the cheaper filter is built and run faster.
  - Lossless outputs have no coding noise to hide the resampler, so they keep the full precision (97 dB).
  - The default resampler's error is 64 dB below the signal, which is close enough to the coding noise to matter on bright material.
- **Trade-offs**: lossy outputs could carry a measurably, though never audibly, cleaner resample at about 2 ms more per four seconds of stereo audio.
- **Alternatives rejected**:
  - **28-bit precision everywhere**: slower, with no audible gain on lossy outputs.
  - **The default resampler**: faster, but nearer the codec's noise floor.
- **Verified by**: `src/lib/conversions/media-audio-quality.ts` and the audio parity rows. #738 adds a perceptual quality metric.
- **Revisit when**: a perceptual metric shows the precision choice matters at low bit rates.

## 4. Restricted and encrypted PDFs

- **Status**: Implemented (#571 and follow-ups).
- **Decision**:
  - A PDF with an open password needs that password. Without it the request fails with 422.
  - A PDF with owner restrictions only, such as no printing or no editing, is processed after the caller sets `confirmEditRights: true` to confirm they may edit it. Without that confirmation the request fails with 422.
  - An unlock operation removes the restrictions on the same terms.
- **Why**:
  - Owner restrictions are not encryption of the content: any reader can open the file. Commercial PDF tools process such files once the user asserts the right to do so.
  - Refusing them outright blocks routine work, such as compressing a form you filled in, without protecting anyone.
  - An open password does protect content, so it is always required.
- **Trade-offs**: the confirmation relies on the caller's word. The rights responsibility sits with the caller, as it does with every commercial tool.
- **Alternatives rejected**:
  - **Refusing all restricted files**: stricter than the market, and it fails users.
  - **Ignoring restrictions silently**: hides a rights question from the user.
- **Verified by**: `src/lib/conversions/pdf-access.ts` and its tests; the pdf-ops parity rows for unlock and decrypt.
- **Revisit when**: legal advice for a target market requires a different flow.

## 5. Document passwords

- **Status**: Decided (#683).
- **Decision**:
  - Callers may supply the password of an encrypted Office or legacy spreadsheet document.
  - The password is used in memory only. It is never logged or stored.
  - A missing or wrong password fails with 422.
- **Why**: encrypted business documents are common, and converters accept their passwords. Refusing them makes a whole class of files unconvertible.
- **Trade-offs**: password handling widens the secret surface. It is contained by never persisting the password, and by redacting it from logs and errors.
- **Alternatives rejected**: refusing encrypted documents.
- **Verified by**: the tests added with #683.
- **Revisit when**: a password must survive a retry. If so, it needs an encrypted, short-lived store.

## 6. External images in HTML

- **Status**: Implemented (#732).
- **Decision**:
  - When converting an uploaded HTML page, images it references by public `http`/`https` URL are fetched and embedded, as a browser would show them.
  - The fetch runs in a separate child process with no secrets. That process accepts only public addresses on ports 80 and 443, and pins the resolved address.
  - It re-checks every redirect hop, and caps each image (10 MiB, 10 s) and each document (50 MiB, 100 images, 30 s).
  - The renderer itself stays without network access.
  - Images that fail stay out with a warning. `requireResources: true` turns a failure into 400 instead.
  - Deployments without internet set `HTML_IMAGE_FETCH=off`.
- **Why**: users expect a converted page to look like the page in a browser. Leaving images out silently produces a visibly broken document. The guards make the fetch safe against server-side request forgery.
- **Trade-offs**:
  - Conversion time depends on remote servers, within the caps.
  - Worker egress must be allowed to public addresses on 80/443.
  - A page on a nonstandard port loses its images, with a warning.
- **Alternatives rejected**:
  - **Leaving every external image out with a warning** (the earlier behaviour): safe, but the output is visibly worse than users get elsewhere.
  - **Letting the renderer fetch directly**: it would give a full browser engine network access next to the job's secrets.
- **Verified by**: `tests/html-image-fetch*.test.ts`, `tests/public-address.test.ts`, and the end-to-end tests with an independent PDF image reader.
- **Revisit when**: user demand appears for stylesheets, fonts or other ports.

## 7. Characters without a Unicode counterpart

- **Status**: Implemented (#725); extended to every in-process PDF writer (#742), to legacy binary word-processing documents (`.doc`, #726) and, with styles, WP Greek and presentations, in the follow-ups of #760.
- **Decision**:
  - Symbol-font private-use characters are mapped to Unicode with the standard tables for the symbol fonts.
  - A character that no table maps becomes U+FFFD, and a warning names the font and the code.
  - **The PDF writers apply the same rule to any code point no font can draw** (unassigned, private-use, noncharacter, lone surrogate). The code point becomes U+FFFD and the result carries one warning line for each distinct code point. They no longer refuse the document.
  - **Binary word-processing documents (`.doc`) take the font from the formatting of the character**. Each of the ASCII, East Asian and other fonts is the first one set by the run, then by the character style of the run, then by the paragraph style of its paragraph (the Normal style when it has no entry of its own), then by the default character fonts of the style sheet; a style that sets no font hands the choice to the style it is based on. The font of the character is the first of the three that is a symbol font. A Symbol field character (a placeholder in the text plus its own font and code) maps the same way, and in any other font it is the Unicode character it names. A document without a font table or a character whose font index names no font maps nothing, and the warning names no font.
  - **A style chain is followed for at most 32 styles, and a malformed one is refused** (HTTP 400): styles based on each other, a style the sheet does not hold, a style whose size runs outside the table stream, a chain longer than the limit. Each style is resolved once per document.
  - **The WP Greek faces (WordPerfect character set 8) have a table of their own**: the capital and small Greek letters in alphabet order from code 0x21. The slots the set fills with a repeat of another letter and the accented and polytonic letters (their order differs between versions of the set) map to nothing, so they become U+FFFD with a warning like any other unmapped code.
  - **A symbol-font character whose Unicode counterpart no installed font can draw becomes U+FFFD in a PDF**, with a warning that names the font, the code and the counterpart. Text, HTML and the other outputs keep the counterpart. Installing a font that covers the counterpart makes the next conversion draw it. **Binary presentations (`.ppt`) follow the same rule**: the same helper decides what the installed fonts cover, and the warning lines are the same. Presentations in the XML format do not map symbol fonts at all; their private-use characters fall under the rule of the PDF writers above.
- **Why**:
  - The whole document must still convert. Failing it for one glyph is worse than any substitute.
  - A replacement mark is honest.
  - Drawing the code with another font would show a different glyph with no sign of the error, because unknown symbol encodings differ font by font.
  - Word processors keep private-use characters in text on purpose (a bullet or a math symbol typed in a symbol font), so a whole document must not fail for one.
- **Trade-offs**:
  - The reader sees a replacement mark where the original showed a glyph.
  - Plain text, Markdown and HTML to PDF follow the rule too. A file with a stray noncharacter converts, where it used to fail with HTTP 400.
  - A character that is assigned but that no installed font covers still fails, because installing a font fixes it. The exception is a character that came from a symbol-font mapping in a `.doc`: the pictograph and arrow blocks the Wingdings and Webdings tables map to are covered by few fonts, and a bullet or an arrow is not worth a failed document.
  - A symbol-font character that the document stores with the font of an ordinary text style (a check box in the Normal style, whose font is Arial) is not a symbol character to the reader, and it is replaced and reported under that font. The formatting names no symbol font, so any guess would invent a glyph.
  - A PDF made from a presentation shows U+FFFD for an arrow or a pictograph that no installed font covers, where it used to fail the file.
- **Alternatives rejected**:
  - **Refusing the document.**
  - **Rendering with a bundled symbol font**: wrong glyphs, silently.
  - **Dropping the character**: the loss would leave no trace in the output.
  - **Refusing a `.doc` whose mapped character has no installed glyph**: the same document converts on a machine with the font and fails on one without, for a decoration.
- **Verified by**: the PPT and `.doc` symbol-font tests (`tests/doc-symbol-fonts.test.ts`, with a document written by the office suite and the PDF text read by a separate PDF reader; `tests/doc-style-fonts.test.ts`, with documents written by hand from the file format; `tests/ppt-text-extraction.test.ts`; and `tests/doc-corpus-symbol-fonts.test.ts` and `tests/ppt-corpus-symbol-fonts.test.ts` on public documents, the Greek letters read against the sentences they stand in), `tests/symbol-font-map.test.ts` (the Greek alphabet in order), `tests/pdf-unicode-text-writers.test.ts` (plain text), `tests/conversion-warnings-scope.test.ts`, and the public document rows (`doc-poi-bug59058.docx` and `doc-poi-41246-2.ppt` convert).
- **Revisit when**: a reliable glyph source for the remaining math fonts appears, the accented letters of the WP Greek set are confirmed against a real document, or the `.pptx` reader names the font of a run.

## 8. Empty documents and macros

- **Status**: Implemented (#717).
- **Decision**:
  - An input with no content converts to an empty but valid output, with an `emptyOutput` warning.
  - Macro-enabled Office files have their macros removed before rendering.
- **Why**:
  - An empty input is a legitimate request. A valid empty output, with a warning, lets automated pipelines continue.
  - Macros never affect a static render, and removing them takes untrusted code out of the renderer's reach.
- **Trade-offs**: none for rendered output. Macro-to-macro conversions do not exist.
- **Alternatives rejected**: failing empty inputs, which breaks batch jobs.
- **Verified by**: the office output-check tests, and the real-world corpus gate, which accepts a zero-byte output only for the six corpus files that the manifest marks `emptyInput`, each with the reason read from the file by a tool other than the converter, and never because the conversion declared `emptyOutput` (it does so for any blank text result) (`tests/realworld-corpus.test.ts`).
- **Revisit when**: a format is added whose macros change the rendered result.

## 9. Conversion warnings

- **Status**: Implemented (#725).
- **Decision**:
  - Anything a conversion leaves out or substitutes is reported in `warnings`.
  - That includes dropped streams, omitted images and replaced characters.
  - The warnings appear in the synchronous response body, in the `X-Conversion-Warnings` header, and in the job result and webhook.
- **Why**: a conversion that silently loses content is a quality defect the user cannot see. Reporting it lets callers decide.
- **Trade-offs**: a larger API surface. Warnings are capped at 50 lines plus a count.
- **Alternatives rejected**: logging only, which callers cannot see.
- **Verified by**: `tests/conversion-warnings-api.test.ts` and `tests/media-dropped-streams-api.test.ts`.
- **Revisit when**: callers need machine-readable warning codes. Add codes beside the text.

## 10. Archive bomb limits

- **Status**: Implemented.
- **Decision**:
  - Archive extraction refuses a compression ratio above 100:1 once more than 1 MiB has been decoded.
  - It also refuses archives over the entry-count and total-size caps.
- **Why**: a few kilobytes can expand to terabytes. Ratio caps stop that before disk or memory runs out. The 1 MiB floor keeps small, highly repetitive files such as logs from tripping the ratio rule.
- **Trade-offs**: a legitimate file over 100:1 and larger than 1 MiB is refused, such as a huge sparse dump.
- **Alternatives rejected**:
  - **Size caps only**: a bomb still fills the cap.
  - **No floor**: false alarms on small text.
- **Verified by**: `src/lib/conversions/archive-extraction-safety.ts` and its tests.
- **Revisit when**: users report legitimate refusals. The caps can then become per-plan.

## 11. Open-source engines only, separate programs for copyleft tools

- **Status**: Implemented.
- **Decision**:
  - Every engine is open source and free to run.
  - Copyleft engines, such as the PostScript interpreter and the DWG reader (29), are used only as unmodified separate programs.
  - No paid engine, service or CI runner is adopted.
- **Why**: per-conversion licence costs would make free tiers uneconomic. Using copyleft tools as separate programs keeps their obligations with those programs, and the licence notice lists them (`docs/licensing.md`).
- **Trade-offs**: some formats have no open engine that matches the best paid ones. The gap is measured, not hidden, and tracked as an issue.
- **Alternatives rejected**: paid office or CAD engines.
- **Verified by**: `docs/licensing.md` and the dependency review.
- **Revisit when**: a format has no open engine and real demand.

## 12. Engine choice and version pinning

- **Status**: Decided (#703).
- **Decision**: callers may choose an engine and an engine version for a conversion. Every engine version is pinned in the images, and a pinned version is used until the caller or a release changes it.
- **Why**:
  - Reproducibility: the same input and options give the same output today and next month.
  - Choice: some content renders better in a different engine, and power users need to pick it.
- **Trade-offs**: several engine versions must be kept, with images and tests for each.
- **Alternatives rejected**: always the newest engine, which silently changes outputs between releases.
- **Verified by**: the tests planned with #703.
- **Revisit when**: image size or maintenance cost becomes a constraint. If so, limit the number of retained versions.

## 13. CAD input

- **Status**: Implemented for DXF (#727, #744) and for DWG (#728, see [29](#29-dwg-input)).
- **Decision**:
  - DXF is read in-process. It covers lines, arcs, circles, ellipses, clamped and unclamped B-splines (sampled over their valid Cox-de Boor domain `[knots[degree], knots[control.length]]`), polylines with bulges, blocks with nesting, arrays and negative-Z OCS extrusion, dimensions, and single-line and multi-line text (including horizontal/vertical alignments, `Aligned`/`Fit` baseline orientation and width scaling, `STYLE` width factors, `%%` control codes, and linked multi-column `MTEXT` records wrapped to single-column width). Degenerate block insertions with a zero scale factor are skipped after accounting for their visit budget.
  - Output is one vector page fitted to the drawing extents (both strokes and text boxes), with every text line placed at its true drawing coordinates.
  - Expansion is bounded by one budget for the whole drawing; a drawing over it fails with 422.
  - The CAD parity score reads every output the same way, whatever the renderer draws: ink is any pixel that differs from the page colour, the frame of the drawing is fitted so that the truth strokes (the strokes read from the DXF) lie on ink, and the tolerance is a symmetric 1 % dilation. Ink inside a text box that is on no stroke is taken for glyphs up to a quarter of the box; beyond that it is charged to precision, and ink in a text box never meets a truth stroke that lies outside the text boxes. The score names no colour, line weight or page layout of the product or of the reference tool. B-splines whose knot vector is unclamped are sampled over their valid domain with the reference library's domain sampler, because its path conversion leaves the domain.
  - DWG is converted to DXF by an open-source reader run as a separate program (see [29](#29-dwg-input)).
- **Why**:
  - Fidelity: dropping entity types, misplacing aligned or multi-column text, ignoring negative-Z block extrusion, or extrapolating unclamped B-spline knot vectors outside their domain gives visibly wrong drawings.
  - Fitting the page to the drawing extents matches what CAD exporters produce.
  - The budget stops a small file from expanding into millions of strokes.
  - Scoring: a score that names the product's colours, line weight or page cannot be applied to another renderer, so the same drawing would be judged in a different frame depending on who drew it. Registering the truth strokes onto the picture reads every renderer alike, and the 25 % glyph coverage is above the largest share measured on the corpus renders of both sides (22 % of a text box, median 5 %) while a solid box (100 %) or dense scribbling is not text.
- **Trade-offs**:
  - Drawings beyond the budget are refused. The DWG reader does not handle every vendor version.
  - The fitted frame is optimistic for every renderer, the product and the reference tool alike: it moves to where the truth strokes find ink, so a render that is slightly off reads better than a fixed frame would score it. The product's margin over the reference tool shrinks where the reference was understated before.
  - Each frame edge may move at most 40 % inward and 5 % outward of the box of all ink. A render that leaves out only the outermost outline is over-penalised: the frame cannot grow past 5 %, so it settles on inner strokes and loses precision as well as recall. A render with a page border or a title block is charged for those marks in precision, and the search also starts from the biggest component inside such a border.
  - Text boxes: ink in them that is on no stroke is free up to 25 % of the grown box, so noise below glyph coverage is not charged; that bound is deliberate and the blind spot is at most a quarter of each text box. Text can move the frame when strokes are missing (the miss then shows in precision and extent error), but it never counts as a stroke outside the text boxes.
  - A truth with no strokes, no length, or all strokes on one horizontal or vertical line cannot be registered and scores as nothing drawn for both sides.
- **Alternatives rejected**:
  - Paid DWG libraries.
  - Adding a title and frame to the page, which users then have to crop.
  - Keying the score on the stroke and text colours of the product, which put the reference tool's black drawings in a different frame and understated them.
  - Using the box of all ink as the frame, which counts text outside the strokes as a scale error.
- **Verified by**: the CAD parity rows, `tests/cad-dxf-*.test.ts` and `tests/bench-cad-ink.test.ts` (the same drawing in several palettes, light on dark included, scores alike; a missing outline costs recall; text or a stray mark outside the strokes does not move the frame; solid or hatched text boxes lower precision; text does not stand in for strokes outside the text boxes; a drawing inside a page border is found).
- **Revisit when**: users hit the budget with real drawings; a renderer draws a page border, a title block or text that the 25 % glyph coverage or the 5 % outward limit misreads; or the corpus gains drawings whose text is denser than the measured 22 %.

## 14. SVG to PDF

- **Status**: Implemented (#727).
- **Decision**: SVG becomes a vector PDF with real text, rendered by a separate SVG renderer in the sandbox from the sanitised SVG. A worker without that renderer falls back to a raster page and records the fallback.
- **Why**: a raster PDF loses text search, selection and sharp printing. A vector page is what users expect.
- **Trade-offs**: one more program in the worker image.
- **Alternatives rejected**: rasterising in process.
- **Verified by**: `tests/svg-native-pdf-route.test.ts` and the vector parity rows.
- **Revisit when**: an in-process vector writer matches the renderer.

## 15. Usage is charged for successful conversions only

- **Status**: Implemented (#690).
- **Decision**:
  - Only a conversion that produces output consumes quota.
  - A conversion that times out (504) or is cancelled by the client (499) is refunded.
- **Why**: users should not pay for failures they did not cause. Charging only success also gives the service an incentive to fail less.
- **Trade-offs**: repeated failing requests cost compute without consuming quota. Processing-time caps, concurrency caps and rate limits bound that cost.
- **Alternatives rejected**: charging on submission.
- **Verified by**: the usage ledger tests.
- **Revisit when**: abuse through deliberately failing jobs appears in metrics.

## 16. Free and anonymous limits

- **Status**: Decided (#693). The processing and concurrency caps are implemented (#690).
- **Decision**:
  - **Free and anonymous callers**:
    - files up to 1 GB;
    - no page limit;
    - up to 5 minutes of processing per conversion;
    - at most 5 concurrent conversions.
  - **Output files**: kept for 24 hours, with immediate deletion on request.
- **Why**:
  - These are the limits users meet at the common free tiers, so a free user can do the same work here.
  - Processing time bounds cost better than a page count. A 1,000-page text PDF is cheap, while one 4K video minute is not.
  - 24-hour retention covers download retries. Immediate deletion serves privacy.
- **Trade-offs**: heavy free use costs compute, bounded by the time and concurrency caps.
- **Alternatives rejected**: page limits, which are arbitrary for cost and annoying for users.
- **Verified by**: the quota tests; #693 adds the file-size and retention tests.
- **Revisit when**: cost per free conversion exceeds the budget.

## 17. Parity gate: quality and speed against reference tools

- **Status**: Implemented (#639, #700, #704, #723, #724).
- **Decision**: every conversion change must keep its quality rows at or above the reference tools. Speed rows have two checks.
  - **Base comparison**: a change may not make a row slower than the base branch by more than the row's threshold, measured in the same job. The default threshold is 10 % (`AB_DEFAULT_REGRESSION`). A row whose measured noise needs a different threshold has its own entry in `AB_ROW_REGRESSION`; each entry records the measurement that justifies it, and no threshold may exceed the cap.
  - **Reference check**: rows below the reference must have a tracked gap entry and issue.

  Quality rows can never be excused by a gap entry. Gate files are taken from the base branch, so a change cannot weaken its own gate.
- **Why**:
  - "Industry-best quality and speed" needs a measured definition, not a claim.
  - Comparing against the base in the same job removes runner noise.
  - Taking the gate from the base stops a change from judging itself.
- **Trade-offs**:
  - CI time.
  - A change that makes output more correct, and therefore slower, must also be optimised. QA confirmed in #727 that the 10 % rule stays.
- **Alternatives rejected**:
  - **Absolute timing thresholds**: noisy on shared runners.
  - **Allowing quality gaps**: hides regressions.
- **Verified by**: `tests/bench-parity.test.ts` and the CI parity workflow tests.
- **Revisit when**: runner hardware changes enough to need new baselines.

## 18. Public sample sets as evidence

- **Status**: Phase 1 implemented (#734); phase 2 implemented (#733).
- **Decision**:
  - The parity bench measures each family on public test corpora. These are the sets used by codec and converter evaluations:
    - standard photo sets;
    - video and audio test material;
    - mixed compression corpora;
    - PDF and office regression sets, open camera files, SVG rendering tests, CAD drawings, fonts, ebooks and open datasets.
  - Each family has at least 10 samples across content classes.
  - Results are reported per sample and per class. A pull request runs a fixed quick subset; the nightly run covers everything.
  - **All twelve families use one sample system:** one manifest of pinned files (address, size, SHA-256, licence, content class), one fetcher that follows only redirects the publisher's set allows and reads no more than the pinned size, one class-row pool, one quick list, one scope switch. A fix to a guard reaches every family. A sample the host does not deliver is skipped as a missing optional tool is in a lenient run and fails a strict one.
  - **Speed gaps of nightly-only rows are tracked in issues, not in the gap file.** The speed job of a pull request times the generated corpus only, so a gap entry for a public sample could never be backed by it. The nightly run reports those rows, and the issue of their family tracks them.
  - **A file the product refuses is a result, not a skipped row.** Every public sample has a `converts` row beside its quality rows. Refusing a valid file puts that sample below the reference, and the other samples are still measured. A file the reference tool cannot convert is stated in the same row.
  - **The truth of a sample is read from the file's own format**, by a reader that is neither our converter nor the reference: the XML of an office package, the text of the binary office formats, the strokes of a drawing, the reference picture shipped with a rendering test, the text of the source book, the text of a dataset or its expected-values file. A converter is never scored against the output of another converter. A sample whose text is too short to tell a conversion from an empty page is kept for its fonts and structure only.
  - **Class results are the mean over the samples of a class**, so one long file does not outweigh a short one. Size ratios are pooled instead. A class row exists only when every sample of the class was measured.
  - **Words are counted the way the script is read.** A word is a run of letters or digits, and every CJK character counts as a word of its own, because those scripts have no spaces and a line break would otherwise split one reference word into two extracted ones.
  - **Office documents are converted by our own readers and writers**, not by the office suite that the product uses when it is installed. Otherwise the suite would be compared with itself.
  - **The quick subset names only cases that are at the reference today.** A case below the reference stays in the nightly run until a fix lands, so a pull request is not blocked by a gap it did not cause.
  - **Very large camera files are measured on the fast targets.** Every RAW file is measured to JPEG and PNG; AVIF and GIF are measured on the four smallest files.
- **Why**:
  - A verdict from one or two samples can flip on the next file. Results per sample and per class stop a good average from hiding a bad class.
  - Mature converters hand office documents to an office suite, ebooks to an ebook toolchain, vector files to a vector renderer and tabular files to a columnar engine. Those tools are the references, and a document that only one side can open is the clearest quality gap there is, so it must show as a row.
  - Reading the truth from the format keeps the verdict independent of both sides.
- **Trade-offs**:
  - Longer nightly runs: the quality half of the nightly parity run grew from about 5 to about 40 minutes.
  - Licences restrict some material to testing. That material is fetched at test time, never committed or published, and pinned by SHA-256.
  - A text read from a format cannot see a word that is drawn only (a scanned page, a vector outline) or a field result a reader would compute. Those samples are scored on structure and fonts.
  - Mean over a class lets a perfect sample hide a failed one inside the class row; the sample rows keep it visible.
  - Measuring only the fast targets of the largest camera files leaves their AVIF and GIF paths to the smaller files.
- **Alternatives rejected**:
  - Small generated samples only, which give too little evidence.
  - Skipping a file the product refuses, which hides the very gap the sample set exists to find.
  - Scoring against the reference tool's own output, which cannot show a case where the reference is wrong.
- **Verified by**: `bench/corpora.ts`, `bench/class-rows.ts`, `bench/corpus/PROVENANCE.md`, `tests/bench-corpora.test.ts`, `tests/bench-public-samples.test.ts`, `tests/bench-public-unified.test.ts` and `tests/bench-public-oracles.test.ts`.
- **Revisit when**: a class is missing from the sets, a licence changes, or the nightly run no longer fits its time budget.

## 19. HTML character encoding

- **Status**: Implemented (#742).
- **Decision**: the encoding of an HTML file is found as the HTML standard's encoding sniffing does it:
  1. a byte order mark (UTF-8 or UTF-16);
  2. a `<meta charset>` or `<meta http-equiv="Content-Type">` declaration in the first 1024 bytes;
  3. UTF-8, when the bytes are valid UTF-8 (a pattern legacy text hardly ever matches);
  4. Windows-1252.

  A declared label that names UTF-16 is read as UTF-8, and a label that is not an encoding, or names an escape-based encoding, is ignored, as the standard says. Bytes that the encoding cannot decode become U+FFFD. The file is never refused for its bytes.
- **Why**: every browser and every office suite opens such a file. Government and archive pages written in the 1990s have no declaration and hold a single curly quote in Windows-1252; refusing them as "not valid UTF-8" was a defect, not a safeguard. Windows-1252 is the default of the standard for the Latin-script locales and decodes every byte.
- **Trade-offs**:
  - An undeclared page in another legacy encoding (Shift_JIS, GBK) is read as Windows-1252 and shows wrong characters, not an error. The page itself did not state its encoding, and a statistical detector would be a guess with its own failures.
  - No warning marks the guess. The bytes are valid in the encoding chosen, so no character is replaced.
  - Plain text and Markdown keep their strict rule (UTF-8, or UTF-16 with a byte order mark): they have no way to declare an encoding, so the user is told to save as UTF-8.
- **Alternatives rejected**:
  - **Refusing non-UTF-8 HTML** (the previous behaviour).
  - **A statistical detector for every encoding**: a new dependency for a guess that the standard leaves to the implementation, and wrong on short pages.
  - **Always Windows-1252**: breaks the UTF-8 pages that declare nothing.
- **Verified by**: `tests/html-encoding-sniffing.test.ts` (the legacy bytes come from an independent encoder) and the public row `doc-gov-000824.html`.
- **Revisit when**: users report undeclared East Asian pages, which would justify a detector for them.

## 20. Damaged office files

- **Status**: Implemented (#742).
- **Decision**: a document that is damaged in a way mature readers read through is read through, and what was read is reported when it matters.
  - **RTF control-word parameters** beyond the 32-bit range are clamped to its largest value. A writer in the wild emits a 19-digit character expansion. No parameter of that size has a meaning that a clamp changes (a clamped `\bin` length still fails when it runs past the end of the file).
  - **RTF groups that close early**: when the document group closes before the end of the file and RTF content (a group or a control word) follows, the reader keeps reading and one warning says so. Other trailing data is still refused.
  - **XLSX coordinates past the sheet limits**: a row number above 1048576, a cell reference or column range past column XFD (16384) is refused with a typed error naming the sheet. The limits are those of the format (ECMA-376) and of every spreadsheet application. A fuzzer-made workbook with the row number 231999999999940 took the reader to its heap limit before this rule.
  - **XLSX sparse sheets**: the reader builds one workbook with at most 20 million cells and rows, the empty cells that pad a cell out to its column and the empty rows that pad a row out to its row number included. A workbook past it is refused with a payload-limit error (413) that says the padding is counted. The 20 million is the cap the Parquet reader and writer already apply to a table, so one number bounds every tabular reader. The count covers all sheets of the workbook together, because they stay in memory together.
- **Why**: users convert the files they have, and the reference office suite opens them. Refusing the document for one parameter loses all of it. For the early close, the suite stops at the stray brace and drops the rest of the text; keeping the rest loses nothing the file holds.
  - **Sparse sheets** are the case the format bounds do not cover: a cell at column XFD on each of 2000 rows is a workbook of 11 KB, and the reader padded it to 33 million cells, 1.7 GB of heap. Padded cells hold nothing, but they are the grid every target is written from, and a part of a few kilobytes must not decide the heap of a worker. Counting what the reader builds, not what the file declares, bounds the memory whatever shape the coordinates take.
- **Trade-offs**:
  - A document with a structural error is read with the same trust as a clean one. The warning is the only mark.
  - Reading past an early close can show content the suite hides. The file contains it, and the warning says where the structure broke.
  - A legitimate sheet with more than 20 million cells and rows, padding included, is refused. A sheet that fills 1220 rows to column XFD is inside the budget; one that fills 1221 rows is not. A workbook that reaches the budget with real values needs about 57 bytes of heap per padded cell and more per filled cell (measured at the budget: a sheet of 1219 rows with a cell at XFD, 1.17 GB), so the cap is also the largest workbook the worker is allowed to build in one conversion.
- **Alternatives rejected**:
  - **Refusing the document**, which made the user's file unusable for one bad number.
  - **Stopping at the early close** as the reference does: the output would lose half of the text without a trace.
  - **Reading sparse sheets without padding** (a map of cells in place of rows of arrays): the converters read a sheet as rows of arrays, so it would move the cost to every one of them and change what each of them reads.
  - **A limit per sheet**: many small-XML sheets, each just inside the budget, add up to any heap size.
  - **A limit on the file size alone**: the example above is 11 KB.
- **Verified by**: `tests/rtf-text-extraction.test.ts` (including the office suite as the oracle of what a clamped parameter reads as) the public row `doc-lo-footnotes.rtf`, and `tests/xlsx-sheet-limits.test.ts` (the last row and column are read, the next ones refused; a workbook of 1320 rows with a cell at XFD is refused before it is built while 100 such rows and 10 filled rows of 16384 cells are read; twenty sheets that end on the last row are counted together) with the corpus workbook `clusterfuzz-testcase-minimized-POIXSSFFuzzer-5937385319563264`.
- **Revisit when**: a damaged file reads wrongly after a clamp, or QA decides that structural errors must fail; a user reports a real sheet refused for its padding; or the worker memory share changes (the cap follows it).

## 21. Charts, notes and sheets in PDF

- **Status**: Implemented (#742).
- **Decision**: the in-process PDF writers draw all the text a document shows.
  - **Charts** (OOXML charts of documents, workbooks and slides; charts embedded in 97-2003 presentations, whether stored as an Excel chart or as an OpenDocument chart) are drawn with their title, axis titles, category names, series names and a labelled value axis. A pie lists the name of each slice beside its colour. A chart in a workbook is drawn below its sheet. A chart that cannot be read is reported as a warning and the rest of the slide is kept.
  - **Notes**: a note mark is drawn smaller and raised, and the notes of a block are set as a list that hangs each mark beside its text.
  - **Sheets**: every worksheet of a 97-2003 workbook is its own table with its name, a column is never narrower than its longest word (up to a page-wide column), and a table wider than a page continues in further column groups.
  - **Prose after tables and drawings** starts at the margin.
- **Why**: text a document shows but the PDF omits is lost content, and the users compare the PDF with the one the office suite makes. A word cut in two by a narrow column cannot be searched or copied. Worksheets laid over each other lost the text of all but the last.
- **Trade-offs**:
  - A column group repeats the header rows and makes a wide sheet longer than one squeezed onto a page. Squeezing cut words.
  - The chart drawing is a plain vector rendering, not a copy of the application's look.
  - The text targets of 97-2003 workbooks still lay the worksheets over each other (a sheet-aware text output needs a product decision on the sheet separators; the OOXML workbook already names its sheets).
- **Alternatives rejected**:
  - **A data table in place of the chart**: it shows numbers, not the chart the file holds.
  - **Squeezing columns until the table fits a page**: the previous behaviour, which cut words.
- **Verified by**: `tests/office-chart-text.test.ts`, `tests/biff-chart.test.ts`, `tests/xls-multi-sheet-pdf.test.ts`, `tests/pdf-table-word-breaks.test.ts`, `tests/docx-pdf-layout.test.ts`, and the public document rows of #742.
- **Revisit when**: the chart drawing needs the look of the application's charts, or the text targets of workbooks are made sheet-aware.

## 22. Image metadata and alpha

- **Status**: Implemented (#749, issue #736), decided 2026-10-11.
- **Decision**:
  - **Metadata blocks**: a JPEG, WebP or AVIF carries the EXIF block, the XMP packet and the ICC profile of its source unchanged. The profile is attached and the pixels are not converted through it. No block is made up.
  - **sRGB-gamut profiles**: a profile with sRGB primaries (whether IEC 61966-2-1 sRGB or a development curve over sRGB primaries such as a camera RAW decoder's gamma 2.222 curve) is not written. A development curve goes through the profile into standard sRGB; a profile that describes sRGB itself changes no pixel (the samples are read as they are, #641); wider-gamut and grey profiles stay attached.
  - **Print density**: a JPEG keeps it (in its header, together with an EXIF block made from it when the source has none); WebP and AVIF do not.
  - **Alpha**: the alpha plane of an AVIF is encoded at the colour quality. There is no separate alpha setting.
  - **16 to 8 bits**: a 16-bit picture written as JPEG or WebP is reduced to the nearest 8-bit level, not to the high byte.
  - PNG, TIFF and the other targets keep their earlier handling (the profile applied to the pixels).
- **Why**: all four follow what the leading converter does by default, so a user who compares the files finds the same information and the same colours, at the same size. Checked in the converter's source and on its output, not assumed:
  - Its AVIF writer sets one quality and hands the picture to the AV1 library with an alpha channel; the library encodes the alpha plane at that quality unless an alpha quality is set, and the writer sets none. Lossless alpha is what the standalone AV1 image encoder does when only a colour quality is given, which is why that tool is not the reference for alpha.
  - Its writers attach the profile as it is, add the EXIF and XMP blocks it read, and write nothing else. Its PNG reader rejects the usual 3 kB sRGB profile as "known incorrect", so for the pictures of cameras and editors it writes no profile at all; any other profile (a grey gamma profile, Display P3) is kept.
  - Its JPEG writer scales 16-bit samples with rounding.
  - Keeping a wide-gamut profile attached is exact: converting it into the pixels at encode time loses gamut where the target is narrower and cannot be undone, and a viewer applies the profile anyway. Not making blocks up keeps small files small: the library's switch for "keep metadata" writes an EXIF block of about 190 bytes for a source that has none, 2 % of a small WebP or AVIF, and was the whole 2.4 to 4.2 % gap of a screenshot with a print density.
- **Trade-offs**:
  - A profile that is not sRGB makes a file larger by the profile (4.5 kB for the grey profile of the radiograph) where the earlier policy baked it in. That is the cost of exact colours, paid by the pictures that need it.
  - Dropping an sRGB profile changes no colour a viewer shows, but a reader that treats an untagged file as another colour space will see it differently; the web formats and every browser assume sRGB.
  - Alpha at the colour quality moves the edge pixels of flat graphics: at quality 70 a flat chart reads 57 dB on the flattened picture, where lossless alpha gives an exact picture at 2.5 times the bytes (51.2 kB against 20.0 kB). The service does the former, so the files stay comparable.
  - Rounding is the image library's scaling step in front of its high-byte cast. Placed between the two colour transforms the library runs for a picture with an sRGB profile (through a wide-gamut working space and back), it cost the 16-bit space photograph 31 ms against 23 ms before the step; with the profile read as it is (#641) it takes 18 ms (Linux test machine, medians of 40 runs).
  - A picture with an sRGB profile is read without converting its samples through the profile. For 8-bit samples that transform is the identity on the pictures of the benchmark (0 of 1.7 to 6.8 million samples differ) and costs 3 to 6 ms per read of a 1 to 2 megapixel picture; on noise it moves 0.3 % of the samples by one level. For 16-bit samples it goes through a wide-gamut space and back and moved 3.5 % of the nearest 8-bit levels one level too low.
  - A PNG that holds only text chunks and an sRGB profile is decoded once for JPEG and AVIF like a plain PNG: neither encoder writes text, and the profile is not written.
  - A JPEG with a print density gets an EXIF block it did not have.
- **Alternatives rejected**:
  - **Lossless alpha** (the standalone encoder's default): exact, but 2.5 times the bytes on a flat chart and not what the service writes.
  - **Converting every profile into the pixels and writing none** (the earlier policy): smaller, but irreversible for wide-gamut pictures, and the pictures differ from the service's.
  - **Keeping every profile, the sRGB one included**: 3 kB more than the service on most photographs.
  - **Dithering the 16 to 8 bit reduction**: adds noise the encoder must code, and loses PSNR and SSIM at the same size.
  - **Keeping the colour transform through an sRGB profile**: an identity for 8-bit samples and an error of one step of 65535 for 16-bit ones, at the cost of two reads' worth of transform time per conversion.
- **Verified by**:
  - `tests/image-metadata-overhead.test.ts` (no block made up; a wide-gamut profile kept byte for byte in JPEG, WebP and AVIF; an sRGB profile not written; XMP kept alone), `tests/icc-srgb.test.ts`, `tests/image-16bit-rounding.test.ts`, `tests/image-16bit-reduction.test.ts` (all 65536 inputs against exact rational arithmetic; a picture with an sRGB profile written as the same file as the one without), and the argument test of `tests/image-avif-library-encoder.test.ts` (alpha quality equals the colour quality).
  - The image parity rows, where the reference receives the same blocks and the colour quality for alpha (`bench/png-metadata.ts`).
- **Revisit when**:
  - A target other than JPEG, WebP and AVIF should follow (PNG and TIFF still apply the profile to the pixels).
  - The service's converter changes how it writes alpha or reads profiles.
  - Users report colour differences in untagged files.

## 23. Embedded SVG images, physical units and child clip paths

- **Status**: Implemented (#746).
- **Decision**:
  - **Embedded SVG images (`<image href="data:image/svg+xml,...">`)**: a `data:image/svg+xml` URI on an `<image>` element is decoded, verified to be an SVG document within the input character limit, recursively sanitized through the SVG sanitizer (with bounded nesting depth), and re-encoded as `data:image/svg+xml;base64,...`. On every other element (`<a>`, `<use>`, `<feImage>`, animation attributes), `data:image/svg+xml` remains neutralized to `href="#"`.
  - **Physical CSS length units (`mm`, `cm`, `in`, `pt`, `pc`, `Q`)**: absolute CSS length units on SVG geometry and presentation attributes are converted to user units at the CSS Values and Units ratio of 96 user units per inch before raster or PDF rendering, independent of the rasterization density (such as 72 or 300 dpi).
  - **Child `clip-path` inside `<clipPath>`**: a `<clipPath>` whose child shapes carry their own `clip-path="url(#...)"` attributes (and is not itself referenced inside another `<clipPath>`) is lowered into a white luminance `<mask>` before rendering so the rasterizer composites the union of the clipped children.
- **Why**:
  - Neutralizing `data:image/svg+xml` on `<image>` dropped embedded vector sub-drawings completely, whereas sanitizing the decoded inner SVG through the same sanitizer strips scripts, event handlers, and external references while preserving safe geometry.
  - Setting the native SVG renderer's DPI to 72 or 300 caused it to scale `mm`/`cm`/`in`/`pt`/`pc` attributes inside `viewBox` user space at 72 or 300 user units per inch instead of the CSS standard 96 user units per inch.
  - The native SVG renderer's clipping path builder cannot form the union of multiple child shapes inside `<clipPath>` when those children carry their own `clip-path`; lowering the outer `<clipPath>` to a luminance `<mask>` preserves the union.
- **Trade-offs**:
  - Recursive sanitization decodes and re-encodes embedded SVG `data:` URIs on `<image>` elements.
  - Lowering a `<clipPath>` with clipped children into a luminance `<mask>` computes an alpha mask rather than a vector clip outline in PDF rasterization.
- **Alternatives rejected**:
  - **Allowing unsanitized `data:image/svg+xml` on `<image>`**: would allow script or external-reference payloads inside the embedded SVG.
  - **Neutralizing all `data:image/svg+xml` URIs on `<image>`**: broke drawings that embed vector icons or sub-diagrams via `<image>`.
- **Verified by**: `tests/svg-rendering-units-embed-clip.test.ts` and the public vector rows `vec-rect-mm-values.svg`, `vec-image-embedded-svg.svg`, and `vec-clipPath-clip-path-on-children.svg`.
- **Revisit when**: the upstream native SVG renderer fixes union clipping of `<clipPath>` children carrying `clip-path` or decouples CSS physical unit conversion from output rasterization DPI.

## 24. WOFF/WOFF2 font compression and colour bitmap fonts

- **Status**: Implemented (#747).
- **Decision**:
  - **WOFF 1.0 per-table Deflate**: 16-bit index, layout, and variation tables (`VDMX`, `EBLC`, `EBDT`, `gvar`, `HVAR`, `COLR`, `CPAL`, and `GPOS`/`GSUB`/`GDEF`/`loca`/`hmtx` tables of at least 10 KB) are compressed with RFC 1951 3-byte LZ77 matching (`pako.deflate`), while outline and general tables keep native `zlib` default compression to preserve throughput on small fonts.
  - **WOFF2 Brotli quality threshold**: the uncompressed stream size ceiling for Brotli quality 11 (`WOFF2_BROTLI_MAX_QUALITY_BYTES`) is raised from 4 MB to 8 MB so single-script CJK OpenType/CFF fonts (around 4.5 MB) receive quality 11 compression like the reference encoder.
  - **Colour and bitmap-only SFNT fonts**: when converting to TrueType (`.ttf`), an SFNT font that carries bitmap glyph tables (`CBDT`+`CBLC`, `EBDT`+`EBLC`, or `sbix`) without `glyf`/`loca` or `CFF ` outlines is serialized as a TrueType-version SFNT container rather than rejected for missing outlines.
- **Why**:
  - Node.js bundles a zlib fork whose SIMD match finder requires 4-byte minimum LZ77 matches (`MIN_MATCH = 4`), whereas the reference `sfnt2woff` tool links standard `libz` (`MIN_MATCH = 3`), which finds 3-byte matches across 16-bit big-endian offset/value tables and shrinks `GPOS`/`gvar` tables by an additional 5 to 12 %.
  - A 4.5 MB CJK CFF font fell just above the 4 MB threshold and dropped to Brotli quality 9 (`0.81` ratio vs `0.74` at quality 11).
  - Colour emoji fonts (`CBDT`/`CBLC`) have no outline tables by design and must round-trip cleanly between WOFF/WOFF2 and TTF.
- **Trade-offs**:
  - Pure-JS 3-byte LZ77 Deflate on 16-bit layout tables is slightly slower than native C `zlib`, and Brotli quality 11 on 4 to 8 MB CJK fonts takes longer than quality 9, while remaining within the throughput parity budget.
- **Alternatives rejected**:
  - **Native `zlib` level 9 alone for WOFF 1.0**: still leaves 4-byte minimum matching on 16-bit tables and falls short of `sfnt2woff` on `Lato` (`0.520` vs `0.510`), while slowing down outline compression on small fonts.
  - **Synthesizing dummy empty `glyf`/`loca` tables for bitmap-only fonts**: mutates the font's table set and fails byte-exact SFNT table round-trip checks.
- **Verified by**: `tests/font-woff2-encode.test.ts` and the public `font` parity suite (`font-lato-regular.ttf->woff`, `font-notosansjp-regular.otf->woff2`, `font-notocoloremoji-flags.ttf.woff->ttf`, and `font-notocoloremoji-flags.ttf.woff2->ttf`).
- **Revisit when**: Node.js exposes a native 3-byte match option in `node:zlib` or variable CFF2-to-TrueType outline conversion is added.

## 25. 16-bit sRGB tone-curve mapping and RAW development parity

- **Status**: Implemented (#745).
- **Decision**:
  - **16-bit sRGB-primaries tone-curve lookup (`srgb16LutsFromProfile`)**: when a 16-bit image carries a matrix/TRC ICC profile with sRGB colorants whose tone reproduction curve differs from IEC 61966-2-1 sRGB (such as the RAW decoder's gamma 2.222 / 4.5-slope development curve) and is converted to a 16-bit or high-bit-depth target (`png`, `tiff`, `tif`, `avif`, `psd`), its 16-bit samples are extracted without the image library's intermediate Display P3 working-space transform and mapped in place through per-channel 65,536-entry `Uint16Array` lookup tables from the embedded TRC to the IEC 61966-2-1 inverse transfer curve.
  - **8-bit targets with sRGB-primaries development curves**: when converting a 16-bit source carrying a non-sRGB tone curve over sRGB primaries to an 8-bit target (`jpg`, `webp`, `gif`), the pipeline stays in 8-bit sRGB so the native ICC transform applies the tone curve and strips the profile in one pass.
  - **16-bit PNG Paeth filter selection (`PAETH_PENALTY = 1.01`)**: the adaptive scanline filter heuristic for 16-bit photographs lowers the Paeth tie-break penalty from `1.015` to `1.01` so rows where Paeth beats Sub/Up/Average by more than 1 % select Paeth.
- **Why**:
  - Calling `.withIccProfile('srgb').toColourspace('rgb16')` on a 16-bit image in the native image library triggers two `vips_icc_transform` passes: first from the embedded profile into its 16-bit Display P3 working profile (while leaving the source profile attached in memory), and then from that source profile to sRGB a second time, lifting shadow zeros (`0 -> 2826`) and shifting colours by up to 17 dB of PSNR on developed camera RAW files.
  - Applying the exact 65,536-entry TRC-to-IEC-61966-2-1 lookup table directly to the untouched 16-bit samples matches the reference LittleCMS transform within 1 LSB (`~87 dB` PSNR) and preserves black at `0`.
- **Trade-offs**:
  - Building and applying the 65,536-entry `Uint16Array` LUT adds one pass over the 16-bit samples in memory for deep targets (`png`, `tiff`, `avif`, `psd`), while 8-bit targets (`jpg`, `webp`, `gif`) avoid the extra buffer round-trip.
- **Alternatives rejected**:
  - **Passing `-g 2.4 12.92` to the RAW decoder**: the decoder's internal power/toe curve differs from the standard ICC profile transform by up to 9 dB of PSNR on 14-bit camera files.
  - **Calling `.withIccProfile('srgb')` on a `rgb16` pipeline**: triggers the double ICC transform through Display P3 in the native image library.
- **Verified by**: `tests/icc-srgb.test.ts` and the `raw` quality and speed parity suites across Canon, Nikon, Sony, Olympus, Panasonic, Pentax, Fujifilm X-Trans, and DNG samples.
- **Revisit when**: the upstream image library stops routing `rgb16` inputs with an explicit output `icc_transform` through an intermediate Display P3 working profile.

## 26. Tabular data fidelity, Parquet encodings, and columnar fast paths

- **Status**: Implemented (issues #743, #730).
- **Decision**:
  - **Parquet reader coverage**: the in-process Parquet reader decodes `DATA_PAGE` and `DATA_PAGE_V2` headers, `PLAIN`, `RLE_DICTIONARY`/`PLAIN_DICTIONARY`, `RLE`, `BIT_PACKED`, `DELTA_BINARY_PACKED`, `DELTA_LENGTH_BYTE_ARRAY`, `DELTA_BYTE_ARRAY`, and `BYTE_STREAM_SPLIT` encodings, `UNCOMPRESSED`, `SNAPPY`, `GZIP`, `ZSTD`, and `LZ4_RAW` page codecs, and `INT96` (Julian day + nanosecond time of day to ISO-8601 UTC timestamp text) and `FLOAT16` (IEEE 754 binary16) logical/physical types.
  - **Direct columnar and byte-scanning fast paths (`data-fast-paths.ts`)**:
    - `csv`/`tsv`/`tab -> parquet` (`delimitedToParquet`): scans UTF-8 delimited bytes into column spans (`DelimitedByteScanner`) and encodes Parquet pages directly from the input buffer without building intermediate row objects.
    - `parquet -> csv`/`tsv` (`parquetToDelimited`) and `parquet -> json` (`parquetToJson`): `FormattedParquetTable` formats the cells of each page once (a dictionary entry once per distinct value, not once per row) and hands out row windows that end at the next page boundary of any column, so a table is never held as one JavaScript string per cell. Rows are written to `ChunkedOutput` while they are read, preserving BOM defaults, formula escaping, 1-column empty-cell quoting, column order (including integer-named and `"__proto__"` columns) and `-0`. Non-finite doubles are written to CSV as the general route writes them, without a formula guard.
    - `jsonl`/`ndjson -> csv`/`tsv` (`jsonLinesToDelimited`): scans flat UTF-8 JSON object lines directly into delimited rows, written in 32-row batches to `ChunkedOutput`, while preserving exact integer literals up to 4,096 digits, standard JSON escapes, and omitted or reordered keys, declining (`null`) to the general lossless parser whenever nested containers, `\uXXXX` escapes, new keys after the first record, or syntax/encoding errors require full AST handling.
    - **Memory**: input and output are buffers outside the V8 heap. The heap holds one decoded page per column (Parquet) or one 32-row batch (JSON Lines). `ChunkedOutput` collects output in chunks of up to 4 MiB and joins them once, and fails with `DataLimitExceededError` when the table would exceed one buffer (about 2 GiB). A 190 MB JSON Lines file and a 12-million-cell Parquet file convert inside a 128 MiB heap (`tests/data-columnar-memory.test.ts`). Parquet input stays bound by the reader's existing caps (1 GiB decompressed, 512 MiB of decoded text, 20 million cells).
  - **Parquet writer adaptive compression**: when the caller does not specify a compression codec, the general and direct delimited-byte Parquet writers use `SNAPPY` by default, switching individual non-dictionary `BYTE_ARRAY` columns whose values are predominantly numeric digits and punctuation (`0-9`, `.`, `-`, `+`, `,`) to `GZIP` when the raw column byte budget is at least 128 KB or the table has at least 32 columns.
  - **JSON and YAML key order**: the lossless JSON reader records the source key order of every object whose keys include non-negative integer indices (`"0"`, `"1970"`, etc.) in a side table, and JSON, YAML, TOML, HTML, and tabular flattening iterate keys in that recorded source order instead of ECMAScript's ascending array-index order.
  - **CSV and TSV formula escaping**: a cell beginning with `=`, `@`, `\t`, or `\r` is always prefixed with `'`; a cell beginning with `+` or `-` is prefixed with `'` only when it is a single-line non-prose expression that is neither a plain number (`-5`, `+1.5e3`) nor a thousands-grouped number (`-566,000`).
- **Why**:
  - Columnar engines emit `DATA_PAGE_V2`, delta encodings, `BYTE_STREAM_SPLIT`, `LZ4_RAW`, `INT96`, and `FLOAT16` in standard datasets; refusing them leaves common analytical files unreadable.
  - Materializing intermediate JS objects and `Map` cells for every row (`parseDelimitedRecords` -> `tabulate` -> `encodeParquet` / `writeDelimited` / `stringifyJsonLossless`) dominated CPU and GC time on multi-thousand-row tables. Operating on page-sized column windows and UTF-8 byte spans eliminates per-row object and `Map` allocations while producing the same cells as the general route; windows also bound the memory a large table needs, because Parquet pages of different columns end at different rows and a whole row group can be too large to hold decoded.
  - CSV inputs store numeric columns as `BYTE_ARRAY` text unless schema inference is requested. On dense decimal text or wide numeric tables, byte-aligned `SNAPPY` cannot exploit sub-byte digit entropy, whereas `GZIP`'s Huffman coding shrinks those pages past the reference columnar writer's size while keeping `SNAPPY` speed on general text.
  - V8 reorders non-negative integer property keys ahead of string keys on ordinary JS objects, which scrambled year-keyed columns (`"1976"`..`"2099"`) when flattening nested JSON to CSV or Parquet.
  - Prefixing `'` to negative thousands-grouped numbers (`"-566,000"`) or multi-line prose starting with `"- "` corrupts legitimate data values that no spreadsheet evaluates as a formula.
- **Trade-offs**:
  - Maintaining direct columnar/byte fast paths alongside the general structured-data pipeline adds specialized serializers for the four hot tabular pairs, mitigated by strict decline-to-general fallback (`return null`) on any non-flat or malformed input and byte-exact equivalence tests against the general route.
  - Compressing wide or large non-dictionary numeric-text `BYTE_ARRAY` columns with `GZIP` trades a small CPU cost on those columns for 35 to 45 % smaller Parquet output.
  - Recording key order in a `WeakMap` adds a small per-object array only when an object mixes or reorders array-index keys.
- **Alternatives rejected**:
  - **Coercing CSV numeric strings to `DOUBLE` or `INT64` in the Parquet writer**: loses formatting fidelity (leading zeros, trailing decimals) and diverges from string-preserving tabular conversion.
  - **Using `ZSTD` or `GZIP` unconditionally for all Parquet columns**: slows down general text and dictionary-encoded columns where `SNAPPY` already meets size parity.
  - **Disabling `+`/`-` formula escaping altogether**: would leave single-token spreadsheet formulas such as `-2+3` or `+A1` unescaped.
- **Verified by**: `tests/parquet-writer-conformance.test.ts`, `tests/parquet-logical-types.test.ts`, `tests/parquet-codec.test.ts`, `tests/data-csv-encoding.test.ts`, `tests/data-json-yaml-lossless.test.ts`, `tests/data-columnar-fast-paths.test.ts`, `tests/data-columnar-memory.test.ts`, `tests/chunked-output.test.ts`, and the `data` quality and speed parity suites.
- **Revisit when**: callers gain an explicit schema-inference option for CSV-to-Parquet, or spreadsheet formula rules are configured per target dialect.

## 27. Ebook FB2/MathML text fidelity and PDF compression structural repair

- **Status**: Implemented (issue #748).
- **Decision**:
  - **FB2 bare ampersands and HTML-style inline/list elements**: the FB2 reader escapes bare `&` characters that do not begin a valid XML entity reference (`&name;`, `&#digits;`, `&#xhex;`) before XML parsing, and recognizes HTML-style list (`<ul>`, `<ol>`, `<li>`), line-break (`<br>`), and inline emphasis (`<b>`, `<i>`, `<u>`, `<s>`) elements alongside standard FictionBook 2.0 tags.
  - **Inline and block MathML in HTML/EPUB**: `<math>` elements in HTML and EPUB content documents are no longer dropped; their text content is preserved in document order, and blocks dominated by single-character tokens (such as tokenized equations and matrices) emit wider inter-token spacing in PDF output so PDF text extractors do not merge adjacent single-character tokens into one word.
  - **PDF compression tolerance and structural repair**: the PDF recompression pass runs without `-dPDFSTOPONERROR` so non-fatal annotation or syntax warnings in otherwise valid pages do not abort compression before page-count verification; when a lossless stream/object-stream rewrite produces a file no smaller than the input, `compressPdf` checks the input with the structural PDF checker and, if the input has cross-reference or stream warnings, returns the smaller of the repaired rewrite and a lossless object-stream recompression instead of returning the damaged input bytes unchanged.
- **Why**:
  - Real-world FB2 files generated by desktop converters frequently embed unescaped `&` in query-string URLs (`href="...&st=..."`) and HTML `<ul>`/`<li>`/`<br>` markup inside `<section>`; strict entity scanning without bare-`&` escaping swallows the remainder of the document until EOF.
  - Dropping `<math>` stripped every formula and matrix from mathematical EPUB textbooks (reducing word F1 to `0.77`), and narrow single spaces between 1-character equation tokens fell below standard PDF text extractors' letter-spaced-word coalescing threshold (`~0.35 em`).
  - Public PDFs with damaged cross-reference tables or non-standard PDF/UA annotation dictionaries either aborted the PDF rewriter under `-dPDFSTOPONERROR` or were returned un-repaired when structural cross-reference repair added a few hundred bytes to the cross-reference stream.
- **Trade-offs**:
  - Running the structural check when a lossless rewrite does not shrink the input adds one fast validation pass only on already-compact PDFs, preserving idempotency on clean inputs while repairing damaged inputs.
  - Widening spaces in single-character-heavy blocks slightly increases horizontal advance on equation lines in exchange for exact token recovery by PDF text extractors.
- **Alternatives rejected**:
  - **Global `wordSpacing` (`Tw`) in the PDF text writer**: alters line-wrapping state across multi-run lines and tight spreadsheet cells.
  - **Always returning the rewritten PDF even when larger on clean inputs**: breaks idempotency when compressing an already-compressed clean PDF a second time.
- **Verified by**: `tests/fb2-book-structure.test.ts`, `tests/pdf-compress.test.ts`, and the public `ebook` and `pdf-ops` parity suites (`book-help-ru.fb2`, `book-linear-algebra.epub->pdf`, `pdf-gov-000012.pdf->compress`, `pdf-gov-001071.pdf->compress`, `pdf-gov-003966.pdf->compress`, and `pdf-vera-ua1-annotations.pdf->compress`).
- **Revisit when**: a dedicated MathML layout engine is added to the in-process PDF writer.

## 28. Zstandard level 3 match finder and literal cost floor

- **Status**: Implemented (issue #737).
- **Decision**:
  - **Level 3 match-finder parameters**: the default Zstandard encoder level (`level = 3`) uses `windowLog = 20`, `hashLog = 18`, `chainLog = 18`, `searchDepth = 6`, `minMatch = 5`, `niceLength = 24`, `lazyDepth = 1`, `lazyLength = 8`, `skipStrength = 7`, `insertMatchInterior = true`, and `interiorInsertCap = 4`. Levels 4 to 6 scale `searchDepth` (10, 12, 14), `hashLog` (18), and `chainLog` (18, 18, 19) monotonically from level 3.
  - **Five-byte hash (`minMatch = 5`)**: the chain is keyed on five bytes, so a four-byte match is taken only as a repeat-offset match. The level 4 and higher chains keep the four-byte hash.
  - **Lazy length cap (`lazyLength`)**: a match of at least `lazyLength` bytes is emitted without probing the next position for a better one; a shorter match is still compared against the match starting one byte later, with the chain floor `len - 1` so that candidates that cannot beat the current match are rejected on one byte. It defaults to `niceLength`, which leaves every other level unchanged.
  - **Interior insertion cap**: with `interiorInsertCap = 4`, a match longer than 8 bytes inserts only its first and last 4 positions into the chains.
  - **Post-LZ77 literal cost floor (`LITERAL_BITS_MIN = 6.5`)**: the match finder clamps its per-block literal bit-cost estimate to at least `6.5` bits per byte when scoring short matches against the sequence overhead (`MATCH_OVERHEAD_BITS + OFFSET_SYMBOL_BITS + highBit32(offset + 1)`).
- **Why**:
  - Whole-block order-0 Shannon entropy underestimates the cost of the unmatched literals that remain after LZ77 removes repetitive runs. On zero-padded binary slices such as 3D medical volumes (where 50 to 65 % of each 128 KB block is `0x00`), raw block entropy drops to 2.3 to 2.6 bits per byte while the non-zero tissue bytes left in the Huffman literals stream cost 5.4 to 5.6 bits per literal; on natural-language prose, raw block entropy is 4.5 to 4.8 bits per byte while post-LZ77 literal residuals cost 5.3 to 5.4 bits per literal. With `LITERAL_BITS_MIN = 1`, the scorer rejected every four-byte match at `offset >= 63` in prose and every four- to eight-byte cross-slice match in zero-padded medical volumes.
  - The reference level 3 strategy (double-hash fast matcher) also hashes five bytes. A four-byte chain fills with positions that share only their first four bytes, so each probe is mostly a collision or a match too short to pay for its offset; a five-byte chain spends the same probes on candidates that can win. Measured on the public set, five-byte hashing improved the ratio of the medical, prose, and source samples by 1 to 3 points at the same speed, which is what allowed `searchDepth` to fall from 8 to 6.
  - Raising `chainLog` from 16 (64 KiB chain reach) to 18 (256 KiB chain reach) prevents the 64 KiB dense job history from overwriting all chain links into the sparse window and brings prose, source code, XML, and chemical database recurrences between 64 KiB and 256 KiB into chain reach.
  - Enabling 1-step lazy matching (`lazyDepth = 1`) avoids taking a short match at `p` when `p + 1` starts a longer one. The first version of this change also probed the next position for matches up to 32 bytes and inserted every position of matches up to 32 bytes, which made the mixed benchmark input 19 % slower than the previous level 3 (speed gate: no more than 15 % slower than the base). Matches of 8 or more bytes are rarely beaten by a match one byte later, and the middle of a short match is mostly redundant with positions already in the chain, so `lazyLength` and `interiorInsertCap` remove that work.
- **Trade-offs**:
  - `hashLog = 18` and `chainLog = 18` allocate 1 MiB for `head` and 1 MiB for `chain` per worker thread (up from 512 KiB and 256 KiB), reused across blocks and jobs inside each worker.
  - A four-byte match at a medium offset is no longer found by the chain at level 3, and a long match is less often replaced by a better one that starts a byte later; both cost ratio against a higher-effort setting (the mixed benchmark input is 1.9 % smaller than the reference and the Silesia `nci` sample 2.3 % smaller, against 3.7 % and 7.7 % for the intermediate setting), but every sample and class stays below the reference level 3 size.
  - The speed measured on the mixed benchmark input is within 5 % of the previous level 3 (the gate allows 15 %), because the lazy lookahead, the larger tables and the deeper search all cost time that the cheaper insertion only partly returns.
- **Alternatives rejected**:
  - **Keeping the four-byte hash with `searchDepth = 8`, `niceLength = 24`, `lazyLength = 12`**: the same speed range but 1 to 3 points less ratio on the medical, prose, and Polish text samples, with the `mr` sample only 0.4 % below the reference.
  - **Raising `windowLog` above 20 or enabling multi-step lazy matching (`lazyDepth = 2`) at level 3**: increases memory footprint and slows down single-block and multi-worker throughput without needed ratio gains once `LITERAL_BITS_MIN = 6.5`, `minMatch = 5`, and `chainLog = 18` are in place.
  - **Two-pass per-block literal entropy estimation**: requires a trial LZ77 pass over every 128 KB block before scoring matches, nearly doubling parse time.
  - **Hoisting fields and pre-filtering candidates on their first bytes without changing the search**: byte-identical output, and no measurable speed change; the time is spent in cache misses on the hash and chain tables, not in instruction count.
- **Verified by**: `tests/zstd-job-frames.test.ts`, `tests/zstd-engine.test.ts`, `tests/zstd-level-pins.test.ts`, `tests/zstd-hostile-frames.test.ts`, `tests/zstd-throughput.perf.test.ts`, and the `compression` quality and speed parity suites across all 12 Silesia files and all 8 content classes.
- **Revisit when**: a dedicated double-hash fast matcher (separate short-match and long-match tables without a chain array) is introduced for levels 1 to 4.

## 29. DWG input

- **Status**: Implemented (#728).
- **Decision**:
  - A DWG is converted to DXF by `dwg2dxf`, the command-line reader of an open-source DWG library (GPL-3.0-or-later). The program is unmodified, runs as a separate process in the process sandbox (no network, 2 GiB of memory, a file-size limit, the time left of the job at most 120 s, a 4 MiB diagnostics buffer, its own scratch directory removed afterwards), and is never linked into the application. The DXF path then draws SVG, PDF and the raster formats from what it wrote; a DXF target returns that DXF.
  - The release code at the start of the file (`AC1015`, ...) is read before the program starts. R13 (`AC1012`), R14, 2000, 2004, 2007, 2010, 2013 and 2018 (`AC1032`, which every release from 2018 on writes) are converted. R12 and older (`AC1009` and the codes before it), a code newer than `AC1032` and a code nobody released are refused with HTTP 422 that names the release and says to save the drawing as a newer DWG or as a DXF. Bytes that do not start with any DWG code, including a DXF saved under the name `.dwg`, are refused with 400.
  - What the program writes is checked before the DXF path reads it: pairs of an integer group code and a value, no NUL bytes, balanced `SECTION` and `ENDSEC`, an `ENTITIES` section and the `EOF` record last. A program that exits with an error or a signal, writes nothing, writes a file that fails the check, or outruns its limit is a typed error: 422 for the drawing, a typed timeout for the clock, 503 and a retry on another worker when the program is missing. There is no estimate and no fallback to a guess.
  - Proxy entities (objects of an add-on application, which a DWG stores with no drawable geometry) are left out of the drawing and reported in `warnings` with their number.
  - The pinned reader is a snapshot of the 0.14 series (0.14.8601), built from its release archive checked against a SHA-256 (`scripts/install-libredwg.sh`) in the worker image and in CI. It is not the 0.14 release of 2026-06-27, which still has the heap overflow in the R2004 section decompressor that was fixed on 2026-07-01.
  - The licence notice lists the reader as a separate program (`docs/licensing.md`), and the image carries its licence text and the name and digest of the archive it was built from in `/licenses`.
- **Why**:
  - Fidelity and cost: DWG is the common CAD exchange format and no open-source library decodes it as completely as this reader (its decoder reads R13 to R2018, with a few advanced objects of 2010 and later skipped). A DWG decoder of our own would take years and be wrong in ways nobody could check, and licensed decoders are out of scope (11).
  - Safety: the reader is a C program that parses an attacker-controlled file, and its advisories and fuzzing fixes are frequent (a heap overflow in the R2004 decompressor, a non-terminating loop in the R13 to 2000 decoder, an unbounded allocation in the pre-R13 entity decoder). A separate sandboxed process with limits turns each of them into a refused job instead of a hung or compromised worker, and the output check keeps a half-written file from reaching the DXF reader.
  - R13 as the lower bound: the reader prints that its output for R9 to R11 is experimental, the advisory about the unbounded allocation concerns exactly the pre-R13 decoder and had no fixed release when this was decided, and no pre-R13 drawing of the pinned sample sets has a truth that is not the reader's own. Refusing them with the way out is better than a drawing that may be wrong. The lower bounds that commercial converters publish range from R12 to R14, and an unsupported release is a stated limit of theirs too (an error that names the supported releases), not a silent failure.
  - Release by release, not one sample: the same entities saved by the drawing program as six releases give the same coordinates through the reader, so the check does not rest on one release's layout.
- **Trade-offs**:
  - R12 and older drawings are refused although the reader can decode them; some commercial converters accept R12.
  - The reader skips some advanced objects of R2010 and later (and keeps the proxies above as stubs), and the DXF path draws what it knows (lines, arcs, circles, ellipses, splines, polylines, text, blocks, dimensions); the rest is absent from the output, with a warning only for proxies.
  - External references are not resolved: the referenced file is not part of the request, so what it draws is absent from the output.
  - A statically linked build of the reader is part of every worker image and CI run (about a minute and a half to build on four cores, cached by the hash of the install script).
  - The DXF a DWG becomes is the reader's, so a defect of the reader (a wrong colour index, a text style) reaches the output. The parity rows judge the drawing step against the DXF the reader wrote and cannot see such a defect; the AutoCAD property dumps of the single-entity drawings do.
- **Alternatives rejected**:
  - **A DWG decoder in this project**: the format is only documented by a reverse-engineered specification, and the reader already has years of fuzzing behind it.
  - **A paid DWG library or service**: out of scope (11).
  - **The 0.14 release itself or the 0.13 series**: both carry the R2004 decompressor overflow.
  - **Distribution packages**: Debian ships no package of the reader.
  - **Linking the library into the application**: it would bring the GPL to the application and put a memory-unsafe parser in the process that serves requests.
  - **Accepting every release code and letting the reader decide**: its refusal of an old file is a crash or a hang, not a message, and the unbounded allocation would cost a worker its memory.
- **Verified by**: `tests/cad-dwg-version.test.ts` (the release table of the Open Design Specification for .dwg files, written out in the test), `tests/cad-dwg-reader.test.ts` (a line, an arc and a circle saved as six releases against the values of the drawing program's own property dump read by an independent DXF library; the ink score of SVG, PDF and PNG output; refusals before the program starts; stand-in programs for every way the program can fail; proxy warnings), `tests/cad-dwg-fuzz.test.ts` (truncated, bit-flipped and zero-filled copies of three real drawings are converted or refused with a typed error inside the limit), `tests/cad-dwg-routes.test.ts` (the 422 and 400 answers of the routes), and the DWG rows of the CAD parity family.
- **Revisit when**: a licensed pre-R13 drawing with an independent truth exists and the reader fixes its pre-R13 decoder (accept R11 and R12); the reader publishes a release after 0.14 with the fixes of the pinned snapshot (pin it); a release newer than `AC1032` appears (accept its code once the reader decodes it); or users report drawings where proxy entities or external references are the content.

## 30. Archive repacking in process: deflate engine, size bound and fail-over

- **Status**: Implemented (issue #685).
- **Decision**:
  - **tar to ZIP and tar to gzip are packed in process** from the vetted tar when the file data is at most 4 MiB (`IN_PROCESS_DEFLATE_MAX_BYTES`). Above 4 MiB, and for a gzip target of a tar that holds more than one regular file or any folder, the request goes to the 7-Zip pipeline exactly as before.
  - **Deflate engine**: the platform zlib, in blocks of 256 KiB that are compressed at the same time by the thread pool. Each block after the first starts with the last 32 KiB of the data before it as a preset dictionary and each block but the last ends with a sync flush, so the pieces join as plain bytes into one RFC 1951 stream and matches still reach across the cuts. The layout depends on the length alone, never on the number of cores, so the bytes are the same on every machine. The CRC-32 is taken once over the whole entry with zlib's native routine (0.09 ms for 0.9 MB), so no checksum combination is needed.
  - **Level mapping**: the product's `compressionLevel` (0 to 9; default 6) was 7-Zip's `-mx`. Level 0 stores; levels 1 to 4 are zlib levels 1 to 4 (their sizes match 7-Zip's fast parser); levels 5 and 6 are zlib level 8 (322 913 bytes against 7-Zip's optimal parser at 321 978 on the benchmark input); levels 7 to 9 are zlib level 9. The default therefore writes less than `zip -6` and `gzip -6`, not the same size.
  - **ZIP to tar, stored RAR 4.x to tar and gzip to tar are read in process.** The ZIP reader (central directory checked against every local header, entries inflated at their declared size, CRC-32 checked), the stored-RAR reader (header CRC-16, entry CRC-32, plain ASCII names, no volumes, encryption or compression) and the gzip decoder (output bounded by `maxOutputLength`) hand their entries to the same extraction policy as the general pipeline (names, links, entry count, size and ratio caps, collisions) before a tar is written from the vetted entries. Modes and modification times the source recorded are carried into the tar.
  - **The ZIP and RAR readers answer only for what they verify completely.** For an archive that is encrypted, uses a method that is not decoded in process, is damaged, is over a cap, collides under the request's policy, or is a RAR with a compressed entry, extended time fields or a Unicode name, the reader returns nothing and the request goes through the 7-Zip pipeline, which re-reads the archive from the start and raises its own typed errors. These two routes never decide on a refusal. A gzip stream has no such second reader: a damaged or cut stream is an `UnreadableArchiveError` and a bomb the same `UnsafeArchiveError` (`compression-ratio` or `uncompressed-size`) as before.
  - **Target bytes change**: the ZIP and gzip written for a small tar are zlib's deflate, not 7-Zip's. Folders implied by a member's path get an entry, as they did before; the gzip header names the member (ASCII names only) and carries its modification time.
- **Why**:
  - The cost of these conversions was never the extraction or the process starts. Measured per step on the Linux VM (4 vCPU, 903 KB input), tar to ZIP took 57.7 ms: `7z l` 1.1 ms, `7z x` 1.6 ms, `7z a -tzip -mx=6` 47.1 ms, against 13.2 ms for `zip -6`. 7-Zip's optimal-parsing deflate alone took 3.6 times as long as `zip -6`; zlib deflates the same input in 8 ms at level 6, 17.6 ms at level 8, and 4.9 ms at level 8 in four blocks.
  - The size is held against the reference tool at its default level, which is what the parity gate measures: 323 235 bytes in blocks at the default level against 332 658 for `zip -6` and 332 560 for `gzip -6` (2.8 % smaller), and 0.4 % above the previous 7-Zip output (inside the 1 % allowance of the gate's own baseline). A single call at zlib level 6 wrote 331 078 bytes, 2.9 % above the baseline, which the parity run reports as a regression of the row's own baseline.
  - ZIP, RAR and gzip reads take 0.3 to 2.5 ms in process against 4.5 to 7 ms for the reference extractor, whose cost is its process start.
- **Trade-offs**:
  - **Ratio on binary data**: zlib hashes four bytes (CRC-32C), so it misses three-byte matches. On binary data it is up to 2.2 % larger than `gzip -6` (measured on `table.parquet` 87 KB and `book.fb2` 59 KB of the benchmark corpus: +2.2 % and +2.0 %, at every level), and 1.8 to 3.6 % larger on four of the fourteen Silesia files (5 to 51 MB; all above the bound, so those requests are still written by 7-Zip). That is the reason for the bound, and the reason it is not raised.
  - **CPU**: the default level costs about twice the CPU time of zlib level 6 (17.6 ms against 9 ms for the benchmark input), spread over up to four pool threads, and a quarter of what 7-Zip's encoder took (47 ms). Under concurrent load the pool is shared, so the saving in latency shrinks; the saving in CPU does not.
  - **Memory**: ZIP, RAR and gzip sources are held in memory with their entries (bounded by `MAX_IN_MEMORY_BYTES` and the archive caps, as the 7z and xz routes already are). They no longer run under the child process's resource limits; inflation is capped at the size each entry declares and the stream's total at the archive caps while it is produced.
  - **Behaviour at the edges**: a gzip stream followed by bytes that are not a gzip member is refused (gzip -d accepts it with a warning); a stored RAR with extended time fields, Unicode names or any compressed entry is read by 7-Zip as before.
- **Alternatives rejected**:
  - **zlib level 6 in one call**: 9 ms and 331 078 bytes, but 2.9 % above the previous output and 8 % larger on JSON lines (level 8 is 8 % smaller than level 6 there).
  - **zlib level 8 or 9 in one call**: 17.6 ms; the speed row falls to 0.75.
  - **7-Zip with fast deflate parameters** (`-mx=5 -mpass=1 -mfb=16`: 333 623 bytes at 28 ms; `-mx=4`: 340 868 bytes at 9 ms): either too slow or larger than the reference.
  - **libdeflate**: 5.8 ms and 324 638 bytes at level 6 (measured with the command-line tool, process start included), 0.65 % smaller than `gzip -6` on the binary Silesia sample where zlib is 3.6 % larger. It would remove both the bound and the ratio gap, but needs a WebAssembly build of a C library that the repository does not carry; recorded as the follow-up.
  - **A smaller bzip2 block for parallelism** on the tar to tar.bz2 row: 7-Zip's bzip2 is single-threaded for the two blocks a 0.9 MB input makes (73.5 ms against 51.7 ms for `bzip2 -9`, pipes or files alike); blocks of 300 or 450 KB run in parallel but write up to 11 % more than `bzip2 -9` on text. The in-repo encoder takes 115 to 150 ms. The row stays a tracked gap.
- **Verified by**: `tests/deflate-blocks.test.ts`, `tests/archive-inprocess-repack.test.ts` and `tests/archive-inprocess-unpack.test.ts` (outputs read back by `unzip -t`, `zipinfo`, `7z t`, `gzip -t`, `gzip -N`, `tar` and `unrar`; entry-by-entry SHA-256, modes and times; sizes against `zip -6` and `gzip -6`; no 7-Zip call; traversal, link, collision, entry-count, size, ratio, CRC and encryption refusals), `tests/archive-stream-to-tar.test.ts`, `tests/archive-native-compression-level.test.ts`, and the `compression` quality and speed parity rows (`mixed.tar->zip`, `mixed.tar->gz`, `mixed.zip->tar`, `mixed.gz->tar`, `mixed.rar->tar`).
- **Revisit when**: a WebAssembly deflate with a three-byte hash (libdeflate, or zlib without the CRC-32C hash) is vendored, which removes the 4 MiB bound; or the stored-only RAR reader is extended to RAR 5 and extended times.

## 31. Starting external programs from a small helper process

- **Status**: Implemented (issue #695).
- **Decision**:
  - The PDF page operations, protection, the edit gate and the decryption for the readers start `qpdf` through a small launcher helper process (`src/lib/security/sandbox-launcher.ts`) instead of from the worker process itself. The helper starts every program through the same sandboxed runner as before, so the sanitized environment, the network namespace, the resource limits, the time limit and the output limit are unchanged.
  - The helper boots in the background on first use. Until it is ready, and whenever it is not worth using, a program is started directly. A helper that dies fails the requests it held with the typed process error, and the next request runs directly while a new helper starts. After a helper that never became ready, programs run directly for 30 seconds before another start is tried.
  - It is used only when the fork it saves costs more than the helper adds: `(resident memory - 112 MiB) * 4.2 ms/GB > output bytes * 2.5 ms/MB`. A small PDF in a worker of 200 MB or more goes through the helper; a large document, or a small process, starts `qpdf` directly.
  - `SANDBOX_LAUNCHER=off` turns the helper off. The `qpdf` command lines, and therefore every output byte, are unchanged: the object streams and stream compression of the output are the ones the reference tool writes with the same options.
- **Why**:
  - Node starts a program with `fork()`, which copies the page tables of the whole worker: on Linux the start costs about 4.2 ms per gigabyte of resident memory, on top of the 2 ms a small PDF tool needs. A worker that holds a few hundred megabytes spends more time starting `qpdf` than `qpdf` spends working. The pdf-ops rows ran the same `qpdf` command lines as the reference, with a wrapper cost of 0.06 to 0.2 ms around them (temporary input, environment, pipes), which was the 7 to 10 percent gap. Starting from a small process removes the fork cost, which is larger than that wrapper cost, and puts ours ahead of the reference on a worker of realistic size.
  - Measured on the 4-core Linux test VM against main, with the parity bench (`--parity --speed-only --family pdf-ops`, five rounds, medians): protect 0.972 to 1.027, decrypt 0.986 to 1.080, unlock 0.978 to 1.019, split 0.931 to 1.034, extract 0.982 to 1.114, delete 0.979 to 1.144, reorder 0.978 to 1.121, rotate 0.989 to 1.091 (ratio of ours to the reference, throughput). Held constant, the helper takes 2.45 ms per small-PDF operation at 110 MB and at 430 MB of worker memory, where a direct start takes 2.44 and 3.82 ms.
  - Where the profile shows no further overhead to remove: a start of `qpdf` takes 1.2 ms of dynamic linking, 0.55 ms of reading and checking a small PDF, 0.2 ms to pack the objects of the output, and for AES-256 2.9 ms (protect) to 3.5 ms (decrypt) of key derivation. All of that runs in `qpdf` and is the same for the reference.
- **Trade-offs**:
  - A request and its reply cross two pipes: about 0.1 to 0.25 ms of wake-ups, and the output is moved once more (up to 2.5 ms per megabyte for outputs of several 64 KB reads). Below a worker size of about 112 MB the helper is no faster than a direct start, and for outputs of several hundred kilobytes it pays only in a large worker, which is why it is chosen per request.
  - The helper ends the programs it started whenever it ends on its own terms: its input closing, a request it cannot read, SIGTERM, SIGINT, SIGHUP, an uncaught error. A kill it cannot handle (SIGKILL, the out-of-memory killer) leaves the programs it had started running, without the time and output limits, until they finish; the worker has the same exposure for programs it starts directly when it is killed. A helper that ends by itself is not replaced for 30 seconds, so a document that could do this cannot make every request start a new one.
  - One more process of about 50 MB per worker while it is used; it ends after 60 seconds without a request, and when the worker ends.
  - The recorder-based argument tests in `tests/pdf-password-argv.test.ts` observe the programs this process starts, so they run with the helper off; `tests/pdf-ops-launcher.test.ts` covers the launched path with `qpdf --check`, `qpdf --json`, `pdfinfo` and `pdftotext`.
  - One more built file, `dist/sandbox-launcher-child.js` (`npm run build:sandbox-launcher`). Without it the source is run through `tsx`, and without either the programs start directly.
- **Alternatives rejected**:
  - **`vfork`/`posix_spawn` from the worker**: Node's child process API does not offer it on Linux.
  - **A different qpdf option set** (no object streams, lower compression level): shaves 0.1 to 0.2 ms but writes 13 percent larger files than the reference, or changes the output.
  - **Incremental update for rotate**: appends to the original file, so the output keeps the unpacked objects of the input and is larger than the reference's; for extract, delete and split it would keep the content of the removed pages in the file.
  - **qpdf compiled to WebAssembly in the worker**: the published builds are command-line wrappers for browsers, add a dependency outside the pinned engine set, and do not remove the cost of reading and writing the document that dominates the run.
  - **Reading the input from a pipe or a file descriptor**: `qpdf` needs a seekable file; the temporary input file costs 0.02 ms.
  - **Always using the helper**: slower than a direct start in a small process and for large outputs.
- **Verified by**: `tests/sandbox-launcher.test.ts` (the program is started by the helper, by the parent process id it reports; results, errors, time and output limits, abort, concurrency, environment sanitizing, strict isolation, a dying helper, the direct path), `tests/sandbox-launcher-protocol.test.ts`, `tests/pdf-ops-launcher.test.ts` (the PDF operations through the helper read back by independent tools, and the guards: the edit gate, page ranges, emptied documents), and the `pdf-ops` parity rows `protect`, `decrypt`, `unlock`, `split`, `extract`, `delete`, `reorder` and `rotate`.
- **Revisit when**: Node starts programs with `vfork` or `posix_spawn` on Linux, or the worker's resident size stays below 112 MiB.


## 32. Code smell ratchet

- **Decision**: CI fails on any new violation of `complexity` 30, `max-depth` 5, `max-lines-per-function` 250, `max-params` 6, `no-nested-ternary`, `@typescript-eslint/no-explicit-any` and `max-lines` 1500 in `src/**/*.{ts,tsx}`. Existing violations sit in `.github/code-smell-baseline.json`, keyed by file, rule and enclosing function name with a count and the worst measured value. The baseline can only shrink: a rise fails, and so does a fall until `--update` rewrites the baseline in the same change. Inline `eslint-disable` comments do not count for this gate. On pull requests CI also compares the baseline with the base branch's copy, summed per file and rule (a renamed function passes), so regenerating the baseline with `--allow-growth` cannot admit a new violation; pushes to main skip that comparison because the pull request already passed it.
- **Why it is right in practice**: large codebases that cannot be cleaned in one pass hold the line with a ratchet instead of a flag day: new code meets the bar, old code is paid down as it is touched. Keys without line numbers survive unrelated edits, so the baseline does not churn.
- **Benefits and trade-offs**: reviewers stop meeting new 300-line, deeply nested functions. Cost: a refactor that lowers one number must also commit the smaller baseline, and a function renamed or moved shows as one removed and one new key; the change then fails until the baseline is regenerated, which is reviewed as a diff. A hot codec loop that has to stay long keeps its entry with a recorded `reason`.
- **Alternatives rejected**:
  - **Adding the rules to the framework lint preset as warnings**: nobody reads 700 warnings and nothing blocks a new one.
  - **Failing only on changed lines**: it needs the base commit at check time and misses growth of an existing function in an unchanged line range.
  - **Line-number keys**: every edit above a violation would invalidate the baseline.
- **Verified by**: `tests/guard-code-smells.test.ts` (known violation recorded under the right key, a rising count or value fails, a new function fails, inserted lines keep keys, a removed violation fails until `--update`, `--update` never raises) and the `checks` job step `npm run guard:code-smells`.
- **Revisit when**: the baseline is small enough to switch to zero tolerance, or the thresholds are tightened.


## 33. OCR page preparation: leased image threads and a bounded skew sample

- **Status**: Implemented (issue #644).
- **Decision**:
  - The preparation of a page for recognition (decode, measuring, enlargement, turn) runs on the image library's leased threads (`withImageThreads`, the lease the AVIF encode uses) instead of its single default thread. The lease is two threads while the process does not bound its glibc heap, and the cores up to the memory limit when it does (`MALLOC_ARENA_MAX`), as for the encode; the base count is put back when the preparation ends or fails.
  - The skew search scores at most 40 000 ink points of a page (was 300 000): the page is read once, the points are thinned evenly by halves when the store fills up, and the widest stage of the search (41 angles over plus or minus 10 degrees) scores every fourth of them. The finest stages and the reported gain use all kept points.
  - No setting, parameter of the engine, language data or output changes: the angle found, the turned page and every recognized word are the same on the golden pages and the benchmark scan.
- **Why it is right in practice**:
  - The benchmark scan (840 x 260, nine text lines) spends 30 ms in preparation before the engine starts, and nothing else in the request can run meanwhile. On one image thread the Lanczos enlargement and the bilinear turn of the 2100 x 650 page took 17 ms of it; on two threads the whole preparation takes 22 ms (4-core and 2-core Linux VM, 30 runs, medians).
  - The skew search costs one multiplication and one increment per point for each of 73 candidate angles. On the two-column golden page (2550 px wide) the search took 55 ms of a 104 ms preparation; with 40 000 points the preparation takes 73 ms (before the lease). An even sample of a few ten thousand points places the row profile as sharply as all of them: the angle found is the one the page was turned by within the 0.15 degree tolerance of the existing skew tests, for turns from -8.1 to 6.2 degrees. The angle reported is the same on all 59 golden pages and turned variants compared with main but one (a 0.45 degree turn of the two-column page: 0.44 before, 0.46 now), the character error is the same on every English golden page, and the measured line height of the two turned dense pages moved by 1.2 and 2.5 percent (53.0 to 52.4 px, 33.2 to 34.0 px), because the row profile that it is read from is built from the sample.
  - Measured on the 4-core Linux test VM with the parity bench (`--parity --speed-only --family ocr`, 18 interleaved pairs, medians): the head runs the benchmark scan at 1.08 times the speed of main, and on two cores at 1.06 times. The English golden pages take 6 percent less time in total (6.9 s to 6.5 s for 20 pages).
- **Trade-offs**:
  - The lease is process-wide for its length, as for the encode: a WebP encode running during a page preparation of a 4-core worker takes the two threads for those 20 ms (the encode of a small interface was measured 6 ms slower on more threads). The preparation is at most two at once (`OCR_PREPROCESS_MAX_CONCURRENCY`).
  - With the heap bound by `MALLOC_ARENA_MAX` the preparation may use as many threads as the encode does; the buffers it holds are a few page-sized arrays, far below the 24-megapixel encode the memory bound was measured with.
  - A skew of a page whose lines are fewer than 40 000 ink pixels is searched exactly as before; a denser page is judged on a sample, so a page whose skew shows only in a small part of its ink (a few lines of text under a large solid block) is judged on proportionally fewer points of those lines.
- **Alternatives rejected**:
  - **Enlarging and turning in one pipeline**: the enlarged page is no longer written out as a buffer, but the preparation took the same 30 ms; the cost is in the resampling, not the copy.
  - **A smaller enlargement target** (25 to 30 px lines instead of 35): the engine reads a page 10 percent faster, but the confidence of the reading falls below the threshold that triggers a second reading for some pages, which doubles the cost; the benchmark scan took 350 ms against 245 ms at 28 px.
  - **Skipping the turn for skews under 0.75 degrees**: the character error is the same on the swept pages, but the page is then not cut into bands on a 4-core machine (the ink of tilted lines fills the gaps the cuts are found in), and the whole page is read by one worker: 211 ms against 166 ms.
  - **The lean engine build and the relaxed-SIMD build**: the Node adapter of the engine library loads the build that includes the legacy engine, because it compares a boolean with the engine-mode enumeration. Pinning the lean build, or the relaxed-SIMD build, gave no gain on the CI runner (AMD EPYC, x64, Node 20: 340 ms for the build in use, 342 ms lean, 344 ms relaxed, 347 ms both, best of twelve readings) and none on the 4-core ARM VM; the relaxed-SIMD build also needs an experimental V8 flag on Node 20, and the lean build a worker script of our own.
  - **The native command line as the engine of the page**: on the CI runner the native engine reads the prepared page in 307 ms against 340 ms for the WebAssembly engine, and the reference command reads the raw scan in 203 ms; the gap to the reference is the work of the enlarged page (about 100 ms more engine time than the page as submitted), not the engine build.
  - **Reading the page unenlarged when the first pass is confident** (QA decision 2026-10-16: the enlargement of small text stays and the speed gap is tracked on #644): measured with the page read whole by one worker, 209 ms against 234 ms on 2 cores, but 213 ms against 166 ms on 4 cores, because the bands need lines of 30 px or more and are lost. The benchmark scan then reads at 0.157 percent character error (one character) instead of 0, and the mean character error of the 72 dpi golden pages goes from 0.12 to 0.43 percent. Accuracy is the value of OCR, and the engine's own guidance asks for text with an x-height of 20 to 30 px, which small text only reaches after enlargement.
  - **Fewer or more bands, a single-line reading mode for each line, a binarized page, and engine parameters** (dictionaries off, no trial inversion): each measured within 5 percent of the current reading, or slower.
- **Verified by**: `tests/ocr-skew-work.test.ts` (the points scored are bounded for solid ink and for dense text, a sparse page is scored whole, and the angle of dense pages turned by an independent rotation is found from the bounded sample), `tests/ocr-preprocess-threads.test.ts` (the preparation runs on the leased threads and puts the base count back, also on failure), `tests/ocr-scan-pdf-oracle.test.ts` (the searchable PDF of the benchmark scan read back with `pdftotext` and `pdfinfo`: character error, word F1, page count and size), the existing skew, band, orientation and worker pool tests, and the `ocr` parity rows (`cer`, `word_f1`, `throughput`).
- **Revisit when**: the throughput row is judged on a runner with more cores than the CI runner has, or the reading of an enlarged page gets cheaper in the engine (a build whose layout analysis does not grow with the pixels). The levers that remain for the speed gap are tracked on #644: the PNG re-encode in `decodePdfPages` (9 to 20 ms before the OCR starts), a retuned second-reading trigger (confidence threshold 0.9) together with a 28 px enlargement target, and bands for text lines under 30 px.
