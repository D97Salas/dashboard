import { useState } from 'react'
import { computeStatus, goToArea, headline } from './status'
import {
  Area, AreaChart, CartesianGrid, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { dur, filterRows, money, moneyShort, num, pct, useMetrics } from './api'
import { BarTable, Card, Panel, Section, SegmentedBars, Skeleton, StackedBar, TopBar, useTheme } from './components'
import Detail from './Detail'
import Docs from './Docs'
import Treasury from './Treasury'
import { CAT_DARK, CAT_LIGHT, SLOTS, stableColors, statusColor } from './palette'

// Índice del salto de la topbar. El orden es el de la página: primero lo que
// obliga a actuar (alertas), después lo que se consulta.
const SECTIONS = [
  ['estado', 'Estado'], ['resumen', 'Resumen'], ['alertas', 'Alertas'], ['ventas', 'Ventas'],
  ['operacion', 'Operación'], ['sistema', 'Sistema'],
]

const AXIS = { fontSize: 11, tickLine: false, axisLine: false, stroke: 'var(--muted)' }
const TOOLTIP = {
  contentStyle: {
    background: 'var(--surface)', border: '1px solid var(--line)',
    borderRadius: 8, fontSize: 13, boxShadow: '0 4px 16px rgba(0,0,0,.10)',
  },
  labelStyle: { color: 'var(--muted)', marginBottom: 4 },
  cursor: { fill: 'var(--hover)' },
}
/** Lo que cayó, con atajo al detalle ya filtrado por esa fila: el punto del
 *  cuadro es entrar a analizarlo, no quedarse mirando el porcentaje. */
function Drops({ rows, keyCol, head, onPick }) {
  if (!rows.length) return null
  return (
    <table className="plain pickable">
      <thead><tr><th>{head}</th><th className="n">Antes</th><th className="n">Ahora</th><th className="n">Δ</th></tr></thead>
      <tbody>
        {rows.map((d) => (
          <tr key={d[keyCol]} onClick={() => onPick(d[keyCol])} tabIndex={0} role="button"
            title={`Ver ingresos de ${d[keyCol]}`}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onPick(d[keyCol]))}>
            <td>{d[keyCol]}</td>
            <td className="n">{money(d.prev)}</td>
            <td className="n">{money(d.now)}</td>
            <td className="n danger-text">{d.delta}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Trend({ t, onOpen }) {
  const drops = t.store_drops
  const methods = t.method_drops
  if (t.no_history) {
    return (
      <p className="empty">
        No hay período anterior con qué comparar: el rango elegido cubre todo tu
        histórico, que empieza el {t.data_start}. Elige una ventana más corta
        (30d o 90d) para ver la variación.
      </p>
    )
  }
  if (!t.reliable) {
    return (
      <p className="empty">
        Base insuficiente para comparar: {t.prev_payments} transacciones entre {t.prev_desde} y {t.prev_hasta}.
        Con tan pocos datos una variación no significa nada.
      </p>
    )
  }
  return (
    <>
      <p className={`headline ${t.alarm ? 'bad' : ''}`}>
        {t.alarm ? '⚠ Caída de ventas' : 'Comportamiento normal'} — ingresos{' '}
        <b>{t.revenue.delta > 0 ? '+' : ''}{t.revenue.delta}%</b> vs los {t.span_days} días
        anteriores ({t.prev_desde} → {t.prev_hasta}).
      </p>
      {/* Un método de pago que se cae es una avería (datáfono, proveedor,
          integración), no menos demanda: se avisa aunque el total esté plano. */}
      {methods.length > 0 && (
        <div className="warn">
          <p className="headline bad">
            ⚠ {methods.length === 1
              ? <>El método <b>{methods[0].method}</b> cayó <b>{methods[0].delta}%</b></>
              : <><b>{methods.length}</b> métodos de pago cayeron</>}
            {!t.alarm && ' — el total no lo muestra'}. Clic para ver las transacciones.
          </p>
          <Drops rows={methods} keyCol="method" head="Método que cayó"
            onPick={(metodo) => onOpen({ metric: 'revenue', preset: { metodo } })} />
        </div>
      )}
      <Drops rows={drops} keyCol="store" head="Tienda que cayó"
        onPick={(tienda) => onOpen({ metric: 'revenue', preset: { tienda } })} />
    </>
  )
}

/** Tiempos de atención por terminal. Las tres cifras van juntas a propósito: dos
 *  terminales con el mismo promedio y peores tiempos de 2 y 20 minutos son
 *  problemas distintos, y el promedio solo no los separa. */
function DispatchTimes({ d, rows, onPick }) {
  if (!d.n) {
    return <p className="empty">Ningún despacho cobrado y cerrado en este rango: no hay tiempo que medir.</p>
  }
  return (
    <>
      <p className={`headline ${d.over_ttl ? 'bad' : ''}`}>
        Promedio <b>{dur(d.avg)}</b> · mejor <b>{dur(d.best)}</b> · peor <b>{dur(d.worst)}</b>{' '}
        sobre {num(d.n)} despachos cobrados.
        {d.over_ttl > 0 && ` ${num(d.over_ttl)} pasaron del TTL de ${dur(d.ttl)}.`}
      </p>
      {rows.length > 0 && (
        <table className="plain pickable">
          <thead>
            <tr>
              <th>Terminal</th><th>Tienda</th><th className="n">Despachos</th>
              <th className="n">Mejor</th><th className="n">Promedio</th><th className="n">Peor</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.terminal} onClick={() => onPick(r.terminal)} tabIndex={0} role="button"
                title={`Ver los despachos de ${r.terminal}`}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onPick(r.terminal))}>
                <td>{r.terminal}</td>
                <td>{r.store}</td>
                <td className="n">{num(r.n)}</td>
                <td className="n">{dur(r.best)}</td>
                <td className="n strong">{dur(r.avg)}</td>
                {/* El TTL del modelo es el único umbral con significado propio:
                    marcar en rojo por encima de la media sería inventar uno. */}
                <td className={`n ${r.worst > d.ttl ? 'danger-text' : ''}`}>{dur(r.worst)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

/** Un UUID completo por celda deja la tabla ilegible; el valor entero va en el
 *  `title` y en el detalle, que es donde se copia. */
const corto = (s) => (s && s.length > 14 ? `${s.slice(0, 8)}…` : s)

/** Lo cobrado a los usuarios, método a método.
 *
 * Tabla y no barras sueltas porque un método no se describe con un total: dos
 * métodos con la misma cifra no son lo mismo si uno son tres cobros grandes y el
 * otro trescientos chicos. La participación va como barra dentro de la celda —
 * es parte-de-un-todo, y el porcentaje solo se lee bien contra algo.
 */
function ByMethod({ m, rows, colors, topups, onPick }) {
  if (!m.n) return <p className="empty">Sin ventas cobradas en el período.</p>
  return (
    <>
      <p className="headline">
        <b>{money(m.total)}</b> cobrados a los usuarios en {num(m.n)} ventas ·
        ticket promedio {money(m.n ? m.total / m.n : 0)}.
      </p>
      {/* La diferencia con el KPI de arriba no puede quedar sin explicar: son
          dos cifras distintas del mismo período en la misma pantalla. */}
      <p className="panel-note">
        Las recargas ({money(topups)}) no entran acá: son dinero que el usuario mete a su billetera,
        no algo que la cafetería le vendió. El KPI «Ingresos» de arriba sí las suma.
      </p>
      <table className="plain pickable">
        <thead>
          <tr>
            <th>Método</th><th>Medio</th><th className="n">Ventas</th>
            <th className="n">Ticket promedio</th><th className="n">Total</th><th>Participación</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const tint = colors(r.metodo)
            return (
              <tr key={r.metodo} onClick={() => onPick(r.metodo)} tabIndex={0} role="button"
                title={`Ver las ventas con ${r.metodo}`}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onPick(r.metodo))}>
                <td><span className="dot" style={{ background: tint }} />{r.metodo}</td>
                <td>{MEDIO[r.tipo] ?? r.tipo}</td>
                <td className="n">{num(r.n)}</td>
                <td className="n">{money(r.ticket)}</td>
                <td className="n strong">{money(r.total)}</td>
                <td className="share">
                  <span className="share-bar" style={{
                    width: `${r.share}%`,
                    background: `color-mix(in srgb, ${tint} 40%, transparent)`,
                  }} />
                  <span className="share-num">{pct(r.share)}</span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </>
  )
}

/** El `kind` del método dicho en español. Es lo que separa «con qué plata pagó»
 *  de «cómo se llama el método en la tienda»: dos tiendas pueden llamar distinto
 *  a su datáfono, pero el medio es el mismo. */
const MEDIO = {
  WALLET: 'Billetera Fud',
  CASH: 'Efectivo',
  CARD: 'Tarjeta',
  OTHER: 'Otro',
}

/** Vigilancia de acceso. 401 y 403 van en columnas separadas porque no son lo
 *  mismo: el 401 repetido es alguien probando credenciales; el 403 repetido
 *  sobre muchos recursos es alguien que YA entró y está enumerando lo ajeno. */
function AuthWatch({ w, rows, ends, tint, onPick }) {
  if (!w.scopable) {
    return <p className="empty">Los fallos de acceso no se pueden atribuir a una tienda o ciudad — quita el filtro para verlos.</p>
  }
  if (!w.total) return <p className="ok">✓ Sin fallos de acceso en el período</p>

  const tabla = rows.length > 0 && (
    <table className="plain pickable">
      <thead>
        <tr>
          <th>Actor</th><th>Quién</th><th className="n">401</th><th className="n">403</th>
          <th className="n">Recursos</th><th className="n">IPs</th><th className="n">Último</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((a) => (
          <tr key={`${a.actor}-${a.role}`} onClick={() => onPick(a.actor)} tabIndex={0} role="button"
            title={`Ver los fallos de ${a.actor}`}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onPick(a.actor))}>
            <td>{corto(a.actor)}</td>
            <td>{a.who || '—'}</td>
            <td className="n">{num(a.auth)}</td>
            <td className={`n ${a.perm >= w.min ? 'danger-text' : ''}`}>{num(a.perm)}</td>
            <td className="n">{num(a.targets)}</td>
            <td className="n">{num(a.ips)}</td>
            <td className="n">{a.last ? a.last.slice(0, 10) : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )

  return (
    <>
      <p className={`headline ${w.flagged ? 'bad' : ''}`}>
        <b>{num(w.total)}</b> fallos de acceso — {num(w.auth)} credenciales inválidas (401)
        y {num(w.perm)} accesos denegados (403).
        {w.flagged > 0 && ` ${num(w.flagged)} actor(es) por encima de ${w.min} fallos.`}
      </p>
      {w.flagged > 0 ? <div className="warn">{tabla}</div> : tabla}
      {ends.length > 0 && (
        <>
          <h3 className="sub">Recursos más golpeados</h3>
          {/* Los fallos concentrados en un solo recurso suelen ser un cliente
              mal configurado; repartidos entre muchos, es alguien buscando. */}
          <BarTable rows={ends} label="endpoint" value="n" format={num} colors={() => tint} />
        </>
      )}
    </>
  )
}

/** Límites de peticiones: quién choca contra los rate limits, por usuario y por
 *  dispositivo. Por IP no sirve: en un colegio cientos de celulares salen por una.
 *  Un usuario con varios dispositivos es una cuenta compartida o robada; un
 *  dispositivo con varios usuarios es un celular prestado… o un script probando cuentas. */
function ThrottleWatch({ w, users, devices, scopes, tint, onPick }) {
  if (!w.scopable) {
    return <p className="empty">Los límites de peticiones no se pueden atribuir a una tienda o ciudad — quita el filtro para verlos.</p>
  }
  if (!w.total) return <p className="ok">✓ Nadie topó los límites de peticiones en el período</p>

  const fila = (key, label, onClick, celdas) => (
    <tr key={key} onClick={onClick} tabIndex={0} role="button" title={label}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onClick())}>
      {celdas}
    </tr>
  )
  const ultimo = (v) => (v ? v.slice(0, 16).replace('T', ' ') : '—')

  return (
    <>
      <p className={`headline ${w.flagged ? 'bad' : ''}`}>
        <b>{num(w.total)}</b> peticiones cortadas por límite en el período.
        {w.flagged > 0 && ` ${num(w.flagged)} usuario(s) o dispositivo(s) con ${w.min} o más.`}
      </p>
      {users.length > 0 && (
        <>
          <h3 className="sub">Usuarios</h3>
          <table className="plain pickable">
            <thead>
              <tr><th>Usuario</th><th>Quién</th><th className="n">Rechazos</th>
                <th className="n">Límites</th><th className="n">Dispositivos</th><th className="n">Último</th></tr>
            </thead>
            <tbody>
              {users.map((u) => fila(u.user, `Ver los rechazos de ${u.user}`, () => onPick({ usuario: u.user }), (
                <>
                  <td>{corto(u.user)}</td>
                  <td>{u.who || '—'}</td>
                  <td className={`n ${u.flag ? 'danger-text' : ''}`}>{num(u.n)}</td>
                  <td className="n">{num(u.scopes)}</td>
                  <td className={`n ${u.devices > 1 ? 'danger-text' : ''}`}>{num(u.devices)}</td>
                  <td className="n">{ultimo(u.last)}</td>
                </>
              )))}
            </tbody>
          </table>
        </>
      )}
      {devices.length > 0 && (
        <>
          <h3 className="sub">Dispositivos</h3>
          <table className="plain pickable">
            <thead>
              <tr><th>Dispositivo</th><th className="n">Rechazos</th><th className="n">Usuarios</th><th className="n">Último</th></tr>
            </thead>
            <tbody>
              {devices.map((d) => fila(d.device, `Ver los rechazos de ${d.device}`, () => onPick({ dispositivo: d.device }), (
                <>
                  <td>{corto(d.device)}</td>
                  <td className={`n ${d.flag ? 'danger-text' : ''}`}>{num(d.n)}</td>
                  <td className={`n ${d.users > 1 ? 'danger-text' : ''}`}>{num(d.users)}</td>
                  <td className="n">{ultimo(d.last)}</td>
                </>
              )))}
            </tbody>
          </table>
        </>
      )}
      {scopes.length > 0 && (
        <>
          <h3 className="sub">Límites más topados</h3>
          <BarTable rows={scopes} label="scope" value="n" format={num} colors={() => tint} />
        </>
      )}
    </>
  )
}

/** Bloqueos de PIN de las últimas 24 h (consumidores y cajas), según auth_fud.
 *  «Sin datos» (auth no respondió) se distingue de «sin bloqueos»: lo primero no es buena noticia. */
function PinWatch({ w }) {
  if (!w.available) return <p className="empty">Sin datos: auth_fud no respondió, no se pueden ver los bloqueos de PIN.</p>
  const global = w.scopable
  if (!global && w.terminals.length === 0) {
    return <p className="empty">Sin cajas bloqueadas en este ámbito. Los bloqueos de consumidores no se pueden atribuir a una tienda — quita el filtro para verlos.</p>
  }
  if (global && !w.locks_window) return <p className="ok">✓ Sin bloqueos de PIN en las últimas {w.window_hours} h</p>
  return (
    <>
      {global && (
        <p className={`headline ${w.hard_locks_window ? 'bad' : ''}`}>
          <b>{num(w.locks_window)}</b> bloqueos en {w.window_hours} h ({num(w.locks_last_hour)} en la última hora)
          {w.hard_locks_window > 0 && `, ${num(w.hard_locks_window)} bloqueo(s) duro(s) que requieren intervención`}.
        </p>
      )}
      {w.terminals.length > 0 && (
        <table className="plain">
          <thead><tr><th>Caja</th><th>Tienda</th><th className="n">Bloqueos</th><th className="n">Último</th></tr></thead>
          <tbody>
            {w.terminals.map((t, i) => (
              <tr key={`${t.terminal}-${i}`}>
                <td>{t.terminal}</td><td>{t.store || '—'}</td>
                <td className="n danger-text">{num(t.locks)}</td>
                <td className="n">{t.last ? t.last.slice(0, 16).replace('T', ' ') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {global && w.repeat_users.length > 0 && (
        <>
          <h3 className="sub">Consumidores que insisten (enmascarados)</h3>
          <table className="plain">
            <thead><tr><th>Usuario</th><th className="n">Bloqueos</th><th className="n">Duros</th><th className="n">Último</th></tr></thead>
            <tbody>
              {w.repeat_users.map((u, i) => (
                <tr key={`${u.user}-${i}`}>
                  <td>{u.user}</td><td className="n">{num(u.locks)}</td>
                  <td className={`n ${u.hard_locks ? 'danger-text' : ''}`}>{num(u.hard_locks)}</td>
                  <td className="n">{u.last ? u.last.slice(0, 16).replace('T', ' ') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  )
}

const DPOP_KIND = {
  missing: 'Sin header DPoP', bad_signature: 'Firma inválida', jkt_mismatch: 'Clave distinta a la del token',
  ath_mismatch: 'Proof de otro token', stale: 'Proof vencido', future: 'Proof con fecha futura',
  method_mismatch: 'Método distinto', uri_mismatch: 'URL distinta', replay: 'Proof repetido (replay)',
  replay_check_failed: 'Anti-replay no pudo evaluarse', malformed: 'Proof mal formado',
  bad_typ: 'Tipo de proof inválido', unsupported_alg: 'Algoritmo no permitido',
  private_key_in_header: 'Clave privada en el header', missing_claims: 'Proof incompleto',
  body_digest_mismatch: 'Cuerpo distinto al firmado', invalid: 'Inválido',
}

/** Fallos de DPoP de 24 h. «Bloqueados» (enforce) dejó a alguien sin operar; «observados»
 *  (log_only) se dejó pasar: es lo que hay que revisar antes de pasar a enforce. */
function DpopWatch({ w }) {
  if (!w.available) return <p className="empty">Sin datos: Redis no respondió, no se pueden ver los fallos de DPoP.</p>
  if (!w.scopable) return <p className="empty">Los fallos de DPoP no se pueden atribuir a una tienda o ciudad — quita el filtro para verlos.</p>
  const tabla = (rows) => (
    <table className="plain">
      <tbody>
        {rows.map((r) => (
          <tr key={r.kind}><td>{DPOP_KIND[r.kind] || r.kind}</td><td className="n strong">{num(r.n)}</td></tr>
        ))}
      </tbody>
    </table>
  )
  if (!w.blocked_total && !w.observed_total) {
    return <p className="ok">✓ Sin fallos de DPoP en las últimas {w.window_hours} h (modo {w.mode})</p>
  }
  return (
    <>
      <p className={`headline ${w.blocked_total ? 'bad' : ''}`}>
        Modo <b>{w.mode}</b>: <b>{num(w.blocked_total)}</b> rechazados y <b>{num(w.observed_total)}</b> observados sin bloquear
        (últimas {w.window_hours} h).
      </p>
      {w.blocked_total > 0 && <><h3 className="sub">Rechazados</h3>{tabla(w.blocked)}</>}
      {w.observed_total > 0 && <><h3 className="sub">Observados (no bloquearon)</h3>{tabla(w.observed)}</>}
    </>
  )
}

/** Usuarios DISTINTOS, que no es lo que dice «Tipo de pagador»: veinte órdenes
 *  pueden ser veinte personas o una que volvió veinte veces, y para dimensionar
 *  el sistema hace falta la segunda cifra. */
function ActiveUsers({ u, onPick }) {
  const filas = u.rows.filter((r) => r.orders > 0)
  const total = u.rows.reduce((s, r) => s + r.users, 0)
  return (
    <>
      <p className="headline">
        <b>{num(total)}</b> usuarios distintos operaron en el período ·{' '}
        <b>{num(u.terminals_active)}</b> de {num(u.terminals_total)} terminales con actividad.
      </p>
      {filas.length === 0 ? <p className="empty">Sin actividad de usuarios en el período</p> : (
        <table className="plain pickable">
          <thead>
            <tr><th>Tipo</th><th className="n">Usuarios</th><th className="n">Órdenes</th><th className="n">Monto</th></tr>
          </thead>
          <tbody>
            {filas.map((r) => (
              <tr key={r.type} onClick={() => onPick(r.type)} tabIndex={0} role="button"
                title={`Ver los ${r.label.toLowerCase()} uno por uno`}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onPick(r.type))}>
                <td>{r.label}</td>
                <td className="n strong">{num(r.users)}</td>
                <td className="n">{num(r.orders)}</td>
                <td className="n">{money(r.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

function Events({ e, tint, onPick }) {
  if (!e.scopable) {
    return <p className="empty">Los eventos de auditoría no se pueden atribuir a una tienda o ciudad — quita el filtro para verlos.</p>
  }
  if (!e.rows.length) return <p className="empty">Sin eventos en el período</p>
  const alto = e.failure_rate >= 30
  return (
    <>
      <p className={`headline ${alto ? 'bad' : ''}`}>
        <b>{e.failure_rate}%</b> de {num(e.total)} eventos son fallos de autenticación o permisos.
        {alto && ' Revisar: puede ser un cliente mal configurado o intentos de acceso.'}
        {/* El % y el total son de TODOS los eventos; la tabla solo dibuja los 15
            tipos más frecuentes. Decirlo evita que las cifras parezcan no cuadrar. */}
        {e.types > e.rows.length && ` Abajo, los ${e.rows.length} tipos más frecuentes de ${e.types}.`}
      </p>
      <BarTable rows={e.rows} label="event_type" value="n" format={num} onRow={onPick}
        colors={(_, i) => (e.rows[i].failure ? statusColor('FAILED') : tint)} />
    </>
  )
}

const WORKER_STATE = {
  ok: { tone: 'ok', text: 'Activo' },
  down: { tone: 'down', text: 'Caído' },
  never: { tone: 'idle', text: 'Sin latidos registrados' },
  unknown: { tone: 'idle', text: 'Sin datos' },
}

/** Los procesos de fondo, siempre arriba y fuera de los filtros.
 *
 *  Si el que drena el outbox se detiene, los cobros a wallet dejan de confirmarse
 *  y el síntoma (cobros en limbo) aparece horas después. Aquí se ve la causa. Un
 *  worker «sin latidos» no es lo mismo que uno caído: puede no estar desplegado
 *  en este entorno, así que va en gris y no enciende la alarma. */
function WorkersBar({ workers }) {
  const caidos = workers.filter((w) => w.state === 'down').length
  return (
    <section id="procesos" className={`workers ${caidos ? 'alarm' : ''}`} role="status" aria-label="Procesos de fondo">
      <span className="workers-title">Procesos de fondo</span>
      <ul>
        {workers.map((w) => {
          const s = WORKER_STATE[w.state] ?? WORKER_STATE.unknown
          const vivo = w.state === 'ok' || w.state === 'down'
          return (
            <li key={w.worker} className={`worker ${s.tone}`}
              title={vivo ? `Se da por caído tras ${dur(w.threshold_seconds)} sin latir (corre cada ${dur(w.interval)})` : undefined}>
              <i />
              <b>{w.label}</b>
              <span>{vivo ? `${s.text}, último latido hace ${dur(w.age_seconds)}` : s.text}</span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** Semáforo por área, arriba de todo. Se calcula en `status.js` con lo que ya llegó. */
function StatusStrip({ data }) {
  const areas = computeStatus(data)
  const h = headline(areas)
  return (
    <section className={`status ${h.tone}`} aria-label="Estado del día">
      <p className="status-head"><i />Estado del día: <b>{h.text}</b></p>
      <ul>
        {areas.map((a) => (
          <li key={a.id}>
            <button type="button" className={`pill ${a.tone}`} onClick={() => goToArea(a.id)}
              title={a.razones.length ? a.razones.join('; ') : a.tone === 'ok' ? 'Sin novedades' : undefined}>
              <i />{a.label}{a.n > 0 && <b>{num(a.n)}</b>}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

// La severidad que manda el backend decide el tono de la tarjeta.
const ALERT_TONE = { critical: 'danger', warn: 'warn', info: 'info' }

/** El subtítulo viaja tipado: el formato de dinero vive aquí, no en el backend. */
const alertSub = (sub) => (!sub ? '' : sub.type === 'money' ? money(sub.value) : sub.value)

function Alerts({ a, onOpen }) {
  // El backend manda TODAS las alertas registradas, también las que están en
  // cero (el «Estado del día» necesita saber que un grupo está en verde). Aquí
  // solo se dibujan las que tienen casos. La clave es la misma que la métrica
  // del detalle: la tarjeta y sus filas salen del mismo queryset, así el número
  // no puede diferir.
  // Las que dependen de otro servicio y no tienen datos también se dibujan: su 0 no
  // es «sin casos», y callarla sería decir que todo está bien sin saberlo.
  const items = a.filter((x) => x.n > 0 || x.available === false)

  if (!items.length) return <p className="ok">✓ Sin alertas</p>
  return (
    <div className="alerts">
      {items.map((x) => (x.available === false
        ? <Card key={x.key} label={x.label} value="—" sub="sin datos: el servicio no respondió" />
        : <Card key={x.key} tone={ALERT_TONE[x.severity] ?? 'danger'} label={x.label} value={num(x.n)}
            sub={alertSub(x.sub)} onOpen={() => onOpen(x.key)} />
      ))}
    </div>
  )
}

export default function App() {
  const { data, error, loading, filters, setFilters, refresh, tick } = useMetrics()
  const [theme, toggleTheme] = useTheme()
  const [q, setQ] = useState('')
  const [detail, setDetail] = useState(null)  // {metric, preset}
  const [docs, setDocs] = useState(false)
  const [treasury, setTreasury] = useState(false)

  if (error) return <main><p className="error">Error cargando métricas: {error}</p></main>
  if (!data) return <Skeleton />

  const { kpis, alerts, trend } = data
  const CAT = theme === 'dark' ? CAT_DARK : CAT_LIGHT
  // Un color por ítem dentro de cada panel, FIJADO desde la lista sin filtrar:
  // así buscar o acotar no repinta a los supervivientes. Los slots son 8 y solo
  // 8 (generar un noveno lo haría indistinguible bajo daltonismo), así que los
  // paneles se recortan a 8 filas y el resto se ve en el detalle.
  const paleta = (rows, key) => stableColors(rows, key, CAT)
  const top = (rows) => rows.slice(0, SLOTS)
  const restante = (rows) => (rows.length > SLOTS ? `top ${SLOTS} de ${rows.length}` : null)

  // Un solo período puede concentrar casi todo el ingreso y dejar la serie
  // plana. Se etiqueta el extremo: sin eso el gráfico no dice nada. (Solo el
  // máximo — una cifra en cada punto sería ruido.)
  const series = data.revenue.points
  const peak = series.reduce((a, b) => (b.total > (a?.total ?? -1) ? b : a), null)
  // La etiqueta va del lado donde hay sitio. Centrada sobre un punto del borde, el texto se
  // extendía sobre los números del eje Y y se encimaba con el `$100 k`.
  const peakAt = series.length > 1 ? series.indexOf(peak) / (series.length - 1) : 0.5
  const peakSide = peakAt < 0.25 ? 'right' : peakAt > 0.75 ? 'left' : 'top'
  const bucketLabel = { day: 'por día', week: 'por semana', month: 'por mes' }[data.revenue.bucket]

  // Cada paleta se calcula sobre los datos SIN el filtro de texto.
  const colStore = paleta(data.sales_by_store, 'store')
  const colMethod = paleta(data.revenue_by_method.rows, 'metodo')
  // El dominio de métodos sale del panel de métodos, no de las tiendas: así el
  // orden de la leyenda y los slots de color son los mismos en los dos sitios,
  // y una tienda que solo cobra en efectivo no repinta a las demás.
  const metodosDom = data.revenue_by_method.rows.map((r) => r.metodo)
  const negocio = data.customers.find((c) => c.id === filters.customer)
  const colProduct = paleta(data.top_products, 'name')
  const colPayment = paleta(data.payments_by_status, 'status')
  const colOrder = paleta(data.orders_funnel, 'status')
  const colTopup = paleta(data.topups, 'status')
  const colOrigin = paleta(data.orders_mix.origin, 'origin')
  const colOwner = paleta(data.orders_mix.owner, 'payment_owner_type')
  const colDispatch = paleta(data.dispatches, 'status')

  const metodos = filterRows(data.revenue_by_method.rows, q, 'metodo', 'tipo')
  const stores = filterRows(data.sales_by_store, q, 'store')
  const products = filterRows(data.top_products, q, 'name')
  const payments = filterRows(data.payments_by_status.filter((r) => r.n > 0), q, 'status')
  const funnel = filterRows(data.orders_funnel.filter((r) => r.n > 0), q, 'status')
  const topups = filterRows(data.topups.filter((r) => r.n > 0), q, 'status')
  const origin = filterRows(data.orders_mix.origin.filter((r) => r.n > 0), q, 'origin')
  const owner = filterRows(data.orders_mix.owner.filter((r) => r.n > 0), q, 'payment_owner_type')
  const dispatches = filterRows(data.dispatches.filter((r) => r.n > 0), q, 'status')
  const lowStock = filterRows(data.low_stock, q, 'product', 'store')
  const tiempos = filterRows(data.dispatch_times.terminals, q, 'terminal', 'store')
  const actores = filterRows(data.auth_watch.actors, q, 'actor', 'who')
  const recursos = filterRows(data.auth_watch.endpoints, q, 'endpoint')
  const limUsers = filterRows(data.throttle_watch.users, q, 'user', 'who')
  const limDevices = filterRows(data.throttle_watch.devices, q, 'device')
  const limScopes = filterRows(data.throttle_watch.scopes, q, 'scope')

  // Buscando, un panel sin coincidencias se oculta en vez de quedar vacío:
  // ocho cajas con "Sin datos" leen como si el buscador estuviera roto.
  const searching = q.trim().length > 0
  const show = (rows) => !searching || rows.length > 0

  const suggestions = [...new Set([
    ...data.sales_by_store.map((r) => r.store),
    ...data.stores.map((s) => s.name),
    ...data.top_products.map((r) => r.name),
    ...[data.payments_by_status, data.orders_funnel, data.dispatches, data.topups]
      .flat().filter((r) => r.n > 0).map((r) => r.status),
  ].filter(Boolean))].sort()

  return (
    <>
      <TopBar {...{ filters, setFilters, cities: data.cities, stores: data.stores, customers: data.customers, range: data.range, suggestions, q, setQ, onRefresh: refresh, loading, theme, toggleTheme, onDocs: () => setDocs(true), onTreasury: () => setTreasury(true), sections: SECTIONS }} />
      {/* Al refrescar se mantiene el render anterior atenuado: sin salto de layout. */}
      <main className={loading ? 'stale' : ''}>
        <Section id="estado" title="Estado del día" sub="semáforo por área y procesos de fondo">
          <StatusStrip data={data} />
          <WorkersBar workers={data.workers} />
        </Section>
        {/* Qué estás mirando, antes de la primera cifra. Con un customer puesto,
            todos los números de abajo son de ESTAS tiendas y de ninguna otra;
            dejarlo implícito es la forma más fácil de leer mal el panel. */}
        {filters.customer && (
          <div className="scope-band">
            <p>
              <b>{negocio?.name ?? 'Customer seleccionado'}</b>
              {' · '}{num(data.stores.length)} {data.stores.length === 1 ? 'tienda' : 'tiendas'}
              {filters.city && ' en la ciudad elegida'}
            </p>
            {data.stores.length > 0 && (
              <div className="chips">
                {data.stores.map((t) => (
                  <button key={t.id} className={filters.store === t.id ? 'on' : ''}
                    title={filters.store === t.id ? 'Quitar el filtro de tienda' : `Ver solo ${t.name}`}
                    onClick={() => setFilters({
                      ...filters, store: filters.store === t.id ? '' : t.id,
                    })}>
                    {t.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <Section id="resumen" title="Resumen">
        <div className="cards">
          <Card hero label="Ingresos" value={moneyShort(kpis.revenue)} onOpen={() => setDetail({ metric: 'revenue' })}
            delta={trend.revenue.delta} deltaMuted={!trend.reliable}
            sub={`${num(kpis.payments)} transacciones · ${money(kpis.revenue)}`} />
          <Card tone="accent" label="Comisión plataforma" value={money(kpis.commission)}
            onOpen={() => setDetail({ metric: 'commission' })} sub="lo que gana Fud" />
          <Card label="Recargas" value={moneyShort(kpis.topups)} onOpen={() => setDetail({ metric: 'topups' })} />
          {/* Lo que las promos descontaron en órdenes pagadas, y cuánto pesa sobre las ventas.
              Un salto aquí suele ser una promo mal configurada (p. ej. 90 % por accidente). */}
          <Card label="Descuentos" value={moneyShort(kpis.discounts)} sub={`${kpis.discounts_pct}% de las ventas`}
            onOpen={() => setDetail({ metric: 'discounts' })} />
          <Card label="Ticket promedio" value={money(kpis.ticket_avg)} onOpen={() => setDetail({ metric: 'ticket_avg' })} />
          <Card label="Órdenes" value={num(kpis.orders)} delta={trend.orders.delta}
            onOpen={() => setDetail({ metric: 'orders' })}
            deltaMuted={!trend.reliable} sub={`${kpis.conversion}% pagadas`} />
          <Card label="Terminales" value={`${data.terminals.active}/${data.terminals.total}`}
            onOpen={() => setDetail({ metric: 'terminals' })}
            sub={data.scoped_to_store ? 'activas en este ámbito' : 'activas'} />
        </div>
        </Section>

        <Section id="alertas" title="Alertas" sub="lo que hay que mirar antes que las ventas">
        <Panel title="Requiere atención"
          sub={data.scoped_to_store ? 'de este ámbito · sin límite de fechas' : 'sin límite de fechas'}>
          <Alerts a={alerts} onOpen={(metric) => setDetail({ metric })} />
        </Panel>

        <Panel title="Bloqueos de PIN" sub="consumidores y cajas, últimas 24 h, datos de auth_fud">
          <PinWatch w={data.pin_watch} />
        </Panel>

        <Panel title="Fallos de DPoP" sub="prueba de posesión de la clave del dispositivo, últimas 24 h">
          <DpopWatch w={data.dpop_watch} />
        </Panel>

        <Panel title="Cambios de comportamiento" sub={`vs los ${trend.span_days} días anteriores`} wide>
          <Trend t={trend} onOpen={setDetail} />
        </Panel>

        <Panel title="Vigilancia de acceso" wide
          sub="fallos de autenticación y permisos del período · clic en un actor para ver los suyos"
          onOpen={() => setDetail({ metric: 'auth_failures' })}>
          <AuthWatch w={data.auth_watch} rows={top(actores)} ends={top(recursos)} tint={CAT[0]}
            onPick={(actor) => setDetail({ metric: 'auth_failures', preset: { actor } })} />
        </Panel>

        <Panel title="Límites de peticiones" wide
          sub="quién topa los rate limits (auth y business) en el período · clic en una fila para ver sus rechazos"
          onOpen={() => setDetail({ metric: 'throttle_denials' })}>
          <ThrottleWatch w={data.throttle_watch} users={top(limUsers)} devices={top(limDevices)}
            scopes={top(limScopes)} tint={CAT[0]}
            onPick={(preset) => setDetail({ metric: 'throttle_denials', preset })} />
        </Panel>
        </Section>

        <Section id="ventas" title="Ventas">
        <Panel title="Ingresos" sub={bucketLabel} wide>
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={series} margin={{ left: 4, right: 12, top: 24, bottom: 4 }}>
              <defs>
                <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={CAT[0]} stopOpacity={0.14} />
                  <stop offset="100%" stopColor={CAT[0]} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--line)" vertical={false} />
              <XAxis dataKey="day" {...AXIS} minTickGap={28} />
              <YAxis {...AXIS} width={62} tickFormatter={moneyShort} />
              <Tooltip {...TOOLTIP} cursor={{ stroke: 'var(--muted)', strokeWidth: 1 }}
                formatter={(v, k) => [k === 'Ingresos' ? money(v) : num(v), k]} />
              <Area type="monotone" dataKey="total" name="Ingresos" stroke={CAT[0]}
                strokeWidth={2} fill="url(#fill)" dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }} />
              {peak?.total > 0 && (
                <ReferenceDot x={peak.day} y={peak.total} r={4} fill={CAT[0]}
                  stroke="var(--surface)" strokeWidth={2} isFront
                  label={{ value: `${moneyShort(peak.total)} · ${peak.day.slice(5)}`,
                    position: peakSide, offset: 10, fontSize: 11, fill: CAT[0],
                    // Halo del color del fondo: la línea de la grilla no cruza el texto.
                    style: { stroke: 'var(--surface)', strokeWidth: 3, paintOrder: 'stroke' } }} />
              )}
            </AreaChart>
          </ResponsiveContainer>
        </Panel>

        {/* Panel ancho y antes de la grilla: es la cifra que el negocio mira
            primero, y necesita las cinco columnas para no mentir. */}
        {show(metodos) && (
          <Panel title="Cobrado a los usuarios, método a método" wide
            sub="ventas del período · sin recargas"
            onOpen={() => setDetail({ metric: 'sales' })}>
            <ByMethod m={data.revenue_by_method} rows={metodos} colors={colMethod}
              topups={kpis.topups}
              onPick={(metodo) => setDetail({ metric: 'sales', preset: { metodo } })} />
          </Panel>
        )}

        <div className="grid">
          {/* Estados de pago: aquí el color SÍ significa bueno/malo, así que
              usa la paleta de estado — y nunca va solo, la fila lleva su
              etiqueta y su cifra al lado. */}
          {show(payments) && (
            <Panel title="Pagos por estado" sub="nº de transacciones" onOpen={() => setDetail({ metric: 'payments' })}>
              <BarTable rows={top(payments)} label="status" value="n" format={num} colors={colPayment}
                onRow={(estado) => setDetail({ metric: 'payments', preset: { estado } })} />
            </Panel>
          )}

          {show(stores) && (
            <Panel title="Ventas por tienda" wide
              sub={restante(stores) ?? "acumulado de todos los métodos · sin recargas"}
              onOpen={() => setDetail({ metric: 'sales' })}>
              {/* Segmentada por método, con la paleta de método: el largo compara
                  tiendas y el reparto dice de qué vive cada una. Dos tiendas con
                  la misma venta no son el mismo negocio si una cobra todo en
                  efectivo y la otra todo por billetera. */}
              <SegmentedBars rows={top(stores)} label="store" value="total" extra="n"
                series={metodosDom} colors={colMethod}
                onRow={(tienda) => setDetail({ metric: 'sales', preset: { tienda } })} />
            </Panel>
          )}

          {show(products) && (
            <Panel title="Productos más vendidos" sub={restante(products) ?? "unidades"}>
              <BarTable rows={top(products)} label="name" value="q" format={num} colors={colProduct} />
            </Panel>
          )}

          {show(topups) && (
            <Panel title="Recargas por estado" sub="monto acumulado" onOpen={() => setDetail({ metric: 'topups' })}>
              <BarTable rows={top(topups)} label="status" value="total" extra="n" colors={colTopup}
                onRow={(estado) => setDetail({ metric: 'topups', preset: { estado } })} />
            </Panel>
          )}
        </div>
        </Section>

        <Section id="operacion" title="Operación">
        <div className="grid">
          {/* Una sola serie (nº de órdenes) ⇒ un solo tono. Los estados que no
              son etapa sino salida en falso van en crítico: eso es énfasis,
              no una paleta categórica. */}
          {show(funnel) && (
            <Panel title="Órdenes por estado" sub="nº de órdenes" onOpen={() => setDetail({ metric: 'orders' })}>
              <BarTable rows={top(funnel)} label="status" value="n" format={num} colors={colOrder}
                onRow={(estado) => setDetail({ metric: 'orders', preset: { estado } })} />
            </Panel>
          )}

          {/* Estas tres son parte-de-un-todo: el total es el 100% de las
              órdenes / despachos, no un ranking. */}
          {show(origin) && (
            <Panel title="Canal de venta" sub="% de órdenes">
              <StackedBar rows={top(origin)} label="origin" value="n" colors={colOrigin} />
            </Panel>
          )}

          {show(owner) && (
            <Panel title="Tipo de pagador" sub="% de órdenes">
              <StackedBar rows={top(owner)} label="payment_owner_type" value="n" colors={colOwner} />
            </Panel>
          )}

          {show(dispatches) && (
            <Panel title="Desenlace de despachos" sub="% del total">
              <StackedBar rows={top(dispatches)} label="status" value="n" colors={colDispatch} />
            </Panel>
          )}
        </div>

        <Panel title="Usuarios activos" wide
          sub="usuarios distintos, no órdenes · sin dato de wifi/datos móviles: no se registra"
          onOpen={() => setDetail({ metric: 'active_users' })}>
          <ActiveUsers u={data.active_users}
            onPick={(tipo) => setDetail({ metric: 'active_users', preset: { tipo } })} />
        </Panel>

        {show(tiempos) && (
          <Panel title="Tiempos de despacho" wide
            sub="solo despachos cobrados · clic en una terminal para ver los suyos"
            onOpen={() => setDetail({ metric: 'dispatch_times' })}>
            <DispatchTimes d={data.dispatch_times} rows={top(tiempos)}
              onPick={(terminal) => setDetail({ metric: 'dispatch_times', preset: { terminal } })} />
          </Panel>
        )}

        {lowStock.length > 0 && (
          <Panel title="Stock bajo" wide>
            <table className="plain">
              <thead><tr><th>Producto</th><th>Tienda</th><th className="n">Cantidad</th><th className="n">Límite</th></tr></thead>
              <tbody>
                {lowStock.map((r, i) => (
                  <tr key={i}>
                    <td>{r.product}</td><td>{r.store}</td>
                    <td className="n danger-text">{r.quantity}</td><td className="n">{r.limit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
        </Section>

        <Section id="sistema" title="Sistema">
        <Panel title="Eventos del sistema" sub="auditoría · clic en un evento para ver el detalle" wide
          onOpen={() => setDetail({ metric: 'events' })}>
          <Events e={data.events} tint={CAT[0]}
            onPick={(evento) => setDetail({ metric: 'events', preset: { evento } })} />
        </Panel>
        </Section>

        {searching && ![payments, funnel, stores, products, origin, owner, dispatches, topups, lowStock, tiempos]
          .some((r) => r.length > 0) && (
          <p className="empty">Sin coincidencias para «{q}».</p>
        )}
      </main>

      {detail && (
        <Detail metric={detail.metric} preset={detail.preset} filters={filters}
          tint={CAT[0]} cat={CAT} reload={tick} onChanged={refresh} onClose={() => setDetail(null)} />
      )}

      {docs && <Docs onClose={() => setDocs(false)} />}

      {treasury && (
        <Treasury stores={data.stores} store={filters.store} cat={CAT} onClose={() => setTreasury(false)} />
      )}
    </>
  )
}
