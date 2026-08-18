import { useCallback, useEffect, useState } from 'react'

/** El peso no lleva centavos, PERO un monto chico que sí los tiene deja de ser
 *  cierto al redondearlo: una comisión de 0,32 se dibujaba «$0», y el total de
 *  0,52 «$1» — tres filas en cero que sumaban uno. El panel se contradecía solo
 *  aunque la base estuviera bien.
 *
 *  Los decimales aparecen solo cuando cargan información: hay parte fraccional y
 *  el monto es lo bastante chico como para que esa parte pese. En $203.417,15 el
 *  ,15 es ruido; en $0,32 es el dato entero. */
const decimales = (n) => (!Number.isInteger(n) && Math.abs(n) < 1000 ? 2 : 0)

export const money = (v) => {
  const n = Number(v ?? 0)
  const d = decimales(n)
  return new Intl.NumberFormat('es-CO', {
    style: 'currency', currency: 'COP',
    minimumFractionDigits: d, maximumFractionDigits: d,
  }).format(n)
}

/** Compacta para ejes y KPIs grandes: 203417 → $203 K */
export const moneyShort = (v) => {
  const n = Number(v ?? 0)
  // Por debajo de mil no hay nada que compactar y `compact` sí redondea: 0,52
  // salía «$0,5». Ahí manda `money`, que ya decide los decimales.
  if (Math.abs(n) < 1000) return money(n)
  return new Intl.NumberFormat('es-CO', {
    style: 'currency', currency: 'COP', notation: 'compact', maximumFractionDigits: 1,
  }).format(n)
}

export const num = (v) => new Intl.NumberFormat('es-CO').format(Number(v ?? 0))

export const pct = (v) => `${Number(v ?? 0).toFixed(Number(v) < 10 ? 1 : 0)}%`

/** Segundos → duración legible. Nunca "254 s": a partir del minuto el lector
 *  tiene que dividir mentalmente, y ahí es donde se malinterpreta un tiempo. */
export const dur = (v) => {
  if (v == null) return '—'
  const s = Math.round(Number(v))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} m ${String(s % 60).padStart(2, '0')} s`
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m`
}

export function useMetrics() {
  // Vacío = histórico completo. El backend resuelve el rango real y lo devuelve
  // en `filters`; los inputs se sincronizan con eso en la primera carga.
  const [filters, setFilters] = useState({ desde: '', hasta: '', city: '', store: '' })
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    setLoading(true)
    setError(null)
    const qs = new URLSearchParams(filters)
    const startTime = performance.now()
    fetch(`/admin/dashboard/api/metrics/?${qs}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        const endTime = performance.now()
        console.log(`Filtro aplicado en ${(endTime - startTime).toFixed(0)}ms`, filters)
        setData(d)
        setFilters((f) => (f.desde && f.hasta ? f : { ...f, ...d.filters }))
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [filters, tick])

  // `tick` sale afuera para que el cajón de detalle también se recargue: sus
  // datos son de otra petición, y si no, refrescar dejaba el panel al día y el
  // cajón abierto mostrando cifras viejas.
  return { data, error, loading, filters, setFilters, tick,
           refresh: useCallback(() => setTick((t) => t + 1), []) }
}

/** Filtro de texto del buscador. Client-side: los paneles ya vienen recortados
 *  a 15 filas, no vale la pena un round-trip. */
export const filterRows = (rows, q, ...fields) => {
  if (!q) return rows
  const start = performance.now()
  const result = rows.filter((r) => fields.some((f) => String(r[f] ?? '').toLowerCase().includes(q.toLowerCase())))
  const end = performance.now()
  if (end - start > 10) {
    console.log(`filterRows tomó ${(end - start).toFixed(2)}ms para ${rows.length} filas con query "${q}"`)
  }
  return result
}
