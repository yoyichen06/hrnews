// Canvas 編輯引擎
// -----------------------------------------------------------------------------
// 設計重點（對應到你回報的問題）：
//  * 預覽與下載都用同一段繪製程式 → 字型/版面 100% 一致，下載不會跑掉。
//  * 座標以「元素中心」為準 → 縮放時中心不動，達成「以物件中心點放大」。
//  * 每個元素獨立 → 改副標題不會動到主標題、改技能說明不會動到技能名稱。
//  * 空的圖片框只畫在「操作層 overlay」，不會被下載進去（下載乾淨、無亂碼）。
//  * 支援滑鼠與觸控（Pointer Events）→ 手機、電腦都能拖曳、雙指縮放。
// -----------------------------------------------------------------------------

import { fontString, ensureFont, ensureDocFonts } from './fonts.js';
import { loadImage, peekImage, clamp, hexToRgba, uid, deepClone } from './util.js';

const HANDLE = 30; // 縮放控制點大小（doc 座標）
const HIT_PAD = 34; // 控制點觸控容錯

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 把文字切成 token：CJK 字元各自一個 token、拉丁字/數字連在一起、空白保留。
function tokenize(s) {
  const out = [];
  const re = /[　-鿿豈-﫿＀-￯]|[A-Za-z0-9]+(?:[.\-_/][A-Za-z0-9]+)*|\s+|[^\s]/g;
  let m;
  while ((m = re.exec(s))) out.push(m[0]);
  return out;
}

// 依 shadow 設定套用 canvas 陰影（angle 角度、distance 距離、blur 模糊、color/opacity）。
function applyShadow(ctx, sh, f) {
  if (!sh || !sh.on) return false;
  const rad = ((sh.angle ?? 135) * Math.PI) / 180;
  ctx.shadowColor = hexToRgba(sh.color || '#000000', sh.opacity ?? 0.5);
  ctx.shadowBlur = (sh.blur ?? 8) * f;
  ctx.shadowOffsetX = Math.cos(rad) * (sh.distance ?? 8) * f;
  ctx.shadowOffsetY = Math.sin(rad) * (sh.distance ?? 8) * f;
  return true;
}
function clearShadow(ctx) {
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}
// 把點 (px,py) 繞 (cx,cy) 旋轉 deg 度
function rotatePt(px, py, cx, cy, deg) {
  if (!deg) return [px, py];
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r), dx = px - cx, dy = py - cy;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
}

export class Editor {
  constructor(board, overlay) {
    this.board = board;
    this.overlay = overlay;
    this.ctx = board.getContext('2d');
    this.octx = overlay.getContext('2d');
    this.doc = null;
    this.selectedId = null;
    this.unlockFixed = false; // 是否解鎖固定元素（外框/LOGO/HR NEWS）
    this.onSelect = () => {};
    this.onChange = () => {};
    this.drag = null;
    this.pointers = new Map();
    this.pinch = null;
    this._bindPointer();
  }

  async setDoc(doc) {
    this.doc = doc;
    this.selectedId = null;
    this.unlockFixed = false;
    for (const c of [this.board, this.overlay]) {
      c.width = doc.width;
      c.height = doc.height;
      c.style.aspectRatio = `${doc.width} / ${doc.height}`;
    }
    await this.preload();
    this.render();
    this.onSelect(null);
  }

  async preload() {
    await ensureDocFonts(this.doc);
    await Promise.all((this.doc.elements || []).filter((e) => e.type === 'image' && e.src).map((e) => loadImage(e.src)));
  }

  el(id) {
    return (this.doc.elements || []).find((e) => e.id === id) || null;
  }
  get selected() {
    return this.el(this.selectedId);
  }

  // ---------- 繪製（factor 讓匯出可用更高解析度）----------
  drawScene(ctx, factor) {
    const d = this.doc;
    ctx.save();
    ctx.fillStyle = d.bgColor || '#111318';
    ctx.fillRect(0, 0, d.width * factor, d.height * factor);
    for (const el of d.elements || []) {
      if (el.hidden) continue; // 隱藏的元素不畫、不下載
      const rotDeg = el.type !== 'gradient' ? (el.rotation || 0) : 0;
      if (rotDeg) {
        const c = this.center(el);
        ctx.save();
        ctx.translate(c.cx * factor, c.cy * factor);
        ctx.rotate((rotDeg * Math.PI) / 180);
        ctx.translate(-c.cx * factor, -c.cy * factor);
      }
      if (el.type === 'text') this.drawText(ctx, el, factor);
      else if (el.type === 'image') this.drawImage(ctx, el, factor);
      else if (el.type === 'shape') this.drawShape(ctx, el, factor);
      else if (el.type === 'gradient') this.drawGradient(ctx, el, factor);
      if (rotDeg) ctx.restore();
    }
    ctx.restore();
  }

  // 元素的旋轉中心
  center(el) {
    if (el.type === 'text') { const b = this.bounds(el); return { cx: b.cx, cy: b.cy }; }
    return { cx: el.x, cy: el.y };
  }

  layoutText(el) {
    // 回傳每行字串與量測資訊（doc 座標，未乘 factor）。
    const ctx = this.ctx;
    ctx.font = fontString(el);
    const ls = el.letterSpacing || 0;
    const measure = (str) => {
      let w = 0;
      for (const ch of str) w += ctx.measureText(ch).width + ls;
      return w - (str.length ? ls : 0);
    };
    const raw = el.uppercase ? String(el.text).toUpperCase() : String(el.text);
    const lines = [];
    for (const para of raw.split('\n')) {
      const tokens = tokenize(para);
      let line = '';
      for (const tk of tokens) {
        const trial = line + tk;
        if (line && measure(trial) > el.boxWidth && tk.trim()) {
          lines.push(line);
          line = tk.trimStart();
        } else {
          line = trial;
        }
      }
      lines.push(line);
    }
    const lineStep = el.size * (el.lineHeight || 1.2);
    const widths = lines.map(measure);
    const blockW = Math.max(1, ...widths);
    const blockH = Math.max(el.size, lines.length * lineStep);
    return { lines, widths, blockW, blockH, lineStep, measure, ls };
  }

  drawText(ctx, el, f) {
    const L = this.layoutText(el);
    ctx.save();
    ctx.globalAlpha = el.opacity ?? 1;
    ctx.font = fontString({ ...el, size: el.size * f });
    ctx.textBaseline = 'top';
    const boxLeft = (el.x - el.boxWidth / 2) * f;
    const boxRight = (el.x + el.boxWidth / 2) * f;
    const top = (el.y - L.blockH / 2) * f;
    const ls = L.ls * f;
    const startX = (i) => {
      const lw = L.widths[i] * f;
      if (el.align === 'left') return boxLeft;
      if (el.align === 'right') return boxRight - lw;
      return el.x * f - lw / 2;
    };
    const paint = (doStroke, doFill) => {
      L.lines.forEach((line, i) => {
        let x = startX(i);
        const y = top + i * L.lineStep * f;
        for (const ch of line) {
          if (doStroke) ctx.strokeText(ch, x, y);
          if (doFill) ctx.fillText(ch, x, y);
          x += ctx.measureText(ch).width + ls;
        }
      });
    };
    const hasStroke = el.stroke && el.stroke.width > 0;
    const hollow = el.hollow && hasStroke; // 空心字：只留外框（需要有外框線）
    ctx.fillStyle = el.color;
    if (hasStroke) { ctx.lineJoin = 'round'; ctx.strokeStyle = el.stroke.color; ctx.lineWidth = el.stroke.width * f; }
    // 陰影 pass（實心→填色投影；空心→外框投影）
    if (applyShadow(ctx, el.shadow, f)) { paint(hollow, !hollow); clearShadow(ctx); }
    // 正式 pass
    paint(hasStroke, !hollow);
    ctx.restore();
  }

  drawImage(ctx, el, f) {
    const img = el.src ? peekImage(el.src) : null;
    if (!img) return; // 空圖片框不畫在畫布上（下載乾淨、不會有殘影）
    const bx = (el.x - el.w / 2) * f, by = (el.y - el.h / 2) * f, bw = el.w * f, bh = el.h * f;
    const scale = el.fit === 'cover'
      ? Math.max(bw / img.naturalWidth, bh / img.naturalHeight)
      : Math.min(bw / img.naturalWidth, bh / img.naturalHeight);
    const dw = img.naturalWidth * scale, dh = img.naturalHeight * scale;
    const ix = el.x * f - dw / 2, iy = el.y * f - dh / 2;
    // 陰影：contain（去背圖/LOGO）用圖片本身投影；cover（照片）用框形投影。
    if (el.shadow && el.shadow.on) {
      ctx.save();
      applyShadow(ctx, el.shadow, f);
      if (el.fit === 'cover') { roundRectPath(ctx, bx, by, bw, bh, (el.radius || 0) * f); ctx.fillStyle = '#000'; ctx.fill(); }
      else ctx.drawImage(img, ix, iy, dw, dh);
      ctx.restore();
    }
    ctx.save();
    ctx.globalAlpha = el.opacity ?? 1;
    if (el.blendMode && el.blendMode !== 'source-over') ctx.globalCompositeOperation = el.blendMode;
    if (el.flipH || el.flipV) { // 水平/垂直翻轉（以中心鏡射）
      ctx.translate(el.x * f, el.y * f);
      ctx.scale(el.flipH ? -1 : 1, el.flipV ? -1 : 1);
      ctx.translate(-el.x * f, -el.y * f);
    }
    if (el.fit === 'cover' || el.radius) {
      roundRectPath(ctx, bx, by, bw, bh, (el.radius || 0) * f);
      ctx.clip();
    }
    ctx.drawImage(img, ix, iy, dw, dh);
    ctx.restore();
  }

  drawShape(ctx, el, f) {
    const bx = (el.x - el.w / 2) * f, by = (el.y - el.h / 2) * f, bw = el.w * f, bh = el.h * f;
    ctx.save();
    ctx.globalAlpha = el.opacity ?? 1;
    roundRectPath(ctx, bx, by, bw, bh, (el.radius || 0) * f);
    const hadShadow = applyShadow(ctx, el.shadow, f);
    if (!el.noFill) { ctx.fillStyle = el.fill; ctx.fill(); }
    if (hadShadow) clearShadow(ctx); // 避免描邊再疊一層陰影
    if (el.stroke) {
      ctx.strokeStyle = el.stroke.color;
      ctx.lineWidth = (el.stroke.width || 2) * f;
      ctx.stroke();
    }
    // 四角方塊（裝飾）：線（描邊）與方塊顏色是分開的
    if (el.corners && el.corners.size > 0) {
      const cs = el.corners.size * f;
      ctx.fillStyle = el.corners.color || '#e4002b';
      for (const [cxp, cyp] of [[bx, by], [bx + bw, by], [bx, by + bh], [bx + bw, by + bh]]) {
        ctx.fillRect(cxp - cs / 2, cyp - cs / 2, cs, cs);
      }
    }
    ctx.restore();
  }

  // 漸層遮罩：從上緣或下緣往內淡出。size = 佔畫面高度比例，opacity = 邊緣最濃處。
  drawGradient(ctx, el, f) {
    const W = this.doc.width * f, H = this.doc.height * f;
    const band = clamp(el.size ?? 0.4, 0, 1) * H;
    const strong = hexToRgba(el.color, el.opacity ?? 0.85);
    const clear = hexToRgba(el.color, 0);
    ctx.save();
    let g;
    if (el.edge === 'top') {
      g = ctx.createLinearGradient(0, 0, 0, band);
      g.addColorStop(0, strong); g.addColorStop(1, clear);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, band);
    } else {
      g = ctx.createLinearGradient(0, H - band, 0, H);
      g.addColorStop(0, clear); g.addColorStop(1, strong);
      ctx.fillStyle = g; ctx.fillRect(0, H - band, W, band);
    }
    ctx.restore();
  }

  render() {
    if (!this.doc) return;
    this.drawScene(this.ctx, 1);
    this.renderOverlay();
  }

  renderOverlay() {
    const ctx = this.octx;
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    // 空圖片框：畫虛線提示框（只在操作層，不會被下載）。疊加圖層由面板管理，不畫框避免與背景重疊。
    for (const el of this.doc.elements || []) {
      if (el.type === 'image' && !el.src && el.role !== 'overlay' && !el.hidden) {
        const b = this.bounds(el);
        const deg = el.rotation || 0, c = this.center(el);
        ctx.save();
        if (deg) { ctx.translate(c.cx, c.cy); ctx.rotate((deg * Math.PI) / 180); ctx.translate(-c.cx, -c.cy); }
        ctx.setLineDash([12, 10]);
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,255,255,.45)';
        ctx.strokeRect(b.cx - b.w / 2, b.cy - b.h / 2, b.w, b.h);
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255,255,255,.6)';
        ctx.font = `600 ${Math.max(22, b.w * 0.06)}px "Noto Sans TC", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('＋ ' + el.label, b.cx, b.cy);
        ctx.restore();
      }
    }
    // 選取框 + 縮放控制點（跟著旋轉）
    const sel = this.selected;
    if (sel) {
      const cs = this.selCorners(sel);
      ctx.save();
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 3;
      ctx.beginPath();
      cs.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = '#38bdf8';
      for (const [hx, hy] of cs) ctx.fillRect(hx - HANDLE / 2, hy - HANDLE / 2, HANDLE, HANDLE);
      ctx.restore();
    }
  }

  corners(b) {
    const x = b.cx - b.w / 2, y = b.cy - b.h / 2;
    return [[x, y], [x + b.w, y], [x + b.w, y + b.h], [x, y + b.h]];
  }
  // 選取框的四角（含旋轉）
  selCorners(el) {
    const b = this.bounds(el), c = this.center(el), deg = el.rotation || 0;
    return this.corners(b).map(([x, y]) => rotatePt(x, y, c.cx, c.cy, deg));
  }

  bounds(el) {
    if (el.type === 'text') {
      const L = this.layoutText(el);
      let left;
      if (el.align === 'left') left = el.x - el.boxWidth / 2;
      else if (el.align === 'right') left = el.x + el.boxWidth / 2 - L.blockW;
      else left = el.x - L.blockW / 2;
      return { cx: left + L.blockW / 2, cy: el.y, w: L.blockW, h: L.blockH };
    }
    if (el.type === 'gradient') {
      const W = this.doc.width, H = this.doc.height;
      const band = clamp(el.size ?? 0.4, 0, 1) * H;
      return { cx: W / 2, cy: el.edge === 'top' ? band / 2 : H - band / 2, w: W, h: band };
    }
    return { cx: el.x, cy: el.y, w: el.w, h: el.h };
  }

  // 固定元素在未解鎖時等同鎖定（不可點選、不進表單）。
  isLocked(el) {
    return el.locked || (el.fixed && !this.unlockFixed);
  }

  // ---------- 互動 ----------
  toDoc(e) {
    const r = this.overlay.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (this.doc.width / r.width),
      y: (e.clientY - r.top) * (this.doc.height / r.height),
    };
  }

  _bindPointer() {
    const ov = this.overlay;
    ov.addEventListener('pointerdown', (e) => this.onDown(e));
    ov.addEventListener('pointermove', (e) => this.onMove(e));
    ov.addEventListener('pointerup', (e) => this.onUp(e));
    ov.addEventListener('pointercancel', (e) => this.onUp(e));
    ov.addEventListener('pointerleave', (e) => this.onUp(e));
  }

  hitTest(p) {
    // 由上而下找最上層、未鎖定的元素
    const els = this.doc.elements || [];
    for (let i = els.length - 1; i >= 0; i--) {
      const el = els[i];
      if (el.hidden || this.isLocked(el)) continue;
      const b = this.bounds(el);
      const c = this.center(el);
      const [lx, ly] = rotatePt(p.x, p.y, c.cx, c.cy, -(el.rotation || 0)); // 反旋轉到元素本地座標
      if (Math.abs(lx - b.cx) <= b.w / 2 + 6 && Math.abs(ly - b.cy) <= b.h / 2 + 6) return el;
    }
    return null;
  }

  hitHandle(p) {
    const sel = this.selected;
    if (!sel) return -1;
    const cs = this.selCorners(sel);
    for (let i = 0; i < cs.length; i++) {
      if (Math.abs(p.x - cs[i][0]) <= HIT_PAD && Math.abs(p.y - cs[i][1]) <= HIT_PAD) return i;
    }
    return -1;
  }

  onDown(e) {
    if (!this.doc) return;
    this.overlay.setPointerCapture?.(e.pointerId);
    const p = this.toDoc(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 2) {
      this.startPinch();
      return;
    }
    const hIdx = this.hitHandle(p);
    if (hIdx >= 0) {
      const sel = this.selected;
      const b = this.bounds(sel);
      this.drag = { mode: 'scale', id: sel.id, startDist: Math.hypot(p.x - b.cx, p.y - b.cy) || 1, snap: this.snapshot(sel) };
      return;
    }
    const hit = this.hitTest(p);
    this.selectedId = hit ? hit.id : null;
    this.onSelect(this.selected);
    if (hit) this.drag = { mode: 'move', id: hit.id, last: p };
    this.render();
  }

  onMove(e) {
    if (!this.doc) return;
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, this.toDoc(e));
    if (this.pinch && this.pointers.size >= 2) {
      this.updatePinch();
      return;
    }
    if (!this.drag) return;
    const p = this.toDoc(e);
    const el = this.el(this.drag.id);
    if (!el) return;
    if (this.drag.mode === 'move') {
      el.x += p.x - this.drag.last.x;
      el.y += p.y - this.drag.last.y;
      this.drag.last = p;
    } else if (this.drag.mode === 'scale') {
      const b = this.bounds(el);
      const dist = Math.hypot(p.x - b.cx, p.y - b.cy);
      const k = clamp(dist / this.drag.startDist, 0.15, 12);
      this.applyScale(el, this.drag.snap, k); // 以中心點縮放
    }
    this.render();
    this.onChange();
  }

  onUp(e) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 0) this.drag = null;
  }

  snapshot(el) {
    return { size: el.size, boxWidth: el.boxWidth, w: el.w, h: el.h };
  }
  applyScale(el, snap, k) {
    if (el.type === 'text') {
      el.size = clamp(Math.round(snap.size * k), 8, 600);
      el.boxWidth = Math.round(snap.boxWidth * k);
    } else {
      el.w = Math.round(snap.w * k);
      el.h = Math.round(snap.h * k);
    }
  }

  // 雙指縮放（以兩指中點附近的選取物件中心縮放）
  startPinch() {
    const el = this.selected;
    if (!el) return;
    const pts = [...this.pointers.values()];
    this.pinch = { id: el.id, startDist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1, snap: this.snapshot(el) };
    this.drag = null;
  }
  updatePinch() {
    const el = this.el(this.pinch.id);
    if (!el) return;
    const pts = [...this.pointers.values()];
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    this.applyScale(el, this.pinch.snap, clamp(dist / this.pinch.startDist, 0.15, 12));
    this.render();
    this.onChange();
  }

  // ---------- 對外操作 ----------
  select(id) {
    this.selectedId = id;
    this.onSelect(this.selected);
    this.render();
  }
  async update(id, patch) {
    const el = this.el(id);
    if (!el) return;
    Object.assign(el, patch);
    if (patch.font || patch.weight) await ensureFont(el.font, el.weight, el.size);
    this.render();
    this.onChange();
  }
  async replaceImage(id, { src, w, h }) {
    const el = this.el(id);
    if (!el) return;
    el.src = src;
    await loadImage(src);
    // 只有「完整顯示(contain)的一般圖片框」才依原圖比例調整框高；滿版/疊加圖層維持原框。
    if (el.fit === 'contain' && !el.isBackground && el.role !== 'overlay' && w && h) {
      el.h = Math.round(el.w * (h / w));
    }
    this.render();
    this.onChange();
  }
  clearImage(id) {
    const el = this.el(id);
    if (el) { el.src = null; this.render(); this.onChange(); }
  }
  moveLayer(id, dir) {
    const els = this.doc.elements;
    const i = els.findIndex((e) => e.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= els.length) return;
    [els[i], els[j]] = [els[j], els[i]];
    this.render();
    this.onChange();
  }
  bringToFront(id) {
    const els = this.doc.elements, i = els.findIndex((e) => e.id === id);
    if (i < 0) return; els.push(els.splice(i, 1)[0]); this.render(); this.onChange();
  }
  sendToBack(id) {
    const els = this.doc.elements, i = els.findIndex((e) => e.id === id);
    if (i < 0) return; els.unshift(els.splice(i, 1)[0]); this.render(); this.onChange();
  }
  // 對齊畫布中心（axis: 'x' 水平置中 / 'y' 垂直置中）
  alignCenter(id, axis) {
    const el = this.el(id);
    if (!el) return;
    const b = this.bounds(el);
    if (axis === 'x') el.x += this.doc.width / 2 - b.cx;
    else el.y += this.doc.height / 2 - b.cy;
    this.render();
    this.onChange();
  }
  // 複製選取物件（往右下偏移一點）
  duplicateElement(id) {
    const el = this.el(id);
    if (!el) return null;
    const copy = deepClone(el);
    copy.id = uid('el');
    copy.x = (copy.x || 0) + 24;
    copy.y = (copy.y || 0) + 24;
    copy.fixed = false; copy.locked = false;
    const i = this.doc.elements.findIndex((e) => e.id === id);
    this.doc.elements.splice(i + 1, 0, copy);
    this.select(copy.id);
    this.onChange();
    return copy;
  }
  // 貼上一份元素資料（給複製/貼上）
  pasteElement(data) {
    const copy = deepClone(data);
    copy.id = uid('el');
    copy.x = (copy.x || this.doc.width / 2) + 24;
    copy.y = (copy.y || this.doc.height / 2) + 24;
    copy.fixed = false; copy.locked = false; copy.hidden = false;
    this.doc.elements.push(copy);
    this.select(copy.id);
    this.onChange();
    return copy;
  }
  addElement(el) {
    this.doc.elements.push(el);
    this.select(el.id);
    this.onChange();
  }
  // 一次加入多個元素（元件），並確保圖片載入後再渲染
  async addComponent(els) {
    for (const el of els) { el.id = el.id || uid('el'); this.doc.elements.push(el); }
    await this.preload();
    this.select(els[els.length - 1].id);
    this.onChange();
  }
  removeElement(id) {
    this.doc.elements = this.doc.elements.filter((e) => e.id !== id);
    if (this.selectedId === id) this.selectedId = null;
    this.onSelect(this.selected);
    this.render();
    this.onChange();
  }
  setBg(color) {
    this.doc.bgColor = color;
    this.render();
    this.onChange();
  }
  // 顯示/隱藏元素（同 group 的一起切換），例如名稱標籤的底框+文字。
  setHidden(id, hidden) {
    const el = this.el(id);
    if (!el) return;
    const grp = el.group;
    for (const e of this.doc.elements) if (e.id === id || (grp && e.group && e.group === grp)) e.hidden = hidden;
    if (hidden && this.selected && this.selected.hidden) { this.selectedId = null; this.onSelect(null); }
    this.render();
    this.onChange();
  }
  setUnlockFixed(on) {
    this.unlockFixed = on;
    if (!on && this.selected && this.selected.fixed) { this.selectedId = null; this.onSelect(null); }
    this.render();
  }
  // 改變畫布尺寸／比例。滿版元素（背景/疊加/外框/漸層）跟著填滿，其餘依比例平移避免跑出畫面。
  static reflow(doc, w, h) {
    const sx = w / doc.width, sy = h / doc.height;
    for (const el of doc.elements) {
      const fullBleed = el.isBackground || el.role === 'background' || el.role === 'overlay';
      if (el.type === 'gradient') continue; // 漸層以比例計算，免處理
      if (fullBleed) { el.x = w / 2; el.y = h / 2; el.w = w; el.h = h; }
      else { el.x = Math.round(el.x * sx); el.y = Math.round(el.y * sy); }
      if (el.role === 'frame' && el.type === 'shape') { el.w = w - 48; el.h = h - 48; }
    }
    doc.width = w; doc.height = h;
  }
  async setSize(w, h) {
    Editor.reflow(this.doc, w, h);
    await this.setDoc(this.doc);
  }

  // 匯出任一份 doc（不動到目前正在編輯的畫布），給「下載全部頁」用。
  static async exportDoc(doc, type = 'image/png', scale = 2, quality = 0.95) {
    const ed = new Editor(document.createElement('canvas'), document.createElement('canvas'));
    await ed.setDoc(doc);
    return ed.exportImage(type, scale, quality);
  }

  // 匯出圖片。type: 'image/png' | 'image/jpeg'
  async exportImage(type = 'image/png', scale = 2, quality = 0.95) {
    await this.preload();
    const off = document.createElement('canvas');
    off.width = this.doc.width * scale;
    off.height = this.doc.height * scale;
    this.drawScene(off.getContext('2d'), scale);
    return off.toDataURL(type, quality);
  }

  // 產生模板縮圖（給模板一覽用）。
  static async renderThumb(doc, maxW = 360) {
    const ed = new Editor(document.createElement('canvas'), document.createElement('canvas'));
    await ed.setDoc(doc);
    const t = document.createElement('canvas');
    t.width = maxW;
    t.height = Math.round((maxW * doc.height) / doc.width);
    t.getContext('2d').drawImage(ed.board, 0, 0, t.width, t.height);
    return t.toDataURL('image/png');
  }

  async exportPNG(scale = 2) {
    return this.exportImage('image/png', scale);
  }
}
