const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// .env 파일이 있으면 환경변수로 로드 (Node 20.6+ 내장 기능)
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* .env 없으면 무시 */ }

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me';
const TOKEN_TTL = '7d';

// --- PostgreSQL (Supabase) data store ---
const DATABASE_URL =
  (process.env.DATABASE_URL ||
    'postgresql://postgres.iwlstbwrhhtylkhiypwe:@aws-1-us-east-1.pooler.supabase.com:6543/postgres').trim();

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Supabase 는 SSL 필요
});

// 아파트 커뮤니티 게시판 카테고리
const CATEGORIES = ['공지', '자유', '나눔장터', '분실물', '맛집', '반려동물'];

// 시작 시 테이블 보장
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_users (
      id            SERIAL PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      nickname      TEXT        NOT NULL,
      password_hash TEXT        NOT NULL,
      apt_dong      TEXT        NOT NULL DEFAULT '',
      apt_ho        TEXT        NOT NULL DEFAULT '',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_posts (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER     NOT NULL REFERENCES community_users(id) ON DELETE CASCADE,
      title      TEXT        NOT NULL,
      content    TEXT        NOT NULL,
      category   TEXT        NOT NULL DEFAULT '자유',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

// --- Helpers ---
function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, nickname: user.nickname },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

// 로그인 필수 미들웨어
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ success: false, message: '세션이 만료되었습니다. 다시 로그인해주세요.' });
  }
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    nickname: row.nickname,
    aptDong: row.apt_dong,
    aptHo: row.apt_ho,
  };
}

function rowToPost(row, currentUserId) {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    category: row.category,
    authorId: row.user_id,
    author: row.nickname,
    aptDong: row.apt_dong,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isMine: currentUserId != null && row.user_id === currentUserId,
  };
}

// --- Middleware ---
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ==================== AUTH ====================

// 회원가입
app.post('/api/auth/signup', async (req, res) => {
  try {
    const body = req.body || {};
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const nickname = typeof body.nickname === 'string' ? body.nickname.trim() : '';
    const aptDong = typeof body.aptDong === 'string' ? body.aptDong.trim() : '';
    const aptHo = typeof body.aptHo === 'string' ? body.aptHo.trim() : '';

    if (username.length < 3) {
      return res.status(400).json({ success: false, message: '아이디는 3자 이상이어야 합니다.' });
    }
    if (password.length < 4) {
      return res.status(400).json({ success: false, message: '비밀번호는 4자 이상이어야 합니다.' });
    }
    if (!nickname) {
      return res.status(400).json({ success: false, message: '닉네임을 입력해주세요.' });
    }

    const dup = await pool.query('SELECT 1 FROM community_users WHERE username = $1', [username]);
    if (dup.rowCount > 0) {
      return res.status(409).json({ success: false, message: '이미 사용 중인 아이디입니다.' });
    }

    const password_hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO community_users (username, nickname, password_hash, apt_dong, apt_ho)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, username, nickname, apt_dong, apt_ho`,
      [username, nickname, password_hash, aptDong, aptHo]
    );
    const user = rows[0];
    const token = signToken(user);
    res.status(201).json({ success: true, token, user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '회원가입에 실패했습니다.' });
  }
});

// 로그인
app.post('/api/auth/login', async (req, res) => {
  try {
    const body = req.body || {};
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    const { rows } = await pool.query(
      'SELECT id, username, nickname, password_hash, apt_dong, apt_ho FROM community_users WHERE username = $1',
      [username]
    );
    if (rows.length === 0) {
      return res.status(401).json({ success: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }
    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ success: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }
    const token = signToken(user);
    res.json({ success: true, token, user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '로그인에 실패했습니다.' });
  }
});

// 내 정보 (토큰 검증)
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, username, nickname, apt_dong, apt_ho FROM community_users WHERE id = $1',
      [req.user.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '사용자를 찾을 수 없습니다.' });
    }
    res.json({ success: true, user: publicUser(rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '사용자 정보를 불러오지 못했습니다.' });
  }
});

// ==================== POSTS ====================

// 목록 (로그인한 누구나) — 최신순
app.get('/api/posts', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.user_id, p.title, p.content, p.category, p.created_at, p.updated_at,
              u.nickname, u.apt_dong
         FROM community_posts p
         JOIN community_users u ON u.id = p.user_id
        ORDER BY p.created_at DESC`
    );
    res.json({ success: true, data: rows.map((r) => rowToPost(r, req.user.id)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '게시글을 불러오지 못했습니다.' });
  }
});

// 상세 (로그인한 누구나)
app.get('/api/posts/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await pool.query(
      `SELECT p.id, p.user_id, p.title, p.content, p.category, p.created_at, p.updated_at,
              u.nickname, u.apt_dong
         FROM community_posts p
         JOIN community_users u ON u.id = p.user_id
        WHERE p.id = $1`,
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: rowToPost(rows[0], req.user.id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '게시글을 불러오지 못했습니다.' });
  }
});

// 작성 (로그인 필수)
app.post('/api/posts', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    const category = CATEGORIES.includes(body.category) ? body.category : '자유';

    if (!title) return res.status(400).json({ success: false, message: '제목을 입력해주세요.' });
    if (!content) return res.status(400).json({ success: false, message: '내용을 입력해주세요.' });

    const { rows } = await pool.query(
      `INSERT INTO community_posts (user_id, title, content, category)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [req.user.id, title, content, category]
    );
    res.status(201).json({ success: true, data: { id: rows[0].id } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '게시글 작성에 실패했습니다.' });
  }
});

// 수정 (본인만)
app.patch('/api/posts/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const owner = await pool.query('SELECT user_id FROM community_posts WHERE id = $1', [id]);
    if (owner.rowCount === 0) {
      return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다.' });
    }
    if (owner.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ success: false, message: '본인이 작성한 글만 수정할 수 있습니다.' });
    }

    const body = req.body || {};
    const sets = [];
    const values = [];
    if (typeof body.title === 'string') {
      const title = body.title.trim();
      if (!title) return res.status(400).json({ success: false, message: '제목을 입력해주세요.' });
      values.push(title); sets.push(`title = $${values.length}`);
    }
    if (typeof body.content === 'string') {
      const content = body.content.trim();
      if (!content) return res.status(400).json({ success: false, message: '내용을 입력해주세요.' });
      values.push(content); sets.push(`content = $${values.length}`);
    }
    if (CATEGORIES.includes(body.category)) {
      values.push(body.category); sets.push(`category = $${values.length}`);
    }
    if (sets.length === 0) {
      return res.status(400).json({ success: false, message: '수정할 내용이 없습니다.' });
    }
    sets.push('updated_at = NOW()');
    values.push(id);

    await pool.query(`UPDATE community_posts SET ${sets.join(', ')} WHERE id = $${values.length}`, values);
    res.json({ success: true, message: '수정되었습니다.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '게시글 수정에 실패했습니다.' });
  }
});

// 삭제 (본인만)
app.delete('/api/posts/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const owner = await pool.query('SELECT user_id FROM community_posts WHERE id = $1', [id]);
    if (owner.rowCount === 0) {
      return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다.' });
    }
    if (owner.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ success: false, message: '본인이 작성한 글만 삭제할 수 있습니다.' });
    }
    await pool.query('DELETE FROM community_posts WHERE id = $1', [id]);
    res.json({ success: true, message: '삭제되었습니다.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '게시글 삭제에 실패했습니다.' });
  }
});

// --- SPA fallback (Express 5 splat syntax) ---
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// --- Local start / Vercel export dual-mode ---
if (require.main === module) {
  initDb()
    .then(() => app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`)))
    .catch((err) => {
      console.error('DB 초기화 실패:', err.message);
      process.exit(1);
    });
} else {
  initDb().catch((err) => console.error('DB 초기화 실패:', err.message));
}
module.exports = app;
