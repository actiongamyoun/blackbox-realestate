// /api/building.js
//
// 건축물대장 조회 API
//
// 사용처: 위반건축물 여부, 면적, 용도, 건축연도 확인
// 데이터 출처: 국토교통부 건축물대장정보서비스 (공공데이터 포털)
//
// Vercel 환경변수:
//   DATA_GO_KR_KEY_BLDG  ← 건축물대장 API 키
//
// 호출 방법:
//   GET /api/building?bdMgtSn=1168010100100070000027459        ← 건물관리번호 (JUSO에서 받은 값)
//   GET /api/building?sigunguCd=11680&bjdongCd=10100&platGbCd=0&bun=7&ji=27
//
// 파라미터:
//   bdMgtSn:    건물관리번호 25자리 (JUSO API의 bdMgtSn과 동일)
//   sigunguCd:  시군구코드 5자리
//   bjdongCd:   법정동코드 5자리
//   platGbCd:   대지구분코드 (0:대지, 1:산, 2:블록)
//   bun:        본번
//   ji:         부번
//
// 응답 표준:
//   {
//     ok: true,
//     source: "publicData" | "mock",
//     building: {
//       name, useType, structure, totalFloors, undergroundFloors,
//       buildYear, totalArea, plotArea, isViolation, violationDesc, ...
//     },
//     warnings: [],
//     fetchedAt
//   }

// 표제부 (건물 기본정보) 엔드포인트
const BLDG_TITLE_URL = 'https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo';

// XML 파서 (price.js와 동일)
function parseXml(xmlText) {
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
  const resultCode = (xmlText.match(/<resultCode>(\d+)<\/resultCode>/) || [])[1];
  const resultMsg  = (xmlText.match(/<resultMsg>([^<]*)<\/resultMsg>/) || [])[1];
  return { items, resultCode, resultMsg };
}

// bdMgtSn(25자리)을 분해해서 sigunguCd, bjdongCd, platGbCd, bun, ji 추출
function parseBdMgtSn(bdMgtSn) {
  if (!bdMgtSn || bdMgtSn.length !== 25) return null;
  return {
    sigunguCd: bdMgtSn.substring(0, 5),
    bjdongCd:  bdMgtSn.substring(5, 10),
    platGbCd:  bdMgtSn.substring(10, 11),
    bun:       String(parseInt(bdMgtSn.substring(11, 15)) || 0),
    ji:        String(parseInt(bdMgtSn.substring(15, 19)) || 0),
  };
}

async function fetchBuildingData(key, params) {
  const qs = new URLSearchParams({
    serviceKey: key,
    sigunguCd:  params.sigunguCd,
    bjdongCd:   params.bjdongCd,
    platGbCd:   params.platGbCd || '0',
    bun:        String(params.bun).padStart(4, '0'),
    ji:         String(params.ji).padStart(4, '0'),
    numOfRows:  '10',
    pageNo:     '1',
    _type:      'xml',
  });
  // serviceKey 재인코딩 처리
  const url = BLDG_TITLE_URL + '?' + qs.toString().replace(
    /serviceKey=([^&]+)/,
    'serviceKey=' + encodeURIComponent(decodeURIComponent(key))
  );

  const res  = await fetch(url, { headers: { 'Accept': 'application/xml' } });
  const text = await res.text();
  if (text.includes('SERVICE_KEY_IS_NOT_REGISTERED')) {
    throw new Error('API 키 미등록 또는 승인 대기 중');
  }
  return parseXml(text);
}

// 응답 데이터 정규화
function normalizeBuilding(item) {
  if (!item) return null;
  return {
    name:               item.bldNm || '(이름 없음)',
    address:            (item.platPlc || '') + (item.newPlatPlc ? ' / ' + item.newPlatPlc : ''),
    mainPurpose:        item.mainPurpsCdNm || '',  // 주용도 (예: 공동주택)
    detailPurpose:      item.etcPurps   || '',
    structure:          item.strctCdNm || '',     // 구조 (예: 철근콘크리트구조)
    totalFloors:        parseInt(item.grndFlrCnt) || 0,        // 지상층수
    undergroundFloors:  parseInt(item.ugrndFlrCnt) || 0,       // 지하층수
    totalArea:          parseFloat(item.totArea) || 0,         // 연면적 (㎡)
    plotArea:           parseFloat(item.platArea) || 0,        // 대지면적
    archArea:           parseFloat(item.archArea) || 0,        // 건축면적
    bcRat:              parseFloat(item.bcRat) || 0,           // 건폐율 (%)
    vlRat:              parseFloat(item.vlRat) || 0,           // 용적률 (%)
    buildYear:          item.useAprDay ? item.useAprDay.substring(0, 4) : null,
    useApprovalDate:    item.useAprDay || null,                // 사용승인일
    isViolation:        item.violBldYn === 'Y',                // 위반건축물 여부
    violationDesc:      item.violBldYn === 'Y' ? '위반건축물 등재' : null,
    parkingTotal:       parseInt(item.totPkngCnt) || 0,        // 총 주차대수
    elevatorPassenger:  parseInt(item.rideUseElvtCnt) || 0,    // 승강기
    rooftopType:        item.rserthqkAblty || null,            // 지붕재료
  };
}

function mockBuilding(query) {
  return {
    name: query.aptName || '샘플 아파트',
    address: query.address || '서울특별시 강남구 (mock)',
    mainPurpose: '공동주택',
    detailPurpose: '아파트',
    structure: '철근콘크리트구조',
    totalFloors: 25,
    undergroundFloors: 2,
    totalArea: 12500.5,
    plotArea: 3200.0,
    archArea: 1100.0,
    bcRat: 34.4,
    vlRat: 250.5,
    buildYear: '2018',
    useApprovalDate: '20180501',
    isViolation: false,
    violationDesc: null,
    parkingTotal: 320,
    elevatorPassenger: 4,
    rooftopType: null,
    _isMock: true,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const q = req.query || {};
    let params;

    // bdMgtSn으로 들어온 경우 분해
    if (q.bdMgtSn) {
      params = parseBdMgtSn(q.bdMgtSn);
      if (!params) {
        return res.status(400).json({
          ok: false,
          error: 'bdMgtSn 형식이 잘못되었습니다 (25자리 필요)',
          source: 'error',
        });
      }
    } else if (q.sigunguCd && q.bjdongCd) {
      params = {
        sigunguCd: q.sigunguCd,
        bjdongCd:  q.bjdongCd,
        platGbCd:  q.platGbCd || '0',
        bun:       q.bun || '0',
        ji:        q.ji  || '0',
      };
    } else {
      return res.status(400).json({
        ok: false,
        error: 'bdMgtSn 또는 (sigunguCd + bjdongCd + bun) 필요',
        source: 'error',
      });
    }

    const key = process.env.DATA_GO_KR_KEY_BLDG;
    let usedSource = 'mock';
    let building   = null;
    let warnings   = [];

    if (key) {
      try {
        const result = await fetchBuildingData(key, params);
        if (result.items.length) {
          building = normalizeBuilding(result.items[0]);
          usedSource = 'publicData';
          // 여러 건 (단지 내 여러 동) 응답 시 추가 정보
          if (result.items.length > 1) {
            building.relatedBuildings = result.items.slice(1).map(normalizeBuilding);
          }
        } else {
          warnings.push('해당 주소의 건축물대장 정보가 없습니다');
          building = mockBuilding({ aptName: q.aptName, address: q.address });
          usedSource = 'mock-fallback';
        }
      } catch (e) {
        console.error('건축물대장 API 오류:', e.message);
        warnings.push('건축물대장 API 오류: ' + e.message);
        building = mockBuilding({ aptName: q.aptName, address: q.address });
        usedSource = 'mock-fallback';
      }
    } else {
      building = mockBuilding({ aptName: q.aptName, address: q.address });
    }

    return res.status(200).json({
      ok: true,
      source: usedSource,
      query: params,
      building,
      warnings,
      fetchedAt: new Date().toISOString(),
    });

  } catch (e) {
    console.error('building.js 처리 오류:', e);
    return res.status(500).json({
      ok: false,
      error: e.message || '서버 오류',
      source: 'error',
      fetchedAt: new Date().toISOString(),
    });
  }
};
