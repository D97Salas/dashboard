/* Paleta de datos, validada con scripts/validate_palette.js contra las
 * superficies reales (#fff claro / #172029 oscuro). NO tocar los hexes sin
 * volver a correr el validador: el orden de los slots es el mecanismo de
 * seguridad para daltonismo, no decoración.
 *
 *   claro  → CVD ΔE 9.1 · normal 19.6 · WARN de contraste (relevado con
 *            etiquetas visibles y cifras en cada fila)
 *   oscuro → CVD ΔE 8.4 · normal 19.3 · contraste ≥ 3:1
 *
 * SON 8 Y SOLO 8. Un noveno color generado es indistinguible de alguno de
 * estos bajo daltonismo, así que los paneles se recortan a 8 filas (`SLOTS`) y
 * el resto se ve en el detalle. Nunca ciclar la lista.
 *
 * Los colores de marca de la UI (#417690) son cromo, no tinta de datos: los
 * gráficos nunca los usan para codificar valores.
 */

export const CAT_LIGHT = [
  '#2a78d6', '#eb6834', '#1baf7a', '#eda100',
  '#e87ba4', '#008300', '#4a3aa7', '#e34948',
]
export const CAT_DARK = [
  '#3987e5', '#d95926', '#199e70', '#c98500',
  '#d55181', '#008300', '#9085e9', '#e66767',
]
export const SLOTS = CAT_LIGHT.length

// Estados: paleta fija, nunca tematizada. Jamás se reusa para "serie 4".
export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
}

const GOOD = ['PAID', 'COMPLETED', 'CREDITED', 'DELIVERED', 'DONE', 'DISPATCHED']
const WARN = ['PENDING', 'CREATED', 'OPEN', 'PARTIAL', 'ON_HOLD', 'IN_PROGRESS']
const SERIOUS = ['EXPIRED', 'ABANDONED', 'CANCELLED']

/** Estado → rol semántico. Nunca va solo: siempre lleva su etiqueta al lado. */
export const statusColor = (s = '') =>
  GOOD.includes(s) ? STATUS.good
    : s.startsWith('REQUIRES_') || ['FAILED', 'REJECTED', 'PAYMENT_FAILED'].includes(s) ? STATUS.critical
      : SERIOUS.includes(s) ? STATUS.serious
        : WARN.includes(s) || s.includes('PENDING') || s.includes('PROCESSING') ? STATUS.warning
          : STATUS.warning

/* Estados con color propio. Son ÍNDICES de slot, no hexes: así cada tema usa su
 * variante y la paleta sigue siendo la validada (no se agrega ningún color
 * nuevo, que exigiría volver a correr `validate_palette.js`).
 *
 * Un estado con significado no debería obligar a mirar la leyenda: cancelado en
 * rojo y pendiente en ámbar se leen de un vistazo. El resto de estados sigue
 * tomando un slot libre por orden de dominio — a los que no se les asigna a
 * propósito: FAILED en el mismo rojo que CANCELLED los volvería indistinguibles
 * dentro del mismo gráfico, que es donde hay que separarlos.
 */
export const STATUS_SLOT = {
  PAID: 2,        // verde azulado — cobrado
  COMPLETED: 5,   // verde         — cerrado
  PENDING: 3,     // ámbar         — esperando
  EXPIRED: 4,     // rosa          — se venció solo
  CANCELLED: 7,   // rojo          — alguien lo canceló
}

/** Devuelve `label -> color`, fijado desde el DOMINIO, no desde lo visible.
 *
 *  El color sigue a la entidad, nunca a su posición en la lista visible. Si se
 *  asignara por índice, ocultar una fila repintaría a todas las siguientes y
 *  quien aprendió "PAID es naranja" quedaría engañado.
 *
 *  `rows` debe venir en un orden estable (el del enum, no el del ranking) y sin
 *  filtrar. Una fila en CERO gasta su slot igual que las demás: saltarla hacía
 *  que el color dependiera de qué estados tienen datos en el período, así que
 *  acotar el rango ascendía al primero con datos al slot 1 y EXPIRED cambiaba de
 *  verde a azul — el repintado que esto existe para evitar, entrando por atrás.
 *  El dominio ya viene recortado a los estados que la base ha usado alguna vez
 *  (`selectors._domain`), así que ninguno de los 8 slots se gasta en un valor
 *  del enum que nunca ocurre.
 */
export function stableColors(rows, key, cat) {
  const propio = (label) => (STATUS_SLOT[label] != null ? cat[STATUS_SLOT[label]] : null)
  // Un slot que ya se lleva un estado con color propio no se reparte otra vez:
  // dos entidades del mismo tono en un gráfico es peor que una sin color.
  const tomados = new Set(rows.map((r) => propio(r[key])).filter(Boolean))
  const libres = cat.filter((c) => !tomados.has(c))
  const slot = new Map()
  let i = 0
  for (const r of rows) {
    const label = r[key]
    if (label == null || slot.has(label)) continue
    // Sin `break` al agotar los libres: un estado con color propio lo conserva
    // aunque venga el último del dominio.
    if (propio(label)) slot.set(label, propio(label))
    else if (i < libres.length) slot.set(label, libres[i++])
  }
  return (label) => slot.get(label) ?? NO_COLOR
}

/** Lo que devuelve `stableColors` para una etiqueta sin slot (pasó de los 8). */
export const NO_COLOR = 'var(--muted)'


/** Tinta legible sobre un relleno: blanco o negro según su luminancia.
 *
 *  El umbral NO es 0.5 ni un número a ojo: es el punto donde los dos contrastes
 *  se cruzan. Con L la luminancia del relleno, negro da (L+.05)/.05 y blanco da
 *  1.05/(L+.05); se igualan en L = √(1.05·0.05) − 0.05 = 0.179. Por encima gana
 *  el negro. Estaba en 0.4, que le ponía tinta BLANCA a todo relleno de
 *  luminancia media: 12 de los 15 slots (los dos temas) quedaban entre 2.7:1 y
 *  4.0:1 — el % dentro del segmento apilado era ilegible. Con 0.179 quedan
 *  14 de 15 por encima de 4.5:1.
 *
 *  El que queda corto es `#2a78d6` (slot 1 claro, 4.28:1): su luminancia cae
 *  justo en el cruce y ninguna de las dos tintas llega a 4.5. No se retoca el
 *  hex — el orden de los slots es la seguridad CVD (ver arriba) — y el dato no
 *  se pierde: el mismo % va en la leyenda, en tinta normal.
 */
export const inkOn = (hex) => {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179 ? '#111' : '#fff'
}
