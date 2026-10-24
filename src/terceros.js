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

// --- Step 2: city (DANE) + "Información Económica" mapping ------------------

const CITY_PAGE = 'index.php?page=Basicos.Ciudad.Buscar';
const cityCache = new Map(); // ciudadId -> { dane, nombre } (stable master data)

// 33 departamentos DANE (2 first digits of the municipality code).
export const DEPARTAMENTOS = {
  '05': 'Antioquia', '08': 'Atlántico', '11': 'Bogotá D.C.', '13': 'Bolívar', '15': 'Boyacá',
  '17': 'Caldas', '18': 'Caquetá', '19': 'Cauca', '20': 'Cesar', '23': 'Córdoba',
  '25': 'Cundinamarca', '27': 'Chocó', '41': 'Huila', '44': 'La Guajira', '47': 'Magdalena',
  '50': 'Meta', '52': 'Nariño', '54': 'Norte de Santander', '63': 'Quindío', '66': 'Risaralda',
  '68': 'Santander', '70': 'Sucre', '73': 'Tolima', '76': 'Valle del Cauca', '81': 'Arauca',
  '85': 'Casanare', '86': 'Putumayo', '88': 'Archipiélago de San Andrés, Providencia y Santa Catalina',
  '91': 'Amazonas', '94': 'Guainía', '95': 'Guaviare', '97': 'Vaupés', '99': 'Vichada',
};

export const EMAIL_ENTREGA = 'informacionalproveedor@elogia.com.co';

// DANE codes may lose the leading zero (e.g. Antioquia 05001000 → 5001000).
export function normalizeDane(raw) {
  const d = String(raw ?? '').replace(/\D/g, '');
  return d.length === 7 || d.length === 4 ? `0${d}` : d;
}

export async function findCiudad(client, ciudadId) {
  if (cityCache.has(ciudadId)) return cityCache.get(ciudadId);
  const pg = await client.request(CITY_PAGE);
  if (isLoginPage(pg.text)) throw expired();
  const { form, data } = formFields(pg.text);
  Object.assign(data, {
    [`${P}ciudad_codigo`]: ciudadId,
    PRADO_POSTBACK_TARGET: `${P}ctl2`,
    PRADO_POSTBACK_PARAMETER: '',
    [`${P}ctl2`]: 'Buscar',
  });
  const r = await client.request(new URL(form.attr('action') || CITY_PAGE, pg.url).href, { method: 'POST', form: data });
  if (isLoginPage(r.text)) throw expired();
  const $ = cheerio.load(r.text);
  if (!/formulario de ciudad/i.test(clean($('h2').text()))) {
    throw new SilogtranError(`City ${ciudadId} not found in Silogtran (no single "Formulario de Ciudad").`);
  }
  const dane = normalizeDane(readField($, 'ciudad_codigodane'));
  if (!/^\d{5,8}$/.test(dane)) throw new SilogtranError(`City ${ciudadId} has no valid DANE code ('${dane}').`);
  const city = { dane, nombre: readField($, 'ciudad_nombre') || '' };
  cityCache.set(ciudadId, city);
  return city;
}

// Business rules (approved): country Colombia, departamento/código postal from DANE,
// fixed delivery email, fiscal address = residence, contact data empty.
// Obligations are fixed (R-99-PN) on the MyEInvoice side, so they are not part of the output.
export function toInformacionEconomica(t, city) {
  const depto = city ? DEPARTAMENTOS[city.dane.slice(0, 2)] || '' : '';
  const codigoPostal = city ? city.dane.slice(0, 5) : '';
  const ubicacion = { pais: t.pais || 'Colombia', departamento: depto, ciudad: t.ciudad, direccion: t.direccion, codigoPostal };

  return {
    identificacion: {
      tipoDocumento: t.tipoDocumento,
      documento: t.documento,
      tipoPersona: t.tipoPersona,
      nombre: t.nombreCompleto,
    },
    residenciaEntrega: {
      ...ubicacion,
      email: t.email,
      telefono: t.telefono || t.celular,
      emailEntrega: EMAIL_ENTREGA,
      confirmarEmailEntrega: EMAIL_ENTREGA,
    },
    direccionFiscal: { ...ubicacion },
    contacto: { nombre: '', correo: '', telefono: '', notas: '' },
    // Obligaciones: not returned — MyEInvoice always uses the fixed value R-99-PN (No aplica – Otros).
    fuente: { ciudadId: t.ciudadId, ciudadDane: city?.dane || null },
  };
}

export async function getInformacionEconomica(client, documento) {
  const t = await findTercero(client, documento);
  const city = t.ciudadId ? await findCiudad(client, t.ciudadId) : null;
  return toInformacionEconomica(t, city);
}
