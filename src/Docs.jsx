/** Guías operativas, dentro del panel.
 *
 * Son estáticas a propósito: no salen del backend ni se piden por fetch. Lo que
 * explican es CÓDIGO (estados, comandos, invariantes), así que su fuente de
 * verdad es este repo y no una tabla — un documento que se edita en una base de
 * datos se desincroniza del código sin que nadie lo note.
 *
 * Para agregar una guía: un objeto más en DOCS. Las pestañas salen solas.
 */
import { useCallback, useEffect, useState } from 'react'
import { action } from './api'
import { useBackdropClose } from './components'

const Chip = ({ tone, children }) => <span className={`chip ${tone ?? ''}`}>{children}</span>


const fecha = (iso) => (iso ? iso.slice(0, 16).replace('T', ' ') : '—')

/** La parte accionable de la guía.
 *
 * Dos botones y ni uno más. `Drenar` y `Reprogramar` reintentan con la misma
 * clave de idempotencia: no pueden inventar un pago, el peor caso es que wallet
 * repita la respuesta que ya dio. Finalizar o declarar fallido NO está aquí a
 * propósito — eso exige mirar el ledger de wallet, y un formulario para teclear
 * un ledger_id sería un botón para marcar PAID sin prueba. Para eso, el panel
 * entrega los ids exactos y el comando se corre en la shell.
 */
function OutboxTool() {
  const [rows, setRows] = useState(null)
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)
  const [abierta, setAbierta] = useState(null)

  const cargar = useCallback(() => {
    fetch('/admin/dashboard/api/detail/outbox_stuck/', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => setRows(d.rows ?? []))
      .catch((e) => setMsg({ bad: true, text: `No se pudo leer el outbox: ${e.message}` }))
  }, [])

  useEffect(() => { cargar() }, [cargar])

  const correr = (promesa, texto) => {
    setBusy(true)
    setMsg(null)
    promesa
      .then((d) => setMsg({ text: texto(d) }))
      .catch((e) => setMsg({ bad: true, text: e.message }))
      .finally(() => { setBusy(false); cargar() })
  }

  const drenar = () => correr(
    action('drain'),
    (d) => `Barrido hecho: ${d.counts.done} cerradas, ${d.counts.failed} fallidas, ` +
           `${d.counts.retry} para reintentar, ${d.counts.skipped} sin handler.`,
  )

  const reprogramar = (id) => correr(action('reschedule', { row: id }), (d) => d.message)

  return (
    <div className="doc-tool">
      <div className="doc-tool-head">
        <b>Herramientas</b>
        <button className="ghost" onClick={drenar} disabled={busy}>
          {busy ? 'Trabajando…' : 'Drenar ahora'}
        </button>
      </div>
      <p className="doc-tool-sub">
        Un barrido de hasta 25 filas, el mismo que corre el servicio. Reintenta con la misma clave:
        si wallet ya había cobrado, devuelve el mismo asiento en vez de cobrar otra vez.
      </p>

      {msg && <p className={msg.bad ? 'doc-msg bad' : 'doc-msg'}>{msg.text}</p>}

      {rows === null && <p className="doc-tool-sub">Leyendo el outbox…</p>}
      {rows?.length === 0 && <p className="doc-msg">✓ No hay filas sin cerrar.</p>}

      {rows?.length > 0 && (
        <table className="plain">
          <thead>
            <tr><th>Operación</th><th>Estado</th><th>Intentos</th><th>Próximo</th><th>Último error</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.operacion}</td>
                <td><span className={`chip ${r.estado === 'FAILED' ? 'bad' : 'hold'}`}>{r.estado}</span></td>
                <td>{r.intentos}</td>
                <td>{fecha(r.proximo)}</td>
                <td className="doc-err">{r.error}</td>
                <td>
                  {r.estado === 'IN_PROGRESS' && (
                    <button className="ghost" disabled={busy} onClick={() => reprogramar(r.id)}>
                      Reprogramar
                    </button>
                  )}
                  {r.estado === 'FAILED' && (
                    <button className="ghost" onClick={() => setAbierta(abierta === r.id ? null : r.id)}>
                      Datos para reconciliar
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {abierta && rows?.find((r) => r.id === abierta) && (() => {
        const r = rows.find((x) => x.id === abierta)
        // Buscar estos tres a mano, entre una shell y otra, es justo donde se
        // equivoca uno: se pega la clave de otra fila y se finaliza el pago ajeno.
        const datos = `fila:  ${r.id}
clave: ${r.clave}
ref:   ${r.ref}`
        return (
          <div className="doc-recon">
            <p><b>Reconciliación manual.</b> Verifica primero en el ledger de wallet con esta clave; después
              sigue el paso 6 con estos ids.</p>
            <pre>{datos}</pre>
            <button className="ghost" onClick={() => navigator.clipboard?.writeText(datos)}>Copiar</button>
          </div>
        )
      })()}
    </div>
  )
}

function Outbox() {
  return (
    <>
      <p className="doc-lede">
        Qué hacer cuando el panel dice <b>Outbox sin cerrar</b>: cómo leer una fila, qué significa
        <Chip tone="hold">PROCESSING_WALLET_CAPTURE</Chip> y cómo reconciliar a mano contra el ledger
        de wallet sin inventar un pago.
      </p>

      <div className="doc-note">
        <b>El invariante.</b> Nada se marca <Chip tone="ok">PAID</Chip> ni se entrega producto si
        wallet no confirmó un cobro real, con <code>ledger_entry_id</code> o su replay idempotente.
        El drenador jamás marca pagado: eso solo lo hace el handler ante una confirmación de wallet.
        Si algo quedó a medias, el dinero pudo moverse en wallet, pero el negocio nunca mintió.
      </div>

      <OutboxTool />

      <h3 className="sub">Cómo funciona</h3>
      <p>
        El cobro no ocurre dentro de la transacción de negocio. Se congela la intención
        (orden, pago y fila de outbox commiteadas juntas), se hace el HTTP afuera, y una segunda
        transacción finaliza según lo que wallet conteste: <b>éxito</b> con ledger real,
        <b> rechazo de negocio</b> (400, 402, 404) o <b>ambiguo</b> (timeout, 409, 5xx), que vuelve a
        la cola y se reintenta con la misma clave. Un reintento no es un cobro nuevo: wallet reconoce
        la <code>wallet_idempotency_key</code> y devuelve el mismo asiento.
      </p>

      <h3 className="sub">La fila del outbox</h3>
      <table className="plain">
        <thead><tr><th>Estado</th><th>Significa</th><th>¿Se mueve solo?</th></tr></thead>
        <tbody>
          <tr><td><Chip tone="hold">PENDING</Chip></td>
            <td>Esperando turno. Con <code>next_attempt_at</code> futuro está en backoff.</td>
            <td>Sí, el drenador la toma al vencer.</td></tr>
          <tr><td><Chip>IN_PROGRESS</Chip></td>
            <td>Reclamada por un drenador, con el HTTP en curso.</td>
            <td>No. Si el proceso murió aquí, se queda.</td></tr>
          <tr><td><Chip tone="ok">DONE</Chip></td>
            <td>Wallet confirmó y el negocio se finalizó.</td>
            <td>Terminal.</td></tr>
          <tr><td><Chip tone="bad">FAILED</Chip></td>
            <td>Rechazo de negocio, o se agotaron los cinco intentos.</td>
            <td>No, hasta que alguien intervenga.</td></tr>
        </tbody>
      </table>

      <h3 className="sub">El pago en business</h3>
      <table className="plain">
        <thead><tr><th>Estado</th><th>Qué pasó</th></tr></thead>
        <tbody>
          <tr><td><Chip tone="hold">PENDING_WALLET_CAPTURE</Chip></td>
            <td>El intento quedó congelado y todavía no se llamó a wallet. No se cobró nada.</td></tr>
          <tr><td><Chip tone="hold">PROCESSING_WALLET_CAPTURE</Chip></td>
            <td><b>Es el estado ambiguo, no un error.</b> Se llamó a wallet y no se pudo confirmar el
              resultado: timeout, 409 por otra petición en vuelo, 5xx. El débito pudo ocurrir o no.
              Por eso no se marca ni pagado ni fallido, y el outbox reintenta con la misma clave.</td></tr>
          <tr><td><Chip tone="ok">PAID</Chip></td>
            <td>Wallet devolvió un ledger real. Factura, stock y despacho ya se cerraron.</td></tr>
          <tr><td><Chip tone="bad">FAILED</Chip></td>
            <td>Wallet rechazó por reglas de negocio: saldo, límite, moneda. No hay dinero movido.</td></tr>
          <tr><td><Chip tone="bad">REQUIRES_RECONCILIATION</Chip></td>
            <td><b>La única que exige a un humano.</b> Se agotaron los reintentos sin respuesta clara:
              el sistema no sabe si el dinero salió, y prefiere decirlo a adivinar.</td></tr>
        </tbody>
      </table>

      <h3 className="sub">Paso a paso</h3>
      <ol className="doc-steps">
        <li>
          <b>Mirar la alerta.</b> Sección <b>Alertas</b>, tarjeta <b>Outbox sin cerrar</b>: cuenta todo
          lo que no está en DONE e indica cuántas agotaron intentos. El cajón trae operación, estado,
          intentos sobre el máximo, próximo intento y último error. Esa alerta <b>ignora el rango de
          fechas a propósito</b> — un cobro colgado de hace dos meses sigue siendo un problema hoy —
          pero sí respeta la tienda. Al lado, <b>Cobros en limbo</b> y <b>Recargas atascadas</b> son la
          misma avería vista desde el registro de negocio.
        </li>
        <li>
          <b>Clasificar las filas.</b> Cuatro casos y solo uno necesita a un humano:
          <ul>
            <li><b>PENDING con próximo intento futuro:</b> está trabajando, no toques nada. El backoff
              es de 3 segundos por intento acumulado.</li>
            <li><b>PENDING vencida y quieta:</b> nadie está drenando. Paso 3.</li>
            <li><b>IN_PROGRESS quieta hace rato:</b> el proceso murió con el HTTP en vuelo. No vuelve
              sola.</li>
            <li><b>FAILED con intentos al máximo:</b> reconciliación manual, pasos 5 y 6.</li>
          </ul>
        </li>
        <li>
          <b>Drenar.</b> Un barrido procesa hasta <code>--limit</code> filas vencidas, una a una y con
          bloqueo para que dos drenadores no se pisen.
          <pre>{`# un barrido
venv/Scripts/python.exe manage.py drain_wallet_outbox

# worker continuo
venv/Scripts/python.exe manage.py drain_wallet_outbox --loop --interval 3 --limit 100`}</pre>
          Imprime el conteo por resultado: <code>done</code>, <code>failed</code>, <code>retry</code>,
          <code>skipped</code>. Si todo sale en <code>retry</code>, wallet no contesta y el problema es
          de disponibilidad, no del outbox.
          <p>En producción esto no se corre a mano: el comando es un servicio de systemd
            (<code>deploy/systemd/wallet-outbox-drainer.service</code>) en modo bucle. Si hay filas
            vencidas y quietas, lo primero es mirar si el servicio está vivo, no lanzar un barrido
            suelto.</p>
          <pre>{`systemctl status wallet-outbox-drainer
journalctl -u wallet-outbox-drainer -f`}</pre>
          Correr dos instancias a la vez es seguro: cada una reclama filas distintas con bloqueo, sin
          duplicar intentos.
        </li>
        <li>
          <b>Leer el último error.</b> <code>last_error</code> guarda el texto del último intento. Lo
          que diga decide el camino:
          <table className="plain">
            <thead><tr><th>Dice</th><th>Es</th><th>Qué hacer</th></tr></thead>
            <tbody>
              <tr><td>400 / 402 / 404</td>
                <td>Rechazo de negocio: saldo, límite, moneda, recurso inexistente.</td>
                <td>Nada. Quedó FAILED sin reintento y no hubo cobro.</td></tr>
              <tr><td>409</td>
                <td>Wallet tiene otra petición en vuelo con esa misma clave.</td>
                <td>Esperar, se reintenta solo. En recargas el replay responde 409 con cuerpo de
                  éxito y el cliente ya lo absorbe.</td></tr>
              <tr><td>5xx, timeout, red</td>
                <td>Ambiguo puro. Pudo haber cobrado.</td>
                <td>Reintentar; si agota, reconciliar.</td></tr>
              <tr><td>sin ledger_entry_id</td>
                <td>Wallet respondió 200 pero sin el identificador del asiento.</td>
                <td>Tratar como ambiguo y verificar en el ledger. No finalizar a ciegas.</td></tr>
              <tr><td>PT no encontrado</td>
                <td>La fila apunta a un registro que ya no está.</td>
                <td>Investigar borrados: reintentará en vano.</td></tr>
              <tr><td>sin handler registrado</td>
                <td>El comando no logró importar el módulo del handler.</td>
                <td>Arreglar el import. Esa rama reprograma para siempre y nunca agota intentos.</td></tr>
            </tbody>
          </table>
        </li>
        <li>
          <b>Preguntarle al ledger de wallet.</b> Es el único que sabe si el dinero se movió. Lo más
          rápido es el <b>admin de wallet</b>, sección <i>Wallet Ledger Entries</i>: el buscador acepta
          la clave de idempotencia y la referencia. Por shell, si necesitas más detalle:
          <pre>{`# en el repo de wallet
venv/Scripts/python.exe manage.py shell

from apps.wallets.models import WalletLedger
WalletLedger.objects.filter(reference_id="<pt_id>").values(
    "id", "movement_type", "amount", "balance_after", "created_at")

# o por la clave exacta que envió business (row.wallet_idempotency_key)
WalletLedger.objects.filter(idempotency_key="wallet-capture:<hash>")`}</pre>
          Hay asiento: el cobro ocurrió. No hay asiento: no se movió nada.
        </li>
        <li>
          <b>Aplicar el veredicto.</b> Si <b>wallet sí cobró</b>, hay que terminar lo que quedó a
          medias — sellar el pago, reflejar el reparto, facturar, descontar stock y cerrar el
          despacho. Eso ya lo hace el finalizador del handler, así que se le pasa el ledger real en vez
          de tocar tablas a mano.
          <pre>{`from src.payments.models import WalletOperationOutbox, PaymentTransaction
from src.payments.services.wallet_capture_service import WalletCaptureHandler

row = WalletOperationOutbox.objects.get(id="<row>")
pt = PaymentTransaction.objects.get(id=row.ref_id)

# "respuesta" es la respuesta real de wallet: sin net_amount ni
# commission_amount, la venta queda SIN comisión registrada.
WalletCaptureHandler()._finalize_success(pt, "<ledger_entry_id>", respuesta, row.payload)

row.status = "DONE"
row.save(update_fields=["status", "updated_at"])`}</pre>
          Si <b>wallet no cobró</b>, el pago se declara fallido: las órdenes vuelven a pago fallido y se
          liberan las asignaciones, para que el saldo pueda cobrarse por otro método.
          <pre>{`WalletCaptureHandler()._finalize_business_failure(
    pt, "reconciliado a mano: sin asiento en wallet")

row.status = "FAILED"
row.save(update_fields=["status", "updated_at"])`}</pre>
          En una recarga el reparto es el mismo y cambian los objetos: la solicitud pasa a acreditada y
          el finalizador de recargas sella pago y factura.
        </li>
        <li>
          <b>Verificar aquí mismo.</b> Refresca el panel: <b>Outbox sin cerrar</b> bajó, <b>Cobros en
          limbo</b> ya no incluye ese pago y <b>Allocations descuadradas</b> sigue en cero. Si esa
          última subió tras una finalización manual, el reparto grabado no cuadra con lo cobrado.
        </li>
      </ol>

      <h3 className="sub">Trampas conocidas</h3>
      <dl className="doc-traps">
        <dt>Reintentar una reconciliación pendiente no funciona en cobros</dt>
        <dd>Poner la fila en PENDING y volver a drenar parece lo natural, pero el handler primero marca
          el pago como <code>PROCESSING_WALLET_CAPTURE</code>, y la máquina de estados no permite salir
          de <code>REQUIRES_RECONCILIATION</code> hacia ahí: solo deja ir a PAID, FAILED o CANCELLED.
          El intento revienta, el drenador lo toma como ambiguo y la fila se vuelve a agotar. Para
          cobros y pagos de marketplace, el camino es el paso 6. En recargas sí funciona reprogramar,
          porque el estado de la solicitud no pasa por esa máquina.</dd>

        <dt>Una fila IN_PROGRESS no vuelve sola</dt>
        <dd>El drenador solo reclama filas PENDING. Si el proceso muere con el HTTP en vuelo, la fila
          queda ahí indefinidamente. La sacan dos cosas: que el POS reenvíe el mismo pago con la misma
          clave, o una reprogramación manual. Verifica el ledger antes: esa fila es justo la que pudo
          haber cobrado.</dd>

        <dt>Cada reclamo gasta un intento, aunque no haya habido HTTP</dt>
        <dd>El contador sube al tomar la fila, no al recibir respuesta. Un proceso que muere tres veces
          consume tres de los cinco intentos sin haber llamado a wallet. Por eso una fila puede llegar a
          reconciliación con el contador lleno y sin errores interesantes.</dd>

        <dt>El reintento del POS no gasta presupuesto durante dos segundos</dt>
        <dd>Si el mismo pago se reenvía dentro de la ventana de enfriamiento, business devuelve el
          estado actual sin llamar a wallet. Sin eso, un cajero tocando «reintentar» quemaba los cinco
          intentos con su propio nerviosismo, no con fallas reales.</dd>

        <dt>El outbox no está en el admin de Django</dt>
        <dd>Pagos, recargas y asignaciones sí; el outbox no. Se lee desde el cajón de esta alerta o
          desde la shell, y cualquier cambio es por shell. Eso es bueno: no hay un botón que marque
          pagado sin pasar por el ledger.</dd>
      </dl>

      <h3 className="sub">Referencia</h3>
      <table className="plain">
        <thead><tr><th>Qué</th><th>Dónde</th></tr></thead>
        <tbody>
          <tr><td>Comando de drenado</td><td><code>src/payments/management/commands/drain_wallet_outbox.py</code></td></tr>
          <tr><td>Mecánica de reintentos</td><td><code>src/payments/services/outbox_service.py</code></td></tr>
          <tr><td>Handler de cobro</td><td><code>src/payments/services/wallet_capture_service.py</code></td></tr>
          <tr><td>Handler de recarga</td><td><code>src/payments/services/topup_service.py</code></td></tr>
          <tr><td>Transiciones permitidas</td><td><code>src/orders/state_machine.py</code></td></tr>
          <tr><td>Ledger de wallet</td><td><code>apps/wallets/models.py :: WalletLedger</code></td></tr>
        </tbody>
      </table>
      <p className="doc-foot">
        Cinco intentos por fila, backoff lineal de 3 s por intento, 2 s de enfriamiento para el
        reintento del cliente, y 400, 402 y 404 como únicos rechazos definitivos. Todo lo demás se
        reintenta. Cuando una fila agota los intentos, el servicio deja un registro crítico en el log
        con operación, referencia y correlación: ese es el aviso que debería llegar antes que el panel.
      </p>
    </>
  )
}

function Reconciliar() {
  return (
    <>
      <p className="doc-lede">
        Qué hacer cuando el sistema se declaró ignorante: un pago en
        <Chip tone="bad">REQUIRES_RECONCILIATION</Chip> y su fila del outbox en <Chip tone="bad">FAILED</Chip>.
        Es el único caso que un humano tiene que resolver, y el único donde equivocarse deja plata mal
        contada.
      </p>

      <div className="doc-note">
        <b>La regla, y no tiene excepciones.</b> El ledger de wallet decide, tú transcribes. Nunca al
        revés. Aprobar un pago porque «seguro sí se cobró» es exactamente lo que el outbox entero
        existe para impedir: el cliente reclama, y el registro dice que pagó.
      </div>

      <h3 className="sub">¿Estás en el documento correcto?</h3>
      <table className="plain">
        <thead><tr><th>Si ves…</th><th>Entonces</th></tr></thead>
        <tbody>
          <tr><td><Chip tone="hold">PENDING</Chip></td>
            <td>No es esto. Está esperando turno: drena y se resuelve sola.</td></tr>
          <tr><td><Chip>IN_PROGRESS</Chip> quieta</td>
            <td>No es esto. Es la fila huérfana: reprográmala desde la otra guía.</td></tr>
          <tr><td><Chip tone="bad">FAILED</Chip> con intentos al máximo</td>
            <td>Sí. Sigue leyendo.</td></tr>
          <tr><td><Chip tone="bad">FAILED</Chip> con pocos intentos</td>
            <td>Fue un rechazo de negocio: saldo o límite. Ya está resuelto y no hubo cobro.</td></tr>
        </tbody>
      </table>

      <h3 className="sub">Lo que necesitas antes de empezar</h3>
      <ul className="doc-list">
        <li>Acceso a la shell de <b>business</b> y a la de <b>wallet</b>. Son dos servidores distintos.</li>
        <li>Los tres ids de la fila. Te los da el panel: en la guía del outbox, botón <b>Datos para
          reconciliar</b>. No los busques a mano.</li>
        <li>Diez minutos sin interrupciones. Esto mueve dinero y no tiene deshacer.</li>
      </ul>

      <h3 className="sub">El procedimiento</h3>
      <ol className="doc-steps">
        <li>
          <b>Copia los ids del panel.</b> Son la fila del outbox, la clave de idempotencia y la
          referencia al pago. La clave es la que se le mandó a wallet, y es la que prueba de qué cobro
          estamos hablando.
        </li>
        <li>
          <b>Pregúntale al ledger de wallet.</b> Esto no necesita shell: entra al <b>admin de
          wallet</b>, sección <i>Wallet Ledger Entries</i>, y pega la clave en el buscador. El buscador
          cubre la clave de idempotencia y la referencia, así que sirven las dos.
          <p>Si prefieres la shell, o necesitas ver más campos de los que muestra la lista:</p>
          <pre>{`venv/bin/python manage.py shell

from apps.wallets.models import WalletLedger
list(WalletLedger.objects.filter(idempotency_key="<clave>").values(
    "id", "movement_type", "amount", "balance_after", "created_at"))`}</pre>
          Si sale vacío, prueba por referencia: <code>reference_id</code> es el id del pago, lo que va
          después de los dos puntos en la referencia que copiaste.
        </li>
        <li>
          <b>Lee lo que devolvió.</b> Solo hay tres lecturas posibles:
          <table className="plain">
            <thead><tr><th>Devolvió</th><th>Significa</th><th>Vas a</th></tr></thead>
            <tbody>
              <tr><td>Nada</td><td>Wallet nunca cobró.</td><td>Rechazar, paso 5.</td></tr>
              <tr><td>Dos o más asientos</td>
                <td>Cobró: el débito al consumidor y el crédito a la tienda.</td>
                <td>Aprobar, paso 4.</td></tr>
              <tr><td>Algo que no cuadra</td>
                <td>Un solo asiento, o un monto distinto al del pago.</td>
                <td><b>Parar.</b> Eso no es un cobro normal y no se arregla desde aquí.</td></tr>
            </tbody>
          </table>
        </li>
        <li>
          <b>Aprobar.</b> No se editan tablas a mano: se llama al mismo finalizador que habría corrido
          el handler, para que factura, inventario, comisión y cierre del despacho queden como en
          cualquier venta normal.
          <pre>{`venv/Scripts/python.exe manage.py shell

from src.payments.models import WalletOperationOutbox, PaymentTransaction
from src.payments.services.wallet_capture_service import WalletCaptureHandler

row = WalletOperationOutbox.objects.get(id="<fila>")
pt = PaymentTransaction.objects.get(id=row.ref_id)
assert pt.status == "REQUIRES_RECONCILIATION", pt.status

respuesta = {
    "ledger_entry_id": "<id del asiento>",
    "net_amount": "<lo que recibió la tienda>",
    "commission_amount": "<lo que cobró Fud>",
}
WalletCaptureHandler()._finalize_success(
    pt, respuesta["ledger_entry_id"], respuesta, row.payload)

row.status = "DONE"
row.save(update_fields=["status", "updated_at"])`}</pre>
          Los montos salen de los asientos: el crédito a la tienda es el neto y el asiento de comisión
          es lo que cobró Fud. También están en el log del día, en la línea crítica que se escribió al
          agotarse los intentos. <b>Si los omites, la venta queda sin comisión registrada.</b> No se
          estima a propósito: una comisión inventada es una mentira con dos decimales.
        </li>
        <li>
          <b>Rechazar.</b> Deja el pago fallido, devuelve las órdenes a pago fallido y libera las
          asignaciones, que es lo que permite volver a cobrar ese despacho por otro método.
          <pre>{`WalletCaptureHandler()._finalize_business_failure(
    pt, "reconciliado a mano: sin asiento en wallet")

row.status = "FAILED"
row.save(update_fields=["status", "updated_at"])`}</pre>
          Después de esto el punto de venta puede cobrar otra vez, con una clave nueva. La anterior ya
          está gastada y wallet la reconoce.
        </li>
        <li>
          <b>Verifica en el panel.</b> Refresca y mira tres cosas: <b>Cobros en limbo</b> ya no incluye
          ese pago, <b>Outbox sin cerrar</b> bajó, y <b>Allocations descuadradas</b> sigue en cero. Si
          esa última subió, el reparto que grabaste no cuadra con lo cobrado.
        </li>
      </ol>

      <h3 className="sub">Si es una recarga</h3>
      <p>
        El esquema es idéntico y cambian los objetos. La referencia apunta a una solicitud de recarga,
        el asiento en wallet es un crédito, y finaliza el handler de recargas: la solicitud pasa a
        acreditada y el servicio de finalización sella pago y factura. Ojo con dos estados que hoy no
        tienen salida en el código, esperando al proveedor y confirmado por el proveedor: el webhook de
        la pasarela todavía no existe, así que una recarga ahí no avanza por más que drenes.
      </p>

      <h3 className="sub">Por qué el veredicto no se aplica desde el admin</h3>
      <p>
        El admin de wallet sirve para <b>mirar</b>, y es la mejor herramienta para el paso 2. El admin
        de business, en cambio, no sirve para <b>resolver</b>: edita una fila de una tabla, y finalizar
        un cobro toca siete cosas en una sola transacción —el pago, las asignaciones, la comisión, la
        factura, sus líneas, el inventario y el cierre del despacho—. Cambiar el estado ahí deja el
        pago pagado y la venta rota: sin factura, sin descuento de stock y con el despacho abierto.
      </p>
      <div className="doc-note">
        <b>Ojo con esto.</b> Hoy el campo <i>status</i> del pago es <b>editable</b> en el admin de
        business, y la validación del modelo no comprueba transiciones. Es decir, nada impide
        técnicamente marcar un pago como PAID sin asiento en wallet. Que se pueda no significa que se
        haga: es exactamente el atajo que todo este flujo existe para impedir.
      </div>

      <h3 className="sub">Lo que nunca se hace</h3>
      <ul className="doc-list">
        <li><b>Aprobar sin asiento.</b> Si el ledger no lo tiene, no ocurrió. Da igual lo que diga el
          cliente o lo obvio que parezca.</li>
        <li><b>Editar el estado del pago desde el admin o con un update.</b> Se salta factura,
          inventario, comisión y cierre del despacho: el pago queda pagado y la venta rota.</li>
        <li><b>Reponer los intentos de una fila.</b> El presupuesto de cinco es lo que impide golpear a
          wallet para siempre.</li>
        <li><b>Reusar la clave de otra fila.</b> Es la forma más fácil de finalizar el pago
          equivocado. Por eso el panel te la entrega ya copiada.</li>
        <li><b>Borrar la fila del outbox.</b> Es el registro de lo que pasó y lo que permite auditar
          después quién resolvió qué.</li>
      </ul>

      <h3 className="sub">Antes de cerrar el caso</h3>
      <ul className="doc-list">
        <li>El pago quedó en <Chip tone="ok">PAID</Chip> o en <Chip tone="bad">FAILED</Chip>, nunca en
          medio.</li>
        <li>La fila quedó en <Chip tone="ok">DONE</Chip> o <Chip tone="bad">FAILED</Chip>, coherente
          con lo anterior.</li>
        <li>Las tres alertas del panel están donde deben.</li>
        <li>Quedó anotado qué asiento justificó la decisión. El día que alguien pregunte, esa es la
          prueba.</li>
      </ul>
    </>
  )
}

const DOCS = [
  { id: 'outbox', title: 'Outbox de wallet', sub: 'cómo funciona y cómo depurarlo', body: Outbox },
  { id: 'reconciliar', title: 'Reconciliar un pago', sub: 'cuando el sistema no sabe si se cobró', body: Reconciliar },
]

export default function Docs({ onClose }) {
  const [id, setId] = useState(DOCS[0].id)
  const doc = DOCS.find((d) => d.id === id) ?? DOCS[0]
  const Body = doc.body
  const backdrop = useBackdropClose(onClose)

  useEffect(() => {
    const onEsc = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [onClose])

  return (
    <div className="drawer-backdrop" {...backdrop}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{doc.title}</h2>
          <button className="ghost" onClick={onClose} title="Cerrar">×</button>
        </header>
        <p className="drawer-meta">Guía operativa · {doc.sub}</p>
        <div className="tabs">
          {DOCS.map((d) => (
            <button key={d.id} className={d.id === id ? 'on' : ''} onClick={() => setId(d.id)}>
              {d.title}
            </button>
          ))}
        </div>
        <article className="doc">
          <Body />
        </article>
      </div>
    </div>
  )
}
