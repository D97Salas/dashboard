h90 UAS DG — Dashboard global de Fud

> Contexto permanente del dashboard interno. Leer ESTO antes de tocar código:
> evita releer `business_fud`, `auth_fud` y `wallet` en cada consulta nueva.
> Si el código y este archivo divergen, gana el código — y hay que actualizarlo.

---

## 1. Qué es y para quién

Panel de administración global de Fud. **Dos usuarios: los dos socios.** No es un
producto, es una herramienta interna. Esa restricción justifica casi todas las
decisiones de aquí: sin routing, sin paginación, sin i18n, sin code-splitting,
sin sistema de permisos propio.

### Las dos mitades

| Mitad | Ruta | Qué contiene |
|---|---|---|
| **Frontend** | `fud/dashboard_fud/` | React 19 + Vite 8 + Recharts. Repo suelto (sin git propio todavía). |
| **Backend** | `fud/business_fud/src/dashboard/` | Módulo plano de Django. Sin modelos, sin migraciones, sin DRF. |

El build de Vite escribe **directo** en `business_fud/static/dashboard/`
(`vite.config.js` → `outDir`). Ese bundle **sí entra al repo de business**:
`static/` no está en su `.gitignore`. Es deliberado — desplegar no requiere Node
en el servidor.

Nombres de archivo fijos (`app.js`, `app.css`, sin hash) para que el template no
tenga que leer un `manifest.json`. Si el navegador se queda pegado: `Ctrl+F5`.

---

## 2. Arquitectura y flujo de datos

```
Navegador (mismo origen, cookie sessionid del admin de Django)
  ├─ /admin/                         Django Admin  ── botón "Dashboard"
  ├─ /admin/dashboard/               TemplateView + superuser_required
  │                                    └─ static/dashboard/app.js  (React)
  ├─ /admin/dashboard/api/metrics/         → selectors.dashboard_data()
  └─ /admin/dashboard/api/detail/<key>/    → detail.metric_detail()
                                             └─ ORM de business_fud
```

**React habla con UN solo backend: business.** Nunca con `auth` ni con `wallet`.

### Por qué (no cambiar esto sin leer)

- La cookie de sesión es de *business*. `wallet` y `auth` no la comparten y no
  deben aprender a leerla: sería construir un segundo sistema de autenticación.
- El middleware de wallet **exige** el claim `obo` con `sub/role/sid/jti` en todo
  JWT técnico. Un dashboard global no tiene un humano detrás, así que no hay
  `obo` natural que mandar.
- Los endpoints de datos de wallet son todos `/v1/wallet/user/<auth_user_id>/…`,
  con guardas BOLA. **No existe endpoint agregado.**
- `auth` no tiene cifras: su superficie interna son 4 endpoints
  (`technical-jwt/issue`, `service-accounts/provision|delete`, `users/by-ids`).
  Lo único que aportaría es hidratar nombres, y para eso ya existe
  `src/gateway/clients/auth_user_lookup_client.py` (batch + caché Redis 5 min +
  tolerante a fallos).

### Qué NO puede responder este dashboard

Saldos de billeteras, float total, escrow, cuadre real contra el ledger. Eso vive
en `wallet`. Business guarda el `ledger_id` que grabó `FinalizationService`, pero
no los saldos.

Para tenerlo haría falta: (a) endpoint agregado nuevo en wallet, (b) scope
concedido al `ApiClient` de business en su DB (ojo con el AND estricto de
`scope_check`), (c) decidir qué `obo` se manda. **Es la parte cara. No empezarla
sin pedirlo explícitamente.** El panel de integridad (§5) detecta la mayoría de
descuadres sin salir de business.

---

## 3. Autenticación

Sesión nativa del admin de Django. Toda la capa son 4 líneas en `views.py`:

```python
superuser_required = user_passes_test(
    lambda u: u.is_active and u.is_superuser,
    login_url="admin:login",
)
```

Detalles que importan:

- **Las URLs van fuera de `/api/`** a propósito: `GlobalHeadersMiddleware`
  (`src/core/middleware.py:75`) solo aplica a `/api/`, así el navegador no tiene
  que mandar `X-Client-ID`/`X-Device-ID`/etc.
- `path('admin/dashboard/', …)` va **antes** de `path('admin/', admin.site.urls)`
  en `config/urls.py`. Si va después, el `catch_all_view` del admin lo intercepta
  y devuelve 404.
- Es **solo GET**, así que no hay CSRF que manejar. El primer POST necesitará
  `{% csrf_token %}` + cabecera `X-CSRFToken`.
- El decorador va en **cada** vista. Un endpoint nuevo sin él queda público, y
  fuera de `/api/` tampoco lo protege el middleware de cabeceras.

---

## 4. El contrato de datos

### `GET /admin/dashboard/api/metrics/?desde=&hasta=&city=&store=`

Sin fechas → **todo el histórico** (desde el primer registro real). Devuelve un
objeto plano; cada clave es un panel. Las que existen hoy:

`filters` · `range` · `cities` · `stores` · `kpis` · `trend` · `events` ·
`auth_watch` · `scoped_to_store` · `alerts` · `revenue` · `payments_by_status` ·
`orders_funnel` · `orders_mix` · `sales_by_store` · `top_products` ·
`dispatches` · `dispatch_times` · `active_users` · `topups` · `terminals` ·
`low_stock`

### `GET /admin/dashboard/api/detail/<key>/?…&f_<col>=<valor>`

Las filas y gráficos detrás de una tarjeta. **Todas las métricas devuelven la
misma forma**, para que el frontend tenga un solo renderizador:

```python
{
  "key", "title", "note"?, "ignores_date_range"?,
  "columns": [{"key", "label", "type"}],   # type: text|num|money|datetime|status|dur
  "rows":    [{...}],                      # máx. ROW_LIMIT (100)
  "total":   int,                          # cuántas hay DE VERDAD
  "filters": [{"key", "label", "options", "value"}],
  "charts":  [{"id", "label", "type", "unit"?, "points": [{"label","value","n"}],
               "series"?: ["COMPLETED", …], "dim"?: "estado"}],
  "stats"?:  {...},                        # ticket_avg y dispatch_times
  "stats_unit"?: "dur",                    # las stats son segundos, no pesos
}
```

`type: "dur"` y `unit: "dur"` = **segundos**. Sin ellos el frontend adivina el
formato (`value != n` ⇒ dinero) y muestra «$180» donde van 3 minutos.

Métricas registradas en `detail.METRICS`: `revenue`, `payments`, `orders`,
`terminals`, `commission`, `topups`, `ticket_avg`, `dispatch_times`,
`auth_failures`, `active_users`, `events`, más una por alerta (`limbo_payments`, `outbox_stuck`, `allocation_mismatch`,
`paid_orders_without_allocation`, `topups_stuck`, `stale_dispatches`).

**Frescura.** Ninguna **cifra** se cachea: cada request re-consulta el ORM.
La única excepción es la *forma* del dato — `selectors._cached` memoiza en el
proceso, 5 min, `status_domain()` (qué estados existen) y `data_start()` (dónde
empieza el histórico). Son consultas sobre la tabla entera que no dependen del
filtro y cuyo resultado cambia casi nunca; ninguna de las dos altera un número.
En memoria y no en Redis a propósito: con Redis caído `cache.get` tarda **117 ms
en fallar** y son 9 llamadas por request. Los tests limpian `selectors._META` en
`setUp` — sin eso un test hereda el dominio vacío que cacheó el anterior. Las
dos vistas llevan `@never_cache` — no traían **ninguna** cabecera de caché, así
que nada le impedía al navegador (o a un proxy delante) devolver cifras viejas.
El botón de refrescar recarga el panel **y** el cajón abierto (`tick` va a las
dependencias del `useEffect` de `Detail`; sin eso el cajón se quedaba con los
datos de cuando se abrió). Lo único que sí se queda pegado es el **bundle**, que
va sin hash: tras un `npm run build` hace falta `Ctrl+F5` — pero eso es código,
nunca datos.

**Contrato de respuesta:** este módulo usa `JsonResponse` crudo, **no**
`api_success`/`api_error`. Es deliberado: ese contrato existe para las apps
móviles y el POS, que hay que versionar. Aquí no hay clientes externos. No lo
"arregles".

---

## 5. Cómo sacar datos nuevos para un gráfico

Este es el procedimiento que evita releer los repos.

### Dónde está cada cosa (business_fud, ~60 tablas)

| Necesitas | Modelo | Notas |
|---|---|---|
| Ingresos, cobros | `payments.PaymentTransaction` | FK `store`, `terminal`; `status` en `core.enums.PaymentStatus` |
| Lo que gana Fud | `payments.TransactionCommission` | `commission_amount`; FK `store` |
| Recargas | `payments.TopupRequest` | FK `store`, `terminal`; `TopupStatus` |
| Efectos remotos pendientes | `payments.WalletOperationOutbox` | **Sin FK a Store** — se vincula por `(ref_type, ref_id)` |
| Órdenes, embudo | `orders.Order` | `status`, `payment_status`, `origin`, `payment_owner_type` |
| Ítems vendidos | `orders.OrderItems` | `name`, `quantity`, `subtotal` |
| Despachos | `orders.Dispatches` | `DispatchStatus`; el 39% ABANDONED fue un hallazgo real. `opened_at`/`closed_at`, `TTL_MINUTES = 10` |
| Facturación | `orders.Invoice`, `InvoiceItem` | |
| Vínculo PT↔Order↔Invoice | `payments.PaymentAllocation` | fuente de verdad del reparto |
| Terminales | `devices.Terminal` | inventario, no flujo |
| Catálogo, stock | `catalog.StoreHasProduct`, `Stock`, `StockEvent` | |
| Tiendas, ciudades | `stores.Store`, `locations.City` | `Store.city` |
| Auditoría | `audit.AuditLog` | 500+ filas, **sin FK a Store**; append-only. El 57% son 401/403 (§8) |
| Metadatos de request | `AuditLog.payload` (JSON) | `endpoint`, `client_ip`, `user_agent`, `response_status`, `duration_ms`, `headers` |

**Tablas vacías — no construir sobre ellas:** todo `ads.*` (9 tablas),
`RefundRequest` (flujo sin definir), `OrderShares`, `GatewayEvent`,
`WalletPointPayments`, `BanckAccount`.

### Receta: panel nuevo en el dashboard principal

1. En `selectors.py`, función `_mi_panel(qs_o_f)` que devuelva una lista de
   dicts con claves primitivas. Agregar en DB (`annotate`/`aggregate`), nunca en
   Python.
2. Aplicar el ámbito: `f.apply(qs)` (fechas + tienda + ciudad) o `f.scope(qs)`
   (solo ámbito, para inventarios y alertas). **Nunca `Model.objects.all()` sin
   pasar por uno de los dos.**
3. Añadir la clave al dict de `dashboard_data()`.
4. Añadir la clave a `PANELES` en `tests.py`.
5. En `App.jsx`: `const colX = paleta(data.mi_panel, 'clave')` y
   `<BarTable rows={top(mi_panel)} colors={colX} />`.

### Receta: métrica nueva en el cajón de detalle

1. En `detail.py`, `def _mi_metrica(f, sel)` devolviendo la forma de §4.
2. Facetas con `_facets(base, [(key, label, campo_orm)], sel)` — filtra en la DB
   y calcula las opciones antes de aplicar los filtros.
3. Series temporales: `_daily(qs, f, agg, split="campo", dim="faceta")` — una
   línea por valor del campo. **Nunca escribir un `TruncDay` a mano** (ver §6).
4. Registrar en `METRICS`. El test recorre el registro solo.

---

## 6. Invariantes — los errores que ya se cometieron

Cada uno de estos se rompió al menos una vez. No repetirlos.

**El inicio del histórico son TODAS las fuentes, y no solo `created_at`.**
`data_start()` miraba `created_at` de pagos y órdenes; la auditoría empieza antes
y `Order.date` (el día **comercial**, que fija quien crea la orden) empieza aún
antes. El botón «Todo» arrancaba después de registros que sí existen y el preset
«1a» mostraba **más** datos. `HISTORY_SOURCES` es una lista de
`(modelo, campo)` — un panel nuevo que lea otra fuente reabre el agujero.
`AuditLog` va aparte: sin FK a Store, solo cuenta sin ámbito. Hay test.

⚠️ **`Order.date` ≠ día de `Order.created_at` en 12 de 30 órdenes** de la base de
dev, en ambos sentidos (una orden con `date` 10-abr creada el 20; otra con `date`
15-jun creada el 9). Todos los paneles filtran por `created_at`: una venta con
fecha comercial del 10 de abril se cuenta en la semana del 20. Cambiar el campo de
filtrado movería el 40% de las órdenes de período — **es una decisión de negocio,
no se cambió por cuenta propia.**

**El margen entre paneles lo lleva la grilla.** `.grid .panel` va a `margin: 0`,
así que un panel ancho justo después de un `.grid` queda pegado al último de la
fila si `.grid` no trae su propio `margin-bottom`.

**Color de fallo en el cajón.** El detalle colorea por ítem solo mientras la lista
quepa en los 8 slots; pasado eso cae a un tono único y los eventos de fallo se
volvían azules como el resto. Un punto puede traer `bad: true` y entonces se pinta
con `statusColor('FAILED')` pase lo que pase — el panel y su detalle no pueden
decir cosas distintas sobre lo mismo.

**El filtro de fecha va contra la columna cruda, nunca con `__date`.**
`created_at__date__gte` envuelve la columna en la función de zona horaria
(`(created_at AT TIME ZONE 'America/Bogota')::date`), y una columna dentro de una
función **no puede usar su índice**: las 46 consultas con fecha del panel salían
por seq scan. `Filters.dates()` convierte el rango a instantes
(`__gte` / `__lt` con `bounds()`) — misma condición, 155 ms → 1,3 ms sobre 500k
filas. Hay índice de `created_at` en las 5 tablas calientes (+ `orders.date`,
que lee `data_start`). **Un panel nuevo que escriba `__date__gte` a mano vuelve a
abrir el agujero**: usar `f.apply()` (con ámbito) o `f.dates()` (sin él).

**Zona horaria.** `TIME_ZONE='America/Bogota'`, `USE_TZ=True`, la DB guarda UTC.
`created_at.date()` devuelve la fecha **UTC**: una venta de las 20:30 en Bogotá
se contaba al día siguiente. Usar siempre `timezone.localdate(dt)` y
`timezone.localdate()` — nunca `date.today()`, que lee el reloj del **sistema
operativo** (en un contenedor UTC devuelve mañana después de las 19:00).

**Huecos en las series.** Devolver solo los días con ventas hace que el área
trace una recta entre el 22-abr y el 2-may, insinuando ingresos que no
existieron. Un día sin ventas es un **cero**, no un dato ausente. Todo gráfico
temporal pasa por `selectors.period_series()`, que rellena y elige el bucket
según el rango (día ≤92d · semana ≤750d · mes más allá). **Este error se
reintrodujo al copiar la función a `detail.py`** — por eso hay un solo punto.

**Fuente única por alerta.** `selectors.alert_querysets(f)` alimenta *a la vez*
el contador de la tarjeta y las filas del detalle. Si el detalle recalculara,
abrirías "3 cobros en limbo" y verías otro número.

**Ámbito.** `Filters.apply()` = fechas + ámbito; `Filters.scope()` = solo
ámbito. Están separados porque cuando iban juntos, cualquier panel que quisiera
ignorar las fechas (inventarios, alertas) ignoraba también la tienda y mostraba
datos globales. Hay un test que pide el dashboard con una tienda inexistente y
exige que **todo** dé cero.

**Un trazo único sobre varios estados esconde el dato.** «Cayeron las recargas»
y «las recargas ahora expiran» dibujaban la misma curva. Los gráficos temporales
del cajón salen de `detail._daily(..., split=campo, dim=faceta)`: una línea por
estado, sin relleno (dos áreas translúcidas dan un tercer tono que no es ningún
dato), y una sola serie cuando queda un valor —el filtro puesto— o cuando pasan
de los 8 slots. El frontend guarda la paleta por `dim`, no por `chart.id`: la
línea y las barras de la misma dimensión describen lo mismo y no pueden usar
colores distintos.

**Color estable.** El color sigue a la **entidad**, nunca a su posición en la
lista visible. Asignar por índice repinta a los supervivientes cuando se filtra.
El slot lo da la posición en el **dominio**, que es único para toda la app:
`selectors.status_domain(modelo, enum)` = los valores del enum que la base ha
usado **alguna vez**, sin `f.apply()`. Lo consumen los paneles de estado, las
facetas del cajón (4º elemento del spec en `_facets`) y de ahí la paleta del
frontend. Dos errores que ya costó:
- El dominio **no puede salir del período**: si sale, acotar el rango cambia qué
  estados hay y EXPIRED es azul con un filtro y verde con otro.
- El dominio **no puede ser el enum entero**: `TopupStatus` tiene 10 valores y
  `PaymentStatus` 11 contra 8 slots, y los últimos (`CREDITED`) quedan sin color.

Una fila en **cero conserva su slot** — saltarla era la puerta de atrás por la
que volvía el repintado. Comprobación: `npm run check`.

**Recharts 3.10 no pinta `layout="vertical"`** en este montaje: los
`recharts-bar-rectangle` salen vacíos, sin `<path>`. Todas las barras van en
HTML plano (`BarTable`). Recharts se usa **solo** para el área temporal.

**N+1.** Tocar `r.store.name` en 100 filas dispara 100 queries. Usar `values()`
con alias `F()`, o `select_related` (los builders de alerta lo declaran en
`related=`). Ojo: un alias de `values()` no puede llamarse igual que un campo del
modelo (`terminal=F("terminal__name")` revienta; usar `term=`).

**`__isnull=True` en relación inversa.** `City.objects.filter(stores__deleted_at__isnull=True)`
también empareja las ciudades **sin** tiendas (LEFT JOIN → NULL IS NULL es
cierto). Resolver con subquery sobre el modelo hijo.

**Entrada no confiable.** Los filtros vienen de query params. Un `store` que no
sea UUID reventaba el ORM con `ValidationError` → 500. Validar en
`Filters.from_query`.

---

## 7. Reglas de visualización

Vienen de la skill `dataviz`, aplicadas y verificadas contra este proyecto.

- **La forma la decide el trabajo del dato.** Magnitud → barra. Tendencia →
  línea/área. Parte-de-un-todo → barra apilada al 100% (no un ranking).
  Un número → tarjeta, no un gráfico de una barra.
- **8 slots y solo 8** (`palette.js`). Un noveno color generado es
  indistinguible bajo daltonismo. Los paneles se recortan a 8 filas y el resto
  se ve en el detalle. **Nunca ciclar la lista.**
- Los hexes están **validados** con `scripts/validate_palette.js` de la skill,
  contra las superficies reales (`#fff` / `#172029`). No cambiarlos sin volver a
  correrlo. El orden de los slots es el mecanismo de seguridad CVD, no cosmética.
- Cinco estados llevan **color propio** (`palette.STATUS_SLOT`, pedido explícito):
  PAID verde azulado · COMPLETED verde · PENDING ámbar · EXPIRED rosa ·
  CANCELLED rojo. Son **índices de slot**, no hexes nuevos: el tema oscuro usa su
  variante y la paleta sigue siendo la validada. Los demás estados toman un slot
  **libre** (el que se lleva un color propio no se reparte dos veces). A FAILED
  no se le asigna rojo a propósito: junto a CANCELLED serían el mismo tono en el
  mismo gráfico, que es justo donde hay que separarlos.
- La escala `statusColor()` (rojo/ámbar/verde de `STATUS`) es otra cosa y sigue
  reservada a **Eventos del sistema** y a los puntos marcados `bad`.
- Nunca esconder un valor solo tras el tooltip: la cifra exacta va visible.
- Cifras proporcionales en números grandes; `tabular-nums` solo en columnas y
  ticks de eje.
- **El formato no puede contradecir al dato.** `money()` fija los decimales
  según el monto: el peso no lleva centavos, pero redondearlos en cifras chicas
  hacía que tres comisiones de `$0,32 / $0,09 / $0,11` se dibujaran «$0» y su
  total `$0,52` como «$1» — un panel que se desmiente solo con la base intacta.
  Aparecen decimales solo si hay parte fraccional y el monto es < 1000, donde esa
  parte **es** el dato. `moneyShort` delega en `money` por debajo de mil: `compact`
  también redondeaba (0,52 → «$0,5»).
- Grilla sólida de un paso (nunca punteada). Área al ~14% de opacidad.
- Etiquetar solo el extremo, jamás cada punto.

### Estructura de la página

Cinco secciones (`<Section>` + el índice de anclas de la topbar), en este orden:

`resumen` (KPIs) · `alertas` (integridad, caídas, accesos) · `ventas` ·
`operacion` (órdenes, despachos, usuarios, stock) · `sistema` (auditoría).

El orden no es temático sino de urgencia: **primero lo que obliga a actuar**,
después lo que se consulta. Un panel nuevo va en su sección, no al final.

Las secciones **no se pliegan** y no guardan estado: con quince paneles el
problema es encontrarlos, y para eso bastan un encabezado y un ancla. El salto usa
`href="#id"` nativo — nada de router. Si se agregan filas a la topbar hay que
subir `.sect { scroll-margin-top }` o el ancla queda tapada por la barra sticky.

---

## 8. Análisis y umbrales

**Comparación de períodos** (`_trend`): el rango elegido contra el
inmediatamente anterior del mismo largo. Nada de medias móviles ni z-scores
sobre cinco puntos.

Dos guardas contra falsas alarmas, ambas con test:
- `MIN_BASE = 5` transacciones en el período previo. Pasar de 2 ventas a 1 no es
  "-50%", es ruido.
- `no_history`: si la ventana anterior cae entera antes del primer registro, no
  es "poca muestra", es que no hay pasado. Se dice, no se alarma.

`MIN_BASE` se exige también **por entidad** dentro de `_drops`, no solo sobre el
total: el agregado puede tener base de sobra y una tienda suelta no.

`DROP_PCT = 25` levanta la bandera. Umbral fijo marcado `ponytail:` — si genera
ruido, pasar a media móvil + desviación.

`_drops(now, prev, campo, clave)` alimenta dos listas de `trend`, porque un
agregado sano esconde una muerte:
- `store_drops` — una tienda apagada se pierde en el total: si nueve suben y una
  muere, el agregado apenas se mueve. Vacío si ya hay una tienda seleccionada.
- `method_drops` — un método de pago que cae casi nunca es demanda: es el
  datáfono, el proveedor o una integración rota. Se avisa **aunque el total esté
  plano** (`alarm` sigue siendo solo de ingresos), en un cuadro `.warn` con las
  filas clickeables → detalle `revenue` filtrado por ese método.

Lo que NO cubre: un método que sigue intentándose pero falla se ve como caída de
ingresos, no como pico de `FAILED` por método. Si hace falta, la tasa de fallo
por método sale del mismo `payment_method__display_name` sobre `payments` sin
filtrar por `PAID`.

### Tiempos de despacho (`dispatch_times`)

`closed_at - opened_at` sobre `selectors.timed_dispatches(f)`. Promedio, mejor,
peor, y el desglose por terminal (peor promedio primero). Las tres cifras van
juntas: dos terminales con el mismo promedio y peores tiempos de 2 y 20 minutos
no tienen el mismo problema.

**Solo `PAID`.** En `ABANDONED`/`CANCELLED` el `closed_at` lo escribe el barrido
que los expira, no el operador: con `TTL_MINUTES = 10`, los ABANDONED de la base
promedian **días**. Mezclarlos convierte «atiende en 3 min» en «atiende en una
semana». Cuántos se abandonan ya se ve en «Desenlace de despachos». Hay test.

`over_ttl` compara contra `Dispatches.TTL_MINUTES`: es el umbral que ya define el
dominio, no uno inventado en el dashboard. Sin él, «el peor fue de 9 min» no dice
si eso está bien o mal.

**La resta va con `ExpressionWrapper(..., output_field=DurationField())`**, nunca
con `Extract(…, "epoch")`: eso exige `DurationField` nativo y revienta en SQLite,
que es la base de **dev** (prod es Postgres). El wrapper agrega en las dos.

Mediana y percentiles salen de `_stats` (el mismo de `ticket_avg`) sobre la lista
de segundos. Eso **sí** trae todas las duraciones del rango a Python — no hay
percentil portable en DB y es lo que ya hace `ticket_avg` con los montos, que son
muchos más. Marcado `ponytail:` en el código; el día que moleste, `PERCENTILE_CONT`
en Postgres.

### Vigilancia de acceso (`auth_watch`)

Sale de `AuditLog`, no de `auth_fud`: **los fallos de acceso ya están en business**
(`target_table='ENDPOINT'`, 288 de 503 filas). No hace falta hablar con auth — que
además no tiene cifras (§2).

`AUTHENTICATION_FAILED` (401) y `AUTHORIZATION_FAILED` (403) **no se suman en una
cifra**: 401 repetido es alguien probando credenciales; 403 repetido es alguien que
ya entró y está pidiendo lo ajeno. El segundo es el grave. Las columnas que lo
vuelven accionable son `targets` (recursos distintos tocados) e `ips`: 403 alto con
`targets` alto es enumeración; 401 alto con `ips` alto es una credencial rotando.

`AUTH_FAIL_MIN = 10` fallos de un actor marca la fila. Umbral fijo `ponytail:`.

**Este panel SÍ respeta el rango de fechas**, al revés que `alerts`. Un cobro
colgado de hace dos meses sigue siendo un problema hoy; una ráfaga de 401 de hace
dos meses ya no. Y con "todo el histórico" cualquier actor acaba cruzando el
umbral, con lo que la marca deja de significar nada. Por eso no está en
`alert_querysets` — su contrato es justo el contrario.

**`normalize_actor()`, la trampa que ya estaba en los datos.** El mismo actor se
guarda con el UUID crudo *y* con el UUID en base64 (el `security_user_id` del
middleware): en la base real, 109 fallos bajo `MWE0YzA1…` y 75 bajo `1a4c059a-…`
son la misma persona. Sin unirlos se parte en dos filas, ninguna llega a 10, y el
que más golpea es justo el que no se marca. El fold va sobre las filas **ya
agregadas** (una por alias), no sobre los eventos. `targets`/`ips` se toman al
**máximo** entre alias, no sumados: sumar contaría dos veces el mismo endpoint e
inflaría la sospecha. La faceta de actor del detalle une los mismos alias
(`_actor_facet`) — si no, la tarjeta diría 184 y el cajón 75. Hay test.

**Del payload solo salen `endpoint`, `client_ip` y `user_agent`.** `headers` no:
hoy trae `Authorization: "PRESENT"` (ya redactado) y el `X-Device-ID`, pero nada
garantiza que el próximo header venga limpio y la vista no lo necesita.

Ojo en dev: los 288 fallos son de `127.0.0.1` con Postman/curl — desarrollo, no un
ataque. El panel los marca igual, que es lo correcto: filtrarlos por user-agent
sería enseñarle a la alerta a callarse justo con la herramienta que usaría un
atacante.

### Usuarios activos (`active_users`)

Cuenta **usuarios distintos**, no órdenes: veinte órdenes pueden ser veinte
personas o una que volvió veinte veces, y «Tipo de pagador» solo reparte órdenes.

Un usuario es el par **(`payment_owner_id`, `payment_owner_type`)** — el id solo
no identifica a nadie, el mismo UUID puede ser una billetera y un customer
distintos. Los tipos se agrupan en `USER_GROUPS`:

| Grupo | `payment_owner_type` | Quién es |
|---|---|---|
| `consumer` | `USER_WALLET`, `GROUP_WALLET`, `USER_WALLET_TERMINAL` | el usuario final; con su plata, aunque pague desde el datáfono |
| `customer` | `CUSTOMER` | dueño/empleado comprando a nombre del negocio |
| `terminal` | `TERMINAL` | el datáfono pagando a nombre propio. No es una persona |

Las terminales **activas** no salen de ahí sino de los despachos del período: una
terminal trabaja aunque todas sus órdenes las pague el consumidor.

**No hay dato de wifi vs datos móviles, y no se puede derivar.** Se buscó en todo
`business`: el modelo `WifiInfirmation` se borró en `devices/migrations/0004`, y
el contrato con las apps son exactamente cuatro cabeceras (`X-Client-ID`,
`X-Device-ID`, `X-App-Version`, `X-Platform` — `core/middleware.py:496`), ninguna
de red. `AuditLog.payload.headers` guarda solo esas. Para tenerlo hacen falta tres
pasos, y los dos primeros están fuera de este repo:
1. que la app Android mande la cabecera (p. ej. `X-Network-Type: WIFI|CELLULAR`),
2. que `GlobalHeadersMiddleware` la deje pasar y quede en el `payload`,
3. aquí: agrupar por `payload__headers__X-Network-Type`, que es una línea.

No inventar un proxy (`X-Client-ID`, latencia, `duration_ms`): ninguno distingue
wifi de datos, y una cifra inventada en un panel se usa para decidir.

---

## 9. Comandos

```bash
# Frontend (dashboard_fud/)
npm run dev      # :5173, hot-reload, proxy /admin → :8000
npm run build    # bundle → business_fud/static/dashboard/
npm run check    # comprobación de estabilidad de color

# Backend (business_fud/)
venv/Scripts/python.exe manage.py runserver
venv/Scripts/python.exe manage.py test src.dashboard.tests   # módulo EXPLÍCITO
```

⚠️ `src` es namespace package: el auto-discovery de tests falla si pasas un
paquete. Pasar siempre el módulo completo.

Entrada: `http://127.0.0.1:8000/admin/` → botón **Dashboard**.

---

## 10. Deuda conocida

1. `dashboard_fud/` **sin `git init`** — decisión del usuario, pendiente.
2. El bundle (≈570 kB / 170 gzip) entra al repo de business en cada build.
   Recharts es ~70% del peso y dibuja **un** gráfico; si alguna vez importa,
   sacarlo y hacer esa área en ~40 líneas de SVG deja el bundle en ~180 kB, a
   costa del tooltip.
3. Datos sembrados sucios en dev: 8 ciudades "Bogotá" con códigos inventados
   (`CITY-0001-…`) y departamento "Meta", todas sin tiendas.
4. Sin exportación a CSV. El detalle corta en 100 filas y avisa cuántas faltan.
5. El buscador filtra **filas**, no re-calcula los KPIs. Para acotar cifras está
   el selector de tienda, que sí va al backend.
6. **Lo que queda por optimizar** (medido, ninguno urgente hoy):
   - Las **alertas** agregan sobre la tabla completa sin fecha, por diseño
     (`allocation_mismatch` es un GROUP BY de todos los pagos × allocations).
     Crecen para siempre. Acotarlas a 90 días es decisión de negocio.
   - `ticket_avg`, `dispatch_times` y `_age_buckets` traen **todo el rango a
     Python** para percentiles/histogramas. Marcados `ponytail:`; el arreglo es
     `PERCENTILE_CONT` en Postgres.
   - `audit_logs` extrae `payload__endpoint`/`client_ip` **por fila y sin
     índice**: ya hoy son las dos consultas más lentas (99 ms y 80 ms con 500
     filas). Necesita índice de expresión o columnas materializadas.
   - Los índices nuevos se crearon **sin `CONCURRENTLY`**: en Postgres eso
     bloquea la tabla mientras dura. Con las tablas de hoy es instantáneo; si
     alguna vez hay millones de filas, usar `AddIndexConcurrently`.

---

## 11. Checklist antes de tocar código

1. ¿El dato sale del ORM de business? (si necesitas wallet/auth → §2, es caro)
2. ¿Pasaste el queryset por `f.apply()` o `f.scope()`?
3. ¿Fechas con `timezone.localdate()`, nunca `date.today()` ni `.date()`?
4. ¿Serie temporal por `period_series()`?
5. ¿Alerta nueva registrada en `alert_querysets()` (fuente única)?
6. ¿Colores por entidad (`stableColors`), no por índice?
7. ¿La forma del gráfico corresponde al trabajo del dato? (§7)
8. ¿`select_related`/`values()` para evitar N+1?
9. ¿`@superuser_required` en la vista nueva?
10. ¿Test añadido? El registro `METRICS` y la lista `PANELES` se recorren solos.
