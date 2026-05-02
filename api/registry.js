// api/registry.js
// 등기부등본 분석 API
// 실제: 레지스터올(Registall) API 연동
// 미설정시: Mock 데이터 반환
// Vercel Serverless Function

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { bdMgtSn, address } = req.query;
  // bdMgtSn: 건물관리번호 (address API에서 받아온 값)
  // address: 주소 문자열 (bdMgtSn 없을 때 대체)

  const apiKey = process.env.REGISTALL_API_KEY;

  // API 키 없으면 Mock 반환
  if (!apiKey || apiKey === 'YOUR_REGISTALL_API_KEY_HERE') {
    return res.status(200).json({
      ok: true,
      mock: true,
      message: '등기부 API 미설정 — Mock 데이터 반환 (실제 서비스 전 레지스터올 계약 필요)',
      data: getMockRegistryData(address),
    });
  }

  if (!bdMgtSn && !address) {
    return res.status(400).json({ error: '건물관리번호 또는 주소가 필요합니다.' });
  }

  try {
    const baseUrl = process.env.REGISTALL_API_URL || 'https://api.registall.co.kr/v1';

    const response = await fetch(`${baseUrl}/registry/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ bdMgtSn, address }),
    });

    if (!response.ok) {
      throw new Error(`레지스터올 API 오류: ${response.status}`);
    }

    const raw = await response.json();

    // 위험도 분석
    const analysis = analyzeRegistry(raw);

    return res.status(200).json({
      ok: true,
      mock: false,
      raw,
      analysis,
    });

  } catch (err) {
    console.error('등기부 API 오류:', err);
    return res.status(500).json({ error: '등기부 조회 중 오류가 발생했습니다.' });
  }
}

// 등기부 위험도 분석 엔진
function analyzeRegistry(data) {
  const risks = [];
  let score = 100; // 100점에서 차감

  // 갑구 분석 (소유권)
  const gabgu = data.갑구 || data.gabgu || [];
  const hasSeizure = gabgu.some(g =>
    g.등기목적?.includes('가압류') || g.등기목적?.includes('압류') || g.등기목적?.includes('경매')
  );
  if (hasSeizure) {
    score -= 30;
    risks.push({ level: 'danger', title: '가압류/압류 발견', desc: '갑구에 강제집행 관련 등기가 있습니다.' });
  }

  const hasTrust = gabgu.some(g => g.등기목적?.includes('신탁'));
  if (hasTrust) {
    score -= 25;
    risks.push({ level: 'danger', title: '신탁 등기 발견', desc: '수익자 동의 없는 임대차 계약은 무효가 될 수 있습니다.' });
  }

  const ownerChanges = gabgu.filter(g => g.등기목적?.includes('소유권이전')).length;
  if (ownerChanges >= 3) {
    score -= 15;
    risks.push({ level: 'warning', title: `소유권 변동 ${ownerChanges}회`, desc: '단기간 잦은 소유주 변경은 갭투자 의심 신호입니다.' });
  }

  // 을구 분석 (근저당)
  const eulgu = data.을구 || data.eulgu || [];
  const mortgages = eulgu.filter(g =>
    g.등기목적?.includes('근저당') && !g.등기목적?.includes('말소')
  );
  const totalMortgage = mortgages.reduce((sum, m) => {
    const amt = parseInt((m.채권최고액 || '0').replace(/[^0-9]/g, '')) || 0;
    return sum + amt;
  }, 0);

  if (mortgages.length > 0) {
    const mortgageManwon = Math.round(totalMortgage / 10000);
    if (mortgages.length >= 2 || totalMortgage > 100000000) {
      score -= 25;
      risks.push({
        level: 'danger',
        title: `근저당 ${mortgages.length}건`,
        desc: `채권최고액 합계 ${mortgageManwon.toLocaleString()}만 원. 보증금 회수 위험.`,
      });
    } else {
      score -= 10;
      risks.push({
        level: 'warning',
        title: `근저당 ${mortgages.length}건`,
        desc: `채권최고액 ${mortgageManwon.toLocaleString()}만 원. 말소 조건 특약 필요.`,
      });
    }
  }

  return {
    score: Math.max(score, 0),
    riskLevel: score >= 80 ? 'safe' : score >= 60 ? 'warning' : 'danger',
    risks,
    summary: {
      hasSeizure,
      hasTrust,
      ownerChanges,
      mortgageCount: mortgages.length,
      totalMortgageManwon: Math.round(totalMortgage / 10000),
    },
  };
}

// Mock 등기부 데이터
function getMockRegistryData(address) {
  const isDanger = address?.includes('해운대') || address?.includes('오피스텔');
  return {
    score:     isDanger ? 42 : 78,
    riskLevel: isDanger ? 'danger' : 'warning',
    risks: isDanger ? [
      { level: 'danger',  title: '근저당 2건',         desc: '채권최고액 합계 1억 8천만 원. 보증금 회수 위험.' },
      { level: 'danger',  title: '전세가율 91% 초과',  desc: 'KB시세 대비 91.2%. 역전세 위험.' },
      { level: 'warning', title: '소유권 변동 3회',    desc: '최근 2년 내 3회 변동. 갭투자 의심.' },
    ] : [
      { level: 'warning', title: '근저당 1건',         desc: '채권최고액 5,000만 원. 말소 조건 특약 필요.' },
      { level: 'warning', title: '소유권 변동 1회',    desc: '최근 14개월 내 1회 변동.' },
    ],
    summary: {
      hasSeizure:           false,
      hasTrust:             false,
      ownerChanges:         isDanger ? 3 : 1,
      mortgageCount:        isDanger ? 2 : 1,
      totalMortgageManwon:  isDanger ? 18000 : 5000,
    },
    gabgu: [
      { 순위번호: '1', 등기목적: '소유권보존', 등기원인: '신탁', 권리자: '소유자 홍○○' },
      { 순위번호: '2', 등기목적: '소유권이전', 등기원인: '매매', 권리자: '홍○○' },
    ],
    eulgu: isDanger ? [
      { 순위번호: '1', 등기목적: '근저당권설정', 채권최고액: '금130,000,000원', 채권자: '○○은행' },
      { 순위번호: '2', 등기목적: '근저당권설정', 채권최고액: '금50,000,000원',  채권자: '△△저축은행' },
    ] : [
      { 순위번호: '1', 등기목적: '근저당권설정', 채권최고액: '금50,000,000원', 채권자: '○○은행' },
    ],
  };
}
