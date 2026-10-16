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
| `ffmpeg-fate-suite` | Samples of the FFmpeg regression suite (FATE), published at fate-suite.ffmpeg.org for testing decoders and demuxers | No licence is stated; the publisher offers the samples for testing. Fetched only, never stored or shown | 76: containers and codecs of many vendors (aac, ac3, ape, asf, av1, avi, dts, flv, h264, h265, hevc, mka, mkv, mpc, mpg, mxf, ogv, rm, ts, vob, voc and more) |
| `ffmpeg-samples` | Files of the MPlayer/FFmpeg samples collection at samples.ffmpeg.org (mobile phone clips, DV, DVD, Windows Media Center recordings, AIFF, AU, DSS, a Blu-ray transport stream, an iPod audiobook) | `00-README` states no licence and invites downloading samples. Fetched only, never stored or shown | 25: 3g2 3, 3gp 3, aiff 3, dvr 3, aifc 2, au 2 and more |
| `wikimedia-commons-formats` | Files of Wikimedia Commons under open licences: audio, MIDI, DjVu, GIMP, TIFF and WebM files, one file page each | The licence of each file page, recorded as the file's `licence` code (below); reuse terms at <https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia> | 17: djvu 2, mid 3, mp3 3, oga 2, ogg 2, webm 2, tiff, wav, xcf |
| `pixls-raw-samples` | Camera RAW files of the raw.pixls.us sample archive, one or two per model across Hasselblad, Sony, Canon, Kodak, Epson, Minolta, Nikon, Olympus, Pentax, Fujifilm, Panasonic, Leica and Raspberry Pi (no file above 25 MB) | CC0 1.0: every sample of the archive is placed in the public domain by its contributor (<https://raw.pixls.us/>) | 26: 3fr, arw 2, cr2 2, cr3 2, crw 2, dcr 2, erf 2, mrw 2, orf 2, pef 2, raf 2, raw 3, nef, rw2 |
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
| `gsm8k-data` | JSON lines files of the GSM8K data set | MIT (`LICENSE`) | 2 |
| `vega-datasets-files` | A tab-separated data set (US unemployment by county) of the Vega datasets | `datapackage.json` declares BSD 3-clause for the repository and the U.S. Government Works terms for this data set | 1 |

## Licence codes of single files

Files from Wikimedia Commons carry the licence code of their file page; the page itself and the author are in the manifest (`page`,
`credit`). The codes in use are `CC0-1.0` (CC0 1.0 Universal), `Public-domain` (the file page states public domain), `CC-BY-3.0`,
`CC-BY-SA-3.0` and `CC-BY-SA-4.0` (Creative Commons Attribution and Attribution-ShareAlike). Attribution and share-alike terms bind a
redistribution, which does not happen here: the files are read to test conversions and are not stored or shown.

## Notes

- Files that a publisher names with one extension and the registry knows under another carry the registry's extension in their id,
  and the manifest URL shows the published name: `.dvr-ms` recordings of Windows Media Center are `.dvr`; `.lzh` archives are `.lha`;
  the raw HEVC streams published as `.hevc` are `.h265` (three further files are `.hevc`); the AV1 IVF and OBU streams are `.av1`;
  the AFsp AIFF-C files published as `.aif` are `.aifc`; one STEP file published as `.stp` is `.step`; a HWPX document published as
  `HWP2016.hwpx.zip.testfile` is `.hwpx`; the KF8 edition that Project Gutenberg serves as `pg11-images-kf8.mobi` is `.azw3`. The bytes are the publisher's, unchanged.
- A few FATE files are cut from a longer recording by their publisher (their names say `partial`); they stay because a truncated
  real file is a common input.
- GitHub raw URLs carry a commit or a release tag, and Debian and Arch packages come from archives that keep old versions. The
  FFmpeg collections, raw.pixls.us, Wikimedia Commons, the Library of Congress, kernel.org, the GNU and Slackware mirrors, the
  CentOS vault, Tiny Core, iPXE and the Open Preservation Foundation files are pinned by digest only, and a change at the host fails
  the run until the file is re-pinned (`bench/realworld/fetch.ts` never accepts other bytes).
- Selection: files from exploit databases (the `EDB-` and `CVE-` named test documents of LibreOffice), fuzzer outputs and files the
  project marks as failing import are not used, and neither are government form templates whose licence is not stated. The entries
  of `format-coverage-exceptions.json` say where that cost a format its third sample.
- To add a sample: download it into a new empty directory, never run it, identify it with a tool that is not the converter, add the
  manifest entry with the digest of the downloaded bytes and, if the source is new, its licence statement here and in `sources`.
