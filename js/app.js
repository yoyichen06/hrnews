// 主控制器：串起模板一覽、快速填寫、微調面板、自製模板、匯出下載。

import { Editor } from './editor.js';
import { store } from './store.js';
import { instantiate, newBlankTemplate, makeText, makeImage, makeShape } from './builtins.js';
import { FONTS } from './fonts.js';
import { readImageFile, downloadDataURL, deepClone, clamp } from './util.js';

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
const state = { mode: 'post', doc: null, filter: '全部', editingCustomId: null, syncProps: null };
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
    const actions = tpl.custom
      ? h('div', { class: 'card-actions' },
          h('button', { class: 'icon-btn', title: '編輯模板', onclick: (e) => { e.stopPropagation(); openBuilder(tpl); } }, '✎'),
          h('button', { class: 'icon-btn', title: '刪除模板', onclick: (e) => { e.stopPropagation(); if (confirm(`刪除模板「${tpl.name}」？`)) { store.remove(tpl.id); renderGallery(); } } }, '🗑'))
      : null;
    grid.append(h('div', { class: 'card', onclick: () => openPost(tpl) },
      img,
      tpl.custom ? h('span', { class: 'tag-custom' }, '自製') : null,
      actions,
      h('div', { class: 'meta' }, h('div', { class: 'name' }, tpl.name), h('div', { class: 'cat' }, tpl.category || '未分類'))));
  }
}

// =============================================================
//  開啟編輯器
// =============================================================
function showView(id) {
  $('#galleryView').classList.toggle('hidden', id !== 'gallery');
  $('#editorView').classList.toggle('hidden', id !== 'editor');
  window.scrollTo(0, 0);
}

async function openPost(tpl) {
  state.mode = 'post';
  state.editingCustomId = null;
  state.doc = instantiate(tpl);
  $('#builderTools').classList.add('hidden');
  $('#editorTitle').textContent = tpl.name;
  showView('editor');
  await editor.setDoc(state.doc);
  buildFillForm();
  activateTab('fill');
}

async function openBuilder(tpl) {
  state.mode = 'build';
  const doc = tpl ? deepClone(tpl) : newBlankTemplate();
  state.editingCustomId = tpl ? tpl.id : null;
  state.doc = doc;
  $('#builderTools').classList.remove('hidden');
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
  // 底色
  pane.append(h('label', { class: 'prop' }, h('span', {}, '底色'),
    h('input', { type: 'color', value: state.doc.bgColor || '#111318', oninput: (e) => editor.setBg(e.target.value) })));

  for (const el of state.doc.elements) {
    if (el.editable === false) continue;
    if (el.type === 'text') {
      const ta = h('textarea', { rows: el.text.length > 18 ? 3 : 1, oninput: (e) => editor.update(el.id, { text: e.target.value }) });
      ta.value = el.text;
      pane.append(h('div', { class: 'group' },
        h('div', { class: 'g-label' }, el.label, h('span', { class: 'badge' }, '文字')),
        ta,
        h('button', { class: 'btn small', onclick: () => { editor.select(el.id); activateTab('props'); } }, '微調位置 / 大小 / 字型')));
    } else if (el.type === 'image') {
      const g = h('div', { class: 'group' }, h('div', { class: 'g-label' }, el.label, h('span', { class: 'badge' }, '圖片')));
      if (el.hint) g.append(h('div', { class: 'hint-line' }, el.hint));
      if (el.src) g.append(h('img', { class: 'thumb-preview', src: el.src }));
      g.append(h('div', { class: 'mini-actions' },
        h('button', { class: 'btn small', onclick: () => pickImage((d) => editor.replaceImage(el.id, d).then(refreshFillImage)) }, el.src ? '替換圖片' : '上傳圖片'),
        el.src ? h('button', { class: 'btn small', onclick: () => { editor.clearImage(el.id); refreshFillImage(); } }, '清除') : null,
        h('button', { class: 'btn small', onclick: () => { editor.select(el.id); activateTab('props'); } }, '微調')));
      pane.append(g);
    }
  }
}
// 圖片變更後重建表單（更新縮圖與按鈕文字）
function refreshFillImage() { buildFillForm(); }

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
  const head = h('div', { class: 'g-label' }, el.label || el.type,
    h('span', { class: 'badge' }, el.type === 'text' ? '文字' : el.type === 'image' ? '圖片' : '色塊'));
  pane.append(head);

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
    pane.append(
      h('div', { class: 'mini-actions' },
        h('button', { class: 'btn small', onclick: () => pickImage((d) => editor.replaceImage(el.id, d).then(() => { buildProps(editor.selected); buildFillForm(); })) }, el.src ? '替換圖片' : '上傳圖片'),
        el.src ? h('button', { class: 'btn small', onclick: () => { editor.clearImage(el.id); buildProps(editor.selected); buildFillForm(); } }, '清除') : null),
      h('label', { class: 'prop' }, h('span', {}, '顯示方式'), fit),
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

  // 圖層與刪除
  const layerRow = h('div', { class: 'mini-actions' },
    h('button', { class: 'btn small', onclick: () => editor.moveLayer(el.id, 1) }, '上移一層'),
    h('button', { class: 'btn small', onclick: () => editor.moveLayer(el.id, -1) }, '下移一層'));
  pane.append(h('hr'), layerRow);
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
$('#tplSize').addEventListener('change', async (e) => {
  const [w, hh] = e.target.value.split('x').map(Number);
  state.doc.width = w; state.doc.height = hh;
  const bg = state.doc.elements.find((x) => x.isBackground);
  if (bg) { bg.x = w / 2; bg.y = hh / 2; bg.w = w; bg.h = hh; }
  await editor.setDoc(state.doc);
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
  toast('產生高解析圖片中…');
  const url = await editor.exportPNG(2);
  const name = (state.doc.name || 'post').replace(/[^\w一-鿿-]+/g, '_');
  downloadDataURL(url, `${name}-${Date.now()}.png`);
  toast('已下載 ✓');
});
$('#exportAllBtn').addEventListener('click', () => {
  if (store.custom().length === 0) return toast('目前沒有自製模板可匯出');
  store.exportAll();
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
