// api/analyze.js
// 통합 분석 API — 주소 하나로 전체 분석 수행
// 순서: 주소정제 → 실거래가 → 등기부 → 종합 위험도 산출
// Vercel Serverless Function

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { address, deposit } = req.query;
  // address: 입력 주소 문자열
  // deposit: 보증금 (만원 단위, 예: 32000 = 3억2천)

  if (!address) {
    return res.status(400).json({ error: '주소를 입력해주세요.' });
  }

  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000';

  try {
    // ── STEP 1: 주소 정제 ──────────────────────────
    let addrData = null;
    let lawdCd = null;
    let bdMgtSn = null;

    try {
      const addrRes = await fetch(`${baseUrl}/api/address?query=${encodeURIComponent(address)}`);
      const addrJson = await addrRes.json();
      if (addrJson.ok && addrJson.results?.length > 0) {
        addrData = addrJson.results[0];
        lawdCd   = addrData.admCd?.slice(0, 5);   // 법정동코드 앞 5자리
        bdMgtSn  = addrData.bdMgtSn;
      }
    } catch (e) {
      console.warn('주소 API 실패, 계속 진행:', e.message);
    }

    // ── STEP 2: 실거래가 조회 ──────────────────────
    let priceData = null;
    let jeonseRatio = null;  // 전세가율

    try {
      const priceRes = await fetch(`${baseUrl}/api/price?lawdCd=${lawdCd || '26350'}`);
      const priceJson = await priceRes.json();
      if (priceJson.ok) {
        priceData = priceJson.data || priceJson;
        // 전세가율 계산 (보증금 / 평균시세 * 100)
        if (deposit && priceData.avgDepositManwon) {
          jeonseRatio = Math.round((parseInt(deposit) / priceData.avgDepositManwon) * 100);
        }
      }
    } catch (e) {
      console.warn('실거래가 API 실패, 계속 진행:', e.message);
    }

    // ── STEP 3: 등기부 분석 ────────────────────────
    let registryData = null;

    try {
      const regUrl = bdMgtSn
        ? `${baseUrl}/api/registry?bdMgtSn=${bdMgtSn}&address=${encodeURIComponent(address)}`
        : `${baseUrl}/api/registry?address=${encodeURIComponent(address)}`;
      const regRes  = await fetch(regUrl);
      const regJson = await regRes.json();
      if (regJson.ok) registryData = regJson.data || regJson;
    } catch (e) {
      console.warn('등기부 API 실패, 계속 진행:', e.message);
    }

    // ── STEP 4: 종합 위험도 산출 ───────────────────
    const finalScore = calcFinalScore({
      registryScore: registryData?.score,
      jeonseRatio,
      mortgageCount: registryData?.summary?.mortgageCount,
      hasSeizure:    registryData?.summary?.hasSeizure,
      hasTrust:      registryData?.summary?.hasTrust,
    });

    const alerts = buildAlerts({ registryData, jeonseRatio, priceData });
    const checklist = buildChecklist({ registryData, jeonseRatio });

    // ── STEP 5: 응답 ───────────────────────────────
    return res.status(200).json({
      ok: true,
      address: addrData?.roadAddr || address,
      analyzedAt: new Date().toISOString(),

      score: finalScore,
      riskLevel: finalScore >= 80 ? 'safe' : finalScore >= 60 ? 'warning' : 'danger',

      // 전세가율
      jeonseRatio: jeonseRatio || null,
      jeonseRatioRisk: jeonseRatio
        ? jeonseRatio >= 90 ? 'danger'
        : jeonseRatio >= 80 ? 'warning' : 'safe'
        : null,

      // 주소 정보
      addressInfo: addrData,

      // 실거래가
      priceInfo: priceData ? {
        avgDepositManwon: priceData.avgDepositManwon || priceData.avgDeposit,
        recentDeals:      priceData.recentDeals || priceData.deals,
        mock:             priceData.mock ?? true,
      } : null,

      // 등기부
      registryInfo: registryData ? {
        risks:    registryData.risks,
        summary:  registryData.summary,
        mock:     registryData.mock ?? true,
      } : null,

      // 주요 경보
      alerts,

      // 체크리스트
      checklist,

      // HUG 가입 가능 여부
      hugEligible: jeonseRatio ? jeonseRatio < 90 : null,
    });

  } catch (err) {
    console.error('통합 분석 오류:', err);
    return res.status(500).json({ error: '분석 중 오류가 발생했습니다.' });
  }
}

// 종합 점수 계산
function calcFinalScore({ registryScore, jeonseRatio, mortgageCount, hasSeizure, hasTrust }) {
  let score = registryScore ?? 75;

  if (jeonseRatio) {
    if (jeonseRatio >= 90) score -= 20;
    else if (jeonseRatio >= 80) score -= 10;
  }
  if (hasSeizure) score -= 15;
  if (hasTrust)   score -= 15;
  if (mortgageCount >= 2) score -= 10;

  return Math.max(Math.min(Math.round(score), 100), 0);
}

// 주요 경보 생성
function buildAlerts({ registryData, jeonseRatio, priceData }) {
  const alerts = [];

  if (jeonseRatio && jeonseRatio >= 90) {
    alerts.push({
      level: 'danger',
      title: 'HUG 보증보험 가입 불가 위험',
      desc:  `전세가율 ${jeonseRatio}% — HUG 기준(90%) 초과. 보증보험 가입이 거절될 수 있습니다.`,
    });
  }
  if (registryData?.summary?.mortgageCount >= 2) {
    alerts.push({
      level: 'danger',
      title: '선순위 근저당 다수 발견',
      desc:  `근저당 ${registryData.summary.mortgageCount}건, ${registryData.summary.totalMortgageManwon?.toLocaleString()}만 원. 잔금 전 말소 특약 필수.`,
    });
  }
  if (registryData?.summary?.hasTrust) {
    alerts.push({
      level: 'danger',
      title: '신탁 등기 발견',
      desc:  '수익자 동의 없는 임대차는 법적 효력이 없을 수 있습니다.',
    });
  }
  if (jeonseRatio && jeonseRatio >= 80 && jeonseRatio < 90) {
    alerts.push({
      level: 'warning',
      title: '전세가율 위험 구간 근접',
      desc:  `현재 ${jeonseRatio}% — 80% 이상은 역전세 위험 구간입니다.`,
    });
  }

  return alerts;
}

// 체크리스트 자동 생성
function buildChecklist({ registryData, jeonseRatio }) {
  return [
    { id: 1, required: true,  done: false, text: '임대인 신분증 대조 및 등기부 소유자 일치 확인' },
    { id: 2, required: true,  done: false, text: '국세 / 지방세 완납 증명서 수령' },
    { id: 3, required: true,  done: !(registryData?.summary?.mortgageCount > 0),
      text: '근저당권 잔금 전 전액 말소 조건 계약서 명시',
      alert: registryData?.summary?.mortgageCount > 0 },
    { id: 4, required: true,  done: false, text: '확정일자 및 전입신고 즉시 이행 계획 확인' },
    { id: 5, required: true,  done: jeonseRatio ? jeonseRatio < 90 : null,
      text: 'HUG / SGI 전세보증금 반환보증 가입 확인',
      alert: jeonseRatio >= 90 },
    { id: 6, required: false, done: false, text: '임대인 담보대출 추가 설정 금지 특약 삽입' },
    { id: 7, required: false, done: !registryData?.summary?.hasTrust,
      text: '신탁 등기 여부 확인 (수익자 동의 없는 임대 금지)' },
    { id: 8, required: false, done: false, text: '계약 후 사후 모니터링 등록' },
  ];
}
