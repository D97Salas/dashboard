/** Comisiones: la tasa que la plataforma le cobra a una tienda por cada tipo de venta.
 *
 * Wallet es el dueño de las tasas (`StoreCommissionRate`): aquí solo se leen
 * (`api/cartera/rates/`) y se crean (`commission_rate`). Tres reglas de wallet
 * que la pantalla tiene que hacer visibles:
 *  - Sin tasa vigente, wallet cobra ese tipo a 0 % (`DEFAULT_RATE`). No es un
 *    dato normal: la tienda vende sin pagar comisión.
 *  - Una tasa nunca se edita ni se borra: cambiarla es crear otra que cierra la anterior.
 *  - La nueva tiene que empezar DESPUÉS de cualquier otra del mismo tipo. Una
 *    programada por error rige hasta que empiece la corrección.
 */
import { useCallback, useEffect, useState } from 'react'
import { action, API_BASE, getJson, when } from './api'

// Los de wallet (CommissionOperationType), en su orden.
const TYPES = [
  ['SALE_SAME_STORE', 'Venta en la tienda de la wallet'],
  ['SALE_CROSS_STORE', 'Venta en otra tienda de la red'],
  ['SALE_GROUP_WALLET', 'Venta pagada por vaca'],
  ['SALE_CASH', 'Venta en efectivo'],
  ['NETWORK_SETTLEMENT', 'Compensación de red',
    'No es una venta: la paga la tienda deudora de una liquidación de red, de su garantía.'],
]
const LABEL = Object.fromEntries(TYPES)

// Wallet guarda una FRACCIÓN (0.0350); aquí se lee y se escribe en porcentaje.
const asPct = (r) => `${(Number(r) * 100).toLocaleString('es-CO', { maximumFractionDigits: 2 })} %`
const pctNum = (v) => (v === '' ? NaN : Number(v.replace(',', '.')))
const toFraction = (p) => (p / 100).toFixed(4)

/** Porcentaje con coma decimal, hasta 2 decimales. Quien escribe «3» quiere decir
 *  3 %, no 300 %: por eso no se pide la fracción que guarda wallet. */
function PercentInput({ value, onChange, ...p }) {
  const change = (e) => {
    const [i = '', ...rest] = e.target.value.replace(/[^\d,]/g, '').split(',')
    onChange(i.replace(/^0+(?=\d)/, '').slice(0, 3) + (rest.length ? `,${rest.join('').slice(0, 2)}` : ''))
  }
  return (
    <div className="tz-money">
      <input inputMode="decimal" autoComplete="off" value={value} onChange={change} {...p} />
      <span className="cm-unit">%</span>
    </div>
  )
}

/** Vigente, próxima programada y la fecha de la última, por tipo. */
function classify(rows, now) {
  const out = {}
  for (const [op] of TYPES) {
    const mine = rows.filter((r) => r.operation_type === op)
    const from = (r) => new Date(r.effective_from)
    out[op] = {
      current: mine.find((r) => from(r) <= now && (!r.effective_to || new Date(r.effective_to) > now)),
      next: mine.filter((r) => from(r) > now).sort((a, b) => from(a) - from(b))[0],
      latest: mine.reduce((m, r) => (from(r) > m ? from(r) : m), new Date(0)),
    }
  }
  return out
}

function RateForm({ op, info, storeId, storeName, notify, onDone, onCancel }) {
  const [pct, setPct] = useState('')
  const [mode, setMode] = useState(info.next ? 'later' : 'now')
  const [at, setAt] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const p = pctNum(pct)
  const start = mode === 'now' ? new Date() : at ? new Date(at) : null
  const missing = Number.isNaN(p) ? 'Falta el porcentaje'
    : p > 100 ? 'El porcentaje va de 0 a 100'
    : !start ? 'Falta la fecha'
    : mode === 'later' && start <= new Date() ? 'La fecha ya pasó'
    : start <= info.latest ? `Debe empezar después del ${when(info.latest.toISOString())}`
    : !reason.trim() ? 'Falta el motivo'
    : null

  const before = info.current ? asPct(info.current.rate) : 'sin tasa (0 %)'
  const summary = `${LABEL[op]} de ${storeName}: ${before} → ${pct || '…'} % `
    + (mode === 'now' ? 'desde ahora' : `desde el ${at ? when(new Date(at).toISOString()) : '…'}`)

  const submit = (e) => {
    e.preventDefault()
    if (missing) return
    // Confirmar todo haría que la confirmación dejara de leerse: solo lo que no tiene vuelta
    // atrás (una programada no se puede borrar) o un salto grande.
    const jump = info.current && p > Number(info.current.rate) * 100 * 2
    if ((mode === 'later' || jump) && !window.confirm(
      `${summary}.\n\n${mode === 'later'
        ? 'Una tasa programada no se puede borrar: si te equivocas, la corrección solo puede empezar después de esta.'
        : 'La tasa nueva es más del doble de la vigente.'}\n\n¿Continuar?`)) return
    setBusy(true)
    action('commission_rate', {
      store: storeId, operation_type: op, rate: toFraction(p),
      effective_from: start.toISOString(), reason: reason.trim(),
    })
      .then((d) => { notify(d.message); onDone() })
      .catch((err) => notify(err.message, true))
      .finally(() => setBusy(false))
  }

  return (
    <form className="tz-card cm-form" onSubmit={submit}>
      <h3>{info.current ? 'Cambiar' : 'Fijar'} tasa: {LABEL[op]}</h3>
      <div className="cm-row">
        <label>Porcentaje<PercentInput autoFocus value={pct} onChange={setPct} placeholder="0" /></label>
        <div className="cm-when">
          <span className="cm-lbl">Desde</span>
          <div className="tz-seg" role="tablist">
            <button type="button" role="tab" aria-selected={mode === 'now'} className={mode === 'now' ? 'on' : ''}
              disabled={!!info.next} title={info.next ? 'Ya hay una programada: la nueva tiene que empezar después' : undefined}
              onClick={() => setMode('now')}>Ahora</button>
            <button type="button" role="tab" aria-selected={mode === 'later'} className={mode === 'later' ? 'on' : ''}
              onClick={() => setMode('later')}>Programar</button>
          </div>
          {mode === 'later' && <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />}
        </div>
      </div>
      <label>Motivo
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={255} rows={2}
          placeholder="Contrato, acuerdo comercial, corrección…" />
      </label>
      <p className="cm-summary">{summary}</p>
      {mode === 'later' && (
        <p className="tz-help">Una tasa programada no se puede borrar: si te equivocas, la corrección solo puede empezar después de esta.</p>
      )}
      <div className="tz-w-actions">
        <button className="btn btn-primary" disabled={busy || !!missing}>
          {missing ?? `Fijar ${pct} %`}
        </button>
        <button type="button" className="ghost" onClick={onCancel}>Cancelar</button>
      </div>
    </form>
  )
}

export default function Commissions({ storeId, storeName, notify }) {
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState(null)
  const [open, setOpen] = useState(null)

  const load = useCallback(() => {
    setErr(null)
    if (storeId) getJson(`${API_BASE}api/cartera/rates/?store=${storeId}`).then((d) => setRows(d.data ?? []), (e) => setErr(e.message))
  }, [storeId])
  useEffect(load, [load])

  if (!storeId) return <p className="empty">No hay tiendas en el ámbito elegido.</p>
  // «sin datos» no es «sin tasas»: una tabla vacía diría que la tienda vende a 0 %.
  if (err) return <p className="error">{err === 'sin datos' ? 'Sin datos: wallet no respondió. No se puede saber qué tasas tiene la tienda.' : err}</p>
  if (!rows) return <div className="tz-hero sk short" />

  const now = new Date()
  const info = classify(rows, now)
  const sinTasa = TYPES.slice(0, 4).filter(([op]) => !info[op].current).length

  return (
    <div className="cm">
      {sinTasa > 0 && (
        <p className="cm-warn">
          {sinTasa} tipo(s) de venta sin tasa: wallet los cobra a 0 %, así que la tienda vende sin pagar comisión.
        </p>
      )}
      <table className="plain">
        <thead>
          <tr><th>Tipo</th><th className="n">Vigente</th><th>Desde</th><th>Programada</th><th /></tr>
        </thead>
        <tbody>
          {TYPES.map(([op, label, note]) => {
            const { current, next } = info[op]
            return (
              <tr key={op}>
                <td>{label}{note && <span className="cm-note">{note}</span>}</td>
                <td className={`n ${current ? '' : 'cm-missing'}`}>{current ? asPct(current.rate) : 'Sin tasa: 0 %'}</td>
                <td>{current ? when(current.effective_from) : '—'}</td>
                <td>{next ? `${asPct(next.rate)} desde ${when(next.effective_from)}` : '—'}</td>
                <td className="n">
                  <button className="btn btn-outline btn-sm" onClick={() => setOpen(open === op ? null : op)}>
                    {current ? 'Cambiar' : 'Fijar'}
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {open && (
        <RateForm key={open} op={open} info={info[open]} storeId={storeId} storeName={storeName} notify={notify}
          onDone={() => { setOpen(null); load() }} onCancel={() => setOpen(null)} />
      )}

      <details className="cm-history">
        <summary>Historial ({rows.length})</summary>
        {rows.length ? (
          <table className="plain">
            <thead>
              <tr><th>Tipo</th><th className="n">Tasa</th><th>Desde</th><th>Hasta</th><th>Motivo</th><th>Quién</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{LABEL[r.operation_type] ?? r.operation_type}{r.in_use && <span className="cm-note">ya se cobraron ventas con ella</span>}</td>
                  <td className="n">{asPct(r.rate)}</td>
                  <td>{when(r.effective_from)}</td>
                  <td>{r.effective_to ? when(r.effective_to) : 'vigente'}</td>
                  <td>{r.reason || '—'}</td>
                  <td className="cm-who">{r.created_by || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="empty">Esta tienda nunca ha tenido tasa.</p>}
      </details>
    </div>
  )
}
