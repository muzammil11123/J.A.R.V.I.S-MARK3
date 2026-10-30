package com.jarvis.companion

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.media.AudioManager
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.CancellationSignal
import android.os.SystemClock
import android.provider.ContactsContract
import android.provider.Settings
import android.telecom.TelecomManager
import android.telephony.TelephonyManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.concurrent.Executors
import kotlin.coroutines.resume

/** A refusal with a code the PC understands and a sentence a person does. */
class ActionError(val code: String, message: String) : Exception(message)

/** Whether the app's own screen is in front, which lets it open other apps. */
object AppVisibility {
    @Volatile var foreground = false
}

/**
 * The only things the PC can ask this phone to do. There is no generic
 * "run this" operation: an unknown op is refused, and every op checks two
 * switches before acting — the capability is on in this app, and Android
 * has granted the permission it needs.
 */
class Actions(private val ctx: Context, private val store: SecureStore) {

    suspend fun handle(op: String, args: JSONObject): JSONObject = when (op) {
        "status.get" -> status()
        "contacts.search" -> contacts(args)
        "call.dial" -> dial(args)
        "call.place" -> placeCall(args)
        "location.get" -> location(args)
        "whatsapp.prepare" -> whatsapp(args)
        "notifications.list" -> notifications(args)
        "sms.draft" -> smsDraft(args)
        "sms.send" -> smsSend(args)
        "sms.list" -> smsList(args)
        else -> throw ActionError("UNSUPPORTED", "The phone app does not support \"$op\".")
    }

    // ---- permissions -----------------------------------------------------

    private fun granted(p: String) = ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED

    private fun need(cap: String, vararg perms: String) {
        if (!store.enabled(cap)) throw ActionError("CAPABILITY_DISABLED", "${cap.replaceFirstChar { it.uppercase() }} is switched off in the JARVIS companion app.")
        if (perms.isNotEmpty() && perms.none { granted(it) }) {
            throw ActionError("PERMISSION_DENIED", "Android has not granted the $cap permission to the JARVIS companion app. Open the app and allow it.")
        }
    }

    fun notificationAccess(): Boolean = NotificationManagerCompat.getEnabledListenerPackages(ctx).contains(ctx.packageName)

    /** What the console shows: Android's answer for each capability. */
    fun permissionStates(): JSONObject = JSONObject()
        .put("contacts", if (granted(Manifest.permission.READ_CONTACTS)) "granted" else "denied")
        .put("calls", if (granted(Manifest.permission.CALL_PHONE)) "granted" else "denied")
        .put("location", when {
            granted(Manifest.permission.ACCESS_FINE_LOCATION) -> "granted"
            granted(Manifest.permission.ACCESS_COARSE_LOCATION) -> "approximate"
            else -> "denied"
        })
        .put("notifications", if (notificationAccess()) "granted" else "denied")
        .put("whatsapp", if (whatsappPackage() != null) "granted" else "not_installed")
        .put("open_apps", if (Settings.canDrawOverlays(ctx)) "granted" else "notification_only")
        .put("sms", if (granted(Manifest.permission.SEND_SMS)) "granted" else "denied")
        .put("sms_history", if (granted(Manifest.permission.READ_SMS)) "granted" else "denied")

    fun status(): JSONObject {
        val battery = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = battery?.let {
            val l = it.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            val s = it.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
            if (l >= 0 && s > 0) (l * 100 / s) else null
        }
        val charging = battery?.getIntExtra(BatteryManager.EXTRA_STATUS, -1)?.let {
            it == BatteryManager.BATTERY_STATUS_CHARGING || it == BatteryManager.BATTERY_STATUS_FULL
        }
        val enabled = JSONObject()
        SecureStore.CAPABILITIES.forEach { enabled.put(it, store.enabled(it)) }
        return JSONObject()
            .put("battery", JSONObject().put("level", level ?: JSONObject.NULL).put("charging", charging ?: JSONObject.NULL))
            .put("permissions", permissionStates())
            .put("enabled", enabled)
            .put("app", BuildConfigVersion.NAME)
    }

    // ---- contacts --------------------------------------------------------

    private fun contacts(args: JSONObject): JSONObject {
        need("contacts", Manifest.permission.READ_CONTACTS)
        val q = args.optString("query").trim()
        if (q.isEmpty() || q.length > 80) throw ActionError("INVALID_ARGS", "Give a name to search for.")
        // Parameterised, with LIKE wildcards in the name escaped.
        val like = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        val out = JSONArray()
        ctx.contentResolver.query(
            ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
            arrayOf(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME, ContactsContract.CommonDataKinds.Phone.NUMBER),
            "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} LIKE ? ESCAPE '\\'",
            arrayOf(like),
            "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} ASC",
        )?.use { c ->
            while (c.moveToNext() && out.length() < 25) {
                out.put(JSONObject().put("name", c.getString(0) ?: "").put("number", c.getString(1) ?: ""))
            }
        }
        return JSONObject().put("contacts", out)
    }

    // ---- calls -----------------------------------------------------------

    private fun number(args: JSONObject): String {
        val n = args.optString("number").replace(Regex("[\\s().-]"), "")
        if (!Regex("^\\+?\\d{2,15}$").matches(n)) throw ActionError("INVALID_ARGS", "That is not a valid phone number.")
        return n
    }

    private fun isEmergency(n: String): Boolean {
        val digits = n.removePrefix("+")
        if (digits in setOf("911", "112", "999", "000", "100", "101", "102", "108", "110", "119", "118", "15", "17", "18") || Regex("^(1|9|0)\\d{1,2}$").matches(digits)) return true
        return try {
            Build.VERSION.SDK_INT >= 29 && (ctx.getSystemService(TelephonyManager::class.java)?.isEmergencyNumber(n) == true)
        } catch (e: Exception) {
            false
        }
    }

    private fun dial(args: JSONObject): JSONObject {
        need("calls")
        val n = number(args)
        return JSONObject().put("status", launch(Intent(Intent.ACTION_DIAL, Uri.parse("tel:$n")), "Tap to open the dialer", "Number ready: $n"))
    }

    private suspend fun placeCall(args: JSONObject): JSONObject {
        need("calls", Manifest.permission.CALL_PHONE)
        val n = number(args)
        // Never, whatever the PC says. The PC refuses these too; this is the second lock.
        if (isEmergency(n)) throw ActionError("EMERGENCY_REFUSED", "Emergency and short-code numbers are never called automatically. Dial it yourself.")
        val telecom = ctx.getSystemService(TelecomManager::class.java) ?: throw ActionError("UNSUPPORTED", "This phone cannot place calls.")
        try {
            telecom.placeCall(Uri.fromParts("tel", n, null), null)
        } catch (e: SecurityException) {
            throw ActionError("PERMISSION_DENIED", "Android refused the call: ${e.message}")
        }
        // Read back whether audio went into call mode, rather than assume it.
        delay(2500)
        val mode = ctx.getSystemService(AudioManager::class.java)?.mode
        val dialing = mode == AudioManager.MODE_IN_CALL || mode == AudioManager.MODE_IN_COMMUNICATION
        return JSONObject().put("status", if (dialing) "dialing" else "requested")
    }

    // ---- location --------------------------------------------------------

    private suspend fun location(args: JSONObject): JSONObject {
        need("location", Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        val lm = ctx.getSystemService(LocationManager::class.java) ?: throw ActionError("UNSUPPORTED", "No location service.")
        if (!LocationManagerCompat.isLocationEnabled(lm)) throw ActionError("LOCATION_OFF", "Location is turned off on the phone. JARVIS will not turn it on.")
        var fix: Location? = null
        var fresh = false
        try {
            if (args.optBoolean("fresh", true)) {
                val provider = when {
                    Build.VERSION.SDK_INT >= 31 && lm.hasProvider(LocationManager.FUSED_PROVIDER) -> LocationManager.FUSED_PROVIDER
                    lm.isProviderEnabled(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
                    else -> LocationManager.NETWORK_PROVIDER
                }
                fix = withTimeoutOrNull(20_000) { currentLocation(lm, provider) }
                fresh = fix != null
            }
            if (fix == null) {
                fix = lm.getProviders(true).mapNotNull { lm.getLastKnownLocation(it) }.maxByOrNull { it.elapsedRealtimeNanos }
            }
        } catch (e: SecurityException) {
            throw ActionError("PERMISSION_DENIED", "Android refused location access. If the app was started in the background, open it once.")
        }
        val f = fix ?: throw ActionError("NOT_FOUND", "The phone has no location fix yet. Try again outdoors, or open a maps app.")
        val ageSeconds = (SystemClock.elapsedRealtimeNanos() - f.elapsedRealtimeNanos) / 1_000_000_000L
        return JSONObject()
            .put("latitude", f.latitude)
            .put("longitude", f.longitude)
            .put("accuracy_m", if (f.hasAccuracy()) f.accuracy.toDouble() else JSONObject.NULL)
            .put("fixed_at", Instant.ofEpochMilli(f.time).toString())
            .put("age_seconds", ageSeconds)
            .put("provider", f.provider ?: "unknown")
            .put("fresh", fresh)
            .put("stale", ageSeconds > 15 * 60)
            .put("precision", if (granted(Manifest.permission.ACCESS_FINE_LOCATION)) "precise" else "approximate")
    }

    @Suppress("MissingPermission")
    private suspend fun currentLocation(lm: LocationManager, provider: String): Location? = suspendCancellableCoroutine { cont ->
        val signal = CancellationSignal()
        cont.invokeOnCancellation { signal.cancel() }
        LocationManagerCompat.getCurrentLocation(lm, provider, signal, Executors.newSingleThreadExecutor()) { loc ->
            if (cont.isActive) cont.resume(loc)
        }
    }

    // ---- WhatsApp --------------------------------------------------------

    private fun whatsappPackage(): String? = listOf("com.whatsapp", "com.whatsapp.w4b").firstOrNull {
        try {
            ctx.packageManager.getPackageInfo(it, 0)
            true
        } catch (e: PackageManager.NameNotFoundException) {
            false
        }
    }

    /** Opens the chat with the text typed in. Never sends: the person does. */
    private fun whatsapp(args: JSONObject): JSONObject {
        need("whatsapp")
        val digits = args.optString("phone")
        if (!Regex("^\\d{8,15}$").matches(digits)) throw ActionError("INVALID_ARGS", "WhatsApp needs a full international number.")
        val text = args.optString("text")
        if (text.length > 4000) throw ActionError("INVALID_ARGS", "The message is too long.")
        val pkg = whatsappPackage() ?: throw ActionError("NOT_FOUND", "WhatsApp is not installed on the phone.")
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://wa.me/$digits?text=${Uri.encode(text)}")).setPackage(pkg)
        return JSONObject().put("status", launch(intent, "Tap to open WhatsApp", "Message ready for +$digits. You press send."))
    }

    // ---- notifications ---------------------------------------------------

    private fun notifications(args: JSONObject): JSONObject {
        need("notifications")
        if (!notificationAccess()) throw ActionError("PERMISSION_DENIED", "Notification access is not enabled for the JARVIS companion app in Android settings.")
        val listener = JarvisNotificationListener.instance ?: throw ActionError("FAILED", "Android has not connected the notification reader yet. Try again in a moment.")
        val limit = args.optInt("limit", 15).coerceIn(1, 50)
        val out = JSONArray()
        // Only what Android shows right now. There is no history to read.
        listener.activeNotifications
            ?.filter { it.packageName != ctx.packageName && !it.isOngoing }
            ?.sortedByDescending { it.postTime }
            ?.take(limit)
            ?.forEach { sbn ->
                val extras = sbn.notification.extras
                out.put(
                    JSONObject()
                        .put("app", sbn.packageName)
                        .put("title", extras.getCharSequence("android.title")?.toString()?.take(200) ?: "")
                        .put("text", extras.getCharSequence("android.text")?.toString()?.take(500) ?: "")
                        .put("posted_at", Instant.ofEpochMilli(sbn.postTime).toString()),
                )
            }
        return JSONObject().put("notifications", out)
    }

    // ---- SMS --------------------------------------------------------------

    private fun smsArgs(args: JSONObject): Pair<String, String> {
        val n = args.optString("number").replace(Regex("[\\s().-]"), "")
        val why = SmsRules.refuse(n)
        if (why != null) throw ActionError(if (why.startsWith("emergency")) "EMERGENCY_REFUSED" else "INVALID_ARGS", why)
        val text = args.optString("text")
        if (text.isBlank() || text.length > SmsRules.MAX_TEXT) throw ActionError("INVALID_ARGS", "The message must be 1 to ${SmsRules.MAX_TEXT} characters.")
        return n to text
    }

    /** Opens the messages app with the text typed in. Nothing is sent. */
    private fun smsDraft(args: JSONObject): JSONObject {
        need("sms")
        val (n, text) = smsArgs(args)
        val intent = Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:${Uri.encode(n)}")).putExtra("sms_body", text)
        return JSONObject().put("status", launch(intent, "Tap to open your text message", "Message ready for $n. You press send."))
    }

    /**
     * Sends through Android's SmsManager and reports what the phone itself
     * observed: each part's "sent" broadcast (the radio handed it to the
     * network) and, if the carrier provides one, the delivery report. Nothing
     * is claimed that the phone did not see.
     */
    @Suppress("MissingPermission")
    private suspend fun smsSend(args: JSONObject): JSONObject {
        need("sms", Manifest.permission.SEND_SMS)
        val (n, text) = smsArgs(args)
        val sms = (if (Build.VERSION.SDK_INT >= 31) ctx.getSystemService(android.telephony.SmsManager::class.java) else null)
            ?: @Suppress("DEPRECATION") android.telephony.SmsManager.getDefault()
        val parts = sms.divideMessage(text)
        val tag = "com.jarvis.companion.SMS_${System.nanoTime()}"
        val sentAction = "$tag.SENT"
        val deliveredAction = "$tag.DELIVERED"
        val sentCodes = java.util.concurrent.ConcurrentLinkedQueue<Int>()
        var delivered = 0
        val allSent = kotlinx.coroutines.CompletableDeferred<Unit>()
        val anyDelivered = kotlinx.coroutines.CompletableDeferred<Unit>()
        val receiver = object : android.content.BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) {
                when (i.action) {
                    sentAction -> {
                        sentCodes.add(resultCode)
                        if (sentCodes.size >= parts.size) allSent.complete(Unit)
                    }
                    deliveredAction -> {
                        delivered++
                        if (delivered >= parts.size) anyDelivered.complete(Unit)
                    }
                }
            }
        }
        val filter = IntentFilter().apply { addAction(sentAction); addAction(deliveredAction) }
        ContextCompat.registerReceiver(ctx, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        try {
            val pending = { action: String, i: Int ->
                PendingIntent.getBroadcast(ctx, i, Intent(action).setPackage(ctx.packageName), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_ONE_SHOT)
            }
            val sentIntents = ArrayList(parts.indices.map { pending(sentAction, it) })
            val deliveryIntents = ArrayList(parts.indices.map { pending(deliveredAction, 1000 + it) })
            try {
                sms.sendMultipartTextMessage(n, null, parts, sentIntents, deliveryIntents)
            } catch (e: SecurityException) {
                throw ActionError("PERMISSION_DENIED", "Android refused to send: ${e.message}")
            } catch (e: Exception) {
                throw ActionError("FAILED", "The phone could not send the message: ${e.message}")
            }
            // From here the message is the radio's. Report what it says.
            val confirmed = withTimeoutOrNull(45_000) { allSent.await() } != null
            if (!confirmed) {
                return JSONObject().put("status", "handed_to_android").put("parts", parts.size)
                    .put("note", "Android accepted the message but has not reported it sent yet.")
            }
            val failures = sentCodes.filter { it != android.app.Activity.RESULT_OK }
            if (failures.isNotEmpty()) {
                throw ActionError("FAILED", "The phone could not send it: ${SmsRules.describe(failures.first())}.")
            }
            val gotReport = withTimeoutOrNull(10_000) { anyDelivered.await() } != null
            return JSONObject().put("status", "sent").put("parts", parts.size)
                .put("delivered", if (gotReport) true else JSONObject.NULL)
        } finally {
            runCatching { ctx.unregisterReceiver(receiver) }
        }
    }

    /** The latest texts Android stores, newest first. Read only, when allowed. */
    private fun smsList(args: JSONObject): JSONObject {
        need("sms_history", Manifest.permission.READ_SMS)
        val limit = args.optInt("limit", 10).coerceIn(1, 50)
        val number = args.optString("number").replace(Regex("[\\s().-]"), "").takeLast(10)
        val out = JSONArray()
        ctx.contentResolver.query(
            android.provider.Telephony.Sms.CONTENT_URI,
            arrayOf(android.provider.Telephony.Sms.ADDRESS, android.provider.Telephony.Sms.BODY, android.provider.Telephony.Sms.DATE, android.provider.Telephony.Sms.TYPE),
            if (number.length >= 6) "${android.provider.Telephony.Sms.ADDRESS} LIKE ?" else null,
            if (number.length >= 6) arrayOf("%$number") else null,
            "${android.provider.Telephony.Sms.DATE} DESC",
        )?.use { c ->
            while (c.moveToNext() && out.length() < limit) {
                out.put(
                    JSONObject()
                        .put("from_or_to", c.getString(0) ?: "")
                        .put("text", (c.getString(1) ?: "").take(500))
                        .put("at", Instant.ofEpochMilli(c.getLong(2)).toString())
                        .put("direction", when (c.getInt(3)) {
                            android.provider.Telephony.Sms.MESSAGE_TYPE_INBOX -> "received"
                            android.provider.Telephony.Sms.MESSAGE_TYPE_SENT -> "sent"
                            android.provider.Telephony.Sms.MESSAGE_TYPE_OUTBOX, android.provider.Telephony.Sms.MESSAGE_TYPE_QUEUED -> "sending"
                            android.provider.Telephony.Sms.MESSAGE_TYPE_FAILED -> "failed"
                            else -> "other"
                        }),
                )
            }
        } ?: throw ActionError("FAILED", "Android did not return the message list.")
        return JSONObject().put("messages", out)
    }

    // ---- opening another app --------------------------------------------

    /**
     * Android stops background apps opening screens. If this app is in front,
     * or the user granted "display over other apps", it opens directly;
     * otherwise a notification is posted for the person to tap. The PC is told
     * which happened.
     */
    private fun launch(intent: Intent, title: String, text: String): String {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (AppVisibility.foreground || Settings.canDrawOverlays(ctx)) {
            ctx.startActivity(intent)
            return "opened"
        }
        if (Build.VERSION.SDK_INT >= 33 && !granted(Manifest.permission.POST_NOTIFICATIONS)) {
            throw ActionError("PERMISSION_DENIED", "The phone app may not open other apps from the background or post notifications. Allow one of them in the app.")
        }
        ensureChannels(ctx)
        val pi = PendingIntent.getActivity(ctx, (System.nanoTime() and 0xffff).toInt(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = NotificationCompat.Builder(ctx, CHANNEL_ACTIONS)
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setContentTitle(title)
            .setContentText(text)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        ctx.getSystemService(NotificationManager::class.java)?.notify((System.currentTimeMillis() and 0xfffffff).toInt(), n)
        return "notification_posted"
    }

    companion object {
        const val CHANNEL_LINK = "link"
        const val CHANNEL_ACTIONS = "actions"

        fun ensureChannels(ctx: Context) {
            val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
            nm.createNotificationChannel(NotificationChannel(CHANNEL_LINK, "Connection to PC", NotificationManager.IMPORTANCE_LOW))
            nm.createNotificationChannel(NotificationChannel(CHANNEL_ACTIONS, "Actions from JARVIS", NotificationManager.IMPORTANCE_HIGH))
        }
    }
}

object BuildConfigVersion {
    const val NAME = "1.1.0"
}

/** SMS rules with no Android in them, so they can be unit tested. */
object SmsRules {
    const val MAX_TEXT = 1000

    /**
     * Why this number must not be texted automatically, or null if it may be.
     * Short codes are refused as well as emergency numbers: they include
     * premium-rate services that charge per message.
     */
    fun refuse(number: String): String? {
        val digits = number.removePrefix("+")
        if (!Regex("^\\d{2,15}$").matches(digits)) return "That is not a valid phone number."
        if (digits in setOf("911", "112", "999", "000", "100", "101", "102", "108", "110", "119", "118", "15", "17", "18") ||
            Regex("^(1|9|0)\\d{1,2}$").matches(digits)
        ) return "emergency numbers are never texted automatically."
        if (digits.length < 7) return "Short codes are never texted automatically: they can be premium-rate services."
        return null
    }

    /** SmsManager's sent-result codes, in words. */
    fun describe(code: Int): String = when (code) {
        1 -> "generic failure"
        2 -> "the radio is off (airplane mode?)"
        3 -> "no message service (null PDU)"
        4 -> "no mobile service"
        5 -> "limit exceeded"
        else -> "error code $code"
    }
}
