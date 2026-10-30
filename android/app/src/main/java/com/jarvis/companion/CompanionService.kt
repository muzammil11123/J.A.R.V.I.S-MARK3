package com.jarvis.companion

import android.Manifest
import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.IBinder
import android.service.notification.NotificationListenerService
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Keeps the link to the PC open while the app is in the background.
 *
 * A foreground service, so Android shows a notification for as long as JARVIS
 * can reach this phone: nothing about the connection is hidden. Its location
 * type is declared only when location permission has been granted, so the
 * phone's location can be read while the app is not on screen, and only then.
 */
class CompanionService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var netCallback: ConnectivityManager.NetworkCallback? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Actions.ensureChannels(this)
        goForeground("Starting…")
        val link = Hub.link(this)
        scope.launch { link.runForever() }
        scope.launch {
            Hub.state.collect { s ->
                val text = when (s) {
                    is LinkState.Connected -> "Connected to ${s.desktop}"
                    is LinkState.Connecting -> "Connecting to ${s.where}…"
                    is LinkState.Offline -> "Not connected: ${s.reason}"
                    LinkState.PausedByUser -> "Disconnected. Open the app to reconnect."
                    LinkState.NotPaired -> "Not paired with a PC"
                    is LinkState.Revoked -> "Pairing removed: ${s.reason}"
                }
                NotificationManagerCompat.from(this@CompanionService).let { nm ->
                    if (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(this@CompanionService, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
                        nm.notify(NOTIFICATION_ID, notification(text))
                    }
                }
            }
        }
        // Back on Wi-Fi: try at once instead of waiting out the backoff.
        val cm = getSystemService(ConnectivityManager::class.java)
        netCallback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                link.wakeUp()
            }
        }.also { cm?.registerDefaultNetworkCallback(it) }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_WAKE) Hub.link(this).wakeUp()
        return START_STICKY
    }

    override fun onDestroy() {
        netCallback?.let { runCatching { getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(it) } }
        scope.cancel()
        super.onDestroy()
    }

    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, Actions.CHANNEL_LINK)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentTitle("JARVIS link")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(open)
            .build()
    }

    private fun goForeground(text: String) {
        var types = 0
        if (Build.VERSION.SDK_INT >= 29) {
            types = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
            val loc = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
                ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
            if (loc && SecureStore(this).enabled("location")) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
        }
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(text), types)
        } catch (e: Exception) {
            // Location type refused (started from the background): run without it.
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(text), if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE else 0)
        }
    }

    companion object {
        private const val NOTIFICATION_ID = 7
        const val ACTION_WAKE = "com.jarvis.companion.WAKE"

        fun start(ctx: Context) {
            ContextCompat.startForegroundService(ctx, Intent(ctx, CompanionService::class.java).setAction(ACTION_WAKE))
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, CompanionService::class.java))
        }
    }
}

/**
 * Reads the notifications Android shows right now, when the person has given
 * this app notification access in Android settings. It keeps nothing: the PC
 * asks, it looks, it answers.
 */
class JarvisNotificationListener : NotificationListenerService() {
    override fun onListenerConnected() {
        instance = this
    }

    override fun onListenerDisconnected() {
        instance = null
    }

    companion object {
        @Volatile var instance: JarvisNotificationListener? = null
    }
}

/** After a restart, reconnect to the paired PC unless the person disconnected it. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val store = SecureStore(context)
        if (store.paired() != null && !store.userPaused) CompanionService.start(context)
    }
}
