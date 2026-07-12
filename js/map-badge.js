// 地圖輪替菱形徽章 —— 改用乾淨的向量 SVG 重畫（原本從 .ai 轉出的點陣圖有雜線／殘留的橫線）。
// 只有圖案本身（白色菱形＋綠 IN／紅 OUT／中間 Map Rotation 白條）。
// 橫線與地圖名稱是另外分開的可編輯元素，因此圖案本身「不含」任何橫線，避免變成兩條。
// SVG 可無限縮放、不含任何多餘線條。用 encodeURIComponent 產生 data URI（可安全帶 UTF-8）。

const SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 360">',
  '<defs><clipPath id="mrDiamond"><polygon points="180,58 302,180 180,302 58,180"/></clipPath></defs>',
  // 外層白色菱形（圓角）
  '<polygon points="180,26 334,180 180,334 26,180" fill="#ffffff" stroke="#ffffff" stroke-width="20" stroke-linejoin="round"/>',
  // 內部：上綠、下紅，中間一條白帶
  '<g clip-path="url(#mrDiamond)">',
  '<rect x="0" y="0" width="360" height="180" fill="#12b886"/>',
  '<rect x="0" y="180" width="360" height="180" fill="#ff4655"/>',
  '<rect x="0" y="158" width="360" height="44" fill="#ffffff"/>',
  '</g>',
  // 固定文字（圖案的一部分，不需編輯）
  '<g font-family="Arial, Helvetica, sans-serif" text-anchor="middle">',
  '<text x="180" y="120" font-size="34" font-weight="800" letter-spacing="3" fill="#ffffff">IN</text>',
  '<text x="180" y="262" font-size="34" font-weight="800" letter-spacing="3" fill="#ffffff">OUT</text>',
  '<text x="180" y="188" font-size="22" font-weight="700" letter-spacing="0.5" fill="#1a1a1a">Map Rotation</text>',
  '</g>',
  '</svg>',
].join('');

export const MAP_BADGE = 'data:image/svg+xml;utf8,' + encodeURIComponent(SVG);
