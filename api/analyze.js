// /api/analyze.js
//
// 통합 부동산 안전 분석 API
//
// 역할: price.js + building.js + (등기부 — 추후 추가) 를 종합하여
//       안전 점수 + Red Flags + 정밀 데이터 + 체크리스트를 산출
//
// 호출 방법:
//   GET /api/analyze?address=서울+강남구+역삼동&contract=전세&deposit=32000
//   GET /api/analyze?lawdCd=11680&apt=래미안&contract=전세&deposit=32000
//   GET /api/analyze?bdMgtSn=...&contract=전세&deposit=32000  ← JUSO 결과 활용 시 권장
//
// 응답:
//   {
//     ok, source, score, riskLevel, redFlags[], forensicData[],
//     autoChecked{}, summary, fetchedAt
//   }

// 내부 fetch 헬퍼 — 같은 Vercel 인스턴스 내 함수 호출
async function callInternal(req, path) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host  = req.headers['x-forwarded-host']  || req.headers.host;
  const url   = `${proto}://${host}${path}`;
  try {
    const res  = await fetch(url);
    return await res.json();
  } catch (e) {
    console.error('내부 호출 실패:', path, e.message);
    return null;
  }
}

// 점수 산출 — 100점 만점에서 위험 요소만큼 차감
function calculateScore(factors) {
  let score = 100;
  const flags = [];
  const data  = [];
  const auto  = {};

  // ① 전세가율 (전세 계약 시)
  if (factors.contract === '전세' && factors.jeonseRatio !== null) {
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
    } else if (factors.jeonseRatio > 0) {
      auto['전세가율 확인 (80% 이하 권장)'] = true;
    }
    data.push({
      category: '전세가율',
      result: factors.jeonseRatio > 0 ? `${factors.jeonseRatio}% (보증금 ${factors.deposit}만원 / 시세 ${factors.medianPrice}만원)` : '미산출',
      riskLevel: factors.jeonseRatio > 90 ? 'danger' : factors.jeonseRatio > 80 ? 'caution' : 'safe',
    });
  }

  // ② 시세 데이터 충분성
  if (factors.tradeCount === 0) {
    flags.push({
      title: '최근 실거래 데이터 부족',
      description: '최근 3개월간 해당 단지의 매매 실거래가 없어 시세 비교가 제한됩니다.',
      severity: 'caution',
    });
    score -= 5;
  }

  // ③ 위반건축물
  if (factors.isViolation) {
    score -= 20;
    flags.push({
      title: '위반건축물 등재',
      description: '건축물대장에 위반건축물로 등재되어 있습니다. 매매·전세 시 양성화 부담이 발생할 수 있고, HUG 보증보험 가입도 거절될 수 있습니다.',
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
        description: '준공 30년 이상 경과 — 재건축·리모델링 추진 가능성과 함께, 시설 노후로 인한 분쟁 가능성도 검토하세요.',
        severity: 'caution',
      });
    }
    data.push({
      category: '준공연도',
      result: `${factors.buildYear}년 (${yearsOld}년차)`,
      riskLevel: yearsOld > 30 ? 'caution' : 'safe',
    });
  }

  // ⑤ 면적 정보 (참고)
  if (factors.totalArea > 0) {
    data.push({
      category: '연면적',
      result: `${factors.totalArea.toLocaleString()}㎡`,
      riskLevel: 'safe',
    });
  }

  // ⑥ 시세 통계 (참고)
  if (factors.tradeStats) {
    data.push({
      category: '최근 매매 시세',
      result: `중앙값 ${(factors.tradeStats.median / 10000).toFixed(2)}억원 (${factors.tradeStats.count}건 기준)`,
      riskLevel: 'safe',
    });
  }
  if (factors.rentStats?.jeonse) {
    data.push({
      category: '최근 전세 시세',
      result: `중앙값 ${(factors.rentStats.jeonse.median / 10000).toFixed(2)}억원 (${factors.rentStats.jeonse.count}건 기준)`,
      riskLevel: 'safe',
    });
  }

  // 점수 하한
  if (score < 0) score = 0;
  if (score > 100) score = 100;

  // 위험 등급
  let riskLevel;
  if (score >= 80) riskLevel = 'safe';
  else if (score >= 60) riskLevel = 'warning';
  else riskLevel = 'danger';

  return { score, riskLevel, redFlags: flags, forensicData: data, autoChecked: auto };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const q = req.query || {};
    const contract = q.contract || '전세';
    const deposit  = parseInt(q.deposit) || 0;
    const aptName  = q.apt || q.complexName || '';
    const lawdCd   = q.lawdCd || '';
    const address  = q.address || '';
    const bdMgtSn  = q.bdMgtSn || '';

    // ── 1. 시세 데이터 ──
    const priceQs = new URLSearchParams();
    if (lawdCd) priceQs.set('lawdCd', lawdCd);
    if (address) priceQs.set('address', address);
    priceQs.set('contract', contract);
    if (deposit) priceQs.set('deposit', deposit);
    if (aptName) priceQs.set('apt', aptName);
    priceQs.set('type', contract === '매매' ? 'trade' : 'both');

    const priceData = await callInternal(req, '/api/price?' + priceQs.toString());

    // ── 2. 건축물대장 ──
    let buildingData = null;
    if (bdMgtSn) {
      const bldgQs = new URLSearchParams({ bdMgtSn });
      if (aptName) bldgQs.set('aptName', aptName);
      if (address) bldgQs.set('address', address);
      buildingData = await callInternal(req, '/api/building?' + bldgQs.toString());
    } else {
      // bdMgtSn 없으면 mock
      buildingData = await callInternal(req, '/api/building?bdMgtSn=00000000000000000000');
    }

    // ── 3. 점수 산출 ──
    const factors = {
      contract,
      deposit,
      jeonseRatio:    priceData?.analysis?.jeonseRatio || null,
      medianPrice:    priceData?.trade?.stats?.median || 0,
      tradeCount:     priceData?.trade?.stats?.count || 0,
      tradeStats:     priceData?.trade?.stats || null,
      rentStats:      priceData?.rent?.stats || null,
      isViolation:    buildingData?.building?.isViolation,
      buildYear:      buildingData?.building?.buildYear,
      totalArea:      buildingData?.building?.totalArea || 0,
    };

    const { score, riskLevel, redFlags, forensicData, autoChecked } = calculateScore(factors);

    // 데이터 출처 통합 (어느 쪽이 mock이면 알림)
    const sources = {
      price:    priceData?.source    || 'unavailable',
      building: buildingData?.source || 'unavailable',
    };
    const hasMock = Object.values(sources).some(s => s.includes('mock'));

    return res.status(200).json({
      ok: true,
      score,
      riskLevel,
      redFlags,
      forensicData,
      autoChecked,
      summary: {
        contract,
        address: address || (priceData?.query?.lawdCd ? `법정동코드 ${priceData.query.lawdCd}` : ''),
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
    console.error('analyze.js 오류:', e);
    return res.status(500).json({
      ok: false,
      error: e.message || '분석 실패',
      score: 75,
      riskLevel: 'warning',
      redFlags: [{
        title: '분석 시스템 오류',
        description: e.message || '데이터를 불러오지 못했습니다',
        severity: 'caution',
      }],
      forensicData: [],
      autoChecked: {},
    });
  }
};
