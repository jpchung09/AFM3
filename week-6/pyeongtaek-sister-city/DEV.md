# DEV.md - 개발 가이드

> 평택 자매도시 탐색기 — 세계지도 위에서 후보 도시를 클릭해 평택과의 공통점·보완점·미추천 사유를 확인하는 발표용 의사결정 지원 도구
> Architecture: **Option 1 — 단일 파일 (index.html + single.js) + Supabase PostgreSQL 하이브리드**

## Requirements
- [x] 평택 도시 프로필(반도체·항만·미군·자동차·계획도시·농업)을 근거의 기준선으로 제시
- [x] 세계지도 인터랙티브 UI (도시 마커 + 나라·도시명 라벨)
- [x] 마커 클릭 → 공통점·보완점 상세 패널 표시
- [x] 미추천 대조군 + "왜 추천하지 않는지(why_not)" 설명
- [x] 추천 등급(색)·테마(아이콘) 시각화 (추천 9곳 + 미추천 3곳 = 총 12곳)
- [x] 후보 도시 데이터를 Supabase PostgreSQL 에 저장·조회

## Non-goals
- 실제 자매결연 체결·행정 처리 기능 없음 (추천·시각화까지만)
- 로그인/계정/권한 관리 없음
- 사용자가 후보 도시를 직접 CRUD 하는 관리자 화면 없음 (데이터는 리서치 기반 시드)
- 실시간 외부 API 연동(항만 통계 등) 없음 — 리서치 스냅샷 기반

## Style
- 톤: 정부/정책 발표에 어울리는 신뢰감 + 모던·미니멀. 유리질(glassmorphism) 카드, 부드러운 그림자, 라운드.
- 지도: CARTO Voyager 타일(밝고 라벨 가독성 높음). 마커는 등급별 색(최우선=에메랄드, 추천=블루, 신중=앰버, 미추천=그레이), 평택은 붉은 펄스 마커.
- 상세 패널: 우측 슬라이드-인, 등급별 헤더 그라데이션, 국기 이모지 + 테마 뱃지.

## Key Concepts
- **공통점(commonalities)**: 후보 도시가 평택과 구조적으로 닮은 점 (예: 반도체 앵커 팹, 자동차 수출항, 미군기지).
- **보완점(complements)**: 그 도시가 평택에 더해줄 수 있는 것 (예: 파운드리 생태계, 반도체 장비·소재, EU 칩스법 네트워크).
- **미추천 사유(why_not)**: 대조군 도시가 왜 우선순위에서 빠지는지 (규모 불균형·주제 중복·항만 부재 등).
- **tier**: strong(최우선)·good(추천)·consider(신중)·not_recommended(미추천).
- **theme**: semiconductor·port_trade·military·automotive·planned_city·agriculture.

## Open Questions
- 하이퐁(베트남): 기존 베트남 우호도시(땀끼)와 중복 여부 확인 후 추진.
- 데이터 스냅샷 갱신 주기: 리서치 결과를 언제·어떻게 업데이트할지.

---

## 선택된 개발 구조 — Option 1: 단일 파일 (Single-File) + Supabase 하이브리드

세 가지 표준 옵션을 모두 검토한 뒤, 본 프로젝트는 **단일 파일 구조를 선택**하되 데이터 저장에만 **Supabase PostgreSQL** 을 사용하는 하이브리드로 확정했다. 즉 프론트는 `index.html`(React 18 CDN + Tailwind + Leaflet), 백엔드는 `single.js`(Express) 하나이며, 후보 도시 데이터는 `single.js`가 `pg`로 Supabase PostgreSQL 에 연결해 서빙한다.

- **Option 1 (단일 파일) ✅ 선택** — MVP·프로토타입·발표용에 최적이며 가장 빠르다. 이 앱은 지도 시각화 중심의 **읽기 전용**(추천 데이터를 보여주기만) 앱이라 최소 구조로 즉시 구동·배포할 수 있다. 프론트 전체를 `index.html` 하나에 담고, `single.js` 하나로 정적 서빙 + `/api/cities` API를 제공한다. 발표 데모까지의 리드타임이 가장 짧아 적합하다. **단, 후보 12곳 데이터를 영속 저장·조회하려면 저장소가 필요하므로 Supabase PostgreSQL 을 붙인 하이브리드로 운영한다** (`single.js`가 최초 실행 시 테이블 생성·시드).
- **Option 2 (Supabase 기반)** — 프론트에서 Supabase JS 클라이언트로 직접 조회하고 Auth·RLS를 쓰는 구조. 이 프로젝트는 **로그인·계정·사용자별 권한이 전혀 필요 없고**(Non-goals) 데이터도 리서치 스냅샷 읽기 전용이라, Auth/RLS 설계는 과잉이다. 게다가 제공된 자격증명이 `postgres://` 연결 문자열(anon key/RLS 세팅이 아님)이라 서버 경유(Option 1)가 더 자연스럽다. **부적합.**
- **Option 3 (Next.js 풀스택)** — SSR·SEO·API 라우트에 강해 본격 프로덕션에 좋지만, 단일 지도 화면 하나짜리 발표용 앱에는 학습 곡선·설정 복잡도가 과설계다. SEO도 발표용 내부 도구라 불필요. **부적합.**

## 개발 에이전트
- `single-react-dev`: 프론트엔드 전체를 `index.html` 하나에 구현(React 컴포넌트·스타일·로직). **별도 JS/CSS 파일 분리 금지.** 컴포넌트: `MapView`(Leaflet 세계지도+마커), `CityList`(사이드바 목록), `DetailPanel`(우측 상세 슬라이드), `Legend`(등급·테마 범례), `App`(루트·상태·데이터 fetch).
- `single-server-specialist`: `single.js` 개발 서버 구현. 정적 서빙 + `/api/cities`(Supabase 조회) + 최초 실행 시 `cafe_candidate_cities` 테이블 생성·시드.

## 프로젝트 구조
```
week-6/pyeongtaek-sister-city/
├── index.html          # 프론트엔드 전체 (React 18 CDN + Tailwind + Leaflet, 파일 분리 불가)
├── single.js           # Express 개발 서버 (+ Supabase PostgreSQL 연결/시드/API)
├── package.json
├── .env                # DATABASE_URL, PORT
├── MISSION.md          # 제품 비전·문제·타겟·해결
└── DEV.md              # 본 문서
```

## 📋 TODO List

### Phase 1: 디자인 & 프로토타이핑
- [x] 🟢 세계지도 + 마커 + 상세 패널 UI 프로토타입 — `MapView`, `DetailPanel`, `Legend` (더미 데이터, Leaflet, 브라우저에서 직접 확인)
- 📌 체크포인트: 지도 위 마커를 클릭하면 공통점/보완점 패널이 뜨는 화면이 눈으로 보임

### Phase 2: 기본 기능 (쉬운 것부터)
- [x] 🟢 프로젝트 초기화 (`package.json`, `single.js` Express 서버, `.env`)
- [x] 🟢 프로토타입 → `index.html`(React CDN) 전환, `CityList` 사이드바 + 등급/테마 시각화 연결 (`App` 상태 관리)
- [x] 🟢 `/api/cities` 정적 서빙 및 폴백 데이터 렌더
- 📌 체크포인트: 브라우저에서 지도·리스트·상세 패널이 실제로 동작

### Phase 2.5: 플랫폼/인프라 연결 검증 (Supabase)
- [x] 🟡 Supabase PostgreSQL 연결(`pg`) + `cafe_candidate_cities` 테이블 생성 (`single.js`)
- [x] 🟡 리서치 기반 후보 12곳 시드(최초 실행 시 비어있으면 자동 삽입) + `/api/cities`가 DB에서 조회
- 📌 체크포인트: 실제 Supabase DB에서 후보 도시가 조회되어 지도에 렌더

### Phase 3: 핵심 & 어려운 기능 (불확실한 것부터)
- [x] 🔴 리서치(임무1·2): 평택 프로필(삼성 평택캠퍼스·평택항 자동차 1위·캠프 험프리스) + 시도지사협의회 참고 후보 도시 근거 확보 ⚠️ 실패 시 우회: 공개 백과·뉴스 교차검증
- [x] 🟡 미추천 대조군 3곳 + `why_not` 표현, 평택↔추천도시 연결선 시각화 (`MapView`, `DetailPanel`)
- 📌 체크포인트: 공통점·보완점·미추천 사유가 근거 있는 문장으로 모두 표시

### Phase 4: 마무리 & 배포
- [ ] 🟡 UI 폴리싱(반응형, 슬라이드/펄스 애니메이션), 로딩/에러 처리 (`App`, `DetailPanel`)
- [ ] 🟡 발표 요약 문서 정리
- [ ] 🟡 최종 테스트(브라우저 구동 확인) 및 (선택) Vercel 배포
- 📌 체크포인트: 발표 가능한 상태

## 🔧 외부 설정 필요 항목

### 필수 (Must Have)
| 항목 | 설명 | 획득 방법 |
|------|------|----------|
| DATABASE_URL | Supabase PostgreSQL 연결 문자열 (후보 도시 저장·조회) | Supabase 대시보드 > Project Settings > Database > Connection string (비밀번호 URL 인코딩) |
| PORT | 로컬 개발 서버 포트 (기본 3100) | 임의 지정 (`.env`) |

`.env` 예시:
```
DATABASE_URL=postgresql://postgres:****@db.<project>.supabase.co:5432/postgres
PORT=3100
```

### 선택 (Nice to Have)
| 항목 | 설명 | 획득 방법 |
|------|------|----------|
| Vercel | 배포 및 공개 URL | vercel.com 로그인 후 `vercel` 실행 (환경변수는 대시보드에 등록) |

## 시작하기
```bash
cd week-6/pyeongtaek-sister-city
npm install
node single.js          # http://localhost:3100
```
