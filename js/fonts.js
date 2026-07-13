// 字型註冊表 —— 所有可用字型集中管理。
// 預覽與下載都走同一條 canvas 繪製路徑，並在繪製前確保字型已載入，
// 因此「預覽字型 = 下載字型」，不會再發生下載後字型跑掉的問題。

export const FONTS = [
  { family: 'Noto Sans TC',  label: '思源黑體 (中文)',   weights: [400, 700, 900], latin: false },
  { family: 'Noto Serif TC', label: '思源宋體 (中文)',   weights: [400, 700, 900], latin: false },
  { family: 'Anton',         label: 'Anton (粗體英數)',  weights: [400],           latin: true  },
  { family: 'Bebas Neue',    label: 'Bebas Neue (英數)', weights: [400],           latin: true  },
  { family: 'Oswald',        label: 'Oswald (英數)',     weights: [400, 700],      latin: true  },
  { family: 'Teko',          label: 'Teko (電競英數)',   weights: [400, 700],      latin: true  },
  { family: 'Rajdhani',      label: 'Rajdhani (科技感)', weights: [500, 700],      latin: true  },
  // 使用者上傳的字型（僅英數，中文會自動退回思源黑體）
  { family: 'Foundry Gridnik', label: 'Foundry Gridnik（英數）', weights: [800],  latin: true },
  { family: 'Minecraft Ten',   label: 'Minecraft Ten（英數）',   weights: [400, 700, 900],  latin: true },
  { family: 'Minecraft',       label: 'Minecraft Regular（英數）', weights: [400, 700],     latin: true },
];

// CSS font stack —— 中文字型後面都補上思源黑體，避免缺字時掉成系統字型造成偏差。
export function fontStack(family) {
  const f = FONTS.find((x) => x.family === family) || FONTS[0];
  if (f.latin) return `"${family}", "Noto Sans TC", sans-serif`;
  return `"${family}", sans-serif`;
}

// 產生 canvas / CSS 共用的 font 字串。
// 元素用的欄位是 `font`（不是 family），這裡兩者都接受。
export function fontString({ weight = 700, size = 48, font, family } = {}) {
  return `${weight} ${Math.round(size)}px ${fontStack(font || family || 'Noto Sans TC')}`;
}

// 確保某個 (family, weight) 已被瀏覽器載入，才進行繪製。
const loaded = new Set();
export async function ensureFont(family, weight = 700, size = 48) {
  const key = `${family}:${weight}`;
  if (loaded.has(key)) return;
  try {
    // 需要帶入實際文字（含中文）才能確保中文子集被載入。
    await document.fonts.load(`${weight} ${size}px "${family}"`, '字あAgW0');
    await document.fonts.ready;
    loaded.add(key);
  } catch (_) {
    /* 字型載入失敗時，退回系統字型即可，不中斷流程 */
  }
}

// 一次確保整份設計會用到的所有字型都載入。
export async function ensureDocFonts(doc) {
  const jobs = [];
  for (const el of doc.elements || []) {
    if (el.type === 'text') jobs.push(ensureFont(el.font, el.weight, el.size));
  }
  await Promise.all(jobs);
}
