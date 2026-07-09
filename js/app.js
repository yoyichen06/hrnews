// 主控制器：串起模板一覽、快速填寫、微調面板、自製模板、匯出下載。

import { Editor } from './editor.js';
import { store } from './store.js';
import { instantiate, newBlankTemplate, makeText, makeImage, makeShape, makeGradient,
         SIZE_PRESETS, BLEND_MODES } from './builtins.js';
import { FONTS } from './fonts.js';
import { importSVGFile } from './svg.js';
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
const state = { mode: 'post', doc: null, pages: [], pageIndex: 0, filter: '全部', editingCustomId: null, syncProps: null };
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
      h('button', { class: 'icon-btn', title: '編輯模板', onclick: (e) => { e.stopPropagation(); openBuilder(tpl); } }, '✎'),
      h('button', { class: 'icon-btn', title: '複製一份', onclick: (e) => { e.stopPropagation(); duplicateToCustom(tpl); } }, '⧉'),
      h('button', { class: 'icon-btn', title: '刪除模板', onclick: (e) => { e.stopPropagation(); if (confirm(`刪除模板「${tpl.name}」？`)) { store.remove(tpl.id); renderGallery(); } } }, '🗑'));
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
  toast('已複製為自製模板 ✓');
  renderGallery();
}

function showView(id) {
  $('#galleryView').classList.toggle('hidden', id !== 'gallery');
  $('#editorView').classList.toggle('hidden', id !== 'editor');
  window.scrollTo(0, 0);
}

async function openPost(tpl) {
  state.mode = 'post';
  state.editingCustomId = null;
  state.pages = [instantiate(tpl)];
  state.pageIndex = 0;
  state.doc = state.pages[0];
  $('#builderTools').classList.add('hidden');
  $('#pageBar').classList.remove('hidden'); // 多頁只在套版產文時出現
  $('#editorTitle').textContent = tpl.name;
  showView('editor');
  await editor.setDoc(state.doc);
  buildFillForm();
  renderPageStrip();
  activateTab('fill');
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
  await editor.setDoc(doc);
  buildFillForm();
  activateTab('fill');
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

// 單一欄位的填寫區塊
function fieldGroup(el, isFixed = false) {
  if (el.type === 'text') {
    const ta = h('textarea', { rows: el.text.length > 18 ? 3 : 1, oninput: (e) => editor.update(el.id, { text: e.target.value }) });
    ta.value = el.text;
    const g = h('div', { class: 'group' },
      h('div', { class: 'g-label' }, el.label, h('span', { class: 'badge' }, isFixed ? '固定' : '文字')), ta);
    // 顏色（例如 VAL NEWS 小字）
    g.append(h('label', { class: 'inline' }, h('span', { class: 'hint-line' }, '顏色'),
      h('input', { type: 'color', value: el.color, oninput: (e) => editor.update(el.id, { color: e.target.value }) })));
    g.append(h('button', { class: 'btn small', onclick: () => { editor.select(el.id); activateTab('props'); } }, '微調位置 / 大小 / 字型'));
    return g;
  }
  if (el.type === 'shape') {
    // 例如分類標籤底色膠囊：只需改顏色（大小/位置到微調調）
    return h('div', { class: 'group' },
      h('div', { class: 'g-label' }, el.label, h('span', { class: 'badge' }, isFixed ? '固定' : '色塊')),
      h('label', { class: 'inline' }, h('span', { class: 'hint-line' }, '顏色'),
        h('input', { type: 'color', value: el.fill, oninput: (e) => editor.update(el.id, { fill: e.target.value }) })),
      h('button', { class: 'btn small', onclick: () => { editor.select(el.id); activateTab('props'); } }, '微調大小 / 位置'));
  }
  // image
  const g = h('div', { class: 'group' }, h('div', { class: 'g-label' }, el.label, h('span', { class: 'badge' }, isFixed ? '固定' : '圖片')));
  if (el.hint) g.append(h('div', { class: 'hint-line' }, el.hint));
  if (el.src) g.append(h('img', { class: 'thumb-preview', src: el.src }));
  g.append(h('div', { class: 'mini-actions' },
    h('button', { class: 'btn small', onclick: () => pickImage((d) => editor.replaceImage(el.id, d).then(buildFillForm)) }, el.src ? '替換圖片' : '上傳圖片'),
    el.src ? h('button', { class: 'btn small', onclick: () => { editor.clearImage(el.id); buildFillForm(); } }, '清除') : null,
    h('button', { class: 'btn small', onclick: () => { editor.select(el.id); activateTab('props'); } }, '微調')));
  return g;
}

// 背景設定：背景圖 + 疊加圖層(混合模式/不透明度) + 上下漸層遮罩
function buildBackgroundGroup(bgEl, ovEl, grads) {
  const g = h('div', { class: 'group' }, h('div', { class: 'g-label' }, '背景設定', h('span', { class: 'badge' }, '背景 / 疊加 / 遮罩')));

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
    const radius = slider('圓角', el.radius || 0, 0, Math.round(Math.min(el.w, el.h) / 2), 1, (v) => editor.update(el.id, { radius: v }));
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
      sizeS, radius, posX, posY, opacity,
    );
    state.syncProps = () => { setSlider(sizeS, Math.round(el.w)); setSlider(posX, Math.round(el.x)); setSlider(posY, Math.round(el.y)); };
  } else if (el.type === 'shape') {
    const color = h('input', { type: 'color', value: el.fill, oninput: (e) => editor.update(el.id, { fill: e.target.value }) });
    const wS = slider('寬度', Math.round(el.w), 10, D.width * 1.5, 2, (v) => editor.update(el.id, { w: v }));
    const hS = slider('高度', Math.round(el.h), 10, D.height * 1.5, 2, (v) => editor.update(el.id, { h: v }));
    const radius = slider('圓角', el.radius || 0, 0, 400, 1, (v) => editor.update(el.id, { radius: v }));
    pane.append(h('label', { class: 'prop' }, h('span', {}, '顏色'), color), wS, hS, radius, posX, posY, opacity);
    state.syncProps = () => { setSlider(wS, Math.round(el.w)); setSlider(hS, Math.round(el.h)); setSlider(posX, Math.round(el.x)); setSlider(posY, Math.round(el.y)); };
  }

  appendLayerControls(pane, el);
}

// 圖層順序 + 移除（移除僅在自製/編輯模板時提供）
function appendLayerControls(pane, el) {
  pane.append(h('hr'), h('div', { class: 'mini-actions' },
    h('button', { class: 'btn small', onclick: () => editor.moveLayer(el.id, 1) }, '上移一層'),
    h('button', { class: 'btn small', onclick: () => editor.moveLayer(el.id, -1) }, '下移一層')));
  if (state.mode === 'build') {
    pane.append(h('button', { class: 'btn small danger block', onclick: () => { editor.removeElement(el.id); buildFillForm(); } }, '移除此物件'));
  }
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
  editor.addElement(makeText({ label: '新文字', text: '輸入文字', x: state.doc.width / 2, y: state.doc.height / 2, size: 64 }));
  buildFillForm();
});
$('#addImageBtn').addEventListener('click', () => {
  editor.addElement(makeImage({ label: '圖片框', x: state.doc.width / 2, y: state.doc.height / 2, w: 400, h: 400 }));
  buildFillForm();
});
$('#addShapeBtn').addEventListener('click', () => {
  editor.addElement(makeShape({ label: '色塊', x: state.doc.width / 2, y: state.doc.height / 2, w: 600, h: 200, opacity: 1, fill: '#ff4655' }));
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
  toast('模板已儲存 ✓');
  showView('gallery');
  renderGallery();
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
});
$('#importBtn').addEventListener('click', () => $('#fileImport').click());
$('#fileImport').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try { const n = store.importAll(r.result); toast(`已匯入 ${n} 個模板 ✓`); renderGallery(); }
    catch (_) { toast('匯入失敗：檔案格式不正確'); }
  };
  r.readAsText(f);
});

// =============================================================
//  啟動
// =============================================================
editor = new Editor($('#board'), $('#overlay'));
editor.onSelect = (el) => { buildProps(el); if (el) activateTab('props'); };
editor.onChange = () => { state.syncProps && state.syncProps(); };
renderGallery();

// 加上 ?debug 可在 console 取用 editor（方便進階操作／測試），一般使用者不受影響。
if (new URLSearchParams(location.search).has('debug')) window.__editor = editor;
