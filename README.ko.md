# EasyConvert

[![CI](https://github.com/AquilaXk/easyconvert/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/AquilaXk/easyconvert/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

[English](README.md) | [한국어](README.ko.md)

EasyConvert는 웹 앱과 HTTP API를 함께 제공하는 오픈소스 파일 변환 서비스예요. **13개 카테고리**, **308개 포맷**, **2,766개 변환 쌍**을 지원해요. 운영 중인 서비스는 <https://convert.aquilaxk.site>에서 쓸 수 있어요.

[서비스 바로가기](https://convert.aquilaxk.site) · [API 문서](https://convert.aquilaxk.site/api-docs) · [설정](docs/configuration.md) · [보안 정책](SECURITY.md)

## 주요 기능

- **여러 포맷을 한 API로.** 이미지(카메라 RAW 포함), 문서, 압축 파일, 영상, 오디오, 자막, 전자책, 스프레드시트, 프레젠테이션, 데이터 파일, 벡터 그래픽, 폰트, CAD·3D를 변환해요.
- **샌드박스 엔진.** LibreOffice, FFmpeg, libvips, Poppler, Tesseract, 7-Zip, Calibre, veraPDF는 작업마다 격리된 샌드박스에서 외부 도구로 실행해요. 일부 포맷은 프로세스 안의 TypeScript 엔진이 처리해요. HWP 5.0(OLE2 CFBF), BZip2, TrueType/OpenType 폰트 테이블, B-스플라인·베지에 경로 평탄화, Oklab·NeuQuant 팔레트 양자화가 여기에 들어가요.
- **검색 가능한 OCR.** 스캔한 입력을 텍스트 레이어가 있는 PDF로 바꿔요.
- **PDF/A 출력.** 모든 PDF/A 결과를 요청한 수준에 맞춰 veraPDF로 검증해요.
- **동기 변환과 큐 변환.** `POST /api/v1/convert`는 요청 안에서 바로 응답해요. `POST /api/v1/jobs`는 단일 변환, `tasks` 파이프라인, `graph` DAG를 Redis 기반 큐에 넣고, 재시도·진행률·HMAC-SHA256 서명 웹훅을 지원해요.
- **큰 파일 업로드.** tus 1.0.0 이어올리기와 사전 서명 직접 멀티파트 업로드를 지원하고, 저장소는 S3, OCI, 로컬 디스크를 쓸 수 있어요.
- **잘못된 입력은 거부해요.** 0바이트 파일, 위조된 매직 바이트, 손상된 헤더, 지원하지 않는 변환 쌍은 HTTP 400 또는 422로 거부해요. 조용한 대체 처리는 없어요.
- **정해진 시점에 삭제해요.** 변환 결과는 처음 끝까지 내려받은 뒤 10분 또는 변환 1시간 뒤에, 업로드는 그 파일을 읽는 마지막 작업이 끝나고 10분 뒤에 삭제해요(정책 결정 125).
- **다국어 화면과 포맷 쌍 페이지.** `/pdf-to-docx`, `/png-to-webp`, `/mp4-to-mp3` 같은 페이지와 OpenAPI 3.1 문서에서 만든 API 문서 페이지를 제공해요.

## 지원 포맷

아래 포맷을 읽고 써요. 포맷별로 지원하는 변환 쌍은 `GET /api/formats`로 조회할 수 있어요.

<!-- registry-stats:start -->
| Category | Format Count | Supported Extensions |
| :--- | ---: | :--- |
| **Images** (`image`) | 50 | 3FR, AI, ARW, AVIF, BMP, CR2, CR3, CRW, CUR, DCR, DDS, DNG, EPS, ERF, EXR, GIF, HEIC, HEIF, ICNS, ICO, J2K, JFIF, JP2, JPEG, JPG, JXL, MOS, MRW, NEF, ORF, PBM, PCX, PEF, PGM, PNG, PNM, PPM, PSB, PSD, RAF, RAW, RW2, TGA, TIF, TIFF, WBMP, WEBP, X3F, XCF |
| **Documents** (`document`) | 43 | ABW, DJVU, DOC, DOCM, DOCX, DOT, DOTX, EML, FODT, HOCR, HTM, HTML, HWP, HWPX, LATEX, LOG, LWP, MAN, MD, MSG, ODD, ODG, ODT, OTT, OXPS, PAGES, PDB, PDF, PDFA, PUB, RST, RTF, SDW, SXW, TEX, TEXT, TXT, WPD, WPS, XHTML, XML, XPS, ZABW |
| **Archives** (`archive`) | 44 | 7Z, ACE, ALZ, ARC, ARJ, BZ, BZ2, CAB, CPIO, DEB, DMG, EAR, GZ, IMG, ISO, JAR, LHA, LZ, LZMA, LZO, RAR, RPM, RZ, TAR, TAR.7Z, TAR.BZ, TAR.BZ2, TAR.GZ, TAR.LZO, TAR.XZ, TAR.Z, TAR.ZST, TBZ, TBZ2, TGZ, TXZ, TZ, TZO, WAR, XZ, Z, ZIP, ZST, ZSTD |
| **Video** (`video`) | 37 | 3G2, 3GP, 3GPP, ASF, AV1, AVI, CAVS, DIVX, DV, DVR, F4V, FLV, H264, H265, HEVC, M2TS, M2V, M4V, MKV, MOD, MOV, MP4, MPEG, MPG, MTS, MXF, OGV, RM, RMVB, SWF, TS, VOB, WEBM, WEBP, WMV, WTV, XVID |
| **Audio** (`audio`) | 29 | AAC, AC3, AIF, AIFC, AIFF, ALAC, AMR, APE, AU, CAF, DSS, DTS, FLAC, M4A, M4B, MID, MIDI, MKA, MP3, MPC, OGA, OGG, OPUS, RA, SPX, VOC, WAV, WEBA, WMA |
| **Subtitles** (`subtitle`) | 5 | ASS, SRT, SSA, SUB, VTT |
| **Ebooks** (`ebook`) | 24 | AZW, AZW3, AZW4, CB7, CBC, CBR, CBT, CBZ, CHM, DJV, EPUB, FB2, HTMLZ, IBOOKS, LIT, LRF, MOBI, OEB, PML, PRC, RB, SNB, TCR, TXTZ |
| **Spreadsheets** (`spreadsheet`) | 18 | DBF, DIF, ET, FODS, NUMBERS, ODS, OTS, PRN, QPW, SDC, SLK, WK1, WKS, XLS, XLSM, XLSX, XLT, XLTX |
| **Presentations** (`presentation`) | 18 | DPS, FODP, KEY, KEYNOTES, ODP, OTP, POT, POTX, PPS, PPSX, PPT, PPTM, PPTX, PRESENTATION, SDA, SHW, SXD, SXI |
| **Data & Tables** (`data`) | 11 | CSV, JSON, JSONL, NDJSON, PARQUET, TAB, TOML, TSV, XML, YAML, YML |
| **Vector** (`vector`) | 10 | CDR, CGM, EMF, PS, SK, SK1, SVG, SVGZ, VSD, WMF |
| **Fonts** (`font`) | 10 | BIN, DFONT, EOT, OTF, PFA, PFB, SVG, TTF, WOFF, WOFF2 |
| **CAD & 3D** (`cad`) | 9 | DWF, DWG, DXF, IGES, IGS, OBJ, STEP, STL, STP |
<!-- registry-stats:end -->

`src/lib/registry.ts`를 수정한 뒤에는 아래 명령으로 `docs/generated/registry-stats.json`과 위 표를 다시 만들어요.

```bash
npm run docs:generate
```

## 빠른 시작

필요한 것은 Node.js 24 이상, npm 10 이상, 워커를 띄울 Docker(Compose 포함)예요.

```bash
git clone https://github.com/AquilaXk/easyconvert.git
cd easyconvert
npm install
docker compose up -d   # Redis와 워커 1개, 로컬 스토리지, 클라우드 설정과 시크릿 불필요
npm run dev            # 웹 앱: http://localhost:3000
```

`docker compose up`은 Redis와 모든 큐를 처리하는 워커를 띄워요. 리소스 등급별 워커를 따로 쓰려면 `docker compose --profile split up -d --scale worker=0`을 실행하세요. 프로덕션 빌드는 `npm run build`와 `npm start`로 해요.

프로덕션 스택(웹, 워커, Redis, 리소스 한도)은 `docker-compose.prod.yml`이에요. 자세한 내용은 [docs/deploy-oci.md](docs/deploy-oci.md)를 보세요.

## 설정

서버와 워커는 시작할 때 환경 변수 전체를 검증하고, 형식이 잘못된 값이 있으면 실행하지 않아요. 변수 전체는 [docs/configuration.md](docs/configuration.md)에 있고, 시작용 파일은 [docs/configuration.example.env](docs/configuration.example.env)예요. 프로덕션에서 특히 중요한 설정은 아래와 같아요.

- `KEY_HASH_PEPPER`: API 키 해시를 일반 SHA-256 대신 HMAC-SHA256으로 저장하는 서버 측 비밀 값이에요. 32바이트 이상의 무작위 값을 쓰세요. 무중단으로 교체하려면 새 값을 설정하고 이전 값을 `KEY_HASH_PEPPER_PREVIOUS`에 넣어요. 이전 값에만 맞는 키는 첫 인증 때 검증하고 새 값으로 다시 해시해요. `KEY_HASH_PEPPER_PREVIOUS` 없이 교체하면 기존 키가 무효가 돼요.
- `JOB_SECRET_KEK`: 큐에 저장되는 작업 데이터의 서명 URL과 요청 헤더를 봉인하는 전용 비밀 값이에요(AES-256-GCM, 작업 ID에 결합). 프로덕션에서는 웹 앱과 모든 워커에 필요해요. `openssl rand -hex 32` 같은 값을 쓰고, JWT·보관소·암호화 비밀 값은 재사용하지 마세요. 이 값이 없으면 `docker-compose.prod.yml`은 워커를 시작하지 않아요. 프로덕션이 아니면 개발용 키를 써요.
- `JOB_SECRET_KEK_PREVIOUS`: 선택 사항이에요. 교체할 때 이전 `JOB_SECRET_KEK` 값을 넣으면 교체 전에 큐에 들어간 작업을 계속 열 수 있어요. 그 작업이 끝나면 지우세요. 설정하지 않은 키로 봉인된 작업은 알 수 없는 키 오류로 실패해요.
- `EASYCONVERT_MAX_INPUT_PIXELS`: 정지 이미지(또는 문서 안의 이미지)가 선언할 수 있는 최대 픽셀 수예요. 이보다 큰 이미지는 픽셀을 디코딩하기 전에 컨테이너 헤더만 읽고 HTTP 413으로 거부해요. 기본값은 100000000(100메가픽셀)이고 십진수만 허용해요. 268402689(16383 x 16383)보다 크게 지정하면 이 값으로 낮춰요. 잘못된 값은 로그에 한 번 남기고 무시해요. 프로세스 안에서 픽셀 단위로 처리하는 경로(Oklab·Riemersma 팔레트 양자화, 카메라 RAW 센서, Ultra HDR)에는 더 엄격한 내장 한도가 있어요.
- `TRUSTED_PROXIES`: 클라이언트 IP 신뢰 모드예요. `NODE_ENV=production`에서는 꼭 설정해야 해요. 서버 앞 프록시 홉의 CIDR 목록을 넣고, 서버가 직접 노출되면 `none`을 넣어요(이때는 모든 클라이언트가 속도 제한 버킷 하나를 공유해요). 설정하지 않으면 엣지가 API 요청에 503을 돌려줘요.
- `TRUSTED_CDN`: 검증된 Cloudflare 엣지 홉의 `CF-Connecting-IP`를 신뢰하려면 `cloudflare`로 설정해요.
- `TRUSTED_PROXY_HEADER`: 프록시가 관리하는 전달 헤더 하나예요. `x-forwarded-for`(기본값) 또는 `forwarded`예요.

[docs/client-ip-trust.md](docs/client-ip-trust.md)도 함께 보세요.

## API

API 문서는 `/api-docs`에서 볼 수 있어요(주제별 페이지: `quickstart`, `convert`, `jobs`, `uploads`, `downloads`, `formats`, `ocr-languages`, `archives`, `usage`). OpenAPI 3.1 문서는 `GET /api/v1/openapi.json`(별칭 `GET /api/openapi.json`)이에요. TypeScript와 Python 클라이언트는 [sdk/](sdk)에 있어요.

파일을 동기 방식으로 변환하는 예시예요.

```bash
curl -X POST https://convert.aquilaxk.site/api/v1/convert \
  -H "Authorization: Bearer $EASYCONVERT_API_KEY" \
  -F "file=@report.docx" \
  -F "targetFormat=pdf" \
  -o response.json
```

API 키는 `x-api-key` 헤더로도 보낼 수 있어요. 응답은 `fileId`, `fileName`, `mimeType`, `size`, `downloadUrl`, `expiresAt`이 담긴 JSON이고, 결과가 작으면 `dataUri`도 들어 있어요. `Accept: application/octet-stream`(또는 `?raw=true`)을 보내면 변환된 바이트를 바로 받아요.

```bash
curl -X POST "https://convert.aquilaxk.site/api/v1/convert?raw=true" \
  -H "Authorization: Bearer $EASYCONVERT_API_KEY" \
  -F "file=@photo.png" -F "targetFormat=webp" -o photo.webp
```

계정이 없는 호출자에게는 하루 한도가 있어요(정책 결정 16, [docs/policy-decisions.md](docs/policy-decisions.md)).

### 공개 v1 (`/api/v1/*`)

- **동기 변환**: `POST /api/v1/convert` (`multipart/form-data`, `file`, `targetFormat`, 선택 `options`, 선택 `Idempotency-Key` 헤더).
  - `layout` (PDF → TXT): `true`이면 페이지 배치를 유지해서 표의 행이 한 줄로 남아요. 기본값은 읽기 순서대로 열 단위로 텍스트를 뽑아요.
  - `imageDpi` (72-1200)와 `jpegQuality` (1-100) (오피스 → PDF): 압축 프로필을 골라요. 기본값은 내장 JPEG 스트림, 문서 개요, 링크를 그대로 둬요.
  - `pdfa` (`{"conformance": "pdfa-1b" | "pdfa-2b" | "pdfa-3b"}`) 또는 `pdfStandard`: PDF/A 출력을 요청해요. 수준을 정하지 않으면(`{}` 또는 `"pdfa"`) PDF/A-2b로 응답해요. veraPDF가 없으면 `503`이고, 검증에 실패하면 실패한 규칙 ID(`failedRules`)와 요청한 `profile`을 담아 `422`로 응답해요.
- **작업과 파이프라인**: `POST /api/v1/jobs`, `GET /api/v1/jobs`, `GET /api/v1/jobs/:id`, `DELETE /api/v1/jobs/:id`. 단일 변환, 순차 `tasks` 파이프라인, 다중 노드 `graph` DAG를 지원하고, 2단계 쿼터 예약과 선택적 HMAC-SHA256 웹훅 콜백을 제공해요.
- **tus 1.0.0 업로드**: `OPTIONS`·`POST /api/v1/uploads`, `HEAD`·`PATCH`·`DELETE /api/v1/uploads/:id`.
- **직접 멀티파트 업로드**: `POST /api/v1/uploads/direct`, `PUT /api/v1/uploads/direct/part`, `POST /api/v1/uploads/direct/complete`, `DELETE /api/v1/uploads/direct/:id`.
- **압축 파일 검사**: `POST /api/v1/archives/inspect`는 압축을 풀지 않고 엔트리 목록과 암호화 여부를 알려줘요.
- **OCR 언어**: `GET /api/v1/ocr/languages`는 설치된 언어 팩과 스크립트 메타데이터를 돌려줘요.

### 웹 앱 엔드포인트

- `POST /api/convert`, `POST /api/convert/batch`(ZIP 묶음): 동기 변환이에요.
- `GET /api/formats`: 포맷 레지스트리 조회예요. 선택 쿼리 파라미터는 `category`, `search`예요.
- `POST /api/fetch-url`: 원격 URL 가져오기예요. 본문은 `{"url": "https://example.com/asset.png"}`예요.
- `POST /api/queue/jobs`에 `{"filename": "model.step", "targetFormat": "stl", "storageKey": "...", "fileSize": 1048576, "options": {}}`를 보내면 작업을 제출해요. `GET /api/queue/jobs/:id`로 상태를 조회하고(`?stream=true`는 Server-Sent Events), `DELETE /api/queue/jobs/:id`로 취소하고, `GET /api/queue/stats`로 큐 지표를 봐요.
- `POST /api/storage/multipart`의 `action` 값은 아래와 같아요.
  - `initiate`: JSON 본문 `{"filename": "archive.zip", "mimeType": "application/zip", "totalSize": 104857600}`(선택 `partSize`, 작업 전달 때는 `contentType`과 `fileSize`)을 보내면 `uploadId`, `key`, `partSize`, `totalParts`, `expiresAt`을 돌려줘요.
  - `chunk`: `?action=chunk&uploadId=...&partNumber=1`에 `application/octet-stream` 본문과 `Content-Length`를 보내요.
  - `complete`: `{"uploadId": "...", "parts": [{"partNumber": 1, "etag": "..."}]}`를 보내요.
  - `abort`: `{"uploadId": "..."}`를 보내요.
  - `GET /api/storage/file/[...key]`로 저장된 파일을 내려받아요.
- `GET /api/health`: `redis`(설정한 경우)와 `storage` 점검 결과에 따라 `{"status": "healthy" | "unhealthy"}`와 HTTP `200` 또는 `503`을 돌려줘요. 네이티브 도구(`soffice`, `ffmpeg`, `ffprobe`, `pdftoppm`, `pdftotext`, `tesseract`, `7z`, `dcraw_emu`, `ebook-convert`)는 보조 구성 요소로 점검해요. 와일드카드(`*`) 스코프 API 키로 요청하면 `components`도 함께 와요.

## 아키텍처

웹 앱(Next.js 15 App Router, TypeScript)이 요청을 받고 쿼터를 확인해요. 작업은 Redis(Lua 스크립트)에 쌓이고, 워커가 변환마다 샌드박스 자식 프로세스를 띄워 처리해요. 파일은 로컬 디스크, S3, OCI 오브젝트 스토리지에 둬요.

```
easyconvert/
├── src/
│   ├── app/                 # Next.js 페이지와 API 라우트
│   │   ├── [locale]/        # 다국어 UI (변환기, /[slug], /api-docs)
│   │   └── api/             # convert, formats, queue, storage, keys, health, v1/*
│   ├── components/          # UI와 API 문서 컴포넌트
│   ├── lib/
│   │   ├── api/openapi/     # OpenAPI 3.1 스키마와 경로
│   │   ├── conversions/     # 변환 엔진과 디스패처
│   │   ├── queue/           # Redis 큐 (bullmq-engine.ts, conversion-queue.ts)
│   │   ├── storage/         # 로컬, S3, OCI 스토리지 백엔드
│   │   ├── registry.ts      # 표준 포맷 정의와 옵션
│   │   └── slug-parser.ts   # [source]-to-[target] 라우트 파서
│   └── worker/              # 큐 워커 진입점
├── sdk/                     # TypeScript, Python 클라이언트
├── bench/                   # 품질·속도 벤치마크
├── docs/                    # 정책 결정, 배포, 설정, 생성된 통계
├── scripts/                 # 빌드, 검증, 문서 생성 스크립트
├── tests/                   # Vitest 단위, 통합, 드리프트 테스트
├── Dockerfile.web, Dockerfile.worker
└── docker-compose.yml, docker-compose.prod.yml
```

## 개발

```bash
npm test                   # Vitest (먼저 guard:anti-cheat 실행)
npm run lint
npm run guard:code-smells  # src에 새 코드 스멜이 없는지 검사
npm run bench:quality      # 변환 품질 벤치마크
```

- **코드 스멜 래칫.** `npm run guard:code-smells`는 `src/**/*.{ts,tsx}`에 ESLint 규칙 `complexity` 30, `max-depth` 5, `max-lines-per-function` 250, `max-params` 6, `max-lines` 1500, `no-nested-ternary`, `no-explicit-any`를 적용해요. 인라인 `eslint-disable` 주석은 무시해요. 기존 위반은 파일, 규칙, 함수 이름을 키로 `.github/code-smell-baseline.json`에 기록해요. 기준선은 줄어들기만 해요. `NEW`나 `GREW` 줄은 코드를 고쳐서 없애고, 스멜을 지웠다면 `npm run guard:code-smells -- --update`로 줄어든 기준선을 커밋해요.
- **정책 결정.** 출력 기본값, 한도, 엔진, 품질 게이트는 근거와 함께 [docs/policy-decisions.md](docs/policy-decisions.md)에 기록해요. 정책을 바꾸는 커밋에서 이 문서도 함께 고쳐요.
- **운영.** [docs/operations/README.md](docs/operations/README.md), [docs/deploy-oci.md](docs/deploy-oci.md), [docs/slo.md](docs/slo.md)를 보세요.
- **정적 분석.** SonarCloud를 쓰고, 설정은 `sonar-project.properties`에 있어요.

관리자는 한 명이에요. 변경은 `main`에 바로 올리고 push마다 CI가 돌아요. 남은 일은 [TODO.md](TODO.md)에 있어요. 배포할 때마다 릴리스에 태그를 달고 짧은 노트를 직접 써요([docs/deploy-oci.md](docs/deploy-oci.md)의 "Releases", [CHANGELOG.md](CHANGELOG.md) 참고).

## 보안

취약점은 [SECURITY.md](SECURITY.md)에 적힌 방법으로 비공개 제보해 주세요. 공개 이슈로 올리지 마세요.

## 라이선스

EasyConvert는 [Apache License 2.0](LICENSE)로 배포해요. 자체 라이선스를 유지하는 부분은 [NOTICE](NOTICE)에 적혀 있어요. 2026-11-12 이전에 공개한 버전은 MIT License로 배포했어요.

- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md): 프로덕션 의존성의 저작권과 라이선스 고지예요.
- [docs/licensing.md](docs/licensing.md): 외부 CLI 도구(FFmpeg, Poppler, veraPDF), LGPL 재링크, unRAR 조건, 코덱 특허 안내예요.
