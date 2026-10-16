# Real-world corpus provenance

`bench/realworld/manifest.json` pins every file of the real-world corpus by origin, size and SHA-256. None of these files is
committed or redistributed by this repository: `bench/realworld/fetch.ts` downloads a file from the host that publishes it the
first time a run needs it, checks its digest against the manifest, and keeps it in `~/.cache/easyconvert-realworld` (the nightly
workflow restores that directory per shard with `actions/cache`, keyed by the hash of the manifest). A digest that differs from
the manifest fails the run: the corpus compares against fixed bytes. Origins are pinned to a commit, a release tag or an archive
that keeps old versions wherever the host offers one; the exceptions are named in the notes at the end.

The corpus has two parts. The first, `govdocs1` and `office-test-data`, is the large set of office, PDF, HTML, text and image files
that the nightly run of #636 converts. The second answers #780 (QA decision 2026-10-16): **every format the registry accepts as an
input has at least three real sample files, or a recorded reason why not**. A real sample is a file that somebody other than this
project produced and published; files that a test or a generator in this repository writes do not count, because a conversion
judged only on inputs we wrote is judged on our own producer. `tests/corpus-format-coverage.test.ts` enforces the rule: it counts
the samples of every registry format in `bench/corpus/remote-manifest.json`, this manifest and `tests/fixtures/raw/*.json`, and it
fails for a format with fewer than three samples that has no entry in `bench/realworld/format-coverage-exceptions.json`. Each entry
there states why no further public sample could be used and lists the sources searched; the test also fails for an entry whose
format has since reached three samples, so the list can only shrink. `npx tsx bench/realworld/format-coverage.ts` prints the table
of formats, samples and producers.

Each file of the second part carries `producer` (the application, version or device that wrote it, where the publisher says), and a
`licence` code when its licence differs from its source's statement. Files from Wikimedia Commons also carry `page` (the file page
that states the licence and the author) and `credit` (the author).

## Sources

The licence column quotes the statement of the source itself (the licence file or README named in brackets). Where a source states
no licence for its files, the table says so; those files are fetched for conversion testing only and are never stored or shown. The
manifest's `sources` array holds the same statements.

| Source id | What it is | Licence statement | Files |
|---|---|---|---|
| `govdocs1` | Documents and images collected from public web servers in the .gov domain (the digital corpora research corpus) | Published as freely redistributable to the best of the publisher's knowledge | 4,189: doc, ppt, xls, pdf, html, jpg, gif, png, txt, csv, xml, ps, rtf |
| `govdocs1-listed` | Files of the same archives that the quota-based set above does not take, listed by name: PowerPoint slide shows (.pps, none in the quota set) and four Word documents that the 20,000-file regression trial found refused or misread (a report with embedded Word and Visio objects, a document whose main story ends inside a text piece, a Word 6 file from a Macintosh and a Word 5.0 for Macintosh file) | Published as freely redistributable to the best of the publisher's knowledge; fetched for testing only | 7: doc 4, pps 3 |
| `office-test-data` | Test data of Apache POI (Word, Excel and PowerPoint documents) | Apache License 2.0 (`legal/LICENSE` of the repository) | 1,317: doc, docx, dotx, ppt, pptx, xls, xlsm, xlsx |
| `poi-format-samples` | Test files of Apache POI in formats the quota-based set above leaves out: macro-enabled and template Office files, Publisher, Visio, CorelDRAW, Outlook, Corel Presentations, an OpenDocument spreadsheet, Markdown (added by #780 so that a rebuild of the generated set keeps them) | Apache License 2.0 (`legal/LICENSE` of the repository) | 16: docm 3, pub 2, vsd 2, cdr, md, msg, ods, potx, ppsx, pptm, shw, xltx |
| `tika-test-documents` | Test documents of Apache Tika: office, media, archive, image, ebook, CAD and vector files of many applications | Apache License 2.0 (`LICENSE.txt`); `NOTICE.txt` names one Open Government Licence 3.0 document | 101: 7z, aac, ai, amr 2, asf, au, bmp, cab, cgm, chm 2, cpio, cur, dbf, dif, djvu, dmg, dwf, emf, eml 3, flv, hwp 3, ibooks, icns 2, jp2, key, mkv, mp4 2, numbers 2, oga, opus, pages, psd 2, rar, sda, sdc, stl, svgz, swf 3, tbz2, tgz, tif 2, tsv 2, war, webm, wma, wmv 2, xps 3 and more |
| `commons-compress-tests` | Archives written by tar, cpio, zip, 7-Zip, LHA, ARJ and bzip2 implementations of several operating systems (FreeBSD, SunOS, Cygwin) | Apache License 2.0 (`LICENSE.txt`) | 35: 7z, arj 2, bz2 3, cpio 3, gz 2, lha 3, lzma, tar 3, tar.bz2, tar.gz 2, tar.z, tgz 2, xcf 2, xz 2, zip 3, aif, ico, jar, md |
| `libreoffice-test-data` | Documents, drawings, spreadsheets, metafiles and images from the unit-test data of the LibreOffice core repository (import filters for Keynote, Pages, Numbers, Publisher, Visio, CorelDRAW, WordPerfect, Works, AbiWord, StarOffice, Lotus, SYLK, DIF, dBASE, Palm databases) | LibreOffice is distributed under MPL 2.0 (`COPYING.MPL`) and LGPL and GPL for parts (`COPYING`); the test documents live in the same repository. Only files the project marks as passing import are used | 75, 1 to 4 per format: abw 2, cdr, cgm 2, dbf 2, dif 2, emf 2, fodp 2, fods 2, fodt 2, jpeg 3, key 2, odg 2, odp 2, ott 4, pages 2, pdb 3, slk 3, sxw 3, wmf 2, xhtml 3 and more |
| `pillow-test-images` | Test images of the Pillow imaging library: bmpsuite bitmaps, TIFF, Targa, PNM, WebP, ICO, ICNS, PSD, EPS, DDS, JPEG 2000, AVIF and HEIF, plus project documentation and configuration files (rst, toml, yaml) | MIT-CMU (HPND) licence of the project (`LICENSE`) | 36 |
| `format-corpus` | The Open Preservation Foundation format corpus: small example files of many formats with the tool that wrote them (calibre 0.8.57 and 0.9.0 ebooks, QuickTime movies, Lotus and Quattro sheets, WordPerfect, ARJ, disk images, iBooks Author, OpenOffice and LibreOffice files) | CC0 1.0: the README states that all items are CC0 licensed unless stated otherwise | 39: azw3 2, htmlz 2, ibooks 3, img 3, lit 2, lrf 2, mov 3, pdb 2, rb 2, snb 2, txtz 2, wk1 4, arj, htm, jp2, qpw, tif, wpd and more |
| `libvips-test-images` | Test images of the libvips library | LGPL 2.1 or later (`LICENSE`) | 10: avif, cur, exr, ico, j2k, jp2, ppm, tga, tif, webp |
| `rarfile-tests` | RAR 3.x and 5.x archives and documentation of the rarfile Python library | ISC (`LICENSE`) | 6 |
| `lhasa-tests` | An LHA archive written by an LHA 2.13 implementation, from the lhasa test suite | ISC (`COPYING`) | 1 |
| `py7zr-tests` | 7-Zip archives with BCJ and other coders, and documentation of the py7zr library | LGPL 2.1 or later (`LICENSE`) | 3 |
| `libmspack-tests` | Microsoft Cabinet and CHM files of the libmspack and cabextract test suite | LGPL 2.1 for libmspack, GPL for cabextract (README) | 3 |
| `libarchive-tests` | A GitHub Actions workflow file (YAML) of the libarchive repository | BSD 2-clause (`COPYING`) | 1 |
| `libheif-examples` | HEIF and HEIC example files of the libheif test data | LGPL 3.0 for the library, MIT for the sample applications (`COPYING`) | 4 |
| `nokia-heif-conformance` | HEIF conformance file candidates published by Nokia Technologies | The repository states no licence for the files; they are generated with Nokia's HEIF software (Nokia HEIF License 2.1 in `nokiatech/heif`) | 2 |
| `av1-avif-files` | An AVIF example of the Link-U set of the AV1 image format specification repository | CC-BY-SA 4.0 (`testFiles/Link-U/README.md`) | 1 |
| `libavif-tests` | The Gradle wrapper jar of the libavif repository | Apache License 2.0 (Gradle) | 1 |
| `kaitai-samples` | RPM packages and a WAV file from the Kaitai Struct sample library | CC0 1.0 per file (each file has a `.license` companion in REUSE format) | 3 |
| `ffmpeg-fate-suite` | Samples of the FFmpeg regression suite (FATE), published at fate-suite.ffmpeg.org for testing decoders and demuxers | No licence is stated; the publisher offers the samples for testing. Fetched only, never stored or shown | 109: containers and codecs of many vendors (aac, ac3, ape, asf, av1, avi, caf 3, dts, flv, h264, h265, hevc, m4a 8, mka, mkv 4, mp3 4, mp4 4, mpc, mpg, mxf 4, ogg 4, ogv, opus 3, ra 3, rm, ts 4, vob, voc, wma 5 and more), among them HDR10, HDR10+ and Dolby Vision profile 5, 7 and 8.1 clips |
| `ffmpeg-samples` | Files of the MPlayer/FFmpeg samples collection at samples.ffmpeg.org (mobile phone clips, DV, DVD, Windows Media Center recordings, AIFF, AU, DSS, a Blu-ray transport stream, an iPod audiobook) | `00-README` states no licence and invites downloading samples. Fetched only, never stored or shown | 49: 3g2 3, 3gp 3, aif 2, aifc 6, aiff 3, au 4, caf 4, dv 2, dvr 3, m2ts 2, mts 2, mpeg 2, wav 6 and more; the A-codecs files of libsndfile (`libsndfile-*`: 32- and 64-bit float, 24-bit and 32-bit integer, A-law, mu-law and ADPCM variants of WAV, AIFF, AIFF-C, CAF and AU) are in this source |
| `wikimedia-commons-formats` | Files of Wikimedia Commons under open licences: audio, MIDI, DjVu, GIMP, TIFF and WebM files, one file page each | The licence of each file page, recorded as the file's `licence` code (below); reuse terms at <https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia> | 19: djvu 2, mid 3, mp3 3, oga 2, ogg 2, webm 4 (two of them HLG), tiff, wav, xcf |
| `pixls-raw-samples` | Camera RAW files of the raw.pixls.us sample archive, one or two per model across Sony, Canon, Kodak, Epson, Minolta, Nikon, Olympus, Pentax, Fujifilm, Panasonic, Leica and Raspberry Pi (no file above 25 MB; phone and camera DNG files from Apple, Google, Huawei, OnePlus, LG, DJI, Pentax, Samsung, Leica, Blackmagic, Sigma and Adobe's converter, and Foveon X3F, Canon CR3, Nikon, Sony, Olympus and Panasonic files) | CC0 1.0: the contributor places the file in the public domain, and the archive's file list (<https://raw.pixls.us/json/getrepository.php?set=all>, which also gives each file's SHA-256) shows the licence per file. Every digest of this source was matched against that list and every file is CC0; the 146 files of the former rawsamples.ch collection that the list shows as CC BY-NC-SA are not used | 66: arw 3, cr2 2, cr3 4, crw 2, dcr 2, dng 29, erf 2, mrw 2, nef 3, orf 4, pef 3, raf 3, raw 3, rw2 2, x3f 2 |
| `pythonocc-test-io` | STEP, IGES and STL files of the pythonocc-core import and export tests | LGPL 3.0 (`LICENSE`) | 8 |
| `trimesh-models` | An STL and an OBJ mesh of the trimesh test models | MIT (`LICENSE.md`) | 2 |
| `tinyobjloader-models` | Wavefront OBJ models of tinyobjloader | MIT (README) | 2 |
| `cadquery-testdata` | A STEP file of the CadQuery test data | Apache License 2.0 (`LICENSE`) | 1 |
| `occt-data` | STEP and IGES sample data of Open CASCADE Technology | LGPL 2.1 with the Open CASCADE exception (`LICENSE_LGPL_21.txt`) | 3 |
| `openexr-images` | OpenEXR test images of the OpenEXR project | BSD 3-clause (`LICENSE`) | 2 |
| `fonttools-tests` | Type 1, WOFF and Mac data-fork fonts of the fontTools test suite | MIT (`LICENSE`) | 5 |
| `ibm-plex-fonts` | WOFF, WOFF2 and EOT builds of the IBM Plex families | SIL Open Font License 1.1 (`LICENSE.txt`) | 4 |
| `adobe-source-sans-fonts` | WOFF and WOFF2 builds of Source Sans 3 | SIL Open Font License 1.1 (`LICENSE.md`) | 2 |
| `bootstrap-icons-font` | WOFF and WOFF2 builds of the Bootstrap Icons font (release v1.11.3) | MIT (`LICENSE`) | 2 |
| `font-awesome-fonts` | WOFF2, EOT and SVG font builds of Font Awesome 4.7.0 | SIL Open Font License 1.1 for the fonts (README, License section) | 3 |
| `apache-batik-samples` | SVG font samples of the Apache Batik distribution | Apache License 2.0 (`batik-shared-resources/src/main/resources/LICENSE`) | 2 |
| `zstd-tests` | Golden Zstandard frames of the zstd test suite | BSD 3-clause or GPL 2.0 at the user's choice (`LICENSE`, `COPYING`) | 3 |
| `file-command-tests` | A HWP 2016 (HWPX) document of the file(1) command's test suite | BSD 2-clause for the project (`COPYING`); the test file's own licence is not stated | 1 |
| `kde-ark-tests` | Archives of the Ark archive manager test suite: lzma, lzop, compress, RPM, Debian packages | GPL 2.0 or later with the KDE project's REUSE licence files (`LICENSES/`) | 6 |
| `kde-karchive-tests` | An xz tar archive of the KArchive test suite | LGPL 2.0 or later with REUSE licence files (`LICENSES/`) | 1 |
| `kde-kfilemetadata-tests` | An AIFF file of the KFileMetaData test suite | LGPL 2.1 or later with REUSE licence files (`LICENSES/`) | 1 |
| `kde-okular-tests` | LaTeX sources, a comic book archive and SVG icons of the Okular test suite and artwork | GPL 2.0 or later for the code, with REUSE licence files for the data (`LICENSES/`) | 6: cbz, svgz 2, tex 3 |
| `abiword-docs` | AbiWord documents (abw and zabw) of the AbiWord source repository's documentation | GPL 2.0 or later (`COPYING`) | 3 |
| `hocr-tools-tests` | hOCR files written by Tesseract in the hocr-tools test data | Apache License 2.0 (`LICENSE`) | 2 |
| `hocr-to-alto-tests` | A Tesseract hOCR file of the hOCR-to-ALTO converter's tests | MIT (`LICENSE.txt`) | 1 |
| `loc-chronicling-america` | ALTO XML text layers (ABBYY FineReader output of the National Digital Newspaper Program) of three 1913 newspaper pages | Public domain: Library of Congress publication, 1913 newspaper pages with no known copyright restriction (<https://chroniclingamerica.loc.gov/about/>) | 3 |
| `gnu-ftp-archive` | Release tarballs and patches of GNU Hello (gzip, bzip2 and xz compressed) from ftp.gnu.org | GNU GPL 3.0 or later for GNU Hello | 8 |
| `tukaani-lzma-release` | LZMA Utils 4.32.7 release tarballs compressed with xz and LZMA | GNU GPL 2.0 or later | 2 |
| `gnu-savannah-releases` | Release tarballs of lzip, compressed with lzip | GNU GPL 2.0 or later | 3 |
| `kernel-org-patches` | xz-compressed Linux kernel patches from kernel.org | GNU GPL 2.0 | 2 |
| `debian-snapshot-packages` | Debian packages of GNU Hello from snapshot.debian.org (permanent URLs, archive of 2024-01-01) | GNU GPL 3.0 or later for the packaged software | 2 |
| `ubuntu-old-releases-packages` | An Ubuntu package of GNU Hello from old-releases.ubuntu.com | GNU GPL 3.0 or later for the packaged software | 1 |
| `centos-vault-packages` | RPM packages of CentOS 7.9.2009 from vault.centos.org | Per package, as the package metadata states (basesystem and setup are free software) | 2 |
| `arch-linux-archive` | Zstandard-compressed Arch Linux packages from archive.archlinux.org (permanent URLs) | Per package: which, sed and grep are GPL | 3 |
| `slackware-packages` | xz-compressed Slackware 15.0 packages from mirrors.slackware.com | Per package: tar, bzip2 and ed are free software | 3 |
| `gutenberg-ebooks` | A Kindle KF8 edition of a Project Gutenberg book (Alice's Adventures in Wonderland), as the project's ebook maker writes it | Public domain in the United States; Project Gutenberg's terms of use apply to its trademark only (<https://www.gutenberg.org/policy/permission.html>) | 1 |
| `tinycore-releases` | Tiny Core Linux 12.0 and 14.0 release ISO images | GPL 2.0 and the licences of the packages on the image | 2 |
| `ipxe-boot-images` | The iPXE boot ISO | GPL 2.0 with the UBDL linking exception | 1 |
| `rectangle-releases` | The Rectangle 2.0.3 macOS disk image | MIT (`LICENSE`) | 1 |
| `stats-releases` | The Stats 3.0.21 macOS disk image | MIT (`LICENSE`) | 1 |
| `apache-tomcat-docs` | The sample web application archive of the Apache Tomcat documentation | Apache License 2.0 | 1 |
| `jellyfin-test-videos` | HDR10 test clips of the Jellyfin project in HEVC and AV1, courtesy of Gnattu | Creative Commons Attribution-ShareAlike 4.0 (statement on <https://repo.jellyfin.org/test-videos/>) | 2: mp4 2 |
| `internet-archive-comics` | Comic book archives of Internet Archive items (three CBR and two CBZ files of 1 to 9 MB) | Per item page: CC0 1.0 (`CC0-1.0`) or a public domain statement of the uploader (`PD-uploader`, a Creative Commons public-domain dedication on the item page); the project does not verify an uploader's statement, and the files are fetched for testing only | 5: cbr 3, cbz 2 |
| `pdfjs-test-pdfs` | PDF files of the PDF.js regression suite at a pinned commit: encrypted files (RC4 and AES, revisions 2 to 6), damaged files, and files with Type 3 and CID fonts, forms, linearization, PDF/A and JBIG2 or JPEG 2000 images | Apache License 2.0 (`LICENSE` of the repository) | 29 |
| `qpdf-test-pdfs` | PDF files of the qpdf test suite at a pinned commit: encrypted files (revisions 2 to 6, 30 pages each), files that exercise its error handling, a form, tagged and long documents | Apache License 2.0 (`LICENSE.txt` of the repository) | 18 |
| `pdfbox-test-pdfs` | PDF files of the Apache PDFBox test resources at a pinned commit: an encrypted tagged file, forms, a PDF/A-3 file, a linearized file and long documents | Apache License 2.0 (`LICENSE.txt` of the repository) | 9 |
| `pypdf-sample-files` | Sample PDF files of the py-pdf project at a pinned commit (a document with an attachment and a 117-page LaTeX document) | Creative Commons Attribution-ShareAlike 4.0 (`LICENSE` of the repository) | 3 |
| `verapdf-corpus` | Conforming PDF/A files of the veraPDF corpus (PDF/A-1b, 2b and 3b) at a pinned commit | Creative Commons Attribution 4.0 (README of the repository) | 3 |
| `vctk-voicebank` | Clean read English speech of two speakers of the CSTR VCTK corpus (utterances of the clean test set of the Voice Bank noisy speech database), read with range requests from the archive | Creative Commons Attribution 4.0 International (item page <https://datashare.ed.ac.uk/handle/10283/2791>) | 18: wav 18 |
| `gsm8k-data` | JSON lines files of the GSM8K data set | MIT (`LICENSE`) | 2 |
| `vega-datasets-files` | A tab-separated data set (US unemployment by county) of the Vega datasets | `datapackage.json` declares BSD 3-clause for the repository and the U.S. Government Works terms for this data set | 1 |

## Regression corpus

`bench/realworld/regression-manifest.json` is a second manifest, for the regression corpus of #780 (QA decision 2026-10-17): about
20,000 office and PDF files drawn from two public corpora and run weekly, in part nightly, by `.github/workflows/regression-corpus.yml`
(`bench/README.md`, Regression corpus). It pins every file by archive, entry, offset, size and SHA-256, and records the producing application
(`producer`: the PDF Producer or Creator, the application name of the OLE SummaryInformation stream, or `Application` of the OOXML
`docProps/app.xml`). **No file is committed, redistributed, shown or shipped.** Each shard reads its files out of the publisher's ZIP
archives with range requests, checks the digest, converts the file and deletes it; no Actions cache holds them. This is internal test use,
as for the other sets whose terms allow research and development use (`docs/policy-decisions.md`, entries 37 and 39).

| Source id | What it is | Licence statement | Files |
|---|---|---|---|
| `govdocs1` | The same government document corpus as above, now drawn from all 1,000 archives (office files: doc, xls, ppt, pps, docx, xlsx, pptx; and PDF), without the entries the real-world corpus already holds | Published as freely redistributable to the best of the publisher's knowledge | 15,003: doc 4,000, xls 3,300, ppt 2,400, pps 400, docx 162, xlsx 37, pptx 204, pdf 4,500 |
| `cc-main-2021-31-pdf` | PDF files of the CC-MAIN-2021-31 web crawl, re-fetched untruncated and packaged in ZIP archives by the digital corpora project for the SafeDocs programme (40 of the 7,933 archives are indexed; the file number inside the corpus follows the hash of the PDF, so any archive is a random sample of the crawl) | Files collected by Common Crawl from public web servers: Common Crawl terms of use (<https://commoncrawl.org/terms-of-use>) and the terms of the digital corpora project. No licence of the individual file is stated; the files are fetched for conversion testing only | 5,000: pdf |

How the files were chosen (`scripts/regression-corpus-manifest.ts`, steps `index`, `profile` and `select`):

- **Strata.** A file belongs to a stratum of its format, the class of the application that wrote it (`producerClass` in
  `bench/realworld/regression/producer.ts`: for example `microsoft-word`, `acrobat-distiller`, `openoffice-family`, else the first two
  words of the producer name without versions) and its size class (under 64 KiB, under 512 KiB, under 2 MiB, larger). The budget of each
  format (and, for PDF, of each source) is shared equally between its strata; a stratum with fewer files than its share is taken whole.
  Producers are read from the file itself where it names one; for the crawl PDFs the producer of the corpus's `pdfinfo` metadata table
  is the fallback.
- **Pool.** The draw is made from a pool of 1.5 times the budget, stratified by format and size class (and, for the crawl, by the producer
  of the metadata table), so a producer that is rarer than about one file in a thousand of its format may not be seen.
- **Left out.** Files above 8 MiB; empty files; entries the real-world corpus already holds; names that mark an exploit sample, a fuzzer
  output or malware (`bench/realworld/regression/build.ts`); crawl PDFs whose metadata says they carry JavaScript; and, after reading
  the bytes, files with a Visual Basic project (an OLE document with a `VBA` storage, an OOXML package with a `vbaProject.bin`) or a
  PDF with a script or launch action. The UNSAFE-DOCS set and any malicious-file or fuzzing corpus are not used: they belong to the
  pre-launch security batch (#761). A web crawl can still hold a hostile PDF that none of these checks finds, so the converters run in
  their sandbox and the bytes are never executed or rendered by the tooling that builds the manifest.
- **Known gap.** The government corpus holds few OOXML files (162 docx, 37 xlsx and 204 pptx within the size cap), so those strata are
  small; the office sets of the format-sample sources above cover them better.

## Licence codes of single files

Files from Wikimedia Commons carry the licence code of their file page; the page itself and the author are in the manifest (`page`,
`credit`). The codes in use are `CC0-1.0` (CC0 1.0 Universal), `Public-domain` (the file page states public domain), `CC-BY-3.0`,
`CC-BY-SA-3.0` and `CC-BY-SA-4.0` (Creative Commons Attribution and Attribution-ShareAlike). Files from other hosts that name a licence per file use `CC0-1.0`, `PD-uploader` (see `internet-archive-comics`). Attribution and share-alike terms bind a
redistribution, which does not happen here: the files are read to test conversions and are not stored or shown.

## Notes

- Files that a publisher names with one extension and the registry knows under another carry the registry's extension in their id,
  and the manifest URL shows the published name: `.dvr-ms` recordings of Windows Media Center are `.dvr`; `.lzh` archives are `.lha`;
  the raw HEVC streams published as `.hevc` are `.h265` (three further files are `.hevc`); the AV1 IVF and OBU streams are `.av1`;
  the AFsp AIFF-C files published as `.aif` are `.aifc`; one STEP file published as `.stp` is `.step`; a HWPX document published as
  `HWP2016.hwpx.zip.testfile` is `.hwpx`; the KF8 edition that Project Gutenberg serves as `pg11-images-kf8.mobi` is `.azw3`. The bytes are the publisher's, unchanged.
- The PDF files of `pdfjs-test-pdfs` and `qpdf-test-pdfs` are the regression files that the two projects keep for encrypted documents and for damaged structure (a looping page tree, a wrong cross-reference table, a truncated object). Files that carry the name of a fuzzer or of a CVE are not used.
- A few FATE files are cut from a longer recording by their publisher (their names say `partial`); they stay because a truncated
  real file is a common input.
- GitHub raw URLs carry a commit or a release tag, and Debian and Arch packages come from archives that keep old versions. The
  FFmpeg collections, raw.pixls.us, Wikimedia Commons, the Library of Congress, kernel.org, the GNU and Slackware mirrors, the
  CentOS vault, Tiny Core, iPXE and the Open Preservation Foundation files are pinned by digest only, and a change at the host fails
  the run until the file is re-pinned (`bench/realworld/fetch.ts` never accepts other bytes).
- Licence rule (the research and R&D sets of the parity benchmark are described in `bench/corpus/PROVENANCE.md`; none is in this corpus): only files whose licence allows commercial use are used; Creative Commons NonCommercial (NC) and NoDerivatives (ND) files are excluded, however they are used. Where the publisher lists a licence per file (the camera sample archive) it is read from that list and not from the statement of the source.
- Selection: files from exploit databases (the `EDB-` and `CVE-` named test documents of LibreOffice), fuzzer outputs and files the
  project marks as failing import are not used, and neither are government form templates whose licence is not stated. The entries
  of `format-coverage-exceptions.json` say where that cost a format its third sample.
- To add a sample: download it into a new empty directory, never run it, identify it with a tool that is not the converter, add the
  manifest entry with the digest of the downloaded bytes and, if the source is new, its licence statement here and in `sources`.
