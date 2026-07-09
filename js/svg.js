// 匯入 Illustrator 匯出的 SVG，變成一張可編輯模板。
// 作法：SVG 當成「固定版型（外框/LOGO/HR NEWS 都在裡面）」放在最上層，
// 底下自動放好背景照片框、上下漸層遮罩，最上面放一個主標題，馬上就能套用。
//
// 小提醒：在 Illustrator 匯出前，把文字「建立外框」(Create Outlines)，
// 這樣字型一定不會跑掉；需要換字的地方就用這裡的文字元素來擺。

import { uid } from './util.js';
import { makeImage, makeGradient, makeText } from './builtins.js';

function parseSize(text) {
  let w = 0, h = 0;
  try {
    const svg = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
    w = parseFloat(svg.getAttribute('width')) || 0;
    h = parseFloat(svg.getAttribute('height')) || 0;
    const vb = svg.getAttribute('viewBox');
    if ((!w || !h) && vb) {
      const p = vb.split(/[\s,]+/).map(Number);
      w = w || p[2]; h = h || p[3];
    }
  } catch (_) { /* ignore */ }
  if (!w || !h) { w = 1080; h = 1080; }
  // 正規化到合理的畫布像素（最長邊約 1350），維持比例。
  const maxSide = Math.max(w, h);
  const k = maxSide > 1600 || maxSide < 800 ? 1350 / maxSide : 1;
  return { w: Math.round(w * k), h: Math.round(h * k) };
}

// 確保 <svg> 有 width/height，否則某些瀏覽器畫到 canvas 會是 0 尺寸。
function ensureSized(text, w, h) {
  if (/<svg[^>]*\swidth=/.test(text) && /<svg[^>]*\sheight=/.test(text)) return text;
  return text.replace(/<svg/i, `<svg width="${w}" height="${h}"`);
}

const toDataURL = (text) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);

export async function importSVGFile(file) {
  const text = await file.text();
  const { w, h } = parseSize(text);
  const src = toDataURL(ensureSized(text, w, h));
  const name = (file.name || 'SVG 模板').replace(/\.svg$/i, '') || 'SVG 模板';
  return {
    id: uid('tpl'),
    name,
    category: 'SVG 匯入',
    custom: true,
    width: w,
    height: h,
    bgColor: '#0b0d12',
    elements: [
      makeImage({ id: 'photo', role: 'background', isBackground: true, label: '背景圖片',
        x: w / 2, y: h / 2, w, h, fit: 'cover', hint: '上傳主視覺照片，會鋪滿版面' }),
      makeGradient({ id: 'gTop', edge: 'top', label: '上漸層遮罩', color: '#000000', size: 0.25, opacity: 0.85 }),
      makeGradient({ id: 'gBot', edge: 'bottom', label: '下漸層遮罩', color: '#000000', size: 0.45, opacity: 0.9 }),
      makeImage({ id: 'svgFrame', role: 'frame', label: 'SVG 版型（固定）', fixed: true,
        x: w / 2, y: h / 2, w, h, fit: 'contain', src, replaceable: false }),
      makeText({ id: 'title', label: '主標題', text: '在這裡輸入主標題',
        x: w / 2, y: Math.round(h * 0.82), boxWidth: Math.round(w * 0.9),
        font: 'Noto Sans TC', weight: 900, size: Math.round(h * 0.06), color: '#ffffff', lineHeight: 1.1 }),
      makeText({ id: 'subtitle', label: '副標題', text: '副標題補充說明',
        x: w / 2, y: Math.round(h * 0.9), boxWidth: Math.round(w * 0.85),
        font: 'Noto Sans TC', weight: 500, size: Math.round(h * 0.03), color: '#c9d1d9' }),
    ],
  };
}
