// Express API: static API key auth, report endpoints (JSON or CSV), health check.
import crypto from 'node:crypto';
import express from 'express';
import { withSession, sessionActive } from './session.js';
import { SilogtranError } from './silogtran.js';
import { REPORTS } from './reports/index.js';
import { runReport, debugReport } from './reports/engine.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = Number(process.env.MAX_RANGE_DAYS || 366);

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.get('/health', (_req, res) => res.json({ ok: true, sessionActive: sessionActive() }));

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

app.get('/api/reports', (_req, res) =>
  res.json(Object.entries(REPORTS).map(([id, d]) => ({ id, title: d.title, params: ['fechaInicial', 'fechaFinal', 'format'] })))
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

app.get('/api/reports/:name', async (req, res, next) => {
  try {
    const def = getReport(req);
    const dates = parseDates(req.query);
    const t0 = Date.now();
    const { columns, rows, source } = await withSession((c) => runReport(c, def, dates));
    if (req.query.format === 'csv') {
      const lines = [columns.map(csvCell).join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))];
      res.setHeader('content-disposition', `attachment; filename="${req.params.name}_${dates.startDate}_${dates.endDate}.csv"`);
      return res.type('text/csv; charset=utf-8').send('﻿' + lines.join('\r\n'));
    }
    res.json({
      report: req.params.name,
      filters: { fechaInicial: dates.startDate, fechaFinal: dates.endDate },
      source,
      count: rows.length,
      elapsedMs: Date.now() - t0,
      columns,
      rows,
    });
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
