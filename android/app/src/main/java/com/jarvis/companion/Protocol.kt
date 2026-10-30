package com.jarvis.companion

import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * The wire protocol's primitives. Every function here has a twin in
 * bridge/phone/companion.mjs, and ProtocolTest checks them against vectors
 * produced by that code, so the two sides cannot drift apart silently.
 */
object Proto {
    const val VERSION = 1
    private val rng = SecureRandom()

    fun b64url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    fun fromB64url(s: String): ByteArray = Base64.getUrlDecoder().decode(s)
    fun random(n: Int): ByteArray = ByteArray(n).also { rng.nextBytes(it) }

    fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)
    fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }

    fun hmacHex(key: ByteArray, text: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return hex(mac.doFinal(text.toByteArray(Charsets.UTF_8)))
    }

    /** SHA-256 of a certificate's DER bytes, lower-case hex: the pin. */
    fun fingerprint(der: ByteArray): String = hex(sha256(der))

    fun pairProof(secret: String, pid: String, deviceId: String, nonce: String, fp: String): String =
        hmacHex(fromB64url(secret), "pair|$pid|$deviceId|$nonce|$fp")

    fun authProof(token: String, deviceId: String, nonce: String, fp: String): String =
        hmacHex(fromB64url(token), "auth|$deviceId|$nonce|$fp")

    /** The six digits both screens show while pairing. */
    fun verificationCode(secret: String, deviceId: String, nonce: String): String {
        val h = sha256("sas|$secret|$deviceId|$nonce".toByteArray(Charsets.UTF_8))
        val v = ((h[0].toLong() and 0xff) shl 24) or ((h[1].toLong() and 0xff) shl 16) or
            ((h[2].toLong() and 0xff) shl 8) or (h[3].toLong() and 0xff)
        return (v % 1_000_000).toString().padStart(6, '0')
    }

    /** Constant-time comparison. */
    fun same(a: String, b: String): Boolean = MessageDigest.isEqual(a.toByteArray(), b.toByteArray())

    val UUID_RE = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
}

/** What the PC's QR code says: where it is, who it is, and the one-time secret. */
data class PairingInfo(
    val pid: String,
    val secret: String,
    val fp: String,
    val hosts: List<String>,
    val port: Int,
    val name: String,
    val desktopId: String,
) {
    companion object {
        private val IPV4 = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$")

        /** Parses and checks a `jarvis-pair:` link. Throws with a reason a person can read. */
        fun parse(raw: String): PairingInfo {
            val text = raw.trim()
            require(text.startsWith("jarvis-pair:")) { "That is not a JARVIS pairing code." }
            val json = try {
                JSONObject(String(Proto.fromB64url(text.removePrefix("jarvis-pair:")), Charsets.UTF_8))
            } catch (e: Exception) {
                throw IllegalArgumentException("The pairing code is damaged. Scan it again.")
            }
            require(json.optInt("v") == Proto.VERSION) { "This pairing code is from a different JARVIS version." }
            val fp = json.optString("fp")
            require(Regex("^[0-9a-f]{64}$").matches(fp)) { "The pairing code has no valid certificate fingerprint." }
            val secret = json.optString("s")
            require(runCatching { Proto.fromB64url(secret).size == 32 }.getOrDefault(false)) { "The pairing code has no valid secret." }
            val pid = json.optString("pid")
            require(pid.length in 8..64) { "The pairing code has no valid id." }
            val port = json.optInt("port")
            require(port in 1..65535) { "The pairing code has no valid port." }
            val arr = json.optJSONArray("hosts")
            val hosts = (0 until (arr?.length() ?: 0)).map { arr!!.optString(it) }.filter { h ->
                IPV4.matchEntire(h)?.groupValues?.drop(1)?.all { (it.toIntOrNull() ?: 999) in 0..255 } == true
            }
            require(hosts.isNotEmpty()) { "The pairing code has no address for the PC." }
            return PairingInfo(pid, secret, fp, hosts, port, json.optString("name", "JARVIS PC").take(60), json.optString("did"))
        }
    }
}
