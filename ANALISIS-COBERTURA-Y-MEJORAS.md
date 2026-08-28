# Tablero global de Fud — cobertura actual y revisión de los backends

> Fecha: 2026-08-28 · Revisión sobre `dashboard_fud` (frontend), `business_fud/src/dashboard`
> (backend del tablero) y el resto de `business_fud`, más `wallet` y `auth_fud` para el
> apartado de integraciones.
>
> Todo lo que aquí se afirma sobre datos está **verificado contra la base de dev**
> (`business_fud/db.sqlite3`) o ejecutando el código, no inferido de los comentarios.
> Cuando una cifra sale de dev se dice explícitamente.
>
> Suite del tablero: **30 tests, OK, 1 skip** (`manage.py test src.dashboard.tests`, 78 s).

---

## Índice

1. [Método de la revisión](#1-método-de-la-revisión)
2. [Parte I — Qué cubre el tablero hoy](#parte-i--qué-cubre-el-tablero-hoy)
3. [Parte II — Hallazgos: lo que el tablero dice mal](#parte-ii--hallazgos-lo-que-el-tablero-dice-mal)
4. [Parte III — Qué puede añadirse (revisión de backends)](#parte-iii--qué-puede-añadirse-revisión-de-backends)
5. [Parte IV — Integraciones caras: wallet y auth](#parte-iv--integraciones-caras-wallet-y-auth)
6. [Parte V — Riesgos operativos y de escalado](#parte-v--riesgos-operativos-y-de-escalado)
7. [Apéndice A — Mapa tabla → panel](#apéndice-a--mapa-tabla--panel)
8. [Apéndice B — Orden de trabajo sugerido](#apéndice-b--orden-de-trabajo-sugerido)

---

## 1. Método de la revisión

Qué se leyó, entero, no en diagonal:

| Capa | Archivos | Líneas |
|---|---|---|
| Backend del tablero | `business_fud/src/dashboard/{selectors,detail,views,urls,tests}.py` | 2.311 |
| Frontend | [src/App.jsx](src/App.jsx), [src/Detail.jsx](src/Detail.jsx), [src/components.jsx](src/components.jsx), [src/api.js](src/api.js), [src/palette.js](src/palette.js) | 1.699 |
| Modelos de negocio | `business_fud/src/*/models.py` (11 apps) | 2.325 |
| Enums de dominio | `core`, `orders`, `payments`, `catalog` | — |
| Integraciones | `business_fud/src/gateway/clients/*`, `wallet/config/urls.py`, `wallet/apps/*/urls.py` | — |
| Servicios de reporte ya existentes | `business_fud/src/stores/services/{reporting,terminal_reporting}_service.py` | — |

Verificaciones ejecutadas:

- Conteo de filas de las **77 tablas** de la base de dev.
- Consultas sobre poblado real de campos candidatos (`processed_at`, `ended_at`, `split_*`,
  `purchase_price`, `delivered_at`, `gateway_callback_at`, `payload.duration_ms`…).
- Ejecución de `dashboard_data()` con filtros de ámbito para comprobar fugas.
- Ejecución de la suite completa del tablero.

---

# Parte I — Qué cubre el tablero hoy

## 1.1 Superficie

Tres rutas, todas GET, todas bajo `@superuser_required`, dos con `@never_cache`:

| Ruta | Vista | Devuelve |
|---|---|---|
| `/admin/dashboard/` | `TemplateView` | el bundle React |
| `/admin/dashboard/api/metrics/` | `metrics_view` | los 22 paneles del tablero |
| `/admin/dashboard/api/detail/<key>/` | `detail_view` | las filas y gráficos detrás de una tarjeta (17 métricas) |

Parámetros de ámbito: `desde`, `hasta`, `city`, `store`. Filtros de columna del cajón:
`f_<col>`. Sin fechas explícitas, el rango es **todo el histórico**, calculado desde
`HISTORY_SOURCES` (`selectors.py:143`) — cinco pares (modelo, campo), incluido
`Order.date` además de `Order.created_at`, más `AuditLog` cuando no hay ámbito.

Autenticación: sesión del admin de Django, cuatro líneas en `views.py`. Las URLs viven
fuera de `/api/` para esquivar `GlobalHeadersMiddleware`. Sin CSRF porque no hay POST.

## 1.2 Los 22 paneles

Agrupados por las cinco secciones de la página (`resumen · alertas · ventas · operación ·
sistema`), en orden de urgencia y no temático.

### Resumen — 6 KPIs (`_kpis`, `selectors.py:246`)

| KPI | Cómo se calcula | Detalle |
|---|---|---|
| Ingresos | `Σ amount` de `PaymentTransaction` PAID del rango | `revenue` |
| Comisión plataforma | `Σ commission_amount` de `TransactionCommission` con `status=PAID` | `commission` |
| Recargas | `Σ amount` de `TopupRequest` en `CREDITED`/`COMPLETED` | `topups` |
| Ticket promedio | ingresos / nº de cobros PAID | `ticket_avg` |
| Órdenes | conteo, con `% pagadas` como sub-cifra | `orders` |
| Terminales | activas/total (inventario, ignora fechas) | `terminals` |

Los KPIs de ingresos y órdenes llevan variación contra el período anterior, atenuada
cuando la base no es fiable.

### Alertas — tres paneles

**1. «Requiere atención»** — seis alertas de integridad, todas desde la fuente única
`alert_querysets()` (`selectors.py:279`), **sin límite de fechas** y con ámbito aplicado:

| Alerta | Qué detecta |
|---|---|
| `limbo_payments` | cobros en `PENDING_WALLET_CAPTURE`, `PROCESSING_WALLET_CAPTURE`, `REQUIRES_RECONCILIATION` |
| `outbox_stuck` | filas del outbox de wallet sin `DONE`, con conteo de agotadas (`attempts ≥ max_attempts`) |
| `allocation_mismatch` | `Σ allocations ≠ amount` de la PT |
| `paid_orders_without_allocation` | órdenes PAID sin ninguna `PaymentAllocation` |
| `topups_stuck` | recargas en los cuatro estados de limbo |
| `stale_dispatches` | despachos `OPEN`/`PARTIAL` |

Cubre la mayoría de descuadres sin salir de business, que es exactamente lo que el
proyecto se propuso.

**2. «Cambios de comportamiento»** (`_trend`, `selectors.py:366`) — el rango contra el
inmediatamente anterior del mismo largo. Dos guardas contra falsas alarmas
(`MIN_BASE = 5` transacciones previas, `no_history` cuando la ventana previa cae antes
del primer registro), umbral `DROP_PCT = 25`. Y dos desagregados que evitan que un
agregado sano esconda una muerte:

- `store_drops` — tiendas que cayeron (vacío si ya hay tienda seleccionada).
- `method_drops` — métodos de pago que cayeron; se avisa **aunque el total esté plano**,
  porque un método que se cae casi nunca es demanda. Filas clickeables al detalle.

**3. «Vigilancia de acceso»** (`_auth_watch`, `selectors.py:524`) — 401 y 403 desde
`AuditLog`, separados y nunca sumados, con `targets` (recursos distintos) e `ips` como
columnas accionables, umbral `AUTH_FAIL_MIN = 10`, y `normalize_actor()` uniendo el UUID
crudo con su versión base64. Este panel **sí** respeta el rango de fechas, al revés que
las alertas de integridad. Incluye el top de recursos golpeados.

### Ventas — 4 paneles

- **Ingresos** — área temporal, único gráfico de Recharts del proyecto, con el bucket
  elegido por rango (día ≤92d · semana ≤750d · mes) vía `period_series()`
  (`selectors.py:616`), huecos rellenados en cero y el máximo etiquetado.
- **Pagos por estado** — barras HTML, en orden de dominio (`status_domain`).
- **Ventas por tienda** — total, nº y ticket por tienda, top 15 recortado a 8 en pantalla.
- **Recargas por estado** — monto acumulado por estado.

### Operación — 7 paneles

- **Órdenes por estado** (embudo), **Canal de venta** y **Tipo de pagador** (barras
  apiladas al 100 %, parte-de-un-todo), **Desenlace de despachos**.
- **Usuarios activos** (`_active_users`, `selectors.py:882`) — usuarios **distintos** por
  el par `(payment_owner_id, payment_owner_type)`, agrupados en `consumer`/`customer`/
  `terminal`, más terminales con actividad real (por despachos, no por quién pagó).
- **Tiempos de despacho** (`_dispatch_times`, `selectors.py:833`) — promedio, mejor, peor
  y `over_ttl` contra `Dispatches.TTL_MINUTES`, desglosado por terminal (peor promedio
  primero). Solo `PAID`, con razón: en `ABANDONED` el `closed_at` lo pone el barrido.
- **Stock bajo** — `Stock.quantity ≤ low_limit_quantity`.
- **Productos más vendidos** — por unidades (`OrderItems`).

### Sistema — 1 panel

- **Eventos del sistema** — conteo por `event_type` de `AuditLog`, con tasa de fallo
  calculada sobre **todos** los tipos aunque solo se dibujen 15, y los eventos de fallo
  pintados en rojo.

## 1.3 Las 17 métricas del cajón de detalle

Todas devuelven la misma forma (`columns`/`rows`/`total`/`filters`/`charts`, más `stats`
en dos de ellas), para un solo renderizador en el frontend:

`revenue` · `payments` · `orders` · `terminals` · `commission` · `topups` · `ticket_avg` ·
`dispatch_times` · `auth_failures` · `active_users` · `events` · y una por alerta:
`limbo_payments` · `outbox_stuck` · `allocation_mismatch` ·
`paid_orders_without_allocation` · `topups_stuck` · `stale_dispatches`.

Lo que aporta el cajón por encima del panel:

- **Facetas calculadas en la DB** (`_facets`, `detail.py:44`), con las opciones tomadas
  del queryset *sin* filtrar, y omitidas cuando tienen menos de dos valores.
- **Series partidas por estado** (`_daily`, `detail.py:118`), una línea por valor, sin
  relleno, con `dim` para que la línea y las barras de la misma dimensión compartan color.
- **Franja horaria** (`_by_hour`) en revenue, orders y events.
- **Distribución y percentiles** (`_stats`) en `ticket_avg` y `dispatch_times`.
- **Antigüedad** (`_age_buckets`) en las seis alertas — para dinero colgado importa más
  «cuánto lleva así» que «cuándo entró».
- Corte en `ROW_LIMIT = 100` filas, diciendo siempre cuántas hay de verdad.

## 1.4 Reglas transversales que el código sí respeta

Verificadas leyendo el código y con la suite:

| Regla | Dónde | Estado |
|---|---|---|
| Filtro de fecha contra la columna cruda, nunca `__date` | `Filters.dates`, `selectors.py:117` | ✔ en todos los paneles |
| Zona horaria del negocio, nunca `date.today()` | `timezone.localdate` en todo | ✔ |
| Series sin huecos, un solo punto de verdad | `period_series` | ✔ (`detail._by_day` delega) |
| Color por entidad desde el dominio, no por posición | `status_domain` + `stableColors` | ✔ |
| 8 slots de paleta, validados para daltonismo | `palette.js` | ✔ (`npm run check`) |
| Fuente única por alerta (tarjeta = detalle) | `alert_querysets` | ✔ con test |
| Sin N+1 | `values()` con alias `F()` / `related=` en las alertas | ✔ |
| Sin caché de cifras; memo solo de metadatos | `_cached`, `META_TTL = 300` | ✔ |
| `@superuser_required` en cada vista | `views.py` | ✔ con test |

## 1.5 Cobertura de la suite

30 tests que verifican, sobre datos creados por el propio test: control de acceso,
robustez ante query params basura, recorte por fechas, **que un ámbito inexistente deje
todo en cero**, que cada métrica del registro responda, que las facetas filtren en la DB,
que la tarjeta y el detalle de cada alerta coincidan, orden de dominio estable, zona
horaria, las dos guardas de tendencia, el fold de alias de actor, el split de series, que
usuarios activos cuente personas, el inicio real del histórico y el crecimiento del
bucket.

**Límite de esa suite:** corre contra una base de test vacía y cada test siembra solo lo
que necesita. Las aserciones «todo en cero con ámbito inexistente» se cumplen de forma
vacía en los paneles cuyos datos ese test no siembra — que es exactamente por dónde se
colaron dos de los hallazgos de la Parte II.

## 1.6 Lo que el tablero declara que NO responde

Y sigue siendo cierto tras esta revisión:

- Saldos de billetera, float total, escrow, cuadre contra el ledger. Viven en `wallet`.
- Wifi vs datos móviles: **confirmado, no es derivable**. `WifiInfirmation` se borró en
  `devices/migrations/0004` y `AuditLog.payload.headers` solo guarda las cuatro cabeceras
  del contrato (`X-Client-ID`, `X-Device-ID`, `X-App-Version`, `X-Platform`).
- Nombres de usuario: solo UUIDs (existe `auth_user_lookup_client` para hidratarlos).

---

# Parte II — Hallazgos: lo que el tablero dice mal

Ordenados por gravedad. Los tres primeros están **verificados ejecutando código**.

---

### 🔴 H-1 — «Ingresos» incluye las recargas: la cifra principal está inflada

**Qué pasa.** `_kpis` toma como ingresos *todas* las `PaymentTransaction` PAID del rango
(`selectors.py:238`), sin distinguir `payment_type`. Pero una recarga genera su propia PT
con `payment_type = TOPUP`: es dinero que entra a una billetera, **no una venta**. La
venta ocurre después, cuando esa billetera paga.

**Verificado en dev:**

```
PAID por payment_type:  PURCHASE  9 tx   $   5.124,15
                        TOPUP     7 tx   $ 350.000,00
KPI «Ingresos» muestra:               $ 355.124,15
KPI «Recargas» muestra:               $ 350.000,00   ← el mismo dinero, dos veces
Ventas reales:                        $   5.124,15
```

El 98,6 % de la cifra de «Ingresos» no son ventas, y aparece **otra vez** en la tarjeta de
al lado. El ticket promedio queda en $22.195 donde el real es $569.

**Qué más contamina.** Todo lo que parte de ese mismo queryset: la serie temporal de
ingresos, `sales_by_store`, `_trend` (y por tanto la alarma de caída), `store_drops`,
`method_drops`, `ticket_avg` y el detalle `revenue`.

**El propio business ya traza esta línea.** `terminal_reporting_service.py:155` filtra
`payment_type=PaymentType.PURCHASE` con este comentario textual: *«Solo ventas (PURCHASE)
y PAID: excluye las PT de recarga (TOPUP) que comparten payment_method (p.ej. CASH) y
contaminarían "efectivo"»*. El tablero global es el único sitio donde no se aplica.

**Arreglo.** Una línea en la base de ingresos:

```python
paid = payments.filter(status=PaymentStatus.PAID).exclude(payment_type=PaymentType.TOPUP)
```

Usar `exclude(TOPUP)` y no `filter(PURCHASE)`: `payment_type` es `blank=True, default=''`,
así que filtrar por PURCHASE tiraría cualquier fila histórica sin clasificar. Hay que
aplicarlo en `_kpis`, `_revenue_series`, `_sales_by_store`, `_trend` y `detail._revenue` /
`detail._ticket` — o mejor, en un único helper `ventas(f)` que los seis consuman, para que
no vuelva a divergir. Test: sembrar una PT `TOPUP` PAID y exigir que no aparezca en
`kpis.revenue`.

---

### 🟠 H-2 — «Stock bajo» ignora el filtro de ciudad

`_low_stock` (`selectors.py:927`) aplica `f.store_id` a mano y **nunca mira `city_id`**.
No usa `f.scope()` porque las rutas por defecto no le sirven (`Stock` llega a `Store` por
`store_has_product__store`).

**Verificado:** con una ciudad inexistente, todos los demás paneles dan cero y «Stock
bajo» devuelve 1 fila de una tienda de otra ciudad.

```python
# ejecutado sobre la base de dev
f = Filters(desde=date(2000,1,1), hasta=date(2100,1,1), city_id=str(uuid4()))
dashboard_data(f)['kpis']['revenue']   # 0.0   ✔
len(dashboard_data(f)['low_stock'])    # 1     ✘  ← fuga
```

**Arreglo (una línea):**

```python
qs = f.scope(qs, store_path="store_has_product__store_id",
                 city_path="store_has_product__store__city_id")
```

Sustituye al `if f.store_id` manual y cierra las dos dimensiones a la vez.

---

### 🟠 H-3 — La alerta «Outbox sin cerrar» ignora el filtro de ciudad

`outbox_pending()` (`selectors.py:595`) resuelve el ámbito a mano —
`WalletOperationOutbox` no tiene FK a `Store`, se vincula por `(ref_type, ref_id)` — pero
sale por `return qs` en cuanto no hay `store_id`, sin mirar `city_id`.

**Verificado:** con una ciudad inexistente, las otras cinco alertas dan 0 y `outbox_stuck`
devuelve 2. Es decir: filtrar por una ciudad muestra alertas de dinero que no son de esa
ciudad.

**Arreglo.** Mismo patrón que ya usa para tienda, resolviendo por ciudad:

```python
if not (f.store_id or f.city_id):
    return qs
pts   = f.scope(PaymentTransaction.objects.all()).values("id")
tops  = f.scope(TopupRequest.objects.all()).values("id")
return qs.filter(Q(ref_type="payment_transaction", ref_id__in=pts)
                 | Q(ref_type="topup_request", ref_id__in=tops))
```

Reusar `f.scope()` en vez de repetir el `filter(store_id=…)` cierra las dos dimensiones y
deja un solo sitio donde equivocarse.

**Por qué H-2 y H-3 sobrevivieron a la suite:** el test que exige «todo en cero» solo se
ejecuta con `store_id` inexistente, y el de ciudad
(`test_filtrar_por_ciudad_acota_igual_que_tienda`) comprueba cinco claves, ninguna de las
dos afectadas. Además la base de test no tiene filas de `Stock` ni de outbox, así que las
aserciones del primero pasan de forma vacía. **La corrección debería incluir extender el
test de ciudad para que exija los mismos ceros que el de tienda, con datos sembrados.**

---

### 🟡 H-4 — Las órdenes borradas se siguen contando (latente)

`Order` tiene `deleted_at` (borrado lógico) y **ningún panel lo excluye**: ni el KPI de
órdenes, ni el embudo, ni `orders_mix`, ni `top_products`, ni `active_users`. Hoy en dev
hay 0 órdenes borradas, así que no se nota; el día que se borre una, la orden desaparece
de la app y sigue contando en el tablero.

Nota: `InvoiceItem.clean()` ya rechaza asociarse a una orden borrada, o sea que el resto
del sistema sí trata `deleted_at` como significativo.

**Arreglo:** un `.filter(deleted_at__isnull=True)` en la base de órdenes de
`dashboard_data`, o mejor un helper `ordenes(f)` — igual que el de ventas de H-1.
Decisión de negocio a confirmar: si se quiere seguir viendo lo borrado, que sea una faceta
del cajón, no el valor por defecto del KPI.

---

### 🟡 H-5 — La comisión muestra solo lo cobrado, sin decir cuánto falta por cobrar

`_kpis` filtra `TransactionCommission` por `status=PAID`. En dev: 3 comisiones PAID por
$0,52 y **4 en `PENDING_WALLET_CAPTURE` por $102,00**. La tarjeta dice «lo que gana Fud:
$0,52» y no hay ningún sitio en el tablero donde aparezcan esos $102 pendientes.

No es un bug —lo cobrado es lo cobrado— pero es un punto ciego caro: la comisión atascada
es justo la que hay que perseguir. Ver M-12.

---

### 🟡 H-6 — 33 eventos de auditoría entran como `UNKNOWN_EVENT`

En dev, `UNKNOWN_EVENT` es el 5.º tipo más frecuente (33 de 518), y su payload muestra
peticiones reales y clasificables (`POST /api/payments/internal/topup`). Es un fallo de
clasificación en el middleware de auditoría, no del tablero — pero el tablero es donde se
ve, y hoy los pinta como un tipo más sin señalar que son eventos sin clasificar.

Lo barato: no arreglar el middleware desde aquí, sino que el panel de eventos marque
`UNKNOWN_EVENT` como lo que es (un agujero de observabilidad), igual que ya marca los de
fallo.

---

### 🔵 H-7 — Notas menores

- **Tiendas inactivas en el selector.** `dashboard_data` lista tiendas con
  `deleted_at__isnull=True` pero ignora `is_active`. En dev las 5 están activas.
- **`console.log` en producción.** [src/api.js](src/api.js) deja dos trazas de rendimiento
  (`Filtro aplicado en Xms`, `filterRows tomó…`) en el bundle. Inofensivo, pero es ruido
  en la consola de una herramienta que decide plata.
- **`_chart` acepta `x`/`y`** y el frontend no los usa nunca: parámetros muertos.

---

# Parte III — Qué puede añadirse (revisión de backends)

Criterio de la lista: **sale del ORM de business, aporta una decisión que hoy no se puede
tomar, y el dato ya está poblado.** Cada entrada dice de dónde sale y qué cuesta.

Contexto que enmarca todo lo que sigue — poblado real de la base de dev:

```
audit_logs 518 · orders 35 · order_items 50 · dispatches 24 · orders_has_dispatches 22
invoices 17 · invoice_items 19 · payment_transactions 18 · payment_allocations 19
stock_events 16 · topup_requests 12 · wallet_operation_outbox 11 · transaction_commissions 7
success_events 5 · terminals 5 · stores 5 · store_has_products 4 · stock 4

VACÍAS: gateway_events · refund_request · order_shares · wallet_point_payments ·
        rejection_events · store_bank_accounts · terminals_has_roles ·
        ads_* (4) · reward_* (3) · app_zones
```

Las tablas `reward_codes`, `reward_claims`, `reward_point_pools` y `app_zones` **no
aparecen en CLAUDE.md** y están vacías: son nuevas y no hay nada que construir sobre ellas
todavía.

---

## Tier 1 — Alto valor, dato ya poblado, sin salir de business

### M-1 · Margen bruto por producto y por tienda ⭐ el hueco más grande

**Qué responde:** cuánto se *gana*, no cuánto se factura. Hoy el tablero entero mide
ingreso y **en ningún sitio aparece el costo**.

**De dónde sale:** `StoreHasProduct.purchase_price` (precio de compra) frente a
`OrderItems.subtotal`. En dev, las 4 filas de `store_has_products` tienen `purchase_price`
y `price` poblados. Existe además `alternative_cost`.

```python
# margen = Σ(subtotal) − Σ(quantity × purchase_price)
OrderItems.objects.filter(order__in=ordenes_pagadas).values(
    tienda=F("order__store__name")
).annotate(
    venta=Sum("subtotal"),
    costo=Sum(F("quantity") * F("product__shp_entry__purchase_price"),
              output_field=DecimalField()),
)
```

**Coste:** un selector + un panel de barras + una métrica de detalle. Sin migraciones.
**Riesgo:** `purchase_price` es el precio **actual**, no el del día de la venta — el margen
histórico se recalcula si cambia el costo. Decirlo en el `sub` del panel; guardar el costo
en `OrderItems` sería una migración y una decisión de negocio.

---

### M-2 · Composición del ingreso: ventas vs recargas

**Qué responde:** cuánto del dinero que entra es venta y cuánto es carga de billetera —
la pregunta que H-1 hace obligatoria. Barra apilada al 100 % por `payment_type`
(`PURCHASE`/`TOPUP`, y lo que aparezca: el enum tiene 8 valores).

**De dónde sale:** `PaymentTransaction.payment_type`, ya poblado (11 PURCHASE, 7 TOPUP).
**Coste:** trivial una vez hecho H-1; es el mismo queryset agrupado.

---

### M-3 · Latencia de cobro

**Qué responde:** cuánto tarda un cobro en cerrarse, y cuáles se quedan largos. Es la
señal temprana del limbo de wallet: una PT que tarda 300 s es la que mañana estará en
`PROCESSING_WALLET_CAPTURE`.

**De dónde sale:** `PaymentTransaction.started_at` / `processed_at` / `ended_at`, poblados
en **16 de 18** filas de dev. Distribución medida:

```
335,6 s ← una cola larga real
  0,30 / 0,29 / 0,25 / 0,22 / 0,20 / 0,18 / 0,18 s
```

Ese único caso de 335 s frente a un p50 de 0,25 s es exactamente el tipo de bimodalidad
que un promedio esconde.

**Coste:** mismo patrón que `dispatch_times` — `ExpressionWrapper(..., DurationField())`
(nunca `Extract(epoch)`, revienta en SQLite), `_stats` para percentiles, `type: "dur"` en
las columnas. La receta ya existe y está probada.

---

### M-4 · Salud de la API: latencia y códigos HTTP ⭐ observabilidad regalada

**Qué responde:** qué endpoints están lentos y cuáles devuelven 5xx. Hoy el tablero mide
fallos de *acceso* (401/403) pero **no sabe nada de errores de servidor**.

**De dónde sale:** `AuditLog.payload`, que ya trae en **365 de 518 filas** (todas las que
pasan por el middleware):

```
timestamp · event_type · endpoint · client_ip · user_agent ·
duration_ms · is_secure · response_status · response_size · headers
```

El tablero solo lee tres de esas claves (`endpoint`, `client_ip`, `user_agent`).
`duration_ms` y `response_status` están ahí, sin usar, en el 70 % de las filas.

**Coste:** medio. La agregación es directa (`values("payload__endpoint")` +
`Avg/Max(payload__duration_ms)` + `Count(filter=Q(payload__response_status__gte=500))`),
pero **choca con la deuda ya conocida**: extraer del JSON va sin índice y ya hoy son las
dos consultas más lentas del tablero (99 ms y 80 ms con 500 filas). Con volumen real hace
falta índice de expresión sobre `(payload->>'endpoint')` o columnas materializadas.
**Recomendación:** hacerlo, pero acotado por rango de fechas siempre y con el índice de
expresión en la misma PR, no después.

Cuidado explícito: seguir la regla que ya está escrita — del payload salen `endpoint`,
`client_ip`, `user_agent`, y ahora `duration_ms`/`response_status`. `headers` **no**.

---

### M-5 · Facturación

**Qué responde:** impuestos, descuentos, facturas que no cerraron. Hoy el tablero **no
toca `Invoice` en absoluto**, y hay 17 facturas por $355.124,15 con `paid_at` poblado en
las 17.

**De dónde sale:** `Invoice` (`status`, `subtotal_amount`, `discount_amount`,
`tax_amount`, `total_amount`, `issued_at`, `paid_at`, `cancelled_at`, `due_date`) e
`InvoiceItem` (`line_type`, `source_type`).

Tres cosas concretas:
1. Embudo de estado de factura (el enum tiene 7: `PENDING`…`REFUNDED`, `EXPIRED`).
2. Impuesto y descuento acumulados — hoy invisibles (en dev: $0 de impuesto, $0,35 de
   descuento; en producción no serán cero).
3. **Alerta nueva:** facturas `PENDING`/`PROCESSING` con `due_date` vencida, y facturas
   `PAID` sin `paid_at`. Encaja en `alert_querysets()` sin tocar nada más.

**Coste:** bajo. Es el patrón de panel de estado + una alerta.

---

### M-6 · Movimientos de stock

**Qué responde:** merma y ajustes, no solo el nivel actual. Hoy «Stock bajo» dice *dónde
está bajo*; nada dice *por qué bajó*.

**De dónde sale:** `StockEvent`, poblado por dos servicios vivos
(`catalog/services/stock_service.py:113`, `orders/services/stock_service.py:150,191`).
En dev: `SALE` 13 · `ADJUST` 2 · `INCREASE` 1.

Un ajuste manual (`ADJUST`/`DECREASE`) que no corresponde a una venta es merma, robo o un
error de conteo — y es la única forma de verlo. Lleva `terminal_id`, así que se puede
atribuir.

**Coste:** bajo. Ojo: `store_id`/`product_id` son `CharField`, no FK — el ámbito hay que
resolverlo con el UUID en texto, no con `f.scope()` por defecto.

---

### M-7 · Tiempo hasta la entrega

**Qué responde:** cuánto pasa entre que se abre el despacho y se entrega la orden. El
panel actual mide `closed_at − opened_at` (el cobro); esto mide la entrega, que es otra
cosa.

**De dónde sale:** `OrdersHasDispatches.delivered_at`, poblado en **19 de 22** filas de
dev. Medido contra `Dispatches.opened_at`: 10,6 s a 143 s.

**Coste:** bajo, mismo molde que `dispatch_times`. Bonus: las 3 filas sin `delivered_at`
son en sí mismas una señal (¿se entregó y no se marcó, o no se entregó?).

---

### M-8 · Eficiencia de terminal: tasa de aprobación

**Qué responde:** de cada 10 intentos de cobro en esa terminal, cuántos se aprueban. Hoy
el tablero ve los pagos que existieron, no los que se intentaron y fallaron en el flujo.

**De dónde sale:** `SuccessEvent` y `RejectionEvent` (`audit`), escritos en vivo por
`orders/services/payment_service.py:410,443` con `duration_ms`, `amount`, `reason` y
`flow_id`. En dev: 5 success (24,8 s – 468 s), 0 rejections.

**Ya está calculado.** `terminal_reporting_service.get_terminal_metrics()` computa
`approval_rate`, `total_rejections`, `average_service_time_ms` y `average_rejection_time_ms`,
con test propio (`stores/tests/test_terminal_metrics.py`). El tablero global no lo usa
porque ese servicio es por-terminal y sin ámbito de ciudad; pero la lógica y su definición
ya están acordadas — replicarla agregada es leer un archivo, no diseñar una métrica.

**Coste:** bajo-medio. **Valor alto:** `RejectionEvent.reason` responde *por qué* se
rechaza, que ningún panel de hoy contesta.

---

### M-9 · Turno y tipo de orden: dos dimensiones de negocio ya pobladas

`Order.shift` (`MORNING`/`AFTERNOON`/`NIGHT`) y `Order.order_type`
(`PRE_ORDER`/`TAKEAWAY`/`DINE_IN`/`NONE`) están poblados en las 35 órdenes de dev
(19/14/2 y 17/18) y **no aparecen en ningún panel ni faceta**.

El turno no es lo mismo que la franja horaria del cajón: la franja sale del reloj
(`created_at`), el turno lo declara quien crea la orden. Para un negocio con turnos, el
segundo es el que se usa para programar personal.

**Coste:** mínimo. Dos facetas nuevas en `detail._orders` (`("turno","Turno","shift")`,
`("tipo","Tipo","order_type")`) y, si aporta, una barra apilada en Operación. Es la receta
de §5 del CLAUDE.md tal cual.

---

### M-10 · Alerta: checkouts de marketplace vencidos

**Qué responde:** cuánta gente abandona el carrito en la app. Hoy se ven los despachos
abandonados (POS) pero no los checkouts abandonados (marketplace).

**De dónde sale:** la regla ya está escrita en el modelo — `Order.is_pending_expired`
(`orders/models.py:86`), con `PENDING_TTL_MINUTES = 5`, medida contra `updated_at`:

```python
Order.objects.filter(
    origin=OrderOrigin.MARKETPLACE, status=OrderStatus.CREATED,
    payment_status=PaymentStatus.PENDING,
    updated_at__lt=timezone.now() - timedelta(minutes=Order.PENDING_TTL_MINUTES),
).exclude(payment_owner_type=PaymentOwnerType.GROUP_WALLET)
```

**Coste:** una entrada en `alert_querysets()` + una en `ALERTS` + un `_alert_builder`. El
test recorre el registro solo. Igual que `stale_dispatches`, usa el TTL que define el
dominio y no uno inventado.

---

### M-11 · Vacas (billeteras grupales) y su vencimiento

**Qué responde:** cuántas vacas están abiertas, cuánto dinero mueven y cuántas se vencen
sin completarse. `GROUP_WALLET` es un flujo de producto completo (escrow en wallet,
`vaca_expires_at`, invitados) y en el tablero es una etiqueta más dentro de «Tipo de
pagador».

**De dónde sale:** `Order.vaca_expires_at` (1 fila en dev) + `payment_owner_type =
GROUP_WALLET` + `Order.is_vaca_expired`.

**Coste:** bajo. **Pero:** el estado real de la vaca (cuánto se ha aportado, quién falta)
vive en `wallet.GroupWallet` / `GroupWalletContribution` — desde business solo se ve la
orden, no el progreso del escrow. Vale la pena hacer la mitad barata y decir en el panel
que el progreso está en wallet.

---

### M-12 · Comisión devengada vs cobrada

Resuelve el punto ciego de H-5: el mismo panel de comisión, partido por `status` en vez de
filtrado a `PAID`. En dev revelaría $102 pendientes junto a $0,52 cobrados.

**Coste:** mínimo — quitar el filtro y añadir el desglose por estado. Es el mismo cambio
que ya se hizo en el panel de recargas por exactamente esta razón (*«antes solo las
acreditadas: la curva bajaba igual si caían las recargas que si empezaban a expirar»*).

---

### M-13 · Reparto tienda / plataforma

`PaymentTransaction.split_store_amount` y `split_platform_amount` están poblados en **11
de 18** filas de dev, más `net_amount` en 11. Es el reparto real del dinero de cada cobro,
independiente de `TransactionCommission`.

Tenerlos los dos permite **cuadrarlos entre sí**: `Σ split_platform_amount` frente a
`Σ commission_amount` del mismo período debería coincidir; si no, es una alerta de
integridad del mismo tipo que `allocation_mismatch`.

**Coste:** bajo. **Valor:** una alerta de descuadre nueva sobre datos que ya están.

---

## Tier 2 — Interesante, pero el dato hoy es pobre o vacío

| Idea | De dónde | Por qué esperar |
|---|---|---|
| Embudo de la pasarela de pago | `GatewayEvent` | **0 filas**. Además `TopupRequest.gateway_callback_at` está en `NULL` en las 12 recargas de dev: la latencia del proveedor no es medible todavía |
| Devoluciones | `RefundRequest` | **0 filas**, flujo sin construir (el propio modelo lo dice en un TODO) |
| Compartir órdenes | `OrderShares` | **0 filas** |
| Pagos con puntos | `WalletPointPayments`, `StoreLoyaltyConfig` | **0 filas**; la config existe (1 fila) pero no hay uso |
| Publicidad | `ads_*` (9 tablas) | **0 filas** |
| Recompensas | `reward_codes`, `reward_claims`, `reward_point_pools` | **0 filas**; ni siquiera están en CLAUDE.md |
| Suscripciones (MRR) | `CustomerSubscription`, `SubscriptionPlan`, `SubscriptionStatuses` | 2 filas, y **solo se tocan desde el admin** — no hay servicio de facturación. Con dos socios y dos clientes no hay MRR que graficar |
| Salud de emparejamiento | `TerminalPairings` (`used`, `revoked_at`, `expires_at`) | 1 fila. Cuando haya parque real, «terminales con emparejamiento por vencer» es una alerta operativa legítima |
| Embudo de QR | `QrAction` (`GENERATED→SCANNED→USED/EXPIRED/FAILED`) | 1 fila |
| Ventas fuera de horario | `Schedule` (35 filas) × hora de la orden | Viable ya, pero el valor es dudoso hasta que haya volumen: hoy diría más sobre datos sembrados que sobre el negocio |
| Documentos legales por vencer | `LegalInfo.expires_at` (1 fila) | Alerta de cumplimiento barata, pero con una fila no se justifica un panel |
| Cuentas bancarias sin configurar | `BanckAccount` | **0 filas**. Una tienda que factura y no tiene cuenta de liquidación es un problema real — cuando existan filas |

**Regla que se mantiene:** no construir paneles sobre tablas vacías. Un panel que siempre
dice cero enseña a ignorar los paneles.

---

## Tier 3 — Segmentaciones que existen y no se usan

Baratas, sin modelos nuevos, solo dimensiones que ya están en `Store`:

- **Categoría de tienda** (`Store.category` → `CategoriesStore`, 7 categorías en dev).
- **Colegio y estrato** (`Store.school` → `School.stratum`, `school_type`,
  `student_capacity`). Fud vende en colegios; el estrato y la capacidad son el
  denominador natural de «penetración» y hoy no se usan para nada.
- **Departamento** (`City.department`) — el filtro llega a ciudad y se para ahí.

**Coste:** un `values()` distinto en paneles que ya existen. Con 5 tiendas y 1 colegio no
cambia nada hoy; con 50 tiendas es la primera pregunta que se va a hacer.

**Aviso de dev:** hay 8 ciudades «Bogotá» sembradas con códigos inventados y sin tiendas.
`_cities()` ya las filtra correctamente (subquery sobre `Store`, no `stores__deleted_at__isnull`).

---

# Parte IV — Integraciones caras: wallet y auth

## 4.1 Corrección a lo documentado

CLAUDE.md §2 dice: *«Los endpoints de datos de wallet son todos
`/v1/wallet/user/<auth_user_id>/…`, con guardas BOLA. **No existe endpoint agregado**»*.

**Eso ya no es exacto.** Revisando `wallet/apps/*/urls.py` y el cliente que business tiene
escrito, hay **tres endpoints con ámbito de tienda, no de usuario**, y los tres están ya
implementados en `business_fud/src/gateway/clients/wallet_client.py`:

| Endpoint de wallet | Método del cliente | Qué devuelve |
|---|---|---|
| `GET /v1/stores/<store_id>/escrow` | `escrow_status(store_id, correlation_id)` (línea 762) | estado del escrow de esa tienda |
| `GET /v1/stores/<store_id>/consumers/count` | `consumer_count(store_id, correlation_id)` (línea 767) | nº de consumidores de la tienda |
| `GET /v1/stores/active` | — (no envuelto) | tiendas activas en la red de wallet |

El comentario del propio cliente confirma que el `ApiClient` de business ya opera con un
scope genérico de plataforma para el bloque `stores/*` (*«Pendiente acotarlo a un scope
dedicado (ej. `platform:stores`)»*). Es decir, **el permiso y el transporte ya existen**.

## 4.2 Qué bloquea de verdad, entonces

No es «no hay endpoint». Son tres cosas, y siguen siendo caras:

1. **El `obo` / `sub`.** `WalletHttpClient.__init__` lanza `ValueError` si no recibe un
   `sub` explícito: *«Toda llamada a wallet debe tener contexto de usuario para
   auditoría»*. El JWT técnico se pide a auth con `sub` + `original_context` (role, sid,
   jti). Un tablero global no tiene un humano de `auth_fud` detrás — el socio se autentica
   con la sesión del admin de Django, que es otro sistema de identidad.
2. **Anti-replay por `jti`.** El comentario del cliente documenta el incidente
   **2026-08-22**: reutilizar el cliente para dos llamadas consumía el `jti` y la segunda
   caía en 401 disfrazado de «servicio no disponible». Cada llamada necesita **su propio
   token**, emitido por auth.
3. **N llamadas por refresco.** El escrow es por tienda. Con 5 tiendas son 5 tokens + 5
   HTTP por cada carga del tablero. Con 50, son 100 peticiones de red sincrónicas para
   pintar una tarjeta.

## 4.3 Si aun así se quiere, la vía más barata

**Panel de escrow por tienda**, no cuadre del ledger:

- Un **service account propio del tablero** en auth (`service-accounts/provision` ya
  existe), para tener un `sub` legítimo en vez de suplantar a un socio.
- Llamada **solo bajo demanda**: no en `/api/metrics/` sino en un endpoint aparte
  (`/api/dashboard/api/escrow/`) que el frontend pida al abrir *ese* panel. Así una caída
  de wallet no tumba el tablero entero.
- **Caché corta en Redis** (60 s) para esta cifra concreta — y solo para esta. Es la única
  excepción defendible a la regla de «ninguna cifra se cachea», porque el coste no es una
  consulta al ORM sino N round-trips a otro servicio; conviene dejarlo escrito al lado del
  código.
- Degradación explícita: si wallet no responde, el panel dice «escrow no disponible», no
  un cero.

**Estimación honesta:** es la tarea más grande de todo este documento, y sigue **sin
resolver** el cuadre real contra el ledger (que necesitaría un endpoint agregado nuevo del
lado de wallet). Antes de empezarla, hacer todo el Tier 1: cubre más preguntas por menos
trabajo.

## 4.4 auth_fud

Sin cambios: cuatro endpoints internos (`technical-jwt/issue`,
`service-accounts/provision|delete`, `users/by-ids`), ninguna cifra. Lo único que aportaría
es **hidratar nombres** donde hoy se ven UUIDs — «Usuarios activos», «Vigilancia de
acceso», despachos. `auth_user_lookup_client` ya hace batch + caché Redis 5 min y es
tolerante a fallos, así que es una mejora de UX barata y de bajo riesgo:

> En el cajón de `active_users` y `auth_failures`, pasar los ≤100 UUIDs de la página por
> `lookup()` y mostrar `nombre (uuid corto)`. Si el lookup falla, se queda el UUID.

Eso **no** rompe la regla de «React habla con un solo backend»: la llamada la hace
business del lado del servidor, como ya la hace para el POS.

---

# Parte V — Riesgos operativos y de escalado

Ninguno urgente hoy; todos crecen con el volumen.

| Riesgo | Dónde | Cuándo duele | Arreglo |
|---|---|---|---|
| Las alertas agregan sobre la tabla completa sin fecha | `alert_querysets` | `allocation_mismatch` es un GROUP BY de todos los pagos × allocations. Crece para siempre | Acotar a 90 días — **decisión de negocio**, no técnica |
| Percentiles en Python | `_stats` en `ticket_avg` y `dispatch_times`; `_age_buckets` | trae todo el rango a memoria | `PERCENTILE_CONT` en Postgres (marcado `ponytail:`) |
| Extracción de JSON sin índice | `audit_logs` en `_auth_watch` y `_system_events` | ya hoy son las 2 consultas más lentas (99 ms / 80 ms con 500 filas). **M-4 lo agrava** | Índice de expresión o columnas materializadas — hacerlo *con* M-4, no después |
| Una consulta por serie en `_daily` | `detail.py:118` | máx. 8 por gráfico | `TruncX + values()` agrupando por (bucket, campo) — pero pierde el punto único de relleno de huecos; medir antes |
| Índices creados sin `CONCURRENTLY` | migraciones | bloqueo de tabla con millones de filas | `AddIndexConcurrently` |
| Bundle sin hash en el repo de business | `vite.config.js` | ≈570 kB en cada build; Recharts es ~70 % del peso para **un** gráfico | Sacar Recharts y hacer el área en ~40 líneas de SVG (≈180 kB), a costa del tooltip |
| Sin exportación a CSV | — | el detalle corta en 100 filas | Un `?format=csv` en `detail_view` son ~10 líneas con `csv.DictWriter` sobre las mismas `columns`/`rows` — el contrato ya es uniforme, que es justo lo que lo hace barato |
| `dashboard_fud` sin `git init` | — | ya | Decisión pendiente del usuario |

---

# Apéndice A — Mapa tabla → panel

Qué alimenta el tablero hoy y qué no.

### Con datos y en uso

| Tabla | Filas (dev) | Paneles |
|---|---|---|
| `payment_transactions` | 18 | KPIs, ingresos, pagos por estado, ventas por tienda, tendencia, limbo, mismatch |
| `orders` | 35 | KPIs, embudo, mix, usuarios activos, órdenes huérfanas |
| `order_items` | 50 | productos más vendidos |
| `dispatches` | 24 | desenlace, tiempos, despachos abiertos |
| `topup_requests` | 12 | KPI recargas, recargas por estado, atascadas |
| `transaction_commissions` | 7 | KPI comisión (solo PAID) |
| `wallet_operation_outbox` | 11 | alerta outbox |
| `payment_allocations` | 19 | mismatch, órdenes sin allocation |
| `audit_logs` | 518 | eventos del sistema, vigilancia de acceso |
| `terminals` | 5 | KPI terminales, tiempos por terminal |
| `stock` / `store_has_products` | 4 / 4 | stock bajo (solo `quantity` y `low_limit_quantity`) |
| `stores` / `cities` | 5 / 9 | selectores de ámbito |

### Con datos y **sin usar** — el material de la Parte III

| Tabla | Filas | Qué se pierde |
|---|---|---|
| `invoices` / `invoice_items` | 17 / 19 | **toda la facturación**: impuestos, descuentos, estado (M-5) |
| `stock_events` | 16 | merma y ajustes (M-6) |
| `orders_has_dispatches` | 22 | `delivered_at` → tiempo de entrega (M-7) |
| `success_events` | 5 | tasa de aprobación y tiempo de servicio (M-8) |
| `store_schedules` | 35 | ventas dentro/fuera de horario |
| `store_has_products.purchase_price` | 4 | **el margen** (M-1) |
| `store_offers` / `products_has_offers` | 2 / 1 | efecto de las ofertas en la venta |
| `customer_subscriptions` | 2 | ingreso recurrente (sin flujo real) |
| `terminal_pairings` / `qr_actions` | 1 / 1 | salud de emparejamiento, embudo QR |
| `schools` / `store_categories` | 1 / 7 | segmentación por colegio, estrato y categoría |
| `legal_infos` | 1 | documentos por vencer |

### Campos poblados y sin usar dentro de tablas que sí se usan

| Campo | Poblado (dev) | Qué daría |
|---|---|---|
| `PaymentTransaction.payment_type` | 18/18 | separar venta de recarga (**H-1**, M-2) |
| `PaymentTransaction.processed_at` / `ended_at` | 16/18 | latencia de cobro (M-3) |
| `PaymentTransaction.split_store_amount` / `split_platform_amount` / `net_amount` | 11/18 | reparto real y cuadre contra comisión (M-13) |
| `AuditLog.payload.duration_ms` / `response_status` | 365/518 | salud de la API, 5xx (M-4) |
| `Order.shift` | 35/35 | turno (M-9) |
| `Order.order_type` | 35/35 | pre-orden vs takeaway (M-9) |
| `Order.deleted_at` | 0/35 | **hoy se cuentan las borradas** (H-4) |
| `Order.vaca_expires_at` | 1/35 | vacas vencidas (M-11) |
| `Dispatches.wallet_balance` | — | saldo *snapshot* al abrir el despacho. Es lo único parecido a un saldo que business guarda; útil como referencia, **nunca** como sustituto del ledger |
| `Order.is_cross_store` / `shipping_cost` | 0 / 0 | sin uso todavía |

### Vacías — no construir encima

`gateway_events` · `refund_request` · `order_shares` · `wallet_point_payments` ·
`rejection_events` · `store_bank_accounts` · `terminals_has_roles` · `ads_*` (4) ·
`reward_codes` · `reward_claims` · `reward_point_pools` · `app_zones`

---

# Apéndice B — Orden de trabajo sugerido

Por relación valor/coste, no por tema.

**Ahora — corrección, no funcionalidad (≈ medio día)**

1. **H-1** separar recargas de ingresos, con un helper `ventas(f)` único + test.
2. **H-2** y **H-3** cerrar las dos fugas de ámbito por ciudad, y extender
   `test_filtrar_por_ciudad_acota_igual_que_tienda` para que exija los mismos ceros que el
   de tienda, con datos sembrados.
3. **H-4** excluir órdenes borradas (o decidir explícitamente que no).

Sin esto, cada panel nuevo se construye sobre una cifra que se sabe mal.

**Después — lo que más responde por menos código (≈ 2-3 días)**

4. **M-1** margen bruto — es la pregunta que el tablero hoy no puede contestar.
5. **M-2** composición del ingreso (cae solo tras H-1).
6. **M-9** turno y tipo de orden — dos facetas, valor inmediato.
7. **M-12** comisión devengada vs cobrada — quitar un filtro.
8. **M-10** alerta de checkouts vencidos — la regla ya está en el modelo.

**Luego — más trabajo, valor claro**

9. **M-5** facturación (panel + alerta de vencidas).
10. **M-3** latencia de cobro.
11. **M-7** tiempo hasta la entrega.
12. **M-6** movimientos de stock.
13. **M-8** eficiencia de terminal (reusar la definición del servicio existente).
14. **M-4** salud de la API — **con** su índice de expresión en la misma PR.
15. **M-13** reparto tienda/plataforma + alerta de descuadre.

**Solo si se pide explícitamente**

16. Escrow por tienda desde wallet (Parte IV) — la tarea más cara, y sigue sin dar el
    cuadre contra el ledger.

---

## Cambios que este documento propone a `CLAUDE.md`

Para que el contexto permanente no quede desalineado con lo revisado:

- **§2** — corregir *«No existe endpoint agregado»*: existen `stores/<id>/escrow`,
  `stores/<id>/consumers/count` y `stores/active`, ya envueltos en el cliente de business.
  El bloqueo real es el `obo`, el anti-replay por `jti` y el N×HTTP (§4.2 de aquí).
- **§5** — la tabla «Dónde está cada cosa» no menciona `SuccessEvent`/`RejectionEvent`
  (con `duration_ms`), `StockEvent`, `OrdersHasDispatches.delivered_at`,
  `StoreHasProduct.purchase_price` ni `Store.school`. Son las fuentes de M-1, M-6, M-7 y M-8.
- **§5** — la lista de tablas vacías no incluye `reward_codes`, `reward_claims`,
  `reward_point_pools` ni `app_zones`.
- **§6** — añadir como invariante: *«una recarga no es un ingreso»*, con el mismo nivel de
  énfasis que tienen las demás. Es el error que más caro sale de todos los listados.
