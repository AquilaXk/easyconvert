# EasyConvert

[English](README.md) | [한국어](README.ko.md)

EasyConvert는 Next.js 15(App Router)와 TypeScript로 구축된 범용 파일 변환 플랫폼입니다. **12개 카테고리**, **302개 포맷**, **2,742개 변환 쌍**에 대해 결정론적인 파일 변환을 수행합니다.

인메모리 TypeScript 바이너리 엔진, 샌드박스 격리 네이티브 도구, Lua 스크립트 기반 Redis 작업 큐, S3 및 OCI 멀티파트 오브젝트 스토리지를 결합하여 손상되거나 위조된 입력은 즉시 거부(Fail-Closed)하고 파일은 정해진 일정에 따라 삭제합니다. 변환 결과는 처음 끝까지 내려받은 뒤 10분 또는 변환 1시간 뒤에 삭제하고, 업로드는 그 파일을 읽는 마지막 작업이 끝나고 10분 뒤에 삭제합니다(정책 결정 125).

---

## 핵심 기술 하이라이트

- **12개 카테고리 302개 포맷 지원**: Images, Documents, Archives, Video, Audio, Ebooks, Spreadsheets, Presentations, Data & Tables, Vector, Fonts, CAD & 3D 전반에 걸쳐 `2,742`개 변환 쌍을 지원합니다.
- **바이너리 변환 엔진**:
  - **HWP 5.0 OLE2 CFBF**: OLE2 복합 파일 바이너리 포맷 파서 및 빌더를 통해 문단과 표 구조를 추출하고 생성합니다.
  - **Cox-de Boor 곡선**: CAD 및 벡터 경로를 위한 B-스플라인 기저 함수 평가와 베지에 곡선 평탄화를 수행합니다.
  - **BZip2 엔진**: 버로우즈-휠러 변환(BWT), MTF(Move-To-Front), 허프만 코딩 기반 인코더 및 디코더를 포함합니다.
  - **색상 양자화(Color Quantization)**: Oklab k-d 트리, NeuQuant, Median Cut 팔레트 양자화와 오차 확산 디더링을 지원합니다.
  - **미디어 인코더**: 스트림 검증과 컨테이너 패키징을 포함한 오디오·비디오 트랜스코딩을 처리합니다.
  - **폰트 변환 엔진**: TrueType/OpenType SFNT 테이블 디렉터리 파서 및 폰트 상호 변환(TTF, OTF, WOFF, WOFF2, EOT, PFA, PFB, DFONT, BIN, SVG)을 제공합니다.
  - **검색 가능한 OCR**: 광학 문자 인식을 거쳐 투명 텍스트 레이어가 내장된 검색 가능한 PDF를 생성합니다.
- **Lua 스크립트 기반 Redis 작업 큐**: 비동기 큐 엔진(`src/lib/queue/bullmq-engine.ts`, `src/lib/queue/conversion-queue.ts`)이 `/api/v1/jobs`와 `/api/queue/jobs`를 구동하며 실시간 진행률 추적, 2단계 쿼터 예약, 재시도 제어, DAG 파이프라인, HMAC-SHA256 웹훅 알림을 처리합니다.
- **이어올리기(Resumable) 및 멀티파트 스토리지**: 공개 tus 1.0.0 및 사전 서명(Presigned) 직접 멀티파트 업로드(`/api/v1/uploads`, `/api/v1/uploads/direct`)와 웹 멀티파트 청크 업로드(`/api/storage/multipart`, `/api/storage/file/[...key]`)를 제공합니다.
- **동적 랜딩 라우트 및 API 레퍼런스**: 포맷 쌍별 `/[slug]` 페이지(예: `/pdf-to-docx`, `/png-to-webp`, `/mp4-to-mp3`)와 OpenAPI 3.1 명세(`/api/v1/openapi.json`)에서 생성되는 주제별 `/api-docs` 레퍼런스 페이지를 제공합니다.
- **Fail-Closed 처리와 정해진 삭제**: 모든 작업은 격리된 워커에서 실행되며, 결과와 업로드는 위의 일정에 따라 삭제됩니다. 손상된 페이로드, 위조된 매직 바이트, 미지원 변환 쌍은 조용한 폴백 없이 HTTP 400 또는 422 응답으로 즉시 거부합니다.

---

## 지원 포맷 매트릭스 (12개 카테고리)

<!-- registry-stats:start -->
| Category | Format Count | Supported Extensions |
| :--- | ---: | :--- |
| **Images** (`image`) | 49 | 3FR, AI, ARW, AVIF, BMP, CR2, CR3, CRW, CUR, DCR, DDS, DNG, EPS, ERF, EXR, GIF, HEIC, HEIF, ICNS, ICO, J2K, JFIF, JP2, JPEG, JPG, MOS, MRW, NEF, ORF, PBM, PCX, PEF, PGM, PNG, PNM, PPM, PSB, PSD, RAF, RAW, RW2, TGA, TIF, TIFF, WBMP, WEBP, X3F, XCF |
| **Documents** (`document`) | 43 | ABW, DJVU, DOC, DOCM, DOCX, DOT, DOTX, EML, FODT, HOCR, HTM, HTML, HWP, HWPX, LATEX, LOG, LWP, MAN, MD, MSG, ODD, ODG, ODT, OTT, OXPS, PAGES, PDB, PDF, PDFA, PUB, RST, RTF, SDW, SXW, TEX, TEXT, TXT, WPD, WPS, XHTML, XML, XPS, ZABW |
| **Archives** (`archive`) | 44 | 7Z, ACE, ALZ, ARC, ARJ, BZ, BZ2, CAB, CPIO, DEB, DMG, EAR, GZ, IMG, ISO, JAR, LHA, LZ, LZMA, LZO, RAR, RPM, RZ, TAR, TAR.7Z, TAR.BZ, TAR.BZ2, TAR.GZ, TAR.LZO, TAR.XZ, TAR.Z, TAR.ZST, TBZ, TBZ2, TGZ, TXZ, TZ, TZO, WAR, XZ, Z, ZIP, ZST, ZSTD |
| **Video** (`video`) | 37 | 3G2, 3GP, 3GPP, ASF, AV1, AVI, CAVS, DIVX, DV, DVR, F4V, FLV, H264, H265, HEVC, M2TS, M2V, M4V, MKV, MOD, MOV, MP4, MPEG, MPG, MTS, MXF, OGV, RM, RMVB, SWF, TS, VOB, WEBM, WEBP, WMV, WTV, XVID |
| **Audio** (`audio`) | 29 | AAC, AC3, AIF, AIFC, AIFF, ALAC, AMR, APE, AU, CAF, DSS, DTS, FLAC, M4A, M4B, MID, MIDI, MKA, MP3, MPC, OGA, OGG, OPUS, RA, SPX, VOC, WAV, WEBA, WMA |
| **Ebooks** (`ebook`) | 24 | AZW, AZW3, AZW4, CB7, CBC, CBR, CBT, CBZ, CHM, DJV, EPUB, FB2, HTMLZ, IBOOKS, LIT, LRF, MOBI, OEB, PML, PRC, RB, SNB, TCR, TXTZ |
| **Spreadsheets** (`spreadsheet`) | 18 | DBF, DIF, ET, FODS, NUMBERS, ODS, OTS, PRN, QPW, SDC, SLK, WK1, WKS, XLS, XLSM, XLSX, XLT, XLTX |
| **Presentations** (`presentation`) | 18 | DPS, FODP, KEY, KEYNOTES, ODP, OTP, POT, POTX, PPS, PPSX, PPT, PPTM, PPTX, PRESENTATION, SDA, SHW, SXD, SXI |
| **Data & Tables** (`data`) | 11 | CSV, JSON, JSONL, NDJSON, PARQUET, TAB, TOML, TSV, XML, YAML, YML |
| **Vector** (`vector`) | 10 | CDR, CGM, EMF, PS, SK, SK1, SVG, SVGZ, VSD, WMF |
| **Fonts** (`font`) | 10 | BIN, DFONT, EOT, OTF, PFA, PFB, SVG, TTF, WOFF, WOFF2 |
| **CAD & 3D** (`cad`) | 9 | DWF, DWG, DXF, IGES, IGS, OBJ, STEP, STL, STP |
<!-- registry-stats:end -->

`src/lib/registry.ts`를 수정한 뒤에는 아래 명령으로 `docs/generated/registry-stats.json`과 표를 다시 생성합니다.

```bash
npm run docs:generate
```

---

## 아키텍처 개요 (Architecture Overview)

```
easyconvert/
├── src/
│   ├── app/                         # Next.js App Router (페이지 및 API 라우트)
│   │   ├── [locale]/                # 다국어 UI 페이지 (변환기, /[slug], /api-docs)
│   │   ├── api/
│   │   │   ├── convert/             # 웹 동기식 변환 엔드포인트
│   │   │   │   └── batch/           # 일괄 변환 및 ZIP 번들링 엔드포인트
│   │   │   ├── fetch-url/           # 외부 URL 파일 가져오기
│   │   │   ├── formats/             # 포맷 레지스트리 및 카테고리 조회 API
│   │   │   ├── health/              # 서비스 헬스체크, 준비 상태 및 스모크 프로브
│   │   │   ├── keys/                # API 키 관리 및 시크릿 교체
│   │   │   ├── openapi.json/        # OpenAPI 3.1 명세 엔드포인트
│   │   │   ├── queue/               # 웹 비동기 작업 큐 엔드포인트
│   │   │   │   ├── jobs/            # 작업 생성 및 상태 조회 ([id])
│   │   │   │   └── stats/           # 큐 처리량 및 상태 지표
│   │   │   ├── storage/             # 오브젝트 스토리지 다운로드 및 멀티파트 라우트
│   │   │   │   ├── file/[...key]/   # 임시 아티팩트 다운로드
│   │   │   │   └── multipart/       # 멀티파트 청크 업로드 제어
│   │   │   ├── v1/                  # 공개 REST API v1 (/api/v1/*)
│   │   │   │   ├── archives/inspect/# 아카이브 구조 및 암호화 검사
│   │   │   │   ├── convert/         # 2단계 쿼터 예약 기반 동기 변환
│   │   │   │   ├── jobs/            # 비동기 작업 및 DAG 파이프라인 ([id])
│   │   │   │   ├── ocr/languages/   # 설치된 OCR 언어 카탈로그
│   │   │   │   ├── openapi.json/    # 공개 OpenAPI 3.1 명세
│   │   │   │   ├── storage/         # 고객 BYOS 스토리지 자격 증명 볼트
│   │   │   │   ├── uploads/         # tus 1.0.0 및 직접 멀티파트 업로드
│   │   │   │   ├── usage/           # API 사용량 및 쿼터 조회
│   │   │   │   └── webhooks/        # 웹훅 서명 시크릿 교체
│   │   │   └── webhooks/dlq/        # 웹훅 데드레터 큐(DLQ) 조회 및 재전송
│   │   ├── globals.css              # 디자인 시스템 변수 및 유틸리티
│   │   └── layout.tsx               # 루트 레이아웃 및 프로바이더
│   ├── components/                  # UI 및 API 문서 컴포넌트
│   └── lib/
│       ├── api/openapi/             # OpenAPI 3.1 스키마 및 경로 정의
│       ├── conversions/             # 바이너리 변환 엔진 및 디스패처
│       ├── queue/                   # Lua 스크립트 기반 Redis 작업 큐
│       │   ├── bullmq-engine.ts     # Redis Lua 큐 어댑터 및 인메모리 엔진
│       │   └── conversion-queue.ts  # 큐 매니저 및 작업 수명주기 조정기
│       ├── storage/                 # 로컬, S3, OCI 오브젝트 스토리지 백엔드
│       ├── registry.ts              # 302개 표준 포맷 정의 및 옵션 스키마
│       ├── registry-stats.ts        # 계산된 포맷, 카테고리, 변환 쌍 통계
│       ├── slug-parser.ts           # 동적 라우트 슬러그 파서 ([source]-to-[target])
│       └── types.ts                 # 공유 TypeScript 인터페이스 및 계약
├── docs/                            # 정책 결정, 배포 가이드, 생성된 통계 파일
├── scripts/                         # 빌드, 검증, 문서 생성 스크립트
├── tests/                           # Vitest 단위, 통합, 드리프트 테스트 스위트
├── sonar-project.properties         # SonarCloud 코드 품질 분석 설정
└── package.json
```

---

## API 레퍼런스

공개 v1 API의 레퍼런스 문서는 `/api-docs`(주제별 페이지 `/api-docs/quickstart`, `/api-docs/convert`, `/api-docs/jobs`, `/api-docs/uploads`, `/api-docs/downloads`, `/api-docs/formats`, `/api-docs/ocr-languages`, `/api-docs/archives`, `/api-docs/usage`)에서 제공하며, `GET /api/v1/openapi.json`(별칭 `GET /api/openapi.json`)의 OpenAPI 3.1 문서를 정본으로 사용합니다.

### 1. 공개 v1 변환 및 비동기 작업 (`/api/v1/*`)
- **동기 파일 변환**: `POST /api/v1/convert` (`multipart/form-data`, `file`, `targetFormat`, 선택적 `options`, 선택적 `Idempotency-Key` 헤더)
  - **문서 옵션** (`options` 내부):
    - `layout` (PDF → TXT): `true`이면 물리적 페이지 배치를 유지해 표의 행을 한 줄에 보존합니다. 기본값은 읽기 순서대로 열 단위로 텍스트를 추출합니다.
    - `imageDpi` (72-1200) 및 `jpegQuality` (1-100) (오피스 → PDF): 압축 프로필을 선택합니다. 기본값은 내장된 JPEG 스트림, 문서 개요, 링크를 변경 없이 유지합니다.
    - `pdfa` (`{"conformance": "pdfa-1b" | "pdfa-2b" | "pdfa-3b"}`) 또는 `pdfStandard`: PDF/A 출력을 요청합니다. 수준을 지정하지 않으면(`{}` 또는 `"pdfa"`) **PDF/A-2b**로 응답합니다. 모든 PDF/A 출력은 요청된 수준에 대해 veraPDF로 검증하며, veraPDF가 없으면 `503`, 검증에 실패하면 실패한 규칙 ID(`failedRules`)와 요청된 `profile`을 담아 `422`로 응답합니다.
- **비동기 작업 및 파이프라인**: `POST /api/v1/jobs`, `GET /api/v1/jobs`, `GET /api/v1/jobs/:id`, `DELETE /api/v1/jobs/:id`
  - 단일 변환, 순차 `tasks` 파이프라인, 다중 노드 `graph` DAG 작업을 Lua 스크립트 기반 Redis 큐에 등록하며 2단계 쿼터 예약과 HMAC-SHA256 웹훅 콜백을 지원합니다.
- **이어올리기(Resumable) 및 직접 멀티파트 업로드**:
  - tus 1.0.0 업로드: `OPTIONS /api/v1/uploads`, `POST /api/v1/uploads`, `HEAD /api/v1/uploads/:id`, `PATCH /api/v1/uploads/:id`, `DELETE /api/v1/uploads/:id`
  - 사전 서명 직접 멀티파트 업로드: `POST /api/v1/uploads/direct`, `PUT /api/v1/uploads/direct/part`, `POST /api/v1/uploads/direct/complete`, `DELETE /api/v1/uploads/direct/:id`
- **아카이브 검사 및 OCR 언어 조회**:
  - `POST /api/v1/archives/inspect`: 압축을 풀지 않고 아카이브 엔트리 메타데이터와 암호화 여부를 검사합니다.
  - `GET /api/v1/ocr/languages`: 설치된 OCR 언어 팩과 스크립트 메타데이터를 반환합니다.

### 2. 웹 애플리케이션 엔드포인트
- **동기 변환**: `POST /api/convert`, `POST /api/convert/batch`
- **포맷 레지스트리 조회**: `GET /api/formats` (선택적 `category`, `search` 쿼리 파라미터)
- **원격 URL 파일 가져오기**: `POST /api/fetch-url` (`{"url": "https://example.com/asset.png"}`)
- **웹 비동기 작업 큐**:
  - 작업 제출: `POST /api/queue/jobs` (`{"filename": "model.step", "targetFormat": "stl", "storageKey": "...", "fileSize": 1048576, "options": {}}`)
  - 작업 상태 조회 및 스트리밍: `GET /api/queue/jobs/:id` (`?stream=true`로 Server-Sent Events 지원)
  - 작업 취소: `DELETE /api/queue/jobs/:id`
  - 큐 상태 지표: `GET /api/queue/stats`
- **멀티파트 청크 스토리지 (`POST /api/storage/multipart`)**:
  - 업로드 초기화: `POST /api/storage/multipart?action=initiate`에 JSON 본문 `{"filename": "archive.zip", "mimeType": "application/zip", "totalSize": 104857600}`(선택적 `partSize`, 작업 전달 시 `contentType` 및 `fileSize` 메타데이터 지원)을 보내면 `uploadId`, `key`, `partSize`, `totalParts`, `expiresAt`을 반환합니다.
  - 청크 파트 전송: `POST /api/storage/multipart?action=chunk&uploadId=...&partNumber=1`에 바이너리 본문(`application/octet-stream`)과 `Content-Length`를 전송합니다.
  - 업로드 완료: `POST /api/storage/multipart?action=complete`에 `{"uploadId": "...", "parts": [{"partNumber": 1, "etag": "..."}]}`을 전송합니다.
  - 업로드 중단: `POST /api/storage/multipart?action=abort`에 `{"uploadId": "..."}`을 전송합니다.
  - 파일 다운로드: `GET /api/storage/file/[...key]`
- **서비스 헬스체크 및 진단**:
  - `GET /api/health`: `redis`(설정된 경우)와 `storage` 실시간 점검 결과에 따라 `{"status": "healthy" | "unhealthy"}`와 HTTP `200`(`healthy`) 또는 `503`(`unhealthy`)을 반환합니다. 네이티브 도구(`soffice`, `ffmpeg`, `ffprobe`, `pdftoppm`, `pdftotext`, `tesseract`, `7z`, `dcraw_emu`, `ebook-convert`)는 보조 구성 요소로 점검되며, 와일드카드(`*`) 스코프 API 키로 요청하면 `components` 필드에 구성 요소별 상태가 함께 포함됩니다.

---

## 시작하기

### 요구 사양

- Node.js >= 24 (활성 LTS)
- npm >= 10.x

### 설치

```bash
git clone https://github.com/AquilaXk/easyconvert.git
cd easyconvert
npm install
```

### 환경 변수 설정

- `KEY_HASH_PEPPER`: API 키 해시를 일반 SHA-256 대신 HMAC-SHA256으로 저장하는 서버 측 비밀 값입니다. 프로덕션에서는 32바이트 이상의 긴 무작위 값으로 설정해야 합니다. 새 값을 `KEY_HASH_PEPPER_PREVIOUS`와 함께 설정하면 기존 키를 첫 인증 시점에 무중단으로 재해시하여 교체할 수 있으며, `KEY_HASH_PEPPER_PREVIOUS` 없이 단독 교체하면 이전 값으로 해시된 키가 무효화됩니다.
- `KEY_HASH_PEPPER_PREVIOUS`: 선택 사항입니다. `KEY_HASH_PEPPER`를 무중단으로 교체할 때 이전 페퍼 비밀 값을 설정하면, 현재 `KEY_HASH_PEPPER`와 일치하지 않는 API 키를 `KEY_HASH_PEPPER_PREVIOUS`로 검증한 뒤 성공 시 현재 페퍼 해시로 자동 마이그레이션합니다.
- `JOB_SECRET_KEK`: 대기열 작업 데이터에 저장되는 서명 URL과 요청 헤더를 봉인하는 전용 비밀 값입니다(AES-256-GCM, 작업 ID에 결합). 프로덕션에서는 웹 앱과 모든 워커에 필수이며, `openssl rand -hex 32`처럼 32바이트 이상의 무작위 값을 사용하세요. JWT, 보관소, 암호화 비밀 값은 이 용도로 재사용하지 않습니다. 이 값이 없으면 `docker compose up`은 워커를 시작하지 않습니다. 프로덕션이 아니면 값이 없을 때 개발용 키를 사용합니다.
- `JOB_SECRET_KEK_PREVIOUS`: 선택 사항입니다. 키를 교체할 때 이전 `JOB_SECRET_KEK` 값을 넣으면 교체 전에 대기열에 들어간 작업을 계속 열 수 있습니다. 해당 작업이 끝나면 제거하세요. 설정되지 않은 키로 봉인된 작업은 알 수 없는 키 오류로 실패합니다.
- `EASYCONVERT_MAX_INPUT_PIXELS`: 변환 전에 정지 이미지(또는 문서 안의 이미지)가 선언할 수 있는 최대 픽셀 수입니다. 이보다 큰 이미지는 픽셀을 디코딩하기 전에 컨테이너 헤더만 읽고 HTTP 413으로 거부합니다. 기본값은 100000000(100메가픽셀)이며 십진수만 허용하고, 268402689(16383 x 16383)보다 크면 이 값으로 낮춥니다. 잘못된 값은 로그에 한 번 알리고 무시합니다. 프로세스 안에서 픽셀 단위로 처리하는 경로(Oklab/Riemersma 팔레트 양자화, 카메라 RAW 센서, Ultra HDR)에는 더 엄격한 내장 한도가 적용됩니다.
- `TRUSTED_PROXIES`: 클라이언트 IP 신뢰 모드이며 `NODE_ENV=production`에서는 필수입니다. 서버 앞단 프록시 홉의 CIDR 목록으로 설정하거나, 서버가 직접 노출된 경우 `none`으로 설정합니다(이 경우 모든 클라이언트가 하나의 속도 제한 버킷을 공유합니다). 설정하지 않으면 엣지가 API 라우트 요청에 503을 반환합니다.
- `TRUSTED_CDN`: 검증된 Cloudflare 엣지 홉의 `CF-Connecting-IP`를 신뢰하려면 `cloudflare`로 설정합니다.
- `TRUSTED_PROXY_HEADER`: 프록시가 관리하는 단일 전달 헤더이며 `x-forwarded-for`(기본값) 또는 `forwarded`입니다.

전체 배포 규약은 [docs/client-ip-trust.md](docs/client-ip-trust.md)와 [docs/configuration.md](docs/configuration.md)를 참고하세요.

### 개발 서버 실행

```bash
npm run dev
```

브라우저에서 [http://localhost:3000](http://localhost:3000)으로 접속합니다.

### 결정론적 검증 (Deterministic Verification)

Vitest 테스트 스위트를 실행합니다:

```bash
npm test
```

ESLint 정적 문법 및 규칙 검사:

```bash
npm run lint
```

코드 스멜 기준선 검사:

```bash
npm run guard:code-smells
```

### 프로덕션 빌드

```bash
npm run build
npm start
```

---

## 코드 품질 및 엔지니어링 표준

- **결정론적 테스트 스위트**: Vitest 단위, 통합, 드리프트 테스트를 통해 RFC 규격 준수, 수학적 기저 함수, OLE2 CFBF 구조, OpenAPI 계약, 메모리 안전성을 검증합니다.
- **Fail-Closed 보안 원칙**: 0바이트 파일, 미지원 확장자, 손상된 바이너리 헤더는 즉시 HTTP 400 또는 422 응답을 반환하여 손상된 출력이나 조용한 폴백이 생성되는 것을 방지합니다.
- **정해진 삭제**: 결과는 처음 끝까지 내려받은 뒤 10분 또는 변환 1시간 뒤까지, 업로드는 마지막 작업이 끝나고 10분 뒤까지 보관합니다(정책 결정 125).
- **SonarCloud 연동**: `sonar-project.properties` 설정을 통해 정적 코드 분석과 코드 품질 게이트를 유지합니다.

---

## 정책 결정

출력 기본값, 한도, 엔진, 품질 게이트 같은 변환·제품 정책은 근거와 트레이드오프와 함께 [docs/policy-decisions.md](docs/policy-decisions.md)에 기록합니다. 정책을 바꾸는 pull request에서 이 문서도 함께 갱신합니다.

## 라이선스 및 오픈소스 고지 (Licensing)

- **프로젝트 라이선스**: EasyConvert는 [MIT License](LICENSE)에 따라 배포됩니다.
- **서드파티 오픈소스 고지**: 프로덕션 의존성에 대한 전체 저작권 및 라이선스 고지는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 참고하십시오.
- **외부 도구, LGPL 재링크 및 특허 가이드**: 외부 CLI 도구(FFmpeg, Poppler, veraPDF)의 프로세스 격리 원칙, LGPL 재링크 의무, unRAR 컴포넌트 라이선스 조건 및 코덱 특허 관련 세부 안내는 [docs/licensing.md](docs/licensing.md)에서 확인할 수 있습니다.
