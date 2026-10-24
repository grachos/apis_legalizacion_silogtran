// Legalización Viaje enriched with the SAP report's plate, joined by "Legvia codigo",
// excluding rows whose "Concepto gasto" is in the excluded list (default: PEAJE ELECTRÓNICO).
import { SilogtranError } from '../silogtran.js';
import { REPORTS } from './index.js';
import { runReportRange } from './range.js';

export const DEFAULT_EXCLUDED_CONCEPTS = ['PEAJE ELECTRÓNICO'];

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

const isLegviaCode = (n) => n.includes('legvia') && n.includes('codigo');
const isPlate = (n) => n.includes('placa') || n === 'vehiculo';
const isConcept = (n) => n.includes('concepto') && n.includes('gasto');

export async function runViajeWithSapPlate(dates, excludedConcepts = DEFAULT_EXCLUDED_CONCEPTS) {
  const viaje = await runReportRange('legalizacion-viaje', REPORTS['legalizacion-viaje'], dates);
  const sap = await runReportRange('legalizacion-sap', REPORTS['legalizacion-sap'], dates);

  const vCode = findColumn(viaje.columns, isLegviaCode, 'Legvia codigo', 'legalizacion-viaje');
  const sCode = findColumn(sap.columns, isLegviaCode, 'Legvia codigo', 'legalizacion-sap');
  const sPlate = findColumn(sap.columns, isPlate, 'Placa/Vehiculo', 'legalizacion-sap');
  const vConcept = viaje.columns.find((c) => isConcept(norm(c)));
  if (!vConcept && excludedConcepts.length) {
    throw new SilogtranError(`Column 'Concepto gasto' not found in legalizacion-viaje. Columns: ${viaje.columns.join(', ')}`);
  }

  // Index SAP plates by code; a code with several distinct plates keeps them all.
  const plates = new Map();
  for (const r of sap.rows) {
    const key = String(r[sCode] ?? '').trim();
    const plate = String(r[sPlate] ?? '').trim();
    if (!key || !plate) continue;
    if (!plates.has(key)) plates.set(key, new Set());
    plates.get(key).add(plate);
  }

  const excluded = new Set(excludedConcepts.map(norm));
  let excludedCount = 0;
  let unmatched = 0;
  const rows = [];
  for (const r of viaje.rows) {
    if (vConcept && excluded.has(norm(r[vConcept]))) {
      excludedCount++;
      continue;
    }
    const found = plates.get(String(r[vCode] ?? '').trim());
    if (!found) unmatched++;
    rows.push({ ...r, placa_sap: found ? [...found].join(', ') : '', cruce_sap: Boolean(found) });
  }

  return {
    columns: [...viaje.columns, 'placa_sap', 'cruce_sap'],
    rows,
    months: viaje.months,
    cacheHits: viaje.cacheHits + sap.cacheHits,
    stats: {
      viajeRows: viaje.rows.length,
      sapRows: sap.rows.length,
      excludedByConcept: excludedCount,
      unmatched,
      joinKeys: { viaje: vCode, sap: sCode, sapPlate: sPlate, concept: vConcept || null },
    },
  };
}
