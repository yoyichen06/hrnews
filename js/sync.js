// 雲端同步（Supabase）：Email 登入 + 一張 items 表存所有資料（模板/素材/歷史）。
// Supabase 只在「有設定且需要用」時才動態載入，沒設定的使用者完全不受影響。
//
// 需要在 Supabase SQL Editor 先執行（見 README「雲端同步」段）：
//   create table if not exists items (
//     uid uuid not null default auth.uid(),
//     kind text not null, item_id text not null,
//     data jsonb, deleted boolean default false,
//     updated_at timestamptz default now(),
//     primary key (uid, kind, item_id));
//   alter table items enable row level security;
//   create policy "own" on items for all using (uid = auth.uid()) with check (uid = auth.uid());

const CFG_KEY = 'hrnews.supabase';
let client = null, clientSig = '';

export const syncCfg = {
  get() { try { return JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); } catch (_) { return {}; } },
  set(url, key) { localStorage.setItem(CFG_KEY, JSON.stringify({ url: url.trim(), key: key.trim() })); client = null; },
  configured() { const c = this.get(); return !!(c.url && c.key); },
};

async function getClient() {
  const c = syncCfg.get();
  if (!c.url || !c.key) throw new Error('尚未設定 Supabase 專案');
  const sig = c.url + '|' + c.key;
  if (client && clientSig === sig) return client;
  const mod = await import('https://esm.sh/@supabase/supabase-js@2');
  client = mod.createClient(c.url, c.key, { auth: { persistSession: true, storageKey: 'hrnews.sb', autoRefreshToken: true } });
  clientSig = sig;
  return client;
}

export async function signUp(email, password) {
  const s = await getClient();
  const { error } = await s.auth.signUp({ email, password });
  if (error) throw error;
}
export async function signIn(email, password) {
  const s = await getClient();
  const { data, error } = await s.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}
export async function signOut() { try { const s = await getClient(); await s.auth.signOut(); } catch (_) {} }
export async function currentUser() {
  if (!syncCfg.configured()) return null;
  try { const s = await getClient(); const { data } = await s.auth.getUser(); return data.user || null; } catch (_) { return null; }
}

// items CRUD
export async function fetchRemote() {
  const s = await getClient();
  const { data, error } = await s.from('items').select('kind,item_id,data,deleted,updated_at');
  if (error) throw error;
  return data || [];
}
export async function pushRemote(rows) {
  if (!rows.length) return;
  const s = await getClient();
  const u = (await s.auth.getUser()).data.user;
  if (!u) throw new Error('尚未登入');
  const payload = rows.map((r) => ({ uid: u.id, kind: r.kind, item_id: r.item_id, data: r.data ?? null, deleted: !!r.deleted, updated_at: new Date(r.updated_at || Date.now()).toISOString() }));
  const { error } = await s.from('items').upsert(payload, { onConflict: 'uid,kind,item_id' });
  if (error) throw error;
}
// 刪除 = 寫一筆 deleted 墓碑（讓其他裝置也刪掉）
export async function markDeleted(kind, itemId) {
  try { await pushRemote([{ kind, item_id: itemId, data: null, deleted: true, updated_at: Date.now() }]); } catch (_) {}
}
