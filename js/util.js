// 共用小工具

export const uid = (p = 'id') => `${p}_${Math.random().toString(36).slice(2, 9)}`;

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const deepClone = (o) =>
  typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o));

// 讀取使用者選的圖片 -> 回傳 { src(dataURL), w, h }
export function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve({ src: reader.result, w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// 圖片快取：同一個 src 只解碼一次，繪製才會順。
const imgCache = new Map();
export function loadImage(src) {
  if (!src) return Promise.resolve(null);
  if (imgCache.has(src)) {
    const c = imgCache.get(src);
    return c.complete ? Promise.resolve(c) : new Promise((r) => (c.onload = () => r(c)));
  }
  const img = new Image();
  img.crossOrigin = 'anonymous';
  const p = new Promise((resolve) => {
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
  });
  img.src = src;
  imgCache.set(src, img);
  return p;
}

// 同步取出已載入完成的圖片（給 canvas 繪製用）。preload 會先確保載入完成。
export function peekImage(src) {
  const img = imgCache.get(src);
  return img && img.complete && img.naturalWidth ? img : null;
}

// 觸發下載。data: URL 先轉成 Blob，檔名才會可靠（Chromium 對大型 data URL 會忽略檔名）。
export async function downloadDataURL(dataURL, filename) {
  let href = dataURL;
  let revoke = false;
  if (dataURL.startsWith('data:')) {
    const blob = await (await fetch(dataURL)).blob();
    href = URL.createObjectURL(blob);
    revoke = true;
  }
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (revoke) setTimeout(() => URL.revokeObjectURL(href), 1500);
}

export function downloadText(text, filename, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  downloadDataURL(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
