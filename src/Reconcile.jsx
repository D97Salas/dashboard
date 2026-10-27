/** «Conciliar con wallet»: cerrar un cobro dudoso preguntándole a wallet.
 *
 *  Nadie teclea aquí un ledger ni elige el resultado: wallet dice si hubo débito
 *  (consulta de solo lectura) y el backend aplica lo que wallet respondió. Por eso
 *  existe este botón y no existe uno para marcar pagado a mano (ver `actions.py`).
 *
 *  Dos pasos a propósito:
 *    1. Al abrir el panel se CONSULTA. No cambia nada; solo muestra qué haría.
 *    2. Aplicar exige un motivo (queda en la auditoría) y una confirmación. El
 *       backend vuelve a consultar a wallet antes de aplicar: no confía en lo que
 *       se vio en el paso 1, porque entre uno y otro el cobro pudo cambiar.
 *
 *  `onNotify(texto, malo)` avisa el resultado fuera de este panel. Tiene que vivir
 *  afuera: al aplicar, el tablero se refresca y el cajón cierra el panel, así que un
 *  mensaje pintado aquí dentro desaparecería antes de poder leerse.
 */
import { useCallback, useEffect, useState } from 'react'
import { action } from './api'

const MOTIVO_MIN = 5
const MOTIVO_MAX = 200

const RESULTADO = {
  PAID: {
    titulo: 'Wallet confirma el débito.',
    efecto: 'Al aplicar, el cobro pasa a PAGADO (con el ledger de wallet) y el despacho se desbloquea.',
    confirmar: 'PAGADO',
    boton: 'btn-ok',
  },
  FAILED: {
    titulo: 'Wallet NO tiene el débito.',
    efecto: 'Al aplicar, el cobro pasa a FALLIDO y se libera lo que tenía reservado.',
    confirmar: 'FALLIDO',
    boton: 'btn-danger',
  },
}

/** Lo que falta para poder aplicar, dicho con palabras. */
function pistaMotivo(largo) {
  if (largo === 0) return { texto: `Escribe el motivo para poder aplicar (mínimo ${MOTIVO_MIN} caracteres).`, clase: 'falta' }
  if (largo < MOTIVO_MIN) {
    const faltan = MOTIVO_MIN - largo
    return { texto: `Faltan ${faltan} ${faltan === 1 ? 'carácter' : 'caracteres'} para poder aplicar.`, clase: 'falta' }
  }
  return { texto: `Listo para aplicar (${largo} de ${MOTIVO_MAX} caracteres).`, clase: 'ok' }
}

export default function Reconcile({ pt, onApplied, onNotify }) {
  const [vista, setVista] = useState(null)
  const [error, setError] = useState(null)
  const [motivo, setMotivo] = useState('')
  const [busy, setBusy] = useState(false)

  const consultar = useCallback(() => {
    setVista(null)
    setError(null)
    return action('reconcile_capture', { pt }).then(setVista, (e) => setError(e.message))
  }, [pt])

  useEffect(() => { consultar() }, [consultar])

  const largo = motivo.trim().length
  const motivoOk = largo >= MOTIVO_MIN && largo <= MOTIVO_MAX
  const info = vista ? RESULTADO[vista.outcome] : null
  const pista = pistaMotivo(largo)

  const aplicar = () => {
    if (!motivoOk) return  // defensa: el botón ya está deshabilitado, esto cubre el Enter
    if (!window.confirm(`¿Aplicar? El cobro pasará a ${info.confirmar}. Esto no se puede deshacer.`)) return
    setBusy(true)
    setError(null)
    action('reconcile_capture', { pt, apply: true, reason: motivo.trim() })
      .then((d) => {
        onNotify?.(`Listo: ${d.message} Quedó registrado en la auditoría.`, false)
        onApplied?.()
      })
      .catch((e) => {
        setError(e.message)
        onNotify?.(`No se aplicó: ${e.message}`, true)
      })
      .finally(() => setBusy(false))
  }

  return (
    <div className="reconcile">
      {!vista && !error && <p className="msg">Consultando a wallet…</p>}

      {error && (
        <>
          <p className="msg bad">{error}</p>
          <div>
            <button className="btn btn-outline btn-sm" onClick={consultar} disabled={busy}>Volver a consultar</button>
          </div>
        </>
      )}

      {vista && vista.kind === 'NOOP' && <p className="msg">{vista.message}</p>}

      {vista && vista.kind === 'PREVIEW' && info && (
        <>
          <p className={`msg ${vista.outcome === 'PAID' ? 'ok' : ''}`}>
            <b>{info.titulo}</b> {info.efecto}
          </p>
          <div className="row">
            <label>
              Motivo (obligatorio)
              <input value={motivo} maxLength={MOTIVO_MAX} placeholder="Ticket o explicación (queda en la auditoría)"
                onChange={(e) => setMotivo(e.target.value)} aria-required="true"
                onKeyDown={(e) => e.key === 'Enter' && aplicar()} />
              <span className={`hint ${pista.clase}`}>{pista.texto}</span>
            </label>
            <button className={`btn ${info.boton}`} onClick={aplicar} disabled={busy || !motivoOk}
              title={motivoOk ? undefined : `Escribe un motivo de al menos ${MOTIVO_MIN} caracteres`}>
              {busy ? 'Aplicando…' : `Aplicar como ${info.confirmar}`}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
