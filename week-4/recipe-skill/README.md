# 🍳 냉장고 재료 레시피 스킬 (week-4)

냉장고 재료를 **재료당 JSON 파일 1개**로 관리하고, `/recipe` 슬래시 스킬로 그 파일들을 읽어
**1인분 · 15분 이내 · 자취생 난이도** 레시피를 자동 생성해 마크다운으로 저장하는 프로젝트입니다.

## 📁 구조

```
week-4/recipe-skill/
├── ingredients/          # 재료 1개 = 파일 1개 (추가=파일생성, 삭제=파일삭제)
│   ├── egg.json
│   ├── kimchi.json
│   ├── green-onion.json
│   ├── ramen.json
│   ├── tofu.json
│   ├── onion.json
│   ├── rice.json
│   ├── spam.json
│   ├── cheese.json
│   └── milk.json
├── recipes/              # /recipe 실행 결과 (생성된 레시피 .md)
│   └── kimchi-fried-rice.md
└── README.md

.claude/skills/recipe/SKILL.md   # /recipe 슬래시 스킬 본체
```

## 🔄 동작 흐름

```
[재료별 JSON 작성] → [/recipe 실행] → [ingredients/ 전체 읽기] → [레시피 생성 + 칼로리 계산] → [recipes/*.md 저장]
```

## ▶️ 사용법

Claude Code에서:

```
/recipe              # 보유 재료로 알아서 추천
/recipe 김치볶음밥    # 특정 메뉴 방향으로 생성
```

## 🧊 재료 JSON 스키마

```json
{
  "name": "계란",
  "name_en": "egg",
  "quantity": "6개",
  "unit": "개",
  "category": "냉장",
  "calories_per_unit": 70,
  "expiry": "2026-07-12"
}
```

## ➕ 재료 추가/삭제

- **추가:** `ingredients/`에 JSON 파일 하나만 새로 만들면 끝. 스킬 코드 수정 불필요.
- **삭제:** 해당 JSON 파일만 지우면 끝.

## ✨ 추가 기능 (창의성)

- **칼로리 계산:** 각 재료 JSON의 `calories_per_unit`을 사용량과 곱해 1인분 예상 칼로리를 표로 계산.
- **유통기한 우선:** `expiry`가 임박한 재료를 먼저 쓰는 레시피를 우대.

> 💡 다음 퀘스트에서 이 `ingredients/` 데이터를 DB로 옮길 예정입니다.
