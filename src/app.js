// Express API: static API key auth, report endpoints (JSON or CSV), health check.
import crypto from 'node:crypto';
import express from 'express';
import { withSession, sessionActive } from './session.js';
import { SilogtranError } from './silogtran.js';
import { REPORTS } from './reports/index.js';
import { debugReport } from './reports/engine.js';
import { findTercero, debugTercero, getInformacionEconomica } from './terceros.js';
import { runReportRange, cacheStats, clearCache } from './reports/range.js';
import { runViajeWithSapPlate, viajeFilter, DEFAULT_EXCLUDED_CONCEPTS } from './reports/combined.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = Number(process.env.MAX_RANGE_DAYS || 731);

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.get('/health', (_req, res) => res.json({ ok: true, sessionActive: sessionActive(), cache: cacheStats() }));

function requireApiKey(req, res, next) {
  const expected = process.env.API_KEY || '';
  const got = req.get('x-api-key') || '';
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Invalid or missing x-api-key.' });
  }
  next();
}
app.use('/api', requireApiKey);

app.post('/api/cache/clear', async (_req, res, next) => {
  try {
    await clearCache();
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

app.get('/api/reports', (_req, res) =>
  res.json([
    ...Object.entries(REPORTS).map(([id, d]) => ({
      id,
      title: d.title,
      params: ['fechaInicial', 'fechaFinal', 'format', ...(id === 'legalizacion-viaje' ? ['anulados'] : [])],
    })),
    {
      id: 'legalizacion-viaje-sap',
      title: 'Legalización Viaje + placa SAP (sin PEAJE ELECTRÓNICO)',
      params: ['fechaInicial', 'fechaFinal', 'format', 'excluirConcepto', 'anulados'],
    },
  ])
);

function parseDates(q) {
  const { fechaInicial, fechaFinal } = q;
  if (!DATE_RE.test(fechaInicial || '') || !DATE_RE.test(fechaFinal || '')) {
    throw Object.assign(new Error('fechaInicial and fechaFinal are required (yyyy-mm-dd).'), { status: 400 });
  }
  const days = (Date.parse(fechaFinal) - Date.parse(fechaInicial)) / 86_400_000;
  if (Number.isNaN(days) || days < 0) throw Object.assign(new Error('Invalid date range.'), { status: 400 });
  if (days > MAX_RANGE_DAYS) throw Object.assign(new Error(`Range exceeds ${MAX_RANGE_DAYS} days.`), { status: 400 });
  return { startDate: fechaInicial, endDate: fechaFinal };
}

// anulados=true includes voided legalizations (rows without "Concepto gasto"); default false.
function parseAnulados(q) {
  const v = String(q.anulados ?? 'false').trim().toLowerCase();
  if (['true', '1', 'si', 'sí'].includes(v)) return true;
  if (['false', '0', 'no', ''].includes(v)) return false;
  throw Object.assign(new Error('anulados must be true or false.'), { status: 400 });
}

function getReport(req) {
  const def = REPORTS[req.params.name];
  if (!def) throw Object.assign(new Error(`Unknown report '${req.params.name}'.`), { status: 404 });
  return def;
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Writes in batches and honors backpressure so 100k+ rows never build one giant string.
async function streamRows(res, rows, toText, sep) {
  const BATCH = 2000;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH).map(toText).join(sep);
    if (res.destroyed) return; // client went away
    if (!res.write((i ? sep : '') + chunk)) await new Promise((r) => (res.once('drain', r), res.once('close', r)));
  }
}

async function send(req, res, name, dates, t0, { columns, rows, ...extra }, filters = {}) {
  if (req.query.format === 'csv') {
    res.setHeader('content-disposition', `attachment; filename="${name}_${dates.startDate}_${dates.endDate}.csv"`);
    res.type('text/csv; charset=utf-8');
    res.write('﻿' + columns.map(csvCell).join(',') + (rows.length ? '\r\n' : ''));
    await streamRows(res, rows, (r) => r.map(csvCell).join(','), '\r\n');
    return res.end();
  }
  const head = {
    report: name,
    filters: { fechaInicial: dates.startDate, fechaFinal: dates.endDate, ...filters },
    ...extra,
    count: rows.length,
    elapsedMs: Date.now() - t0,
    columns,
  };
  res.type('application/json; charset=utf-8');
  res.write(JSON.stringify(head).slice(0, -1) + ',"rows":[');
  await streamRows(res, rows, (r) => JSON.stringify(Object.fromEntries(columns.map((c, i) => [c, r[i]]))), ',');
  res.end(']}');
}

// Viaje + SAP plate (joined by Legvia codigo), excluding Concepto gasto = PEAJE ELECTRÓNICO.
// Optional ?excluirConcepto=A,B overrides the excluded list (empty value = exclude nothing).
// Registered before /:name so it is not taken as a report id.
app.get('/api/reports/legalizacion-viaje-sap', async (req, res, next) => {
  try {
    const dates = parseDates(req.query);
    const excluded =
      req.query.excluirConcepto === undefined
        ? DEFAULT_EXCLUDED_CONCEPTS
        : String(req.query.excluirConcepto).split(',').map((s) => s.trim()).filter(Boolean);
    const anulados = parseAnulados(req.query);
    const t0 = Date.now();
    const result = await runViajeWithSapPlate(dates, excluded, anulados);
    await send(req, res, 'legalizacion-viaje-sap', dates, t0, result, { excluirConcepto: excluded, anulados });
  } catch (e) {
    next(e);
  }
});

app.get('/api/reports/:name', async (req, res, next) => {
  try {
    const def = getReport(req);
    const dates = parseDates(req.query);
    const t0 = Date.now();
    if (req.params.name === 'legalizacion-viaje') {
      // Viaje only: optional removal of voided legalizations (no concept exclusion here).
      const anulados = parseAnulados(req.query);
      const { meta, ...result } = await runReportRange(req.params.name, def, dates, { transform: viajeFilter([], anulados) });
      return await send(req, res, req.params.name, dates, t0, { ...result, stats: { viajeRows: meta.viajeRows || 0, excludedAnulados: meta.anulados || 0 } }, { anulados });
    }
    const { meta, ...result } = await runReportRange(req.params.name, def, dates);
    await send(req, res, req.params.name, dates, t0, result);
  } catch (e) {
    next(e);
  }
});

// Inspect detected form fields and the raw Silogtran response (to pin field names).
app.get('/api/reports/:name/debug', async (req, res, next) => {
  try {
    const def = getReport(req);
    const dates = parseDates(req.query);
    res.json(await withSession((c) => debugReport(c, def, dates)));
  } catch (e) {
    next(e);
  }
});

// --- Terceros -------------------------------------------------------------
const DOC_RE = /^[0-9A-Za-z-]{3,20}$/;
function parseDocumento(req) {
  const d = String(req.params.documento || '').trim();
  if (!DOC_RE.test(d)) throw Object.assign(new Error('Invalid documento.'), { status: 400 });
  return d;
}

// "Información Económica" for the provider screen (tercero + city DANE + business rules).
app.get('/api/terceros/:documento', async (req, res, next) => {
  try {
    const documento = parseDocumento(req);
    const t0 = Date.now();
    const info = await withSession((c) => getInformacionEconomica(c, documento));
    res.json({ ...info, elapsedMs: Date.now() - t0 });
  } catch (e) {
    next(e);
  }
});

// Raw tercero data as read from Silogtran (includes the contacts table).
app.get('/api/terceros/:documento/raw', async (req, res, next) => {
  try {
    const documento = parseDocumento(req);
    const t0 = Date.now();
    const tercero = await withSession((c) => findTercero(c, documento));
    res.json({ tercero, elapsedMs: Date.now() - t0 });
  } catch (e) {
    next(e);
  }
});

app.get('/api/terceros/:documento/debug', async (req, res, next) => {
  try {
    const documento = parseDocumento(req);
    res.json(await withSession((c) => debugTercero(c, documento)));
  } catch (e) {
    next(e);
  }
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || (err instanceof SilogtranError ? 502 : 500);
  if (status >= 500) console.error('[error]', err.message);
  res.status(status).json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
});
