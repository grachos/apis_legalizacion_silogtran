// Minimal RFC4180-ish CSV parser with delimiter auto-detection (; , \t |).
import { toObjects } from './engine.js';

function detectDelimiter(firstLine) {
  const cands = [';', ',', '\t', '|'];
  return cands.reduce((best, d) => (firstLine.split(d).length > firstLine.split(best).length ? d : best), ',');
}

export function parseCsv(text) {
  const src = text.replace(/^﻿/, '');
  const delim = detectDelimiter(src.split(/\r?\n/, 1)[0] || '');
  const matrix = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) {
      row.push(cell.trim());
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell.trim());
      matrix.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell.trim());
    matrix.push(row);
  }
  return toObjects(matrix.filter((r) => r.some((c) => c !== '')));
}
