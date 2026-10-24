// Generic runner for Silogtran report pages: GET form → fill filters → press "Generar" →
// parse the result (CSV download, link to a CSV, or an HTML table rendered on the page).
import * as cheerio from 'cheerio';
import { formFields, isLoginPage, decode, SilogtranError } from '../silogtran.js';
import { parseCsv } from './csv.js';

const expired = () => new SilogtranError('Silogtran session expired.', { sessionExpired: true });

// Locate date fields, print-type select and generate button by name/label heuristics.
// Each report definition can override with explicit names in `fields`.
export function inspectForm(html, overrides = {}) {
  const { $, form, data } = formFields(html);
  const names = Object.keys(data);
  const dateNames = names.filter((n) => /fecha/i.test(n) && !/hidden|\$IDHidden/i.test(n));
  const startDate = overrides.startDate || dateNames.find((n) => /ini/i.test(n)) || dateNames[0];
  const endDate = overrides.endDate || dateNames.find((n) => /fin/i.test(n) && n !== startDate) || dateNames[1];

  let printType = overrides.printType;
  let printValue;
  form.find('select').each((_, el) => {
    const opts = $(el).find('option').toArray().map((o) => ({ value: $(o).attr('value') ?? $(o).text(), text: $(o).text().trim() }));
    const csv = opts.find((o) => /csv/i.test(o.text) || /csv/i.test(o.value));
    if (csv && (!printType || printType === $(el).attr('name'))) {
      printType = $(el).attr('name');
      printValue = csv.value;
    }
  });

  if (printType && overrides.printValue) printValue = overrides.printValue;

  let button = overrides.button;
  let buttonId;
  let buttonValue = 'Generar';
  form.find('input[type=submit], input[type=button], button').each((_, el) => {
    const v = ($(el).attr('value') || $(el).text() || '').trim();
    if ((!button && /generar/i.test(v)) || button === $(el).attr('name')) {
      button = $(el).attr('name');
      buttonId = $(el).attr('id');
      buttonValue = v || buttonValue;
    }
  });
  const isCallback = Boolean(buttonId && new RegExp(`TActive\\w*Button\\(\\{'ID':'${buttonId}'`).test(html));

  return { $, form, data, startDate, endDate, printType, printValue, button, buttonValue, isCallback };
}

function tableFromHtml(html) {
  const $ = cheerio.load(html);
  let best = null;
  $('table').each((_, t) => {
    if ($(t).find('table').length) return; // skip layout tables wrapping others
    const rows = $(t).find('tr').toArray();
    if (rows.length < 2) return;
    const width = Math.max(...rows.map((r) => $(r).children('td,th').length));
    if (width < 3) return;
    if (!best || rows.length * width > best.score) best = { t, score: rows.length * width };
  });
  if (!best) return null;
  const matrix = $(best.t)
    .find('tr')
    .toArray()
    .map((r) => $(r).children('td,th').toArray().map((c) => $(c).text().replace(/\s+/g, ' ').trim()))
    .filter((r) => r.some((c) => c !== ''));
  return toObjects(matrix);
}

export function toObjects(matrix) {
  const [head = [], ...body] = matrix;
  const seen = {};
  const columns = head.map((h, i) => {
    let k = h || `col_${i + 1}`;
    if (seen[k]) k = `${k}_${++seen[k]}`;
    else seen[k] = 1;
    return k;
  });
  const rows = body.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? ''])));
  return { columns, rows };
}

const looksCsv = (r) =>
  /csv|octet-stream|excel|text\/plain/i.test(r.type) || /attachment/i.test(r.headers.get('content-disposition') || '');

// Silogtran answers "Generar" with a script: window.open('../reportes/DOC_<hash>.csv').
// Pick the window.open that targets a generated file, not unrelated menu scripts.
const FILE_RE = /(reportes\/|\.(csv|txt|xls|xlsx)(\?|$))/i;
export function findFileLink(html, baseUrl) {
  const opens = [...html.matchAll(/window\.open\(\s*['"]([^'"]+)['"]/gi)].map((m) => m[1]);
  const hit =
    opens.find((u) => FILE_RE.test(u)) ||
    /location(?:\.href)?\s*=\s*['"]([^'"]+\.(?:csv|txt)[^'"]*)['"]/i.exec(html)?.[1] ||
    /href=['"]([^'"]*reportes\/[^'"]+\.(?:csv|txt)[^'"]*)['"]/i.exec(html)?.[1];
  return hit ? new URL(hit.replace(/&amp;/g, '&'), baseUrl).href : null;
}

async function parseResponse(client, r) {
  if (looksCsv(r)) return { source: 'csv', ...parseCsv(decode(r.body, r.type)) };
  if (isLoginPage(r.text)) throw expired();
  const link = findFileLink(r.text, r.url);
  if (link) {
    const f = await client.request(link);
    if (/<!doctype html|<html[\s>]/i.test(f.text.slice(0, 2000))) {
      throw new SilogtranError(`Report generated but download returned HTML instead of a file (${link}).`);
    }
    return { source: 'csv-link', ...parseCsv(f.text) };
  }
  const t = tableFromHtml(r.text);
  if (t) return { source: 'html', ...t };
  return null;
}

// Submit the report form. Returns { form meta, raw response } — used by run() and debug.
async function submit(client, def, { startDate, endDate }) {
  const pg = await client.request(def.page);
  if (isLoginPage(pg.text)) throw expired();
  const f = inspectForm(pg.text, def.fields);
  if (!f.startDate || !f.endDate) throw new SilogtranError('Date fields not found on report form.');
  if (!f.button) throw new SilogtranError('"Generar" button not found on report form.');
  f.data[f.startDate] = startDate;
  f.data[f.endDate] = endDate;
  if (f.printType && f.printValue !== undefined) f.data[f.printType] = f.printValue;
  const url = new URL(f.form.attr('action') || def.page, pg.url).href;
  let r;
  if (f.isCallback) {
    r = await client.pradoCallback(url, f.data, f.button);
  } else {
    f.data.PRADO_POSTBACK_TARGET = f.button;
    f.data[f.button] = f.buttonValue;
    r = await client.request(url, { method: 'POST', form: f.data });
  }
  return { f, r };
}

export async function runReport(client, def, dates) {
  const { r } = await submit(client, def, dates);
  const parsed = await parseResponse(client, r);
  if (!parsed) {
    throw new SilogtranError('Unrecognized report response (no CSV nor table). Use the /debug endpoint to inspect.');
  }
  return parsed;
}

export async function debugReport(client, def, dates) {
  const { f, r } = await submit(client, def, dates);
  return {
    detected: {
      startDate: f.startDate,
      endDate: f.endDate,
      printType: f.printType,
      printValue: f.printValue,
      button: f.button,
      isCallback: f.isCallback,
    },
    formFieldNames: Object.keys(f.data).filter((n) => !n.startsWith('PRADO_')),
    response: {
      status: r.status,
      url: r.url,
      contentType: r.type,
      contentDisposition: r.headers.get('content-disposition'),
      bytes: r.body.length,
      fileLink: findFileLink(r.text, r.url),
      ...summarizeHtml(r.text),
    },
  };
}

// Skip the big menu: report the form area text, messages, tables and file-opening scripts.
function summarizeHtml(html) {
  if (!/<html|<form|<table/i.test(html)) return { preview: html.slice(0, 3000) };
  const $ = cheerio.load(html);
  const clean = (s) => s.replace(/\s+/g, ' ').trim();
  const scripts = $('script')
    .toArray()
    .map((s) => $(s).html() || '')
    .filter((s) => !s.includes('_sessionBuscador') && !s.includes('nobackbutton') && !s.includes('ocultarSubMenus') && /open\(|location|\.(csv|pdf|xls|txt)|reporte|informe|download|descarg|alert\(/i.test(s))
    .map((s) => clean(s).slice(0, 800));
  const messages = $('[id*=Error], [id*=Mensaje], [id*=mensaje], .error, .mensaje, .fallavalidacion, [id*=ctl0_MainModule_ctl][style*=color]')
    .toArray()
    .map((e) => clean($(e).text()))
    .filter(Boolean);
  const tables = $('table')
    .toArray()
    .map((t) => ({ id: $(t).attr('id') || null, rows: $(t).find('tr').length, firstRow: clean($(t).find('tr').first().text()).slice(0, 200) }))
    .filter((t) => t.rows > 1);
  const iframes = $('iframe, embed, object').toArray().map((e) => $(e).attr('src') || $(e).attr('data'));
  $('script, style, ul, nav').remove();
  const form = $('form').first();
  return {
    messages,
    scripts,
    iframes,
    tables: tables.slice(0, 20),
    formText: clean(form.length ? form.text() : $('body').text()).slice(0, 2500),
  };
}
