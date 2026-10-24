// Persistent cache in Supabase (PostgREST) so closed months survive Render sleeps/restarts.
// Enabled only when SUPABASE_URL and SUPABASE_SERVICE_KEY are set. Failures never break a
// request: they are logged and the API falls back to Silogtran.
import { gzipSync, gunzipSync } from 'node:zlib';

const URL_BASE = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY || '';
const TABLE = process.env.SUPABASE_CACHE_TABLE || 'silog_report_cache';
const RETENTION_DAYS = Number(process.env.SUPABASE_CACHE_RETENTION_DAYS ?? 30);

export const storeEnabled = () => Boolean(URL_BASE && KEY);

function headers(extra = {}) {
  return { apikey: KEY, authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...extra };
}

async function call(path, init) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, { ...init, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Supabase HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

// Returns { columns, rows, meta, at } or null.
export async function storeGet(key) {
  if (!storeEnabled()) return null;
  try {
    const res = await call(`${TABLE}?key=eq.${encodeURIComponent(key)}&select=columns,payload,meta,created_at`, {
      headers: headers(),
    });
    const [row] = await res.json();
    if (!row) return null;
    const rows = JSON.parse(gunzipSync(Buffer.from(row.payload, 'base64')).toString('utf8'));
    return { columns: row.columns, rows, meta: row.meta || undefined, at: Date.parse(row.created_at) };
  } catch (e) {
    console.warn(`[store] get ${key} failed: ${e.message}`);
    return null;
  }
}

export async function storePut(key, { columns, rows, meta }) {
  if (!storeEnabled()) return;
  try {
    const payload = gzipSync(Buffer.from(JSON.stringify(rows))).toString('base64');
    await call(`${TABLE}?on_conflict=key`, {
      method: 'POST',
      headers: headers({ prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify({ key, columns, payload, meta: meta || null, row_count: rows.length, created_at: new Date().toISOString() }),
    });
    // Housekeeping: drop entries older than the retention window (keeps the free tier small).
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
    await call(`${TABLE}?created_at=lt.${cutoff}`, { method: 'DELETE', headers: headers({ prefer: 'return=minimal' }) });
  } catch (e) {
    console.warn(`[store] put ${key} failed: ${e.message}`);
  }
}

export async function storeClear() {
  if (!storeEnabled()) return;
  await call(`${TABLE}?key=neq.`, { method: 'DELETE', headers: headers({ prefer: 'return=minimal' }) });
}
