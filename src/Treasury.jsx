/** Tesorería: la garantía (escrow) de cada tienda en la red, vía wallet.
 *
 * Es el único dinero real que custodia la plataforma. El superusuario registra
 * los depósitos que ya llegaron al banco y paga o rechaza retiros DESPUÉS de
 * hacer (o descartar) la transferencia. Todo pasa por business
 * (`/admin/dashboard/api/treasury/*` y `api/action/*`), nunca directo a wallet.
 *
 * Las tiendas del selector son `data.stores` del panel: respetan el ámbito
 * (customer/ciudad) que ya esté puesto arriba.
 */
import { useCallback, useEffect, useState } from 'react'
import { action, money } from './api'
import { useBackdropClose } from './components'

async function get(url) {
  const r = await fetch(url, { credentials: 'same-origin' })
  const d = await r.json().catch(() => ({}))
  if (!r.ok || d.ok === false) throw new Error(d.error ?? `HTTP ${r.status}`)
  return d
}

const when = (iso) => (iso
  ? new Date(iso).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' })
  : '—')

// Los rechazos que business no traduce llegan con el cuerpo crudo de wallet.
const humanize = (msg) => {
  if (/WITHDRAWALS_DISABLED/.test(msg)) {
    return 'Los retiros están apagados en wallet (TREASURY_WITHDRAWALS_ENABLED). No se puede pagar ninguno por ahora.'
  }
  if (/INSUFFICIENT_SCOPES/.test(msg)) {
    return 'Wallet no le concede a business el scope platform:admin (ApiClient.scopes de cafeteria-business).'
  }
  return msg
}
// Única respuesta que significa "aún no hay garantía": la del 404 de wallet.
const notInNetwork = (msg) => /no está en la red/.test(msg)

/** Monto en pesos tecleado como se lee en Colombia: el punto agrupa miles y la
 *  coma separa centavos. Se guarda solo lo tecleado y se envía con punto
 *  decimal: «100.000» nunca puede llegar a wallet como cien pesos. */
function MoneyInput({ value, onChange, ...p }) {
  const [int = '', dec] = value.split(',')
  const shown = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (dec !== undefined ? `,${dec}` : '')
  const change = (e) => {
    const [i = '', ...rest] = e.target.value.replace(/[^\d,]/g, '').split(',')
    onChange(i.replace(/^0+(?=\d)/, '') + (rest.length ? `,${rest.join('').slice(0, 2)}` : ''))
  }
  return (
    <div className="tz-money">
      <span>$</span>
      <input inputMode="decimal" autoComplete="off" value={shown} onChange={change} {...p} />
    </div>
  )
}
const toApi = (v) => v.replace(',', '.')

const STATUS = {
  REQUESTED: ['Solicitado', 'req'], PAID: ['Pagado', 'paid'], REJECTED: ['Rechazado', 'rej'],
}
const Pill = ({ s }) => {
  const [label, tone] = STATUS[s] ?? [s, '']
  return <span className={`tz-pill ${tone}`}>{label}</span>
}

function Toasts({ items, dismiss }) {
  return (
    <div className="tz-toasts" aria-live="polite" onClick={(e) => e.stopPropagation()}>
      {items.map((t) => (
        <div key={t.id} className={`tz-toast ${t.bad ? 'bad' : 'ok'}`} role="status">
          <span className="tz-toast-dot" />
          <p>{t.text}</p>
          <button onClick={() => dismiss(t.id)} title="Cerrar">×</button>
        </div>
      ))}
    </div>
  )
}

/** Cómo se reparte el dinero de la tienda. Cada tramo lleva su cifra visible:
 *  el tooltip no es el único lugar del dato. */
function Composition({ t, cat }) {
  const available = Number(t.available_balance)
  const floor = Math.min(Number(t.min_escrow_amount), available)
  const withdrawable = Number(t.withdrawable_amount)
  const parts = [
    ['Retirable', withdrawable, cat[2]],
    ['Garantía mínima', t.exit_completed ? 0 : floor, cat[0]],
    ['No retirable por ahora', Math.max(0, available - withdrawable - (t.exit_completed ? 0 : floor)), cat[4]],
    ['Reservado', Number(t.reserved_amount), cat[1]],
    ['En retiro', Number(t.withdrawal_hold), cat[3]],
  ]
  const total = parts.reduce((s, p) => s + p[1], 0)
  if (!total) return <p className="empty">La tienda no tiene saldo en la red todavía.</p>
  return (
    <>
      <div className="tz-bar" role="img" aria-label="Composición del saldo">
        {parts.filter((p) => p[1] > 0).map(([label, v, c]) => (
          <span key={label} style={{ flexGrow: v, background: c }} title={`${label}: ${money(v)}`} />
        ))}
      </div>
      <ul className="tz-legend">
        {parts.map(([label, v, c]) => (
          <li key={label} className={v ? '' : 'zero'}>
            <i style={{ background: c }} />{label}<b>{money(v)}</b>
          </li>
        ))}
      </ul>
    </>
  )
}

function Network({ t }) {
  if (t.is_open_network) return <span className="tz-net open"><i />Red abierta</span>
  if (t.exit_completed) return <span className="tz-net done"><i />Salida cumplida · se puede devolver la garantía</span>
  return <span className="tz-net closed"><i />Red cerrada desde {when(t.network_closed_at)}</span>
}

function StoreTab({ storeId, storeName, cat, notify }) {
  const [t, setT] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const [amount, setAmount] = useState('')
  const [ref, setRef] = useState('')
  const [confirm, setConfirm] = useState('')

  const load = useCallback(() => {
    setT(null); setErr(null)
    if (storeId) get(`/admin/dashboard/api/treasury/store/${storeId}/`).then((d) => setT(d.treasury), (e) => setErr(e.message))
  }, [storeId])
  useEffect(load, [load])

  const run = (name, body, done) => {
    setBusy(true)
    action(name, body)
      .then((d) => { notify(d.message); done?.(); load() })
      .catch((e) => notify(humanize(e.message), true))
      .finally(() => setBusy(false))
  }

  const deposit = (e) => {
    e.preventDefault()
    run('escrow_deposit', { store: storeId, amount: toApi(amount), bank_reference: ref.trim() },
      () => { setAmount(''); setRef('') })
  }

  if (!storeId) return <p className="empty">No hay tiendas en el ámbito elegido.</p>

  return (
    <div className="tz-grid">
      {err ? (
        <div className={`tz-hero tz-empty ${notInNetwork(err) ? '' : 'bad'}`}>
          <div className="tz-empty-icon">{notInNetwork(err) ? '$' : '!'}</div>
          <div>
            <b>{notInNetwork(err) ? 'Esta tienda aún no tiene garantía en la red' : 'No se pudo leer la tesorería'}</b>
            <p>{notInNetwork(err)
              ? 'Cuando llegue el primer depósito de garantía al banco, regístralo aquí abajo: eso abre la red de la tienda.'
              : humanize(err)}</p>
          </div>
        </div>
      ) : !t ? (
        <div className="tz-hero sk" />
      ) : (
        <div className="tz-hero">
          <div className="tz-hero-top">
            <span className="tz-kicker">Retirable ahora</span>
            <span className="tz-badges">
              {t.withdrawals_enabled === false && <span className="tz-net off"><i />Retiros apagados</span>}
              <Network t={t} />
            </span>
          </div>
          <div className="tz-big">{money(t.withdrawable_amount)}</div>
          <p className="tz-hero-sub">
            de {money(t.available_balance)} disponibles · lo ganado se libera a los {t.refund_window_days + 1} días
          </p>
          <Composition t={t} cat={cat} />
        </div>
      )}

      <form className="tz-card" onSubmit={deposit}>
        <h3>Registrar depósito de garantía</h3>
        <p className="tz-help">Solo cuando el dinero ya esté en el banco. Repetir la misma referencia no lo duplica.</p>
        <label>Monto<MoneyInput value={amount} onChange={setAmount} placeholder="0" required /></label>
        <label>Referencia bancaria
          <input value={ref} onChange={(e) => setRef(e.target.value)} maxLength={100} required
            placeholder="Nº de la transacción" />
        </label>
        <button className="tz-primary" disabled={busy || !Number(toApi(amount)) || !ref.trim()}>
          {Number(toApi(amount)) ? `Registrar ${money(toApi(amount))}` : 'Registrar depósito'}
        </button>
      </form>

      {t?.is_open_network && (
        <form className="tz-card danger" onSubmit={(e) => {
          e.preventDefault()
          run('close_network', { store: storeId }, () => setConfirm(''))
        }}>
          <h3>Sacar la tienda de la red</h3>
          <p className="tz-help">
            No se reabre desde aquí. La tienda sigue viendo su tesorería y la garantía se puede
            devolver pasados {t.refund_window_days} días sin reservas ni liquidaciones pendientes.
          </p>
          <label><span>Escribe <b>{storeName}</b> para confirmar</span>
            <input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
          </label>
          <button className="tz-danger" disabled={busy || confirm.trim() !== storeName}>Cerrar red</button>
        </form>
      )}
    </div>
  )
}

function Withdrawal({ w, storeName, onDone, notify }) {
  const [mode, setMode] = useState(null)
  const [text, setText] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const acc = w.bank_account ?? {}

  const submit = (e) => {
    e.preventDefault()
    setBusy(true)
    const [name, body] = mode === 'pay'
      ? ['pay_withdrawal', { withdrawal: w.withdrawal_id, bank_reference: text.trim() }]
      : ['reject_withdrawal', { withdrawal: w.withdrawal_id, reason: text.trim() }]
    action(name, body)
      .then((d) => { notify(d.message); onDone() })
      .catch((e2) => { notify(humanize(e2.message), true); if (/pendiente/.test(e2.message)) onDone() })
      .finally(() => setBusy(false))
  }

  return (
    <li className="tz-w">
      <div className="tz-w-main">
        <div>
          <div className="tz-w-amount">{money(w.amount)}</div>
          <div className="tz-w-store">{storeName}</div>
        </div>
        <div className="tz-w-bank">
          <b>{acc.bank_name ?? '—'}</b> · {acc.account_type ?? ''} · {acc.account_number ?? ''}
          <span>NIT {acc.holder_nit ?? '—'}</span>
        </div>
        <div className="tz-w-side">
          <Pill s={w.status} />
          <span className="tz-w-date">{when(w.created_at)}</span>
        </div>
      </div>
      {w.status === 'PAID' && <p className="tz-w-note">Pagado {when(w.paid_at)} · ref. {w.bank_reference}</p>}
      {w.status === 'REJECTED' && <p className="tz-w-note">Rechazado {when(w.rejected_at)} · {w.reason}</p>}
      {w.status === 'REQUESTED' && !mode && (
        <div className="tz-w-actions">
          {/* `can_pay` viene de wallet (TREASURY_WITHDRAWALS_ENABLED). Rechazar
              sigue disponible: devolver el hold a la tienda nunca es riesgoso. */}
          <button className="tz-primary" onClick={() => setMode('pay')} disabled={w.can_pay === false}
            title={w.can_pay === false ? 'Los retiros están apagados en wallet' : undefined}>Pagar</button>
          <button className="ghost" onClick={() => setMode('reject')}>Rechazar</button>
          {w.can_pay === false && <span className="tz-off">Pagos apagados en wallet</span>}
        </div>
      )}
      {mode && (
        <form className="tz-w-form" onSubmit={submit}>
          {mode === 'pay' ? (
            <>
              <input autoFocus value={text} onChange={(e) => setText(e.target.value)} maxLength={100}
                placeholder="Referencia de la transferencia hecha" required />
              <label className="tz-check">
                <input type="checkbox" checked={sent} onChange={(e) => setSent(e.target.checked)} />
                Ya transferí {money(w.amount)} a esta cuenta
              </label>
            </>
          ) : (
            <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} maxLength={500}
              rows={2} placeholder="Motivo del rechazo (lo verá la tienda)" required />
          )}
          <div className="tz-w-actions">
            <button className={mode === 'pay' ? 'tz-primary' : 'tz-danger'}
              disabled={busy || !text.trim() || (mode === 'pay' && !sent)}>
              {mode === 'pay' ? 'Marcar como pagado' : 'Rechazar retiro'}
            </button>
            <button type="button" className="ghost" onClick={() => { setMode(null); setText(''); setSent(false) }}>
              Cancelar
            </button>
          </div>
        </form>
      )}
    </li>
  )
}

const FILTERS = [['REQUESTED', 'Solicitados'], ['PAID', 'Pagados'], ['REJECTED', 'Rechazados'], ['', 'Todos']]

function WithdrawalsTab({ storeId, names, notify, onCount }) {
  const [status, setStatus] = useState('REQUESTED')
  const [only, setOnly] = useState(false)
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState(null)

  const load = useCallback(() => {
    setErr(null)
    const q = new URLSearchParams({ status })
    if (only && storeId) q.set('store', storeId)
    get(`/admin/dashboard/api/treasury/withdrawals/?${q}`).then((d) => {
      setRows(d.withdrawals)
      if (status === 'REQUESTED' && !only) onCount(d.withdrawals.length)
    }, (e) => setErr(e.message))
  }, [status, only, storeId, onCount])
  useEffect(load, [load])

  return (
    <>
      <div className="tz-toolbar">
        <div className="tz-seg" role="tablist">
          {FILTERS.map(([v, l]) => (
            <button key={l} role="tab" aria-selected={status === v} className={status === v ? 'on' : ''}
              onClick={() => { setRows(null); setStatus(v) }}>{l}</button>
          ))}
        </div>
        <label className="tz-switch">
          <input type="checkbox" checked={only} onChange={(e) => setOnly(e.target.checked)} disabled={!storeId} />
          <span />Solo la tienda elegida
        </label>
      </div>
      {err ? <p className="error">{humanize(err)}</p>
        : !rows ? <div className="tz-hero sk short" />
        : !rows.length ? <p className="empty">No hay retiros {status ? FILTERS.find((f) => f[0] === status)[1].toLowerCase() : ''}.</p>
        : (
          <ul className="tz-list">
            {rows.map((w) => (
              <Withdrawal key={w.withdrawal_id} w={w} notify={notify} onDone={load}
                storeName={names[w.store_id] ?? `Tienda ${String(w.store_id).slice(0, 8)}`} />
            ))}
          </ul>
        )}
    </>
  )
}

export default function Treasury({ stores, store, cat, onClose }) {
  const [tab, setTab] = useState('store')
  const [storeId, setStoreId] = useState(store || stores[0]?.id || '')
  const [pending, setPending] = useState(null)
  const [toasts, setToasts] = useState([])
  const names = Object.fromEntries(stores.map((s) => [s.id, s.name]))
  const backdrop = useBackdropClose(onClose)

  const dismiss = useCallback((id) => setToasts((ts) => ts.filter((t) => t.id !== id)), [])
  const notify = useCallback((text, bad = false) => {
    const id = Math.random()
    setToasts((ts) => [...ts, { id, text, bad }])
    setTimeout(() => dismiss(id), bad ? 9000 : 5000)
  }, [dismiss])

  useEffect(() => {
    get('/admin/dashboard/api/treasury/withdrawals/?status=REQUESTED')
      .then((d) => setPending(d.withdrawals.length), () => {})
  }, [])

  useEffect(() => {
    const onEsc = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [onClose])

  return (
    <div className="drawer-backdrop" {...backdrop}>
      <div className="drawer tz" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Tesorería</h2>
          <button className="ghost" onClick={onClose} title="Cerrar">×</button>
        </header>
        <p className="drawer-meta">
          Garantía de las tiendas en la red · cada acción mueve dinero real en wallet y queda en AuditLog
        </p>
        <div className="tz-head">
          <div className="tabs">
            <button className={tab === 'store' ? 'on' : ''} onClick={() => setTab('store')}>Tienda</button>
            <button className={tab === 'w' ? 'on' : ''} onClick={() => setTab('w')}>
              Retiros{pending ? <span className="tz-count">{pending}</span> : null}
            </button>
          </div>
          <select className="tz-store" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        {tab === 'store'
          ? <StoreTab key={storeId} storeId={storeId} storeName={names[storeId] ?? ''} cat={cat} notify={notify} />
          : <WithdrawalsTab storeId={storeId} names={names} notify={notify} onCount={setPending} />}
      </div>
      <Toasts items={toasts} dismiss={dismiss} />
    </div>
  )
}
