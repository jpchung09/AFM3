const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

// .env 파일이 있으면 환경변수로 로드 (Node 20.6+ 내장 기능)
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* .env 없으면 무시 */ }

const app = express();
const PORT = process.env.PORT || 3000;

// --- TossPayments 키 ---
// 클라이언트 키: 프론트로 내려가는 공개 키. 시크릿 키: 서버 전용(절대 노출 금지).
const TOSS_CLIENT_KEY = (process.env.TOSS_CLIENT_KEY || 'test_gck_docs_Ovk5rk1EwkEbP0W43n07xlzm').trim();
const TOSS_SECRET_KEY = (process.env.TOSS_SECRET_KEY || 'test_gsk_docs_OaPz8L5KdmQXkzRz3y47BMw6').trim();
const TOSS_CONFIRM_URL = 'https://api.tosspayments.com/v1/payments/confirm';

// --- PostgreSQL (Supabase) data store ---
const DATABASE_URL =
  (process.env.DATABASE_URL ||
    'postgresql://postgres.iwlstbwrhhtylkhiypwe:@aws-1-us-east-1.pooler.supabase.com:6543/postgres').trim();

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Supabase 는 SSL 필요
});

// ==========================================================
// 상품 카탈로그 — 가격의 "서버 측 진실의 원천"(Source of Truth).
// 결제 승인 시 이 가격과 대조해 금액 위·변조를 차단한다.
// ==========================================================
const PRODUCTS = [
  { id: 'tshirt',   name: '베이직 티셔츠',   price: 19000, emoji: '👕', desc: '부드러운 순면 100%' },
  { id: 'sneakers', name: '데일리 스니커즈', price: 59000, emoji: '👟', desc: '가볍고 편한 데일리 슈즈' },
  { id: 'cap',      name: '볼캡',           price: 25000, emoji: '🧢', desc: '자외선 차단 코튼 볼캡' },
  { id: 'bag',      name: '캔버스 백팩',     price: 45000, emoji: '🎒', desc: '15인치 노트북 수납' },
  { id: 'watch',    name: '미니멀 워치',     price: 89000, emoji: '⌚', desc: '스테인리스 메탈밴드' },
  { id: 'coffee',   name: '스페셜티 원두',   price: 15000, emoji: '☕', desc: '핸드드립용 갓 볶은 200g' },
];
const productById = (id) => PRODUCTS.find((p) => p.id === id);

// 시작 시 주문 테이블 보장
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_orders (
      order_id    TEXT        PRIMARY KEY,
      product_id  TEXT        NOT NULL,
      order_name  TEXT        NOT NULL,
      amount      BIGINT      NOT NULL,
      status      TEXT        NOT NULL DEFAULT 'PENDING', -- PENDING | PAID | FAILED
      payment_key TEXT,
      method      TEXT,
      receipt_url TEXT,
      approved_at TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

// --- Middleware ---
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// --- API routes ---

// 0) 공개 설정 (클라이언트 키 등) — 프론트가 하드코딩 대신 여기서 받아간다
app.get('/api/config', (_req, res) => {
  res.json({ success: true, data: { clientKey: TOSS_CLIENT_KEY } });
});

// 1) 상품 목록
app.get('/api/products', (_req, res) => {
  res.json({ success: true, data: PRODUCTS });
});

// 2) 주문 생성 — 서버가 상품 가격을 확정해 주문을 저장하고 orderId 를 발급한다.
//    클라이언트가 보낸 금액은 신뢰하지 않는다.
app.post('/api/orders', async (req, res) => {
  try {
    const productId = (req.body && req.body.productId) || '';
    const product = productById(productId);
    if (!product) {
      return res.status(400).json({ success: false, message: '존재하지 않는 상품입니다.' });
    }

    // 추측 불가능한 고유 orderId (토스 권장: 6~64자)
    const orderId = `order_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    const orderName = product.name;
    const amount = product.price;

    await pool.query(
      `INSERT INTO shop_orders (order_id, product_id, order_name, amount, status)
       VALUES ($1, $2, $3, $4, 'PENDING')`,
      [orderId, product.id, orderName, amount]
    );

    res.status(201).json({ success: true, data: { orderId, orderName, amount } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '주문 생성에 실패했습니다.' });
  }
});

// 3) 결제 승인 — successUrl 로 돌아온 paymentKey/orderId/amount 를 검증 후 토스 승인 API 호출.
//    ⚠️ 반드시 서버에 저장된 주문 금액과 대조한다.
app.post('/api/confirm', async (req, res) => {
  const { paymentKey, orderId, amount } = req.body || {};

  if (!paymentKey || !orderId || amount == null) {
    return res.status(400).json({ success: false, message: '결제 정보가 올바르지 않습니다.' });
  }

  try {
    // (1) 서버에 저장된 주문 조회
    const { rows } = await pool.query('SELECT * FROM shop_orders WHERE order_id = $1', [orderId]);
    const order = rows[0];
    if (!order) {
      return res.status(404).json({ success: false, message: '주문을 찾을 수 없습니다.' });
    }

    // (2) 이미 승인된 주문이면 중복 승인 방지 (새로고침 대비)
    if (order.status === 'PAID') {
      return res.json({
        success: true,
        alreadyPaid: true,
        data: {
          orderId: order.order_id,
          orderName: order.order_name,
          amount: Number(order.amount),
          method: order.method,
          receiptUrl: order.receipt_url,
          approvedAt: order.approved_at,
        },
      });
    }

    // (3) 금액 검증 — 클라이언트가 보낸 amount 가 서버 주문 금액과 정확히 일치해야 함
    if (Number(amount) !== Number(order.amount)) {
      await pool.query(`UPDATE shop_orders SET status = 'FAILED' WHERE order_id = $1`, [orderId]);
      return res.status(400).json({
        success: false,
        message: '결제 금액이 주문 금액과 일치하지 않습니다.',
      });
    }

    // (4) 토스페이먼츠 승인 API 호출 (시크릿 키 Basic 인증)
    const encodedKey = Buffer.from(`${TOSS_SECRET_KEY}:`).toString('base64');
    const tossResp = await fetch(TOSS_CONFIRM_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${encodedKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ paymentKey, orderId, amount: Number(amount) }),
    });
    const payment = await tossResp.json();

    if (!tossResp.ok) {
      // 승인 실패 → 주문 실패 처리
      await pool.query(`UPDATE shop_orders SET status = 'FAILED' WHERE order_id = $1`, [orderId]);
      return res.status(tossResp.status).json({
        success: false,
        code: payment.code,
        message: payment.message || '결제 승인에 실패했습니다.',
      });
    }

    // (5) 승인 성공 → 주문 상태 갱신
    const receiptUrl = payment.receipt ? payment.receipt.url : null;
    await pool.query(
      `UPDATE shop_orders
          SET status = 'PAID', payment_key = $2, method = $3, receipt_url = $4, approved_at = $5
        WHERE order_id = $1`,
      [orderId, paymentKey, payment.method || null, receiptUrl, payment.approvedAt || null]
    );

    res.json({
      success: true,
      data: {
        orderId,
        orderName: order.order_name,
        amount: Number(amount),
        method: payment.method,
        receiptUrl,
        approvedAt: payment.approvedAt,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '결제 승인 처리 중 오류가 발생했습니다.' });
  }
});

// 4) 주문 상태 조회 (선택)
app.get('/api/orders/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM shop_orders WHERE order_id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: '주문을 찾을 수 없습니다.' });
    const o = rows[0];
    res.json({
      success: true,
      data: {
        orderId: o.order_id, orderName: o.order_name, amount: Number(o.amount),
        status: o.status, method: o.method, receiptUrl: o.receipt_url, approvedAt: o.approved_at,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '주문 조회에 실패했습니다.' });
  }
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
