// 분석 데모용 샘플 데이터 생성 스크립트
// 2026-06-01 ~ 2026-07-05 (약 5주) 구간에 현실적인 수입/지출 패턴을 생성한다.
// 실행: node seed-sample-data.js   (기존 데이터를 모두 지우고 새로 채움)
//
// 패턴 특징:
//  - 평일: 교통비(출퇴근) + 식비(점심)
//  - 주말: 식비(외식)·문화(영화/카페) 비중↑, 교통비↓
//  - 월초: 월세, 구독료 등 고정지출
//  - 급여는 매월 25일

const path = require('path');
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// 재현 가능한 의사난수 (seed 고정)
let seed = 20260705;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (min, max, step = 100) =>
  Math.round((min + rand() * (max - min)) / step) * step;

const fmt = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const 식비메뉴 = ['점심 백반', '김치찌개', '분식', '편의점 도시락', '카페 아메리카노', '치킨 배달', '삼겹살 회식', '샐러드', '국밥', '햄버거 세트', '마라탕', '초밥'];
const 문화활동 = ['영화 관람', '전시회', '카페 디저트', '노래방', '보드게임 카페', '서점 도서 구매'];
const 교통수단 = ['지하철', '버스', '따릉이', '택시'];

const rows = [];
const start = new Date(2026, 5, 1); // 6월 1일
const end = new Date(2026, 6, 5);   // 7월 5일

for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
  const date = fmt(d);
  const dow = d.getDay(); // 0=일 ~ 6=토
  const isWeekend = dow === 0 || dow === 6;
  const day = d.getDate();

  // --- 고정 지출 (월초) ---
  if (day === 1) {
    rows.push(['expense', date, 550000, '주거', '월세']);
    rows.push(['expense', date, 62000, '주거', '관리비']);
  }
  if (day === 15) rows.push(['expense', date, 55000, '주거', '전기·가스요금']);

  // --- 구독료 (고정일) ---
  if (day === 5) rows.push(['expense', date, 13900, '구독료', '넷플릭스']);
  if (day === 8) rows.push(['expense', date, 14900, '구독료', '유튜브 프리미엄']);
  if (day === 12) rows.push(['expense', date, 11900, '구독료', '멜론 스트리밍']);
  if (day === 20) rows.push(['expense', date, 9900, '구독료', '쿠팡 와우멤버십']);

  // --- 수입 ---
  if (day === 25) rows.push(['income', date, 3200000, '급여', '월급']);
  if (day === 10) rows.push(['income', date, 100000, '용돈', '부모님 용돈']);

  // --- 식비 (거의 매일) ---
  // 점심
  rows.push(['expense', date, between(6000, 13000), '식비', pick(식비메뉴)]);
  // 저녁 (주말엔 외식 비중↑, 금액↑)
  if (isWeekend || rand() < 0.5) {
    rows.push(['expense', date, between(isWeekend ? 15000 : 8000, isWeekend ? 45000 : 20000), '식비', pick(식비메뉴)]);
  }

  // --- 교통 (평일 위주) ---
  if (!isWeekend) {
    rows.push(['expense', date, pick([1250, 1250, 1550, 2500]), '교통', pick(['지하철', '버스'])]);
    if (rand() < 0.25) rows.push(['expense', date, between(6000, 15000), '교통', '택시']);
  } else if (rand() < 0.4) {
    rows.push(['expense', date, pick([1250, 3000, 8000]), '교통', pick(교통수단)]);
  }

  // --- 문화 (주말 위주) ---
  if (isWeekend && rand() < 0.7) {
    rows.push(['expense', date, between(9000, 35000), '문화', pick(문화활동)]);
  } else if (rand() < 0.12) {
    rows.push(['expense', date, between(9000, 20000), '문화', pick(문화활동)]);
  }

  // --- 경조사 / 의료 / 기타 (가끔) ---
  if (rand() < 0.06) rows.push(['expense', date, pick([50000, 100000, 100000, 150000]), '경조사', pick(['결혼 축의금', '조의금', '생일 선물'])]);
  if (rand() < 0.05) rows.push(['expense', date, between(4000, 40000), '의료', pick(['약국', '병원 진료', '치과'])]);
  if (rand() < 0.08) rows.push(['expense', date, between(5000, 30000), '기타', pick(['생활용품', '다이소', '선물', '미용실'])]);
}

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'expense',
      entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
      amount BIGINT NOT NULL,
      category TEXT NOT NULL DEFAULT '기타',
      memo TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('TRUNCATE ledger_entries RESTART IDENTITY');

  for (const [type, date, amount, category, memo] of rows) {
    await pool.query(
      `INSERT INTO ledger_entries (type, entry_date, amount, category, memo)
       VALUES ($1, $2::date, $3, $4, $5)`,
      [type, date, amount, category, memo]
    );
  }

  const { rows: stat } = await pool.query(
    `SELECT COUNT(*)::int total,
            SUM(amount) FILTER (WHERE type='income')::bigint income,
            SUM(amount) FILTER (WHERE type='expense')::bigint expense
       FROM ledger_entries`
  );
  console.log(`✅ 시드 완료: ${rows.length}건 삽입`);
  console.log(stat[0]);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
