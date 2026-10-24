# APIs Legalización Silogtran

API REST (sin frontend) que inicia sesión en Silogtran (PRADO) con credenciales de ENV,
genera informes y los devuelve como JSON o CSV. Desplegada en Render (Docker).

## Endpoints
Todos bajo `/api` requieren el header `x-api-key: <API_KEY>`.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Estado (público) |
| GET | `/api/reports` | Catálogo de informes |
| GET | `/api/reports/legalizacion-viaje?fechaInicial=YYYY-MM-DD&fechaFinal=YYYY-MM-DD[&format=csv][&anulados=true]` | Informe Legalización Viaje |
| GET | `/api/reports/legalizacion-sap?fechaInicial=YYYY-MM-DD&fechaFinal=YYYY-MM-DD[&format=csv]` | Informe Legalización SAP |
| GET | `/api/reports/legalizacion-viaje-sap?fechaInicial=…&fechaFinal=…[&format=csv][&excluirConcepto=A,B][&anulados=true]` | Viaje + `placa_sap` cruzada por *Legvia codigo*, sin *Concepto gasto* = PEAJE ELECTRÓNICO (por defecto) |
| GET | `/api/reports/:name/debug?fechaInicial=…&fechaFinal=…` | Campos detectados + respuesta cruda de Silogtran |

Respuesta JSON: `{ report, filters, source, count, elapsedMs, columns, rows }`.
El cruzado agrega `stats` (filas por informe, excluidas, sin cruce, columnas usadas) y las columnas `placa_sap`, `cruce_sap`.
`excluirConcepto` reemplaza la lista por defecto; vacío (`excluirConcepto=`) no excluye nada. La comparación ignora mayúsculas y tildes.
`anulados` (Viaje y cruzado): `false` por defecto excluye legalizaciones anuladas (filas sin *Concepto gasto*); `true` las incluye. `stats.excludedAnulados` cuenta las excluidas.

```bash
curl -H "x-api-key: $API_KEY" "https://<servicio>.onrender.com/api/reports/legalizacion-sap?fechaInicial=2026-10-01&fechaFinal=2026-10-24"
```

## Cómo funciona
- Sesión única en memoria; login al primer request y re-login automático si expira.
- AWS WAF: Chromium headless (incluido en la imagen Docker) obtiene `aws-waf-token`.
- Los campos del formulario (fechas, *Tipo de Impresión* = CSV, botón *Generar*) se detectan
  automáticamente. Si Silogtran usa otros nombres, fíjalos en `src/reports/index.js` → `fields`
  usando la salida de `/debug`.
- Peticiones serializadas (PRADO guarda estado por sesión).
- Rangos largos se dividen por **mes calendario**; los meses cerrados quedan en caché en memoria
  (`CACHE_TTL_HOURS`, 24 h por defecto; `0` desactiva). El mes en curso siempre se regenera.
  El Viaje crudo no se cachea; el cruzado cachea por mes el Viaje **ya filtrado** (solo con la
  exclusión por defecto) y el SAP crudo, y cruza al final sobre todo el rango (un código puede
  tener su SAP en otro mes). Tope de caché `CACHE_MAX_ROWS` (250 000 filas, LRU).
  `POST /api/cache/clear` vacía la caché. Rango máximo `MAX_RANGE_DAYS` (731 por defecto).
  Los logs muestran filas y tiempo por mes (`[report] ...`).

## Variables de entorno
Ver `.env.example`: `SILOG_BASE_URL`, `SILOG_USER`, `SILOG_PASSWORD`, `API_KEY` (obligatorias),
`SILOG_COST_CENTER`, `CACHE_TTL_HOURS`, `WAF_CHROME_PATH`, `WAF_WAIT_SEC`, `SILOG_TIMEOUT_SEC`, `MAX_RANGE_DAYS`.

## Local
```bash
cp .env.example .env   # completar; en Windows/Mac definir WAF_CHROME_PATH
npm install && npm run dev
```

## Render
New → Blueprint → este repo (usa `render.yaml`), luego completar `SILOG_USER`, `SILOG_PASSWORD`, `API_KEY`.
En plan free el servicio duerme: la primera llamada tarda ~30–60 s.
