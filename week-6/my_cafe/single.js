// ============================================================================
// my_cafe — 평택 자매도시 탐색기 · 단일 개발 서버 (single.js)
//   Express 정적 서빙 + Supabase PostgreSQL(cafe_candidate_cities) 조회/시드
//   Architecture: Option 1 (Single-File) — 프론트는 index.html 하나.
// ============================================================================
const path = require('path');
const express = require('express');
const { Pool, types } = require('pg');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* .env 없으면 무시 */ }

types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10))); // BIGINT → number

const app = express();
const PORT = process.env.PORT || 3100;
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  connectionTimeoutMillis: 10000,
});
pool.on('error', (err) => console.error('[pg] idle client error:', err.message));

// ---- 리서치 기반 후보 도시 (임무2 결과 · 시드 데이터의 원천) ------------------
// 시도지사협의회(GAOK)·PIEF 및 공개 출처 교차검증. 9곳 추천 + 3곳 미추천(대조군).
const SEED_CITIES = [
  { name_en:'Hsinchu', name_ko:'신주', country_en:'Taiwan', country_ko:'대만', flag:'🇹🇼', lat:24.8138, lng:120.9675, recommend:true, tier:'strong', theme:'semiconductor', sort_order:1,
    tagline_ko:'TSMC 본사와 신주과학단지 — 세계 반도체의 발상지',
    commonalities_ko:'신주는 TSMC 본사와 UMC를 품은 신주과학단지(500여 개 첨단기업)의 도시로, 삼성 세계 최대 반도체 캠퍼스를 보유한 평택과 가장 직접적인 「반도체 대 반도체」 쌍입니다. 두 도시 모두 한 국가의 첨단 제조 경쟁력을 상징하며, 인재·협력사·유틸리티(용수·전력)가 밀집한 클러스터 구조가 판박이입니다.',
    complements_ko:'신주는 파운드리 생태계 운영과 인재 양성(대학·ITRI 연구소 연계)에서 수십 년 노하우를 축적해, 평택 고덕 캠퍼스의 협력사 클러스터 고도화와 반도체 인력 교류에 실질적 벤치마크를 제공합니다. 미·중 공급망 재편 국면에서 한·대만 반도체 지방정부 채널을 여는 전략적 가치도 큽니다.', why_not_ko:'' },
  { name_en:'Dresden', name_ko:'드레스덴', country_en:'Germany', country_ko:'독일', flag:'🇩🇪', lat:51.0504, lng:13.7373, recommend:true, tier:'strong', theme:'semiconductor', sort_order:2,
    tagline_ko:'「실리콘 작센」 — 유럽 최대 반도체 허브',
    commonalities_ko:'드레스덴은 유럽에서 생산되는 칩 3개 중 1개를 만드는 「실리콘 작센」의 중심으로, ESMC(TSMC·보쉬·인피니온·NXP 합작 100억 유로 팹)·인피니온·글로벌파운드리 메가팹이 집결해 있습니다. 대기업 앵커 팹을 중심으로 도시가 성장하는 구조가 삼성을 축으로 하는 평택과 흡사합니다.',
    complements_ko:'정부·기업·연구소가 클러스터를 함께 설계하는 유럽식 산학연 거버넌스와 EU 칩스법(CHIPS Act) 연계 지원 모델을 갖춰, 평택이 국가 반도체 메가클러스터를 지역 차원에서 운영하는 데 참고가 됩니다. 유럽 반도체 공급망의 관문 역할도 기대됩니다.', why_not_ko:'' },
  { name_en:'Eindhoven', name_ko:'에인트호번', country_en:'Netherlands', country_ko:'네덜란드', flag:'🇳🇱', lat:51.4416, lng:5.4697, recommend:true, tier:'strong', theme:'planned_city', sort_order:3,
    tagline_ko:'ASML의 브레인포트 — 계획된 혁신 도시',
    commonalities_ko:'노광장비 독점기업 ASML을 축으로 조성된 「브레인포트」 혁신 생태계 도시로, 시의회가 2만 명 규모 ASML 신캠퍼스를 승인(2026)하는 등 계획적으로 성장합니다. 반도체 밸류체인의 핵심 도시이자, 국가·지자체가 도시를 설계해 키운다는 점에서 고덕국제신도시를 조성 중인 평택과 두 겹으로 맞물립니다.',
    complements_ko:'평택이 갖지 못한 반도체 「장비·소재」 축(ASML·협력사)을 보완하며, 인프라·주택·인력을 묶은 25억 유로 「Project Beethoven」식 도시-산업 통합 개발 경험은 고덕신도시 정주여건 설계에 직접적 교훈을 줍니다.', why_not_ko:'' },
  { name_en:'Hillsboro', name_ko:'힐즈버러', country_en:'United States', country_ko:'미국', flag:'🇺🇸', lat:45.5229, lng:-122.9898, recommend:true, tier:'strong', theme:'semiconductor', sort_order:4,
    tagline_ko:'인텔 R&D의 심장 「실리콘 포레스트」',
    commonalities_ko:'오리건주 힐즈버러의 론러 에이커스(D1X 팹)는 인텔 18A 등 차세대 공정이 태어나는 세계 최고 수준의 반도체 R&D 거점으로, 300억 달러 이상이 투입된 「실리콘 포레스트」의 핵심입니다. 대형 반도체 앵커가 도시 경제·수출(오리건 수출의 약 60%가 전자)을 좌우하는 구조가 평택과 닮았습니다.',
    complements_ko:'미국 내 반도체 R&D 중심지로서 한·미 반도체 동맹을 지방정부 차원에서 상징적으로 연결합니다. 이미 미국 모빌(앨라배마)과 결연한 평택이 「산업형」 미국 파트너로 포트폴리오를 넓히는 데 적합합니다.', why_not_ko:'' },
  { name_en:'Bremerhaven', name_ko:'브레머하펜', country_en:'Germany', country_ko:'독일', flag:'🇩🇪', lat:53.5396, lng:8.5809, recommend:true, tier:'strong', theme:'automotive', sort_order:5,
    tagline_ko:'유럽 최대 자동차 수출항 — 연 170만 대',
    commonalities_ko:'브레머하펜은 BLG 로지스틱스가 운영하는 「유럽 최대 자동차 주차장」으로, 18개 선석·5km 안벽에서 연 약 170만 대를 처리하며 그중 3/4이 수출입니다. 자동차 수출과 대(對)중국 교역을 주력으로 하는 평택항, KG모빌리티 생산기지를 둔 평택과 기능적으로 거의 동일합니다.',
    complements_ko:'완성차 로지스틱스·PDI(출고 전 검수)·항만 자동화 운영에서 세계 최정상급이라, 평택항의 자동차 물류 고도화와 수출 밸류체인 개선에 실질적 협력이 가능합니다. 유럽 자동차 산업 네트워크의 창구 역할도 합니다.', why_not_ko:'' },
  { name_en:'Killeen', name_ko:'킬린', country_en:'United States', country_ko:'미국', flag:'🇺🇸', lat:31.1171, lng:-97.7278, recommend:true, tier:'good', theme:'military', sort_order:6,
    tagline_ko:'포트 후드 — 미 본토 최대급 육군기지 도시',
    commonalities_ko:'킬린은 미 본토 최대급 육군기지 포트 후드(III 기갑군단·제1기병사단, 약 21만 에이커)에 붙어 성장한 「군사 도시」로, 세계 최대 미 해외기지 캠프 험프리스를 품은 평택의 대칭점입니다. 대규모 미군·군인가족 커뮤니티와 함께 사는 도시 운영 과제(정주·상권·한미 문화)가 공통됩니다.',
    complements_ko:'기지-도시 상생, 군인가족 정착 지원, 기지 주변 경제 활성화 정책에서 수십 년 경험을 공유할 수 있어, 캠프 험프리스와 공존하는 평택의 도시행정에 직접적 벤치마크가 됩니다. 한미동맹을 지방 차원에서 상징하는 스토리텔링 가치가 큽니다.', why_not_ko:'' },
  { name_en:'Yokosuka', name_ko:'요코스카', country_en:'Japan', country_ko:'일본', flag:'🇯🇵', lat:35.2815, lng:139.6722, recommend:true, tier:'good', theme:'military', sort_order:7,
    tagline_ko:'미 7함대 모항 + 조선·자동차 항구도시',
    commonalities_ko:'요코스카는 미 해군 7함대 사령부가 있는 서태평양 최대 미 해군기지이자, 조선·자동차 제조를 주력으로 하는 도쿄만 입구의 항구도시입니다. 「미군기지 + 항만 + 제조」 세 요소를 동시에 가진 점이 캠프 험프리스·평택항·제조업을 지닌 평택과 정확히 겹칩니다.',
    complements_ko:'미군기지와 항만·제조업이 공존하는 도시경영, 기지 개방 이벤트를 통한 지역 브랜딩 경험을 공유할 수 있습니다. 한·일 지방 우호와 안보 커뮤니티 교류라는 이중 채널을 여는 이점이 있습니다.', why_not_ko:'' },
  { name_en:'Haiphong', name_ko:'하이퐁', country_en:'Vietnam', country_ko:'베트남', flag:'🇻🇳', lat:20.8449, lng:106.6881, recommend:true, tier:'good', theme:'port_trade', sort_order:8,
    tagline_ko:'빈패스트를 품은 베트남 북부 항만·제조 성장도시',
    commonalities_ko:'하이퐁은 베트남 북부 최대 항만도시이자, 깟하이섬에 연산 30만 대 규모 빈패스트(VinFast) 전기차 공장이 들어서며 전통 항구에서 첨단 제조도시로 도약 중입니다. 항만·자동차·급성장이라는 키워드가 평택과 겹치고, 두 도시 모두 국가 신성장 축으로 육성되는 계획적 성장도시입니다.',
    complements_ko:'동남아 생산·물류 거점으로서 평택 기업의 진출 교두보가 되고, 평택은 반도체·자동차 선진 산업의 멘토 역할로 상호보완합니다. 다만 평택이 이미 베트남 우호도시(땀끼) 1곳을 두고 있어 중복 여부를 사전 확인한 뒤 추진해야 합니다.', why_not_ko:'' },
  { name_en:'Kitakyushu', name_ko:'기타큐슈', country_en:'Japan', country_ko:'일본', flag:'🇯🇵', lat:33.8835, lng:130.8752, recommend:true, tier:'consider', theme:'port_trade', sort_order:9,
    tagline_ko:'철강 항만도시에서 「환경모델도시」로 전환',
    commonalities_ko:'기타큐슈는 규슈 최대 항만이자 철강·기계·화학 제조 도시로, 공업항과 제조업 기반이 평택과 닮았습니다. 아시아로 열린 물류 관문이라는 점도 대(對)중국 교역항 평택과 공통됩니다.',
    complements_ko:'「환경모델도시」로 리브랜딩하며 에코타운(재활용 29개사)·해상풍력 등 산업도시의 친환경 전환을 선도해, 대규모 제조단지를 안은 평택의 탄소중립·정주환경 전략에 참고가 됩니다. 다만 반도체·기지 같은 평택 핵심 정체성과의 접점은 상대적으로 약해 우선순위는 중간입니다.', why_not_ko:'' },
  { name_en:'Chandler', name_ko:'챈들러', country_en:'United States', country_ko:'미국', flag:'🇺🇸', lat:33.3062, lng:-111.8413, recommend:false, tier:'not_recommended', theme:'semiconductor', sort_order:10,
    tagline_ko:'인텔·TSMC 애리조나 — 강력하지만 힐즈버러와 중복',
    commonalities_ko:'챈들러(피닉스 권역)는 인텔 오코틸로 캠퍼스(팹52, 18A 양산)와 인근 TSMC 애리조나 팹이 있는 미국 반도체 대량생산 거점으로, 반도체 정체성 자체는 평택과 잘 맞습니다.',
    complements_ko:'고용량 양산 팹 운영과 사막 환경의 용수·전력 관리 노하우를 갖고 있으나, 이는 이미 추천한 힐즈버러(인텔 R&D)와 상당 부분 겹칩니다.',
    why_not_ko:'같은 미국·인텔 축의 반도체 도시로 힐즈버러와 주제가 중복되어 포트폴리오 다양성을 해칩니다. 또한 애리조나는 세계 각국의 구애가 몰리는 과열 지역이라 한 도시가 얻는 상징성이 희석됩니다. 미국 반도체 축은 상징성 높은 힐즈버러 한 곳으로 대표하는 편이 낫습니다.' },
  { name_en:'Wolfsburg', name_ko:'볼프스부르크', country_en:'Germany', country_ko:'독일', flag:'🇩🇪', lat:52.4227, lng:10.7865, recommend:false, tier:'not_recommended', theme:'automotive', sort_order:11,
    tagline_ko:'폭스바겐 기업도시 — 매력적이나 단일기업·내륙',
    commonalities_ko:'볼프스부르크는 1938년 폭스바겐이 노동자 주거를 위해 계획적으로 세운 「기업 도시」로, 세계 최대급 완성차 공장(약 6만 명 고용)을 품어 자동차 제조·계획도시라는 접점이 평택과 있습니다.',
    complements_ko:'완성차 대량생산과 기업-도시 일체형 개발 경험을 갖췄지만, 항만이 없는 내륙 도시라 평택항의 자동차 수출 축과는 맞물리지 않습니다.',
    why_not_ko:'폭스바겐 단일기업에 도시 경제가 과도하게 종속돼 다변화된 평택과 성격이 다르고, 항만이 없어 자동차 「수출항」 협력이라는 핵심 시너지가 나오지 않습니다. 자동차 축은 수출항 기능이 겹치는 브레머하펜이 훨씬 적합합니다.' },
  { name_en:'Yokohama', name_ko:'요코하마', country_en:'Japan', country_ko:'일본', flag:'🇯🇵', lat:35.4437, lng:139.6380, recommend:false, tier:'not_recommended', theme:'port_trade', sort_order:12,
    tagline_ko:'거대 항만도시지만 규모 불균형·식상한 선택',
    commonalities_ko:'요코하마는 일본을 대표하는 대형 국제 무역항이자 제조·물류 중심으로, 항만·교역이라는 표면적 접점은 평택과 있습니다.',
    complements_ko:'선진 항만 운영과 워터프런트 재개발 경험은 참고할 만하나, 인구 370만의 광역 대도시로 60만 평택과는 체급 차이가 큽니다.',
    why_not_ko:'규모 차이가 커서 대등한 상호 교류보다 형식적 결연에 그치기 쉽고, 한국 여러 도시가 이미 맺은 「식상한」 선택이라 차별성이 약합니다. 일본 파트너로는 평택의 정체성(미군기지·항만·제조)과 정확히 맞물리는 요코스카가 더 전략적입니다.' },
];

// 테이블 생성 + 비어있으면 시드 (idempotent)
let ready = false;
async function initDB() {
  if (ready) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cafe_candidate_cities (
      id            BIGSERIAL PRIMARY KEY,
      name_en       TEXT NOT NULL,
      name_ko       TEXT NOT NULL,
      country_en    TEXT NOT NULL,
      country_ko    TEXT NOT NULL,
      flag          TEXT DEFAULT '',
      lat           DOUBLE PRECISION NOT NULL,
      lng           DOUBLE PRECISION NOT NULL,
      recommend     BOOLEAN NOT NULL DEFAULT true,
      tier          TEXT NOT NULL DEFAULT 'good',
      theme         TEXT NOT NULL DEFAULT 'port_trade',
      tagline_ko    TEXT DEFAULT '',
      commonalities_ko TEXT DEFAULT '',
      complements_ko   TEXT DEFAULT '',
      why_not_ko       TEXT DEFAULT '',
      sort_order    INT DEFAULT 100,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (name_en, country_en)
    );
  `);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM cafe_candidate_cities');
  if (rows[0].n === 0) {
    for (const c of SEED_CITIES) {
      await pool.query(
        `INSERT INTO cafe_candidate_cities
           (name_en,name_ko,country_en,country_ko,flag,lat,lng,recommend,tier,theme,tagline_ko,commonalities_ko,complements_ko,why_not_ko,sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (name_en,country_en) DO NOTHING`,
        [c.name_en,c.name_ko,c.country_en,c.country_ko,c.flag,c.lat,c.lng,c.recommend,c.tier,c.theme,c.tagline_ko,c.commonalities_ko,c.complements_ko,c.why_not_ko,c.sort_order]
      );
    }
    console.log(`[db] seeded ${SEED_CITIES.length} cities`);
  }
  ready = true;
  console.log('[db] cafe_candidate_cities ready');
}

app.use(express.json());
app.use('/api', async (_req, res, next) => {
  try { await initDB(); next(); }
  catch (err) { console.error('[db] init failed:', err.message); res.status(500).json({ success:false, message:'DB 초기화 실패' }); }
});

app.get('/api/cities', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM cafe_candidate_cities
        ORDER BY sort_order ASC,
          (CASE tier WHEN 'strong' THEN 0 WHEN 'good' THEN 1 WHEN 'consider' THEN 2 ELSE 3 END), id ASC`
    );
    res.json({ success:true, data:rows });
  } catch (err) {
    console.error('[cities] error:', err.message);
    res.status(500).json({ success:false, message:'도시 데이터를 불러오지 못했습니다.' });
  }
});

app.use(express.static(path.join(__dirname)));
app.get(/^\/(?!api(?:\/|$)).*/, (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

if (require.main === module) {
  initDB()
    .then(() => app.listen(PORT, () => console.log(`my_cafe → http://localhost:${PORT}`)))
    .catch((err) => { console.error('DB 초기화 실패:', err.message); process.exit(1); });
}
module.exports = app;
