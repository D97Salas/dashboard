import { Fragment, useEffect, useRef, useState } from 'react'
import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { action, API_BASE, dur, money, num } from './api'
import { BarTable, SegmentedBars, Toasts, useBackdropClose, useToasts } from './components'
import Reconcile from './Reconcile'
import { NO_COLOR, stableColors, statusColor } from './palette'

const AXIS = { fontSize: 11, tickLine: false, axisLine: false, stroke: 'var(--muted)' }
const TOOLTIP = {
  contentStyle: {
    background: 'var(--surface)', border: '1px solid var(--line)',
    borderRadius: 8, fontSize: 13, boxShadow: '0 4px 16px rgba(0,0,0,.10)',
  },
  labelStyle: { color: 'var(--muted)', marginBottom: 4 },
}
const LEGEND = {
  verticalAlign: 'top', align: 'left', iconType: 'plainline', iconSize: 14,
  wrapperStyle: { fontSize: 12, paddingBottom: 8 },
}

const fmt = {
  money: (v) => money(v),
  num: (v) => num(v),
  // Compacto y en 24h: `dateStyle:'short'` con `timeStyle` parte la celda en
  // tres líneas ("17/07/26, 2:08 p. m.") y la tabla se vuelve ilegible.
  datetime: (v) => (v
    ? new Date(v).toLocaleString('es-CO', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      })
    : '—'),
  dur: (v) => dur(v),
  text: (v) => v ?? '—',
  status: (v) => v ?? '—',
}

function Chart({ chart, tint, cat, colorFor, onPick }) {
  const { points, type } = chart
  // Sin `unit` el formato se adivina: si el valor no es el conteo, es dinero.
  // Con duraciones esa heurística falla (mostraría "$180" por 3 minutos).
  const money_ = !chart.unit && points.some((p) => p.value !== p.n)
  const fmtV = chart.unit === 'dur' ? dur : money_ ? money : num
  // Mismo criterio que el panel: un color por ítem mientras quepan en los 8
  // slots validados. Pasado eso (las 24 franjas horarias, una serie por día)
  // es una sola serie y va en un solo tono.
  const porItem = points.length <= cat.length
  // Un punto marcado `bad` va SIEMPRE en el color de estado, aunque la lista pase
  // de los 8 slots y el resto caiga al tono único: si un fallo se pinta como
  // cualquier otra cosa, el panel y el cajón dicen cosas distintas.
  const color = (label, i) => (points[i]?.bad
    ? statusColor('FAILED')
    : porItem ? colorFor(label, i) : tint)

  if (!points.length) return <p className="empty">Sin datos</p>

  if (type === 'area') {
    // `series` = una línea por estado. El backend solo la manda cuando hay más
    // de uno y caben en los 8 slots; filtrando por ese estado vuelve a una sola.
    const series = chart.series ?? []
    const punto = { r: 4, strokeWidth: 2, stroke: 'var(--surface)' }
    return (
      <ResponsiveContainer width="100%" height={260}>
        <AreaChart data={points} margin={{ left: 4, right: 12, top: 8 }}>
          <defs>
            <linearGradient id="dfill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={tint} stopOpacity={0.14} />
              <stop offset="100%" stopColor={tint} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--line)" vertical={false} />
          <XAxis dataKey="label" {...AXIS} minTickGap={28} />
          <YAxis {...AXIS} width={62} tickFormatter={fmtV} />
          <Tooltip {...TOOLTIP} formatter={(v, name) => [fmtV(v), name]} />
          {series.length > 0 && <Legend {...LEGEND} />}
          {/* Varias series van SIN relleno: dos áreas translúcidas superpuestas
              dan un tercer tono que no corresponde a ningún dato. */}
          {series.length
            ? series.map((s) => (
              <Area key={s} type="monotone" dataKey={s} name={s} stroke={colorFor(s)}
                strokeWidth={2} fillOpacity={0} dot={false} activeDot={punto} />
            ))
            : (
              <Area type="monotone" dataKey="value" name={chart.label} stroke={tint}
                strokeWidth={2} fill="url(#dfill)" dot={false} activeDot={punto} />
            )}
        </AreaChart>
      </ResponsiveContainer>
    )
  }

  // Barras en HTML plano, igual que en el panel principal: Recharts 3.10 no
  // pinta los rectángulos con `layout="vertical"` en este montaje, y así el
  // valor exacto queda siempre visible en vez de escondido tras el tooltip.
  //
  // Con `series` cada barra se parte por la dimensión (método, estado…) usando
  // SU paleta, la misma del resto del cajón. El backend solo las manda sin
  // filtro puesto: al filtrar queda un valor y la barra vuelve a ser sólida.
  // La columna `n` solo informa cuando el valor NO es el conteo: en un gráfico
  // de conteos mostraba el mismo número dos veces, pegado a sí mismo.
  const extra = money_ || chart.unit === 'dur' ? 'n' : undefined
  if (chart.series?.length) {
    return (
      <SegmentedBars rows={points} label="label" value="value" extra={extra}
        series={chart.series} colors={(s) => colorFor(s)} format={fmtV} onRow={onPick} />
    )
  }
  return (
    <BarTable rows={points} label="label" value="value" extra={extra}
      format={fmtV} onRow={onPick} colors={color} />
  )
}

function Stats({ s, unit }) {
  if (!s) return null
  // Las mismas cifras pueden ser pesos o segundos; el backend dice cuál.
  const f = unit === 'dur' ? dur : money
  return (
    <div className="stats">
      {[['Mediana', s.mediana], ['Promedio', s.promedio], ['p25', s.p25],
        ['p75', s.p75], ['Mín', s.min], ['Máx', s.max]].map(([k, v]) => (
        <div key={k}><span>{k}</span><b>{f(v)}</b></div>
      ))}
    </div>
  )
}

/** Lo que el desplegable no puede decir.
 *
 * Dos cosas: qué significa cada etiqueta (una faceta puede traer `hint`), y el
 * id COMPLETO del valor elegido. La etiqueta lo abrevia para que quepa, pero
 * para ir a buscarlo a la base hace falta entero — y seleccionarlo entero de un
 * clic, no arrastrando sobre un `<option>` que ni siquiera se puede copiar.
 */
function FilterNote({ filters = [], cols }) {
  const elegidos = filters.filter((f) => f.labels && cols[f.key])
  const notas = filters.filter((f) => f.hint)
  if (!elegidos.length && !notas.length) return null
  return (
    <div className="filter-note">
      {elegidos.map((f) => (
        <p key={f.key}><b>{f.label}:</b> <code>{cols[f.key]}</code></p>
      ))}
      {notas.map((f) => <p key={`${f.key}-hint`}>{f.hint}</p>)}
    </div>
  )
}

export default function Detail({ metric, preset, filters, tint, cat, reload, onChanged, onClose }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [chartId, setChartId] = useState(null)
  const [tab, setTab] = useState('grafico')
  // Filtros de columna. Arrancan en lo que traiga `preset` (p.ej. abrir el
  // detalle ya filtrado por el estado en el que se hizo clic).
  const [cols, setCols] = useState(preset ?? {})
  // Fila cuyo panel (comando copiable o conciliación) está desplegado, y la que se acaba de copiar.
  const [abierta, setAbierta] = useState(null)
  const [copiada, setCopiada] = useState(null)
  // Avisos del resultado de las acciones de las filas (copiar, conciliar), bien o mal.
  const { toasts, dismiss, notify } = useToasts()
  // Color por etiqueta, fijado la PRIMERA vez que se ve cada gráfico. Aplicar un
  // filtro de columna quita filas; si el color se reasignara, las que quedan
  // cambiarían de tono y parecerían otra cosa.
  const paletas = useRef(new Map())
  const backdrop = useBackdropClose(onClose)

  useEffect(() => {
    const onEsc = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [onClose])

  useEffect(() => { paletas.current.clear() }, [metric])

  useEffect(() => {
    setError(null)
    const qs = new URLSearchParams(filters)
    Object.entries(cols).forEach(([k, v]) => v && qs.set(`f_${k}`, v))
    fetch(`${API_BASE}api/detail/${metric}/?${qs}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setError(e.message))
    // `reload` es el contador del botón de refrescar: sin él en las dependencias
    // el cajón abierto se quedaba con los datos de cuando se abrió.
  }, [metric, filters, cols, reload])

  // Un dato nuevo (filtro, refresco, acción aplicada) puede reordenar las filas: el
  // panel abierto apuntaría a otra. Se cierra para que nunca actúe sobre la fila equivocada.
  useEffect(() => { setAbierta(null) }, [data])

  // Una fila puede traer `copy` (texto para pegar en la shell: no se ejecuta desde
  // aquí a propósito, p. ej. marcar pagado exige el ledger de wallet como prueba) o
  // `reconcile` (el id de un cobro que se puede conciliar preguntándole a wallet).
  const hayAcciones = data?.rows?.some((r) => r.copy || r.reconcile || r.actions?.length)

  // Acciones de un clic: `r.actions` en una fila, `data.actions` para todo el conjunto.
  // Cada una es `{name, label, payload, confirm?}` y el backend la valida contra la misma
  // regla que la alerta, así que aquí no se decide nada: se confirma, se manda y se avisa.
  // Mientras una corre, las demás quedan deshabilitadas (no se pisan dos llamadas a auth).
  const [ejecutando, setEjecutando] = useState(null)
  const claveAccion = (a) => `${a.name}:${JSON.stringify(a.payload)}`
  const ejecutar = (a) => {
    if (a.confirm && !window.confirm(a.confirm)) return
    setEjecutando(claveAccion(a))
    action(a.name, a.payload)
      .then((d) => { notify(d.message ?? 'Listo.'); onChanged?.() }, (e) => notify(e.message, true))
      .finally(() => setEjecutando(null))
  }
  const botonAccion = (a, i) => (
    <button key={i} className="btn btn-primary btn-sm" disabled={ejecutando !== null} onClick={() => ejecutar(a)}>
      {ejecutando === claveAccion(a) ? 'Trabajando…' : a.label}
    </button>
  )
  const copiar = (i, texto) => {
    const aviso = () => {
      setCopiada(i)
      setTimeout(() => setCopiada((actual) => (actual === i ? null : actual)), 2000)
    }
    if (!navigator.clipboard) {
      notify('Este navegador no deja copiar desde aquí. Selecciona el texto y cópialo a mano.', true)
      return
    }
    navigator.clipboard.writeText(texto).then(
      () => { aviso(); notify('Comando copiado al portapapeles.') },
      () => notify('No se pudo copiar. Selecciona el texto y cópialo a mano.', true),
    )
  }

  const chart = data?.charts?.find((c) => c.id === chartId) ?? data?.charts?.[0]
  // La paleta se guarda por DIMENSIÓN, no por gráfico: las líneas del temporal y
  // las barras de esa misma dimensión describen lo mismo, y FAILED no puede ser
  // rojo en uno y azul en el otro. Sin `dim` (el caso normal) la clave es el id.
  const pkey = chart && (chart.dim ?? chart.id)
  if (chart && !paletas.current.has(pkey)) {
    // El dominio son las OPCIONES de la faceta, que el backend calcula sin
    // aplicar los filtros de columna. Si el color saliera de lo visible, filtrar
    // por EXPIRED lo repintaría del primer slot y quien aprendió su color en el
    // gráfico completo leería mal el filtrado. Con más opciones que slots se
    // vuelve al orden del gráfico: ahí no hay color por ítem que preservar.
    const dominio = data?.filters?.find((f) => f.key === pkey)
    const etiquetas = dominio && dominio.options.length <= cat.length
      ? dominio.options.map((label) => ({ label }))
      : chart.series?.map((label) => ({ label })) ?? chart.points
    paletas.current.set(pkey, stableColors(etiquetas, 'label', cat))
  }
  // Filtrado a un solo valor no quedan varias series, pero la línea sigue siendo
  // la de ESE estado: lleva su color, no el tinte por defecto. Si no, PAID y
  // PENDING dibujan la misma curva azul y el color deja de significar nada.
  // Si esa dimensión no cupo en los slots no hay color propio que heredar: se
  // queda con el tinte, nunca con el gris de "sin slot".
  const solo = chart?.dim && data?.filters?.find((f) => f.key === chart.dim)?.value
  const propio = solo && paletas.current.get(pkey)(solo)
  const trazo = propio && propio !== NO_COLOR ? propio : tint

  return (
    <div className="drawer-backdrop" {...backdrop}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header>
          <h2>{data?.title ?? 'Cargando…'}</h2>
          <button className="ghost" onClick={onClose} title="Cerrar (Esc)">×</button>
        </header>

        {error && <p className="error">Error: {error}</p>}
        {!data && !error && <p className="empty">Cargando…</p>}

        {data && (
          <>
            <p className="drawer-meta">
              {num(data.total)} registros ·{' '}
              {data.ignores_date_range
                ? 'todo el histórico'
                : `${filters.desde} → ${filters.hasta}`}
              {data.note && <><br /><em>{data.note}</em></>}
            </p>

            {data.filters?.length > 0 && (
              <div className="col-filters">
                {data.filters.map((f) => (
                  <label key={f.key} className={cols[f.key] ? 'on' : ''}>
                    <span>{f.label}</span>
                    <select value={cols[f.key] ?? ''}
                      onChange={(e) => setCols({ ...cols, [f.key]: e.target.value })}>
                      <option value="">Todos</option>
                      {f.options.map((o) => <option key={o} value={o}>{f.labels?.[o] ?? o}</option>)}
                    </select>
                  </label>
                ))}
                {Object.values(cols).some(Boolean) && (
                  <button className="ghost" onClick={() => setCols({})}>Limpiar filtros</button>
                )}
              </div>
            )}

            <FilterNote filters={data.filters} cols={cols} />

            <Stats s={data.stats} unit={data.stats_unit} />

            {data.actions?.length > 0 && data.total > 0 && (
              <div className="bulk-actions">{data.actions.map(botonAccion)}</div>
            )}

            <div className="tabs">
              <button className={tab === 'grafico' ? 'on' : ''} onClick={() => setTab('grafico')}>Gráficos</button>
              <button className={tab === 'tabla' ? 'on' : ''} onClick={() => setTab('tabla')}>
                Tabla ({Math.min(data.rows.length, data.row_limit)})
              </button>
            </div>

            {tab === 'grafico' ? (
              <>
                <div className="chips">
                  {data.charts.map((c) => (
                    <button key={c.id} className={chart?.id === c.id ? 'on' : ''}
                      onClick={() => setChartId(c.id)}>{c.label}</button>
                  ))}
                </div>
                {/* Clic en una barra = filtrar por ese valor, si esa dimensión
                    es filtrable. Evita tener que buscarla en el desplegable. */}
                {chart && <Chart chart={chart} tint={trazo} cat={cat} colorFor={paletas.current.get(pkey)}
                  onPick={data.filters?.some((f) => f.key === chart.id)
                    ? (label) => setCols({ ...cols, [chart.id]: label })
                    : undefined} />}
              </>
            ) : (
              <div className="scroll-x">
                <table className="plain">
                  <thead>
                    <tr>
                      {data.columns.map((c) => (
                        <th key={c.key} className={c.type === 'money' || c.type === 'num' ? 'n' : ''}>{c.label}</th>
                      ))}
                      {hayAcciones && <th />}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r, i) => (
                      <Fragment key={i}>
                        <tr>
                          {data.columns.map((c) => (
                            <td key={c.key} className={c.type === 'money' || c.type === 'num' ? 'n' : ''}>
                              {(fmt[c.type] ?? fmt.text)(r[c.key])}
                            </td>
                          ))}
                          {hayAcciones && (
                            <td>
                              <div className="row-actions">
                                {(r.copy || r.reconcile) && (
                                  <button className="btn btn-outline btn-sm"
                                    onClick={() => setAbierta(abierta === i ? null : i)}>
                                    {abierta === i ? 'Ocultar' : r.reconcile ? 'Conciliar' : 'Comando'}
                                  </button>
                                )}
                                {r.actions?.map(botonAccion)}
                              </div>
                            </td>
                          )}
                        </tr>
                        {abierta === i && (r.copy || r.reconcile) && (
                          <tr className="row-copy">
                            <td colSpan={data.columns.length + 1}>
                              {r.copy && (
                                <>
                                  <pre>{r.copy}</pre>
                                  <button className="btn btn-primary btn-sm" onClick={() => copiar(i, r.copy)}>
                                    {copiada === i ? 'Copiado' : 'Copiar comando'}
                                  </button>
                                </>
                              )}
                              {r.reconcile && <Reconcile pt={r.reconcile} onApplied={onChanged} onNotify={notify} />}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
                {data.total > data.rows.length && (
                  <p className="empty">Mostrando {data.rows.length} de {num(data.total)}. Acota el rango para ver el resto.</p>
                )}
              </div>
            )}
          </>
        )}
      </aside>
      <Toasts items={toasts} dismiss={dismiss} />
    </div>
  )
}
