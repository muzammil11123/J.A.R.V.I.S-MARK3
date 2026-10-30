package com.jarvis.companion

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** The PC this phone is paired with. The key is stored separately, encrypted. */
data class Paired(
    val desktopId: String,
    val desktopName: String,
    val fp: String,
    val hosts: List<String>,
    val port: Int,
)

/**
 * Everything the app remembers.
 *
 * The pairing key is encrypted with an AES key that lives in the Android
 * Keystore and never leaves it; what sits in SharedPreferences is ciphertext.
 * Backups are switched off in the manifest, so a key cannot travel to another
 * phone that way either.
 */
class SecureStore(context: Context) {
    private val prefs = context.getSharedPreferences("jarvis", Context.MODE_PRIVATE)

    private fun keystoreKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    private fun putSecret(name: String, value: String) {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, keystoreKey())
        val ct = c.doFinal(value.toByteArray(Charsets.UTF_8))
        prefs.edit().putString(name, Proto.b64url(c.iv + ct)).apply()
    }

    private fun getSecret(name: String): String? = try {
        val all = Proto.fromB64url(prefs.getString(name, null) ?: return null)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, keystoreKey(), GCMParameterSpec(128, all.copyOfRange(0, 12)))
        String(c.doFinal(all.copyOfRange(12, all.size)), Charsets.UTF_8)
    } catch (e: Exception) {
        null
    }

    /** Random, made once per install. Identifies this phone to the PC; not a secret. */
    val deviceId: String
        get() = prefs.getString("device_id", null) ?: Proto.b64url(Proto.random(18)).also {
            prefs.edit().putString("device_id", it).apply()
        }

    fun paired(): Paired? {
        val raw = prefs.getString("paired", null) ?: return null
        if (token() == null) return null
        return runCatching {
            val j = JSONObject(raw)
            val arr = j.getJSONArray("hosts")
            Paired(j.getString("did"), j.getString("name"), j.getString("fp"), (0 until arr.length()).map { arr.getString(it) }, j.getInt("port"))
        }.getOrNull()
    }

    fun savePairing(p: Paired, token: String) {
        putSecret("token", token)
        prefs.edit().putString(
            "paired",
            JSONObject().put("did", p.desktopId).put("name", p.desktopName).put("fp", p.fp)
                .put("hosts", JSONArray(p.hosts)).put("port", p.port).toString(),
        ).putBoolean("user_paused", false).apply()
    }

    fun token(): String? = getSecret("token")

    /** Forget the PC: its address, its pin and the key. */
    fun clearPairing() {
        prefs.edit().remove("paired").remove("token").remove("last_host").remove("last_connected").apply()
    }

    var lastHost: String?
        get() = prefs.getString("last_host", null)
        set(v) = prefs.edit().putString("last_host", v).apply()

    var lastConnected: Long
        get() = prefs.getLong("last_connected", 0)
        set(v) = prefs.edit().putLong("last_connected", v).apply()

    /** The user pressed Disconnect in the app. */
    var userPaused: Boolean
        get() = prefs.getBoolean("user_paused", false)
        set(v) = prefs.edit().putBoolean("user_paused", v).apply()

    /** A capability the user has switched on in this app. All start off. */
    fun enabled(cap: String): Boolean = prefs.getBoolean("cap_$cap", false)
    fun setEnabled(cap: String, on: Boolean) = prefs.edit().putBoolean("cap_$cap", on).apply()

    companion object {
        private const val ALIAS = "jarvis_companion_key"
        val CAPABILITIES = listOf("contacts", "calls", "location", "whatsapp", "notifications", "sms", "sms_history")
    }
}
