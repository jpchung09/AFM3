# DEV.md - 개발 가이드

> 평택 자매도시 탐색기 — 세계지도 위에서 후보 도시의 추천 근거(공통점·보완점·미추천 사유)를 확인하는 발표용 도구
> Architecture: **Option 1 — Single-File (index.html + single.js) + Supabase PostgreSQL**

## Requirements
- [x] 평택 도시 프로필(반도체/항만/미군/자동차/계획도시/농업)을 근거 기준선으로 제시
- [x] 세계지도 인터랙티브 UI (도시 마커 + 나라·도시명)
- [x] 마커 클릭 → 공통점·보완점 상세 패널
- [x] 미추천 도시 + "왜 추천하지 않는지" 설명
- [x] 추천 등급(색)·테마(아이콘) 시각화
- [x] 후보 도시 데이터를 Supabase PostgreSQL 에 저장·조회

## Non-goals
- 실제 자매결연 행정 처리, 로그인/계정, 관리자 CRUD, 실시간 외부 API 연동

## Style
- 톤: 정부/정책 발표에 어울리는 신뢰감 + 모던·미니멀. 유리질(glassmorphism) 카드, 부드러운 그림자, 라운드.
- 지도: CARTO Voyager 타일(밝고 라벨 가독성 높음). 마커는 등급별 색(최우선=에메랄드, 추천=블루, 신중=앰버, 미추천=그레이), 평택은 붉은 펄스 마커.
- 상세 패널: 우측 슬라이드-인, 등급별 헤더 그라데이션, 국기 이모지 + 테마 뱃지.

## Key Concepts
- **공통점(commonalities)**: 후보 도시가 평택과 구조적으로 닮은 점 (예: 반도체 앵커 팹, 자동차 수출항, 미군기지).
- **보완점(complements)**: 그 도시가 평택에 더해줄 수 있는 것 (예: 파운드리 생태계, 장비·소재, EU 칩스법 네트워크).
- **미추천 사유(why_not)**: 대조군 도시가 왜 우선순위에서 빠지는지 (규모 불균형·주제 중복·항만 부재 등).
- **tier**: strong(최우선)·good(추천)·consider(신중)·not_recommended(미추천).
- **theme**: semiconductor·port_trade·military·automotive·planned_city·agriculture.

## Open Questions
- 하이퐁: 기존 베트남 우호도시(땀끼)와 중복 여부 확인 후 추진.
- 데이터 스냅샷 갱신 주기.

---

## 선택된 개발 구조 — Option 1: Single-File

세 가지 표준 옵션 중 본 프로젝트에 대한 적합성:

- **Option 1 (Single-File)** ✅ **선택**: 프론트는 `index.html`(React 18 CDN + Tailwind + Leaflet), 백엔드는 `single.js`(Express) 하나. 지도 시각화 중심의 읽기 전용 앱이라 최소 구조로 즉시 구동·배포 가능. Supabase PostgreSQL 은 `single.js`가 `pg`로 연결해 후보 도시를 서빙.
- **Option 2 (Supabase JS)**: 프론트에서 Supabase JS 클라이언트로 직접 조회. 다만 제공된 자격증명이 `postgres://` 연결 문자열(anon key/RLS 세팅 아님)이라 서버 경유(Option 1)가 더 자연스러움.
- **Option 3 (Next.js)**: 풀스택·SEO에 강하나, 단일 지도 화면에는 과설계.

## 프로젝트 구조
```
week-6/my_cafe/
├── index.html          # 프론트엔드 전체 (React 18 CDN + Tailwind + Leaflet, 파일 분리 불가)
├── single.js           # Express 개발 서버 (+ Supabase PostgreSQL 연결/시드/API)
├── package.json
├── .env                # DATABASE_URL, PORT
├── MISSION.md          # 제품 비전
├── DEV.md              # 본 문서
├── my_cafe.md          # 리서치 로그 (임무1 평택 프로필 + 임무2 추천)
└── 발표_요약.md         # 발표용 요약
```

## 개발 에이전트
- `single-react-dev`: 프론트엔드 전체를 `index.html` 하나에 구현(React 컴포넌트/스타일/로직). JS/CSS 파일 분리 금지. 컴포넌트: `MapView`, `CityList`, `DetailPanel`, `Legend`, `App`.
- `single-server-specialist`: `single.js` 개발 서버 구현. 정적 서빙 + `/api/cities`(Supabase 조회) + 최초 실행 시 테이블 생성·시드.

## 📋 TODO List

### Phase 1: 디자인 & 프로토타이핑
- [x] 🟢 세계지도 + 마커 + 상세 패널 UI 프로토타입 — `MapView`, `DetailPanel`, `Legend` (더미 데이터, Leaflet)
- 📌 체크포인트: 지도 위 마커 클릭 시 공통점/보완점 패널이 뜨는 화면이 보임

### Phase 2: 기본 기능 (쉬운 것부터)
- [x] 🟢 프로젝트 초기화 (`package.json`, `single.js` Express 서버, `.env`)
- [x] 🟢 프로토타입 → `index.html`(React CDN) 전환, `CityList` 사이드바 + 등급/테마 시각화 연결
- [x] 🟢 `/api/cities` 정적 서빙 및 폴백 데이터 렌더
- 📌 체크포인트: 브라우저에서 지도·리스트·상세가 실제로 동작

### Phase 2.5: 플랫폼/인프라 연결 검증 (Supabase)
- [x] 🟡 Supabase PostgreSQL 연결(`pg`) + `cafe_candidate_cities` 테이블 생성
- [x] 🟡 리서치 기반 후보 도시 시드(최초 실행 시 비어있으면 자동 삽입) + `/api/cities`가 DB에서 조회
- 📌 체크포인트: 실제 Supabase DB에서 후보 도시가 조회되어 지도에 렌더

### Phase 3: 핵심 & 어려운 기능 (불확실한 것부터)
- [x] 🔴 리서치(임무1·2): 평택 프로필 + 시도지사협의회 참고 후보 도시 근거 확보 ⚠️ 실패 시 우회: 공개 백과·뉴스 교차검증
- [x] 🟡 미추천 대조군 + why_not 표현, 평택↔추천도시 연결선 시각화
- 📌 체크포인트: 공통점·보완점·미추천 사유가 근거 있는 문장으로 모두 표시

### Phase 4: 마무리 & 배포
- [ ] 🟡 UI 폴리싱(반응형, 애니메이션), 로딩/에러 처리
- [ ] 🟡 발표 요약 문서(`발표_요약.md`) 정리
- [ ] 🟡 최종 테스트(브라우저 구동 확인) 및 (선택) Vercel 배포
- 📌 체크포인트: 발표 가능한 상태

## 🔧 외부 설정 필요 항목

### 필수 (Must Have)
| 항목 | 설명 | 획득 방법 |
|------|------|----------|
| DATABASE_URL | Supabase PostgreSQL 연결 문자열 | Supabase 대시보드 > Project Settings > Database > Connection string (비밀번호 URL 인코딩) |
| PORT | 로컬 개발 서버 포트 (기본 3100) | 임의 지정 |

`.env` 예시:
```
DATABASE_URL=postgresql://postgres:****@db.<project>.supabase.co:5432/postgres
PORT=3100
```

### 선택 (Nice to Have)
| 항목 | 설명 | 획득 방법 |
|------|------|----------|
| Vercel | 배포 및 공개 URL | vercel.com 로그인 후 `vercel` (환경변수 대시보드 등록) |

## 시작하기
```bash
cd week-6/my_cafe
npm install
node single.js          # http://localhost:3100
```
