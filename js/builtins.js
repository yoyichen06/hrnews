// 模板結構定義 + 內建模板
// -----------------------------------------------------------------------------
// 每個「元素 element」的座標 x,y 都是「元素中心點」，
// 這讓「以物件中心放大縮小」變得非常自然（縮放時中心不動）。
//
// 元素型別：
//   text  文字：可獨立編輯內容、字型、大小、顏色、對齊、位置。
//   image 圖片框：可上傳/替換圖片，可移動、可從中心縮放。
//   shape 形狀：矩形/圓角矩形，常用來當文字底色遮罩，增加照片上的可讀性。
// -----------------------------------------------------------------------------

import { uid, deepClone } from './util.js';
import { VAL_FRAME, MC_FRAME } from './frames.js';

// ---- 元素工廠（帶預設值，建立模板時只需覆寫需要的欄位）----
function T(o = {}) {
  return {
    id: o.id || uid('el'),
    type: 'text',
    label: o.label || '文字',
    editable: o.editable !== false, // 是否出現在「快速填寫」表單
    locked: !!o.locked, // 鎖定後不可在畫布上被選取移動
    fixed: !!o.fixed, // 固定元素（外框/LOGO/HR NEWS）：預設鎖定、不進表單，可解鎖後編輯
    text: o.text ?? '文字',
    x: o.x ?? 540,
    y: o.y ?? 540,
    boxWidth: o.boxWidth ?? 900, // 自動換行寬度
    align: o.align || 'center', // left / center / right
    font: o.font || 'Noto Sans TC',
    weight: o.weight ?? 700,
    size: o.size ?? 48,
    color: o.color || '#ffffff',
    lineHeight: o.lineHeight ?? 1.2,
    letterSpacing: o.letterSpacing ?? 0,
    uppercase: !!o.uppercase,
    stroke: o.stroke || null, // { color, width }
    opacity: o.opacity ?? 1,
  };
}

function I(o = {}) {
  return {
    id: o.id || uid('el'),
    type: 'image',
    label: o.label || '圖片',
    editable: o.editable !== false,
    locked: !!o.locked,
    fixed: !!o.fixed,
    replaceable: o.replaceable !== false,
    isBackground: !!o.isBackground,
    role: o.role || (o.isBackground ? 'background' : ''), // background / overlay / frame
    src: o.src || null,
    x: o.x ?? 540,
    y: o.y ?? 540,
    w: o.w ?? 400,
    h: o.h ?? 400,
    fit: o.fit || 'contain', // contain / cover
    radius: o.radius ?? 0,
    opacity: o.opacity ?? 1,
    blendMode: o.blendMode || 'source-over', // 混合模式（canvas globalCompositeOperation）
    hint: o.hint || '',
  };
}

function S(o = {}) {
  return {
    id: o.id || uid('el'),
    type: 'shape',
    label: o.label || '形狀',
    editable: o.editable === true, // 形狀預設不進填寫表單
    locked: !!o.locked,
    fixed: !!o.fixed,
    x: o.x ?? 540,
    y: o.y ?? 540,
    w: o.w ?? 600,
    h: o.h ?? 200,
    radius: o.radius ?? 24,
    fill: o.fill || '#000000',
    noFill: !!o.noFill, // 只描邊、不填色（做外框用）
    opacity: o.opacity ?? 0.45,
    stroke: o.stroke || null, // { color, width }
  };
}

// 漸層遮罩（貼在上緣或下緣，可獨立調整高度與強度）
function G(o = {}) {
  return {
    id: o.id || uid('el'),
    type: 'gradient',
    label: o.label || '漸層遮罩',
    editable: o.editable === true,
    locked: o.locked !== false, // 預設鎖定，用面板調整、不擋點選
    fixed: !!o.fixed,
    edge: o.edge || 'bottom', // top / bottom
    color: o.color || '#000000',
    size: o.size ?? 0.4, // 佔畫面高度的比例 0~1
    opacity: o.opacity ?? 0.85, // 邊緣最濃處的不透明度
  };
}

// 尺寸／比例預設
export const SIZE_PRESETS = [
  { label: '正方形 1:1', w: 1080, h: 1080 },
  { label: '直式 4:5', w: 1080, h: 1350 },
  { label: '限動 9:16', w: 1080, h: 1920 },
  { label: '橫式 16:9', w: 1920, h: 1080 },
  { label: '橫式 4:3', w: 1440, h: 1080 },
  { label: '直式 3:4', w: 1080, h: 1440 },
];

// 混合模式（label -> canvas globalCompositeOperation）
export const BLEND_MODES = [
  { v: 'source-over', label: 'Normal 一般' },
  { v: 'multiply', label: 'Multiply 正片疊底' },
  { v: 'screen', label: 'Screen 加亮' },
  { v: 'overlay', label: 'Overlay 疊加' },
  { v: 'soft-light', label: 'Soft Light 柔光' },
  { v: 'hard-light', label: 'Hard Light 實光' },
  { v: 'color-dodge', label: 'Color Dodge 加亮顏色' },
  { v: 'color-burn', label: 'Color Burn 加深顏色' },
  { v: 'difference', label: 'Difference 差異化' },
  { v: 'luminosity', label: 'Luminosity 明度' },
];

// ---- 內建模板 ----
export const BUILTIN_TEMPLATES = [
  {
    id: 'valorant-news-hr',
    name: '特戰英豪新聞（HR NEWS 版）',
    category: '特戰英豪',
    builtin: true,
    width: 1080,
    height: 1350,
    bgColor: '#0b0d12',
    elements: [
      // 背景照片：放在中央視窗（外框上下的銀色橫條會蓋住邊緣）
      I({ id: 'bg', role: 'background', isBackground: true, label: '背景圖片', x: 540, y: 675, w: 1080, h: 1350,
          fit: 'cover', hint: '上傳主視覺照片（會放在中央視窗）' }),
      // 疊加圖層 Overlay（材質／光暈，預設加亮）
      I({ id: 'overlay', role: 'overlay', label: '疊加圖層 Overlay', x: 540, y: 675, w: 1080, h: 1350,
          fit: 'cover', blendMode: 'screen', opacity: 0.6, hint: '疊加材質／光暈圖層（顆粒、霓虹、漸層等）' }),
      // 固定版型：你的 SVG（外框＋兔子 LOGO＋VAL NEWS＋FOLLOW US＋H&R）
      I({ id: 'frame', role: 'frame', label: 'HR 外框 / LOGO（固定）', fixed: true, replaceable: false,
          x: 540, y: 675, w: 1080, h: 1350, fit: 'contain', src: VAL_FRAME }),
      // 分類標籤（可改文字與顏色）：膠囊底色 + 文字
      S({ id: 'catBox', label: '分類標籤底色', editable: true, x: 540, y: 224, w: 180, h: 46, radius: 23,
          fill: '#ff1438', opacity: 1 }),
      T({ id: 'catText', label: '分類標籤文字', text: 'VAL NEWS', x: 540, y: 224, boxWidth: 260,
          font: 'Oswald', weight: 700, size: 24, color: '#ffffff', letterSpacing: 4, uppercase: true }),
      // 主標題上方小圖 / LOGO（例如隊伍、遊戲小標，可上傳/替換）
      I({ id: 'titleIcon', label: '主標題上方小圖 / LOGO', x: 540, y: 935, w: 120, h: 120,
          fit: 'contain', hint: '主標題上方的小圖或 LOGO（去背 PNG / SVG，可留空）' }),
      // 名稱標籤（像 TenZ 那個紅框白底標籤）
      S({ id: 'nameBox', label: '名稱標籤底框', x: 540, y: 1044, w: 300, h: 84, radius: 6,
          fill: '#ffffff', opacity: 1, stroke: { color: '#e4002b', width: 6 } }),
      T({ id: 'nameText', label: '名稱標籤文字', text: 'TenZ', x: 540, y: 1044, boxWidth: 300,
          font: 'Oswald', weight: 700, size: 52, color: '#e4002b', uppercase: false }),
      // 主標題（坐落在下方銀色橫條上）
      T({ id: 'title', label: '主標題', text: '在這裡輸入主標題', x: 540, y: 1188, boxWidth: 960,
          font: 'Noto Sans TC', weight: 900, size: 88, color: '#ffffff', lineHeight: 1.05,
          stroke: { color: '#000000', width: 6 } }),
    ],
  },
  {
    id: 'valorant-news',
    name: '特戰英豪・快訊',
    category: '特戰英豪',
    builtin: true,
    width: 1080,
    height: 1080,
    bgColor: '#0f1923',
    elements: [
      T({ id: 'tag', label: '頂部標籤', text: 'VALORANT UPDATE', x: 540, y: 150,
          font: 'Teko', weight: 700, size: 46, color: '#ff4655', letterSpacing: 8, uppercase: true }),
      I({ id: 'logo', label: 'VALORANT LOGO', x: 540, y: 380, w: 460, h: 180,
          fit: 'contain', hint: '上傳你的 VALORANT / 遊戲 LOGO（去背 PNG 最佳）' }),
      T({ id: 'title', label: '主標題', text: '更新標題', x: 540, y: 640,
          boxWidth: 980, font: 'Noto Sans TC', weight: 900, size: 100, color: '#ffffff' }),
      S({ id: 'rule', label: '標題下底線', x: 540, y: 726, w: 120, h: 8, radius: 4,
          fill: '#ff4655', opacity: 1 }),
      T({ id: 'subtitle', label: '副標題', text: '在這裡輸入補充說明文字', x: 540, y: 812,
          boxWidth: 900, font: 'Noto Sans TC', weight: 500, size: 42, color: '#c9d1d9' }),
      T({ id: 'date', label: '日期／出處', text: '2026.07.08', x: 540, y: 980,
          font: 'Teko', weight: 700, size: 44, color: '#7a8899', letterSpacing: 4 }),
    ],
  },
  {
    id: 'game-collab',
    name: '遊戲新聞・聯動',
    category: '遊戲新聞',
    builtin: true,
    width: 1080,
    height: 1080,
    bgColor: '#12121a',
    elements: [
      T({ id: 'title', label: '主標題', text: '遊戲新聞', x: 540, y: 190,
          font: 'Noto Sans TC', weight: 900, size: 92, color: '#ffffff' }),
      T({ id: 'kicker', label: '英文小標', text: 'GAME NEWS / COLLAB', x: 540, y: 288,
          font: 'Oswald', weight: 700, size: 36, color: '#ffb020', letterSpacing: 6, uppercase: true }),
      I({ id: 'logoL', label: '左方 LOGO', x: 355, y: 560, w: 320, h: 320, fit: 'contain',
          hint: '上傳左邊那一方的 LOGO' }),
      // 「×」代表「誰 與 誰」聯動，內容固定不進表單，但仍可自由移動/縮放。
      T({ id: 'xmark', label: '聯動符號 ×（固定）', text: '×', editable: false, x: 540, y: 560,
          font: 'Oswald', weight: 700, size: 110, color: '#ffffff', boxWidth: 200 }),
      I({ id: 'logoR', label: '右方 LOGO', x: 725, y: 560, w: 320, h: 320, fit: 'contain',
          hint: '上傳右邊那一方的 LOGO' }),
      T({ id: 'body', label: '內容說明', text: '在這裡輸入聯動的內容說明。', x: 540, y: 850,
          boxWidth: 920, font: 'Noto Sans TC', weight: 500, size: 42, color: '#d0d0d8', lineHeight: 1.3 }),
    ],
  },
  {
    id: 'minecraft-update',
    name: 'Minecraft 新聞（HR NEWS 版）',
    category: 'Minecraft',
    builtin: true,
    width: 1080,
    height: 1350,
    bgColor: '#0b0d12',
    elements: [
      // 背景照片：全出血（外框只有細邊＋LOGO 浮在照片上）
      I({ id: 'bg', role: 'background', isBackground: true, label: '背景圖片', x: 540, y: 675, w: 1080, h: 1350,
          fit: 'cover', hint: '上傳 Minecraft 截圖，會鋪滿整張' }),
      I({ id: 'overlay', role: 'overlay', label: '疊加圖層 Overlay', x: 540, y: 675, w: 1080, h: 1350,
          fit: 'cover', blendMode: 'screen', opacity: 0.5, hint: '疊加材質／光暈（可留空）' }),
      // 下漸層遮罩：讓底部標題在照片上看得清楚
      G({ id: 'gradBottom', edge: 'bottom', label: '下漸層遮罩', color: '#000000', size: 0.42, opacity: 0.85 }),
      // 固定版型：你的 MC SVG（細外框＋兔子 LOGO＋FOLLOW US＋H&R）
      I({ id: 'frame', role: 'frame', label: 'HR 外框 / LOGO（固定）', fixed: true, replaceable: false,
          x: 540, y: 675, w: 1080, h: 1350, fit: 'contain', src: MC_FRAME }),
      // 分類標籤（可改文字與顏色）：膠囊底色 + 文字
      S({ id: 'catBox', label: '分類標籤底色', editable: true, x: 540, y: 241, w: 232, h: 50, radius: 8,
          fill: '#cccccc', opacity: 1 }),
      T({ id: 'catText', label: '分類標籤文字', text: 'MINECRAFT NEWS', x: 540, y: 241, boxWidth: 320,
          font: 'Minecraft Ten', weight: 400, size: 20, color: '#1a1a1a', letterSpacing: 1 }),
      // 主標題上方遊戲 LOGO（例如 MINECRAFT 字標，可上傳/替換）
      I({ id: 'titleIcon', label: '遊戲 LOGO（主標題上方）', x: 540, y: 940, w: 420, h: 120,
          fit: 'contain', hint: '上傳 MINECRAFT 或其他遊戲字標（去背 PNG，可留空）' }),
      // 版本／資訊標籤（深色膠囊，像「26.3 snapshot-3」）
      S({ id: 'verBox', label: '版本標籤底框', x: 540, y: 1052, w: 340, h: 74, radius: 37,
          fill: '#111418', opacity: 0.82 }),
      T({ id: 'verText', label: '版本標籤文字', text: '26.3 SNAPSHOT-3', x: 540, y: 1052, boxWidth: 340,
          font: 'Minecraft Ten', weight: 400, size: 34, color: '#ffffff', letterSpacing: 1 }),
      // 主標題（白字、置底、加深黑邊）
      T({ id: 'title', label: '主標題', text: '在這裡輸入主標題', x: 540, y: 1172, boxWidth: 960,
          font: 'Noto Sans TC', weight: 900, size: 92, color: '#ffffff', lineHeight: 1.05,
          stroke: { color: '#000000', width: 5 } }),
    ],
  },
  {
    id: 'ability-update',
    name: '技能更新（英雄調整）',
    category: '技能更新',
    builtin: true,
    width: 1080,
    height: 1080,
    bgColor: '#0f1923',
    elements: [
      T({ id: 'tag', label: '調整標籤（NERF／BUFF）', text: 'NERF', x: 270, y: 200,
          font: 'Oswald', weight: 700, size: 60, color: '#ff4655', letterSpacing: 4, uppercase: true }),
      I({ id: 'hero', label: '英雄 LOGO（例：CLOVE）', x: 275, y: 590, w: 400, h: 400, fit: 'contain',
          hint: '上傳英雄／技能圖示（可移動、可從中心縮放、可替換）' }),
      T({ id: 'skillName', label: '技能名稱', text: '技能名稱', x: 760, y: 430, boxWidth: 560,
          align: 'left', font: 'Noto Sans TC', weight: 900, size: 66, color: '#ffffff' }),
      T({ id: 'skillDesc', label: '技能說明', text: '技能說明文字，可以自由換行、獨立移動位置，改這裡不會動到技能名稱。',
          x: 760, y: 650, boxWidth: 560, align: 'left', font: 'Noto Sans TC', weight: 500,
          size: 40, color: '#c9d1d9', lineHeight: 1.4 }),
      T({ id: 'footer', label: '版本標註', text: '特戰英豪 版本更新', x: 540, y: 990,
          font: 'Teko', weight: 700, size: 42, color: '#7a8899', letterSpacing: 4 }),
    ],
  },
];

// 依「模板定義」建立一份可編輯的工作副本（instance），避免污染原始模板。
export function instantiate(template) {
  const doc = deepClone(template);
  doc.templateId = template.id;
  delete doc.builtin;
  return doc;
}

// 建立一張空白模板（給「自製模板」用）。
export function newBlankTemplate({ name = '我的模板', category = '自訂', width = 1080, height = 1080, bgColor = '#111318' } = {}) {
  return { id: uid('tpl'), name, category, width, height, bgColor, elements: [], custom: true };
}

// 對外也導出元素工廠，讓「自製模板」時能新增元素。
export const makeText = T;
export const makeImage = I;
export const makeShape = S;
export const makeGradient = G;
