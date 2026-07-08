// 儲存層：自製模板存在瀏覽器 localStorage（同一台裝置會保留）。
// 想在手機↔電腦之間搬動模板，用「匯出全部 / 匯入」把模板包成 JSON 檔即可。

import { BUILTIN_TEMPLATES } from './builtins.js';
import { downloadText } from './util.js';

const KEY = 'hrnews.customTemplates.v1';

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

export const store = {
  // 所有模板 = 內建 + 自製
  all() {
    return [...BUILTIN_TEMPLATES, ...read()];
  },
  custom() {
    return read();
  },
  get(id) {
    return this.all().find((t) => t.id === id) || null;
  },
  // 新增或更新一張自製模板
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
  // 目前所有分類（內建 + 自製，去重，保留順序）
  categories() {
    const seen = new Set();
    const cats = [];
    for (const t of this.all()) {
      const c = t.category || '未分類';
      if (!seen.has(c)) {
        seen.add(c);
        cats.push(c);
      }
    }
    return cats;
  },
  // 匯出全部自製模板成 JSON 檔
  exportAll() {
    const data = { app: 'hrnews-templates', version: 1, exportedAt: Date.now(), templates: read() };
    downloadText(JSON.stringify(data, null, 2), `hrnews-templates-${new Date().toISOString().slice(0, 10)}.json`);
  },
  // 從 JSON 匯入（合併：同 id 覆蓋）
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
