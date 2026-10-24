// Legalización Viaje enriched with the SAP report's plate, joined by "Legvia codigo",
// excluding rows whose "Concepto gasto" is in the excluded list (default: PEAJE ELECTRÓNICO).
import { SilogtranError } from '../silogtran.js';
import { REPORTS } from './index.js';
import { runReportRange } from './range.js';

export const DEFAULT_EXCLUDED_CONCEPTS = ['PEAJE ELECTRÓNICO'];
const variantOf = (list, anulados = false) => `excl:${list.map((x) => norm(x)).sort().join('|')}|anul:${anulados ? 1 : 0}`;

// Case/accent/space-insensitive comparison key.
export const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/gi, '')
    .toLowerCase();

function findColumn(columns, test, label, reportName) {
  const col = columns.find((c) => test(norm(c)));
  if (!col) {
    throw new SilogtranError(`Column '${label}' not found in ${reportName}. Columns: ${columns.join(', ')}`, { status: 502 });
  }
  return col;
}

const DEFAULT_VARIANT = variantOf(DEFAULT_EXCLUDED_CONCEPTS);

const isLegviaCode = (n) => n.includes('legvia') && n.includes('codigo');
const isPlate = (n) => n.includes('placa') || n === 'vehiculo';
const isConcept = (n) => n.includes('concepto') && n.includes('gasto');

// Per-month transform: drop excluded concepts and (unless anulados=true) voided legalizations,
// i.e. rows with an empty "Concepto gasto". Runs before caching; counts travel in part.meta.
export function viajeFilter(excludedConcepts, anulados = false) {
  const excluded = new Set(excludedConcepts.map(norm));
  return (part) => {
    if (!excluded.size && anulados) return { ...part, meta: { viajeRows: part.rows.length, excluded: 0, anulados: 0 } };
    const col = part.columns.find((c) => isConcept(norm(c)));
    if (!col) {
      throw new SilogtranError(`Column 'Concepto gasto' not found in legalizacion-viaje. Columns: ${part.columns.join(', ')}`);
    }
    const ci = part.columns.indexOf(col);
    let excl = 0;
    let anul = 0;
    const rows = part.rows.filter((r) => {
      const key = norm(r[ci]);
      if (!key) {
        if (anulados) return true;
        anul++;
        return false;
      }
      if (excluded.has(key)) {
        excl++;
        return false;
      }
      return true;
    });
    return { columns: part.columns, rows, meta: { viajeRows: part.rows.length, excluded: excl, anulados: anul } };
  };
}

export async function runViajeWithSapPlate(dates, excludedConcepts = DEFAULT_EXCLUDED_CONCEPTS, anulados = false) {
  // Filtered Viaje is cached per month (variant keyed by the excluded list); SAP raw is small.
  const variant = variantOf(excludedConcepts, anulados);
  const viaje = await runReportRange('legalizacion-viaje', REPORTS['legalizacion-viaje'], dates, {
    transform: viajeFilter(excludedConcepts, anulados),
    variant,
    // Only the default exclusion is cached; custom lists (e.g. none → ~200k raw rows) run uncached.
    cache: variant === DEFAULT_VARIANT,
  });
  const sap = await runReportRange('legalizacion-sap', REPORTS['legalizacion-sap'], dates);

  const vCode = findColumn(viaje.columns, isLegviaCode, 'Legvia codigo', 'legalizacion-viaje');
  const sCode = findColumn(sap.columns, isLegviaCode, 'Legvia codigo', 'legalizacion-sap');
  const sPlate = findColumn(sap.columns, isPlate, 'Placa/Vehiculo', 'legalizacion-sap');
  const vConcept = viaje.columns.find((c) => isConcept(norm(c)));

  // Join over the FULL range: a code's SAP row may fall in a different month than its Viaje row.
  const plates = new Map();
  const sCodeI = sap.columns.indexOf(sCode);
  const sPlateI = sap.columns.indexOf(sPlate);
  for (const r of sap.rows) {
    const key = String(r[sCodeI] ?? '').trim();
    const plate = String(r[sPlateI] ?? '').trim();
    if (!key || !plate) continue;
    if (!plates.has(key)) plates.set(key, new Set());
    plates.get(key).add(plate);
  }

  let unmatched = 0;
  const vCodeI = viaje.columns.indexOf(vCode);
  const rows = viaje.rows.map((r) => {
    const found = plates.get(String(r[vCodeI] ?? '').trim());
    if (!found) unmatched++;
    return [...r, found ? [...found].join(', ') : '', Boolean(found)];
  });

  return {
    columns: [...viaje.columns, 'placa_sap', 'cruce_sap'],
    rows,
    months: viaje.months,
    cacheHits: viaje.cacheHits + sap.cacheHits,
    stats: {
      viajeRows: viaje.meta.viajeRows || 0,
      sapRows: sap.rows.length,
      excludedByConcept: viaje.meta.excluded || 0,
      excludedAnulados: viaje.meta.anulados || 0,
      unmatched,
      joinKeys: { viaje: vCode, sap: sCode, sapPlate: sPlate, concept: vConcept || null },
    },
  };
}
