# 🫶 익명 공감 게시판 (week-4)

익명으로 글(고민·칭찬·응원)을 쓰고, **공감 버튼**을 눌러 응원을 더하고,
**최신순/공감순**으로 정렬해서 보는 풀스택 게시판입니다. 모든 데이터는 **Supabase(PostgreSQL)** 에 저장돼요.

## 🔄 핵심 흐름

```
[글 작성(카테고리, 내용)] → [Server] → DB INSERT → 목록 조회(정렬/필터)
→ [공감 버튼 클릭] → [Server] → DB UPDATE (likes = likes + 1) → 화면 반영
```

> **공감 버튼의 핵심은 DB의 UPDATE 예요.** 버튼을 누를 때마다 `UPDATE posts SET likes = likes + 1` 이 실행되고,
> 새로고침해도 숫자가 유지됩니다(= DB에 저장된 데이터를 수정한다는 개념).

## 🧱 구조

```
week-4/anon-board/
├── server.js     # Express + pg : 게시글 CRUD + 공감 UPDATE + 답글 API
├── index.html    # CDN React 단일 페이지 (화면 전부)
├── package.json
├── vercel.json
├── .env.example
└── README.md
```

## 🗄️ 테이블 (서버 시작 시 자동 생성)

```sql
posts(id, category, content, likes, created_at)
comments(id, post_id → posts(id) ON DELETE CASCADE, content, created_at)  -- 답글(창의성)
```

## 🌐 API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/api/posts?sort=latest\|likes&category=고민\|칭찬\|응원` | 목록 (정렬·필터) |
| POST | `/api/posts` | 글 작성 `{category, content}` |
| POST | `/api/posts/:id/like` | **공감 +1 (DB UPDATE)** |
| DELETE | `/api/posts/:id` | 글 삭제 |
| GET | `/api/posts/:id/comments` | 답글 목록 |
| POST | `/api/posts/:id/comments` | 답글 작성 `{content}` |

## ▶️ 실행

```bash
cd week-4/anon-board
cp .env.example .env      # DATABASE_URL 의 <PASSWORD> 채우기
npm install
npm start                 # http://localhost:3001
```

> ⚠️ 반드시 `http://localhost:3001` 로 접속하세요. `index.html` 을 파일(`file://`)로 직접 열면
> API에 연결되지 않아 "Failed to fetch" 가 납니다. (포트는 recipe-ai-app(3000)과 겹치지 않게 3001)

## ✨ 창의성 포인트

- **카테고리**: 💭고민 / 👏칭찬 / 💪응원 (선택해서 작성)
- **정렬**: 🕒최신순 / 🔥공감순 토글
- **카테고리 필터**: 전체/고민/칭찬/응원
- **🏆 베스트 강조**: 공감순 1위 글에 베스트 배지
- **💬 익명 답글**: 글마다 답글을 달 수 있음 (comments 테이블)
- **공감 애니메이션 + 시간 표시**(방금 전/N분 전)

## ✅ 동작 확인

`anon-board-working.png` — 글 작성 → 공감 클릭 → 새로고침 후에도 공감 수 유지(DB 저장 확인) 스크린샷.
