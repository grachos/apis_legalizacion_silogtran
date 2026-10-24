# APIs Legalización Silogtran

API REST (sin frontend) que entra a **Silogtran** (TMS hecho en PRADO/PHP, sin API oficial) con un
usuario de servicio, genera informes y consulta terceros, y devuelve los datos como **JSON** o **CSV**.
Corre en **Render** (Docker) con caché persistente en **Supabase**.

> ¿Primera vez? Lee la [Guía para principiantes](docs/GUIA_PRINCIPIANTES.md): explica todo el
> proyecto en palabras simples.

- **URL:** `https://apis-legalizacion-silogtran.onrender.com`
- **Autenticación:** header `x-api-key: <API_KEY>` en todo lo que está bajo `/api`.

---

## Endpoints

### Informes de legalización

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/reports/legalizacion-sap` | Informe Legalización SAP |
| GET | `/api/reports/legalizacion-viaje` | Informe Legalización Viaje (sin anulados por defecto) |
| GET | `/api/reports/legalizacion-viaje-sap` | Viaje + `placa_sap` cruzada por *Legvia codigo*, sin PEAJE ELECTRÓNICO ni anulados |
| GET | `/api/reports` | Catálogo de informes y parámetros |
| GET | `/api/reports/:name/debug` | Campos detectados en el formulario + resumen de la respuesta de Silogtran |

**Parámetros**

| Parámetro | Aplica a | Valores | Por defecto |
|---|---|---|---|
| `fechaInicial`, `fechaFinal` | todos (obligatorios) | `YYYY-MM-DD`, rango máx. `MAX_RANGE_DAYS` | — |
| `format` | todos | `json` \| `csv` | `json` |
| `anulados` | viaje, viaje-sap | `true` \| `false` (anulada = fila sin *Concepto gasto*) | `false` (los excluye) |
| `excluirConcepto` | viaje-sap | lista separada por comas; vacío = no excluir | `PEAJE ELECTRÓNICO` |

Las comparaciones de concepto ignoran mayúsculas y tildes.

**Respuesta JSON:** `{ report, filters, source, months, cacheHits, count, elapsedMs, columns, rows }`.
El cruzado agrega `stats` (`viajeRows`, `sapRows`, `excludedByConcept`, `excludedAnulados`,
`unmatched`, `joinKeys`) y las columnas `placa_sap`, `cruce_sap`. Para volúmenes grandes usa
`format=csv` (la mitad de tamaño).

```bash
curl -H "x-api-key: $API_KEY" \
  "https://apis-legalizacion-silogtran.onrender.com/api/reports/legalizacion-viaje-sap?fechaInicial=2026-01-01&fechaFinal=2026-10-24&format=csv" \
  -o viaje_sap.csv
```

### Terceros (para el RPA de MyEInvoice)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/terceros/:documento` | "Información Económica" del proveedor |
| GET | `/api/terceros/:documento/raw` | Datos tal como se leen de Silogtran (incluye indicadores fiscales y contactos) |
| GET | `/api/terceros/:documento/debug` | Estado de la página y campos encontrados |

Reglas de `/api/terceros/:documento`:
- Tercero: `Maestros.Tercero.Buscar` (filtro `tercero_documento`, botón `ctl3`).
- Ciudad: `Basicos.Ciudad.Buscar` con el `IDHidden` de la ciudad → `ciudad_codigodane`
  (en memoria, no cambia). Si el DANE viene sin cero inicial (`5001000`) se corrige.
- **País** Colombia · **Departamento** = 2 primeros dígitos del DANE (tabla de 33 departamentos) ·
  **Código postal** = 5 primeros dígitos del DANE.
- **Email entrega / confirmar**: fijo `informacionalproveedor@elogia.com.co`.
- **Dirección fiscal** = residencia. **Contacto**: vacío.
- **Obligaciones**: O-15 si autorretenedor renta o fuente; O-23 si autorretenedor IVA; O-13 y O-47
  siempre `false`; R-99-PN si no aplica ninguna. *(El RPA de MyEInvoice fija R-99-PN en pantalla.)*
- No expone cuenta bancaria, EPS/ARL ni licencia.
- Errores: `404` no existe, `409` varios resultados (con `details`), `400` documento inválido, `502` Silogtran.

```bash
curl -H "x-api-key: $API_KEY" "https://apis-legalizacion-silogtran.onrender.com/api/terceros/7308756"
```

### Utilidades

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Público. Estado, sesión y caché (`persistent`, filas, TTL) |
| POST | `/api/cache/clear` | Vacía la caché en memoria y en Supabase |

---

## Cómo funciona

1. **Login PRADO** (`src/silogtran.js`): GET a la página de login → POST con usuario/clave y
   `PRADO_POSTBACK_TARGET` → selección de centro de costo (`SILOG_COST_CENTER`, por defecto
   `CONSTRUPROYEC-PRINCIPAL`). Cookies en un *jar* en memoria; re-login automático si la respuesta
   vuelve al login. Peticiones serializadas (PRADO guarda estado por sesión).
2. **AWS WAF**: si Silogtran responde con un *challenge*, Chromium headless (incluido en la imagen)
   obtiene la cookie `aws-waf-token` y se reintenta.
3. **Informes** (`src/reports/engine.js`): GET al formulario → se envían todos los campos
   (incl. `PRADO_PAGESTATE`) + fechas + *Tipo de Impresión* = CSV + botón *Generar*. Silogtran
   responde `window.open('../reportes/DOC_<hash>.csv')`; se descarga ese CSV y se parsea
   (delimitador automático, Windows-1252, se elimina la columna vacía final).
4. **Rangos largos** (`src/reports/range.js`): se dividen por mes calendario y se unen.
5. **Cruce** (`src/reports/combined.js`): índice SAP *Legvia codigo → Vehiculo* sobre todo el rango
   (un código puede tener su SAP en otro mes), filtro de conceptos y anulados por mes.
6. **Salida en streaming**: JSON/CSV se escriben por bloques (no se arma todo en memoria).

### Caché

| Mes | Vida |
|---|---|
| En curso | Nunca se cachea (siempre desde Silogtran) |
| Anterior | `CACHE_TTL_HOURS` (24 h, por legalizaciones tardías) |
| Más antiguos | `CACHE_TTL_OLD_HOURS` (168 h = 7 días) |

- Orden de búsqueda: **memoria → Supabase → Silogtran**.
- Memoria: tope `CACHE_MAX_ROWS` (250 000 filas, LRU).
- Viaje crudo no se cachea; se cachea el Viaje **ya filtrado** del cruzado (solo con la exclusión
  por defecto) y SAP crudo.
- Supabase (`src/reports/store.js`): tabla `public.silog_report_cache` (gzip + base64, RLS activo
  sin políticas → solo la clave secreta del servidor accede). Retención
  `SUPABASE_CACHE_RETENTION_DAYS` (30). Si Supabase falla, la API sigue con Silogtran.

---

## Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `SILOG_BASE_URL` | sí | `https://construproyec.colombiasoftware.net` |
| `SILOG_USER`, `SILOG_PASSWORD` | sí | Usuario de servicio de Silogtran |
| `API_KEY` | sí | Clave estática del header `x-api-key` (`openssl rand -hex 32`) |
| `SILOG_COST_CENTER` | no | Centro de costo (coincidencia parcial). Def. `CONSTRUPROYEC-PRINCIPAL` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | no | Activan la caché persistente |
| `SUPABASE_CACHE_RETENTION_DAYS` | no | Def. 30 |
| `CACHE_TTL_HOURS` / `CACHE_TTL_OLD_HOURS` | no | Def. 24 / 168. `CACHE_TTL_HOURS=0` desactiva caché |
| `CACHE_MAX_ROWS` | no | Def. 250000 |
| `MAX_RANGE_DAYS` | no | Def. 731 |
| `WAF_CHROME_PATH` | no | Ruta de Chrome (la imagen Docker ya trae `/usr/bin/chromium`) |
| `WAF_WAIT_SEC`, `SILOG_TIMEOUT_SEC` | no | Def. 30 / 120 |

---

## Estructura

```
server.js                 # arranque (sin timeout de petición para barridos largos)
src/app.js                # rutas, API key, streaming JSON/CSV, errores
src/silogtran.js          # cliente PRADO: cookies, login, centro de costo, WAF
src/session.js            # sesión única compartida + re-login
src/terceros.js           # tercero + ciudad DANE + Información Económica
src/reports/index.js      # catálogo de informes y nombres de campos PRADO
src/reports/engine.js     # formulario → Generar → descarga del CSV
src/reports/csv.js        # parser CSV
src/reports/range.js      # división por meses + caché escalonada
src/reports/store.js      # caché persistente en Supabase
src/reports/combined.js   # cruce Viaje + SAP, filtros de concepto y anulados
Dockerfile · render.yaml · .env.example
docs/GUIA_PRINCIPIANTES.md
```

---

## Despliegue y operación

- **Render (free, Docker)**: servicio `apis-legalizacion-silogtran`, región Virginia. Variables en
  *Environment*. Si GitHub no está conectado a Render, los deploys se lanzan con *Manual Deploy*.
- **Supabase**: proyecto `graziany.answer@gmail.com's Project` (us-east-1), tabla `silog_report_cache`.
- **cron-job.org**: GET a `/health` cada 10 min, lunes a sábado 6:00–19:50 (America/Bogota), para
  que Render no se duerma en horario laboral (~365 h/mes de las 750 gratis).
- Plan free de Render: se duerme tras 15 min sin tráfico (despertar ~1 min); 750 h/mes por
  workspace; disco efímero (por eso la caché persistente va en Supabase).

## Local

```bash
cp .env.example .env   # completar; en Windows/Mac definir WAF_CHROME_PATH
npm install && npm run dev
```
