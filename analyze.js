// /api/analyze.js
//
// 통합 부동산 안전 분석 API
//
// 계약유형별 점수 산출:
//   전세: 전세가율 + 등기부 + 위반건축물 + 노후
//   월세: 보증금/시세 비율 + 등기부 + 위반건축물
//   매매: 매매가 적정성 + 등기부 + 위반건축물
//
// 등기부 미연동 시 -10점 (확인 불가 = 잠재 위험)

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
  const riskBars = [];   // 점수 아래 위험 바 3개

  // ────────────────────────────────────────
  // ① 등기부 미연동 — 모든 계약유형에 공통 적용
  // ────────────────────────────────────────
  // 등기부 API 미연동 = 확인 불가 = 잠재 위험
  // 등기부 등본은 부동산 거래에서 가장 중요한 정보 (소유권/근저당/신탁/변동이력)
  // → 점수 -30점, 최대 70점 불가능
  const registryConnected = false;   // TODO: Codef 등기부 API 도입 시 true로
  if (!registryConnected) {
    score -= 30;
    flags.push({
      title: '등기부 미연동 — 확인 불가 (-30점)',
      description: '부동산 거래에서 가장 중요한 등기부 등본 정보가 확인되지 않습니다. 갑구(소유권자, 압류, 경매)·을구(근저당, 전세권)·신탁등기·소유권 변동 이력은 안전성 판단의 핵심입니다. 계약 전 반드시 임대인에게 등기부 등본(열람용) 발급을 요청하여 직접 확인하세요. (대법원 인터넷등기소에서 700원에 발급 가능)',
      severity: 'danger',
    });
  }

  // ────────────────────────────────────────
  // ② 계약유형별 핵심 점수
  // ────────────────────────────────────────
  if (factors.contract === '전세') {
    // ── 전세가율 ──
    if (factors.jeonseRatio !== null && factors.jeonseRatio > 0) {
      if (factors.jeonseRatio > 90) {
        score -= 30;
        flags.push({
          title: `전세가율 위험 수준 (${factors.jeonseRatio}%)`,
          description: '전세가율이 90%를 초과합니다. 깡통전세 위험이 매우 높으며, HUG 보증보험 가입도 거절될 수 있습니다.',
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
        result: `${factors.jeonseRatio}% (보증금 ${factors.deposit.toLocaleString()}만원 / 시세 ${factors.medianPrice.toLocaleString()}만원)`,
        riskLevel: factors.jeonseRatio > 90 ? 'danger' : factors.jeonseRatio > 80 ? 'caution' : 'safe',
      });
    } else {
      flags.push({
        title: '전세가율 산출 불가',
        description: '주변 매매 시세 데이터가 부족하여 전세가율을 산출할 수 없습니다.',
        severity: 'caution',
      });
      score -= 5;
    }

    // ── HUG 가입 가능성 ──
    if (factors.jeonseRatio !== null && factors.jeonseRatio > 0) {
      if (factors.jeonseRatio <= 90) {
        data.push({
          category: 'HUG 보증보험 가입 가능성',
          result: `가입 가능 추정 (전세가율 ${factors.jeonseRatio}% ≤ 90%)`,
          riskLevel: 'safe',
          note: '실제 가입은 HUG 심사 통과 필요',
        });
        auto['HUG / SGI 전세보증금 반환보증 가입 가능 여부 확인'] = true;
      } else {
        data.push({
          category: 'HUG 보증보험 가입 가능성',
          result: `가입 어려움 (전세가율 ${factors.jeonseRatio}% > 90%)`,
          riskLevel: 'danger',
          note: 'HUG 가입 기준 초과',
        });
      }
    }

    // ── 전세용 위험 바 3개 ──
    riskBars.push(
      {
        label: '선순위 채권 위험',
        value: registryConnected ? (factors.mortgageRatio || 0) : 50,    // 미연동 시 회색
        level: registryConnected ? (factors.mortgageRatio > 60 ? 'danger' : factors.mortgageRatio > 30 ? 'caution' : 'safe') : 'pending',
        text:  registryConnected ? (factors.mortgageRatio > 60 ? '높음' : factors.mortgageRatio > 30 ? '보통' : '낮음') : '확인 불가',
      },
      {
        label: '전세가율 위험',
        value: factors.jeonseRatio || 0,
        level: factors.jeonseRatio > 90 ? 'danger' : factors.jeonseRatio > 80 ? 'caution' : factors.jeonseRatio > 0 ? 'safe' : 'pending',
        text:  factors.jeonseRatio > 90 ? '높음' : factors.jeonseRatio > 80 ? '보통' : factors.jeonseRatio > 0 ? '낮음' : '산출 불가',
      },
      {
        label: '임대인 체납 위험',
        value: 50,
        level: 'pending',
        text: '확인 불가',
      }
    );
  }

  else if (factors.contract === '월세') {
    // ── 월세: 보증금/시세 비율 ──
    if (factors.deposit > 0 && factors.medianPrice > 0) {
      const ratio = Math.round(factors.deposit / factors.medianPrice * 1000) / 10;
      if (ratio > 30) {
        score -= 15;
        flags.push({
          title: `월세 보증금이 시세 대비 높음 (${ratio}%)`,
          description: '월세 계약치고는 보증금 비율이 높습니다 (시세의 30% 초과). 보증금 회수 위험을 검토하세요.',
          severity: 'caution',
        });
      } else if (ratio > 50) {
        score -= 25;
        flags.push({
          title: `월세 보증금 위험 수준 (${ratio}%)`,
          description: '월세 보증금이 시세의 절반 이상입니다. 사실상 반전세 또는 보증금 회수 위험이 큰 상태입니다.',
          severity: 'danger',
        });
      } else {
        auto['월세 입금 계좌가 임대인 본인 명의인지 확인'] = true;
      }
      data.push({
        category: '월세 보증금 비율',
        result: `${ratio}% (보증금 ${factors.deposit.toLocaleString()}만원 / 시세 ${factors.medianPrice.toLocaleString()}만원)`,
        riskLevel: ratio > 50 ? 'danger' : ratio > 30 ? 'caution' : 'safe',
      });
    } else {
      score -= 5;
      flags.push({
        title: '시세 대비 분석 불가',
        description: '주변 매매 시세 데이터 부족으로 보증금 적정성 분석이 제한됩니다.',
        severity: 'caution',
      });
    }

    // ── 월세 시세 비교 ──
    if (factors.rentMonthlyAvg > 0 && factors.userMonthly > 0) {
      const monthlyRatio = Math.round(factors.userMonthly / factors.rentMonthlyAvg * 100);
      if (monthlyRatio > 130) {
        flags.push({
          title: `월세가 주변 평균 대비 높음 (${monthlyRatio}%)`,
          description: `주변 월세 평균 ${factors.rentMonthlyAvg}만원 대비 ${monthlyRatio}% 수준입니다.`,
          severity: 'caution',
        });
        score -= 5;
      }
      data.push({
        category: '월세 시세 비교',
        result: `사용자 ${factors.userMonthly}만원 / 평균 ${factors.rentMonthlyAvg}만원 (${monthlyRatio}%)`,
        riskLevel: monthlyRatio > 130 ? 'caution' : 'safe',
      });
    }

    // ── 월세용 위험 바 3개 ──
    riskBars.push(
      {
        label: '선순위 채권 위험',
        value: registryConnected ? (factors.mortgageRatio || 0) : 50,
        level: registryConnected ? (factors.mortgageRatio > 60 ? 'danger' : factors.mortgageRatio > 30 ? 'caution' : 'safe') : 'pending',
        text:  registryConnected ? (factors.mortgageRatio > 60 ? '높음' : factors.mortgageRatio > 30 ? '보통' : '낮음') : '확인 불가',
      },
      {
        label: '보증금 회수 위험',
        value: factors.deposit > 0 && factors.medianPrice > 0
              ? Math.min(Math.round(factors.deposit / factors.medianPrice * 100), 100)
              : 0,
        level: (() => {
          if (!factors.deposit || !factors.medianPrice) return 'pending';
          const r = factors.deposit / factors.medianPrice * 100;
          return r > 50 ? 'danger' : r > 30 ? 'caution' : 'safe';
        })(),
        text: factors.deposit > 0 && factors.medianPrice > 0 ? '산출됨' : '산출 불가',
      },
      {
        label: '임대인 체납 위험',
        value: 50,
        level: 'pending',
        text: '확인 불가',
      }
    );
  }

  else if (factors.contract === '매매') {
    // ── 매매가 적정성 ──
    if (factors.deposit > 0 && factors.medianPrice > 0) {
      const ratio = Math.round(factors.deposit / factors.medianPrice * 1000) / 10;
      if (ratio > 115) {
        score -= 15;
        flags.push({
          title: `매매가 시세 대비 고평가 (${ratio}%)`,
          description: '주변 매매 시세 대비 15% 이상 높은 가격입니다. 갭투자 또는 시세 조작 가능성을 검토하세요.',
          severity: 'caution',
        });
      } else if (ratio < 85) {
        score -= 5;
        flags.push({
          title: `매매가 시세 대비 저평가 (${ratio}%)`,
          description: '주변 매매 시세 대비 15% 이상 낮습니다. 권리 하자, 위반건축물, 도시계획 변경 등 가격 하락 요인을 확인하세요.',
          severity: 'caution',
        });
      } else {
        auto['실거래가 및 공시지가 대비 매매가 적정성 확인'] = true;
      }
      data.push({
        category: '매매가 적정성',
        result: `${ratio}% (매매가 ${factors.deposit.toLocaleString()}만원 / 주변 시세 ${factors.medianPrice.toLocaleString()}만원)`,
        riskLevel: ratio > 115 || ratio < 85 ? 'caution' : 'safe',
      });
    } else {
      score -= 5;
      flags.push({
        title: '매매가 적정성 분석 불가',
        description: '주변 실거래 데이터 부족으로 시세 비교가 제한됩니다.',
        severity: 'caution',
      });
    }

    // ── 매매용 위험 바 3개 ──
    riskBars.push(
      {
        label: '권리관계 위험 (등기부)',
        value: 50,
        level: 'pending',
        text: '확인 불가',
      },
      {
        label: '매매가 적정성',
        value: factors.deposit > 0 && factors.medianPrice > 0
              ? Math.min(Math.abs(factors.deposit - factors.medianPrice) / factors.medianPrice * 100 * 5, 100)
              : 0,
        level: (() => {
          if (!factors.deposit || !factors.medianPrice) return 'pending';
          const r = factors.deposit / factors.medianPrice * 100;
          return (r > 115 || r < 85) ? 'caution' : 'safe';
        })(),
        text: factors.deposit > 0 && factors.medianPrice > 0 ? '산출됨' : '산출 불가',
      },
      {
        label: '소유권 안정성',
        value: 50,
        level: 'pending',
        text: '확인 불가',
      }
    );
  }

  // ────────────────────────────────────────
  // ③ 공통 — 위반건축물 + 노후
  // ────────────────────────────────────────
  if (factors.tradeCount === 0) {
    flags.push({
      title: '최근 실거래 데이터 부족',
      description: '최근 3개월간 해당 지역의 매매 실거래가 없어 시세 비교가 제한됩니다.',
      severity: 'caution',
    });
    score -= 5;
  }

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

  if (factors.totalArea > 0) {
    data.push({
      category: '연면적',
      result: `${factors.totalArea.toLocaleString()}㎡`,
      riskLevel: 'safe',
    });
  }

  // ④ 시세 통계
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

  // ⑤ 등기부 관련 — placeholder
  data.push({
    category: '등기부 갑구 (소유권)',
    result: 'API 연결 대기',
    riskLevel: 'pending',
    note: '등기부 등본 API 연동 시 자동 표시',
  });
  data.push({
    category: '등기부 을구 (근저당·전세권)',
    result: 'API 연결 대기',
    riskLevel: 'pending',
    note: '등기부 등본 API 연동 시 자동 표시',
  });
  data.push({
    category: '신탁 등기 여부',
    result: 'API 연결 대기',
    riskLevel: 'pending',
    note: '등기부 등본 API 연동 시 자동 표시',
  });
  data.push({
    category: '소유권 변동 이력',
    result: 'API 연결 대기',
    riskLevel: 'pending',
    note: '등기부 등본 API 연동 시 자동 표시',
  });

  if (score < 0) score = 0;
  if (score > 100) score = 100;

  let riskLevel;
  if (score >= 80) riskLevel = 'safe';
  else if (score >= 60) riskLevel = 'warning';
  else riskLevel = 'danger';

  return {
    score, riskLevel,
    redFlags: flags,
    forensicData: data,
    autoChecked: auto,
    riskBars,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const q = (req.query && typeof req.query === 'object') ? req.query : {};
    const contract = (q.contract || '전세').toString();
    const deposit  = parseInt(q.deposit) || 0;
    const monthly  = parseInt(q.monthly) || 0;       // 월세 추가 입력
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
    if (bdMgtSn && bdMgtSn.length === 25) {
      const bldgQs = new URLSearchParams({ bdMgtSn });
      if (aptName) bldgQs.set('aptName', aptName);
      if (address) bldgQs.set('address', address);
      buildingData = await callInternal(req, '/api/building?' + bldgQs.toString());
    } else {
      // bdMgtSn 미제공 시: 건축물대장 데이터는 미수집 (mock 강제 안 함)
      buildingData = { ok: false, building: null, source: 'unavailable' };
    }

    // ── 3. 점수 ──
    const factors = {
      contract,
      deposit,
      userMonthly:    monthly,
      jeonseRatio:    (priceData && priceData.analysis) ? priceData.analysis.jeonseRatio : null,
      medianPrice:    (priceData && priceData.trade && priceData.trade.stats) ? priceData.trade.stats.median : 0,
      tradeCount:     (priceData && priceData.trade && priceData.trade.stats) ? priceData.trade.stats.count : 0,
      tradeStats:     (priceData && priceData.trade) ? priceData.trade.stats : null,
      rentStats:      (priceData && priceData.rent)  ? priceData.rent.stats : null,
      rentMonthlyAvg: (priceData && priceData.rent && priceData.rent.stats && priceData.rent.stats.monthly)
                       ? priceData.rent.stats.monthly.avgRent : 0,
      mortgageRatio:  null,    // 등기부 미연동
      isViolation:    (buildingData && buildingData.building) ? buildingData.building.isViolation : null,
      buildYear:      (buildingData && buildingData.building) ? buildingData.building.buildYear : null,
      totalArea:      (buildingData && buildingData.building) ? buildingData.building.totalArea : 0,
    };

    const calc = calculateScore(factors);

    const sources = {
      price:    (priceData && priceData.source) || 'unavailable',
      building: (buildingData && buildingData.source) || 'unavailable',
      registry: 'pending',
    };
    const hasMock = Object.values(sources).some(s => s.includes('mock'));

    return res.status(200).json({
      ok: true,
      score:        calc.score,
      riskLevel:    calc.riskLevel,
      redFlags:     calc.redFlags,
      forensicData: calc.forensicData,
      autoChecked:  calc.autoChecked,
      riskBars:     calc.riskBars,
      summary: {
        contract,
        address: address || (priceData && priceData.query ? `법정동코드 ${priceData.query.lawdCd}` : ''),
        complexName: aptName,
        deposit,
        monthly,
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
      riskBars: [],
      analyzedAt: new Date().toISOString(),
    });
  }
}
