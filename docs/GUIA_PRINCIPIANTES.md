# Guía para principiantes — APIs Legalización Silogtran

Esta guía explica **qué hace este proyecto y cómo funciona por dentro**, sin dar por hecho que
sabes programar. Si quieres el detalle técnico (parámetros, variables), mira el [README](../README.md).

---

## 1. La idea en una frase

Es un **robot que entra a Silogtran como lo harías tú**, saca informes y datos de terceros, los
limpia y te los entrega listos para usar en Google Sheets, Excel o en otro robot (como el RPA de
MyEInvoice).

Imagina que contratas a un asistente, le das un usuario de Silogtran y le dices: *"cada vez que
te pida el informe SAP de octubre, entra, llénalo, descárgalo y me lo pasas ordenado"*. Eso es
esta API, pero en segundos y sin pantalla.

---

## 2. ¿Por qué hizo falta un "robot"?

Silogtran **no tiene una puerta para programas** (una API oficial). Solo tiene páginas web hechas
para personas: formularios, botones y menús. Entonces el programa **imita a una persona usando
el navegador**:

1. abre la página,
2. escribe usuario y clave,
3. llena el formulario del informe,
4. pulsa *Generar*,
5. descarga el resultado.

---

## 3. Cómo "habla" una página web

Cuando usas una página, tu navegador le hace dos tipos de pedidos al servidor:

- **GET** = *"muéstrame esta página"* (abrir el formulario).
- **POST** = *"te envío estos datos"* (llenar el formulario y pulsar un botón).

El programa hace **exactamente los mismos pedidos**, solo que no dibuja nada en pantalla.

---

## 4. PRADO: los campos invisibles

Silogtran está hecho con una tecnología antigua llamada **PRADO**. PRADO esconde dentro de cada
formulario unos campos invisibles (por ejemplo `PRADO_PAGESTATE`) que son la *"memoria"* de la
página. Si envías el formulario sin ellos, Silogtran lo rechaza.

Por eso el programa siempre trabaja en dos pasos:

1. **GET** al formulario → lee **todos** los campos, incluidos los invisibles.
2. **POST** con esos mismos campos, cambiando solo lo necesario (las fechas, el documento…) y
   diciéndole a PRADO **qué botón se pulsó** (`PRADO_POSTBACK_TARGET`).

Los nombres exactos de los campos (por ejemplo `ctl0$MainModule$viaemp_fechainicial`) los sacamos
del HTML de las páginas que se guardaron con Ctrl+S.

---

## 5. Cómo entra a Silogtran (login)

Igual que tú:

1. Abre la página de login y lee sus campos invisibles.
2. Envía usuario y clave. **No están escritos en el código**: se guardan como "variables de
   entorno" en Render (`SILOG_USER`, `SILOG_PASSWORD`), así nunca quedan visibles en GitHub.
3. Silogtran pregunta el **centro de costo** → el programa elige `CONSTRUPROYEC-PRINCIPAL` y pulsa
   *Continuar*.
4. Comprueba que ya no está en la pantalla de login.

Si Silogtran pidiera cambio de clave o verificación en dos pasos, la API lo avisa con un error claro.

---

## 6. Las cookies: el "brazalete" de la sesión

Al entrar, Silogtran entrega una **cookie** (por ejemplo `PHPSESSID=abc123`). Piensa en ella como
el **brazalete de un evento**: ya no te piden la entrada, solo miran el brazalete.

- **Captura:** cada respuesta de Silogtran puede traer cookies nuevas; el programa las guarda en
  un "frasco" (*cookie jar*) en memoria.
- **Reutiliza:** en cada pedido siguiente muestra todas las cookies del frasco.
- **Renueva:** si Silogtran devuelve la pantalla de login, el brazalete venció → el programa
  vuelve a entrar solo y repite el pedido.
- **Protege:** nunca manda esas cookies a otro sitio que no sea Silogtran.
- **Hace fila:** los pedidos van **uno por uno**, porque PRADO se confunde si recibe dos a la vez
  con el mismo brazalete.

---

## 7. El portero de Amazon (AWS WAF)

Delante de Silogtran hay un "portero" de Amazon (**WAF**) que bloquea robots. A veces, en vez de la
página, responde con un **acertijo** que solo un navegador real sabe resolver.

Cuando pasa eso, el programa abre por unos segundos un **Chrome invisible** (Chromium "headless"),
resuelve el acertijo, recibe el **sello del portero** (cookie `aws-waf-token`), lo guarda en el
frasco y sigue con pedidos normales, que son mucho más rápidos.

---

## 8. Cómo saca un informe

Este fue el descubrimiento clave (gracias a una captura de la consola del navegador):

1. Llena el formulario (fechas y, en Viaje, *Tipo de impresión = CSV*) y "pulsa" **Generar**.
2. Silogtran **no devuelve el informe** directamente. Devuelve una orden que dice:
   `window.open('../reportes/DOC_e99d....csv')` → *"abre este archivo"*.
3. El programa busca esa orden, arma la dirección completa del archivo y lo **descarga**.
4. Lo convierte en tabla:
   - detecta solo el separador (`;`),
   - arregla los acentos (`Muñoz` y no `MuÃ±oz`),
   - quita una columna fantasma vacía que Silogtran agrega al final.

---

## 9. Qué le puedes pedir a la API

Le preguntas con una **dirección web (URL)** y una clave en el encabezado `x-api-key`. Sin esa
clave responde *"no autorizado"*.

| Pedido | Qué devuelve |
|---|---|
| `legalizacion-sap` | El informe SAP tal cual |
| `legalizacion-viaje` | El informe Viaje (sin anulados) |
| `legalizacion-viaje-sap` | Viaje + la placa de SAP, sin peajes electrónicos ni anulados |
| `terceros/<documento>` | Datos del proveedor listos para MyEInvoice |

Todos los informes aceptan `&format=csv` para bajarlos como archivo CSV (pesa la mitad que JSON).

Ejemplo (en CMD, todo en una línea; cambia `TU_API_KEY`):

```
curl -H "x-api-key: TU_API_KEY" "https://apis-legalizacion-silogtran.onrender.com/api/reports/legalizacion-viaje-sap?fechaInicial=2026-01-01&fechaFinal=2026-10-24&format=csv" -o viaje_sap.csv
```

> En CMD la URL **siempre entre comillas dobles**. Sin ellas, el `&` corta el comando
> (nos pasó: *"'fechaFinal' is not recognized as an internal command"*).

---

## 10. El informe cruzado (Viaje + placa SAP)

Funciona como un **BUSCARV de Excel**:

1. Saca los dos informes con las mismas fechas.
2. Arma un "directorio" con el informe SAP: **Legvia codigo → placa** (columna *Vehiculo*).
3. A cada fila de Viaje le busca su placa en ese directorio y le agrega dos columnas:
   - `placa_sap`: la placa encontrada.
   - `cruce_sap`: `true` si la encontró, `false` si no.
4. Quita filas que no sirven:
   - **PEAJE ELECTRÓNICO** (sin importar tildes o mayúsculas).
   - **Anulados**: legalizaciones sin *Concepto gasto* (salían como filas casi vacías). Si algún
     día los necesitas, agrega `&anulados=true`.

El cruce se hace **sobre todo el rango**, no mes por mes, porque un mismo código puede tener su
registro SAP en otro mes.

---

## 11. Terceros para el RPA de MyEInvoice

`terceros/<documento>` hace **dos consultas** en Silogtran y aplica las reglas del negocio:

1. **Busca el tercero** por documento (`Maestros.Tercero.Buscar`) y lee la ficha: tipo de
   documento, nombre, dirección, teléfono, email, ciudad, indicadores fiscales.
2. **Busca la ciudad** (`Basicos.Ciudad.Buscar`) para obtener su **código DANE** (8 dígitos, por
   ejemplo `25430000` = Madrid, Cundinamarca). La ciudad se recuerda, así que la segunda vez ya no
   la consulta.

Con el DANE se calculan:
- **Departamento:** los 2 primeros dígitos → `25` = Cundinamarca (tabla de los 33 departamentos).
- **Código postal:** los 5 primeros → `25430`.
- Si el DANE llega sin el cero inicial (`5001000` en vez de `05001000`, Antioquia), se corrige.

Reglas fijas:
- País: **Colombia**.
- Email de entrega y su confirmación: **informacionalproveedor@elogia.com.co**.
- Dirección fiscal: **igual a la de residencia**.
- Datos de contacto: **vacíos**.
- Obligaciones: la API las calcula, pero el **RPA de MyEInvoice siempre marca R-99-PN**.

Por seguridad **no devuelve** cuenta bancaria, EPS/ARL ni licencia. Errores posibles: *no existe*
(404), *hay varios con ese documento* (409), *documento inválido* (400).

---

## 12. El problema del año completo (y cómo se resolvió)

Al pedir de enero a octubre, el servidor **se quedó sin memoria** y se reinició (por eso curl no
devolvía nada). El informe Viaje traía **193.552 filas**. Se resolvió con cuatro ideas:

1. **Por partes:** un año se pide como 10–12 informes mensuales pequeños que luego se unen.
2. **Formato compacto:** las filas se guardan como listas simples, no como "objetos", que pesan
   mucho más.
3. **Envío por goteo (streaming):** la respuesta se manda en bloques, sin armar todo de golpe.
4. **Guardar lo filtrado:** en la memoria se guarda el Viaje **ya sin peajes ni anulados** (unas
   99 mil filas al año en vez de 193 mil).

---

## 13. La caché: "apuntes" para no repetir trabajo

La **caché** es como una libreta de apuntes: si ya sacaste el informe de marzo, lo anotas y la
próxima vez no vuelves a Silogtran.

**Vida escalonada** (cada mes se "vence" según qué tan probable es que cambie):

| Mes | ¿Cuánto dura el apunte? | ¿Por qué? |
|---|---|---|
| Mes en curso | Nunca se guarda | Cambia todo el tiempo |
| Mes anterior | 24 horas | Llegan legalizaciones tardías |
| Meses más antiguos | 7 días | Casi nunca cambian |

Resultado: un barrido del año solo regenera 1 o 2 meses; el resto sale de los apuntes en segundos.
Si corriges algo viejo en Silogtran y lo necesitas ya, `POST /api/cache/clear` borra los apuntes.

**Dos libretas:**
- **Memoria** (rápida, pero se borra si el servidor se reinicia o se duerme).
- **Supabase** (una base de datos en internet, gratis): los apuntes **sobreviven** a reinicios.
  Orden de búsqueda: memoria → Supabase → Silogtran. Si Supabase falla, la API sigue funcionando
  directo con Silogtran.

La tabla de Supabase está protegida: solo la **clave secreta** guardada en Render puede leerla.

---

## 14. Render: dónde vive el programa

**Render** es un servicio en internet que mantiene el programa encendido. Usamos el **plan
gratis**, que tiene reglas:

- Si pasan **15 minutos sin uso, se duerme**. Despertarlo tarda ~1 minuto.
- Da **750 horas al mes** (solo cuentan las horas despierto).
- Su disco es **temporal**: lo que guarda se borra al reiniciar (por eso la caché persistente va en
  Supabase).

**Para que no se duerma** usamos **cron-job.org** (gratis): visita `/health` cada 10 minutos, de
lunes a sábado de 6:00 a 20:00. Así nunca se cumplen los 15 minutos de inactividad en horario
laboral, y solo se gastan unas 365 de las 750 horas.

---

## 15. Docker: la caja de mudanza

El programa necesita varias cosas instaladas: **Node.js** (el motor), sus **librerías** y
**Chromium** (el Chrome invisible para el portero). Si en el servidor falta algo, no funciona.

**Docker** es una **caja de mudanza**: empacas el programa **junto con todo lo que necesita**, y
donde abras la caja funciona igual.

| Concepto | Analogía | En este proyecto |
|---|---|---|
| **Dockerfile** | La receta | El archivo `Dockerfile` |
| **Imagen** | El plato preparado | Lo que Render construye en el "Build" (~1 min) |
| **Contenedor** | El plato servido | La app corriendo ("Your service is live") |

La receta dice, en resumen: *parte de un Linux con Node 20 → instala Chromium → instala las
librerías → copia el código → arranca la app con un usuario sin permisos de administrador.*

---

## 16. Seguridad en pocas palabras

- **Usuario y clave de Silogtran**, **API key** y **clave de Supabase** viven solo en las
  variables de entorno de Render, nunca en el código ni en GitHub.
- La **API key** se compara de forma segura; sin ella todo `/api` responde *no autorizado*.
- **No pegues** tu API key en capturas o chats. Si se filtra, cámbiala en Render → *Environment*.
- La API **solo lee** Silogtran: no crea ni modifica nada.

---

## 17. Cómo se hacen los cambios

1. El código está en **GitHub**: `grachos/apis_legalizacion_silogtran`.
2. Cada cambio se sube (*push*) a la rama `main`.
3. Render lo vuelve a construir y publicar (*deploy*). Como GitHub no está conectado a Render, el
   deploy se lanza a mano: Render → *Manual Deploy* → *Deploy latest commit*.

---

## 18. Si algo falla

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| Tarda ~1 min la primera vez | Render estaba dormido | Normal fuera del horario del cron |
| `Invalid or missing x-api-key` | Falta la clave o está mal | Revisa el header `x-api-key` |
| `fechaInicial and fechaFinal are required` | Falta una fecha o la URL sin comillas | Pon la URL entre comillas dobles |
| `Column '...' not found` | Silogtran cambió el nombre de una columna | El error lista las columnas reales; ajustar el código |
| Informe con datos viejos | Apunte de caché aún vigente | `POST /api/cache/clear` |
| `Tercero ... not found` (404) | Documento no existe en Silogtran | Verifica el documento |
| Algo raro en un informe o tercero | — | Usa la misma URL con `/debug` para ver qué detectó |

---

## 19. Glosario rápido

- **API:** una "ventanilla" a la que un programa le pide datos con una URL.
- **Endpoint:** cada ventanilla específica (por ejemplo `/api/terceros/7308756`).
- **JSON / CSV:** formatos de datos. JSON es ordenado por campos (ideal para robots); CSV es una
  tabla de texto (ideal para Excel/Sheets).
- **Cookie:** el brazalete que demuestra que ya iniciaste sesión.
- **Headless:** un navegador que funciona sin ventana.
- **Caché:** apuntes guardados para no repetir trabajo.
- **Deploy:** publicar una nueva versión del programa.
- **Variable de entorno:** un dato secreto o de configuración que el programa lee del servidor.

---

**En resumen:** un robot que entra a Silogtran como tú, guarda su "brazalete" de sesión, pasa el
portero de Amazon con un Chrome invisible cuando hace falta, llena los formularios, descarga lo que
Silogtran genera, lo limpia, lo cruza, lo recuerda para la próxima vez y te lo entrega listo.
