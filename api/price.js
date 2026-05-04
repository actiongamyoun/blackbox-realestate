// /api/price.js
//
// 부동산 실거래가 + 시세 조회 API (방어적 버전)
//
// Vercel 환경변수:
//   DATA_GO_KR_KEY_APT_TRADE  ← 아파트 매매 키 (Encoding 또는 Decoding 형태 모두 허용)
//   DATA_GO_KR_KEY_APT_RENT   ← 아파트 전월세 키

// 매매 API endpoint 후보 (자동 시도)
const APT_TRADE_URLS = [
  'https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev',
  'https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade',
];
const APT_RENT_URLS = [
  'https://apis.data.go.kr/1613000/RTMSDataSvcAptRent/getRTMSDataSvcAptRent',
];

// ── 안전한 XML 파서 ─────────────────────────
function parseXml(xmlText) {
  const result = { items: [], resultCode: '', resultMsg: '', totalCount: 0 };
  if (!xmlText || typeof xmlText !== 'string') return result;
  try {
    const codeMatch = xmlText.match(/<resultCode>(\d+)<\/resultCode>/);
    if (codeMatch) result.resultCode = codeMatch[1];
    const msgMatch = xmlText.match(/<resultMsg>([^<]*)<\/resultMsg>/);
    if (msgMatch) result.resultMsg = msgMatch[1];
    const countMatch = xmlText.match(/<totalCount>(\d+)<\/totalCount>/);
    if (countMatch) result.totalCount = parseInt(countMatch[1]) || 0;

    const itemMatches = xmlText.match(/<item>[\s\S]*?<\/item>/g) || [];
    for (const itemXml of itemMatches) {
      try {
        const item = {};
        const fieldRegex = /<(\w+)>([^<]*)<\/\w+>/g;
        let m;
        while ((m = fieldRegex.exec(itemXml)) !== null) {
          item[m[1]] = (m[2] || '').trim();
        }
        result.items.push(item);
      } catch (e) {
        // 개별 파싱 실패 무시
      }
    }
  } catch (e) {
    console.error('XML 파싱 오류:', e.message);
  }
  return result;
}

// ── 키 정규화: 인코딩/디코딩 형태 자동 처리 ──
function normalizeKey(key) {
  if (!key) return null;
  // %가 있으면 이미 인코딩됨
  if (key.includes('%')) return key;
  // 없으면 디코딩 형태 → 인코딩 처리
  return encodeURIComponent(key);
}

// ── 호출 헬퍼 (URL 여러 개 자동 시도) ──────────
async function fetchPriceData(endpoints, key, lawdCd, dealYmd, options) {
  options = options || {};
  const normalizedKey = normalizeKey(key);
  if (!normalizedKey) throw new Error('API 키가 비어있습니다');

  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      const url = endpoint
        + '?serviceKey=' + normalizedKey
        + '&LAWD_CD=' + encodeURIComponent(lawdCd)
        + '&DEAL_YMD=' + encodeURIComponent(dealYmd)
        + '&pageNo=1'
        + '&numOfRows=' + (options.numOfRows || 100);

      const controller = new AbortController();
      const timeoutId  = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(url, {
        headers: { 'Accept': 'application/xml' },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const text = await res.text();

      if (text.includes('SERVICE_KEY_IS_NOT_REGISTERED')
       || text.includes('SERVICE KEY IS NOT REGISTERED')) {
        throw new Error('SERVICE_KEY_NOT_REGISTERED — 키 미등록 또는 승인 대기 중');
      }
      if (text.includes('NO_OPENAPI_SERVICE_ERROR')) {
        lastError = new Error('NO_OPENAPI_SERVICE — endpoint 미지원');
        continue;   // 다음 endpoint
      }
      if (text.includes('LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR')) {
        throw new Error('일일 호출 한도 초과');
      }

      const parsed = parseXml(text);
      if (parsed.resultCode === '00' || parsed.items.length > 0) {
        return parsed;
      }
      if (parsed.resultCode && parsed.resultCode !== '00') {
        lastError = new Error(`API 응답 오류: ${parsed.resultMsg || parsed.resultCode}`);
        continue;
      }
      // resultCode 없는 경우 — 빈 응답일 수도, 다른 문제일 수도
      if (!parsed.resultCode && parsed.items.length === 0) {
        // 응답 첫 200자를 에러로 (디버깅용)
        lastError = new Error('알 수 없는 응답 형식: ' + text.substring(0, 200));
        continue;
      }
      return parsed;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('모든 endpoint 호출 실패');
}

// ── 주소 → lawdCd 추정 ────────────────────────
function guessLawdCdFromAddress(address) {
  if (!address) return null;
  const map = {
    '강남구': '11680', '서초구': '11650', '송파구': '11710', '강동구': '11740',
    '마포구': '11440', '용산구': '11170', '성동구': '11200', '광진구': '11215',
    '해운대구': '26350', '수영구': '26260', '동래구': '26260',
    '부산진구': '26230', '영도구': '26170',
    '강서구': '26440', '연제구': '26470',
    '사상구': '26530', '사하구': '26380', '금정구': '26410', '기장군': '26710',
  };
  for (const [gu, code] of Object.entries(map)) {
    if (address.includes(gu)) return code;
  }
  return null;
}

// ── Mock 데이터 ────────────────────────────────
function mockData(type) {
  const baseDate = new Date();
  const base = {
    aptNm: '샘플아파트 (mock)',
    dealYear: String(baseDate.getFullYear()),
    dealMonth: String(baseDate.getMonth() + 1).padStart(2, '0'),
    dealDay: String(baseDate.getDate()).padStart(2, '0'),
    excluUseAr: '84.99',
    floor: String(Math.floor(Math.random() * 20) + 3),
    buildYear: String(2000 + Math.floor(Math.random() * 25)),
  };
  if (type === 'trade') {
    return [
      { ...base, dealAmount: '110,000' },
      { ...base, dealAmount: '125,000', floor: '12' },
    ];
  }
  if (type === 'rent') {
    return [
      { ...base, deposit: '85,000', monthlyRent: '0' },
      { ...base, deposit: '5,000',  monthlyRent: '300' },
    ];
  }
  return [];
}

// ── 통계 ──────────────────────────────────────
function summarizeTrades(items) {
  if (!items || !items.length) return null;
  try {
    const prices = items
      .map(i => {
        const raw = (i.dealAmount || i.dealAmt || '').toString().replace(/,/g, '').trim();
        return parseInt(raw);
      })
      .filter(n => !isNaN(n) && n > 0);
    if (!prices.length) return null;
    prices.sort((a, b) => a - b);
    const avg = Math.round(prices.reduce((s, n) => s + n, 0) / prices.length);
    return {
      count: prices.length,
      avg,
      median: prices[Math.floor(prices.length / 2)],
      min: prices[0],
      max: prices[prices.length - 1],
      range: [prices[0], prices[prices.length - 1]],
    };
  } catch (e) {
    return null;
  }
}

function summarizeRents(items) {
  if (!items || !items.length) return { jeonse: null, monthly: null };
  try {
    const result = { jeonse: null, monthly: null };
    const jeonse = [];
    const monthlyDeposits = [];
    const monthlyRents = [];

    for (const i of items) {
      const dep = parseInt((i.deposit || '').toString().replace(/,/g, '').trim());
      const m   = parseInt((i.monthlyRent || '0').toString().replace(/,/g, '').trim()) || 0;
      if (isNaN(dep) || dep <= 0) continue;
      if (m === 0) {
        jeonse.push(dep);
      } else {
        monthlyDeposits.push(dep);
        monthlyRents.push(m);
      }
    }

    if (jeonse.length) {
      jeonse.sort((a, b) => a - b);
      result.jeonse = {
        count: jeonse.length,
        avg: Math.round(jeonse.reduce((s, n) => s + n, 0) / jeonse.length),
        median: jeonse[Math.floor(jeonse.length / 2)],
        range: [jeonse[0], jeonse[jeonse.length - 1]],
      };
    }
    if (monthlyDeposits.length) {
      monthlyDeposits.sort((a, b) => a - b);
      monthlyRents.sort((a, b) => a - b);
      result.monthly = {
        count: monthlyDeposits.length,
        avgDeposit: Math.round(monthlyDeposits.reduce((s, n) => s + n, 0) / monthlyDeposits.length),
        avgRent: Math.round(monthlyRents.reduce((s, n) => s + n, 0) / monthlyRents.length),
        depositRange: [monthlyDeposits[0], monthlyDeposits[monthlyDeposits.length - 1]],
        rentRange: [monthlyRents[0], monthlyRents[monthlyRents.length - 1]],
      };
    }
    return result;
  } catch (e) {
    return { jeonse: null, monthly: null };
  }
}

// ── 메인 핸들러 ────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // 절대 크래시 안 나도록 모든 처리 try-catch
  try {
    const q = (req.query && typeof req.query === 'object') ? req.query : {};
    let lawdCd = (q.lawdCd || '').toString().trim();
    const type = (q.type || 'both').toString().trim();
    const aptName = (q.apt || q.complexName || '').toString().trim();
    const userDeposit = parseInt(q.deposit) || 0;

    if (!lawdCd && q.address) {
      lawdCd = guessLawdCdFromAddress(q.address.toString()) || '';
    }
    if (!lawdCd) {
      return res.status(200).json({
        ok: false,
        error: 'lawdCd 또는 인식 가능한 address가 필요합니다',
        source: 'error',
        fetchedAt: new Date().toISOString(),
      });
    }

    // 최근 3개월 (지정 없으면)
    let dealYmds = [];
    if (q.dealYmd) {
      dealYmds = [q.dealYmd.toString()];
    } else {
      const now = new Date();
      for (let i = 0; i < 3; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        dealYmds.push(d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0'));
      }
    }

    const tradeKey = process.env.DATA_GO_KR_KEY_APT_TRADE;
    const rentKey  = process.env.DATA_GO_KR_KEY_APT_RENT;

    let trades = [];
    let rents  = [];
    let usedSource = 'mock';
    const warnings = [];

    // ── 매매 ──
    if (type === 'trade' || type === 'both') {
      if (tradeKey) {
        for (const ymd of dealYmds) {
          try {
            const result = await fetchPriceData(APT_TRADE_URLS, tradeKey, lawdCd, ymd);
            trades = trades.concat(result.items || []);
            if (trades.length >= 200) break;
          } catch (e) {
            warnings.push(`매매 ${ymd} 호출 실패: ${e.message}`);
          }
        }
        if (trades.length > 0) {
          usedSource = 'publicData';
        } else {
          trades = mockData('trade');
          usedSource = 'mock-fallback';
          warnings.push('매매 실거래 없음 → mock 사용');
        }
      } else {
        trades = mockData('trade');
        warnings.push('DATA_GO_KR_KEY_APT_TRADE 환경변수 미설정');
      }
    }

    // ── 전월세 ──
    if (type === 'rent' || type === 'both') {
      if (rentKey) {
        for (const ymd of dealYmds) {
          try {
            const result = await fetchPriceData(APT_RENT_URLS, rentKey, lawdCd, ymd);
            rents = rents.concat(result.items || []);
            if (rents.length >= 200) break;
          } catch (e) {
            warnings.push(`전월세 ${ymd} 호출 실패: ${e.message}`);
          }
        }
        if (rents.length > 0) {
          if (usedSource === 'mock') usedSource = 'publicData';
        } else {
          rents = mockData('rent');
          if (usedSource !== 'publicData') usedSource = 'mock-fallback';
          warnings.push('전월세 실거래 없음 → mock 사용');
        }
      } else {
        rents = mockData('rent');
        warnings.push('DATA_GO_KR_KEY_APT_RENT 환경변수 미설정');
      }
    }

    // 아파트명 필터 (실데이터에만)
    if (aptName && usedSource === 'publicData') {
      const norm = (s) => (s || '').toString().replace(/\s+/g, '').toLowerCase();
      trades = trades.filter(t => norm(t.aptNm || t.apartment).includes(norm(aptName)));
      rents  = rents.filter (r => norm(r.aptNm || r.apartment).includes(norm(aptName)));
    }

    const tradeStats = summarizeTrades(trades);
    const rentStats  = summarizeRents(rents);

    let jeonseRatio = null;
    if (userDeposit > 0 && tradeStats && tradeStats.median) {
      jeonseRatio = Math.round(userDeposit / tradeStats.median * 1000) / 10;
    }

    return res.status(200).json({
      ok: true,
      source: usedSource,
      query: { lawdCd, type, aptName, dealYmds, userDeposit },
      trade: { items: trades.slice(0, 50), stats: tradeStats },
      rent:  { items: rents.slice(0, 50),  stats: rentStats },
      analysis: {
        jeonseRatio,
        jeonseRatioWarn: jeonseRatio !== null ? jeonseRatio > 80 : null,
      },
      warnings,
      fetchedAt: new Date().toISOString(),
    });

  } catch (e) {
    // 마지막 방어선 — 어떤 에러든 200 OK로 응답 (Vercel 500 방지)
    console.error('price.js 최상위 에러:', e);
    return res.status(200).json({
      ok: false,
      error: (e && e.message) || '알 수 없는 서버 오류',
      stack: (e && e.stack) ? e.stack.split('\n').slice(0, 3).join(' | ') : null,
      source: 'error',
      fetchedAt: new Date().toISOString(),
    });
  }
}
