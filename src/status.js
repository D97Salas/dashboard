/** «Estado del día»: un semáforo por área, calculado con lo que el backend ya manda.
 *
 *  Sin consultas nuevas. Reglas (las que el plan fijó):
 *   - Una alerta `info` NO cuenta: lista algo que auditar, no una falla.
 *   - Rojo = alguna alerta `critical` con casos (o, en Procesos, un worker caído).
 *   - Amarillo = alguna alerta `warn` con casos.
 *   - Verde = nada de lo anterior.
 *   - Gris = no se sabe. Un worker que nunca latió (puede no estar desplegado aquí) o un
 *     panel sin datos NO se pinta verde ni rojo: mentir en ambos sentidos es peor.
 *  Seguridad suma, además de sus alertas, los paneles de vigilancia: fallos de acceso por
 *  encima del umbral, bloqueos duros de PIN, cajas bloqueadas y rechazos de DPoP (los
 *  «observados» de log_only no cuentan: no bloquearon a nadie).
 */

export const AREAS = [
  { id: 'money', label: 'Dinero' },
  { id: 'dispatches', label: 'Despachos' },
  { id: 'security', label: 'Seguridad' },
  { id: 'config', label: 'Configuración' },
  { id: 'promos', label: 'Promos' },
]

const peor = (a, b) => ({ ok: 0, unknown: 1, warn: 2, danger: 3 }[b] > { ok: 0, unknown: 1, warn: 2, danger: 3 }[a] ? b : a)

export function computeStatus(data) {
  const alertas = data.alerts.filter((x) => x.n > 0 && x.severity !== 'info')

  const areas = AREAS.map(({ id, label }) => {
    const propias = alertas.filter((x) => x.group === id)
    const razones = propias.map((x) => `${x.label}: ${x.n}`)
    let tone = 'ok'
    for (const x of propias) tone = peor(tone, x.severity === 'critical' ? 'danger' : 'warn')

    if (id === 'security') {
      const { auth_watch: aw, pin_watch: pw, dpop_watch: dw } = data
      const extra = (cond, texto) => { if (cond) { tone = peor(tone, 'warn'); razones.push(texto) } }
      extra(aw?.flagged > 0, `${aw?.flagged} actor(es) con muchos fallos de acceso`)
      extra(pw?.available && pw.hard_locks_window > 0, `${pw?.hard_locks_window} bloqueo(s) duro(s) de PIN`)
      extra(pw?.available && pw.terminals?.length > 0, `${pw?.terminals?.length} caja(s) con PIN bloqueado`)
      extra(dw?.available && dw.scopable && dw.blocked_total > 0, `${dw?.blocked_total} proof(s) DPoP rechazado(s)`)
      // Sin datos de un panel de seguridad: ni verde ni rojo. Solo si no hay algo peor.
      if (tone === 'ok' && ((pw && !pw.available) || (dw && !dw.available))) {
        tone = 'unknown'
        razones.push('sin datos de PIN o DPoP (auth o Redis no respondieron)')
      }
    }
    // Una alerta que depende de otro servicio (cobro → wallet) sin datos es «no se sabe»:
    // contaba 0 casos y el área quedaba verde con wallet caído.
    const ciegas = data.alerts.filter((x) => x.group === id && x.available === false && x.severity !== 'info')
    if (tone === 'ok' && ciegas.length) {
      tone = 'unknown'
      razones.push(`sin datos: ${ciegas.map((x) => x.label).join(', ')}`)
    }
    return { id, label, tone, razones, n: propias.reduce((s, x) => s + x.n, 0) }
  })

  const caidos = data.workers.filter((w) => w.state === 'down')
  const vivos = data.workers.filter((w) => w.state === 'ok').length
  const sinDato = data.workers.some((w) => w.state === 'unknown')
  // Primero: si un proceso de fondo cae, todo lo demás deja de confirmarse (orden de la guía).
  areas.unshift({
    id: 'workers', label: 'Procesos',
    tone: caidos.length ? 'danger' : sinDato || vivos === 0 ? 'unknown' : 'ok',
    razones: caidos.length ? caidos.map((w) => `${w.label} caído`)
      : sinDato ? ['no se pudieron leer los latidos'] : vivos === 0 ? ['ningún proceso ha latido'] : [],
    n: caidos.length,
  })
  return areas
}

export function headline(areas) {
  const rojas = areas.filter((a) => a.tone === 'danger').length
  const amarillas = areas.filter((a) => a.tone === 'warn').length
  if (rojas) return { tone: 'danger', text: `${rojas} área(s) con problemas${amarillas ? ` y ${amarillas} por revisar` : ''}` }
  if (amarillas) return { tone: 'warn', text: `${amarillas} área(s) por revisar` }
  if (areas.some((a) => a.tone === 'unknown')) return { tone: 'unknown', text: 'Sin problemas conocidos, pero hay áreas sin datos' }
  return { tone: 'ok', text: 'Todo en orden' }
}

/** A dónde lleva el clic en un semáforo: Procesos a su barra; el resto, a Alertas. */
export const goToArea = (id) =>
  document.getElementById(id === 'workers' ? 'procesos' : 'alertas')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
