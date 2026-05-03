// /api/price.js
//
// 부동산 실거래가 + 시세 조회 API
//
// 사용처: 분석 리포트의 매매가 / 전세가 / 전세가율 산출
// 데이터 출처: 국토교통부 실거래가 (공공데이터 포털)
//
// Vercel 환경변수:
//   DATA_GO_KR_KEY_APT_TRADE  ← 아파트 매매 실거래가 키 (Encoding 키)
//   DATA_GO_KR_KEY_APT_RENT   ← 아파트 전월세 실거래가 키
//
// 두 키가 없으면 자동으로 mock 응답을 반환합니다.
//
// 호출 방법:
//   GET /api/price?lawdCd=11680&dealYmd=202611&type=trade
//   GET /api/price?lawdCd=11680&dealYmd=202611&type=rent
//   GET /api/price?lawdCd=11680&dealYmd=202611&type=both     ← 매매+전세 동시
//
// 또는 주소+계약유형 기반:
//   GET /api/price?address=서울특별시강남구역삼동&contract=전세&deposit=32000
//
// 파라미터:
//   lawdCd:    법정동코드 5자리 (예: 11680 = 서울 강남구)
//   dealYmd:   조회연월 6자리 (예: 202611, 미지정 시 최근 3개월)
//   type:      trade(매매) | rent(전월세) | both(둘다)
//   apt:       아파트명 필터 (선택)
//   address:   대안 진입점 — 주소 문자열 (lawdCd 자동 추출)
//   contract:  전세/월세/매매 (응답 가공용)
//   deposit:   사용자 보증금 (만원, 전세가율 계산용)

// ── 매매 API endpoint ─────────────────────────────
const APT_TRADE_URL = 'https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev';

// ── 전월세 API endpoint ───────────────────────────
const APT_RENT_URL  = 'https://apis.data.go.kr/1613000/RTMSDataSvcAptRent/getRTMSDataSvcAptRent';

// ── XML → JS 객체 (Vercel은 fetch 응답이 텍스트)
function parseXml(xmlText) {
  // 간단한 XML 파서 (의존성 없이) — items > item 추출
  const items = [];
  const itemMatches = xmlText.match(/<item>[\s\S]*?<\/item>/g) || [];
  itemMatches.forEach(itemXml => {
    const item = {};
    const fieldMatches = itemXml.matchAll(/<(\w+)>([^<]*)<\/\w+>/g);
    for (const m of fieldMatches) {
      item[m[1]] = m[2].trim();
    }
    items.push(item);
  });

  // 결과 코드/메시지
  const resultCode = (xmlText.match(/<resultCode>(\d+)<\/resultCode>/) || [])[1];
  const resultMsg  = (xmlText.match(/<resultMsg>([^<]*)<\/resultMsg>/) || [])[1];
  const totalCount = parseInt((xmlText.match(/<totalCount>(\d+)<\/totalCount>/) || [])[1] || '0');

  return { items, resultCode, resultMsg, totalCount };
}

// ── 호출 헬퍼 (매매 또는 전월세) ────────────────────
async function fetchPriceData(endpoint, key, lawdCd, dealYmd, options) {
  options = options || {};
  const params = new URLSearchParams({
    serviceKey: key,                  // URLSearchParams가 자동 인코딩하므로 raw key 사용
    LAWD_CD:    lawdCd,
    DEAL_YMD:   dealYmd,
    pageNo:     '1',
    numOfRows:  String(options.numOfRows || 100),
  });
  // serviceKey는 이미 인코딩된 키로 들어왔다면 다시 인코딩하지 않도록 처리
  // 공공데이터 포털 키는 보통 URL 인코딩된 형태로 제공됨 — 그대로 사용
  const url = endpoint + '?' + params.toString().replace(
    /serviceKey=([^&]+)/,
    'serviceKey=' + encodeURIComponent(decodeURIComponent(key))
  );

  const res  = await fetch(url, { headers: { 'Accept': 'application/xml' } });
  const text = await res.text();

  // 에러 응답 (JSON으로 오는 경우 있음)
  if (text.startsWith('{') || text.includes('OpenAPI_ServiceResponse')) {
    const errMatch = text.match(/<returnReasonCode>(\d+)<\/returnReasonCode>/);
    const errMsg   = text.match(/<returnAuthMsg>([^<]+)<\/returnAuthMsg>/);
    throw new Error(`API 오류: ${errMsg ? errMsg[1] : (errMatch ? errMatch[1] : '알 수 없음')}`);
  }

  return parseXml(text);
}

// ── 주소 → lawdCd 추정 (간단 매핑, 차후 행정구역코드 DB로 정밀화) ──
function guessLawdCdFromAddress(address) {
  if (!address) return null;
  // 부산 해운대구 = 26350, 강남구 = 11680, ...
  // 정식으로는 행정안전부의 법정동 코드 데이터 필요 (~3MB JSON)
  const map = {
    '강남구': '11680', '서초구': '11650', '송파구': '11710', '강동구': '11740',
    '마포구': '11440', '용산구': '11170', '성동구': '11200', '광진구': '11215',
    '해운대구': '26350', '수영구': '26260', '남구': '26290', '동래구': '26260',
    '부산진구': '26230', '중구': '26110', '서구': '26140', '영도구': '26170',
    '동구': '26170', '북구': '26320', '강서구': '26440', '연제구': '26470',
    '사상구': '26530', '사하구': '26380', '금정구': '26410', '기장군': '26710',
  };
  for (const [gu, code] of Object.entries(map)) {
    if (address.includes(gu)) return code;
  }
  return null;
}

// ── Mock 데이터 (키 없을 때 또는 실패 시) ──────────
function mockData(type, query) {
  const baseDate = new Date();
  const base = {
    apt:        query.apt || '샘플아파트',
    dealYear:   String(baseDate.getFullYear()),
    dealMonth:  String(baseDate.getMonth() + 1).padStart(2, '0'),
    dealDay:    String(baseDate.getDate()).padStart(2, '0'),
    excluUseAr: '84.99',
    floor:      String(Math.floor(Math.random() * 20) + 3),
    buildYear:  String(2000 + Math.floor(Math.random() * 25)),
  };

  if (type === 'trade') {
    return [{
      ...base, dealAmount: '110,000',  // 11억
    }, {
      ...base, dealAmount: '125,000', floor: '12',
    }];
  }
  if (type === 'rent') {
    return [{
      ...base, deposit: '85,000', monthlyRent: '0',  // 전세 8.5억
    }, {
      ...base, deposit: '5,000', monthlyRent: '300',  // 보증금 5천 / 월 300
    }];
  }
  return [];
}

// ── 통계 산출 ──────────────────────────────────
function summarizeTrades(items) {
  if (!items.length) return null;
  const prices = items
    .map(i => parseInt((i.dealAmount || i.dealAmt || '0').replace(/,/g, '').trim()))
    .filter(n => n > 0);
  if (!prices.length) return null;
  prices.sort((a, b) => a - b);
  const avg = Math.round(prices.reduce((s, n) => s + n, 0) / prices.length);
  const median = prices[Math.floor(prices.length / 2)];
  return {
    count:  prices.length,
    avg,                                         // 만원 단위
    median,
    min:    prices[0],
    max:    prices[prices.length - 1],
    range:  [prices[0], prices[prices.length - 1]],
  };
}

function summarizeRents(items) {
  if (!items.length) return null;
  const jeonse = items.filter(i => {
    const monthly = parseInt((i.monthlyRent || '0').replace(/,/g, '').trim());
    return monthly === 0;
  });
  const monthly = items.filter(i => {
    const m = parseInt((i.monthlyRent || '0').replace(/,/g, '').trim());
    return m > 0;
  });
  // 전세 (보증금만)
  const jeonsePrices = jeonse
    .map(i => parseInt((i.deposit || '0').replace(/,/g, '').trim()))
    .filter(n => n > 0);
  const monthlyDeposits = monthly
    .map(i => parseInt((i.deposit || '0').replace(/,/g, '').trim()))
    .filter(n => n > 0);
  const monthlyRents = monthly
    .map(i => parseInt((i.monthlyRent || '0').replace(/,/g, '').trim()))
    .filter(n => n > 0);

  const result = {
    jeonse:  null,
    monthly: null,
  };
  if (jeonsePrices.length) {
    jeonsePrices.sort((a, b) => a - b);
    result.jeonse = {
      count: jeonsePrices.length,
      avg:    Math.round(jeonsePrices.reduce((s, n) => s + n, 0) / jeonsePrices.length),
      median: jeonsePrices[Math.floor(jeonsePrices.length / 2)],
      range:  [jeonsePrices[0], jeonsePrices[jeonsePrices.length - 1]],
    };
  }
  if (monthlyDeposits.length) {
    monthlyDeposits.sort((a, b) => a - b);
    monthlyRents.sort((a, b) => a - b);
    result.monthly = {
      count:        monthlyDeposits.length,
      avgDeposit:   Math.round(monthlyDeposits.reduce((s, n) => s + n, 0) / monthlyDeposits.length),
      avgRent:      Math.round(monthlyRents.reduce((s, n) => s + n, 0) / monthlyRents.length),
      depositRange: [monthlyDeposits[0], monthlyDeposits[monthlyDeposits.length - 1]],
      rentRange:    [monthlyRents[0], monthlyRents[monthlyRents.length - 1]],
    };
  }
  return result;
}

// ── 메인 핸들러 ────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const q = req.query || {};
    let lawdCd = q.lawdCd || '';
    // contract와 type 분리: 사용자 의도(contract)와 별개로 데이터(type)를 결정
    // 전세가율 산출엔 매매+전세 둘 다 필요하므로 both 기본값
    const type    = q.type || 'both';
    const aptName = q.apt  || q.complexName || '';
    const userDeposit = parseInt(q.deposit) || 0;

    // 주소만 있으면 lawdCd 추정
    if (!lawdCd && q.address) {
      lawdCd = guessLawdCdFromAddress(q.address);
    }
    if (!lawdCd) {
      return res.status(200).json({
        ok: false,
        error: 'lawdCd 또는 address가 필요합니다 (예: lawdCd=26350, 또는 address=부산 해운대구...)',
        source: 'mock',
        fetchedAt: new Date().toISOString(),
      });
    }

    // 조회연월: 미지정 시 최근 3개월
    let dealYmds = [];
    if (q.dealYmd) {
      dealYmds = [q.dealYmd];
    } else {
      const now = new Date();
      for (let i = 0; i < 3; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        dealYmds.push(d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0'));
      }
    }

    // 키 확인
    const tradeKey = process.env.DATA_GO_KR_KEY_APT_TRADE;
    const rentKey  = process.env.DATA_GO_KR_KEY_APT_RENT;
    const useMock  = !tradeKey && !rentKey;

    let trades = [];
    let rents  = [];
    let usedSource = useMock ? 'mock' : 'publicData';
    let warnings = [];

    // ── 매매 데이터 ──
    if (type === 'trade' || type === 'both') {
      if (tradeKey) {
        try {
          for (const ymd of dealYmds) {
            const result = await fetchPriceData(APT_TRADE_URL, tradeKey, lawdCd, ymd);
            trades = trades.concat(result.items);
            if (trades.length >= 200) break;
          }
        } catch (e) {
          console.error('매매 API 오류:', e.message);
          warnings.push('매매 API 호출 실패: ' + e.message);
          trades = mockData('trade', { apt: aptName });
          usedSource = 'mock-fallback';
        }
      } else {
        trades = mockData('trade', { apt: aptName });
      }
    }

    // ── 전월세 데이터 ──
    if (type === 'rent' || type === 'both') {
      if (rentKey) {
        try {
          for (const ymd of dealYmds) {
            const result = await fetchPriceData(APT_RENT_URL, rentKey, lawdCd, ymd);
            rents = rents.concat(result.items);
            if (rents.length >= 200) break;
          }
        } catch (e) {
          console.error('전월세 API 오류:', e.message);
          warnings.push('전월세 API 호출 실패: ' + e.message);
          rents = mockData('rent', { apt: aptName });
          usedSource = 'mock-fallback';
        }
      } else {
        rents = mockData('rent', { apt: aptName });
      }
    }

    // ── 아파트명 필터 ── (실제 데이터일 때만 필터, mock은 단지명이 placeholder)
    if (aptName && usedSource === 'publicData') {
      const norm = (s) => (s || '').replace(/\s+/g, '').toLowerCase();
      trades = trades.filter(t => norm(t.aptNm || t.apartment).includes(norm(aptName)));
      rents  = rents.filter (r => norm(r.aptNm || r.apartment).includes(norm(aptName)));
    }

    // ── 통계 ──
    const tradeStats = summarizeTrades(trades);
    const rentStats  = summarizeRents(rents);

    // ── 전세가율 (사용자 보증금이 있으면) ──
    let jeonseRatio = null;
    if (userDeposit > 0 && tradeStats?.median) {
      jeonseRatio = Math.round(userDeposit / tradeStats.median * 1000) / 10;  // 소수점 1자리
    }

    return res.status(200).json({
      ok: true,
      source: usedSource,
      query: { lawdCd, type, aptName, dealYmds, userDeposit },
      trade: {
        items: trades.slice(0, 50),    // 최대 50건만 응답
        stats: tradeStats,
      },
      rent: {
        items: rents.slice(0, 50),
        stats: rentStats,
      },
      analysis: {
        jeonseRatio,                    // 전세가율 (%)
        jeonseRatioWarn: jeonseRatio !== null ? jeonseRatio > 80 : null,
      },
      warnings,
      fetchedAt: new Date().toISOString(),
    });

  } catch (e) {
    console.error('price.js 처리 오류:', e);
    return res.status(500).json({
      ok: false,
      error: e.message || '서버 오류',
      source: 'error',
      fetchedAt: new Date().toISOString(),
    });
  }
};
