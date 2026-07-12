// ============================================================================
// SOLE Shop — Backend Server (server.js)
// Express + PostgreSQL(Supabase) · JWT auth · order/payment history
//
// The single source of backend truth for this 3-file style project
// (server.js + index.html). Runs locally via `node server.js` and is also
// safe to export for a serverless host (Vercel) via module.exports.
// ============================================================================
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Pool, types } = require('pg');
const jwt = require('jsonwebtoken');

// bcryptjs (pure-JS, as requested). Resilient require so a missing native
// binary can never block boot.
let bcrypt;
try { bcrypt = require('bcryptjs'); } catch { bcrypt = require('bcrypt'); }

// pg returns BIGINT/int8 (oid 20) as a *string* for precision safety. Our
// amounts (KRW) are well under 2^53, so parse them to real numbers — keeps
// JSON responses numeric (won() formatting on the client depends on it).
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));

// ============================================================================
// 1. Config
// ============================================================================
const PORT = process.env.PORT || 3000;
const DATABASE_URL = (process.env.DATABASE_URL || '').trim(); // .trim() guards trailing newlines

// --- JWT secret: read from .env, otherwise self-provision a strong random
// secret and persist it (never hardcode a secret). ---
let JWT_SECRET = (process.env.JWT_SECRET || '').trim();
if (!JWT_SECRET) {
  JWT_SECRET = crypto.randomBytes(48).toString('hex');
  try {
    const envPath = path.join(__dirname, '.env');
    let prefix = '';
    if (fs.existsSync(envPath)) {
      const cur = fs.readFileSync(envPath, 'utf8');
      if (cur.length && !cur.endsWith('\n')) prefix = '\n'; // don't merge onto a prior line
    }
    fs.appendFileSync(envPath, `${prefix}JWT_SECRET=${JWT_SECRET}\n`);
    console.log('[env] JWT_SECRET was missing — generated one and saved it to .env');
  } catch (err) {
    console.warn('[env] Could not persist JWT_SECRET to .env (using in-memory secret):', err.message);
  }
  process.env.JWT_SECRET = JWT_SECRET;
}
const JWT_EXPIRES_IN = '7d';

// --- TossPayments keys ---
// Client key → sent to the browser (public). Secret key → server-only, used to
// call the confirm API with HTTP Basic auth. NEVER expose the secret to the
// client. Falls back to Toss's public test keys so a fresh clone works offline.
const TOSS_CLIENT_KEY = (process.env.TOSS_CLIENT_KEY || 'test_gck_docs_Ovk5rk1EwkEbP0W43n07xlzm').trim();
const TOSS_SECRET_KEY = (process.env.TOSS_SECRET_KEY || 'test_gsk_docs_OaPz8L5KdmQXkzRz3y47BMw6').trim();
const TOSS_CONFIRM_URL = 'https://api.tosspayments.com/v1/payments/confirm';

// --- Server-side price catalogue = the source of truth for money. ---
// The client (index.html) has the full product data, but amounts must never be
// trusted from the browser. We recompute every order total here by productId so
// a tampered client price is caught before we ever ask Toss to charge a card.
const PRICES = {
  p1: 129000, p2: 148000, p3: 98000, p4: 112000, p5: 219000, p6: 189000,
  p7: 69000, p8: 45000, p9: 175000, p10: 139000, p11: 165000, p12: 84000,
};
const FREE_SHIP_THRESHOLD = 50000;
const SHIPPING_FEE = 3000;

// Compute the authoritative total (items subtotal + shipping) from a cart.
// Returns { cleanItems, amount } or throws on an unknown/empty cart.
function priceCart(items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('주문 항목이 비어 있습니다.');
  const cleanItems = items.map((it) => {
    const productId = it.productId ?? it.id ?? null;
    const price = PRICES[productId];
    if (price == null) throw new Error(`알 수 없는 상품입니다: ${productId}`);
    return {
      productId,
      name: String(it.name ?? ''),
      brand: String(it.brand ?? ''),
      color: String(it.color ?? ''),
      size: it.size ?? '',
      qty: Math.max(1, parseInt(it.qty, 10) || 1),
      price, // authoritative price from the server catalogue
    };
  });
  const subtotal = cleanItems.reduce((s, it) => s + it.price * it.qty, 0);
  const shipping = subtotal >= FREE_SHIP_THRESHOLD ? 0 : SHIPPING_FEE;
  return { cleanItems, amount: subtotal + shipping };
}

// ============================================================================
// 2. PostgreSQL pool (Supabase transaction pooler :6543 — SSL required)
//    node-postgres uses *unnamed* prepared statements by default, which the
//    transaction pooler handles fine. We only use plain parameterized
//    query() calls (no named prepared statements).
// ============================================================================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  connectionTimeoutMillis: 10000,
});
// A dropped idle client must not crash the process.
pool.on('error', (err) => console.error('[pg] idle client error:', err.message));

// ============================================================================
// 3. Lazy table init (idempotent; safe for cold starts / concurrent requests)
//    All tables are prefixed with `shop_`.
// ============================================================================
let dbInitialized = false;
let initPromise = null;
async function initDB() {
  if (dbInitialized) return;
  if (initPromise) return initPromise; // coalesce concurrent callers
  initPromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shop_users (
        id            BIGSERIAL PRIMARY KEY,
        email         TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name          TEXT NOT NULL DEFAULT '',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shop_orders (
        id           BIGSERIAL PRIMARY KEY,
        user_id      BIGINT NOT NULL REFERENCES shop_users(id) ON DELETE CASCADE,
        items        JSONB NOT NULL DEFAULT '[]'::jsonb,
        total_amount BIGINT NOT NULL DEFAULT 0,
        status       TEXT NOT NULL DEFAULT 'pending',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    // Payment columns (added idempotently so existing deployments upgrade in place).
    await pool.query(`
      ALTER TABLE shop_orders
        ADD COLUMN IF NOT EXISTS toss_order_id TEXT,
        ADD COLUMN IF NOT EXISTS payment_key   TEXT,
        ADD COLUMN IF NOT EXISTS method        TEXT,
        ADD COLUMN IF NOT EXISTS receipt_url   TEXT,
        ADD COLUMN IF NOT EXISTS approved_at   TIMESTAMPTZ;
    `);
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_orders_toss ON shop_orders (toss_order_id) WHERE toss_order_id IS NOT NULL;`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_shop_orders_user ON shop_orders (user_id, created_at DESC);`
    );
    dbInitialized = true;
    console.log('[db] Tables ready: shop_users, shop_orders');
  })();
  try {
    await initPromise;
  } catch (err) {
    initPromise = null; // allow a retry on the next request
    throw err;
  }
}

// ============================================================================
// 4. App + middleware
// ============================================================================
const app = express();
app.use(express.json({ limit: '1mb' }));

// --- consistent response helpers ---
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const fail = (res, message, status = 400) => res.status(status).json({ success: false, message });

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, created_at: u.created_at });
const signToken = (u) => jwt.sign({ sub: u.id, email: u.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Make sure the DB is initialized before any /api call (lazy init).
app.use('/api', async (_req, res, next) => {
  try {
    await initDB();
    next();
  } catch (err) {
    console.error('[db] init failed:', err.message);
    fail(res, '데이터베이스 초기화에 실패했습니다.', 500);
  }
});

// JWT auth guard — attaches req.user for protected routes.
async function authRequired(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) return fail(res, '로그인이 필요합니다.', 401);

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch {
      return fail(res, '인증이 만료되었거나 올바르지 않습니다.', 401);
    }

    const { rows } = await pool.query(
      'SELECT id, email, name, created_at FROM shop_users WHERE id = $1',
      [payload.sub]
    );
    if (!rows[0]) return fail(res, '사용자를 찾을 수 없습니다.', 401);
    req.user = rows[0];
    next();
  } catch (err) {
    console.error('[auth] error:', err.message);
    fail(res, '인증 처리 중 오류가 발생했습니다.', 500);
  }
}

// ============================================================================
// 5. Auth routes
// ============================================================================
app.post('/api/auth/signup', async (req, res) => {
  try {
    let { email, password, name } = req.body || {};
    email = String(email || '').trim().toLowerCase();
    name = String(name || '').trim();

    if (!EMAIL_RE.test(email)) return fail(res, '올바른 이메일을 입력해주세요.');
    if (!password || String(password).length < 6) return fail(res, '비밀번호는 6자 이상이어야 합니다.');
    if (!name) name = email.split('@')[0];

    const dup = await pool.query('SELECT id FROM shop_users WHERE email = $1', [email]);
    if (dup.rows[0]) return fail(res, '이미 가입된 이메일입니다.', 409);

    const passwordHash = await bcrypt.hash(String(password), 10);
    const { rows } = await pool.query(
      'INSERT INTO shop_users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name, created_at',
      [email, passwordHash, name]
    );
    const user = rows[0];
    return ok(res, { token: signToken(user), user: publicUser(user) }, 201);
  } catch (err) {
    if (err.code === '23505') return fail(res, '이미 가입된 이메일입니다.', 409); // unique_violation race
    console.error('[signup] error:', err.message);
    return fail(res, '회원가입 처리 중 오류가 발생했습니다.', 500);
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    let { email, password } = req.body || {};
    email = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || !password) return fail(res, '이메일과 비밀번호를 입력해주세요.');

    const { rows } = await pool.query(
      'SELECT id, email, name, password_hash, created_at FROM shop_users WHERE email = $1',
      [email]
    );
    const user = rows[0];
    // Same message whether the email is unknown or the password is wrong.
    if (!user) return fail(res, '이메일 또는 비밀번호가 올바르지 않습니다.', 401);
    const good = await bcrypt.compare(String(password), user.password_hash);
    if (!good) return fail(res, '이메일 또는 비밀번호가 올바르지 않습니다.', 401);

    return ok(res, { token: signToken(user), user: publicUser(user) });
  } catch (err) {
    console.error('[login] error:', err.message);
    return fail(res, '로그인 처리 중 오류가 발생했습니다.', 500);
  }
});

app.get('/api/auth/me', authRequired, (req, res) => ok(res, publicUser(req.user)));

// ============================================================================
// 6. Public config — the browser fetches the Toss *client* key from here
//    instead of hardcoding it. (The secret key never leaves the server.)
// ============================================================================
app.get('/api/config', (_req, res) => ok(res, { tossClientKey: TOSS_CLIENT_KEY }));

// ============================================================================
// 7. Order / payment routes (protected)
// ============================================================================
// (7a) Create a PENDING order. The server prices the cart itself and mints a
//      unique Toss orderId — this is the amount Toss will be told to charge and
//      the amount we verify again at confirm time.
app.post('/api/orders', authRequired, async (req, res) => {
  try {
    const { items } = req.body || {};

    let priced;
    try {
      priced = priceCart(items); // { cleanItems, amount } — throws on bad input
    } catch (e) {
      return fail(res, e.message || '주문 항목이 올바르지 않습니다.');
    }
    const { cleanItems, amount } = priced;

    // Unguessable, Toss-compatible order id (6–64 chars, [A-Za-z0-9_-]).
    const tossOrderId = `sole_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    const first = cleanItems[0];
    const orderName =
      cleanItems.length > 1 ? `${first.name} 외 ${cleanItems.length - 1}건` : first.name || '주문';

    // JSONB param must be a JSON *string* + ::jsonb cast.
    const { rows } = await pool.query(
      `INSERT INTO shop_orders (user_id, items, total_amount, status, toss_order_id)
       VALUES ($1, $2::jsonb, $3, 'pending', $4)
       RETURNING id, total_amount, created_at`,
      [req.user.id, JSON.stringify(cleanItems), amount, tossOrderId]
    );

    return ok(res, { id: rows[0].id, tossOrderId, orderName, amount }, 201);
  } catch (err) {
    console.error('[orders:create] error:', err.message);
    return fail(res, '주문 생성 중 오류가 발생했습니다.', 500);
  }
});

// (7b) Confirm payment. Toss redirects the browser back with paymentKey/orderId/
//      amount; the client posts them here. We re-verify the amount against the
//      stored order, then call Toss's confirm API with the SECRET key (Basic
//      auth) — the only place a real charge is authorized. Idempotent on reload.
app.post('/api/payments/confirm', authRequired, async (req, res) => {
  const { paymentKey, orderId, amount } = req.body || {};
  if (!paymentKey || !orderId || amount == null) {
    return fail(res, '결제 정보가 올바르지 않습니다.');
  }

  try {
    const { rows } = await pool.query(
      'SELECT * FROM shop_orders WHERE toss_order_id = $1',
      [orderId]
    );
    const order = rows[0];
    if (!order) return fail(res, '주문을 찾을 수 없습니다.', 404);

    // Only the owner may confirm their own order.
    if (Number(order.user_id) !== Number(req.user.id)) {
      return fail(res, '본인의 주문만 결제할 수 있습니다.', 403);
    }

    // Already paid (e.g. success page refreshed) → return the stored result.
    if (order.status === 'paid') {
      return ok(res, {
        id: order.id, orderName: order.items?.[0]?.name || '주문',
        amount: Number(order.total_amount), method: order.method,
        receiptUrl: order.receipt_url, approvedAt: order.approved_at, alreadyPaid: true,
      });
    }

    // Amount must match the server-priced total exactly.
    if (Number(amount) !== Number(order.total_amount)) {
      await pool.query(`UPDATE shop_orders SET status = 'failed' WHERE id = $1`, [order.id]);
      return fail(res, '결제 금액이 주문 금액과 일치하지 않습니다.');
    }

    // Server-to-server confirm with the secret key.
    const basic = Buffer.from(`${TOSS_SECRET_KEY}:`).toString('base64');
    const tossResp = await fetch(TOSS_CONFIRM_URL, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentKey, orderId, amount: Number(amount) }),
    });
    const payment = await tossResp.json();

    if (!tossResp.ok) {
      await pool.query(`UPDATE shop_orders SET status = 'failed' WHERE id = $1`, [order.id]);
      return res.status(tossResp.status).json({
        success: false, code: payment.code, message: payment.message || '결제 승인에 실패했습니다.',
      });
    }

    const receiptUrl = payment.receipt ? payment.receipt.url : null;
    const { rows: updated } = await pool.query(
      `UPDATE shop_orders
          SET status = 'paid', payment_key = $2, method = $3, receipt_url = $4, approved_at = $5
        WHERE id = $1
      RETURNING id, total_amount, method, receipt_url, approved_at, items`,
      [order.id, paymentKey, payment.method || null, receiptUrl, payment.approvedAt || null]
    );
    const o = updated[0];

    return ok(res, {
      id: o.id, orderName: o.items?.[0]?.name || '주문', amount: Number(o.total_amount),
      method: o.method, receiptUrl: o.receipt_url, approvedAt: o.approved_at,
    });
  } catch (err) {
    console.error('[payments:confirm] error:', err.message);
    return fail(res, '결제 승인 처리 중 오류가 발생했습니다.', 500);
  }
});

app.get('/api/orders', authRequired, async (req, res) => {
  try {
    // Only the signed-in user's *paid* orders — the payment history. The
    // user_id filter is what enforces "본인 주문만" (권한 제어).
    const { rows } = await pool.query(
      `SELECT id, items, total_amount, status, method, receipt_url, approved_at, created_at
       FROM shop_orders
       WHERE user_id = $1 AND status = 'paid'
       ORDER BY approved_at DESC NULLS LAST, id DESC`,
      [req.user.id]
    );
    return ok(res, rows);
  } catch (err) {
    console.error('[orders:list] error:', err.message);
    return fail(res, '주문 내역을 불러오지 못했습니다.', 500);
  }
});

// Unknown API route -> JSON 404 (registered before the SPA fallback).
app.use('/api', (_req, res) => fail(res, '요청하신 API를 찾을 수 없습니다.', 404));

// ============================================================================
// 8. Static: serve the self-contained SPA.
//    The app inlines all assets (base64 images) into index.html, so index.html
//    is the only file the browser needs. We serve it explicitly rather than
//    express.static(__dirname) so server.js / .env / package.json are never
//    exposed over HTTP. Regex route works on both Express 4 and 5.
// ============================================================================
const INDEX_HTML = path.join(__dirname, 'index.html');
app.get(/^\/(?!api(?:\/|$)).*/, (_req, res) => res.sendFile(INDEX_HTML));

// ============================================================================
// 9. Startup (local) / export (serverless)
// ============================================================================
async function start() {
  try {
    await initDB();
    console.log('[db] Connected to PostgreSQL and initialized tables.');
  } catch (err) {
    console.error('[db] Initial connect/init failed (will retry lazily per request):', err.message);
  }
  app.listen(PORT, () => console.log(`SOLE shop server running → http://localhost:${PORT}`));
}

if (require.main === module) {
  start();
}
module.exports = app;
