const express = require('express');
const path = require('path');
const { Pool } = require('pg');

// .env 파일이 있으면 환경변수로 로드 (Node 20.6+ 내장 기능)
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* .env 없으면 무시 */ }

const app = express();
const PORT = process.env.PORT || 3000;

// --- PostgreSQL (Supabase) data store ---
// 비밀번호는 코드에 하드코딩하지 않고 DATABASE_URL 환경변수로 주입한다.
const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres.ehdkvfqigzaqrnfbyxpx:@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres';

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Supabase 는 SSL 필요
});

// --- Claude (Anthropic) API 설정 ---
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';

// 시작 시 테이블 보장
async function initDb() {
  // 재료 테이블 (이전 퀘스트의 ingredients 를 그대로 활용)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ingredients (
      id         SERIAL PRIMARY KEY,
      name       TEXT        NOT NULL,
      quantity   TEXT        NOT NULL DEFAULT '',
      category   TEXT        NOT NULL DEFAULT '냉장',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // AI 가 생성한 레시피 저장 테이블
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recipes (
      id               SERIAL PRIMARY KEY,
      title            TEXT        NOT NULL,
      description      TEXT        NOT NULL DEFAULT '',
      ingredients_used JSONB       NOT NULL DEFAULT '[]',
      instructions     JSONB       NOT NULL DEFAULT '[]',
      cook_time        INTEGER     NOT NULL DEFAULT 0,
      difficulty       TEXT        NOT NULL DEFAULT '보통',
      calories         INTEGER     NOT NULL DEFAULT 0,
      option           TEXT        NOT NULL DEFAULT '기본',
      favorite         BOOLEAN     NOT NULL DEFAULT FALSE,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

// DB row → API 응답 객체 (camelCase 통일)
function rowToIngredient(row) {
  return {
    id: row.id,
    name: row.name,
    quantity: row.quantity,
    category: row.category,
    createdAt: row.created_at,
  };
}

function rowToRecipe(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    ingredientsUsed: row.ingredients_used,
    instructions: row.instructions,
    cookTime: row.cook_time,
    difficulty: row.difficulty,
    calories: row.calories,
    option: row.option,
    favorite: row.favorite,
    createdAt: row.created_at,
  };
}

// ============================================================
// AI: 보유 재료 목록 → 레시피 생성
// ============================================================
const OPTION_HINTS = {
  '기본': '집에 있는 재료로 무난하게 만들 수 있는 한 끼.',
  '간단요리': '15분 이내, 최소한의 손질과 설거지로 끝나는 초간단 요리.',
  '다이어트': '저칼로리·고단백 위주, 기름과 탄수화물을 줄인 건강식.',
  '야식': '늦은 밤에 어울리는 자극적이고 푸짐한 안주/야식.',
};

// JSON 스키마 (구조화 출력 보장용)
const RECIPE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    ingredients_used: { type: 'array', items: { type: 'string' } },
    instructions: { type: 'array', items: { type: 'string' } },
    cook_time: { type: 'integer' },
    difficulty: { type: 'string', enum: ['쉬움', '보통', '어려움'] },
    calories: { type: 'integer' },
  },
  required: ['title', 'description', 'ingredients_used', 'instructions', 'cook_time', 'difficulty', 'calories'],
  additionalProperties: false,
};

// Claude API 호출 (구조화 출력). 키가 없거나 실패하면 null 반환 → 폴백 사용.
async function generateRecipeWithClaude(ingredients, option) {
  if (!ANTHROPIC_API_KEY) return null;

  const names = ingredients.map((i) => `${i.name}${i.quantity ? ` (${i.quantity})` : ''}`).join(', ');
  const hint = OPTION_HINTS[option] || OPTION_HINTS['기본'];

  const system =
    '당신은 자취생을 위한 한국 가정식 레시피 셰프입니다. ' +
    '사용자가 가진 재료만으로 1인분 요리를 제안합니다. ' +
    '기본 양념(소금·후추·간장·고추장·설탕·식용유·참기름)은 보유하고 있다고 가정합니다. ' +
    '없는 재료를 새로 사야 하는 레시피는 피하고, 보유 재료를 최대한 활용하세요. ' +
    '모든 텍스트는 한국어로 작성합니다.';

  const user =
    `현재 냉장고에 있는 재료: ${names}\n` +
    `요청 옵션: "${option}" — ${hint}\n\n` +
    `위 재료로 만들 수 있는 레시피 1개를 제안하세요.\n` +
    `- ingredients_used: 실제 사용하는 재료 목록(양 포함)\n` +
    `- instructions: 따라하기 쉬운 단계별 조리법\n` +
    `- cook_time: 예상 조리 시간(분)\n` +
    `- difficulty: 쉬움/보통/어려움 중 하나\n` +
    `- calories: 1인분 예상 칼로리(kcal)`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1500,
        system,
        messages: [{ role: 'user', content: user }],
        output_config: { format: { type: 'json_schema', schema: RECIPE_SCHEMA } },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('Claude API 오류:', res.status, text.slice(0, 300));
      return null;
    }

    const data = await res.json();
    const textBlock = (data.content || []).find((b) => b.type === 'text');
    if (!textBlock) return null;
    const parsed = JSON.parse(textBlock.text);
    return { ...parsed, _source: 'claude' };
  } catch (err) {
    console.error('Claude 호출 실패:', err.message);
    return null;
  }
}

// 폴백: API 키가 없을 때 보유 재료로 규칙 기반 레시피를 만든다.
function generateRecipeFallback(ingredients, option) {
  const names = ingredients.map((i) => i.name);
  const main = names.slice(0, 4);
  const used = ingredients.slice(0, 4).map((i) => `${i.name}${i.quantity ? ` ${i.quantity}` : ''}`);

  const styleByOption = {
    '기본': { title: `${main[0] || '재료'} 한 그릇`, time: 20, diff: '보통', kcal: 520 },
    '간단요리': { title: `초간단 ${main[0] || '재료'} 볶음`, time: 12, diff: '쉬움', kcal: 430 },
    '다이어트': { title: `가벼운 ${main[0] || '재료'} 샐러드볼`, time: 15, diff: '쉬움', kcal: 320 },
    '야식': { title: `${main[0] || '재료'} 매콤 야식`, time: 18, diff: '보통', kcal: 680 },
  };
  const s = styleByOption[option] || styleByOption['기본'];

  return {
    title: s.title,
    description: `냉장고에 있는 ${main.join(', ')}(으)로 만드는 "${option}" 스타일 1인분 요리예요. (API 키 미설정 — 기본 생성기)`,
    ingredients_used: used.length ? used : ['보유 재료'],
    instructions: [
      `${main.join(', ') || '재료'}를 먹기 좋은 크기로 손질합니다.`,
      '달군 팬에 식용유를 두르고 재료를 넣어 중불에서 볶습니다.',
      '간장·소금·후추로 간을 맞추고 골고루 섞어줍니다.',
      `${option === '다이어트' ? '기름을 적게 쓰고 ' : ''}그릇에 담아 완성합니다.`,
    ],
    cook_time: s.time,
    difficulty: s.diff,
    calories: s.kcal,
    _source: 'fallback',
  };
}

// --- Middleware ---
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ============================================================
// API: 재료 (ingredients)
// ============================================================
app.get('/api/ingredients', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM ingredients ORDER BY id ASC');
    res.json({ success: true, data: rows.map(rowToIngredient) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to load ingredients' });
  }
});

app.post('/api/ingredients', async (req, res) => {
  try {
    const name = (req.body && typeof req.body.name === 'string') ? req.body.name.trim() : '';
    const quantity = (req.body && typeof req.body.quantity === 'string') ? req.body.quantity.trim() : '';
    const category = (req.body && typeof req.body.category === 'string' && req.body.category.trim()) || '냉장';
    if (!name) {
      return res.status(400).json({ success: false, message: '재료 이름(name)은 필수입니다.' });
    }
    const { rows } = await pool.query(
      'INSERT INTO ingredients (name, quantity, category) VALUES ($1, $2, $3) RETURNING *',
      [name, quantity, category]
    );
    res.status(201).json({ success: true, data: rowToIngredient(rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to create ingredient' });
  }
});

app.delete('/api/ingredients/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rowCount } = await pool.query('DELETE FROM ingredients WHERE id = $1', [id]);
    if (rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Ingredient not found' });
    }
    res.json({ success: true, message: 'Ingredient deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to delete ingredient' });
  }
});

// ============================================================
// API: 레시피 (recipes)
// ============================================================

// 핵심 흐름: DB에서 재료 조회 → AI 호출 → 레시피 생성 (아직 저장하지 않음, 미리보기 반환)
app.post('/api/recipes/generate', async (req, res) => {
  try {
    const option = (req.body && typeof req.body.option === 'string' && req.body.option.trim()) || '기본';

    // 1) DB에서 재료 조회
    const { rows } = await pool.query('SELECT * FROM ingredients ORDER BY id ASC');
    const ingredients = rows.map(rowToIngredient);
    if (ingredients.length === 0) {
      return res.status(400).json({ success: false, message: '먼저 냉장고에 재료를 추가해주세요.' });
    }

    // 2) AI 호출 (실패/키없음 → 폴백)
    let recipe = await generateRecipeWithClaude(ingredients, option);
    const aiUsed = !!recipe;
    if (!recipe) recipe = generateRecipeFallback(ingredients, option);

    // 3) 생성 결과를 클라이언트에 반환 (사용자가 저장 또는 재생성 선택)
    res.json({
      success: true,
      data: {
        title: recipe.title,
        description: recipe.description,
        ingredientsUsed: recipe.ingredients_used,
        instructions: recipe.instructions,
        cookTime: recipe.cook_time,
        difficulty: recipe.difficulty,
        calories: recipe.calories,
        option,
      },
      meta: { aiUsed, source: recipe._source },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '레시피 생성에 실패했습니다.' });
  }
});

// 생성된 레시피를 DB에 저장
app.post('/api/recipes', async (req, res) => {
  try {
    const b = req.body || {};
    const title = (typeof b.title === 'string') ? b.title.trim() : '';
    if (!title) {
      return res.status(400).json({ success: false, message: '레시피 제목(title)은 필수입니다.' });
    }
    const { rows } = await pool.query(
      `INSERT INTO recipes
        (title, description, ingredients_used, instructions, cook_time, difficulty, calories, option)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        title,
        typeof b.description === 'string' ? b.description : '',
        JSON.stringify(Array.isArray(b.ingredientsUsed) ? b.ingredientsUsed : []),
        JSON.stringify(Array.isArray(b.instructions) ? b.instructions : []),
        Number.isFinite(b.cookTime) ? Math.round(b.cookTime) : 0,
        typeof b.difficulty === 'string' ? b.difficulty : '보통',
        Number.isFinite(b.calories) ? Math.round(b.calories) : 0,
        typeof b.option === 'string' ? b.option : '기본',
      ]
    );
    res.status(201).json({ success: true, data: rowToRecipe(rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '레시피 저장에 실패했습니다.' });
  }
});

// 저장된 레시피 목록 조회 (필터: ?favorite=true, ?difficulty=쉬움, ?option=다이어트)
app.get('/api/recipes', async (req, res) => {
  try {
    const where = [];
    const values = [];
    if (req.query.favorite === 'true') {
      where.push('favorite = TRUE');
    }
    if (typeof req.query.difficulty === 'string' && req.query.difficulty) {
      values.push(req.query.difficulty);
      where.push(`difficulty = $${values.length}`);
    }
    if (typeof req.query.option === 'string' && req.query.option) {
      values.push(req.query.option);
      where.push(`option = $${values.length}`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT * FROM recipes ${clause} ORDER BY favorite DESC, id DESC`,
      values
    );
    res.json({ success: true, data: rows.map(rowToRecipe) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to load recipes' });
  }
});

// 즐겨찾기 토글 등 수정
app.patch('/api/recipes/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (typeof req.body.favorite !== 'boolean') {
      return res.status(400).json({ success: false, message: 'favorite(boolean)가 필요합니다.' });
    }
    const { rows } = await pool.query(
      'UPDATE recipes SET favorite = $1 WHERE id = $2 RETURNING *',
      [req.body.favorite, id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Recipe not found' });
    }
    res.json({ success: true, data: rowToRecipe(rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to update recipe' });
  }
});

// 레시피 삭제
app.delete('/api/recipes/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rowCount } = await pool.query('DELETE FROM recipes WHERE id = $1', [id]);
    if (rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Recipe not found' });
    }
    res.json({ success: true, message: 'Recipe deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to delete recipe' });
  }
});

// --- SPA fallback (Express 5 splat syntax) ---
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// --- Local start / Vercel export dual-mode ---
if (require.main === module) {
  // 서버는 무조건 먼저 켠다. DB 연결이 실패해도 화면(index.html)은 떠야
  // "Failed to fetch" 대신 정확한 오류 메시지를 볼 수 있다.
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
  initDb()
    .then(() => console.log('DB 연결 성공 · 테이블 준비 완료'))
    .catch((err) => console.error('⚠️ DB 초기화 실패(서버는 계속 실행 중):', err.message));
} else {
  initDb().catch((err) => console.error('DB 초기화 실패:', err.message));
}
module.exports = app;
