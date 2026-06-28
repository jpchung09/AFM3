const express = require('express');
const path = require('path');
const { Pool } = require('pg');

// .env 파일이 있으면 환경변수로 로드 (Node 20.6+ 내장 기능)
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* .env 없으면 무시 */ }

const app = express();
const PORT = process.env.PORT || 3001;

// --- PostgreSQL (Supabase) data store ---
const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres.iwlstbwrhhtylkhiypwe:@aws-1-us-east-1.pooler.supabase.com:6543/postgres';

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Supabase 는 SSL 필요
});

const CATEGORIES = ['고민', '칭찬', '응원'];

// 시작 시 테이블 보장
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id         SERIAL PRIMARY KEY,
      category   TEXT        NOT NULL DEFAULT '고민',
      content    TEXT        NOT NULL,
      likes      INTEGER     NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // 창의성: 익명 답글(댓글)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS comments (
      id         SERIAL PRIMARY KEY,
      post_id    INTEGER     NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      content    TEXT        NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

// DB row → API 응답 객체 (camelCase 통일)
function rowToPost(row) {
  return {
    id: row.id,
    category: row.category,
    content: row.content,
    likes: row.likes,
    commentCount: row.comment_count !== undefined ? Number(row.comment_count) : 0,
    createdAt: row.created_at,
  };
}

function rowToComment(row) {
  return { id: row.id, postId: row.post_id, content: row.content, createdAt: row.created_at };
}

// --- Middleware ---
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ============================================================
// API: 게시글 (posts)
// ============================================================

// 목록 조회 — 정렬(sort=latest|likes) + 카테고리 필터(category)
app.get('/api/posts', async (req, res) => {
  try {
    const values = [];
    let where = '';
    if (typeof req.query.category === 'string' && CATEGORIES.includes(req.query.category)) {
      values.push(req.query.category);
      where = `WHERE p.category = $${values.length}`;
    }
    // 공감순(likes) 아니면 최신순(latest)
    const order = req.query.sort === 'likes' ? 'p.likes DESC, p.id DESC' : 'p.id DESC';

    const { rows } = await pool.query(
      `SELECT p.*, COALESCE(c.cnt, 0) AS comment_count
         FROM posts p
         LEFT JOIN (SELECT post_id, COUNT(*) AS cnt FROM comments GROUP BY post_id) c
           ON c.post_id = p.id
         ${where}
         ORDER BY ${order}`,
      values
    );
    res.json({ success: true, data: rows.map(rowToPost) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '게시글을 불러오지 못했습니다.' });
  }
});

// 글 작성 (익명)
app.post('/api/posts', async (req, res) => {
  try {
    const b = req.body || {};
    const content = (typeof b.content === 'string') ? b.content.trim() : '';
    const category = (typeof b.category === 'string' && CATEGORIES.includes(b.category)) ? b.category : '고민';
    if (!content) {
      return res.status(400).json({ success: false, message: '내용(content)을 입력해주세요.' });
    }
    if (content.length > 1000) {
      return res.status(400).json({ success: false, message: '내용은 1000자 이내로 작성해주세요.' });
    }
    const { rows } = await pool.query(
      'INSERT INTO posts (category, content) VALUES ($1, $2) RETURNING *',
      [category, content]
    );
    res.status(201).json({ success: true, data: rowToPost(rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '글 작성에 실패했습니다.' });
  }
});

// ⭐ 핵심: 공감 버튼 → DB UPDATE (likes = likes + 1)
app.post('/api/posts/:id/like', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await pool.query(
      'UPDATE posts SET likes = likes + 1 WHERE id = $1 RETURNING *',
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: rowToPost(rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '공감 처리에 실패했습니다.' });
  }
});

// 글 삭제
app.delete('/api/posts/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rowCount } = await pool.query('DELETE FROM posts WHERE id = $1', [id]);
    if (rowCount === 0) {
      return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다.' });
    }
    res.json({ success: true, message: 'Post deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '삭제에 실패했습니다.' });
  }
});

// ============================================================
// API: 답글 (comments) — 창의성 기능
// ============================================================
app.get('/api/posts/:id/comments', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await pool.query(
      'SELECT * FROM comments WHERE post_id = $1 ORDER BY id ASC',
      [id]
    );
    res.json({ success: true, data: rows.map(rowToComment) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '답글을 불러오지 못했습니다.' });
  }
});

app.post('/api/posts/:id/comments', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const content = (req.body && typeof req.body.content === 'string') ? req.body.content.trim() : '';
    if (!content) {
      return res.status(400).json({ success: false, message: '답글 내용을 입력해주세요.' });
    }
    // 게시글 존재 확인
    const exist = await pool.query('SELECT 1 FROM posts WHERE id = $1', [id]);
    if (exist.rowCount === 0) {
      return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다.' });
    }
    const { rows } = await pool.query(
      'INSERT INTO comments (post_id, content) VALUES ($1, $2) RETURNING *',
      [id, content]
    );
    res.status(201).json({ success: true, data: rowToComment(rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '답글 작성에 실패했습니다.' });
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
