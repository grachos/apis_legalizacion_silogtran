// Express API: static API key auth, report endpoints (JSON or CSV), health check.
import crypto from 'node:crypto';
import express from 'express';
import { withSession, sessionActive } from './session.js';
import { SilogtranError } from './silogtran.js';
import { REPORTS } from './reports/index.js';
import { debugReport } from './reports/engine.js';
import { runReportRange, cacheStats, clearCache } from './reports/range.js';
import { runViajeWithSapPlate, DEFAULT_EXCLUDED_CONCEPTS } from './reports/combined.js';

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

app.post('/api/cache/clear', (_req, res) => {
  clearCache();
  res.json({ ok: true });
});

app.get('/api/reports', (_req, res) =>
  res.json([
    ...Object.entries(REPORTS).map(([id, d]) => ({ id, title: d.title, params: ['fechaInicial', 'fechaFinal', 'format'] })),
    {
      id: 'legalizacion-viaje-sap',
      title: 'Legalización Viaje + placa SAP (sin PEAJE ELECTRÓNICO)',
      params: ['fechaInicial', 'fechaFinal', 'format', 'excluirConcepto'],
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

function getReport(req) {
  const def = REPORTS[req.params.name];
  if (!def) throw Object.assign(new Error(`Unknown report '${req.params.name}'.`), { status: 404 });
  return def;
}

const csvCell = (v) => (/[",\n;]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v);

function send(req, res, name, dates, t0, { columns, rows, ...extra }, filters = {}) {
  if (req.query.format === 'csv') {
    const lines = [columns.map(csvCell).join(','), ...rows.map((r) => columns.map((c) => csvCell(String(r[c] ?? ''))).join(','))];
    res.setHeader('content-disposition', `attachment; filename="${name}_${dates.startDate}_${dates.endDate}.csv"`);
    return res.type('text/csv; charset=utf-8').send('﻿' + lines.join('\r\n'));
  }
  res.json({
    report: name,
    filters: { fechaInicial: dates.startDate, fechaFinal: dates.endDate, ...filters },
    ...extra,
    count: rows.length,
    elapsedMs: Date.now() - t0,
    columns,
    rows,
  });
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
    const t0 = Date.now();
    const result = await runViajeWithSapPlate(dates, excluded);
    send(req, res, 'legalizacion-viaje-sap', dates, t0, result, { excluirConcepto: excluded });
  } catch (e) {
    next(e);
  }
});

app.get('/api/reports/:name', async (req, res, next) => {
  try {
    const def = getReport(req);
    const dates = parseDates(req.query);
    const t0 = Date.now();
    const result = await runReportRange(req.params.name, def, dates);
    send(req, res, req.params.name, dates, t0, result);
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

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || (err instanceof SilogtranError ? 502 : 500);
  if (status >= 500) console.error('[error]', err.message);
  res.status(status).json({ error: err.message });
});
