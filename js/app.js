// 主控制器：串起模板一覽、快速填寫、微調面板、自製模板、匯出下載。

import { Editor } from './editor.js';
import { store } from './store.js';
import { instantiate, newBlankTemplate, makeText, makeImage, makeShape, makeGradient,
         SIZE_PRESETS, BLEND_MODES } from './builtins.js';
import { FONTS } from './fonts.js';
import { importSVGFile } from './svg.js';
import { assets, projects } from './db.js';
import { BUILTIN_ASSETS } from './builtin-assets.js';
import { syncCfg, signUp, signIn, signInWithGitHub, signOut, currentUser, fetchRemote, pushRemote, markDeleted } from './sync.js';
import { readImageFile, downloadDataURL, deepClone, clamp, uid } from './util.js';

// ---------- 迷你工具 ----------
const $ = (s, r = document) => r.querySelector(s);
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2200);
}

// 滑桿列（含即時數值顯示）
function slider(label, value, min, max, step, cb, fmt = (v) => v) {
  const val = h('span', { class: 'val' }, fmt(value));
  const input = h('input', {
    type: 'range', min, max, step, value,
    oninput: (e) => { const v = parseFloat(e.target.value); val.textContent = fmt(v); cb(v); },
  });
  const row = h('label', { class: 'prop' }, h('span', {}, label), h('div', { class: 'inline' }, input, val));
  row._input = input; row._val = val; row._fmt = fmt;
  return row;
}

// ---------- 狀態 ----------
// pages：多頁（輪播）用；state.doc 永遠指向目前這一頁。
const state = { mode: 'post', doc: null, pages: [], pageIndex: 0, filter: '全部', editingCustomId: null, syncProps: null, projectId: null, projectName: '', user: null };
let editor;
let imgCb = null;

// ---------- 圖片選取 ----------
function pickImage(cb) { imgCb = cb; $('#fileImage').click(); }
$('#fileImage').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f && imgCb) { try { imgCb(await readImageFile(f)); } catch (_) { toast('圖片讀取失敗'); } }
  imgCb = null;
});

// =============================================================
//  模板一覽
// =============================================================
function renderFilters() {
  const box = $('#catFilter');
  box.innerHTML = '';
  const cats = ['全部', ...store.categories()];
  for (const c of cats) {
    box.append(h('button', {
      class: 'chip' + (state.filter === c ? ' active' : ''),
      onclick: () => { state.filter = c; renderGallery(); },
    }, c));
  }
}

async function renderGallery() {
  renderFilters();
  const grid = $('#gallery');
  grid.innerHTML = '';
  const list = store.all().filter((t) => state.filter === '全部' || t.category === state.filter);
  $('#emptyHint').hidden = list.length > 0;
  for (const tpl of list) {
    const img = h('img', { class: 'thumb', alt: tpl.name });
    Editor.renderThumb(deepClone(tpl)).then((src) => (img.src = src)).catch(() => {});
    // 所有模板（含預設）都可編輯 / 複製 / 刪除
    const actions = h('div', { class: 'card-actions' },
      h('button', { class: 'icon-btn', title: '重新命名', onclick: (e) => { e.stopPropagation(); renameTemplate(tpl); } }, '🏷'),
      h('button', { class: 'icon-btn', title: '編輯模板', onclick: (e) => { e.stopPropagation(); openBuilder(tpl); } }, '✎'),
      h('button', { class: 'icon-btn', title: '複製一份', onclick: (e) => { e.stopPropagation(); duplicateToCustom(tpl); } }, '⧉'),
      h('button', { class: 'icon-btn', title: '刪除模板', onclick: (e) => { e.stopPropagation(); if (confirm(`刪除模板「${tpl.name}」？`)) { store.remove(tpl.id); delRemote('template', tpl.id); renderGallery(); syncNow(true); } } }, '🗑'));
    grid.append(h('div', { class: 'card', onclick: () => openPost(tpl) },
      img,
      actions,
      h('div', { class: 'meta' }, h('div', { class: 'name' }, tpl.name), h('div', { class: 'cat' }, tpl.category || '未分類'))));
  }
}

// =============================================================
//  開啟編輯器
// =============================================================
// 複製內建模板為自製（之後可自由編輯 / 刪除）
function duplicateToCustom(tpl) {
  const copy = deepClone(tpl);
  copy.id = uid('tpl');
  copy.name = tpl.name + '（我的）';
  copy.custom = true;
  delete copy.builtin;
  store.save(copy);
  pushOne('template', copy.id, copy, copy.updatedAt);
  toast('已複製為自製模板 ✓');
  renderGallery();
  syncNow(true);
}
// 重新命名模板（含預設）：改名後儲存 + 同步
function renameTemplate(tpl) {
  const name = (prompt('模板名稱：', tpl.name) || '').trim();
  if (!name || name === tpl.name) return;
  const t = deepClone(tpl);
  t.name = name;
  store.save(t);
  pushOne('template', t.id, t, t.updatedAt);
  toast('已改名 ✓');
  renderGallery();
  syncNow(true);
}

function showView(id) {
  $('#galleryView').classList.toggle('hidden', id !== 'gallery');
  $('#editorView').classList.toggle('hidden', id !== 'editor');
  window.scrollTo(0, 0);
}

async function openPost(tpl) {
  state.mode = 'post';
  state.editingCustomId = null;
  state.projectId = null; // 每次套版都是一份新的歷史紀錄
  state.projectName = tpl.name;
  state.pages = [instantiate(tpl)];
  state.pageIndex = 0;
  state.doc = state.pages[0];
  $('#builderTools').classList.add('hidden');
  $('#pageBar').classList.remove('hidden'); // 多頁只在套版產文時出現
  $('#editorTitle').textContent = tpl.name;
  showView('editor');
  initAssetSide();
  await editor.setDoc(state.doc);
  buildFillForm();
  renderPageStrip();
  activateTab('fill');
  histReset();
}

async function openBuilder(tpl) {
  state.mode = 'build';
  const doc = tpl ? deepClone(tpl) : newBlankTemplate();
  state.editingCustomId = tpl ? tpl.id : null;
  state.pages = [doc];
  state.pageIndex = 0;
  state.doc = doc;
  $('#builderTools').classList.remove('hidden');
  $('#pageBar').classList.add('hidden'); // 編輯模板本身不分頁
  $('#downloadAllBtn').classList.add('hidden');
  $('#tplName').value = doc.name;
  $('#tplCategory').value = doc.category;
  $('#tplSize').value = `${doc.width}x${doc.height}`;
  refreshCatList();
  $('#editorTitle').textContent = tpl ? '編輯模板' : '新模板';
  showView('editor');
  initAssetSide();
  await editor.setDoc(doc);
  buildFillForm();
  activateTab('fill');
  histReset();
}

// =============================================================
//  多頁 / 輪播
// =============================================================
async function gotoPage(i) {
  if (i < 0 || i >= state.pages.length) return;
  state.pageIndex = i;
  state.doc = state.pages[i];
  await editor.setDoc(state.doc);
  buildFillForm();
  buildProps(null);
  activateTab('fill');
  renderPageStrip();
  histReset();
}
function addPages(n) {
  const src = state.pages[state.pageIndex];
  const copies = [];
  for (let k = 0; k < n; k++) copies.push(deepClone(src)); // 複製目前頁，保留外框/LOGO，只需改內容
  state.pages.splice(state.pageIndex + 1, 0, ...copies);
  gotoPage(state.pageIndex + 1);
}
function deletePage(i) {
  if (state.pages.length <= 1) return toast('至少要有一頁');
  state.pages.splice(i, 1);
  state.pageIndex = Math.min(state.pageIndex, state.pages.length - 1);
  gotoPage(state.pageIndex);
}
function renderPageStrip() {
  const bar = $('#pageBar');
  if (state.mode !== 'post') { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  $('#downloadAllBtn').classList.toggle('hidden', state.pages.length < 2);
  $('#downloadBtn').textContent = state.pages.length > 1 ? '下載這頁' : '下載';
  const strip = $('#pageStrip');
  strip.innerHTML = '';
  state.pages.forEach((pg, i) => {
    const img = h('img', { alt: `第 ${i + 1} 頁` });
    Editor.renderThumb(deepClone(pg), 140).then((s) => (img.src = s)).catch(() => {});
    strip.append(h('div', { class: 'page-thumb' + (i === state.pageIndex ? ' active' : ''), onclick: () => gotoPage(i) },
      img,
      h('span', { class: 'pnum' }, i + 1),
      h('button', { class: 'pdel', title: '刪除此頁', onclick: (e) => { e.stopPropagation(); deletePage(i); } }, '×')));
  });
}
$('#addPagesBtn').addEventListener('click', () => {
  const n = clamp(parseInt($('#pageCount').value, 10) || 1, 1, 20);
  addPages(n);
});

function refreshCatList() {
  const dl = $('#catList');
  dl.innerHTML = '';
  for (const c of store.categories()) dl.append(h('option', { value: c }));
}

// =============================================================
//  分頁切換
// =============================================================
function activateTab(name) {
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === name);
  $('#fillPanel').classList.toggle('hidden', name !== 'fill');
  $('#propsPanel').classList.toggle('hidden', name !== 'props');
  $('#layersPanel').classList.toggle('hidden', name !== 'layers');
  if (name === 'layers') renderLayers();
}

// 圖層面板：由上到下列出所有元素（可選取 / 顯示隱藏 / 鎖定 / 上下移 / 刪除）
function renderLayers() {
  const pane = $('#layersPanel');
  pane.innerHTML = '';
  const els = state.doc.elements;
  for (let i = els.length - 1; i >= 0; i--) { // 陣列後面的畫在上層 → 由上往下列
    const el = els[i];
    const row = h('div', { class: 'layer-row' + (editor.selectedId === el.id ? ' active' : '') });
    row.append(
      h('button', { class: 'lyr-ic', title: el.hidden ? '顯示' : '隱藏', onclick: () => { editor.setHidden(el.id, !el.hidden); renderLayers(); } }, el.hidden ? '🚫' : '👁'),
      h('button', { class: 'lyr-ic', title: el.locked ? '解鎖' : '鎖定', onclick: () => { editor.update(el.id, { locked: !el.locked }); renderLayers(); } }, el.locked ? '🔒' : '🔓'),
      h('span', { class: 'lyr-name', onclick: () => { editor.select(el.id); activateTab('props'); } }, el.label || el.type),
      h('button', { class: 'lyr-ic', title: '上移', onclick: () => { editor.moveLayer(el.id, 1); renderLayers(); } }, '▲'),
      h('button', { class: 'lyr-ic', title: '下移', onclick: () => { editor.moveLayer(el.id, -1); renderLayers(); } }, '▼'),
      h('button', { class: 'lyr-ic danger', title: '刪除', onclick: () => { editor.removeElement(el.id); buildFillForm(); renderLayers(); } }, '🗑'));
    pane.append(row);
  }
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => activateTab(t.dataset.tab)));

// =============================================================
//  快速填寫表單（自動依可編輯元素產生）
// =============================================================
function buildFillForm() {
  const pane = $('#fillPanel');
  pane.innerHTML = '';
  const D = state.doc;

  // 比例 / 尺寸（隨時可改）
  const ratioSel = h('select', { onchange: (e) => applyRatio(e.target.value) });
  for (const p of SIZE_PRESETS) ratioSel.append(h('option', { value: `${p.w}x${p.h}`, ...(p.w === D.width && p.h === D.height ? { selected: true } : {}) }, p.label));
  pane.append(h('div', { class: 'prop-row' },
    h('label', { class: 'prop' }, h('span', {}, '比例 / 尺寸'), ratioSel),
    h('label', { class: 'prop' }, h('span', {}, '底色'),
      h('input', { type: 'color', value: D.bgColor || '#111318', oninput: (e) => editor.setBg(e.target.value) }))));

  // 背景設定（有背景/疊加/漸層時才出現）
  const bgEl = D.elements.find((e) => e.role === 'background');
  const ovEl = D.elements.find((e) => e.role === 'overlay');
  const grads = D.elements.filter((e) => e.type === 'gradient');
  if (bgEl || ovEl || grads.length) pane.append(buildBackgroundGroup(bgEl, ovEl, grads));

  // 一般可編輯欄位
  for (const el of D.elements) {
    if (el.editable === false || el.fixed || el.role === 'background' || el.role === 'overlay' || el.type === 'gradient') continue;
    pane.append(fieldGroup(el));
  }

  // 固定元素（外框 / LOGO / HR NEWS）解鎖開關
  const fixedEls = D.elements.filter((e) => e.fixed);
  if (fixedEls.length) {
    const chk = h('input', { type: 'checkbox', ...(editor.unlockFixed ? { checked: true } : {}), onchange: (e) => { editor.setUnlockFixed(e.target.checked); buildFillForm(); } });
    pane.append(h('hr'), h('label', { class: 'inline lock-toggle' }, chk, h('span', {}, '編輯固定元素（外框 / LOGO / HR NEWS）')));
    if (editor.unlockFixed) for (const el of fixedEls) pane.append(fieldGroup(el, true));
  }
}

// 顯示 / 隱藏開關（同群組一起切換）
function hideToggle(el) {
  return h('label', { class: 'inline' },
    h('input', { type: 'checkbox', ...(el.hidden ? {} : { checked: true }), title: '顯示 / 隱藏',
      onchange: (e) => { editor.setHidden(el.id, !e.target.checked); buildFillForm(); } }),
    h('span', { class: 'hint-line' }, '顯示這個（取消勾選就不出現）'));
}

// 形狀外框線（描邊）控制：開關 + 粗細 + 顏色
function borderControls(el) {
  const on = !!(el.stroke && el.stroke.width > 0);
  const chk = h('input', { type: 'checkbox', ...(on ? { checked: true } : {}), onchange: (e) => {
    editor.update(el.id, { stroke: e.target.checked
      ? { color: (el.stroke && el.stroke.color) || '#ffffff', width: (el.stroke && el.stroke.width) || 2 } : null });
    buildFillForm(); if (editor.selectedId === el.id) buildProps(editor.selected);
  } });
  const wrap = h('div', {}, h('label', { class: 'inline' }, chk, h('span', { class: 'hint-line' }, '外框線')));
  if (on) {
    wrap.append(slider('外框粗細', el.stroke.width, 0, 40, 1, (v) => editor.update(el.id, { stroke: { ...el.stroke, width: v } })));
    wrap.append(h('label', { class: 'inline' }, h('span', { class: 'hint-line' }, '外框顏色'),
      h('input', { type: 'color', value: el.stroke.color, oninput: (e) => editor.update(el.id, { stroke: { ...el.stroke, color: e.target.value } }) })));
  }
  return wrap;
}

// 四角方塊（像名稱標籤那樣，四個角落各一個小方塊）；線（外框）與方塊顏色分開控制
function cornerSquareControls(el) {
  const on = !!(el.corners && el.corners.size > 0);
  const chk = h('input', { type: 'checkbox', ...(on ? { checked: true } : {}), onchange: (e) => {
    editor.update(el.id, { corners: e.target.checked
      ? { size: (el.corners && el.corners.size) || 20, color: (el.corners && el.corners.color) || '#e4002b' } : null });
    buildFillForm(); if (editor.selectedId === el.id) buildProps(editor.selected);
  } });
  const wrap = h('div', {}, h('label', { class: 'inline' }, chk, h('span', { class: 'hint-line' }, '四角方塊')));
  if (on) {
    wrap.append(slider('方塊大小', el.corners.size, 2, 80, 1, (v) => editor.update(el.id, { corners: { ...el.corners, size: v } })));
    wrap.append(h('label', { class: 'inline' }, h('span', { class: 'hint-line' }, '方塊顏色'),
      h('input', { type: 'color', value: el.corners.color, oninput: (e) => editor.update(el.id, { corners: { ...el.corners, color: e.target.value } }) })));
  }
  return wrap;
}

// 邊角：方形 / 圓角 切換 + 圓角值（給色塊、圖片框用）
function cornerControls(el, rebuild) {
  const rounded = (el.radius || 0) > 0;
  const seg = h('div', { class: 'seg' },
    h('button', { class: !rounded ? 'on' : '', onclick: () => { editor.update(el.id, { radius: 0 }); rebuild(); } }, '方形'),
    h('button', { class: rounded ? 'on' : '', onclick: () => { editor.update(el.id, { radius: el.radius || 24 }); rebuild(); } }, '圓角'));
  const wrap = h('div', {}, h('label', { class: 'prop' }, h('span', {}, '邊角'), seg));
  if (rounded) {
    const cap = Math.round(Math.min(el.w || 800, el.h || 800) / 2) || 400;
    wrap.append(slider('圓角值', Math.round(el.radius), 0, cap, 1, (v) => editor.update(el.id, { radius: v })));
  }
  return wrap;
}

// 單一欄位的填寫區塊
function fieldGroup(el, isFixed = false) {
  const badge = isFixed ? '固定' : (el.type === 'text' ? '文字' : el.type === 'shape' ? '色塊' : '圖片');
  const g = h('div', { class: 'group' }, h('div', { class: 'g-label' }, el.label, h('span', { class: 'badge' }, badge)), hideToggle(el));
  if (el.type === 'text') {
    const ta = h('textarea', { rows: el.text.length > 18 ? 3 : 1, oninput: (e) => editor.update(el.id, { text: e.target.value }) });
    ta.value = el.text;
    g.append(ta,
      h('label', { class: 'inline' }, h('span', { class: 'hint-line' }, '顏色'),
        h('input', { type: 'color', value: el.color, oninput: (e) => editor.update(el.id, { color: e.target.value }) })),
      h('button', { class: 'btn small', onclick: () => { editor.select(el.id); activateTab('props'); } }, '微調位置 / 大小 / 字型'));
    return g;
  }
  if (el.type === 'shape') {
    g.append(
      h('label', { class: 'inline' }, h('span', { class: 'hint-line' }, '底色'),
        h('input', { type: 'color', value: el.fill, oninput: (e) => editor.update(el.id, { fill: e.target.value }) })),
      cornerControls(el, buildFillForm),
      borderControls(el),
      cornerSquareControls(el),
      h('button', { class: 'btn small', onclick: () => { editor.select(el.id); activateTab('props'); } }, '微調大小 / 位置'));
    return g;
  }
  // image
  if (el.hint) g.append(h('div', { class: 'hint-line' }, el.hint));
  if (el.src) g.append(h('img', { class: 'thumb-preview', src: el.src }));
  g.append(cornerControls(el, buildFillForm));
  g.append(h('div', { class: 'mini-actions' },
    h('button', { class: 'btn small', onclick: () => pickImage((d) => editor.replaceImage(el.id, d).then(buildFillForm)) }, el.src ? '替換圖片' : '上傳圖片'),
    el.src ? h('button', { class: 'btn small', onclick: () => { editor.clearImage(el.id); buildFillForm(); } }, '清除') : null,
    h('button', { class: 'btn small', onclick: () => { editor.select(el.id); activateTab('props'); } }, '微調')));
  return g;
}

// 背景設定：背景圖 + 疊加圖層(混合模式/不透明度) + 上下漸層遮罩
function buildBackgroundGroup(bgEl, ovEl, grads) {
  const g = h('details', { class: 'group', open: true }, h('summary', {}, '背景設定 ', h('span', { class: 'badge' }, '背景 / 疊加 / 遮罩')));

  if (bgEl) {
    g.append(h('div', { class: 'hint-line' }, '背景圖片'));
    if (bgEl.src) g.append(h('img', { class: 'thumb-preview', src: bgEl.src }));
    g.append(h('div', { class: 'mini-actions' },
      h('button', { class: 'btn small', onclick: () => pickImage((d) => editor.replaceImage(bgEl.id, d).then(buildFillForm)) }, bgEl.src ? '替換背景圖' : '上傳背景圖'),
      bgEl.src ? h('button', { class: 'btn small', onclick: () => { editor.clearImage(bgEl.id); buildFillForm(); } }, '清除') : null,
      h('button', { class: 'btn small', onclick: () => { editor.select(bgEl.id); activateTab('props'); } }, '位置 / 縮放')));
  }

  if (ovEl) {
    g.append(h('hr'), h('div', { class: 'hint-line' }, '疊加圖層 Overlay（材質 / 光暈）'));
    if (ovEl.src) g.append(h('img', { class: 'thumb-preview', src: ovEl.src }));
    g.append(h('div', { class: 'mini-actions' },
      h('button', { class: 'btn small', onclick: () => pickImage((d) => editor.replaceImage(ovEl.id, d).then(buildFillForm)) }, ovEl.src ? '替換 Overlay' : '上傳 Overlay 圖片'),
      ovEl.src ? h('button', { class: 'btn small', onclick: () => { editor.clearImage(ovEl.id); buildFillForm(); } }, '清除') : null));
    const blend = h('select', { onchange: (e) => editor.update(ovEl.id, { blendMode: e.target.value }) });
    for (const b of BLEND_MODES) blend.append(h('option', { value: b.v, ...(b.v === ovEl.blendMode ? { selected: true } : {}) }, b.label));
    g.append(h('label', { class: 'prop' }, h('span', {}, '混合模式'), blend));
    g.append(slider('不透明度', ovEl.opacity ?? 1, 0, 1, 0.05, (v) => editor.update(ovEl.id, { opacity: v }), (v) => Math.round(v * 100) + '%'));
  }

  for (const gr of grads) {
    g.append(h('hr'), h('div', { class: 'hint-line' }, gr.label + '（' + (gr.edge === 'top' ? '上緣' : '下緣') + '）'));
    g.append(slider('遮罩高度', gr.size ?? 0.4, 0, 1, 0.01, (v) => editor.update(gr.id, { size: v }), (v) => Math.round(v * 100) + '%'));
    g.append(slider('遮罩強度', gr.opacity ?? 0.85, 0, 1, 0.05, (v) => editor.update(gr.id, { opacity: v }), (v) => Math.round(v * 100) + '%'));
    g.append(h('label', { class: 'inline' }, h('span', { class: 'hint-line' }, '遮罩顏色'),
      h('input', { type: 'color', value: gr.color, oninput: (e) => editor.update(gr.id, { color: e.target.value }) })));
  }
  return g;
}

// 改變比例 / 尺寸（多頁時所有頁一起套用，保持輪播尺寸一致）
async function applyRatio(value) {
  const [w, hh] = value.split('x').map(Number);
  for (const pg of state.pages) if (pg !== state.doc) Editor.reflow(pg, w, hh);
  await editor.setSize(w, hh);
  buildFillForm();
  renderPageStrip();
}

// =============================================================
//  微調面板（選取元素後顯示）
// =============================================================
function buildProps(el) {
  const pane = $('#propsPanel');
  pane.innerHTML = '';
  state.syncProps = null;
  if (!el) {
    pane.append(h('p', { class: 'hint-line' }, '點選畫布上的物件，即可微調它的位置、大小、字型與顏色。'));
    return;
  }
  const D = state.doc;
  const badge = { text: '文字', image: '圖片', shape: '色塊', gradient: '漸層' }[el.type] || el.type;
  pane.append(h('div', { class: 'g-label' }, el.label || el.type, h('span', { class: 'badge' }, badge)));

  // 漸層遮罩：只需高度、強度、顏色（貼齊上/下緣）
  if (el.type === 'gradient') {
    pane.append(
      h('label', { class: 'prop' }, h('span', {}, '貼齊'),
        h('div', { class: 'seg' }, ...[['top', '上緣'], ['bottom', '下緣']].map(([e, t]) =>
          h('button', { class: el.edge === e ? 'on' : '', onclick: (ev) => { editor.update(el.id, { edge: e }); [...ev.target.parentNode.children].forEach((b) => b.classList.remove('on')); ev.target.classList.add('on'); } }, t)))),
      slider('遮罩高度', el.size ?? 0.4, 0, 1, 0.01, (v) => editor.update(el.id, { size: v }), (v) => Math.round(v * 100) + '%'),
      slider('遮罩強度', el.opacity ?? 0.85, 0, 1, 0.05, (v) => editor.update(el.id, { opacity: v }), (v) => Math.round(v * 100) + '%'),
      h('label', { class: 'inline' }, h('span', { class: 'hint-line' }, '遮罩顏色'),
        h('input', { type: 'color', value: el.color, oninput: (e) => editor.update(el.id, { color: e.target.value }) })));
    appendLayerControls(pane, el);
    return;
  }

  const posX = slider('水平位置 X', Math.round(el.x), 0, D.width, 1, (v) => editor.update(el.id, { x: v }));
  const posY = slider('垂直位置 Y', Math.round(el.y), 0, D.height, 1, (v) => editor.update(el.id, { y: v }));
  const opacity = slider('透明度', el.opacity ?? 1, 0, 1, 0.05, (v) => editor.update(el.id, { opacity: v }), (v) => Math.round(v * 100) + '%');
  const rotate = slider('旋轉', Math.round(el.rotation || 0), -180, 180, 1, (v) => editor.update(el.id, { rotation: v }), (v) => v + '°');

  if (el.type === 'text') {
    const ta = h('textarea', { rows: 2, oninput: (e) => editor.update(el.id, { text: e.target.value }) });
    ta.value = el.text;
    if (el.editable === false) { ta.disabled = true; }

    const fontSel = h('select', { onchange: (e) => { editor.update(el.id, { font: e.target.value }); rebuildWeights(e.target.value); } });
    for (const f of FONTS) fontSel.append(h('option', { value: f.family, ...(f.family === el.font ? { selected: true } : {}) }, f.label));

    const weightSel = h('select', { onchange: (e) => editor.update(el.id, { weight: parseInt(e.target.value, 10) }) });
    function rebuildWeights(fam) {
      weightSel.innerHTML = '';
      const f = FONTS.find((x) => x.family === fam) || FONTS[0];
      const names = { 400: '一般', 500: '中', 700: '粗', 900: '特粗' };
      for (const w of f.weights) weightSel.append(h('option', { value: w, ...(w === el.weight ? { selected: true } : {}) }, names[w] || w));
    }
    rebuildWeights(el.font);

    const align = h('div', { class: 'seg' }, ...['left', 'center', 'right'].map((a) =>
      h('button', { class: el.align === a ? 'on' : '', onclick: (e) => { editor.update(el.id, { align: a }); [...e.target.parentNode.children].forEach((b) => b.classList.remove('on')); e.target.classList.add('on'); } },
        a === 'left' ? '靠左' : a === 'center' ? '置中' : '靠右')));

    const color = h('input', { type: 'color', value: el.color, oninput: (e) => editor.update(el.id, { color: e.target.value }) });
    const size = slider('字級', Math.round(el.size), 10, 320, 1, (v) => editor.update(el.id, { size: v }));
    const boxW = slider('換行寬度', Math.round(el.boxWidth), 60, D.width, 2, (v) => editor.update(el.id, { boxWidth: v }));
    const spacing = slider('字距', el.letterSpacing || 0, -8, 40, 0.5, (v) => editor.update(el.id, { letterSpacing: v }));

    pane.append(
      h('label', { class: 'prop' }, h('span', {}, el.editable === false ? '內容（此模板固定）' : '內容'), ta),
      h('div', { class: 'prop-row' }, h('label', { class: 'prop' }, h('span', {}, '字型'), fontSel), h('label', { class: 'prop' }, h('span', {}, '粗細'), weightSel)),
      h('div', { class: 'prop-row' }, h('label', { class: 'prop' }, h('span', {}, '對齊'), align), h('label', { class: 'prop' }, h('span', {}, '顏色'), color)),
      size, boxW, spacing, posX, posY, opacity,
    );
    state.syncProps = () => { setSlider(size, Math.round(el.size)); setSlider(boxW, Math.round(el.boxWidth)); setSlider(posX, Math.round(el.x)); setSlider(posY, Math.round(el.y)); };
  } else if (el.type === 'image') {
    const ratio = el.h / el.w || 1;
    const sizeS = slider('大小', Math.round(el.w), 40, D.width * 1.5, 2, (v) => editor.update(el.id, { w: Math.round(v), h: Math.round(v * ratio) }));
    const fit = h('div', { class: 'seg' }, ...[['contain', '完整顯示'], ['cover', '填滿裁切']].map(([f, t]) =>
      h('button', { class: el.fit === f ? 'on' : '', onclick: (e) => { editor.update(el.id, { fit: f }); [...e.target.parentNode.children].forEach((b) => b.classList.remove('on')); e.target.classList.add('on'); } }, t)));
    const blend = h('select', { onchange: (e) => editor.update(el.id, { blendMode: e.target.value }) });
    for (const b of BLEND_MODES) blend.append(h('option', { value: b.v, ...(b.v === (el.blendMode || 'source-over') ? { selected: true } : {}) }, b.label));
    pane.append(
      h('div', { class: 'mini-actions' },
        h('button', { class: 'btn small', onclick: () => pickImage((d) => editor.replaceImage(el.id, d).then(() => { buildProps(editor.selected); buildFillForm(); })) }, el.src ? '替換圖片' : '上傳圖片'),
        el.src ? h('button', { class: 'btn small', onclick: () => { editor.clearImage(el.id); buildProps(editor.selected); buildFillForm(); } }, '清除') : null),
      h('label', { class: 'prop' }, h('span', {}, '顯示方式'), fit),
      h('label', { class: 'prop' }, h('span', {}, '混合模式'), blend),
      sizeS, cornerControls(el, () => buildProps(editor.selected)), posX, posY, opacity,
    );
    if (el.src) pane.append(cropControls(el));
    state.syncProps = () => { setSlider(sizeS, Math.round(el.w)); setSlider(posX, Math.round(el.x)); setSlider(posY, Math.round(el.y)); };
  } else if (el.type === 'shape') {
    const color = h('input', { type: 'color', value: el.fill, oninput: (e) => editor.update(el.id, { fill: e.target.value }) });
    const wS = slider('寬度', Math.round(el.w), 10, D.width * 1.5, 2, (v) => editor.update(el.id, { w: v }));
    const hS = slider('高度', Math.round(el.h), 10, D.height * 1.5, 2, (v) => editor.update(el.id, { h: v }));
    const shapeSel = h('select', { onchange: (e) => { editor.update(el.id, { shape: e.target.value }); buildProps(editor.selected); } });
    for (const [v, t] of [['rect', '方形'], ['ellipse', '圓形 / 橢圓'], ['triangle', '三角形'], ['polygon', '多邊形'], ['star', '星形'], ['line', '線']])
      shapeSel.append(h('option', { value: v, ...((el.shape || 'rect') === v ? { selected: true } : {}) }, t));
    pane.append(h('label', { class: 'prop' }, h('span', {}, '圖形'), shapeSel),
      h('label', { class: 'prop' }, h('span', {}, '底色'), color));
    if (el.shape === 'polygon' || el.shape === 'star')
      pane.append(slider(el.shape === 'star' ? '角數' : '邊數', Math.round(el.sides || 6), 3, 12, 1, (v) => editor.update(el.id, { sides: v })));
    if (!el.shape || el.shape === 'rect') pane.append(cornerControls(el, () => buildProps(editor.selected)));
    pane.append(
      h('div', { class: 'group' }, h('div', { class: 'g-label' }, '外框線 / 四角方塊'), borderControls(el), cornerSquareControls(el)),
      wS, hS, posX, posY, opacity);
    state.syncProps = () => { setSlider(wS, Math.round(el.w)); setSlider(hS, Math.round(el.h)); setSlider(posX, Math.round(el.x)); setSlider(posY, Math.round(el.y)); };
  }

  pane.append(rotate); // 旋轉：所有物件
  if (el.type === 'text') pane.append(strokeControls(el));
  pane.append(shadowControls(el)); // 陰影：所有物件都能加
  appendLayerControls(pane, el);
}

// 文字外框（描邊）：開關 + 粗細 + 顏色
function strokeControls(el) {
  const on = !!(el.stroke && el.stroke.width > 0);
  const chk = h('input', { type: 'checkbox', ...(on ? { checked: true } : {}), onchange: (e) => {
    editor.update(el.id, { stroke: e.target.checked
      ? { color: (el.stroke && el.stroke.color) || '#000000', width: (el.stroke && el.stroke.width) || 6 } : null });
    buildProps(editor.selected);
  } });
  const g = h('details', { class: 'group' }, h('summary', {}, '文字外框（描邊）'),
    h('label', { class: 'inline' }, chk, h('span', { class: 'hint-line' }, '開啟外框')));
  if (on) {
    g.append(slider('外框粗細', el.stroke.width, 0, 40, 1, (v) => editor.update(el.id, { stroke: { ...el.stroke, width: v } })));
    g.append(h('label', { class: 'inline' }, h('span', { class: 'hint-line' }, '外框顏色'),
      h('input', { type: 'color', value: el.stroke.color, oninput: (e) => editor.update(el.id, { stroke: { ...el.stroke, color: e.target.value } }) })));
    g.append(h('label', { class: 'inline' },
      h('input', { type: 'checkbox', ...(el.hollow ? { checked: true } : {}), onchange: (e) => editor.update(el.id, { hollow: e.target.checked }) }),
      h('span', { class: 'hint-line' }, '空心字（只留外框）')));
  }
  return g;
}

// 圖片裁切：從上／下／左／右各裁掉多少（%）
function cropControls(el) {
  const c = el.crop || { top: 0, right: 0, bottom: 0, left: 0 };
  const on = !!((c.top || 0) || (c.right || 0) || (c.bottom || 0) || (c.left || 0));
  const setC = (patch) => editor.update(el.id, { crop: { top: 0, right: 0, bottom: 0, left: 0, ...(el.crop || {}), ...patch } });
  const pct = (v) => Math.round(v * 100) + '%';
  const g = h('details', { class: 'group', ...(on ? { open: true } : {}) }, h('summary', {}, '裁切（上下左右）'));
  g.append(
    slider('上', c.top || 0, 0, 0.9, 0.01, (v) => setC({ top: v }), pct),
    slider('下', c.bottom || 0, 0, 0.9, 0.01, (v) => setC({ bottom: v }), pct),
    slider('左', c.left || 0, 0, 0.9, 0.01, (v) => setC({ left: v }), pct),
    slider('右', c.right || 0, 0, 0.9, 0.01, (v) => setC({ right: v }), pct),
    h('div', { class: 'mini-actions' },
      h('button', { class: 'btn small', onclick: () => { editor.update(el.id, { crop: null }); buildProps(editor.selected); } }, '重設裁切')),
    h('div', { class: 'hint-line' }, '想讓裁切後的圖填滿圖框，把上面「顯示方式」設成「填滿裁切」。'),
  );
  return g;
}

// 陰影：開關 + 角度 + 距離 + 模糊 + 透明度 + 顏色
const SHADOW_DEF = { on: true, angle: 135, distance: 8, blur: 8, color: '#000000', opacity: 0.5 };
function shadowControls(el) {
  const sh = el.shadow || { on: false };
  const set = (patch) => editor.update(el.id, { shadow: { ...SHADOW_DEF, ...(el.shadow || {}), ...patch } });
  const chk = h('input', { type: 'checkbox', ...(sh.on ? { checked: true } : {}), onchange: (e) => { set({ on: e.target.checked }); buildProps(editor.selected); } });
  const g = h('details', { class: 'group', ...(sh.on ? { open: true } : {}) }, h('summary', {}, '陰影'),
    h('label', { class: 'inline' }, chk, h('span', { class: 'hint-line' }, '開啟陰影')));
  if (sh.on) {
    g.append(
      slider('角度', sh.angle ?? 135, 0, 360, 1, (v) => set({ angle: v }), (v) => v + '°'),
      slider('距離', sh.distance ?? 8, 0, 80, 1, (v) => set({ distance: v })),
      slider('模糊', sh.blur ?? 8, 0, 100, 1, (v) => set({ blur: v })),
      slider('陰影透明度', sh.opacity ?? 0.5, 0, 1, 0.05, (v) => set({ opacity: v }), (v) => Math.round(v * 100) + '%'),
      h('label', { class: 'inline' }, h('span', { class: 'hint-line' }, '陰影顏色'),
        h('input', { type: 'color', value: sh.color || '#000000', oninput: (e) => set({ color: e.target.value }) })));
  }
  return g;
}

// 排列 / 對齊 / 翻轉 / 圖層順序 / 複製 / 刪除
function appendLayerControls(pane, el) {
  pane.append(h('hr'));
  pane.append(h('div', { class: 'mini-actions' },
    h('button', { class: 'btn small', onclick: () => editor.alignCenter(el.id, 'x') }, '水平置中'),
    h('button', { class: 'btn small', onclick: () => editor.alignCenter(el.id, 'y') }, '垂直置中'),
    h('button', { class: 'btn small', onclick: () => { editor.duplicateElement(el.id); refreshAfterEdit(); } }, '複製')));
  if (el.type === 'image') {
    pane.append(h('div', { class: 'mini-actions' },
      h('button', { class: 'btn small' + (el.flipH ? ' primary' : ''), onclick: () => { editor.update(el.id, { flipH: !el.flipH }); buildProps(editor.selected); } }, '水平翻轉'),
      h('button', { class: 'btn small' + (el.flipV ? ' primary' : ''), onclick: () => { editor.update(el.id, { flipV: !el.flipV }); buildProps(editor.selected); } }, '垂直翻轉')));
  }
  pane.append(h('div', { class: 'mini-actions' },
    h('button', { class: 'btn small', onclick: () => editor.moveLayer(el.id, 1) }, '上移一層'),
    h('button', { class: 'btn small', onclick: () => editor.moveLayer(el.id, -1) }, '下移一層'),
    h('button', { class: 'btn small', onclick: () => editor.bringToFront(el.id) }, '移到最上'),
    h('button', { class: 'btn small', onclick: () => editor.sendToBack(el.id) }, '移到最下')));
  pane.append(h('button', { class: 'btn small danger block', onclick: () => { editor.removeElement(el.id); refreshAfterEdit(); } }, '刪除此物件'));
}

function setSlider(row, v) { if (row && row._input) { row._input.value = v; row._val.textContent = row._fmt(v); } }

// =============================================================
//  自製模板工具
// =============================================================
$('#newTemplateBtn').addEventListener('click', () => openBuilder(null));
$('#tplName').addEventListener('input', (e) => (state.doc.name = e.target.value));
$('#tplCategory').addEventListener('input', (e) => (state.doc.category = e.target.value));
// 尺寸下拉選單（自製模板工具用）
(function populateSizeSelect() {
  const sel = $('#tplSize');
  for (const p of SIZE_PRESETS) sel.append(h('option', { value: `${p.w}x${p.h}` }, p.label));
})();
$('#tplSize').addEventListener('change', async (e) => { await applyRatio(e.target.value); });
$('#addGradBtn').addEventListener('click', () => {
  editor.addElement(makeGradient({ label: '漸層遮罩', edge: 'bottom', locked: false, color: '#000000', size: 0.4, opacity: 0.85 }));
  buildFillForm();
});
$('#addTextBtn').addEventListener('click', () => {
  // 預設：無外框、無空心（要外框自己在「文字外框」開）
  editor.addElement(makeText({ label: '新文字', text: '輸入文字', x: state.doc.width / 2, y: state.doc.height / 2, size: 64, stroke: null, hollow: false }));
  buildFillForm();
});
$('#addImageBtn').addEventListener('click', () => {
  editor.addElement(makeImage({ label: '圖片框', x: state.doc.width / 2, y: state.doc.height / 2, w: 400, h: 400 }));
  buildFillForm();
});
// 直接上傳一張圖 / LOGO PNG，選好檔就放到畫布中央（依原圖比例縮到適當大小）
$('#addLogoBtn').addEventListener('click', () => {
  pickImage((d) => {
    const ratio = (d.w && d.h) ? d.h / d.w : 1;
    let w = Math.min(560, state.doc.width * 0.6);
    let hh = w * ratio;
    const maxH = state.doc.height * 0.6;
    if (hh > maxH) { hh = maxH; w = hh / ratio; }
    const el = makeImage({ label: 'LOGO / 圖片', x: state.doc.width / 2, y: state.doc.height / 2, w: Math.round(w), h: Math.round(hh), fit: 'contain' });
    el.src = d.src;
    editor.addElement(el);
    editor.select(el.id);
    buildFillForm();
    toast('已加入圖片 ✓');
  });
});
const SHAPE_META = {
  rect: { label: '方形', w: 400, h: 400 }, ellipse: { label: '圓形', w: 400, h: 400 },
  triangle: { label: '三角形', w: 400, h: 360 }, polygon: { label: '多邊形', w: 400, h: 400 },
  star: { label: '星形', w: 400, h: 400 }, line: { label: '線', w: 500, h: 8 },
};
document.querySelectorAll('.addShapeBtn').forEach((btn) => btn.addEventListener('click', () => {
  const t = btn.dataset.shape || 'rect';
  const m = SHAPE_META[t] || SHAPE_META.rect;
  editor.addElement(makeShape({ label: m.label, shape: t, x: state.doc.width / 2, y: state.doc.height / 2, w: m.w, h: m.h, opacity: 1, fill: '#ff4655' }));
  buildFillForm();
}));
// 舊版單一按鈕（若還在）
$('#addShapeBtn')?.addEventListener('click', () => {
  editor.addElement(makeShape({ label: '方形', shape: 'rect', x: state.doc.width / 2, y: state.doc.height / 2, w: 400, h: 400, opacity: 1, fill: '#ff4655' }));
  buildFillForm();
});
$('#addBgBtn').addEventListener('click', () => {
  pickImage((d) => {
    let bg = state.doc.elements.find((x) => x.isBackground);
    if (!bg) {
      bg = makeImage({ label: '背景圖', isBackground: true, x: state.doc.width / 2, y: state.doc.height / 2, w: state.doc.width, h: state.doc.height, fit: 'cover' });
      state.doc.elements.unshift(bg);
    }
    editor.replaceImage(bg.id, d).then(buildFillForm);
  });
});
$('#saveTplBtn').addEventListener('click', () => {
  state.doc.name = $('#tplName').value.trim() || '未命名模板';
  state.doc.category = $('#tplCategory').value.trim() || '自訂';
  store.save(state.doc);
  pushOne('template', state.doc.id, state.doc, state.doc.updatedAt);
  toast('模板已儲存 ✓');
  showView('gallery');
  renderGallery();
  syncNow(true);
});

// =============================================================
//  返回 / 下載 / 匯入匯出
// =============================================================
$('#backBtn').addEventListener('click', () => { showView('gallery'); renderGallery(); });
$('#downloadBtn').addEventListener('click', async () => {
  const type = $('#dlFormat').value;
  const ext = type === 'image/jpeg' ? 'jpg' : 'png';
  toast('產生高解析圖片中…');
  const url = await editor.exportImage(type, 2, 0.95);
  const suffix = state.pages.length > 1 ? `-p${state.pageIndex + 1}` : '';
  await downloadDataURL(url, `${asciiBase()}${suffix}-${timeStamp()}.${ext}`);
  await saveProject(); // 下載後自動存進歷史排版
  toast('已下載 ✓');
});
$('#downloadAllBtn').addEventListener('click', async () => {
  const type = $('#dlFormat').value;
  const ext = type === 'image/jpeg' ? 'jpg' : 'png';
  const stamp = timeStamp();
  toast(`產生 ${state.pages.length} 張圖片中…`);
  for (let i = 0; i < state.pages.length; i++) {
    const url = await Editor.exportDoc(state.pages[i], type, 2, 0.95);
    await downloadDataURL(url, `${asciiBase()}-p${i + 1}-${stamp}.${ext}`);
    await new Promise((r) => setTimeout(r, 400)); // 間隔避免瀏覽器擋多檔下載
  }
  await saveProject();
  toast('已下載全部 ✓');
});
// 檔名只保留 ASCII，避免部分瀏覽器對中文檔名直接丟成 "download"（連副檔名都掉）。
function asciiBase() {
  return (state.doc.name || '').replace(/[^\x20-\x7E]+/g, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'hrnews-post';
}
function timeStamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
// 匯入 SVG 模板
$('#importSvgBtn').addEventListener('click', () => $('#fileSvg').click());
$('#fileSvg').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const tpl = await importSVGFile(f);
    store.save(tpl);
    pushOne('template', tpl.id, tpl, tpl.updatedAt);
    toast('SVG 模板已匯入 ✓');
    renderGallery();
    openBuilder(tpl); // 匯入後直接進編輯，方便擺放文字欄位
  } catch (err) {
    toast('SVG 匯入失敗，請確認檔案');
  }
});
$('#exportAllBtn').addEventListener('click', () => {
  if (store.custom().length === 0) return toast('目前沒有自製模板可匯出');
  store.exportAll();
});
$('#restoreBtn').addEventListener('click', () => {
  const n = store.restoreDefaults();
  toast(n ? `已還原 ${n} 個預設模板 ✓` : '預設模板都在，無需還原');
  renderGallery();
  if (n) syncNow(true);
});
$('#importBtn').addEventListener('click', () => $('#fileImport').click());
$('#fileImport').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try { const n = store.importAll(r.result); toast(`已匯入 ${n} 個模板 ✓`); renderGallery(); syncNow(true); }
    catch (_) { toast('匯入失敗：檔案格式不正確'); }
  };
  r.readAsText(f);
});

// =============================================================
//  Modal（素材庫 / 歷史共用）
// =============================================================
function closeModal() { $('#modalRoot').innerHTML = ''; }
function openModal(title, headActions = []) {
  const body = h('div', { class: 'modal-body' });
  const modal = h('div', { class: 'modal' },
    h('div', { class: 'modal-head' }, h('h3', {}, title),
      h('div', { class: 'head-actions' }, ...headActions, h('button', { class: 'modal-close', onclick: closeModal }, '×'))),
    body);
  const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) closeModal(); } }, modal);
  $('#modalRoot').innerHTML = '';
  $('#modalRoot').append(back);
  return body;
}

// =============================================================
//  素材庫（左側面板 + 自訂分類，IndexedDB）
// =============================================================
const ACAT_KEY = 'hrnews.assetCats';
const ASSET_PAGE_SIZE = 8; // 一頁顯示幾張（每張都完整顯示、好辨識）
const assetCatState = { current: '全部', page: 0 };
const readAssetCats = () => { try { return JSON.parse(localStorage.getItem(ACAT_KEY) || '[]'); } catch (_) { return []; } };
const writeAssetCats = (l) => localStorage.setItem(ACAT_KEY, JSON.stringify(l));

// 上傳：存到目前選的分類
$('#fileAssets').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  const cat = assetCatState.current === '全部' ? '未分類' : assetCatState.current;
  for (const f of files) {
    try {
      const d = await readImageFile(f);
      const a = { id: uid('as'), src: d.src, w: d.w, h: d.h, name: f.name, category: cat, savedAt: Date.now() };
      await assets.put(a);
      pushOne('asset', a.id, a, a.savedAt);
    } catch (_) {}
  }
  renderAssetSide();
});
$('#assetUploadBtn').addEventListener('click', () => $('#fileAssets').click());
$('#assetToggle').addEventListener('click', () => { $('#assetSide').classList.toggle('collapsed'); });
$('#assetSideClose').addEventListener('click', () => $('#assetSide').classList.add('collapsed'));

// 點素材：套到選取中的圖片欄位，否則在畫布新增一個圖片
async function useAsset(a) {
  if (a.component) { // 元件：一次加入多個可編輯元素
    await editor.addComponent(a.component(state.doc.width / 2, state.doc.height / 2, state.doc.width));
    buildFillForm();
    toast('已加入元件（文字可改）');
    return;
  }
  const sel = editor.selected;
  if (sel && sel.type === 'image') {
    await editor.replaceImage(sel.id, { src: a.src, w: a.w, h: a.h });
    buildFillForm();
    if (editor.selectedId === sel.id) buildProps(editor.selected);
  } else {
    const el = makeImage({ label: '素材圖', x: state.doc.width / 2, y: state.doc.height / 2, w: Math.min(500, state.doc.width * 0.5), h: Math.min(500, state.doc.width * 0.5) });
    el.src = a.src;
    if (a.w && a.h) el.h = Math.round(el.w * (a.h / a.w));
    editor.addElement(el);
    buildFillForm();
  }
  toast('已套用素材');
}

async function renderAssetSide() {
  const userList = await assets.list();
  const builtin = BUILTIN_ASSETS.map((a) => ({ ...a, builtin: true }));
  const list = [...builtin, ...userList];
  const userCats = readAssetCats();
  // 分類 = 內建素材的分類 + 使用者自建分類
  const catSet = [];
  for (const a of builtin) if (!catSet.includes(a.category)) catSet.push(a.category);
  for (const c of userCats) if (!catSet.includes(c)) catSet.push(c);
  const cats = ['全部', ...catSet];
  const catBox = $('#assetCats');
  catBox.innerHTML = '';
  for (const c of cats) {
    catBox.append(h('button', { class: 'chip' + (assetCatState.current === c ? ' active' : ''),
      onclick: () => { assetCatState.current = c; assetCatState.page = 0; renderAssetSide(); } }, c));
  }
  catBox.append(h('button', { class: 'chip addcat', title: '新增分類', onclick: () => {
    const name = (prompt('新增素材分類名稱：') || '').trim();
    if (name && !userCats.includes(name) && name !== '全部') { writeAssetCats([...userCats, name]); assetCatState.current = name; assetCatState.page = 0; renderAssetSide(); }
  } }, '＋分類'));
  // 素材格（分頁）
  const grid = $('#assetSideGrid');
  const pager = $('#assetPager');
  grid.innerHTML = ''; pager.innerHTML = '';
  const shown = list.filter((a) => assetCatState.current === '全部' || (a.category || '未分類') === assetCatState.current);
  if (!shown.length) { grid.append(h('p', { class: 'hint-line' }, '這個分類還沒有素材，點「上傳素材」加入。')); return; }
  const totalPages = Math.max(1, Math.ceil(shown.length / ASSET_PAGE_SIZE));
  assetCatState.page = Math.min(Math.max(0, assetCatState.page), totalPages - 1);
  const startIdx = assetCatState.page * ASSET_PAGE_SIZE;
  const pageItems = shown.slice(startIdx, startIdx + ASSET_PAGE_SIZE);
  for (const a of pageItems) {
    const nm = (a.name || '素材').replace(/\.(png|jpe?g|webp|gif|svg)$/i, '');
    grid.append(h('div', { class: 'asset-card pickable', title: nm, onclick: () => useAsset(a) },
      h('img', { src: a.src, alt: nm, loading: 'lazy' }),
      h('div', { class: 'aname' }, nm),
      a.builtin
        ? h('span', { class: 'abuiltin', title: a.name }, '內建')
        : h('button', { class: 'adel', title: '刪除', onclick: async (e) => { e.stopPropagation(); await assets.remove(a.id); delRemote('asset', a.id); renderAssetSide(); } }, '🗑')));
  }
  // 分頁控制（只有超過一頁才顯示）
  if (totalPages > 1) {
    pager.append(
      h('button', { class: 'btn small', ...(assetCatState.page === 0 ? { disabled: true } : {}), onclick: () => { assetCatState.page--; renderAssetSide(); } }, '◀'),
      h('span', { class: 'hint-line' }, `第 ${assetCatState.page + 1} / ${totalPages} 頁（共 ${shown.length} 個）`),
      h('button', { class: 'btn small', ...(assetCatState.page >= totalPages - 1 ? { disabled: true } : {}), onclick: () => { assetCatState.page++; renderAssetSide(); } }, '▶'));
  }
}
function initAssetSide() {
  $('#assetSide').classList.toggle('collapsed', window.innerWidth < 860); // 手機預設收合
  renderAssetSide();
}

// =============================================================
//  歷史排版（projects，IndexedDB）
// =============================================================
async function saveProject() {
  if (state.mode !== 'post' || !state.pages.length) return;
  if (!state.projectId) state.projectId = uid('proj');
  let thumb = '';
  try { thumb = await Editor.renderThumb(deepClone(state.pages[0]), 240); } catch (_) {}
  const proj = { id: state.projectId, name: state.projectName || state.doc.name || '貼文',
    pages: JSON.stringify(state.pages), thumb, count: state.pages.length, savedAt: Date.now() };
  await projects.put(proj);
  pushOne('project', proj.id, proj, proj.savedAt);
}
async function openProject(pr) {
  state.mode = 'post';
  state.editingCustomId = null;
  state.pages = JSON.parse(pr.pages);
  state.pageIndex = 0;
  state.doc = state.pages[0];
  state.projectId = pr.id;
  state.projectName = pr.name;
  $('#builderTools').classList.add('hidden');
  $('#pageBar').classList.remove('hidden');
  $('#editorTitle').textContent = pr.name + '（歷史）';
  showView('editor');
  closeModal();
  initAssetSide();
  await editor.setDoc(state.doc);
  buildFillForm();
  renderPageStrip();
  activateTab('fill');
  histReset();
}
async function openHistory() {
  const body = openModal('歷史排版（點一張繼續編輯）');
  const grid = h('div', { class: 'asset-grid' });
  body.append(grid);
  const list = await projects.list();
  if (!list.length) { grid.append(h('p', { class: 'modal-empty' }, '還沒有歷史紀錄。做好一張貼文按「下載」就會自動存進這裡。')); return; }
  for (const pr of list) {
    grid.append(h('div', { class: 'asset-card pickable', onclick: () => openProject(pr) },
      h('img', { src: pr.thumb || '', alt: pr.name }),
      h('div', { class: 'aname' }, `${pr.name}・${pr.count || 1}頁`),
      h('button', { class: 'adel', title: '刪除', onclick: async (e) => { e.stopPropagation(); await projects.remove(pr.id); delRemote('project', pr.id); openHistory(); } }, '🗑')));
  }
}
$('#historyBtn').addEventListener('click', openHistory);

// =============================================================
//  雲端同步（Supabase，Email 登入，同步模板/素材/歷史）
// =============================================================
function updateSyncBtn() { $('#syncBtn').textContent = state.user ? '☁ 已同步' : '☁ 同步'; }

// 蒐集本機所有可同步項目（跳過未編輯過的內建模板）
async function collectLocal() {
  const out = [];
  for (const t of store.all()) if (t.updatedAt || !t.fromBuiltin) out.push({ kind: 'template', item_id: t.id, data: t, updated_at: t.updatedAt || 1 });
  for (const a of await assets.list()) out.push({ kind: 'asset', item_id: a.id, data: a, updated_at: a.savedAt || 1 });
  for (const p of await projects.list()) out.push({ kind: 'project', item_id: p.id, data: p, updated_at: p.savedAt || 1 });
  // 「已刪除的預設模板」清單也同步，讓刪除跨裝置一致、且不會被種回來
  const del = store.getDeleted();
  if (del.updatedAt) out.push({ kind: 'meta', item_id: 'deletedBuiltins', data: del, updated_at: del.updatedAt });
  return out;
}
function applyLocal(kind, data) {
  if (kind === 'template') store.upsertRaw(data);
  else if (kind === 'asset') assets.put(data);
  else if (kind === 'project') projects.put(data);
  else if (kind === 'meta' && data && data.ids) store.setDeleted(data);
}
function removeLocalItem(kind, id) {
  if (kind === 'template') store.remove(id);
  else if (kind === 'asset') assets.remove(id);
  else if (kind === 'project') projects.remove(id);
}
// 有登入時把單一項目推上雲端（fire-and-forget）
function pushOne(kind, id, data, updated) {
  if (state.user) pushRemote([{ kind, item_id: id, data, updated_at: updated || Date.now() }]).catch(() => {});
}
function delRemote(kind, id) { if (state.user) markDeleted(kind, id); }

let syncing = false;
async function syncNow(silent) {
  if (!state.user || syncing) return;
  syncing = true;
  try {
    const remote = await fetchRemote();
    const rmap = new Map(remote.map((r) => [r.kind + ':' + r.item_id, r]));
    const local = await collectLocal();
    // 雲端較新 → 覆蓋本機；雲端墓碑 → 刪本機
    for (const r of remote) {
      const l = local.find((x) => x.kind === r.kind && x.item_id === r.item_id);
      const rt = new Date(r.updated_at).getTime();
      if (r.deleted) { if (l && rt >= l.updated_at) removeLocalItem(r.kind, r.item_id); continue; }
      if (!l || rt > l.updated_at) applyLocal(r.kind, r.data);
    }
    // 本機較新 / 雲端沒有 → 推上去
    const toPush = [];
    for (const l of local) {
      const r = rmap.get(l.kind + ':' + l.item_id);
      const rt = r ? new Date(r.updated_at).getTime() : -1;
      if (!r || l.updated_at > rt) toPush.push({ kind: l.kind, item_id: l.item_id, data: l.data, updated_at: l.updated_at });
    }
    if (toPush.length) await pushRemote(toPush);
    store.setDeleted(store.getDeleted()); // 保險：把已刪除的預設模板再清一次（避免舊 template 列又被種回來）
    renderGallery();
    if (!$('#editorView').classList.contains('hidden')) renderAssetSide();
    if (!silent) toast('已同步 ✓');
  } catch (e) {
    if (!silent) toast('同步失敗：' + (e.message || e));
  } finally { syncing = false; }
}

// =============================================================
//  自動儲存 + 自動同步（任何更改都會自動存進歷史／模板，並推上雲端）
// =============================================================
let saveStatusTimer = null;
function setSaveStatus(text, cls) {
  const el = $('#saveStatus');
  if (!el) return;
  el.textContent = text;
  el.className = 'save-status show ' + (cls || '');
  clearTimeout(saveStatusTimer);
  if (cls === 'saved') saveStatusTimer = setTimeout(() => el.classList.remove('show'), 2000);
}

let autosaveTimer = null, autosaveRunning = false, autosaveDirty = false;
function scheduleAutoSave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(runAutoSave, 900);
}
async function runAutoSave() {
  if (autosaveRunning) { autosaveDirty = true; return; }
  autosaveRunning = true;
  setSaveStatus(state.user ? '儲存並同步中…' : '儲存中…', 'saving');
  try {
    if (state.mode === 'post') {
      if (state.pages.length) await saveProject();        // 存進歷史 + 推上雲端
    } else if (state.mode === 'build' && state.doc) {
      const nameEl = $('#tplName'), catEl = $('#tplCategory');
      if (nameEl && nameEl.value.trim()) state.doc.name = nameEl.value.trim();
      if (catEl && catEl.value.trim()) state.doc.category = catEl.value.trim();
      store.save(state.doc);                              // 存模板（更新 updatedAt）
      pushOne('template', state.doc.id, state.doc, state.doc.updatedAt); // 推上雲端
    }
    setSaveStatus(state.user ? '已儲存並同步 ✓' : '已儲存 ✓', 'saved');
  } catch (_) {
    setSaveStatus('儲存失敗，稍後自動重試', 'saving');
  } finally {
    autosaveRunning = false;
    if (autosaveDirty) { autosaveDirty = false; scheduleAutoSave(); }
  }
}

function openSyncModal() {
  const body = openModal('雲端同步（Supabase）');
  const cfg = syncCfg.get();
  const urlIn = h('input', { type: 'text', value: cfg.url || '', placeholder: 'https://xxxx.supabase.co' });
  const keyIn = h('input', { type: 'text', value: cfg.key || '', placeholder: 'anon public key' });
  body.append(h('div', { class: 'group' }, h('div', { class: 'g-label' }, '1. 連線設定'),
    h('label', { class: 'prop' }, h('span', {}, 'Project URL'), urlIn),
    h('label', { class: 'prop' }, h('span', {}, 'anon public key'), keyIn),
    h('button', { class: 'btn small', onclick: () => { if (!urlIn.value.trim() || !keyIn.value.trim()) return toast('請填 URL 與 key'); syncCfg.set(urlIn.value, keyIn.value); toast('已儲存'); openSyncModal(); } }, '儲存連線設定'),
    h('div', { class: 'hint-line' }, 'Supabase 專案 → Project Settings → API 可找到 URL 與 anon public key。第一次使用請先照 README 在 SQL Editor 建好 items 表。')));

  if (!syncCfg.configured()) return;

  const authBox = h('div', { class: 'group' }, h('div', { class: 'g-label' }, '2. 登入 / 同步'));
  body.append(authBox);
  if (state.user) {
    authBox.append(
      h('div', { class: 'hint-line' }, '已登入：' + (state.user.email || '')),
      h('div', { class: 'mini-actions' },
        h('button', { class: 'btn small primary', onclick: async () => { await syncNow(); } }, '立即同步'),
        h('button', { class: 'btn small', onclick: async () => { await signOut(); state.user = null; updateSyncBtn(); openSyncModal(); toast('已登出'); } }, '登出')));
  } else {
    const email = h('input', { type: 'text', placeholder: 'you@example.com' });
    const pass = h('input', { type: 'password', placeholder: '密碼（至少 6 碼）' });
    const doLogin = async (isSignup) => {
      try {
        if (isSignup) { await signUp(email.value.trim(), pass.value); toast('已註冊，請直接登入（若開了信箱驗證，先去收信）'); }
        state.user = await signIn(email.value.trim(), pass.value);
        updateSyncBtn();
        toast('登入成功，同步中…');
        openSyncModal();
        await syncNow();
      } catch (e) { toast('失敗：' + (e.message || e)); }
    };
    authBox.append(
      h('button', { class: 'btn small primary', style: 'width:100%;justify-content:center', onclick: async () => { try { toast('前往 GitHub 登入…'); await signInWithGitHub(); } catch (e) { toast('失敗：' + (e.message || e)); } } }, '用 GitHub 登入'),
      h('div', { class: 'hint-line', style: 'text-align:center;margin:6px 0' }, '── 或用 Email ──'),
      h('label', { class: 'prop' }, h('span', {}, 'Email'), email),
      h('label', { class: 'prop' }, h('span', {}, '密碼'), pass),
      h('div', { class: 'mini-actions' },
        h('button', { class: 'btn small primary', onclick: () => doLogin(false) }, '登入'),
        h('button', { class: 'btn small', onclick: () => doLogin(true) }, '註冊新帳號')));
  }
}
$('#syncBtn').addEventListener('click', openSyncModal);

// =============================================================
//  模板分類管理
// =============================================================
function openCatManager() {
  const body = openModal('管理模板分類');
  const addIn = h('input', { type: 'text', placeholder: '新分類名稱' });
  body.append(h('div', { class: 'group' }, h('div', { class: 'g-label' }, '新增分類'),
    h('div', { class: 'mini-actions' }, addIn,
      h('button', { class: 'btn small primary', onclick: () => { if (addIn.value.trim()) { store.addCategory(addIn.value); addIn.value = ''; openCatManager(); renderGallery(); } } }, '新增'))));
  const listBox = h('div', { class: 'group' }, h('div', { class: 'g-label' }, '現有分類（改名會一併更新該分類的模板）'));
  for (const c of store.categories()) {
    if (c === '未分類') continue;
    listBox.append(h('div', { class: 'mini-actions', style: 'align-items:center' },
      h('span', { style: 'flex:1;font-weight:700' }, c),
      h('button', { class: 'btn small', onclick: () => { const n = (prompt('改名為：', c) || '').trim(); if (n) { store.renameCategory(c, n); openCatManager(); renderGallery(); syncNow(true); } } }, '改名'),
      h('button', { class: 'btn small danger', onclick: () => { if (confirm(`刪除分類「${c}」？該分類的模板會移到「未分類」。`)) { store.removeCategory(c); openCatManager(); renderGallery(); syncNow(true); } } }, '刪除')));
  }
  body.append(listBox);
}
$('#manageCatBtn').addEventListener('click', openCatManager);

// =============================================================
//  預覽（乾淨成品，沒有選取框 / 空框虛線）
// =============================================================
async function openPreview() {
  const body = openModal('預覽（成品樣子）');
  const img = h('img', { class: 'preview-img', alt: '預覽' });
  body.append(img);
  try { img.src = await editor.exportImage('image/png', 1); }
  catch (_) { img.replaceWith(h('p', { class: 'modal-empty' }, '預覽產生失敗')); }
}
$('#previewBtn').addEventListener('click', openPreview);

// =============================================================
//  復原 / 重做（Ctrl+Z / Ctrl+Y、預設記憶 100 步）
// =============================================================
const HIST_MAX = 100;
const history = { stack: [], idx: -1, applying: false, timer: null };
const histSnapshot = () => JSON.stringify(state.doc);
function histReset() {
  clearTimeout(history.timer);
  history.stack = [histSnapshot()];
  history.idx = 0;
}
function histCommit() {
  const snap = histSnapshot();
  if (snap === history.stack[history.idx]) return;
  history.stack = history.stack.slice(0, history.idx + 1);
  history.stack.push(snap);
  if (history.stack.length > HIST_MAX) history.stack.shift();
  history.idx = history.stack.length - 1;
}
function histRecord() {
  if (history.applying) return;
  clearTimeout(history.timer);
  history.timer = setTimeout(histCommit, 300);
}
async function histApply(snap) {
  history.applying = true;
  const doc = JSON.parse(snap);
  state.pages[state.pageIndex] = doc;
  state.doc = doc;
  await editor.setDoc(doc);
  buildFillForm();
  buildProps(null);
  renderPageStrip();
  history.applying = false;
}
async function undo() {
  clearTimeout(history.timer);
  histCommit(); // 先把還沒記錄的最新狀態存起來
  if (history.idx > 0) { history.idx--; await histApply(history.stack[history.idx]); scheduleAutoSave(); toast('已復原'); }
}
async function redo() {
  if (history.idx < history.stack.length - 1) { history.idx++; await histApply(history.stack[history.idx]); scheduleAutoSave(); toast('已重做'); }
}
function isTypingTarget(t) {
  return t && (t.tagName === 'TEXTAREA' || t.isContentEditable || (t.tagName === 'INPUT' && /^(text|number|search|url|email|password)$/.test(t.type)));
}
let clipboard = null;
const inEditor = () => !$('#editorView').classList.contains('hidden');
function refreshAfterEdit() { buildFillForm(); if (!$('#layersPanel').classList.contains('hidden')) renderLayers(); }

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey) {
    if (isTypingTarget(e.target)) return; // 文字欄位內走瀏覽器原生行為
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
    else if (k === 'd' && inEditor()) { e.preventDefault(); const s = editor.selected; if (s) { editor.duplicateElement(s.id); refreshAfterEdit(); } }
    else if (k === 'c' && inEditor()) { const s = editor.selected; if (s) clipboard = deepClone(s); }
    else if (k === 'v' && inEditor()) { if (clipboard) { e.preventDefault(); editor.pasteElement(clipboard); refreshAfterEdit(); } }
    return;
  }
  if (isTypingTarget(e.target) || !inEditor()) return;
  // Delete / Backspace 刪除
  if (e.key === 'Delete' || e.key === 'Backspace') {
    const sel = editor.selected;
    if (sel) { e.preventDefault(); editor.removeElement(sel.id); refreshAfterEdit(); }
    return;
  }
  // 方向鍵微移（Shift = 一次 10px）
  const nudge = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (nudge) {
    const sel = editor.selected;
    if (sel) { e.preventDefault(); const s = e.shiftKey ? 10 : 1; editor.update(sel.id, { x: sel.x + nudge[0] * s, y: sel.y + nudge[1] * s }); }
  }
});

// =============================================================
//  啟動
// =============================================================
editor = new Editor($('#board'), $('#overlay'));
editor.onSelect = (el) => { buildProps(el); if (!$('#layersPanel').classList.contains('hidden')) renderLayers(); if (el && $('#layersPanel').classList.contains('hidden')) activateTab('props'); };
editor.onChange = () => { state.syncProps && state.syncProps(); histRecord(); scheduleAutoSave(); };
renderGallery();

// 若已設定並登入過，載入時自動同步
updateSyncBtn();
currentUser().then((u) => { state.user = u; updateSyncBtn(); if (u) syncNow(true); }).catch(() => {});

// 切回這個分頁 / 視窗重新聚焦時，自動拉一次雲端（讓其他裝置的新增/刪除即時出現）
let lastPull = 0;
function pullIfIdle() {
  if (!state.user) return;
  const now = Date.now();
  if (now - lastPull < 4000) return; // 節流，避免頻繁切換狂拉
  lastPull = now;
  syncNow(true);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pullIfIdle(); });
window.addEventListener('focus', pullIfIdle);

// 加上 ?debug 可在 console 取用 editor（方便進階操作／測試），一般使用者不受影響。
if (new URLSearchParams(location.search).has('debug')) window.__editor = editor;
