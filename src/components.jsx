import { useEffect, useState } from 'react'
import { money, num, pct } from './api'
import { inkOn } from './palette'

/* Iconos inline: 5 glifos no justifican una librería. */
const Icon = ({ d, ...p }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" width="16" height="16" {...p}>
    {d}
  </svg>
)
export const IconSearch = () => <Icon d={<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>} />
export const IconRefresh = () => <Icon d={<><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3v6h-6" /></>} />
export const IconBack = () => <Icon d={<path d="M19 12H5m0 0 6-6m-6 6 6 6" />} />
export const IconSun = () => <Icon d={<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>} />
export const IconMoon = () => <Icon d={<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />} />

export function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem('fud-theme') || 'light')
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('fud-theme', theme)
  }, [theme])
  return [theme, () => setTheme((t) => (t === 'light' ? 'dark' : 'light'))]
}

/** Variación vs el período anterior. `null` = no había con qué comparar; se
 *  dice, no se dibuja un 0% que parecería "sin cambios". */
export function Delta({ value, muted }) {
  if (value == null) return <span className="delta none">sin base previa</span>
  const dir = value > 0 ? 'up' : value < 0 ? 'down' : 'flat'
  return (
    <span className={`delta ${muted ? 'muted' : dir}`}>
      {value > 0 ? '▲' : value < 0 ? '▼' : '='} {Math.abs(value)}%
    </span>
  )
}

/** Con `onOpen` la tarjeta es un botón real (foco, Enter, lector de pantalla),
 *  no un <div> con onClick. */
export function Card({ label, value, sub, tone, hero, delta, deltaMuted, onOpen }) {
  const cls = `card ${tone ?? ''} ${hero ? 'hero' : ''} ${onOpen ? 'clickable' : ''}`
  const body = (
    <>
      <span className="card-label">{label}{onOpen && <span className="chev">›</span>}</span>
      <strong className="card-value">{value}</strong>
      {delta !== undefined && <Delta value={delta} muted={deltaMuted} />}
      {sub && <span className="card-sub">{sub}</span>}
    </>
  )
  return onOpen
    ? <button type="button" className={cls} onClick={onOpen} title={`Ver detalle de ${label}`}>{body}</button>
    : <div className={cls}>{body}</div>
}

/** Agrupador visual de paneles. Sin estado ni plegado: con quince paneles el
 *  problema es *encontrarlos*, y para eso basta un encabezado y un ancla. */
export function Section({ id, title, sub, children }) {
  return (
    <section className="sect" id={id}>
      <h2 className="sect-title">{title}{sub && <small>{sub}</small>}</h2>
      {children}
    </section>
  )
}

export function Panel({ title, sub, children, wide, onOpen }) {
  return (
    <section className={`panel ${wide ? 'wide' : ''}`}>
      <h2>
        {onOpen
          ? <button type="button" className="panel-open" onClick={onOpen}>{title} <span className="chev">›</span></button>
          : title}
        {sub && <small>{sub}</small>}
      </h2>
      {children}
    </section>
  )
}

/** Ranking por magnitud: barra + valor exacto SIEMPRE visible (nunca detrás de
 *  un tooltip). Sin `colors` es una sola serie ⇒ un solo tono; con `colors` el
 *  color significa estado (bueno/malo), no magnitud — el largo ya la codifica.
 *
 *  Va en HTML plano a propósito: Recharts colapsa los rectángulos en
 *  contenedores bajos y su LabelList no sobrevive junto a los <Cell>. */
export function BarTable({ rows, label, value, format = money, extra, colors, onRow }) {
  const max = Math.max(...rows.map((r) => Number(r[value]) || 0), 1)
  if (!rows.length) return <p className="empty">Sin datos</p>
  return (
    <table className={`bars ${onRow ? 'pickable' : ''}`}>
      <tbody>
        {rows.map((r, i) => {
          const tint = colors?.(r[label], i)
          const pick = onRow && (() => onRow(r[label], r))
          return (
            <tr key={i} onClick={pick} tabIndex={pick ? 0 : undefined}
              role={pick ? 'button' : undefined}
              onKeyDown={pick ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pick()) : undefined}
              title={pick ? `Ver detalle de ${r[label]}` : undefined}>
              <td className="bar-cell">
                <span className="bar" style={{
                  width: `${(Number(r[value]) / max) * 100}%`,
                  background: tint && `color-mix(in srgb, ${tint} 30%, transparent)`,
                }} />
                {tint && <span className="dot" style={{ background: tint }} />}
                <span className="bar-label">{r[label] ?? '—'}</span>
              </td>
              {extra != null && <td className="n">{num(r[extra])}</td>}
              <td className="n strong">{format(r[value])}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/** Parte-de-un-todo: barra apilada al 100%. Separación por hueco de 2px del
 *  color de la superficie, nunca por borde. La leyenda lleva los valores
 *  exactos, así el porcentaje dentro del segmento puede omitirse si no cabe. */
export function StackedBar({ rows, label, value, colors, format = num }) {
  const total = rows.reduce((s, r) => s + Number(r[value] || 0), 0)
  if (!total) return <p className="empty">Sin datos</p>
  const share = (r) => (Number(r[value]) / total) * 100

  return (
    <div className="stack-wrap">
      <div className="stack" role="img" aria-label={rows.map((r) => `${r[label]} ${pct(share(r))}`).join(', ')}>
        {rows.map((r, i) => {
          const p = share(r)
          const fill = colors(r[label], i)
          return (
            <span key={i} className="seg" style={{ flexBasis: `${p}%`, background: fill }}
              title={`${r[label]}: ${format(r[value])} (${pct(p)})`}>
              {p >= 11 && <em style={{ color: inkOn(fill) }}>{pct(p)}</em>}
            </span>
          )
        })}
      </div>
      <ul className="legend">
        {rows.map((r, i) => (
          <li key={i}>
            <span className="dot" style={{ background: colors(r[label], i) }} />
            <span className="key">{r[label] ?? '—'}</span>
            <span className="n strong">{format(r[value])}</span>
            <span className="n">{pct(share(r))}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

const PRESETS = [['todo', 'Todo'], [7, '7d'], [30, '30d'], [90, '90d'], [365, '1a']]

/** Formatea sin pasar por UTC. `toISOString()` convierte a UTC y en Colombia
 *  (UTC-5) devolvería el día siguiente después de las 7pm. */
const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Resta días a una fecha ISO tratándola como local (el sufijo sin `Z` evita
 *  que el navegador la interprete como UTC y retroceda un día). */
const minusDays = (isoDate, n) => {
  const d = new Date(`${isoDate}T00:00:00`)
  d.setDate(d.getDate() - n)
  return iso(d)
}

export function TopBar({ filters, setFilters, cities, stores, range, suggestions, q, setQ, onRefresh, loading, theme, toggleTheme, sections = [] }) {
  const set = (k) => (e) => setFilters({ ...filters, [k]: e.target.value })
  // Cambiar de ciudad limpia la tienda: la anterior puede no estar en la nueva,
  // y la pareja incompatible devolvería ceros sin explicar por qué.
  const setCity = (e) => setFilters({ ...filters, city: e.target.value, store: '' })

  // "Hoy" sale de `range.max`, que el backend calcula en America/Bogota. Usar
  // el reloj del navegador haría que los presets no casaran nunca para quien
  // mire desde otra zona horaria — ni de noche desde la propia.
  // El rango es inclusivo: "7d" son 7 días contando hoy, no 8.
  const rangeOf = (p) =>
    p === 'todo'
      ? { desde: range.min, hasta: range.max }
      : { desde: minusDays(range.max, p - 1), hasta: range.max }

  const apply = (p) => () => setFilters({ ...filters, ...rangeOf(p) })
  // Un preset está activo cuando el rango actual coincide exactamente con el suyo.
  const isActive = (p) => {
    const r = rangeOf(p)
    return filters.desde === r.desde && filters.hasta === r.hasta
  }

  return (
    <div className="topbar">
      <div className="topbar-row">
        <h1>Dashboard <span>Fud</span></h1>
        <div className={`search ${q ? 'on' : ''}`}>
          <IconSearch />
          <input list="fud-sug" placeholder="Filtrar tiendas, productos, estados…" value={q}
            onChange={(e) => setQ(e.target.value)} />
          <datalist id="fud-sug">
            {suggestions.map((s) => <option key={s} value={s} />)}
          </datalist>
          {q && <button className="clear" onClick={() => setQ('')} title="Limpiar">×</button>}
        </div>
        <button className="ghost" onClick={onRefresh} title="Refrescar" disabled={loading}>
          <IconRefresh />
        </button>
        <button className="ghost" onClick={toggleTheme} title="Cambiar tema">
          {theme === 'light' ? <IconMoon /> : <IconSun />}
        </button>
        <a className="ghost" href="/admin/" title="Volver al admin"><IconBack /><span>Admin</span></a>
      </div>
      <div className="topbar-row filters">
        <input type="date" value={filters.desde} onChange={set('desde')} />
        <span className="sep">→</span>
        <input type="date" value={filters.hasta} onChange={set('hasta')} />
        <select className={filters.city ? 'on' : ''} value={filters.city} onChange={setCity}>
          <option value="">Todas las ciudades</option>
          {cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className={filters.store ? 'on' : ''} value={filters.store} onChange={set('store')}>
          <option value="">Todas las tiendas</option>
          {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <div className="presets">
          {PRESETS.map(([p, l]) => (
            <button key={l} className={isActive(p) ? 'on' : ''} aria-pressed={isActive(p)}
              onClick={apply(p)}>{l}</button>
          ))}
        </div>
      </div>
      {/* Anclas nativas: con quince paneles el salto directo vale más que
          cualquier router, y aquí arriba sigue alcanzable con scroll hecho. */}
      {sections.length > 0 && (
        <nav className="topbar-row jump" aria-label="Secciones del dashboard">
          {sections.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}
        </nav>
      )}
      {loading && <div className="progress" />}
    </div>
  )
}

export function Skeleton() {
  return (
    <main>
      <div className="cards">
        {Array.from({ length: 6 }, (_, i) => <div key={i} className="card sk" />)}
      </div>
      <div className="panel sk tall" />
      <div className="grid">
        {Array.from({ length: 4 }, (_, i) => <div key={i} className="panel sk mid" />)}
      </div>
    </main>
  )
}
