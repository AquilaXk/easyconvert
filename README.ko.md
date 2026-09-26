# EasyConvert

[English](README.md) | [한국어](README.ko.md)

EasyConvert는 Next.js 14(App Router), TypeScript, 그리고 고유한 라벤더 디자인 시스템을 기반으로 구축된 고성능 범용 파일 변환 플랫폼입니다. **12개 카테고리**, **292개 포맷**, 그리고 **2,156개의 검증된 변환 경로**에 대해 안정적이고 결정론적인 변환 환경을 제공합니다.

순수 TypeScript 기반 인메모리 바이너리 엔진, BullMQ 분산 비동기 작업 큐, S3 및 OCI 멀티파트 청크 스토리지 추상화를 통합하여 브라우저 및 REST API 환경 모두에서 엄격한 무보관(Zero-Retention) 원칙과 실패 시 즉시 차단(Fail-Closed) 보안 아키텍처를 철저히 보장합니다.

---

## 핵심 기술 하이라이트

- **12개 도메인에 걸친 292개 포맷 지원**: 이미지, 문서, 스프레드시트, 프레젠테이션, 한글 오피스(HWP), 벡터 및 CAD, 폰트, 오디오, 비디오, 전자책, 구조화 데이터, 아카이브 포맷 전반 지원.
- **순수 TypeScript 바이너리 알고리즘 엔진**:
  - **HWP 5.0 OLE2 CFBF**: OLE2 복합 파일 바이너리 포맷 파서 및 양방향 생성기를 통해 문단, 표(Table) 구조 완벽 추출 및 렌더링.
  - **Cox-de Boor NURBS 알고리즘**: STEP 및 IGES B-Rep 형상에 대한 재귀적 기저 함수 평가 및 적응형 $(u, v)$ 테셀레이터 구현.
  - **순수 BZip2 엔진**: 버로우즈-휠러 변환(BWT), MTF(Move-To-Front), 허프만 코딩 기반 네이티브 인코더/디코더.
  - **색상 양자화(Color Quantization)**: NeuQuant(1994) 신경망 가스 알고리즘 및 Median Cut(1982) 알고리즘과 Floyd-Steinberg 오차 확산 디더링 지원.
  - **순수 미디어 인코더**: 순수 인메모리 MP3 MDCT 주파수 스펙트럼 양자화 및 ISO BMFF MP4 컨테이너 기반 H.264 NAL 베이스라인 인코더.
  - **폰트 변환 엔진**: TrueType/OpenType SFNT 테이블 디렉터리 파서, 폰트 상호 변환(TTF, OTF, WOFF, WOFF2, EOT, SVG Font), 2차 베지에 곡선 추출.
  - **검색 가능한 OCR**: OCR 광학 문자 인식을 거쳐 투명 텍스트 레이어가 내장된 검색 가능한 PDF 자동 생성.
- **BullMQ 기반 분산 비동기 작업 큐**: 대용량 및 장시간 변환 작업을 위한 비동기 큐 시스템(`/api/queue/jobs`, `/api/queue/stats`), 실시간 진행률 추적, 재시도 제어 및 웹훅 연동.
- **S3 & OCI 멀티파트 청크 스토리지**: 대용량 바이너리 처리를 위한 멀티파트 청크 업로드 엔진(`/api/storage/multipart`, `/api/storage/file/[...key]`) 및 만료 즉시 자동 삭제.
- **동적 SEO 변환 서브페이지**: 포맷 쌍별 최적화된 동적 `/[slug]` 서브페이지(예: `/pdf-to-docx`, `/png-to-webp`, `/mp4-to-mp3`)와 파라미터 가이드, FAQ 제공.
- **Fail-Closed 및 Zero-Retention 보안**: 모든 파일은 변환 즉시 메모리에서 영구 소멸되며, 손상된 헤더나 비정상 파일은 조용한 폴백(Silent fallback) 없이 HTTP 400 Bad Request로 즉시 거부.
- **시그니처 라벤더 디자인 시스템**: 고대비 타이포그래피, 직관적인 인터랙션, 라이트/다크 테마를 완벽 지원하는 정밀한 라벤더 컬러 팔레트.

---

## 지원 포맷 매트릭스 (12개 카테고리)

| 카테고리 | 지원 포맷 수 | 주요 지원 확장자 |
| :--- | :--- | :--- |
| **이미지 & RAW** | 68개 | PNG, JPG, JPEG, WebP, AVIF, GIF, BMP, TIFF, SVG, ICO, ICNS, EPS, 3FR, CRW, NEF, ARW, DNG, RAF, RW2, HEIC |
| **문서** | 32개 | PDF, DOCX, DOC, ODT, RTF, TXT, MD, HTML, XHTML, EPUB, AZW4, XPS, ABW, WPS, SXW |
| **스프레드시트** | 18개 | XLSX, XLS, CSV, TSV, ODS, ET, Numbers, XLSM, XLSB, XML, TAB |
| **프레젠테이션** | 16개 | PPTX, PPT, ODP, DPS, Keynote, PPS, PPSX, POT, POTX, VSDX |
| **한글 오피스 (HWP)** | 4개 | HWP (5.0 OLE2 CFBF), HWPX, HWT, HWTX |
| **벡터 & CAD** | 28개 | DXF, DWG, SVG, EMF, WMF, CGM, CDR, STEP, STP, IGES, IGS, STL, OBJ, PLY, DWF |
| **폰트** | 8개 | TTF, OTF, WOFF, WOFF2, EOT, SVG Font, PFA, PFB |
| **오디오** | 22개 | MP3, WAV, FLAC, AAC, OGG, M4A, WMA, AIFF, AC3, AMR, OPUS, MID |
| **비디오** | 26개 | MP4, WebM, AVI, MOV, MKV, FLV, WMV, MPEG, 3GP, M4V, TS, VOB |
| **전자책** | 14개 | EPUB, MOBI, AZW3, AZW, FB2, CBZ, CBR, LIT, LRF, PDB |
| **구조화 데이터** | 18개 | JSON, JSONL, NDJSON, YAML, YML, XML, CSV, TSV, TOML, SQL, PLIST |
| **아카이브 (압축)** | 38개 | ZIP, TAR, GZ, TGZ, BZ2, TBZ2, 7Z, RAR, XZ, Z, ISO, CAB, ARJ |

---

## 아키텍처 개요 (Architecture Overview)

```
easyconvert/
├── src/
│   ├── app/                         # Next.js App Router (페이지 및 API 라우트)
│   │   ├── [slug]/                  # 동적 포맷 변환 서브페이지 (예: /pdf-to-docx)
│   │   ├── api/
│   │   │   ├── convert/             # 동기식 변환 엔드포인트
│   │   │   │   └── batch/           # 일괄 변환 및 ZIP 압축 번들링 엔드포인트
│   │   │   ├── fetch-url/           # 외부 URL 파일 가져오기
│   │   │   ├── formats/             # 포맷 레지스트리 및 카테고리 조회 API
│   │   │   ├── health/              # 서비스 헬스체크 및 변환 엔진 가용성
│   │   │   ├── queue/               # BullMQ 분산 비동기 작업 큐
│   │   │   │   ├── jobs/            # 작업 생성 및 상태 조회 ([id])
│   │   │   │   └── stats/           # 큐 처리량 및 성능 지표
│   │   │   ├── storage/             # S3/OCI 멀티파트 청크 오브젝트 스토리지
│   │   │   │   ├── file/[...key]/   # 임시 아티팩트 다운로드
│   │   │   │   └── multipart/       # 멀티파트 업로드 제어
│   │   │   └── v2/                  # 인터랙티브 API v2 문서 대시보드
│   │   ├── login/                   # 사용자 로그인 페이지
│   │   ├── register/                # 사용자 회원가입 페이지
│   │   ├── pricing/                 # 요금제 플랜 및 크레딧 계산 테이블
│   │   ├── globals.css              # 라벤더 디자인 시스템 변수 및 Tailwind 유틸리티
│   │   ├── layout.tsx               # 루트 레이아웃 및 테마 프로바이더
│   │   └── page.tsx                 # 변환기 메인 대시보드
│   ├── components/                  # 재사용 가능한 UI 컴포넌트
│   │   ├── AuthModal.tsx            # 로그인/회원가입 모달
│   │   ├── ConversionQueue.tsx      # 실시간 변환 대기열, 진행률 및 ZIP 다운로드
│   │   ├── FaqSection.tsx           # 아코디언 자주 묻는 질문(FAQ)
│   │   ├── Features.tsx             # 무보관 보안 및 기술 하이라이트
│   │   ├── Footer.tsx               # 브랜드 푸터 및 서비스 상태 표시
│   │   ├── FormatExplorer.tsx       # 12개 카테고리 포맷 검색 및 탐색기
│   │   ├── FormatSelector.tsx       # 필터링 지원 포맷 선택기 팝오버
│   │   ├── Header.tsx               # 고정 네비게이션바, 테마 토글, 사용자 메뉴
│   │   ├── Hero.tsx                 # 파일 업로드 드래그앤드롭 영역 및 포맷 셀렉터
│   │   ├── OptionsModal.tsx         # 포맷별 세부 파라미터 설정 모달
│   │   ├── UrlImportModal.tsx       # 원격 URL 파일 입력 모달
│   │   └── UrlUploadModal.tsx       # 보조 URL 업로드 다이얼로그
│   └── lib/
│       ├── conversions/             # 순수 바이너리 변환 하위 엔진 모음
│       │   ├── archive.ts           # ZIP, TAR, GZ, TGZ, BZ2, TBZ2, 7Z, RAR
│       │   ├── bzip2.ts             # 순수 TS BZip2 (BWT + MTF + Huffman)
│       │   ├── cad-nurbs.ts         # STEP/IGES Cox-de Boor NURBS 테셀레이션
│       │   ├── data.ts              # CSV, TSV, JSON, JSONL, YAML, XML
│       │   ├── document.ts          # PDFKit, Markdown, HTML, RTF, EPUB
│       │   ├── font.ts              # TTF, OTF, WOFF, WOFF2, EOT, SVG Font
│       │   ├── hwp.ts               # 순수 TS HWP 5.0 OLE2 CFBF 파서 & 빌더
│       │   ├── image.ts             # Sharp, PostScript 래스터, RAW 포맷
│       │   ├── media.ts             # 오디오 및 비디오 트랜스코딩 래퍼
│       │   ├── media-encoder.ts     # 순수 TS MDCT MP3 및 NAL H.264 인코더
│       │   ├── ocr.ts               # 투명 텍스트 레이어가 포함된 검색 가능 PDF 생성
│       │   ├── office.ts            # OOXML (DOCX, XLSX, PPTX), ODF, iWork
│       │   ├── pdf-utils.ts         # PDF 레이아웃, 추출 및 조작 유틸리티
│       │   ├── quantize.ts          # NeuQuant & Median Cut 색상 양자화
│       │   └── vector-cad.ts        # SVG, EMF, WMF, CGM, CDR, DXF, DWG
│       ├── queue/                   # BullMQ 비동기 워커 및 큐 추상화
│       │   ├── bullmq-engine.ts     # Redis 연결 및 백그라운드 워커 설정
│       │   └── conversion-queue.ts  # 인메모리/분산 큐 매니저
│       ├── storage/                 # 클라우드 오브젝트 스토리지 연동
│       │   ├── oci-storage.ts       # Oracle Cloud Infrastructure 오브젝트 스토리지
│       │   └── s3-storage.ts        # AWS S3 호환 청크 업로드 엔진
│       ├── pricing.ts               # 구독 플랜 티어 및 크레딧 계산기
│       ├── registry.ts              # 292개 표준 포맷 정의 및 옵션 스키마
│       ├── slug-parser.ts           # 동적 라우트 슬러그 파서 ([source]-to-[target])
│       ├── theme.ts                 # 라벤더 팔레트 디자인 토큰
│       └── types.ts                 # 공유 TypeScript 인터페이스 및 계약
├── scripts/                         # 헤드리스 브라우저 검증 및 캡처 도구
├── tests/                           # 21개 테스트 스위트 및 192개 결정론적 테스트
├── sonar-project.properties         # SonarCloud 코드 품질 분석 설정
└── package.json
```

---

## API 레퍼런스

EasyConvert는 동기식 REST 엔드포인트와 장시간 대용량 처리를 위한 비동기 작업 큐, 그리고 멀티파트 청크 스토리지 API를 제공합니다.

### 1. 단일 파일 동기 변환
- **엔드포인트**: `POST /api/convert`
- **Content-Type**: `multipart/form-data`
- **필드**:
  - `file`: 원본 바이너리 파일 (필수).
  - `targetFormat`: 변환 대상 포맷 식별자 (예: `webp`, `docx`, `mp3`, `pdf`).
  - `options`: JSON 문자열 형태의 변환 세부 옵션 (예: `{"quality": 85, "width": 1920}`).
- **응답**: 올바른 `Content-Type` 및 `Content-Disposition` 헤더가 설정된 변환 결과 바이너리 스트림.

### 2. 일괄 변환 (Batch Conversion)
- **엔드포인트**: `POST /api/convert/batch`
- **Content-Type**: `multipart/form-data`
- **필드**:
  - `files`: 복수의 바이너리 파일.
  - `targetFormat`: 일괄 적용 대상 포맷.
  - `bundleZip`: 결합된 ZIP 파일 반환 여부 불리언 플래그 (`true` 권장).
- **응답**: 바이너리 ZIP 스트림 또는 개별 변환 결과 JSON 배열.

### 3. 포맷 레지스트리 조회
- **엔드포인트**: `GET /api/formats`
- **쿼리 파라미터**:
  - `category` *(선택)*: 카테고리 필터링 (`image`, `document`, `cad`, `font`, `media` 등).
  - `search` *(선택)*: 포맷 ID, 이름, 확장자 검색어.
- **응답**: 지원 포맷 정의, 변환 가능 대상 포맷 목록, 옵션 스키마 JSON 배열.

### 4. 원격 URL 파일 가져오기
- **엔드포인트**: `POST /api/fetch-url`
- **Content-Type**: `application/json`
- **본문**: `{"url": "https://example.com/asset.png", "targetFormat": "webp"}`
- **응답**: 가져온 파일의 메타데이터 및 임시 스토리지 참조 키.

### 5. 분산 비동기 작업 큐 (BullMQ)
- **작업 생성**: `POST /api/queue/jobs`
  - 요청: `{"originalFilename": "model.step", "targetFormat": "stl", "storageKey": "...", "options": {}}`
  - 응답: `{"jobId": "job-12345", "status": "waiting"}`
- **작업 상태 폴링**: `GET /api/queue/jobs/:id`
  - 응답: `{"jobId": "job-12345", "status": "completed", "downloadUrl": "/api/storage/file/..."}`
- **큐 상태 지표**: `GET /api/queue/stats`
  - 대기 중, 처리 중, 완료, 실패 작업 수 반환.

### 6. 멀티파트 청크 스토리지
- **업로드 초기화**: `POST /api/storage/multipart?action=init`
  - 요청: `{"filename": "archive.zip", "contentType": "application/zip", "size": 104857600}`
  - 응답: `uploadId`, `key`, `partSize`
- **청크 파트 전송**: `POST /api/storage/multipart?action=part&uploadId=...&partNumber=1`
- **업로드 완료**: `POST /api/storage/multipart?action=complete&uploadId=...`
- **파일 다운로드**: `GET /api/storage/file/[...key]`

### 7. 서비스 헬스체크 및 진단
- **엔드포인트**: `GET /api/health`
- **응답**: 시스템 가동 시간, 가용 변환 엔진, 메모리 사용량 및 큐 상태.

---

## 시작하기

### 요구 사양

- Node.js >= 20.x
- npm >= 10.x

### 설치

```bash
git clone https://github.com/AquilaXk/easyconvert.git
cd easyconvert
npm install
```

### 개발 서버 실행

```bash
npm run dev
```

브라우저에서 [http://localhost:3000](http://localhost:3000)으로 접속합니다.

### 결정론적 검증 (Deterministic Verification)

21개 테스트 스위트와 192개 단위/통합 테스트를 실행합니다:

```bash
npm test
```

ESLint 정적 문법 및 규칙 검사:

```bash
npm run lint
```

### 프로덕션 빌드

```bash
npm run build
npm start
```

---

## 코드 품질 및 엔지니어링 표준

- **결정론적 테스트 스위트**: 21개 테스트 파일과 192개의 단위/통합 테스트를 통해 RFC 규격 준수, 순수 TS 수학적 기저 함수, OLE2 CFBF 구조, 메모리 무결성을 검증합니다.
- **Fail-Closed 보안 원칙**: 0바이트 파일, 미지원 확장자, 손상된 헤더는 즉시 HTTP 400 Bad Request를 반환하여 손상된 파일이나 조용한 폴백이 생성되는 것을 방지합니다.
- **철저한 무보관(Zero-Retention)**: 영구적인 사용자 파일 저장을 일절 수행하지 않으며, 모든 임시 버퍼는 휘발성 메모리에 할당되어 변환 완료 즉시 파기됩니다.
- **SonarCloud 연동**: `sonar-project.properties` 설정을 통해 지속적인 정적 코드 분석과 코드 품질 게이트를 유지합니다.

---

## 라이선스

MIT License. 자세한 사항은 [LICENSE](LICENSE)를 참고하십시오.
