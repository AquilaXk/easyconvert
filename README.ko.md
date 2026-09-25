# EasyConvert

[English](README.md) | [한국어](README.ko.md)

EasyConvert는 Next.js, TypeScript, 그리고 고유한 라벤더 컬러 시스템을 기반으로 구축된 최신 고성능 범용 파일 변환 플랫폼입니다. 이미지, 문서, 스프레드시트, 데이터 구조, 아카이브 등 다양한 포맷 간의 안정적이고 결정론적인 변환 환경을 제공합니다.

---

## 주요 기능

- **광범위한 포맷 지원**: 이미지(PNG, JPG, WebP, AVIF, GIF, BMP, TIFF, SVG, ICO), 문서(PDF, Markdown, HTML, TXT), 데이터(CSV, JSON, TSV, XML, YAML, XLSX), 아카이브(ZIP, TAR, GZ) 등 다채로운 포맷 지원.
- **라벤더 브랜드 디자인 시스템**: 고대비 가독성, 직관적인 인터랙션, 완벽한 라이트/다크 모드를 지원하는 세련된 라벤더 팔레트 적용.
- **정밀한 변환 옵션 제어**: 해상도 조절, 품질 계수, 리사이즈 방식, 메타데이터 제거, 페이지 방향, 오디오 비트레이트, 압축률 등 포맷별 세부 파라미터 맞춤 설정.
- **일괄 변환 및 ZIP 아카이브 다운로드**: 여러 파일을 동시에 대기열에 추가하여 일괄 변환하고, 개별 다운로드 또는 통합 ZIP 압축 다운로드 제공.
- **Fail-Closed 보안 원칙**: 업로드된 파일은 변환 즉시 메모리 및 임시 저장소에서 안전하게 영구 삭제되며, 잘못된 데이터에 대해 조용한 폴백 없이 명확한 검증 실패를 반환.
- **개발자 친화적 REST API**: 포맷 매트릭스 조회, 단일 및 일괄 변환 작업을 위한 프로그래밍 방식의 엔드포인트 제공.

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

### 테스트 실행

```bash
npm test
```

### 프로덕션 빌드

```bash
npm run build
npm start
```

---

## 라이선스

MIT License. 자세한 사항은 [LICENSE](LICENSE)를 참고하십시오.
