// Splits a date range into calendar months, runs each month (one Silogtran session, serialized)
// and merges the results. Closed months are cached in memory (CACHE_TTL_HOURS, default 24);
// the current month (America/Bogota) is always regenerated.
import { withSession } from '../session.js';
import { runReport } from './engine.js';

const TTL_MS = Number(process.env.CACHE_TTL_HOURS ?? 24) * 3_600_000;
const MAX_ROWS = Number(process.env.CACHE_MAX_ROWS ?? 250_000);
const cache = new Map(); // key -> { columns, rows, meta, at } (insertion order = age)
let cachedRows = 0;

// Row budget: evict oldest entries so the cache can never exhaust the 512MB instance.
function cachePut(key, entry) {
  if (entry.rows.length > MAX_ROWS) return;
  const old = cache.get(key);
  if (old) {
    cachedRows -= old.rows.length;
    cache.delete(key);
  }
  for (const [k, v] of cache) {
    if (cachedRows + entry.rows.length <= MAX_ROWS) break;
    cachedRows -= v.rows.length;
    cache.delete(k);
  }
  cache.set(key, entry);
  cachedRows += entry.rows.length;
}

const pad = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1-12

export function splitMonths(startDate, endDate) {
  const chunks = [];
  let [y, m] = startDate.split('-').map(Number);
  const [ey, em] = endDate.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    const first = `${y}-${pad(m)}-01`;
    const last = `${y}-${pad(m)}-${pad(lastDay(y, m))}`;
    chunks.push({ startDate: first < startDate ? startDate : first, endDate: last > endDate ? endDate : last });
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  return chunks;
}

// First day of the current month in Colombia; months ending before it are "closed".
function currentMonthStart() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
  return `${today.slice(0, 7)}-01`;
}

function mergeColumns(target, cols) {
  for (const c of cols) if (!target.includes(c)) target.push(c);
}

// opts.transform(part) -> part: applied to each month BEFORE caching (e.g. drop rows).
// opts.variant: cache-key suffix for transformed results. opts.cache: false = never cache.
export async function runReportRange(id, def, dates, opts = {}) {
  const useCache = TTL_MS > 0 && (opts.cache ?? def.cache !== false);
  const chunks = splitMonths(dates.startDate, dates.endDate);
  const monthStart = currentMonthStart();
  const columns = [];
  const rows = [];
  let cacheHits = 0;
  const meta = {};
  const t0 = Date.now();

  for (const ch of chunks) {
    const key = `${id}|${opts.variant || 'raw'}|${ch.startDate}|${ch.endDate}`;
    const closed = ch.endDate < monthStart;
    const hit = closed && useCache ? cache.get(key) : null;
    let part;
    const t1 = Date.now();
    if (hit && Date.now() - hit.at < TTL_MS) {
      part = hit;
      cacheHits++;
      cache.delete(key); // LRU: mark as most recently used
      cache.set(key, hit);
    } else {
      try {
        part = await withSession((c) => runReport(c, def, ch));
        if (opts.transform) part = opts.transform(part);
      } catch (e) {
        e.message = `[${id} ${ch.startDate}..${ch.endDate}] ${e.message}`;
        throw e;
      }
      if (closed && useCache) cachePut(key, { columns: part.columns, rows: part.rows, meta: part.meta, at: Date.now() });
    }
    console.log(`[report] ${id} ${ch.startDate}..${ch.endDate} rows=${part.rows.length} ${Date.now() - t1}ms${part === hit ? ' (cache)' : ''}`);
    for (const [k, v] of Object.entries(part.meta || {})) meta[k] = (meta[k] || 0) + v;
    if (!columns.length) columns.push(...part.columns);
    if (part.columns.length === columns.length && part.columns.every((c, i) => c === columns[i])) {
      for (const r of part.rows) rows.push(r);
    } else {
      // Month with a different column set: realign rows to the merged columns.
      mergeColumns(columns, part.columns);
      const idx = columns.map((c) => part.columns.indexOf(c));
      for (const r of part.rows) rows.push(idx.map((i) => (i < 0 ? '' : r[i])));
    }
  }
  console.log(`[report] ${id} ${dates.startDate}..${dates.endDate} total rows=${rows.length} months=${chunks.length} cache=${cacheHits} ${Date.now() - t0}ms`);
  return { source: 'csv-link', columns, rows, meta, months: chunks.length, cacheHits };
}

export const cacheStats = () => ({ entries: cache.size, rows: cachedRows, maxRows: MAX_ROWS, ttlHours: TTL_MS / 3_600_000 });
export const clearCache = () => {
  cache.clear();
  cachedRows = 0;
};
