package com.jarvis.companion

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

private val Cyan = Color(0xFF19D8D2)
private val Amber = Color(0xFFFFB547)
private val Red = Color(0xFFFF6B6B)
private val Green = Color(0xFF3EF2A8)

class MainActivity : ComponentActivity() {
    /** Bumped on every resume, so permission states are re-read after a trip to Settings. */
    private val resumes = mutableIntStateOf(0)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Actions.ensureChannels(this)
        val link = Hub.link(this)
        if (link.store.paired() != null) CompanionService.start(this)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme(primary = Cyan, background = Color(0xFF05080C), surface = Color(0xFF0B1418))) {
                Screen(link, resumes.intValue)
            }
        }
    }

    override fun onResume() {
        super.onResume()
        AppVisibility.foreground = true
        resumes.intValue++
        Hub.link(this).sendStatus()
    }

    override fun onPause() {
        AppVisibility.foreground = false
        super.onPause()
    }
}

@Composable
private fun Screen(link: Link, resumeTick: Int) {
    val state by Hub.state.collectAsState()
    val pairing by Hub.pairing.collectAsState()
    Column(
        Modifier
            .fillMaxSize()
            .background(Color(0xFF05080C))
            .safeDrawingPadding()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("J.A.R.V.I.S · COMPANION", color = Cyan, fontWeight = FontWeight.Bold, letterSpacing = 3.sp, fontSize = 16.sp)
        PairingCard(link, pairing)
        ConnectionCard(link, state)
        PermissionsCard(link, resumeTick)
        Text(
            "Everything here works only on the same Wi-Fi as your PC. JARVIS asks you on the PC before it calls anyone or prepares a message, " +
                "and it never sends a WhatsApp message itself: you press send.",
            color = Color(0xFF8FA5A3),
            fontSize = 12.sp,
        )
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = Color(0xFF0B1418)), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, color = Color(0xFF6D8886), letterSpacing = 2.sp, fontSize = 12.sp)
            content()
        }
    }
}

@Composable
private fun PairingCard(link: Link, pairing: PairState) {
    val paired = link.store.paired() != null
    var pasted by remember { mutableStateOf("") }
    val scanner = rememberLauncherForActivityResult(ScanContract()) { r ->
        r.contents?.let { text -> appScope.launch { link.pair(text) } }
    }
    when (pairing) {
        is PairState.AwaitingConfirm -> Section("CONFIRM PAIRING") {
            Text("Does the PC show this code?", color = Color.White)
            Text(pairing.code.chunked(3).joinToString(" "), color = Cyan, fontSize = 40.sp, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
            Text("Approve only if it matches the code in the approval prompt on ${pairing.desktop}.", color = Color(0xFF8FA5A3), fontSize = 13.sp)
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Button(onClick = { link.confirmPairing(true) }) { Text("Codes match — confirm") }
                OutlinedButton(onClick = { link.confirmPairing(false) }) { Text("Cancel") }
            }
        }
        is PairState.WaitingForPc -> Section("CONFIRM PAIRING") {
            Text("Confirmed here. Now approve on ${pairing.desktop} (code ${pairing.code.chunked(3).joinToString(" ")}).", color = Color.White)
        }
        is PairState.Working -> Section("PAIRING") { Text(pairing.step, color = Color.White) }
        is PairState.Done -> Section("PAIRED") {
            Text("Paired with ${pairing.desktop}.", color = Green)
            TextButton(onClick = { Hub.pairing.value = PairState.Idle }) { Text("OK") }
        }
        is PairState.Failed, PairState.Idle -> if (!paired || pairing is PairState.Failed) {
            Section("PAIR WITH YOUR PC") {
                if (pairing is PairState.Failed) Text(pairing.message, color = Red, fontSize = 13.sp)
                Text("On the PC, press C in JARVIS → Connections → pair a phone (or say \"Jarvis, connect to my phone\"). Then scan the code it shows.", color = Color(0xFFCFE6E3), fontSize = 13.sp)
                Button(onClick = {
                    scanner.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt("Scan the pairing code on your PC").setBeepEnabled(false))
                }) { Text("Scan pairing code") }
                OutlinedTextField(value = pasted, onValueChange = { pasted = it.trim() }, label = { Text("…or paste the pairing link") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                if (pasted.isNotEmpty()) OutlinedButton(onClick = { appScope.launch { link.pair(pasted) } }) { Text("Pair with link") }
            }
        }
    }
}

@Composable
private fun ConnectionCard(link: Link, state: LinkState) {
    val paired = link.store.paired() ?: return
    val fmt = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT)
    Section("CONNECTION") {
        val (text, color) = when (state) {
            is LinkState.Connected -> "Connected to ${state.desktop} (${state.address}) · verified" to Green
            is LinkState.Connecting -> "Connecting to ${state.where}…" to Amber
            is LinkState.Offline -> "Not connected: ${state.reason}" to Amber
            LinkState.PausedByUser -> "Disconnected by you" to Amber
            is LinkState.Revoked -> "Pairing removed: ${state.reason}" to Red
            LinkState.NotPaired -> "Not paired" to Red
        }
        Text(text, color = color)
        Text("PC: ${paired.desktopName}", color = Color(0xFFCFE6E3), fontSize = 13.sp)
        val last = link.store.lastConnected
        Text("Last connected: ${if (last > 0) fmt.format(Date(last)) else "never"}", color = Color(0xFF8FA5A3), fontSize = 13.sp)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            if (state is LinkState.PausedByUser) {
                Button(onClick = { link.resume(); CompanionService.start(link.context) }) { Text("Reconnect") }
            } else {
                OutlinedButton(onClick = { link.wakeUp() }) { Text("Retry now") }
                OutlinedButton(onClick = { link.disconnect() }) { Text("Disconnect") }
            }
        }
        TextButton(onClick = { link.forget() }) { Text("Forget this PC (revoke access)", color = Red) }
    }
}

private data class Cap(val key: String, val title: String, val why: String, val perms: List<String>)

private val CAPS = listOf(
    Cap("contacts", "Contacts", "So \"call Rahul\" can find Rahul. Names and numbers only, on request.", listOf(Manifest.permission.READ_CONTACTS)),
    Cap("calls", "Calls", "Place a call after you approve it on the PC. Never emergency numbers.", listOf(Manifest.permission.CALL_PHONE)),
    Cap("location", "Location", "Your phone's position, only when you ask JARVIS for it.", listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)),
    Cap("whatsapp", "WhatsApp drafts", "Opens a chat with the message typed in. You press send.", emptyList()),
    Cap("notifications", "Notifications", "Reads the notifications currently showing, when asked. Needs notification access in Android settings.", emptyList()),
    Cap("sms", "Text messages (send)", "Sends an SMS only after you approve the exact recipient and text on the PC. Your carrier's normal SMS charges apply.", listOf(Manifest.permission.SEND_SMS)),
    Cap("sms_history", "Read recent texts", "Optional. Lets JARVIS read your latest SMS when you ask (\"show my recent messages\").", listOf(Manifest.permission.READ_SMS)),
)

@Composable
private fun PermissionsCard(link: Link, resumeTick: Int) {
    val ctx = link.context
    var tick by remember { mutableIntStateOf(0) }
    val refresh = resumeTick + tick
    val requester = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        tick++
        link.sendStatus()
    }
    fun granted(p: String) = ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED

    Section("WHAT JARVIS MAY DO ON THIS PHONE") {
        key(refresh) {
            CAPS.forEach { cap ->
                val on = link.store.enabled(cap.key)
                val androidOk = when (cap.key) {
                    "notifications" -> Actions(ctx, link.store).notificationAccess()
                    else -> cap.perms.isEmpty() || cap.perms.any { granted(it) }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(cap.title, color = Color.White)
                        Text(cap.why, color = Color(0xFF8FA5A3), fontSize = 12.sp)
                        if (on && !androidOk) Text("Android permission not granted", color = Amber, fontSize = 12.sp)
                    }
                    Switch(checked = on, onCheckedChange = { want ->
                        link.store.setEnabled(cap.key, want)
                        if (want) {
                            when {
                                cap.key == "notifications" && !androidOk -> ctx.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                                cap.perms.isNotEmpty() && !androidOk -> requester.launch(cap.perms.toTypedArray())
                            }
                        }
                        tick++
                        link.sendStatus()
                    })
                }
            }
            Spacer(Modifier.height(4.dp))
            val notifOk = Build.VERSION.SDK_INT < 33 || granted(Manifest.permission.POST_NOTIFICATIONS)
            val overlay = Settings.canDrawOverlays(ctx)
            Text(
                "Opening apps from the background: ${if (overlay) "allowed" else "off — JARVIS posts a notification for you to tap"}",
                color = Color(0xFFCFE6E3),
                fontSize = 13.sp,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (!notifOk) OutlinedButton(onClick = { requester.launch(arrayOf(Manifest.permission.POST_NOTIFICATIONS)) }) { Text("Allow notifications") }
                if (!overlay) OutlinedButton(onClick = {
                    ctx.startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${ctx.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }) { Text("Allow opening apps") }
            }
            TextButton(onClick = {
                ctx.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${ctx.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }) { Text("Revoke Android permissions (App info)") }
        }
    }
}

@Composable
private fun key(value: Int, content: @Composable () -> Unit) = androidx.compose.runtime.key(value) { content() }
