/* Comprobación de `stableColors`. Correr con: npm run check
 *
 * Vigila el anti-patrón "recolor-on-filter": si el color se asignara por la
 * posición en la lista visible, ocultar una fila repintaría a todas las
 * siguientes y quien aprendió "PAID es verde" quedaría engañado.
 */
import { CAT_LIGHT, STATUS_SLOT, stableColors } from './palette.js'

const assert = (cond, msg) => {
  if (!cond) { console.error('FALLO:', msg); process.exit(1) }
}

const todos = [
  { status: 'CREATED', n: 12 }, { status: 'PAID', n: 4 },
  { status: 'PENDING', n: 4 }, { status: 'COMPLETED', n: 8 },
  { status: 'CANCELLED', n: 2 }, { status: 'EXPIRED', n: 0 },
]
const color = stableColors(todos, 'status', CAT_LIGHT)
const antes = new Map(todos.map((r) => [r.status, color(r.status)]))

// 1. Filtrar filas no cambia el color de las que quedan.
for (const r of todos.filter((r) => r.status !== 'CREATED')) {
  assert(color(r.status) === antes.get(r.status), `${r.status} cambió de color al filtrar`)
}

// 2. Un estado con significado lleva SU color, venga donde venga en el dominio.
for (const [estado, slot] of Object.entries(STATUS_SLOT)) {
  assert(color(estado) === CAT_LIGHT[slot], `${estado} no lleva su color propio`)
}

// 3. Los demás toman un slot LIBRE: nunca uno ya usado por un estado con color.
const usados = Object.values(STATUS_SLOT).map((s) => CAT_LIGHT[s])
assert(!usados.includes(color('CREATED')), 'CREATED repite el color de otro estado')
assert(color('CREATED') === CAT_LIGHT[0], 'CREATED debe tomar el primer slot libre')

// 4. Una fila en CERO conserva su slot: el dominio no encoge con el filtro.
//    Sin esto, un rango donde solo COMPLETED tiene datos lo ascendía al slot 1 y
//    el mismo estado salía de otro color con cada filtro.
const filtrado = todos.map((r) => ({ ...r, n: r.status === 'COMPLETED' ? r.n : 0 }))
const color2 = stableColors(filtrado, 'status', CAT_LIGHT)
for (const r of todos) {
  assert(color2(r.status) === antes.get(r.status), `${r.status} cambió de color al acotar el rango`)
}

// 5. Lo que no es un estado (tiendas, productos) sigue el orden del dominio.
const tiendas = [{ k: 'Norte' }, { k: 'Sur' }, { k: 'Centro' }]
const c3 = stableColors(tiendas, 'k', CAT_LIGHT)
assert(c3('Norte') === CAT_LIGHT[0] && c3('Centro') === CAT_LIGHT[2], 'el orden del dominio manda')

// 6. Nunca se genera un 9º color: bajo daltonismo sería indistinguible.
const muchos = Array.from({ length: 12 }, (_, i) => ({ k: `x${i}`, n: 1 }))
const c4 = stableColors(muchos, 'k', CAT_LIGHT)
assert(c4('x7') === CAT_LIGHT[7], 'los 8 slots deben usarse')
assert(c4('x8') === 'var(--muted)', 'no debe generar un 9º color')

console.log('OK: el color sigue a la entidad, no a su posición')
