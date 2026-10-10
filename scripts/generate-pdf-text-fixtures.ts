/**
 * Generates the PDF text-extraction golden set in tests/fixtures/pdf-text/.
 *
 * Every fixture is authored here as HTML or flat OpenDocument XML (original prose, no third-party text), written to
 * `sources/`, and rendered to PDF by LibreOffice. The expected text (`<name>.truth.txt`) is written from the same
 * strings, never read back from a PDF, so it is an oracle independent of any reader under test. Run:
 *
 *   npx tsx scripts/generate-pdf-text-fixtures.ts
 *
 * LibreOffice and the fonts named below must be installed; the committed PDFs embed their fonts, so tests need
 * neither. See tests/fixtures/pdf-text/PROVENANCE.md.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const OUTPUT_DIR = path.join(__dirname, '..', 'tests', 'fixtures', 'pdf-text');
const SOURCE_DIR = path.join(OUTPUT_DIR, 'sources');
const SOFFICE_TIMEOUT_MS = 180_000;
const BODY_POINTS = 12;
const TWO_COLUMN_PARAGRAPHS = 40;

interface Fixture {
  name: string;
  /** Source file name inside sources/. */
  source: string;
  /** Contents of the source file. */
  markup: string;
  /** Paragraphs in reading order, as the document reads them. */
  truth: string[];
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function html(fontFamily: string, body: string, lang = 'en'): string {
  return `<!DOCTYPE html>
<html lang="${lang}"><head><meta charset="utf-8"><title>fixture</title>
<style>body{font-family:'${fontFamily}';font-size:${BODY_POINTS}pt}h1{font-size:20pt}</style></head>
<body>
${body}
</body></html>
`;
}

const LATIN_TITLE = 'Quarterly office findings';
const LATIN_PARAGRAPHS = [
  'The ET scan was effective: the first official certificate of the traffic office reached the staff before noon. Fluffy waffles differ from offices, and a well-known brand of coffee is brewed at 8:30.',
  'Evaluation of the second quarter shows steady growth in the fjord region. The ratio of effective to affluent customers rose from 12.5% to 14.8%, which the board called a sufficient result.',
  'Sets of reports (A, B, and C) were filed under reference number 2041-77. Dr. O’Neil replied: “We ship on Friday.” Questions go to the front office.',
];

const KOREAN = '대외비 문서는 승인된 직원만 열람할 수 있습니다. 모든 보고서는 분기마다 갱신되며 보관 기간은 오 년입니다.';
const JAPANESE = '本日の会議では、新しい製品の発売時期について話し合いました。担当者は来月までに計画書を提出します。';
const CHINESE = '本季度的销售报告显示，亚洲市场的增长速度超过了预期。财务部门将在下周发布详细的数据分析。';

const ARABIC = 'تقرير الربع الثاني يظهر نموا مطردا في المنطقة، وقد وافق المجلس على الخطة الجديدة في الاجتماع الأخير.';
const HEBREW = 'דוח הרבעון השני מראה צמיחה יציבה באזור, והמועצה אישרה את התוכנית החדשה בישיבה האחרונה.';
const ARABIC_MIXED = 'رقم الطلب 4521 تم إرساله إلى مكتب Berlin صباح الاثنين.';

const ADJECTIVES = ['quiet', 'broad', 'amber', 'narrow', 'steady', 'bright', 'hollow', 'distant', 'gentle', 'rugged'];
const NOUNS = ['harbor', 'orchard', 'ledger', 'lantern', 'bridge', 'meadow', 'archive', 'compass', 'quarry', 'garden'];
const VERBS = ['crosses', 'follows', 'circles', 'shelters', 'mirrors', 'borders', 'outlasts', 'guides', 'joins', 'divides'];
const PLACES = ['the northern road', 'an old mill', 'the river bend', 'a stone wall', 'the lower field'];

function columnParagraph(n: number): string {
  const label = String(n).padStart(2, '0');
  const a = ADJECTIVES[n % ADJECTIVES.length];
  const b = NOUNS[(n * 3) % NOUNS.length];
  const v = VERBS[(n * 7) % VERBS.length];
  const c = ADJECTIVES[(n * 5 + 2) % ADJECTIVES.length];
  const d = NOUNS[(n * 9 + 1) % NOUNS.length];
  const place = PLACES[n % PLACES.length];
  return `Item ${label}: the ${a} ${b} ${v} the ${c} ${d} near ${place}, and the keeper of record ${label} notes it twice in the weekly register.`;
}

const ODF_NAMESPACES = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"',
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"',
].join(' ');

interface OdfOptions {
  font: string;
  columns?: number;
  justify?: boolean;
  verticalWriting?: boolean;
  body: string;
}

function flatOdt(options: OdfOptions): string {
  const { font, columns = 1, justify = false, verticalWriting = false, body } = options;
  const writingMode = verticalWriting ? ' style:writing-mode="tb-rl"' : '';
  const textStyle = justify ? '<style:paragraph-properties fo:text-align="justify"/>' : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document ${ODF_NAMESPACES} office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.text">
 <office:font-face-decls><style:font-face style:name="${font}" svg:font-family="'${font}'"/></office:font-face-decls>
 <office:styles>
  <style:default-style style:family="paragraph"><style:paragraph-properties fo:margin-bottom="0.25cm"/><style:text-properties style:font-name="${font}" fo:font-size="${BODY_POINTS}pt" fo:language="en" fo:country="US"/></style:default-style>
  <style:style style:name="Body" style:family="paragraph">${textStyle}</style:style>
 </office:styles>
 <office:automatic-styles>
  <style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2cm" fo:margin-right="2cm"${writingMode}/></style:page-layout>
  <style:style style:name="Sect1" style:family="section"><style:section-properties text:dont-balance-text-columns="true"><style:columns fo:column-count="${columns}" fo:column-gap="1cm"/></style:section-properties></style:style>
 </office:automatic-styles>
 <office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1"/></office:master-styles>
 <office:body><office:text><text:section text:style-name="Sect1" text:name="Body1">
${body}
 </text:section></office:text></office:body>
</office:document>
`;
}

function odfParagraphs(paragraphs: string[]): string {
  return paragraphs.map((p) => `  <text:p text:style-name="Body">${esc(p)}</text:p>`).join('\n');
}

/** Words with their discretionary break points marked (U+00AD); the truth text drops the marks. */
const SOFT_HYPHEN = '\u00ad';
const HYPHENATION_SOURCE = [
  'Inter\u00adna\u00adtion\u00adal\u00adiza\u00adtion re\u00adquire\u00adments strength\u00aden the or\u00adgan\u00adiza\u00adtion\u00adal re\u00adspon\u00adsi\u00adbil\u00adi\u00adties of the ad\u00admin\u00adis\u00adtra\u00adtion. Not\u00adwith\u00adstand\u00ading the char\u00adac\u00adter\u00adis\u00adti\u00adcal\u00adly un\u00adcom\u00adpro\u00admis\u00ading spec\u00adi\u00adfi\u00adca\u00adtions, the doc\u00adu\u00admen\u00adta\u00adtion was straight\u00adfor\u00adward\u00adly com\u00adpre\u00adhen\u00adsi\u00adble.',
  'Un\u00adques\u00adtion\u00adably, tele\u00adcom\u00admu\u00adni\u00adca\u00adtions in\u00adfra\u00adstruc\u00adture de\u00advel\u00adop\u00adment ne\u00adces\u00adsi\u00adtates coun\u00adter\u00adin\u00adtu\u00adi\u00adtive re\u00adcon\u00adsid\u00ader\u00ada\u00adtion of elec\u00adtro\u00admag\u00adnet\u00adi\u00adcal\u00adly in\u00adcom\u00adpat\u00adi\u00adble in\u00adstru\u00admen\u00adta\u00adtion through\u00adout the es\u00adtab\u00adlish\u00adment.',
];
const HYPHENATION_PARAGRAPHS = HYPHENATION_SOURCE.map((p) => p.split(SOFT_HYPHEN).join(''));

const MULTIPAGE_PAGES = [
  ['First page heading', 'The opening page holds the introduction of the quarterly review and nothing else.'],
  ['Second page heading', 'The middle page continues with the findings of the regional offices in order.'],
  ['Third page heading', 'The closing page lists the conclusions and the date of the next review.'],
];

function fixtures(): Fixture[] {
  const columnTruth = Array.from({ length: TWO_COLUMN_PARAGRAPHS }, (_, i) => columnParagraph(i + 1));
  return [
    {
      name: 'latin',
      source: 'latin.html',
      markup: html('DejaVu Serif', `<h1>${esc(LATIN_TITLE)}</h1>\n${LATIN_PARAGRAPHS.map((p) => `<p>${esc(p)}</p>`).join('\n')}`),
      truth: [LATIN_TITLE, ...LATIN_PARAGRAPHS],
    },
    {
      name: 'cjk',
      source: 'cjk.html',
      markup: html(
        'Noto Sans CJK KR',
        `<p lang="ko" style="font-family:'Noto Sans CJK KR'">${esc(KOREAN)}</p>\n<p lang="ja" style="font-family:'Noto Sans CJK JP'">${esc(JAPANESE)}</p>\n<p lang="zh" style="font-family:'Noto Sans CJK SC'">${esc(CHINESE)}</p>`
      ),
      truth: [KOREAN, JAPANESE, CHINESE],
    },
    {
      name: 'rtl',
      source: 'rtl.html',
      markup: html(
        'Noto Naskh Arabic',
        `<p dir="rtl" lang="ar" style="font-family:'Noto Naskh Arabic'">${esc(ARABIC)}</p>\n<p dir="rtl" lang="he" style="font-family:'Noto Sans Hebrew'">${esc(HEBREW)}</p>\n<p dir="rtl" lang="ar" style="font-family:'Noto Naskh Arabic'">${esc(ARABIC_MIXED)}</p>`
      ),
      truth: [ARABIC, HEBREW, ARABIC_MIXED],
    },
    {
      name: 'two-column',
      source: 'two-column.fodt',
      markup: flatOdt({ font: 'DejaVu Serif', columns: 2, body: odfParagraphs(columnTruth) }),
      truth: columnTruth,
    },
    {
      name: 'hyphenated',
      source: 'hyphenated.fodt',
      markup: flatOdt({ font: 'DejaVu Serif', columns: 3, justify: true, body: odfParagraphs(HYPHENATION_SOURCE) }),
      truth: HYPHENATION_PARAGRAPHS,
    },
    {
      name: 'multipage',
      source: 'multipage.html',
      markup: html(
        'DejaVu Serif',
        MULTIPAGE_PAGES.map(([heading, text], i) => `<h1${i > 0 ? ' style="page-break-before:always"' : ''}>${esc(heading)}</h1>\n<p>${esc(text)}</p>`).join('\n')
      ),
      truth: MULTIPAGE_PAGES.flat(),
    },
    {
      name: 'vertical',
      source: 'vertical.fodt',
      markup: flatOdt({ font: 'Noto Sans CJK JP', verticalWriting: true, body: odfParagraphs([JAPANESE, '日本語の縦書きの文章は、行が右から左へ進みます。']) }),
      truth: [JAPANESE, '日本語の縦書きの文章は、行が右から左へ進みます。'],
    },
  ];
}

function renderPdf(sourceFile: string, outDir: string): string {
  const profile = path.join(outDir, 'profile');
  execFileSync(
    'soffice',
    ['--headless', `-env:UserInstallation=file://${profile}`, '--convert-to', 'pdf', '--outdir', outDir, sourceFile],
    { timeout: SOFFICE_TIMEOUT_MS, stdio: 'ignore' }
  );
  return path.join(outDir, `${path.basename(sourceFile).replace(/\.[^.]+$/, '')}.pdf`);
}

function main(): void {
  fs.mkdirSync(SOURCE_DIR, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-text-fixtures-'));
  try {
    for (const fixture of fixtures()) {
      const sourceFile = path.join(SOURCE_DIR, fixture.source);
      fs.writeFileSync(sourceFile, fixture.markup, 'utf-8');
      fs.writeFileSync(path.join(OUTPUT_DIR, `${fixture.name}.truth.txt`), `${fixture.truth.join('\n\n')}\n`, 'utf-8');
      const rendered = renderPdf(sourceFile, work);
      fs.copyFileSync(rendered, path.join(OUTPUT_DIR, `${fixture.name}.pdf`));
      console.log(`${fixture.name}: ${fs.statSync(rendered).size} bytes`);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main();
