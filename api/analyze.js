// /api/analyze.js
//
// 통합 부동산 안전 분석 API (방어적 버전)

async function callInternal(req, path) {
  try {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host  = req.headers['x-forwarded-host']  || req.headers.host;
    if (!host) return null;
    const url = `${proto}://${host}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    return await res.json();
  } catch (e) {
    console.error('내부 호출 실패:', path, e.message);
    return null;
  }
}

function calculateScore(factors) {
  let score = 100;
  const flags = [];
  const data  = [];
  const auto  = {};

  // ① 전세가율
  if (factors.contract === '전세' && factors.jeonseRatio !== null && factors.jeonseRatio > 0) {
    if (factors.jeonseRatio > 90) {
      score -= 30;
      flags.push({
        title: `전세가율 위험 수준 (${factors.jeonseRatio}%)`,
        description: '전세가율이 90%를 초과합니다. 깡통전세 위험이 매우 높으며, HUG 보증보험 가입도 어려울 수 있습니다.',
        severity: 'danger',
      });
    } else if (factors.jeonseRatio > 80) {
      score -= 15;
      flags.push({
        title: `전세가율 주의 수준 (${factors.jeonseRatio}%)`,
        description: '전세가율이 80%를 초과합니다. 시세 하락 시 보증금 회수가 어려울 수 있습니다.',
        severity: 'caution',
      });
    } else {
      auto['전세가율 확인 (80% 이하 권장)'] = true;
    }
    data.push({
      category: '전세가율',
      result: `${factors.jeonseRatio}% (보증금 ${factors.deposit.toLocaleString()}만원 / 시세 중앙값 ${factors.medianPrice.toLocaleString()}만원)`,
      riskLevel: factors.jeonseRatio > 90 ? 'danger' : factors.jeonseRatio > 80 ? 'caution' : 'safe',
    });
  }

  // ② 시세 데이터 충분성
  if (factors.tradeCount === 0) {
    flags.push({
      title: '최근 실거래 데이터 부족',
      description: '최근 3개월간 해당 지역의 매매 실거래가 없어 시세 비교가 제한됩니다.',
      severity: 'caution',
    });
    score -= 5;
  }

  // ③ 위반건축물
  if (factors.isViolation === true) {
    score -= 20;
    flags.push({
      title: '위반건축물 등재',
      description: '건축물대장에 위반건축물로 등재되어 있습니다. 양성화 부담 + HUG 보증보험 가입 거절될 수 있습니다.',
      severity: 'danger',
    });
    data.push({
      category: '위반건축물',
      result: '등재됨 — 양성화 필요',
      riskLevel: 'danger',
    });
  } else if (factors.isViolation === false) {
    auto['건축물대장 — 위반건축물·용도변경 여부 확인'] = true;
    data.push({
      category: '위반건축물',
      result: '미등재',
      riskLevel: 'safe',
    });
  }

  // ④ 노후 건물
  if (factors.buildYear) {
    const yearsOld = new Date().getFullYear() - parseInt(factors.buildYear);
    if (yearsOld > 30) {
      score -= 5;
      flags.push({
        title: `노후 건물 (${yearsOld}년차)`,
        description: '준공 30년 이상 — 시설 노후 + 분쟁 가능성 검토 필요.',
        severity: 'caution',
      });
    }
    data.push({
      category: '준공연도',
      result: `${factors.buildYear}년 (${yearsOld}년차)`,
      riskLevel: yearsOld > 30 ? 'caution' : 'safe',
    });
  }

  // ⑤ 면적
  if (factors.totalArea > 0) {
    data.push({
      category: '연면적',
      result: `${factors.totalArea.toLocaleString()}㎡`,
      riskLevel: 'safe',
    });
  }

  // ⑥ 시세 통계
  if (factors.tradeStats && factors.tradeStats.median) {
    data.push({
      category: '최근 매매 시세',
      result: `중앙값 ${(factors.tradeStats.median / 10000).toFixed(2)}억원 (${factors.tradeStats.count}건)`,
      riskLevel: 'safe',
    });
  }
  if (factors.rentStats && factors.rentStats.jeonse && factors.rentStats.jeonse.median) {
    data.push({
      category: '최근 전세 시세',
      result: `중앙값 ${(factors.rentStats.jeonse.median / 10000).toFixed(2)}억원 (${factors.rentStats.jeonse.count}건)`,
      riskLevel: 'safe',
    });
  }

  if (score < 0) score = 0;
  if (score > 100) score = 100;

  let riskLevel;
  if (score >= 80) riskLevel = 'safe';
  else if (score >= 60) riskLevel = 'warning';
  else riskLevel = 'danger';

  return { score, riskLevel, redFlags: flags, forensicData: data, autoChecked: auto };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const q = (req.query && typeof req.query === 'object') ? req.query : {};
    const contract = (q.contract || '전세').toString();
    const deposit  = parseInt(q.deposit) || 0;
    const aptName  = (q.apt || q.complexName || '').toString();
    const lawdCd   = (q.lawdCd || '').toString();
    const address  = (q.address || '').toString();
    const bdMgtSn  = (q.bdMgtSn || '').toString();

    // ── 1. 시세 ──
    const priceQs = new URLSearchParams();
    if (lawdCd)  priceQs.set('lawdCd', lawdCd);
    if (address) priceQs.set('address', address);
    priceQs.set('contract', contract);
    if (deposit) priceQs.set('deposit', deposit);
    if (aptName) priceQs.set('apt', aptName);
    priceQs.set('type', 'both');

    const priceData = await callInternal(req, '/api/price?' + priceQs.toString());

    // ── 2. 건축물대장 ──
    let buildingData = null;
    if (bdMgtSn) {
      const bldgQs = new URLSearchParams({ bdMgtSn });
      if (aptName) bldgQs.set('aptName', aptName);
      if (address) bldgQs.set('address', address);
      buildingData = await callInternal(req, '/api/building?' + bldgQs.toString());
    } else {
      buildingData = await callInternal(req, '/api/building?bdMgtSn=00000000000000000000');
    }

    // ── 3. 점수 ──
    const factors = {
      contract,
      deposit,
      jeonseRatio:    (priceData && priceData.analysis) ? priceData.analysis.jeonseRatio : null,
      medianPrice:    (priceData && priceData.trade && priceData.trade.stats) ? priceData.trade.stats.median : 0,
      tradeCount:     (priceData && priceData.trade && priceData.trade.stats) ? priceData.trade.stats.count : 0,
      tradeStats:     (priceData && priceData.trade) ? priceData.trade.stats : null,
      rentStats:      (priceData && priceData.rent)  ? priceData.rent.stats : null,
      isViolation:    (buildingData && buildingData.building) ? buildingData.building.isViolation : null,
      buildYear:      (buildingData && buildingData.building) ? buildingData.building.buildYear : null,
      totalArea:      (buildingData && buildingData.building) ? buildingData.building.totalArea : 0,
    };

    const calc = calculateScore(factors);

    const sources = {
      price:    (priceData && priceData.source) || 'unavailable',
      building: (buildingData && buildingData.source) || 'unavailable',
    };
    const hasMock = Object.values(sources).some(s => s.includes('mock'));

    return res.status(200).json({
      ok: true,
      score:        calc.score,
      riskLevel:    calc.riskLevel,
      redFlags:     calc.redFlags,
      forensicData: calc.forensicData,
      autoChecked:  calc.autoChecked,
      summary: {
        contract,
        address: address || (priceData && priceData.query ? `법정동코드 ${priceData.query.lawdCd}` : ''),
        complexName: aptName,
        deposit,
      },
      sources,
      hasMock,
      raw: {
        price:    priceData,
        building: buildingData,
      },
      analyzedAt: new Date().toISOString(),
    });

  } catch (e) {
    console.error('analyze.js 최상위 에러:', e);
    return res.status(200).json({
      ok: false,
      error: (e && e.message) || '분석 실패',
      stack: (e && e.stack) ? e.stack.split('\n').slice(0, 3).join(' | ') : null,
      score: 75,
      riskLevel: 'warning',
      redFlags: [{
        title: '분석 시스템 오류',
        description: (e && e.message) || '데이터를 불러오지 못했습니다',
        severity: 'caution',
      }],
      forensicData: [],
      autoChecked: {},
      analyzedAt: new Date().toISOString(),
    });
  }
}
