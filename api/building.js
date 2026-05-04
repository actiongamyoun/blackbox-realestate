// /api/building.js
//
// 건축물대장 조회 API (방어적 버전)

const BLDG_TITLE_URL = 'https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo';

function parseXml(xmlText) {
  const result = { items: [], resultCode: '', resultMsg: '' };
  if (!xmlText || typeof xmlText !== 'string') return result;
  try {
    const codeMatch = xmlText.match(/<resultCode>(\d+)<\/resultCode>/);
    if (codeMatch) result.resultCode = codeMatch[1];
    const msgMatch = xmlText.match(/<resultMsg>([^<]*)<\/resultMsg>/);
    if (msgMatch) result.resultMsg = msgMatch[1];

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
      } catch (e) {}
    }
  } catch (e) {
    console.error('XML 파싱 오류:', e.message);
  }
  return result;
}

function normalizeKey(key) {
  if (!key) return null;
  if (key.includes('%')) return key;
  return encodeURIComponent(key);
}

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
  const normalizedKey = normalizeKey(key);
  if (!normalizedKey) throw new Error('건축물대장 API 키 비어있음');

  const url = BLDG_TITLE_URL
    + '?serviceKey=' + normalizedKey
    + '&sigunguCd=' + encodeURIComponent(params.sigunguCd)
    + '&bjdongCd='  + encodeURIComponent(params.bjdongCd)
    + '&platGbCd='  + encodeURIComponent(params.platGbCd || '0')
    + '&bun='       + encodeURIComponent(String(params.bun).padStart(4, '0'))
    + '&ji='        + encodeURIComponent(String(params.ji).padStart(4, '0'))
    + '&numOfRows=10&pageNo=1&_type=xml';

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 10000);
  const res = await fetch(url, {
    headers: { 'Accept': 'application/xml' },
    signal: controller.signal,
  });
  clearTimeout(timeoutId);

  const text = await res.text();
  if (text.includes('SERVICE_KEY_IS_NOT_REGISTERED')) {
    throw new Error('SERVICE_KEY_NOT_REGISTERED — 키 미등록 또는 승인 대기');
  }
  if (text.includes('LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR')) {
    throw new Error('일일 호출 한도 초과');
  }
  return parseXml(text);
}

function normalizeBuilding(item) {
  if (!item) return null;
  return {
    name: item.bldNm || '(이름 없음)',
    address: (item.platPlc || '') + (item.newPlatPlc ? ' / ' + item.newPlatPlc : ''),
    mainPurpose: item.mainPurpsCdNm || '',
    detailPurpose: item.etcPurps || '',
    structure: item.strctCdNm || '',
    totalFloors: parseInt(item.grndFlrCnt) || 0,
    undergroundFloors: parseInt(item.ugrndFlrCnt) || 0,
    totalArea: parseFloat(item.totArea) || 0,
    plotArea: parseFloat(item.platArea) || 0,
    archArea: parseFloat(item.archArea) || 0,
    bcRat: parseFloat(item.bcRat) || 0,
    vlRat: parseFloat(item.vlRat) || 0,
    buildYear: item.useAprDay ? item.useAprDay.substring(0, 4) : null,
    useApprovalDate: item.useAprDay || null,
    isViolation: item.violBldYn === 'Y',
    violationDesc: item.violBldYn === 'Y' ? '위반건축물 등재' : null,
    parkingTotal: parseInt(item.totPkngCnt) || 0,
    elevatorPassenger: parseInt(item.rideUseElvtCnt) || 0,
  };
}

function mockBuilding(query) {
  return {
    name: (query && query.aptName) || '샘플 아파트 (mock)',
    address: (query && query.address) || '서울특별시 강남구 (mock)',
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
    _isMock: true,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const q = (req.query && typeof req.query === 'object') ? req.query : {};
    let params;

    if (q.bdMgtSn) {
      params = parseBdMgtSn(q.bdMgtSn.toString());
      if (!params) {
        return res.status(200).json({
          ok: false,
          error: 'bdMgtSn 형식 오류 (25자리 필요)',
          source: 'error',
          fetchedAt: new Date().toISOString(),
        });
      }
    } else if (q.sigunguCd && q.bjdongCd) {
      params = {
        sigunguCd: q.sigunguCd.toString(),
        bjdongCd:  q.bjdongCd.toString(),
        platGbCd:  (q.platGbCd || '0').toString(),
        bun:       (q.bun || '0').toString(),
        ji:        (q.ji  || '0').toString(),
      };
    } else {
      return res.status(200).json({
        ok: false,
        error: 'bdMgtSn 또는 (sigunguCd + bjdongCd + bun) 필요',
        source: 'error',
        fetchedAt: new Date().toISOString(),
      });
    }

    const key = process.env.DATA_GO_KR_KEY_BLDG;
    let usedSource = 'mock';
    let building = null;
    const warnings = [];

    if (key) {
      try {
        const result = await fetchBuildingData(key, params);
        if (result.items.length) {
          building = normalizeBuilding(result.items[0]);
          usedSource = 'publicData';
          if (result.items.length > 1) {
            building.relatedBuildings = result.items.slice(1).map(normalizeBuilding);
          }
        } else {
          warnings.push('해당 주소 건축물대장 정보 없음 — 미등록 신축 또는 주소 오류 가능성');
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
      warnings.push('DATA_GO_KR_KEY_BLDG 환경변수 미설정');
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
    console.error('building.js 최상위 에러:', e);
    return res.status(200).json({
      ok: false,
      error: (e && e.message) || '알 수 없는 서버 오류',
      stack: (e && e.stack) ? e.stack.split('\n').slice(0, 3).join(' | ') : null,
      source: 'error',
      fetchedAt: new Date().toISOString(),
    });
  }
}
