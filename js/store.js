// 儲存層：所有模板（含預設）都存在瀏覽器 localStorage，因此預設模板也可以編輯、
// 儲存（LOGO / 外框會被記住）、刪除、複製。想在手機↔電腦之間搬動，用「匯出全部 / 匯入」。

import { BUILTIN_TEMPLATES } from './builtins.js';
import { downloadText, deepClone } from './util.js';

const KEY = 'hrnews.templates.v2';
const SEED_KEY = 'hrnews.seedVer';
const SEED_VER = '5'; // 改內建模板時把版本 +1，未被使用者改過的內建副本會自動更新

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]');
  } catch (_) {
    return [];
  }
}
function write(list) {
  localStorage.setItem(KEY, JSON.stringify(list));
}

// 把某個預設模板做成一份「可編輯」的副本
function fromBuiltin(b) {
  const c = deepClone(b);
  c.custom = true;
  c.fromBuiltin = b.id; // 記住來源，之後「還原預設」用得到
  delete c.builtin;
  return c;
}

// 建立/升級預設模板：
//  - 缺少的預設模板 → 補上
//  - 使用者「沒改過」的預設模板（沒有 updatedAt）→ 換成最新定義（例如加上新外框）
//  - 使用者「改過並儲存過」的模板 → 保留不動
function migrate() {
  if (localStorage.getItem(SEED_KEY) === SEED_VER) return;
  let list = read();
  // 從更舊的 key 搬移使用者既有的自製模板
  if (list.length === 0) {
    try { list = JSON.parse(localStorage.getItem('hrnews.customTemplates.v1') || '[]'); } catch (_) { list = []; }
  }
  const byBuiltin = new Map();
  for (const t of list) if (t.fromBuiltin) byBuiltin.set(t.fromBuiltin, t);
  for (const b of BUILTIN_TEMPLATES) {
    const ex = byBuiltin.get(b.id);
    if (!ex) list.push(fromBuiltin(b));
    else if (!ex.updatedAt) list[list.indexOf(ex)] = fromBuiltin(b);
  }
  write(list);
  localStorage.setItem(SEED_KEY, SEED_VER);
}
migrate();

export const store = {
  all() {
    return read();
  },
  custom() {
    return read();
  },
  get(id) {
    return this.all().find((t) => t.id === id) || null;
  },
  save(tpl) {
    const list = read();
    const idx = list.findIndex((t) => t.id === tpl.id);
    tpl.custom = true;
    tpl.updatedAt = Date.now();
    if (idx >= 0) list[idx] = tpl;
    else list.push(tpl);
    write(list);
    return tpl;
  },
  remove(id) {
    write(read().filter((t) => t.id !== id));
  },
  categories() {
    const seen = new Set();
    const cats = [];
    for (const t of this.all()) {
      const c = t.category || '未分類';
      if (!seen.has(c)) { seen.add(c); cats.push(c); }
    }
    return cats;
  },
  // 還原：把被刪掉的預設模板加回來（不動已存在的）
  restoreDefaults() {
    const list = read();
    const have = new Set(list.map((t) => t.fromBuiltin).filter(Boolean));
    let added = 0;
    for (const b of BUILTIN_TEMPLATES) if (!have.has(b.id)) { list.push(fromBuiltin(b)); added++; }
    write(list);
    return added;
  },
  exportAll() {
    const data = { app: 'hrnews-templates', version: 2, exportedAt: Date.now(), templates: read() };
    downloadText(JSON.stringify(data, null, 2), `hrnews-templates-${new Date().toISOString().slice(0, 10)}.json`);
  },
  importAll(json) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    const incoming = Array.isArray(data) ? data : data.templates || [];
    const list = read();
    let added = 0;
    for (const t of incoming) {
      if (!t || !t.id) continue;
      const idx = list.findIndex((x) => x.id === t.id);
      t.custom = true;
      if (idx >= 0) list[idx] = t;
      else list.push(t);
      added++;
    }
    write(list);
    return added;
  },
};
