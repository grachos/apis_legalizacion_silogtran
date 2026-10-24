// Tercero lookup by document in Silogtran (Maestros.Tercero.Buscar). PRADO postback:
// GET form → set tercero_documento + submit button → POST → parse the "Formulario de Tercero".
import * as cheerio from 'cheerio';
import { formFields, isLoginPage, SilogtranError } from './silogtran.js';

const SEARCH_PAGE = 'index.php?page=Maestros.Tercero.Buscar';
const P = 'ctl0$MainModule$';

// Only the fields the target screen needs (no bank account, EPS/ARL, license, etc.).
const TEXT_FIELDS = [
  'tipdoc_codigo',
  'tercero_documento',
  'tercero_tipopersona',
  'tercero_nombre1',
  'tercero_nombre2',
  'tercero_apellido1',
  'tercero_apellido2',
  'tercero_direccion',
  'tercero_telefono1',
  'tercero_celular1',
  'tercero_email',
  'ciudad_codigo',
];
const FISCAL_FIELDS = [
  'tercero_autoretenedorrenta',
  'tercero_autoretenedorfuente',
  'tercero_autoretenedoriva',
  'tercero_autoretenedorica',
  'tercero_autoretenedorreteiva',
  'tercero_declaranterenta',
  'tercero_regimenespecialrenta',
];

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const expired = () => new SilogtranError('Silogtran session expired.', { sessionExpired: true });

// Value as the user sees it: input value, selected option text, checked radio/checkbox.
function readField($, name) {
  const els = $(`[name="${P}${name}"]`);
  if (!els.length) return null;
  const el = els.first();
  const tag = el.prop('tagName')?.toLowerCase();
  if (tag === 'select') {
    const opt = el.find('option[selected]').first();
    return clean((opt.length ? opt : el.find('option').first()).text());
  }
  if (tag === 'textarea') return clean(el.text());
  const type = (el.attr('type') || '').toLowerCase();
  if (type === 'radio') {
    const checked = els.filter('[checked]').first();
    if (!checked.length) return '';
    const id = checked.attr('id');
    const label = id ? clean($(`label[for="${id}"]`).text()) : '';
    return label || clean(checked.attr('value'));
  }
  if (type === 'checkbox') return el.is('[checked]') ? 'SI' : 'NO';
  return clean(el.attr('value'));
}

const toBool = (v) => /^(si|sí|s|1|true|yes)$/i.test(clean(v));

function parseContacts($) {
  const table = $('#ctl0_MainModule_ItemsContactos');
  if (!table.length) return [];
  const rows = table.find('tr').toArray();
  const headIdx = rows.findIndex((r) => $(r).children('th').length);
  const head = (headIdx >= 0 ? $(rows[headIdx]).children('th') : $(rows[0]).children('td'))
    .toArray()
    .map((c) => clean($(c).text()));
  return rows
    .slice((headIdx >= 0 ? headIdx : 0) + 1)
    .map((r) => $(r).children('td').toArray().map((c) => clean($(c).text())))
    .filter((cells) => cells.some(Boolean))
    .map((cells) => Object.fromEntries(head.map((h, i) => [h || `col_${i + 1}`, cells[i] ?? ''])));
}

function isTerceroForm($) {
  const h2 = clean($('h2').text());
  return /formulario de tercero/i.test(h2);
}

// Result grid rows when several terceros match (no single ficha).
function parseResultGrid($) {
  let best = [];
  $('table').each((_, t) => {
    if ($(t).find('table').length) return;
    const rows = $(t)
      .find('tr')
      .toArray()
      .map((r) => $(r).children('td').toArray().map((c) => clean($(c).text())))
      .filter((cells) => cells.length >= 2 && cells.some(Boolean));
    if (rows.length > best.length && rows.some((cells) => cells.some((c) => /\d{5,}/.test(c)))) best = rows;
  });
  return best;
}

async function submitSearch(client, documento) {
  const pg = await client.request(SEARCH_PAGE);
  if (isLoginPage(pg.text)) throw expired();
  const { form, data } = formFields(pg.text);
  for (const k of Object.keys(data)) if (k.includes('ConsultarDataCarga')) delete data[k];
  Object.assign(data, {
    [`${P}tercero_documento`]: documento,
    PRADO_POSTBACK_TARGET: `${P}ctl3`,
    PRADO_POSTBACK_PARAMETER: '',
    [`${P}ctl3`]: 'Buscar',
  });
  const url = new URL(form.attr('action') || SEARCH_PAGE, pg.url).href;
  const r = await client.request(url, { method: 'POST', form: data });
  if (isLoginPage(r.text)) throw expired();
  return r;
}

export async function findTercero(client, documento) {
  const r = await submitSearch(client, documento);
  const $ = cheerio.load(r.text);

  if (!isTerceroForm($)) {
    const grid = parseResultGrid($).filter((cells) => cells.some((c) => c.includes(documento)));
    if (grid.length > 1) {
      throw Object.assign(new Error(`Several terceros match document ${documento}.`), {
        status: 409,
        details: grid.slice(0, 20).map((cells) => cells.filter(Boolean).join(' | ')),
      });
    }
    throw Object.assign(new Error(`Tercero with document ${documento} not found.`), { status: 404 });
  }

  const fields = Object.fromEntries(TEXT_FIELDS.map((f) => [f, readField($, f) ?? '']));
  const fiscal = Object.fromEntries(FISCAL_FIELDS.map((f) => [f, toBool(readField($, f))]));
  const ciudadId = clean($(`[name="${P}ciudad_codigo$IDHidden"]`).attr('value'));
  const pais = readField($, 'pais_codigo');

  return {
    tipoDocumento: fields.tipdoc_codigo,
    documento: fields.tercero_documento || documento,
    tipoPersona: fields.tercero_tipopersona,
    nombre1: fields.tercero_nombre1,
    nombre2: fields.tercero_nombre2,
    apellido1: fields.tercero_apellido1,
    apellido2: fields.tercero_apellido2,
    nombreCompleto: clean(
      [fields.tercero_nombre1, fields.tercero_nombre2, fields.tercero_apellido1, fields.tercero_apellido2].join(' ')
    ),
    direccion: fields.tercero_direccion,
    telefono: fields.tercero_telefono1,
    celular: fields.tercero_celular1,
    email: fields.tercero_email,
    ciudad: fields.ciudad_codigo,
    ciudadId,
    pais: pais || 'Colombia',
    fiscal,
    contactos: parseContacts($),
  };
}

// Diagnostics without exposing the whole ficha: page title, state and which fields exist.
export async function debugTercero(client, documento) {
  const r = await submitSearch(client, documento);
  const $ = cheerio.load(r.text);
  const present = [...TEXT_FIELDS, ...FISCAL_FIELDS, 'pais_codigo', 'ciudad_codigo$IDHidden'].map((f) => {
    const el = $(`[name="${P}${f}"]`).first();
    return { field: f, found: el.length > 0, tag: el.prop('tagName')?.toLowerCase() || null, type: el.attr('type') || null };
  });
  return {
    status: r.status,
    url: r.url,
    bytes: r.body.length,
    h2: $('h2').toArray().map((h) => clean($(h).text())),
    isTerceroForm: isTerceroForm($),
    fields: present,
    contactosTable: $('#ctl0_MainModule_ItemsContactos').length > 0,
    gridSample: parseResultGrid($).slice(0, 5),
  };
}
