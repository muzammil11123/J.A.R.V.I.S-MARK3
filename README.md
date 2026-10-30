# J.A.R.V.I.S.

A browser voice assistant with an Iron Man holographic interface. Say
**"Hey Jarvis"**, he wakes, listens, and does real things through your tools —
searches the web, generates images, drives your phone, reads your mail. The face
is a web page (React + Vite + Three.js + custom GLSL). The brain is Claude Code,
run headless as a library.

**The only subscription you need is Claude Code.** No API keys, no OpenAI
account, no cloud bill — the brain runs on your existing Claude Code login, and
the heavy work (the model itself) runs on Anthropic's servers, so even a low-end
laptop only has to draw the interface. **ElevenLabs is an optional add-on** that
gives JARVIS a much better voice and sharper hearing; without it he speaks and
listens through the browser's own speech, and everything still works.

---

## Requirements

**In one line:** a Claude Code subscription, plus two free things every computer
can have — Node.js and Chrome. That's the whole list.

- **Claude Code, installed and logged in** — this is the only account you need.
  Install it with the official method — `npm install -g @anthropic-ai/claude-code`,
  or the platform installer at <https://docs.claude.com/en/docs/claude-code> —
  then run `claude` once and complete login. The bridge reuses that login. **No
  API key**, and usage is billed to your existing Claude account.
- **Node.js 20 or newer** — free, one installer from <https://nodejs.org>. This
  is a Node web app, so it is the one unavoidable tool.
- **Google Chrome or Microsoft Edge**, in a **real browser window** — not an
  embedded preview pane. Preview panes (including the one inside editors and
  Claude Code) block microphone access, so the page loads and looks right but
  never hears you. JARVIS also needs WebGL, which these browsers provide.
- **Optional: an ElevenLabs API key** — a good add-on, not a requirement. It
  gives a better voice and sharper transcription; the free tier is plenty for a
  demo. Without it, everything runs on the browser's own speech.

Run `npm run setup` after cloning and it checks all of this for you, in plain
language.

---

## Quick start

First, install, then start it:

```bash
npm install
npm start          # runs the brain and the face together
```

Then open the URL it prints (http://localhost:5173) in **Chrome**, click **INITIALISE**, and say **“Hey Jarvis”**.

Prefer two terminals? Run them separately instead:

```bash
npm install
```

Terminal 1 — the brain:

```bash
npm run bridge
```

Terminal 2 — the face:

```bash
npm run dev
```

Then open the app in a **real Chrome or Edge window**:

```bash
open http://localhost:5173
```

Click **INITIALISE**, allow the microphone when asked, and say **"Hey Jarvis"**.

> It has to be a real browser window. Embedded preview panes block the
> microphone, so JARVIS will look perfectly alive and simply never respond.

---

## How it works

JARVIS is two processes. The browser is the face and the voice; the bridge is
the brain and the hands.

```
  ┌─ browser (the face) ───────────────┐        ┌─ bridge (the brain) ─────────────┐
  │  "Hey Jarvis" wake word            │        │  Node · bridge/server.mjs        │
  │  local VAD  →  speech to text      │   ws   │  Claude Agent SDK                │
  │  reactor UI (Three.js + GLSL)      │◄─────► │   = Claude Code, headless        │
  │  text to speech                    │  8787  │  spawns your MCP servers         │
  │  heads-up display                  │        │  permission gate (decideTool)    │
  └────────────────────────────────────┘        └──────────────────────────────────┘
```

Everything you see and hear happens in the browser. The bridge is a single Node
process (`bridge/server.mjs`) that runs the **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`) — this spawns the real `claude` CLI as a child
process, so **the brain literally is Claude Code, headless.** They talk over a
WebSocket (plus a few HTTP endpoints) on `ws://localhost:8787`.

**Why a bridge at all?** A browser tab cannot spawn the local stdio MCP servers —
`higgsfield`, `elevenlabs`, `android`, `playwright`, `exa`, `serper`, and the
rest. The bridge can. And because it is the Agent SDK, it authenticates off your
existing Claude Code login: no API key, billed to that same Claude account.

**The model.** `claude-opus-5` at effort `medium` by default. Override with the
`JARVIS_MODEL` and `JARVIS_EFFORT` environment variables. On startup the bridge
prints its choice, e.g. `[jarvis] model claude-opus-5 · effort medium`.

### The voice pipeline

The loop is designed so that nothing silently dies and barge-in feels natural.

- **Detection is local.** An energy-based voice-activity detector
  (`src/lib/vad.ts`) decides when you are speaking. It is instant, cannot quietly
  fail, and is what makes **barge-in** work — speak while JARVIS is talking and he
  stops.
- **Transcription has two tiers, chosen automatically at boot.** The browser asks
  the bridge `/health` and picks the best available:
  - **ElevenLabs key present** → ElevenLabs Scribe, via the bridge `/stt` endpoint.
  - **Nothing configured** → the browser's own `SpeechRecognition` (Chrome/Edge),
    guarded by a heartbeat so it recovers when Chrome throttles it.
- **Speaking** uses the **ElevenLabs voice when a key is present**, and the
  browser's `speechSynthesis` otherwise. If a cloud call fails it falls back to
  the browser voice, and if the OS voice itself is broken it latches over to the
  cloud voice.

So it works with no keys and auto-upgrades when a key appears — there is no flag
to set. Capability detection lives in `src/lib/capabilities.ts`, which probes the
bridge's `GET /health` (returning `{ ok, tts, stt }`, both tracking the
ElevenLabs key) once at boot and picks the engines.

---

## What JARVIS can do

Beyond answering, JARVIS reaches every MCP server in your Claude Code
configuration, and can drive his own interface.

### Your tools

Every server in your `~/.claude.json` is handed to the SDK explicitly. Depending
on what you have installed, that is roughly:

- **Web & search** — `exa`, `serper`, `serpapi`
- **Images & video** — `higgsfield`, `openrouter-image`, `palmier-pro`
- **Voice** — `elevenlabs`
- **Your phone** — `android`
- **The browser** — `playwright`

A few things you can say:

- *"What's happening in AI this week?"*
- *"Generate an image of the Mark VII suit."*
- *"Take a screenshot of my phone."*
- *"Open my GitHub notifications."*

> **Note on account connectors.** Connectors added through your **claude.ai
> account** (Gmail, Google Calendar, Docs…) do reach the agent through the SDK,
> as `mcp__claude_ai_<name>__*` tools. With writes on, any of them whose name
> does not plainly say it only reads (`search_…`, `get_…`, `list_…`) waits for
> on-screen approval: `forward`, `trash_thread`, `create_draft` and
> `respond_to_event` all ask first.

### JARVIS controls the interface

He drives the UI through MCP tools the bridge exposes:

- `ui_theme` — accent, background, per-phase colours
- `ui_reactor` — colour, scale, intensity, spin, and style (`ring` | `sphere` | `wire`), visibility
- `ui_orbit` — put images in orbit around the reactor
- `ui_chrome` — show or hide rails, transcript, badges
- `ui_effect` — `glitch` | `pulse` | `scan` | `shake` | `flash`
- `ui_screen` — clear
- `ui_reset` — back to defaults

So *"make it red, hide the systems list, put that render in orbit"* is a spoken
command.

### The heads-up display

JARVIS authors panels with a `display` tool against a fixed `.hud-*` design
system. The browser sanitises the markup (DOMPurify, a class allowlist and a
strict CSP) before rendering. Rich media works — images, `<video>`, and
YouTube/Vimeo embeds. Remote images and video are fetched **server-side** through
the bridge (`/img` and `/media`, both SSRF-guarded), so hotlink-blocked news
thumbnails still appear and the page never beacons your IP to a host the model
chose.

---

## Controls

| Key / phrase | Does |
|---|---|
| **"Hey Jarvis"** | Wake him |
| **Space** | Talk without the wake word |
| Just speak | Interrupt him mid-sentence (barge-in) |
| **V** | Cycle the browser voice |
| **Escape** | Stop speaking, cancel the task and any running tool |
| **C** | Console: status, activity, voice, memory, connections |
| **D** | Live diagnostics panel |
| **T** | One-line audio self-test |
| **STOP** button | Same as Escape; on screen whenever something is running |
| **Enter / Y**, **Esc / N** | Approve or decline an approval prompt |

---

## The boot sequence

Power-up plays a four-beat Iron Man start-up (`src/ui/Boot.tsx`): an
"INITIATING SYSTEM" status bar with a segmented progress bar and boot log; then
concentric reticle rings resolving into "J.A.R.V.I.S"; then a suit schematic;
then the triangular arc reactor lighting up — with a start-up sound under it
(`public/audio/boot-music.mp3`).

---

## Configuration

Everything is optional in bridge mode. Frontend settings live in `.env.local`
(copy `.env.example`); bridge settings are environment variables.

### Bridge

| Variable | Default | Effect |
|---|---|---|
| `JARVIS_BRIDGE_PORT` | `8787` | Port for the WebSocket + HTTP endpoints |
| `JARVIS_MODEL` | `claude-opus-5` | Model to run |
| `JARVIS_EFFORT` | `medium` | Reasoning effort |
| `JARVIS_ALLOW_WRITES` | off | `1` allows effectful tools (see below) |
| `JARVIS_ALLOWED_ORIGINS` | local dev | Extra WebSocket origins to accept |
| `JARVIS_ALLOW_NO_ORIGIN` | off | Accept connections with no `Origin` header |
| `JARVIS_FILE_ROOTS` | — | Roots the `/file` endpoint may serve from |
| `JARVIS_VOICE_ID` | — | ElevenLabs voice id |
| `ELEVENLABS_API_KEY` | — | Optional; enables the ElevenLabs voice + Scribe |

### Frontend (`.env.local`)

| Variable | Effect |
|---|---|
| `VITE_BACKEND` | `bridge` (default) or `direct` |
| `VITE_BRIDGE_URL` | Where to reach the bridge |
| `VITE_TTS_ENGINE` | `system` or `kokoro` |
| `VITE_KOKORO_VOICE` | Voice for the Kokoro engine |
| `VITE_USE_ELEVENLABS` | Force the ElevenLabs voice on |
| `VITE_ANTHROPIC_API_KEY` | Direct mode only |

### Adding an ElevenLabs key

You do not have to touch a flag. Either:

- Set `ELEVENLABS_API_KEY` on the bridge before starting it, **or**
- Add the key to your `elevenlabs` MCP server's env in `~/.claude.json` — the
  bridge reads it from there too.

Either way, `/health` starts reporting the capability, the browser picks it up on
the next boot, and both the voice and transcription upgrade automatically.

---

## Enabling actions

The tool gate starts **read-only**. Search, generation and lookups run freely;
anything effectful — send, tap, delete, install, pay — is denied. Voice is a poor
interface for a confirmation dialog, so the decision is made ahead of time in
`decideTool()` in `bridge/server.mjs`, not at the moment of use. The bridge sets
`settingSources: []`, which makes its own gate the only authority — filesystem
settings and any global `bypassPermissions` cannot override it.

To allow effectful tools (phone, browser driving, sending), run the bridge this
way instead:

```bash
npm run bridge:writes
```

> Read `decideTool()` before you do. *"Hey Jarvis, clean up my downloads folder"*
> means something rather different with writes enabled.

On Windows, `npm run start:desktop` starts it in one step: writes on, every
local drive readable, and Haiku at low effort, the fastest to answer. Set
`JARVIS_MODEL=claude-sonnet-5-5` for more careful multi-step work. Each
session is warmed as the screen connects, so the first question is as quick
as the rest (`JARVIS_PREWARM=0` turns that off).

### The safety policy (writes mode)

With writes on, every tool call still passes through `bridge/policy.mjs`,
enforced by a `PreToolUse` hook so nothing reaches the machine around it. Each
call gets one of three outcomes:

| Outcome | Examples |
|---|---|
| **Runs** | listing and searching files, opening apps and folders, making folders, creating new files, appending, editing a file (a backup is kept) |
| **Asks first**: an amber prompt on screen; **Enter**/**Y** approves, **Esc**/**N** declines, no answer in 60 s declines | deleting, overwriting an existing file, bulk moves or renames, killing programs, shutdown or restart, registry and system settings, installing software, admin elevation, git push or hard reset, uploading or posting data |
| **Never** | formatting or wiping disks, deleting a whole drive or home folder, boot-config changes, destroying backups, disabling Defender or the firewall, clearing event logs, download-and-run, encoded commands, anything touching keys, tokens or saved passwords, writing into `C:\Windows` or `Program Files` |

Approval is on screen, never spoken: a "yes" from a television is not consent.
File tools may only write inside your home folder, the temp folder and any
`JARVIS_FILE_ROOTS`.

- **Audit log:** `~/.jarvis/audit.jsonl` holds one line per decision, with the
  command or path but never file contents.
- **Backups:** `~/.jarvis/backups/` gets a copy of every file before it is
  overwritten or edited.
- **Tests:** `npm test`.

The policy is a guard rail, not a sandbox. A shell can always phrase something
in a way no pattern list anticipates, so it errs towards asking. Code built at
run time (`python -c`, `node -e`, `iex`, `& ("Re"+"move-Item")`) asks; escape
tricks (`d^el`, ``R`emove-Item``) and piping text into a shell are refused;
copies, moves and `tee` onto an existing file count as overwrites; links are
resolved before a write is judged.

---

## JARVIS's own tools

Beyond the shell, JARVIS has 46 structured tools of its own (`bridge/tools/`).
Each declares its input schema, risk level, permissions and timeout in one
place, the central registry (`bridge/tools/registry.mjs`), and every call:

1. is checked by the same `PreToolUse` policy hook as everything else, which
   validates the arguments and decides allow / ask / refuse;
2. runs only with a single-use **ticket** from that hook for exactly those
   arguments. If the hook were ever skipped, the tool refuses to run (fail closed);
3. has a timeout, stops when you press Escape (subprocesses are killed), and
   retries only if it is a read;
4. returns `{"ok":true,"result":…}` or `{"ok":false,"error":{"code","message"}}`,
   so a failure is never reported as a success;
5. is written to the audit log twice, once for the decision and once for the
   result, with argument shapes but never message bodies or tokens.

| Group | Tools | Asks first |
|---|---|---|
| `jarvis_pc` | find_files, count_files, read_text_file, pdf_info, make_folder, move_files, copy_file, open_app, open_path, disk_space, system_stats, list_processes, screenshot | moving more than one file (with a preview of every file), replacing a file |
| `jarvis_memory` | remember, recall, forget, task_history, docs_search | forget |
| `jarvis_phone` | phone_status, phone_pair, phone_forget, phone_permission, phone_contacts, phone_dial, phone_call, phone_location, phone_notifications | pairing, calling, switching on location or notifications |
| `jarvis_whatsapp` | whatsapp_open_chat, whatsapp_share_location, whatsapp_send, whatsapp_delivery_status | everything that addresses a person |
| `jarvis_google` | gmail_search, gmail_read, gmail_thread, gmail_draft, gmail_send, gmail_save_attachment, calendar_events, calendar_free_slots, calendar_create, calendar_update, calendar_cancel | sending, inviting people, changing or cancelling events |
| `jarvis_home` | home_status, home_entities, home_state, home_control | locks, alarms, covers, climate, valves, sirens |

Text from outside (emails, web pages, notifications, files) comes back wrapped
as `untrusted_content`, and the persona is told it is data, not instructions.
The real defence is still the gate: nothing an email says can approve a prompt.

### What results mean

JARVIS is told to report outcomes exactly:

- `draft_opened`: WhatsApp is open with your message typed in. You press send.
- `prepared`: the phone's dialer shows the number. Nothing has been called.
- `requested` / `initiated`: a call was started. Whether anyone answered is not known.
- `accepted`: WhatsApp's API took the message. `delivered` comes only from the webhook.

---

## The console (C)

- **Status:** model, effort, actions on or off, CPU, memory, disks, the
  microphone, and where speech goes.
- **Activity:** the model's plan, if it wrote one, and every tool call with its
  decision and result.
- **Voice:** choose the microphone, turn hands-free on or off, pick the voice
  and speaking rate.
- **Memory:** review, delete, export or switch off memory and request history.
- **Connections:** Google (connect, or disconnect and revoke), the phone (with
  per-device revoke buttons), WhatsApp and Home Assistant, each showing what it
  needs if it isn't set up.

Two things stay on screen without the console. The **mic readout** says whether
JARVIS is listening, and whether that audio is going to Google (Chrome's
recogniser) or ElevenLabs. The **STOP** button appears whenever anything is
running.

> Voice honesty: Chrome's built-in speech recognition sends audio to Google,
> and it always uses the system default microphone. Choosing a mic in the
> console applies to the level meter and the ElevenLabs path. There is no
> offline speech recognition yet; offline speech *output* is available with
> `VITE_TTS_ENGINE=kokoro`.

---

## Connecting your phone, WhatsApp, Google and Home Assistant

Put settings in `jarvis/.env`, which is gitignored (see `.env.example`), then
restart. Anything not set up reports "not set up" and the rest still works.

### Android phone over Wi-Fi (companion app)

The main route: the **JARVIS Companion** app (`android/`, Kotlin and Jetpack
Compose) keeps an encrypted link to the PC over your home Wi-Fi. No cable is
needed. The phone tools (`phone_call`, `phone_location`…) use it whenever it is
connected, and fall back to USB/ADB otherwise.

**Build and install** (Android Studio's JDK and SDK are enough):

```bash
cd android
# Windows (PowerShell): $env:JAVA_HOME="C:\Program Files\Android\Android Studio1\jbr"
./gradlew testDebugUnitTest assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk   # with USB debugging on, once
```

Or copy the APK to the phone and open it (allow "install unknown apps" for your
file manager).

**Pair:**

1. Put the PC and the phone on the **same Wi-Fi**. The first time, Windows asks
   whether Node.js may accept connections. Allow it on **Private networks** only.
2. On the PC, say *"Jarvis, connect to my phone"*, or press **C** → Connections →
   **pair a phone**. A QR code appears for 5 minutes.
3. In the app, tap **Scan pairing code** and scan it.
4. Both screens show the same 6-digit code. Approve the prompt on the PC, and tap
   **Codes match — confirm** on the phone.
5. In the app, switch on what JARVIS may use: Contacts, Calls, Location, WhatsApp
   drafts, Notifications. Each asks for its Android permission when you switch it on.

After that, the app reconnects by itself: after sleep, after Wi-Fi drops, and
after a reboot. If the PC's address changes, the app searches the local
network for the one certificate it trusts.

**How it is secured:**

- **Pinned TLS.** The PC's self-signed certificate fingerprint travels inside
  the QR code. The app talks only to that certificate, whatever address
  answers. Being on the same Wi-Fi earns a device nothing.
- **Pairing needs the QR code and two yeses.** The QR's 32-byte one-time secret
  is proven with an HMAC. Both screens show the same code, and the pairing
  completes only when approved on both. It expires in 5 minutes and locks
  after 5 bad attempts.
- **A per-phone key that is never re-sent.** Pairing hands the phone a random
  32-byte key: stored with DPAPI on the PC, and encrypted under an Android
  Keystore key on the phone. Every later connection answers a fresh challenge
  with an HMAC, so the key itself never crosses the network again.
- **Requests.** Each has an id and a deadline. The phone answers a repeated id
  from memory instead of acting twice. The PC never resends a call or a draft
  after a dropped link; it reports that the result is unknown.
- **What the phone accepts.** Only a fixed list of operations (status,
  contacts search, dial, call, location, WhatsApp draft, current
  notifications). No shell, nothing else.
- **Where the PC listens.** Only on its private-network addresses, only while a
  phone is paired or pairing, and it refuses connections from public addresses.

**What the app can and can't do** (Android's rules, not choices):

| Capability | Notes |
|---|---|
| Calls | After approval on the PC. Never emergency or short-code numbers (refused on both sides). Reports "requested" or "dialing", never "answered". |
| Dialer, WhatsApp | Android blocks background apps from opening screens. JARVIS opens them directly if the app is on screen or you allowed **"Allow opening apps"** (display over other apps); otherwise it posts a notification to tap. WhatsApp is never sent for you. |
| Location | Fresh fix on request, with accuracy, time, and a stale flag. Location must be on; JARVIS never turns it on. If the app was started in the background after a reboot, Android may refuse location until you open the app once. |
| Notifications | Only those showing right now, and only with notification access granted in Android settings. There is no message history. |
| Away from home | Not supported: both devices must be on the same network. Remote access would need a separately secured relay, which isn't built. |

**Text messages (SMS).** Two optional switches in the app:

- **Text messages (send).** Grants `SEND_SMS`. *"Jarvis, text Rahul that I'm
  on my way"* looks Rahul up in your contacts (if two match, JARVIS asks
  which), then shows the approval prompt with the name, the number and the
  whole message. Only **Enter** sends it, from your phone's SIM, at normal
  SMS charges. The result reports what the phone saw:
  - `sent`: the network accepted it.
  - `delivered: true`: only if your carrier sent a delivery report back.
  - `handed_to_android`: not yet confirmed.

  Emergency numbers and short codes (which include premium-rate services)
  are refused. *"Draft a text to Mom"* only opens the Messages app with the
  text typed in, and needs no SMS permission.
- **Read recent texts.** Grants `READ_SMS`, separately and optionally.
  *"Show my recent messages"* or *"what did Mom text me"* reads the latest
  texts Android stores.

Google Play only lets default SMS apps hold these permissions. This app is
installed directly, so it can, but it could not be published on Play as it is.
If Android shows **"Restricted setting"** when you turn one on, open App info →
⋮ → **Allow restricted settings**, then try again.

**Disconnect or revoke:** in the PC console (disconnect, reconnect, revoke), or
in the app (Disconnect, or **Forget this PC**). Either side revoking deletes the
key.

### Android phone over USB (ADB)

The fallback route, and useful for installing the app. It uses Android's own
debugging bridge; no app is needed.

1. Install **Android Platform Tools** (`winget install Google.PlatformTools`, or
   unzip it and set `JARVIS_ADB` to the full path of `adb.exe`).
2. On the phone: Settings → About → tap **Build number** 7 times, then
   Developer options → **USB debugging** on.
3. Plug it in, unlock it, and accept **"Allow USB debugging"** for this PC.
4. Say *"pair my phone"* and approve the prompt. The console (Connections) now
   shows it as **paired**.
5. Location and notifications are **off** per phone. Say *"allow JARVIS to read
   my phone's location"* and approve; revoke any time from the console.

Wireless: Developer options → **Wireless debugging** → *Pair with code*, then
tell JARVIS the IP, pairing port, code and connection port.

What works: status, dialer, calls (approved, never to emergency numbers), contact
lookup, last-known location with accuracy and age, and notifications. What
doesn't: anything while the phone is off the cable or the network, answering
calls, and push notifications to the PC. Those need a companion app, which
isn't built.

### WhatsApp

- **Personal account:** nothing to set up. JARVIS opens the chat with your
  message, or a Google Maps link to your phone's real location, typed in. **You
  press send.** Live location can only be started inside WhatsApp.
- **Business Platform:** for a business number registered with Meta. Set
  `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID`. Meta's rules apply (free-form
  text only within 24 hours of the customer's last message). Delivery receipts
  need the webhook `https://<public-host>/whatsapp/webhook` (forward port 8787
  through a tunnel) plus `WHATSAPP_VERIFY_TOKEN` and `WHATSAPP_APP_SECRET`. Every
  receipt's signature is checked.

### Google (Gmail and Calendar)

1. In <https://console.cloud.google.com>, create a project and enable the
   **Gmail API** and **Google Calendar API**.
2. Under *OAuth consent screen*, choose External, then add yourself as a test user.
3. Under *Credentials*, create an **OAuth client ID** of type **Desktop app**.
   Put its id and secret in `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
4. Restart, press **C** → Connections → **Connect Google**, and approve in the
   browser tab that opens. It returns to
   `http://127.0.0.1:8787/oauth/google/callback`.

Scopes: `gmail.readonly`, `gmail.compose`, `calendar.events`. The refresh token
is stored encrypted with Windows DPAPI in `~/.jarvis/secrets`. **Disconnect**
revokes it at Google.

Separately, if your claude.ai account has the Gmail or Calendar connectors,
JARVIS can already use those (see the note above).

### Home Assistant

Create a long-lived access token (your profile → Security) and set `HASS_URL`
and `HASS_TOKEN`. Lights, switches and fans run directly. Locks, alarms, covers,
climate, valves and sirens ask first. Anything else is refused. Revoke the
token in Home Assistant to disconnect.

---

## Memory

JARVIS saves something only when you ask it to remember, and refuses anything
that looks like a password, PIN, key, token or card number. It also keeps a
searchable history of requests (question, tools used, success) in
`~/.jarvis/history.jsonl`. Everything is pruned after 90 days by default, can
be reviewed, exported and deleted in the console, and stops being written the
moment you switch persistence off (or set `JARVIS_MEMORY=off`). Saved
preferences are added to the start of each session, labelled as your notes.

---

## Start at sign-in (Windows)

JARVIS can start by itself when you sign in, with no terminal and no `npm`
commands. A Task Scheduler task named **JARVIS** runs it as you, with the lowest
privileges (no administrator rights, no UAC prompt), 20 seconds after sign-in.

**Turn it on** (once, from the `jarvis` folder):

```bash
npm install
npm run jarvis:enable
```

That's it. To try it without signing out: `schtasks /Run /TN JARVIS`.

### What happens at sign-in

1. The supervisor (`scripts/supervisor.mjs`) starts hidden from the project
   folder and runs the same launcher as `npm run start:desktop`: the bridge
   first, then the face. The bridge loads `jarvis/.env` itself, so every
   policy, approval prompt and credential rule is the same as from a terminal.
2. A small round **JARVIS button** appears in the bottom-right corner of the
   desktop, with a small popup above it: **"Are you in the mood for JARVIS
   today?"**
   - **Yes**: the HUD opens (a Chrome or Edge app window) as soon as JARVIS is
     ready. Power him up as usual: click INITIALISE, or clap.
   - **No**: nothing more happens. No HUD, no microphone, no voice, no more
     popups. Leaving the question unanswered for 2 minutes counts as no.
   It is asked once per sign-in, never again until you next sign in.
3. The button stays on screen either way. **Click** it to open the HUD at any
   time (or to bring the open one to the front). **Drag** it anywhere; the spot
   is remembered. **Right-click** it for status, the log folder, *Turn off start
   at sign-in*, and *Exit JARVIS*.
4. A paired phone reconnects over Wi-Fi by itself; the supervisor records
   whether it did (`npm run jarvis:status`).

The button's colour shows the state: **amber** while starting, **cyan** when
ready, **red** if it could not start.

### Commands

| Command | Does |
|---|---|
| `npm run jarvis:enable` | Start at every sign-in (creates the task and Start-menu entries) |
| `npm run jarvis:disable` | Stop starting at sign-in (JARVIS keeps running until you exit it) |
| `npm run jarvis:start` | Start now, in the background; opens the HUD without asking |
| `npm run jarvis:stop` | Exit JARVIS completely: bridge, face, button |
| `npm run jarvis:open` | Open the HUD of the running JARVIS |
| `npm run jarvis:status` | Task, supervisor, bridge health, phone, today's answer, last error |
| `npm run jarvis:logs` | The latest log lines |

Without a terminal: **Start menu → JARVIS** has Open, Start, Stop and Disable
entries, and the desktop button's right-click menu has Exit and Turn off.

### Safety rails

- **One copy only.** A lock in `~/.jarvis/run` means a second start opens the
  HUD of the running JARVIS instead of starting another server (no
  `EADDRINUSE`). A JARVIS you started by hand in a terminal is detected and
  left alone. There is only ever one desktop button.
- **Crash recovery, with a limit.** If JARVIS stops, it restarts after 5, 15,
  then 30 s. Four failures within 10 minutes and it gives up and says so
  (a message box, unless you answered No, in which case only the log and
  `jarvis:status` say it). A start that is not ready within 90 s counts as a
  failure (`JARVIS_READY_TIMEOUT_MS` changes that).
- **Clean shutdown.** Exit takes down the whole process tree, so nothing is
  left holding a port, and closes the HUD app window.
- **Writes are on.** The sign-in start runs `--fast --desktop`, like
  `npm run start:desktop`: JARVIS can act, and every action still goes through
  the policy in `bridge/policy.mjs` with its on-screen approvals.

### Settings (in `jarvis/.env`)

| Variable | Effect |
|---|---|
| `JARVIS_STARTUP_PROMPT=0` | Don't ask at sign-in; open the HUD when ready |
| `JARVIS_DESKTOP_BUTTON=0` | No desktop button (and so no question); the HUD opens when ready |

The supervisor reads only these two names from `.env`. Everything else in it is
loaded by the bridge, as before.

### Troubleshooting startup

- **Nothing appeared after sign-in.** Run `npm run jarvis:status`. Then
  `npm run jarvis:logs`, or open `~/.jarvis/logs/jarvis-<date>.log`. Lines
  tagged `[supervisor]` and `[button]` say what started, how long it took,
  what you answered and why anything stopped.
- **The button takes a while to show up.** It runs in Windows PowerShell, which
  can take 20 seconds or more to start just after sign-in while antivirus
  scans it. JARVIS is starting alongside it in the meantime.
- **"did not become ready within 90 s".** Something else is probably using port
  8787 or 5173. Find it with `netstat -ano | findstr :8787`.
- **"stopped 4 times in 10 minutes".** Fix what the log shows, then
  `npm run jarvis:start`. Running `npm run start:desktop` in a terminal shows
  the same errors live.
- **Moved the project folder, or updated Node?** Run `npm run jarvis:enable`
  again; the task points at the folder and the Node it was enabled from.
- **The task exists but never runs.** Open Task Scheduler → Task Scheduler
  Library → **JARVIS** → History. Check that its trigger is *At log on* for your
  user.

**Turn it all off:** `npm run jarvis:disable`, then `npm run jarvis:stop`.
That removes the task and the Start-menu entries. State and logs stay in
`~/.jarvis` (delete `~/.jarvis/run`, `~/.jarvis/logs` and
`~/.jarvis/autostart` if you want them gone).

---

## Testing

```bash
npm test          # 77 tests: policy, registry, desktop, connectors (all mocked)
npx tsc -b        # type-check
npm run lint
npm run build
```

The connector tests replace adb, the network and the secret store with fakes.
They prove the protocol handling and the safety rules, not that your accounts
are connected. The console's Connections tab shows that.

---

## Troubleshooting

**I can't hear him, or he can't hear me.** Press **D** for the diagnostics panel
— it states plainly whether he is hearing you and whether he is producing sound.
Press **T** for a one-line audio self-test.

**No voice at all.** You must be in **Chrome or Edge**, in a **real browser
window** (not an embedded preview), and you must have **allowed the microphone**.

**Bridge not reachable.** Check that `npm run bridge` is still running in its
terminal, and that nothing else is holding port `8787`.

**"Microphone disconnected".** Plug it back in. JARVIS reopens it by itself, or
you can pick another in the console (C → Voice).

**Phone says "adb is not installed".** Install Platform Tools, or set
`JARVIS_ADB` to the full path of `adb.exe`.

**Phone is "unauthorized".** Unlock the phone and accept the USB debugging prompt.

**Google says the redirect URI doesn't match.** The OAuth client must be of type
*Desktop app*. Web clients need the redirect registered explicitly.

**A tool says UNAUTHORIZED.** It ran without passing the policy hook, so it
refused. Restart the bridge, and report it if it persists.

---

## Security

All of this lives in `bridge/server.mjs`:

- The WebSocket accepts only local dev origins (add more with
  `JARVIS_ALLOWED_ORIGINS`).
- `/file`, `/img` and `/media` validate the scheme, confine to allowed roots,
  resolve the real path, and refuse private and loopback addresses (SSRF guard).
- The tool gate (`decideTool`) is default-deny for effectful MCP tools.
- A strict CSP in `index.html`; model-authored panel HTML is sanitised.

---

## Credits & licence

MIT.

The boot sound and any tracks in `public/audio/` ship with the project for the
demo. If you go on to monetise something built on this, clearing the rights to
that audio is your responsibility.
