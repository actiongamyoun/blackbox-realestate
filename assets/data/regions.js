/**
 * 부동산 블랙박스 — 지역 데이터
 * 시/도 → 구/시 → 동 트리구조
 *
 * 현재 범위: 부산광역시 해운대구
 * 차후 확장: 부산 타 구 → 광역시 → 전국
 *
 * 데이터 구조:
 *   BB_REGIONS = {
 *     "시/도명": {
 *       "구/시명": ["동명1", "동명2", ...]
 *     }
 *   }
 *
 * 사용 예:
 *   const sidos = Object.keys(window.BB_REGIONS);              // ["부산광역시", ...]
 *   const gus   = Object.keys(window.BB_REGIONS["부산광역시"]); // ["해운대구", ...]
 *   const dongs = window.BB_REGIONS["부산광역시"]["해운대구"];   // ["우동", "좌동", ...]
 */

window.BB_REGIONS = {
  "부산광역시": {
    "해운대구": [
      "우동",
      "중동",
      "좌동",
      "송정동",
      "반여동",
      "반송동",
      "재송동",
      "석대동"
    ]
    // 차후 추가:
    // "수영구": [...],
    // "남구":   [...],
    // ...
  }
  // 차후 추가:
  // "서울특별시": { ... },
  // "경기도":     { ... },
};

/**
 * 지역 헬퍼 함수들
 */
window.BB_REGION_HELPERS = {

  /** 시/도 목록 */
  getSidos() {
    return Object.keys(window.BB_REGIONS);
  },

  /** 특정 시/도의 구/시 목록 */
  getGus(sido) {
    if (!sido || !window.BB_REGIONS[sido]) return [];
    return Object.keys(window.BB_REGIONS[sido]);
  },

  /** 특정 시/도의 특정 구/시의 동 목록 */
  getDongs(sido, gu) {
    if (!sido || !gu) return [];
    const sidoData = window.BB_REGIONS[sido];
    if (!sidoData || !sidoData[gu]) return [];
    return sidoData[gu];
  },

  /**
   * 지역 칩 한 개를 표현하는 객체
   *   { sido, gu, dong } — dong은 옵셔널
   * 표시용 짧은 이름 반환
   */
  formatChip(chip) {
    if (!chip) return '';
    if (chip.dong) return chip.gu + ' ' + chip.dong;
    if (chip.gu)   return chip.gu;
    return chip.sido || '';
  },

  /**
   * 두 지역 칩이 같은지 비교
   */
  chipEquals(a, b) {
    if (!a || !b) return false;
    return a.sido === b.sido && a.gu === b.gu && a.dong === b.dong;
  },

  /**
   * 매물 주소가 고객의 희망 지역 칩 목록에 매칭되는지
   * 주소 문자열에 칩의 시/도, 구, 동이 포함되면 매치
   *
   * @param {string} address - 매물 도로명 주소
   * @param {Array}  chips   - [{sido, gu, dong}, ...]
   * @returns {boolean}
   */
  addressMatchesChips(address, chips) {
    if (!chips || !chips.length) return true;   // 지역 미지정 = 무관
    if (!address) return false;
    const addr = String(address);
    return chips.some(chip => {
      // 동까지 지정된 경우 — 동 일치 필수
      if (chip.dong) {
        return addr.includes(chip.dong) || (
          // "송정동" 등 정확 매칭이 어려운 경우 구+동 부분일치
          addr.includes(chip.gu || '') && addr.includes(chip.dong.replace(/동$/, ''))
        );
      }
      // 구까지만 지정 — 구 일치
      if (chip.gu) {
        return addr.includes(chip.gu);
      }
      // 시/도까지만 지정
      if (chip.sido) {
        // "부산광역시" 또는 짧게 "부산"으로도 적힐 수 있음
        const shortSido = chip.sido.replace(/(특별시|광역시|특별자치시|특별자치도|도)$/, '');
        return addr.includes(chip.sido) || addr.includes(shortSido);
      }
      return false;
    });
  }

};
