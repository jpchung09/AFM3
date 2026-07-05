// 가계부 분석 쿼리 모음 (데모용). 실행: node analyze.js
const path = require('path');
process.loadEnvFile(path.join(__dirname, '.env'));
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const TODAY = '2026-07-05';
const q = (s, p) => pool.query(s, p).then((r) => r.rows);

(async () => {
  const out = {};

  out.thisMonthExpense = await q(
    `SELECT COALESCE(SUM(amount),0)::bigint total, COUNT(*)::int cnt
       FROM ledger_entries
      WHERE type='expense' AND date_trunc('month',entry_date)=date_trunc('month',$1::date)`,
    [TODAY]
  );

  out.topFoodDays = await q(
    `SELECT to_char(entry_date,'YYYY-MM-DD') d, to_char(entry_date,'Dy') dow, SUM(amount)::bigint total, COUNT(*)::int cnt
       FROM ledger_entries WHERE type='expense' AND category='식비'
      GROUP BY entry_date ORDER BY total DESC LIMIT 3`
  );

  out.transitByMonth = await q(
    `SELECT to_char(date_trunc('month',entry_date),'YYYY-MM') m, SUM(amount)::bigint total, COUNT(*)::int cnt
       FROM ledger_entries WHERE type='expense' AND category='교통' GROUP BY 1 ORDER BY 1`
  );

  out.weekdayVsWeekend = await q(
    `SELECT CASE WHEN EXTRACT(DOW FROM entry_date) IN (0,6) THEN '주말' ELSE '주중' END g,
            SUM(amount)::bigint total, COUNT(DISTINCT entry_date)::int days, COUNT(*)::int cnt
       FROM ledger_entries WHERE type='expense' GROUP BY 1`
  );

  out.byDow = await q(
    `SELECT EXTRACT(DOW FROM entry_date)::int dow, SUM(amount)::bigint total, COUNT(DISTINCT entry_date)::int days
       FROM ledger_entries WHERE type='expense' GROUP BY 1 ORDER BY total DESC`
  );

  out.byCategory = await q(
    `SELECT category, SUM(amount)::bigint total, COUNT(*)::int cnt,
            ROUND(100.0*SUM(amount)/SUM(SUM(amount)) OVER (),1) pct
       FROM ledger_entries WHERE type='expense' GROUP BY 1 ORDER BY total DESC`
  );

  out.totals = await q(
    `SELECT SUM(amount) FILTER(WHERE type='income')::bigint income,
            SUM(amount) FILTER(WHERE type='expense')::bigint expense,
            to_char(MIN(entry_date),'YYYY-MM-DD') mn, to_char(MAX(entry_date),'YYYY-MM-DD') mx,
            COUNT(DISTINCT entry_date)::int days
       FROM ledger_entries`
  );

  out.subs = await q(
    `SELECT memo, SUM(amount)::bigint total, COUNT(*)::int cnt
       FROM ledger_entries WHERE type='expense' AND category='구독료' GROUP BY memo ORDER BY total DESC`
  );

  out.taxi = await q(
    `SELECT COALESCE(SUM(amount),0)::bigint total, COUNT(*)::int cnt
       FROM ledger_entries WHERE type='expense' AND memo LIKE '%택시%'`
  );

  // 일평균 지출(전체 기간) 및 이번 달 일평균
  out.dailyAvgAll = await q(
    `SELECT ROUND(SUM(amount)/COUNT(DISTINCT entry_date))::bigint per_day
       FROM ledger_entries WHERE type='expense'`
  );
  out.julyDailyAvg = await q(
    `SELECT ROUND(SUM(amount)/COUNT(DISTINCT entry_date))::bigint per_day, COUNT(DISTINCT entry_date)::int days
       FROM ledger_entries
      WHERE type='expense' AND date_trunc('month',entry_date)=date_trunc('month',$1::date)`,
    [TODAY]
  );

  console.log(JSON.stringify(out, null, 1));
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
