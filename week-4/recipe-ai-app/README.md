# 🧊 냉장고 → 🤖 AI 레시피 (week-4)

이전 퀘스트의 **DB 기반 재료 관리 앱**을 확장해서, 저장된 재료를 **AI(Claude API)** 에게 보내
레시피를 자동 생성하고, 마음에 들면 **DB에 저장**하고 **목록으로 조회**하는 풀스택 앱입니다.

## 🔄 핵심 흐름

```
[DB에서 재료 조회] → [Server: Claude API 호출] → [레시피 자동 생성] → [사용자 확인 후 DB 저장] → [레시피 목록에 표시]
```

- **DB(PostgreSQL/Supabase):** `ingredients`(재료) + `recipes`(AI 생성 레시피) 저장
- **Server(Express):** DB에서 재료 조회 → AI API 호출 → 생성 결과 반환 → 저장 요청 처리
- **AI(Claude):** 보유 재료 목록 + 옵션을 받아 1인분 레시피를 JSON으로 생성

## 🧱 구조 (3-file + 설정)

```
week-4/recipe-ai-app/
├── server.js        # Express + pg + Claude API 호출 (백엔드 전부)
├── index.html       # CDN React 단일 페이지 (프론트엔드 전부)
├── package.json
├── vercel.json      # 배포 설정
├── .env.example     # 환경변수 템플릿
└── README.md
```

## 🗄️ 테이블

```sql
ingredients(id, name, quantity, category, created_at)
recipes(id, title, description, ingredients_used jsonb, instructions jsonb,
        cook_time, difficulty, calories, option, favorite, created_at)
```
> 서버 시작 시 `CREATE TABLE IF NOT EXISTS` 로 자동 생성됩니다.

## 🌐 API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/api/ingredients` | 재료 목록 |
| POST | `/api/ingredients` | 재료 추가 `{name, quantity, category}` |
| DELETE | `/api/ingredients/:id` | 재료 삭제 |
| POST | `/api/recipes/generate` | **DB 재료 조회 → AI 생성 → 미리보기 반환** `{option}` |
| POST | `/api/recipes` | 생성된 레시피를 DB에 저장 |
| GET | `/api/recipes` | 저장 레시피 목록 (필터 `?favorite=true`, `?difficulty=쉬움`, `?option=다이어트`) |
| PATCH | `/api/recipes/:id` | 즐겨찾기 토글 `{favorite}` |
| DELETE | `/api/recipes/:id` | 레시피 삭제 |

## ▶️ 실행

```bash
cd week-4/recipe-ai-app
cp .env.example .env      # DATABASE_URL, ANTHROPIC_API_KEY 채우기
npm install
npm start                 # http://localhost:3000
```

- `DATABASE_URL` : Supabase 연결 문자열 (`<PASSWORD>` 자리에 DB 비밀번호)
- `ANTHROPIC_API_KEY` : Claude API 키. **없어도 앱은 동작**합니다 — 내장 규칙 기반 생성기로 폴백하며, UI에 `기본 생성` 배지가 표시됩니다. 키를 넣으면 `AI 생성` 배지로 진짜 Claude 레시피가 나옵니다.
- `ANTHROPIC_MODEL` : 기본 `claude-opus-4-8`

## ✨ 창의성 포인트

- **옵션 선택**: 기본 / 간단요리 / 다이어트 / 야식 — AI 프롬프트에 반영
- **조리시간·난이도·칼로리** 저장 및 배지 표시
- **즐겨찾기(⭐)** 토글
- **필터**: 즐겨찾기 / 난이도별 조회
- **생성 → 미리보기 → 저장 / 다시 생성** 의 사용자 선택 흐름
- **AI 폴백**: API 키가 없어도 끊김 없이 동작

## 🤖 AI 연동 방식

`server.js` 의 `generateRecipeWithClaude()` 가 Anthropic Messages API(`/v1/messages`)를 호출합니다.
- `output_config.format`(JSON Schema)로 **구조화된 JSON 레시피**를 보장
- 보유 재료를 system/user 프롬프트로 전달, 옵션별 힌트 추가
- 호출 실패 또는 키 미설정 시 `generateRecipeFallback()` 로 자동 전환
