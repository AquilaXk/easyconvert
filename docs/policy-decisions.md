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
19. [Image metadata and alpha](#19-image-metadata-and-alpha)

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

Engines

11. [Open-source engines only, separate programs for copyleft tools](#11-open-source-engines-only-separate-programs-for-copyleft-tools)
12. [Engine choice and version pinning](#12-engine-choice-and-version-pinning)
13. [CAD input](#13-cad-input)
14. [SVG to PDF](#14-svg-to-pdf)

Usage limits

15. [Usage is charged for successful conversions only](#15-usage-is-charged-for-successful-conversions-only)
16. [Free and anonymous limits](#16-free-and-anonymous-limits)

Quality evidence

17. [Parity gate: quality and speed against reference tools](#17-parity-gate-quality-and-speed-against-reference-tools)
18. [Public sample sets as evidence](#18-public-sample-sets-as-evidence)

---

## 1. AVIF chroma and bit depth

- **Status**: Implemented (#749, issue #736), decided 2026-10-11. Supersedes the 2026-10-09 policy (graphics 4:4:4, at most 10 bits).
- **Decision**:
  - **Lossy output** is 4:2:0 for all content, photographs and graphics alike.
  - **Lossless output** (quality 100), and pictures with an identity colour matrix, are 4:4:4.
  - **Bit depth**: an 8-bit source is written at 8 bits. A 9- or 10-bit source is written at 10 bits. A source of 11 bits or more, 16-bit included, is written at 12 bits. HDR renditions (PQ or HLG) keep their 10 bits.
  - **Alpha and metadata**: see [19. Image metadata and alpha](#19-image-metadata-and-alpha).
- **Why**: users compare our files with the ones the leading converters give them. Those use 4:2:0 for lossy AVIF and keep high-bit-depth sources at a matching depth. Matching this keeps file sizes comparable for every content class, so a user switching to us does not get files that are suddenly larger. 4:2:0 is also the layout every AVIF decoder handles fastest. Keeping 12 bits for 16-bit sources preserves gradations and editing headroom that a 10-bit cap would throw away.
- **Trade-offs**:
  - At the same quality setting, 4:2:0 softens coloured edges in screenshots, text and line art. 4:4:4 would keep them sharp, at a larger file.
  - 12-bit AVIF needs the AV1 Professional profile. Some hardware decoders, and decoders that implement only the AVIF Baseline profile (AV1 Main), cannot open it, so a 16-bit source can produce a file that does not open on every device.
  - Measured against the reference encoder at the same constraints (BD-rate, 0 is parity, lower is better): the 11 photographs that were 1.6 to 4.9 % behind in SSIM are now between -3.1 and +0.9 %; the 16-bit class is 12 to 13 % ahead in WebP and AVIF PSNR. Photographs stay on the in-process encoder, whose speed is 1.2 to 1.4 times the reference's; the command-line encoder with edge-preserving chroma conversion took the same photographs to +1.3 to +1.7 % SSIM at 0.7 times the speed, which is why the 4:4:4 reference could not be met by encoder tuning alone.
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

- **Status**: Implemented (#725); extended to every in-process PDF writer (#742). Legacy binary word-processing documents (`.doc`) are tracked in #726.
- **Decision**:
  - Symbol-font private-use characters are mapped to Unicode with the standard tables for the symbol fonts.
  - A character that no table maps becomes U+FFFD, and a warning names the font and the code.
  - **The PDF writers apply the same rule to any code point no font can draw** (unassigned, private-use, noncharacter, lone surrogate). The code point becomes U+FFFD and the result carries one warning line for each distinct code point. They no longer refuse the document.
- **Why**:
  - The whole document must still convert. Failing it for one glyph is worse than any substitute.
  - A replacement mark is honest.
  - Drawing the code with another font would show a different glyph with no sign of the error, because unknown symbol encodings differ font by font.
  - Word processors keep private-use characters in text on purpose (a bullet or a math symbol typed in a symbol font), so a whole document must not fail for one.
- **Trade-offs**:
  - The reader sees a replacement mark where the original showed a glyph.
  - Plain text, Markdown and HTML to PDF follow the rule too. A file with a stray noncharacter converts, where it used to fail with HTTP 400.
  - A character that is assigned but that no installed font covers still fails, because installing a font fixes it.
- **Alternatives rejected**:
  - **Refusing the document.**
  - **Rendering with a bundled symbol font**: wrong glyphs, silently.
  - **Dropping the character**: the loss would leave no trace in the output.
- **Verified by**: the PPT symbol-font tests, `tests/pdf-unicode-text-writers.test.ts` (plain text), `tests/conversion-warnings-scope.test.ts`, and the public document rows (`doc-poi-bug59058.docx` converts).
- **Revisit when**: a reliable glyph source for the remaining math fonts appears.

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
- **Verified by**: the office output-check tests.
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
  - Copyleft engines, such as the PostScript interpreter and the DWG reader planned in #728, are used only as unmodified separate programs.
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

- **Status**: Implemented for DXF (#727). DWG is decided (#728).
- **Decision**:
  - DXF is read in-process. It covers lines, arcs, circles, ellipses, splines, polylines with bulges, blocks with nesting and arrays, dimensions, and text.
  - Output is one vector page fitted to the drawing extents.
  - Expansion is bounded by one budget for the whole drawing; a drawing over it fails with 422.
  - DWG is converted to DXF by an open-source reader run as a separate program.
- **Why**:
  - Fidelity: dropping entity types gives visibly wrong drawings.
  - Fitting the page to the extents matches what CAD exporters produce.
  - The budget stops a small file from expanding into millions of strokes.
- **Trade-offs**: drawings beyond the budget are refused. The DWG reader does not handle every vendor version.
- **Alternatives rejected**:
  - Paid DWG libraries.
  - Adding a title and frame to the page, which users then have to crop.
- **Verified by**: the CAD parity rows and `tests/cad-dxf-*.test.ts`.
- **Revisit when**: users hit the budget with real drawings.

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
- **Why**: users convert the files they have, and the reference office suite opens them. Refusing the document for one parameter loses all of it. For the early close, the suite stops at the stray brace and drops the rest of the text; keeping the rest loses nothing the file holds.
- **Trade-offs**:
  - A document with a structural error is read with the same trust as a clean one. The warning is the only mark.
  - Reading past an early close can show content the suite hides. The file contains it, and the warning says where the structure broke.
- **Alternatives rejected**:
  - **Refusing the document**, which made the user's file unusable for one bad number.
  - **Stopping at the early close** as the reference does: the output would lose half of the text without a trace.
- **Verified by**: `tests/rtf-text-extraction.test.ts` (including the office suite as the oracle of what a clamped parameter reads as) and the public row `doc-lo-footnotes.rtf`.
- **Revisit when**: a damaged file reads wrongly after a clamp, or QA decides that structural errors must fail.

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
  - **sRGB-gamut profiles**: a profile with sRGB primaries (whether IEC 61966-2-1 sRGB or a development curve over sRGB primaries such as a camera RAW decoder's gamma 2.222 curve) is not written. The pixels go through it into standard sRGB; wider-gamut and grey profiles stay attached.
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
  - Rounding adds one pass over the samples of a 16-bit picture (no measurable time: 24 ms either way on the 16-bit space photograph).
  - A JPEG with a print density gets an EXIF block it did not have.
- **Alternatives rejected**:
  - **Lossless alpha** (the standalone encoder's default): exact, but 2.5 times the bytes on a flat chart and not what the service writes.
  - **Converting every profile into the pixels and writing none** (the earlier policy): smaller, but irreversible for wide-gamut pictures, and the pictures differ from the service's.
  - **Keeping every profile, the sRGB one included**: 3 kB more than the service on most photographs.
  - **Dithering the 16 to 8 bit reduction**: adds noise the encoder must code, and loses PSNR and SSIM at the same size.
- **Verified by**:
  - `tests/image-metadata-overhead.test.ts` (no block made up; a wide-gamut profile kept byte for byte in JPEG, WebP and AVIF; an sRGB profile not written; XMP kept alone), `tests/icc-srgb.test.ts`, `tests/image-16bit-rounding.test.ts`, and the argument test of `tests/image-avif-library-encoder.test.ts` (alpha quality equals the colour quality).
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



