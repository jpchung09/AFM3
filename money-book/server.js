const express = require('express');
const path = require('path');
const { Pool } = require('pg');

// .env 파일이 있으면 환경변수로 로드 (Node 20.6+ 내장 기능)
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* .env 없으면 무시 */ }

const app = express();
const PORT = process.env.PORT || 3000;

// --- PostgreSQL (Supabase) data store ---
// 비밀번호는 코드에 하드코딩하지 않고 DATABASE_URL 환경변수로 주입한다.
// 예) DATABASE_URL="postgresql://postgres.xxxx:<비밀번호>@aws-1-us-east-1.pooler.supabase.com:6543/postgres"
const DATABASE_URL =
  (process.env.DATABASE_URL ||
    'postgresql://postgres.iwlstbwrhhtylkhiypwe:@aws-1-us-east-1.pooler.supabase.com:6543/postgres').trim();

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Supabase 는 SSL 필요
});

// --- ImageKit (프로필 이미지 업로드) ---
// private key 는 코드에 하드코딩하지 않고 환경변수로만 주입한다.
const IMAGEKIT_PRIVATE_KEY = (process.env.IMAGEKIT_PRIVATE_KEY || '').trim();
const IMAGEKIT_URL_ENDPOINT = (process.env.IMAGEKIT_URL_ENDPOINT || '').trim();
const IMAGEKIT_UPLOAD_URL = 'https://upload.imagekit.io/api/v1/files/upload';

// 허용 타입 (수입 / 지출)
const TYPES = new Set(['income', 'expense']);

// 초기 시드 데이터 (테이블이 비어 있을 때만 삽입).
// entry_date 는 CURRENT_DATE 기준 상대일(offset)로 저장한다.
const SEED_ENTRIES = [
  { type: 'income',  amount: 3200000, category: '급여',   memo: '이번 달 월급',     offset: -4 },
  { type: 'expense', amount: 12000,   category: '식비',   memo: '점심 김치찌개',    offset: -3 },
  { type: 'expense', amount: 1550,    category: '교통',   memo: '지하철',          offset: -3 },
  { type: 'expense', amount: 550000,  category: '주거',   memo: '월세',            offset: -2 },
  { type: 'expense', amount: 13900,   category: '구독료', memo: '넷플릭스',        offset: -2 },
  { type: 'expense', amount: 50000,   category: '경조사', memo: '친구 결혼 축의금', offset: -1 },
  { type: 'expense', amount: 8500,    category: '식비',   memo: '카페 아메리카노',  offset: 0 },
  { type: 'income',  amount: 100000,  category: '용돈',   memo: '부모님 용돈',      offset: 0 },
];

// 시작 시 테이블 보장 + 비어 있으면 시드
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS moneybook_entries (
      id         SERIAL PRIMARY KEY,
      type       TEXT        NOT NULL DEFAULT 'expense',
      entry_date DATE        NOT NULL DEFAULT CURRENT_DATE,
      amount     BIGINT      NOT NULL,
      category   TEXT        NOT NULL DEFAULT '기타',
      memo       TEXT        NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM moneybook_entries');
  if (rows[0].count === 0) {
    for (const e of SEED_ENTRIES) {
      await pool.query(
        `INSERT INTO moneybook_entries (type, entry_date, amount, category, memo)
         VALUES ($1, CURRENT_DATE + ($2 || ' days')::interval, $3, $4, $5)`,
        [e.type, String(e.offset), e.amount, e.category, e.memo]
      );
    }
  }

  // 프로필 테이블 (단일 사용자 → id=1 한 행만 유지)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS moneybook_profile (
      id         INTEGER      PRIMARY KEY DEFAULT 1,
      name       TEXT         NOT NULL DEFAULT '사용자',
      email      TEXT         NOT NULL DEFAULT '',
      bio        TEXT         NOT NULL DEFAULT '',
      avatar_url TEXT         NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      CONSTRAINT moneybook_profile_singleton CHECK (id = 1)
    )
  `);
  // 기본 프로필 한 행 보장 (없으면 삽입)
  await pool.query(
    `INSERT INTO moneybook_profile (id, name, email)
     VALUES (1, '머니북 사용자', 'jpchung09@gmail.com')
     ON CONFLICT (id) DO NOTHING`
  );
}

// DB row → 프로필 응답 객체
function rowToProfile(row) {
  return {
    name: row.name,
    email: row.email,
    bio: row.bio,
    avatarUrl: row.avatar_url,
    updatedAt: row.updated_at,
  };
}

// DB row → API 응답 객체
function rowToEntry(row) {
  return {
    id: row.id,
    type: row.type,
    date: row.entry_date, // to_char 로 'YYYY-MM-DD' 문자열로 내려옴
    amount: Number(row.amount),
    category: row.category,
    memo: row.memo,
  };
}

// --- Middleware ---
app.use(express.json({ limit: '12mb' })); // base64 이미지 업로드를 위해 한도 상향
app.use(express.static(path.join(__dirname)));

// --- API routes ---

// 1) 전체 내역 조회 (최신순)
app.get('/api/entries', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, type, to_char(entry_date, 'YYYY-MM-DD') AS entry_date, amount, category, memo
         FROM moneybook_entries
        ORDER BY entry_date DESC, id DESC`
    );
    res.json({ success: true, data: rows.map(rowToEntry) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '내역을 불러오지 못했습니다.' });
  }
});

// 2) 통계: 카테고리별 합계 + 총수입/총지출/잔액
app.get('/api/summary', async (_req, res) => {
  try {
    // 카테고리별 합계 (지출/수입 구분)
    const { rows: byCategory } = await pool.query(
      `SELECT type, category, SUM(amount)::bigint AS total, COUNT(*)::int AS count
         FROM moneybook_entries
        GROUP BY type, category
        ORDER BY total DESC`
    );

    // 타입별 총합
    const { rows: byType } = await pool.query(
      `SELECT type, COALESCE(SUM(amount), 0)::bigint AS total
         FROM moneybook_entries
        GROUP BY type`
    );

    let totalIncome = 0;
    let totalExpense = 0;
    for (const r of byType) {
      if (r.type === 'income') totalIncome = Number(r.total);
      else if (r.type === 'expense') totalExpense = Number(r.total);
    }

    res.json({
      success: true,
      data: {
        totalIncome,
        totalExpense,
        balance: totalIncome - totalExpense,
        categories: byCategory.map((r) => ({
          type: r.type,
          category: r.category,
          total: Number(r.total),
          count: r.count,
        })),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '통계를 불러오지 못했습니다.' });
  }
});

// 3) 내역 등록
app.post('/api/entries', async (req, res) => {
  try {
    const body = req.body || {};

    const type = TYPES.has(body.type) ? body.type : 'expense';

    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: '금액은 0보다 큰 숫자여야 합니다.' });
    }

    const category =
      typeof body.category === 'string' && body.category.trim() ? body.category.trim() : '기타';
    const memo = typeof body.memo === 'string' ? body.memo.trim() : '';
    const date =
      typeof body.date === 'string' && body.date.trim() ? body.date.trim() : null;

    const { rows } = await pool.query(
      `INSERT INTO moneybook_entries (type, entry_date, amount, category, memo)
       VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, $5)
       RETURNING id, type, to_char(entry_date, 'YYYY-MM-DD') AS entry_date, amount, category, memo`,
      [type, date, Math.round(amount), category, memo]
    );
    res.status(201).json({ success: true, data: rowToEntry(rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '내역 등록에 실패했습니다.' });
  }
});

// 4) 내역 수정 (변경할 필드만)
app.patch('/api/entries/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const body = req.body || {};

    const sets = [];
    const values = [];

    if (typeof body.type === 'string') {
      if (!TYPES.has(body.type)) {
        return res.status(400).json({ success: false, message: 'type 은 income 또는 expense 여야 합니다.' });
      }
      values.push(body.type);
      sets.push(`type = $${values.length}`);
    }
    if (body.amount !== undefined) {
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ success: false, message: '금액은 0보다 큰 숫자여야 합니다.' });
      }
      values.push(Math.round(amount));
      sets.push(`amount = $${values.length}`);
    }
    if (typeof body.category === 'string') {
      const category = body.category.trim() ? body.category.trim() : '기타';
      values.push(category);
      sets.push(`category = $${values.length}`);
    }
    if (typeof body.memo === 'string') {
      values.push(body.memo.trim());
      sets.push(`memo = $${values.length}`);
    }
    if (typeof body.date === 'string' && body.date.trim()) {
      values.push(body.date.trim());
      sets.push(`entry_date = $${values.length}::date`);
    }

    if (sets.length === 0) {
      return res.status(400).json({ success: false, message: '수정할 내용이 없습니다.' });
    }

    values.push(id);
    const { rows } = await pool.query(
      `UPDATE moneybook_entries SET ${sets.join(', ')}
        WHERE id = $${values.length}
       RETURNING id, type, to_char(entry_date, 'YYYY-MM-DD') AS entry_date, amount, category, memo`,
      values
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '내역을 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: rowToEntry(rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '내역 수정에 실패했습니다.' });
  }
});

// 5) 내역 삭제
app.delete('/api/entries/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rowCount } = await pool.query('DELETE FROM moneybook_entries WHERE id = $1', [id]);
    if (rowCount === 0) {
      return res.status(404).json({ success: false, message: '내역을 찾을 수 없습니다.' });
    }
    res.json({ success: true, message: '삭제되었습니다.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '내역 삭제에 실패했습니다.' });
  }
});

// --- 프로필 API ---

// 6) 프로필 조회
app.get('/api/profile', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT name, email, bio, avatar_url, updated_at FROM moneybook_profile WHERE id = 1'
    );
    if (rows.length === 0) {
      return res.json({ success: true, data: rowToProfile({ name: '사용자', email: '', bio: '', avatar_url: '' }) });
    }
    res.json({ success: true, data: rowToProfile(rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '프로필을 불러오지 못했습니다.' });
  }
});

// 7) 프로필 수정 (이름 / 이메일 / 소개)
app.put('/api/profile', async (req, res) => {
  try {
    const body = req.body || {};
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : '사용자';
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const bio = typeof body.bio === 'string' ? body.bio.trim() : '';

    const { rows } = await pool.query(
      `UPDATE moneybook_profile
          SET name = $1, email = $2, bio = $3, updated_at = NOW()
        WHERE id = 1
      RETURNING name, email, bio, avatar_url, updated_at`,
      [name, email, bio]
    );
    res.json({ success: true, data: rowToProfile(rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '프로필 수정에 실패했습니다.' });
  }
});

// 8) 프로필 이미지 업로드 → ImageKit → avatar_url 저장
// body: { fileName: string, fileBase64: string(data URL 또는 raw base64) }
app.post('/api/profile/avatar', async (req, res) => {
  try {
    if (!IMAGEKIT_PRIVATE_KEY) {
      return res.status(500).json({ success: false, message: 'ImageKit 설정(IMAGEKIT_PRIVATE_KEY)이 없습니다.' });
    }

    const body = req.body || {};
    const rawFileName =
      typeof body.fileName === 'string' && body.fileName.trim() ? body.fileName.trim() : 'avatar.png';
    const fileBase64 = typeof body.fileBase64 === 'string' ? body.fileBase64 : '';

    if (!fileBase64) {
      return res.status(400).json({ success: false, message: '이미지 데이터가 없습니다.' });
    }

    // data URL(`data:image/png;base64,....`) 형태면 접두부 제거 → 순수 base64
    const base64 = fileBase64.includes(',') ? fileBase64.slice(fileBase64.indexOf(',') + 1) : fileBase64;

    // 파일명 안전화 + 유니크화
    const safeName = rawFileName.replace(/[^\w.\-]+/g, '_');

    // ImageKit 서버-사이드 업로드 (Basic 인증: private key + ':')
    const auth = Buffer.from(`${IMAGEKIT_PRIVATE_KEY}:`).toString('base64');
    const form = new FormData();
    form.append('file', base64); // base64 문자열 업로드 지원
    form.append('fileName', safeName);
    form.append('folder', '/money-book/avatars');
    form.append('useUniqueFileName', 'true');

    const ikResp = await fetch(IMAGEKIT_UPLOAD_URL, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}` },
      body: form,
    });
    const ikJson = await ikResp.json();

    if (!ikResp.ok || !ikJson.url) {
      console.error('ImageKit 업로드 실패:', ikJson);
      return res.status(502).json({
        success: false,
        message: ikJson.message || 'ImageKit 업로드에 실패했습니다.',
      });
    }

    // avatar_url 저장
    const { rows } = await pool.query(
      `UPDATE moneybook_profile SET avatar_url = $1, updated_at = NOW()
        WHERE id = 1
      RETURNING name, email, bio, avatar_url, updated_at`,
      [ikJson.url]
    );

    res.json({ success: true, data: { ...rowToProfile(rows[0]), fileId: ikJson.fileId } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '이미지 업로드 중 오류가 발생했습니다.' });
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
  // 서버리스(Vercel) 환경: 모듈 로드 시 테이블 보장
  initDb().catch((err) => console.error('DB 초기화 실패:', err.message));
}
module.exports = app;
