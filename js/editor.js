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
import { loadImage, peekImage, clamp } from './util.js';

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

export class Editor {
  constructor(board, overlay) {
    this.board = board;
    this.overlay = overlay;
    this.ctx = board.getContext('2d');
    this.octx = overlay.getContext('2d');
    this.doc = null;
    this.selectedId = null;
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
      if (el.type === 'text') this.drawText(ctx, el, factor);
      else if (el.type === 'image') this.drawImage(ctx, el, factor);
      else if (el.type === 'shape') this.drawShape(ctx, el, factor);
    }
    ctx.restore();
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
    ctx.fillStyle = el.color;
    if (el.stroke) {
      ctx.lineJoin = 'round';
      ctx.strokeStyle = el.stroke.color;
      ctx.lineWidth = (el.stroke.width || 4) * f;
    }
    const boxLeft = (el.x - el.boxWidth / 2) * f;
    const boxRight = (el.x + el.boxWidth / 2) * f;
    const top = (el.y - L.blockH / 2) * f;
    const ls = L.ls * f;
    L.lines.forEach((line, i) => {
      const lw = L.widths[i] * f;
      let x;
      if (el.align === 'left') x = boxLeft;
      else if (el.align === 'right') x = boxRight - lw;
      else x = el.x * f - lw / 2;
      const y = top + i * L.lineStep * f;
      for (const ch of line) {
        if (el.stroke) ctx.strokeText(ch, x, y);
        ctx.fillText(ch, x, y);
        x += ctx.measureText(ch).width + ls;
      }
    });
    ctx.restore();
  }

  drawImage(ctx, el, f) {
    const img = el.src ? peekImage(el.src) : null;
    if (!img) return; // 空圖片框不畫在畫布上（下載乾淨、不會有殘影）
    const bx = (el.x - el.w / 2) * f, by = (el.y - el.h / 2) * f, bw = el.w * f, bh = el.h * f;
    ctx.save();
    ctx.globalAlpha = el.opacity ?? 1;
    // cover 一定裁切到框內；contain 只有設圓角時才裁切。
    if (el.fit === 'cover' || el.radius) {
      roundRectPath(ctx, bx, by, bw, bh, (el.radius || 0) * f);
      ctx.clip();
    }
    const scale = el.fit === 'cover'
      ? Math.max(bw / img.naturalWidth, bh / img.naturalHeight)
      : Math.min(bw / img.naturalWidth, bh / img.naturalHeight);
    const dw = img.naturalWidth * scale, dh = img.naturalHeight * scale;
    ctx.drawImage(img, el.x * f - dw / 2, el.y * f - dh / 2, dw, dh);
    ctx.restore();
  }

  drawShape(ctx, el, f) {
    const bx = (el.x - el.w / 2) * f, by = (el.y - el.h / 2) * f, bw = el.w * f, bh = el.h * f;
    ctx.save();
    ctx.globalAlpha = el.opacity ?? 1;
    ctx.fillStyle = el.fill;
    roundRectPath(ctx, bx, by, bw, bh, (el.radius || 0) * f);
    ctx.fill();
    if (el.stroke) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = el.stroke.color;
      ctx.lineWidth = (el.stroke.width || 2) * f;
      ctx.stroke();
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
    // 空圖片框：畫虛線提示框（只在操作層，不會被下載）
    for (const el of this.doc.elements || []) {
      if (el.type === 'image' && !el.src) {
        const b = this.bounds(el);
        ctx.save();
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
    // 選取框 + 縮放控制點
    const sel = this.selected;
    if (sel) {
      const b = this.bounds(sel);
      const x = b.cx - b.w / 2, y = b.cy - b.h / 2;
      ctx.save();
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 3;
      ctx.strokeRect(x, y, b.w, b.h);
      ctx.fillStyle = '#38bdf8';
      for (const [hx, hy] of this.corners(b)) {
        ctx.fillRect(hx - HANDLE / 2, hy - HANDLE / 2, HANDLE, HANDLE);
      }
      ctx.restore();
    }
  }

  corners(b) {
    const x = b.cx - b.w / 2, y = b.cy - b.h / 2;
    return [[x, y], [x + b.w, y], [x + b.w, y + b.h], [x, y + b.h]];
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
    return { cx: el.x, cy: el.y, w: el.w, h: el.h };
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
      if (el.locked) continue;
      const b = this.bounds(el);
      if (Math.abs(p.x - b.cx) <= b.w / 2 + 6 && Math.abs(p.y - b.cy) <= b.h / 2 + 6) return el;
    }
    return null;
  }

  hitHandle(p) {
    const sel = this.selected;
    if (!sel) return -1;
    const cs = this.corners(this.bounds(sel));
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
    if (!el.isBackground && w && h) el.h = Math.round(el.w * (h / w)); // 依原圖比例調整框高
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
  addElement(el) {
    this.doc.elements.push(el);
    this.select(el.id);
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

  // 匯出高解析度 PNG（預設 2x = 2160px）。
  // 字型量測用 this.ctx（board），繪製用離屏 canvas，factor=scale → 與預覽完全一致。
  async exportPNG(scale = 2) {
    await this.preload();
    const off = document.createElement('canvas');
    off.width = this.doc.width * scale;
    off.height = this.doc.height * scale;
    this.drawScene(off.getContext('2d'), scale);
    return off.toDataURL('image/png');
  }
}
