// api/address.js
// 도로명주소 검색 API (business.juso.go.kr)
// Vercel Serverless Function

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { query } = req.query;
  if (!query) {
    return res.status(400).json({ error: '주소를 입력해주세요.' });
  }

  const apiKey = process.env.JUSO_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API 키가 설정되지 않았습니다.' });
  }

  try {
    const url = new URL('https://business.juso.go.kr/addrlink/addrLinkApi.do');
    url.searchParams.set('confmKey', apiKey);
    url.searchParams.set('currentPage', '1');
    url.searchParams.set('countPerPage', '5');
    url.searchParams.set('keyword', query);
    url.searchParams.set('resultType', 'json');

    const response = await fetch(url.toString());
    const data = await response.json();

    const results = data?.results?.juso || [];

    // 필요한 필드만 추출해서 반환
    const cleaned = results.map(j => ({
      roadAddr:    j.roadAddr,       // 도로명 주소
      jibunAddr:   j.jibunAddr,      // 지번 주소
      zipNo:       j.zipNo,          // 우편번호
      admCd:       j.admCd,          // 행정구역코드
      rnMgtSn:     j.rnMgtSn,        // 도로명관리번호
      bdMgtSn:     j.bdMgtSn,        // 건물관리번호 (등기소 조회에 필요)
      siNm:        j.siNm,           // 시도명
      sggNm:       j.sggNm,          // 시군구명
      emdNm:       j.emdNm,          // 읍면동명
      liNm:        j.liNm,           // 리명
      bdNm:        j.bdNm,           // 건물명
      buildMnnm:   j.buildMnnm,      // 건물본번
      buildSlno:   j.buildSlno,      // 건물부번
    }));

    return res.status(200).json({
      ok: true,
      count: cleaned.length,
      results: cleaned,
    });

  } catch (err) {
    console.error('주소 API 오류:', err);
    return res.status(500).json({ error: '주소 검색 중 오류가 발생했습니다.' });
  }
}
