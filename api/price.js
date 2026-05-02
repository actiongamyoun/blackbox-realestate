// api/price.js
// 국토교통부 아파트 전월세 실거래가 API (data.go.kr)
// Vercel Serverless Function

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { lawdCd, dealYmd } = req.query;
  // lawdCd: 법정동코드 앞 5자리 (예: 11680 = 서울 강남구)
  // dealYmd: 계약년월 (예: 202504)

  const apiKey = process.env.MOLIT_API_KEY;

  // API 키 없으면 Mock 데이터 반환 (개발/테스트용)
  if (!apiKey || apiKey === 'YOUR_MOLIT_API_KEY_HERE') {
    return res.status(200).json({
      ok: true,
      mock: true,
      message: 'MOLIT_API_KEY 미설정 — Mock 데이터 반환',
      data: getMockPriceData(lawdCd),
    });
  }

  if (!lawdCd) {
    return res.status(400).json({ error: '법정동코드(lawdCd)가 필요합니다.' });
  }

  try {
    const ym = dealYmd || getCurrentYearMonth();

    // 아파트 전월세 실거래가
    const url = new URL('http://openapi.molit.go.kr/OpenAPI_ToolInstallPackage/service/rest/RTMSOBJSvc/getRTMSDataSvcAptRent');
    url.searchParams.set('serviceKey', decodeURIComponent(apiKey));
    url.searchParams.set('LAWD_CD', lawdCd);
    url.searchParams.set('DEAL_YMD', ym);
    url.searchParams.set('numOfRows', '100');
    url.searchParams.set('pageNo', '1');

    const response = await fetch(url.toString());
    const text = await response.text();

    // XML → JSON 간단 파싱
    const items = parseXmlItems(text);

    // 전세만 필터링 후 평균 시세 계산
    const jeonseItems = items.filter(i => i.계약구분 === '전세' || !i.월세금액 || i.월세금액 === '0');
    const avgDeposit = jeonseItems.length > 0
      ? Math.round(jeonseItems.reduce((sum, i) => sum + parseInt(i.보증금액?.replace(',','') || 0), 0) / jeonseItems.length)
      : 0;

    return res.status(200).json({
      ok: true,
      mock: false,
      lawdCd,
      dealYmd: ym,
      totalCount: items.length,
      jeonseCount: jeonseItems.length,
      avgDepositManwon: avgDeposit,  // 만원 단위
      recentDeals: jeonseItems.slice(0, 10).map(i => ({
        aptName:    i.아파트,
        area:       i.전용면적,
        floor:      i.층,
        deposit:    i.보증금액,
        dealDate:   `${i.년}-${i.월}-${i.일}`,
      })),
    });

  } catch (err) {
    console.error('실거래가 API 오류:', err);
    return res.status(500).json({ error: '실거래가 조회 중 오류가 발생했습니다.' });
  }
}

// XML 아이템 파싱
function parseXmlItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  const fieldRegex = /<([^>]+)>([^<]*)<\/\1>/g;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(xml)) !== null) {
    const item = {};
    let fieldMatch;
    while ((fieldMatch = fieldRegex.exec(itemMatch[1])) !== null) {
      item[fieldMatch[1].trim()] = fieldMatch[2].trim();
    }
    items.push(item);
  }
  return items;
}

// 현재 년월 (YYYYMM)
function getCurrentYearMonth() {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// Mock 데이터 (API 키 없을 때)
function getMockPriceData(lawdCd) {
  const mockMap = {
    '11680': { area: '서울 강남구', avgDeposit: 85000, deals: [
      { aptName: '래미안 역삼', area: '84.27', floor: '12', deposit: '90,000', dealDate: '2026-04-15' },
      { aptName: '역삼 e편한세상', area: '59.98', floor: '8',  deposit: '75,000', dealDate: '2026-04-10' },
    ]},
    '26350': { area: '부산 해운대구', avgDeposit: 32000, deals: [
      { aptName: '해운대 센텀 푸르지오', area: '84.98', floor: '15', deposit: '35,000', dealDate: '2026-04-20' },
      { aptName: '마린시티 자이',        area: '59.50', floor: '22', deposit: '28,000', dealDate: '2026-04-08' },
    ]},
  };
  return mockMap[lawdCd] || {
    area: '해당 지역',
    avgDeposit: 25000,
    deals: [
      { aptName: '샘플 아파트', area: '59.00', floor: '5', deposit: '25,000', dealDate: '2026-04-01' },
    ],
  };
}
