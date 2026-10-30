package com.jarvis.companion

import android.content.Context
import android.net.ConnectivityManager
import android.os.Build
import android.provider.Settings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509TrustManager
import kotlin.coroutines.cancellation.CancellationException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

sealed class LinkState {
    data object NotPaired : LinkState()
    data class Connecting(val where: String) : LinkState()
    data class Connected(val desktop: String, val address: String, val since: Long) : LinkState()
    data class Offline(val reason: String, val retryAt: Long) : LinkState()
    data object PausedByUser : LinkState()
    data class Revoked(val reason: String) : LinkState()
}

sealed class PairState {
    data object Idle : PairState()
    data class Working(val step: String) : PairState()
    data class AwaitingConfirm(val code: String, val desktop: String) : PairState()
    data class WaitingForPc(val code: String, val desktop: String) : PairState()
    data class Done(val desktop: String) : PairState()
    data class Failed(val message: String) : PairState()
}

/** App-wide state the screen and the service both read. */
object Hub {
    val state = MutableStateFlow<LinkState>(LinkState.NotPaired)
    val pairing = MutableStateFlow<PairState>(PairState.Idle)
    @Volatile private var instance: Link? = null
    fun link(ctx: Context): Link = instance ?: synchronized(this) {
        instance ?: Link(ctx.applicationContext).also { instance = it }
    }
}

private sealed class Incoming {
    data class Message(val json: JSONObject) : Incoming()
    data class Closed(val code: Int, val reason: String) : Incoming()
}

/** One WebSocket, as a channel of messages that ends with a Closed. */
private class Socket(val ws: WebSocket, val incoming: Channel<Incoming>) {
    fun send(json: JSONObject) = ws.send(json.toString())
    fun sendText(text: String) = ws.send(text)
    suspend fun next(timeoutMs: Long): Incoming = withTimeoutOrNull(timeoutMs) { incoming.receiveCatching().getOrNull() } ?: Incoming.Closed(-1, "no answer from the PC")
}

private const val MAX_MESSAGE = 256 * 1024

/**
 * The connection to the paired PC.
 *
 * Trust comes from the pin, not the network: the TLS certificate must hash to
 * the fingerprint from the PC's QR code, whatever address answered. After
 * pairing, each connection proves this phone holds the key by answering a
 * fresh challenge, so the key itself never crosses the network again.
 */
class Link(private val ctx: Context) {
    /** The application context, for the screen's Settings shortcuts. */
    val context: Context get() = ctx
    val store = SecureStore(ctx)
    private val actions = Actions(ctx, store)
    private val wake = Channel<Unit>(Channel.CONFLATED)
    private var current: Socket? = null
    private var pairSocket: Socket? = null

    // ---- TLS with a pinned certificate ---------------------------------

    private fun trustManager(pin: String) = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = throw CertificateException("not a server")
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            val leaf = chain?.firstOrNull() ?: throw CertificateException("no certificate")
            if (!Proto.same(Proto.fingerprint(leaf.encoded), pin)) throw CertificateException("this is not the paired PC")
        }
        override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
    }

    private fun sslContext(pin: String): Pair<SSLContext, X509TrustManager> {
        val tm = trustManager(pin)
        val ssl = SSLContext.getInstance("TLS")
        ssl.init(null, arrayOf(tm), SecureRandom())
        return ssl to tm
    }

    private fun client(pin: String): OkHttpClient {
        val (ssl, tm) = sslContext(pin)
        return OkHttpClient.Builder()
            .sslSocketFactory(ssl.socketFactory, tm)
            // The pin identifies the PC; the address it happens to have does not.
            .hostnameVerifier { _, session ->
                (session.peerCertificates.firstOrNull() as? X509Certificate)?.let { Proto.same(Proto.fingerprint(it.encoded), pin) } ?: false
            }
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .build()
    }

    private suspend fun open(client: OkHttpClient, host: String, port: Int): Socket = suspendCancellableCoroutine { cont ->
        val ch = Channel<Incoming>(Channel.UNLIMITED)
        val ws = client.newWebSocket(Request.Builder().url("wss://$host:$port/companion").build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (cont.isActive) cont.resume(Socket(webSocket, ch))
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (text.length > MAX_MESSAGE) return
                runCatching { JSONObject(text) }.getOrNull()?.let { ch.trySend(Incoming.Message(it)) }
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                ch.trySend(Incoming.Closed(code, reason))
                ch.close()
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (cont.isActive) cont.resumeWithException(t)
                else {
                    ch.trySend(Incoming.Closed(-1, t.message ?: "network error"))
                    ch.close()
                }
            }
        })
        cont.invokeOnCancellation { ws.cancel() }
    }

    /** The first address that answers with the pinned certificate. */
    private suspend fun reach(pin: String, hosts: List<String>, port: Int): Pair<Socket, String>? {
        val c = client(pin)
        for (h in hosts.distinct()) {
            Hub.state.value = LinkState.Connecting(h)
            val s = withTimeoutOrNull(7_000) { runCatching { open(c, h, port) }.getOrNull() }
            if (s != null) return s to h
        }
        return null
    }

    /**
     * The PC's address changed (a new DHCP lease). Look for it on this
     * phone's own /24, accepting only the pinned certificate. Bounded: one
     * subnet, short timeouts.
     */
    private suspend fun scan(pin: String, port: Int): String? = withContext(Dispatchers.IO) {
        val cm = ctx.getSystemService(ConnectivityManager::class.java) ?: return@withContext null
        val own = cm.getLinkProperties(cm.activeNetwork)?.linkAddresses
            ?.map { it.address }?.filterIsInstance<Inet4Address>()?.firstOrNull { it.isSiteLocalAddress } ?: return@withContext null
        val base = own.hostAddress!!.substringBeforeLast('.')
        val (ssl, _) = sslContext(pin)
        val gate = Semaphore(32)
        coroutineScope {
            (1..254).map { i ->
                async {
                    gate.withPermit {
                        val ip = "$base.$i"
                        runCatching {
                            (ssl.socketFactory.createSocket() as SSLSocket).use { s ->
                                s.connect(InetSocketAddress(ip, port), 400)
                                s.soTimeout = 1500
                                s.startHandshake() // throws unless the certificate matches the pin
                                ip
                            }
                        }.getOrNull()
                    }
                }
            }.awaitAll().firstOrNull { it != null }
        }
    }

    // ---- pairing -----------------------------------------------------------

    fun deviceName(): String =
        runCatching { Settings.Global.getString(ctx.contentResolver, Settings.Global.DEVICE_NAME) }.getOrNull()?.takeIf { it.isNotBlank() }
            ?: "${Build.MANUFACTURER} ${Build.MODEL}"

    /** Scan → hello with the proof → show the code → both confirm → key. */
    suspend fun pair(raw: String) {
        val info = try {
            PairingInfo.parse(raw)
        } catch (e: IllegalArgumentException) {
            Hub.pairing.value = PairState.Failed(e.message ?: "Bad pairing code.")
            return
        }
        Hub.pairing.value = PairState.Working("Reaching ${info.name}…")
        val reached = reach(info.fp, info.hosts, info.port) ?: scan(info.fp, info.port)?.let { ip -> reach(info.fp, listOf(ip), info.port) }
        if (reached == null) {
            Hub.pairing.value = PairState.Failed("Could not reach ${info.name} at ${info.hosts.joinToString()}. Check both are on the same Wi-Fi, and that Windows Firewall allows JARVIS on private networks.")
            return
        }
        val (sock, host) = reached
        pairSocket = sock
        val deviceId = store.deviceId
        val nonce = Proto.b64url(Proto.random(16))
        val code = Proto.verificationCode(info.secret, deviceId, nonce)
        sock.send(
            JSONObject().put("t", "hello").put("v", Proto.VERSION).put("mode", "pair").put("pid", info.pid).put("nonce", nonce)
                .put("proof", Proto.pairProof(info.secret, info.pid, deviceId, nonce, info.fp))
                .put("device", JSONObject().put("id", deviceId).put("name", deviceName().take(60)).put("model", Build.MODEL.take(60)).put("android", Build.VERSION.RELEASE)),
        )
        try {
            while (true) {
                when (val m = sock.next(120_000)) {
                    is Incoming.Closed -> {
                        if (Hub.pairing.value !is PairState.Done) Hub.pairing.value = PairState.Failed("The PC closed the connection: ${m.reason.ifBlank { "no reason given" }}")
                        return
                    }
                    is Incoming.Message -> when (m.json.optString("t")) {
                        "pair-pending" -> {
                            // The PC must show the same code we computed; if not, someone is in between.
                            if (!Proto.same(m.json.optString("code"), code)) {
                                sock.ws.close(1000, "code mismatch")
                                Hub.pairing.value = PairState.Failed("The codes did not match. Pairing stopped.")
                                return
                            }
                            Hub.pairing.value = PairState.AwaitingConfirm(code, m.json.optString("desktop", info.name))
                        }
                        "paired" -> {
                            val token = m.json.optString("token")
                            if (runCatching { Proto.fromB64url(token).size }.getOrDefault(0) != 32) {
                                Hub.pairing.value = PairState.Failed("The PC sent an invalid key.")
                                return
                            }
                            store.savePairing(Paired(m.json.optString("desktopId", info.desktopId), m.json.optString("desktop", info.name), info.fp, (listOf(host) + info.hosts).distinct(), info.port), token)
                            store.lastHost = host
                            Hub.pairing.value = PairState.Done(m.json.optString("desktop", info.name))
                            CompanionService.start(ctx)
                            wake.trySend(Unit)
                            return
                        }
                        "error" -> {
                            Hub.pairing.value = PairState.Failed(m.json.optString("message", "Pairing failed."))
                            return
                        }
                    }
                }
            }
        } finally {
            pairSocket = null
        }
    }

    /** The person's answer on the phone: do the codes match? */
    fun confirmPairing(accept: Boolean) {
        val s = pairSocket ?: return
        val st = Hub.pairing.value
        s.send(JSONObject().put("t", "pair-confirm").put("accept", accept))
        if (!accept) Hub.pairing.value = PairState.Failed("You declined the pairing.")
        else if (st is PairState.AwaitingConfirm) Hub.pairing.value = PairState.WaitingForPc(st.code, st.desktop)
    }

    // ---- the session -------------------------------------------------------

    private enum class End { Unreachable, Closed, Revoked, PausedByPc, AuthFailed }

    fun wakeUp() = wake.trySend(Unit)

    /** Runs for as long as the service does: connect, serve, reconnect. */
    suspend fun runForever() = coroutineScope {
        var failures = 0
        while (isActive) {
            val p = store.paired()
            when {
                p == null -> {
                    if (Hub.state.value !is LinkState.Revoked) Hub.state.value = LinkState.NotPaired
                    wake.receive()
                    continue
                }
                store.userPaused -> {
                    Hub.state.value = LinkState.PausedByUser
                    wake.receive()
                    continue
                }
            }
            val started = System.currentTimeMillis()
            val (end, why) = try {
                session(p!!)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                End.Closed to (e.message ?: "connection error")
            }
            if (System.currentTimeMillis() - started > 60_000) failures = 0
            when (end) {
                End.Revoked, End.AuthFailed -> {
                    store.clearPairing()
                    Hub.state.value = LinkState.Revoked(why)
                    continue
                }
                else -> {
                    // Bounded backoff; a network change or a tap wakes it early.
                    val wait = if (end == End.PausedByPc) 60_000L else listOf(2_000L, 5_000L, 10_000L, 30_000L, 60_000L)[failures.coerceAtMost(4)]
                    failures++
                    Hub.state.value = LinkState.Offline(why, System.currentTimeMillis() + wait)
                    withTimeoutOrNull(wait) { wake.receive() }
                }
            }
        }
    }

    private suspend fun session(p: Paired): Pair<End, String> = coroutineScope {
        val hosts = listOfNotNull(store.lastHost) + p.hosts
        val reached = reach(p.fp, hosts, p.port)
            ?: scan(p.fp, p.port)?.let { ip -> reach(p.fp, listOf(ip), p.port) }
            ?: return@coroutineScope End.Unreachable to "Can't reach ${p.desktopName}. Is it on, running JARVIS, and on this Wi-Fi?"
        val (sock, host) = reached
        current = sock
        try {
            val deviceId = store.deviceId
            val token = store.token() ?: return@coroutineScope End.AuthFailed to "The pairing key is missing. Pair again."
            sock.send(JSONObject().put("t", "hello").put("v", Proto.VERSION).put("mode", "auth").put("deviceId", deviceId))
            val ch = sock.next(10_000)
            if (ch !is Incoming.Message) return@coroutineScope End.Closed to "The PC did not answer."
            when (ch.json.optString("t")) {
                "challenge" -> Unit
                "error" -> return@coroutineScope errorEnd(ch.json)
                else -> return@coroutineScope End.Closed to "Unexpected reply from the PC."
            }
            sock.send(JSONObject().put("t", "auth").put("mac", Proto.authProof(token, deviceId, ch.json.optString("nonce"), p.fp)))
            val welcome = sock.next(10_000)
            if (welcome !is Incoming.Message) return@coroutineScope End.Closed to "The PC did not answer."
            if (welcome.json.optString("t") == "error") return@coroutineScope errorEnd(welcome.json)
            if (welcome.json.optString("t") != "welcome") return@coroutineScope End.Closed to "Unexpected reply from the PC."

            // Deadlines are the PC's clock; this is how far ours is from it.
            val offset = welcome.json.optLong("serverTime", System.currentTimeMillis()) - System.currentTimeMillis()
            store.lastHost = host
            store.lastConnected = System.currentTimeMillis()
            Hub.state.value = LinkState.Connected(welcome.json.optString("desktop", p.desktopName), host, System.currentTimeMillis())
            sendStatus()

            // Answers already given, by request id: a repeat gets the same answer, not a second action.
            val answered = object : LinkedHashMap<String, String>(256, 0.75f, true) {
                override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?) = size > 200
            }
            val running = ConcurrentHashMap<String, Job>()
            val statusTicker = launch {
                while (isActive) {
                    kotlinx.coroutines.delay(5 * 60_000L)
                    sendStatus()
                }
            }
            try {
                while (true) {
                    when (val m = sock.incoming.receiveCatching().getOrNull() ?: Incoming.Closed(-1, "connection lost")) {
                        is Incoming.Closed -> return@coroutineScope when (m.code) {
                            4001 -> End.PausedByPc to "Disconnected from the PC. Reconnect it in the JARVIS console."
                            4002 -> End.Revoked to "The PC revoked this pairing."
                            else -> End.Closed to "Connection to the PC lost."
                        }
                        is Incoming.Message -> {
                            val j = m.json
                            when (j.optString("t")) {
                                "req" -> serve(sock, j, offset, answered, running, this)
                                "cancel" -> running.remove(j.optString("id"))?.cancel()
                                "revoked" -> return@coroutineScope End.Revoked to "The PC revoked this pairing."
                            }
                        }
                    }
                }
                @Suppress("UNREACHABLE_CODE")
                End.Closed to ""
            } finally {
                statusTicker.cancel()
                running.values.forEach { it.cancel() }
            }
        } finally {
            current = null
            sock.ws.close(1000, null)
        }
    }

    private fun errorEnd(j: JSONObject): Pair<End, String> {
        val msg = j.optString("message", "The PC refused the connection.")
        return when (j.optString("code")) {
            "UNKNOWN_DEVICE", "AUTH_FAILED" -> End.AuthFailed to msg
            "PAUSED" -> End.PausedByPc to msg
            else -> End.Closed to msg
        }
    }

    private fun serve(sock: Socket, j: JSONObject, offset: Long, answered: LinkedHashMap<String, String>, running: ConcurrentHashMap<String, Job>, scope: CoroutineScope) {
        val id = j.optString("id")
        if (!Proto.UUID_RE.matches(id)) return
        synchronized(answered) { answered[id] }?.let { sock.sendText(it); return }
        if (running.containsKey(id)) return
        val reply = { ok: Boolean, body: JSONObject ->
            JSONObject().put("t", "res").put("id", id).put("ok", ok).put(if (ok) "result" else "error", body).toString()
        }
        val deadline = j.optLong("deadline", 0)
        if (deadline > 0 && System.currentTimeMillis() + offset > deadline) {
            sock.sendText(reply(false, JSONObject().put("code", "EXPIRED").put("message", "The request arrived too late.")))
            return
        }
        val op = j.optString("op")
        val args = j.optJSONObject("args") ?: JSONObject()
        running[id] = scope.launch(Dispatchers.IO) {
            val text = try {
                reply(true, actions.handle(op, args))
            } catch (e: CancellationException) {
                throw e
            } catch (e: ActionError) {
                reply(false, JSONObject().put("code", e.code).put("message", e.message ?: e.code))
            } catch (e: Exception) {
                reply(false, JSONObject().put("code", "FAILED").put("message", (e.message ?: "The phone could not do that.").take(300)))
            }
            synchronized(answered) { answered[id] = text }
            running.remove(id)
            sock.sendText(text)
        }
    }

    /** Battery, permissions and switches, as the console shows them. */
    fun sendStatus() {
        val s = current ?: return
        runCatching { s.send(actions.status().put("t", "status")) }
    }

    // ---- the person's controls ------------------------------------------------

    fun disconnect() {
        store.userPaused = true
        current?.ws?.close(1000, "user disconnected")
        wake.trySend(Unit)
    }

    fun resume() {
        store.userPaused = false
        wake.trySend(Unit)
    }

    /** Forget the PC here, and tell it to forget this phone if it can hear us. */
    fun forget() {
        current?.let {
            it.send(JSONObject().put("t", "bye").put("reason", "revoked"))
            it.ws.close(1000, "revoked")
        }
        store.clearPairing()
        Hub.state.value = LinkState.NotPaired
        Hub.pairing.value = PairState.Idle
        wake.trySend(Unit)
    }
}

/** A scope for work that outlives one screen. */
val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
