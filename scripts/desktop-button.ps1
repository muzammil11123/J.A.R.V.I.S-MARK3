<#
  The JARVIS desktop button, and the one question asked at sign-in.

  Started hidden by scripts/supervisor.mjs, never on its own. It is a small,
  always-on-top, draggable button in the corner of the desktop:

    click          ask "Are you in the mood for JARVIS today?" - Yes opens
                   the HUD (or brings the open one forward), No closes it
    drag           move it; the spot is remembered
    right-click    status, log folder, turn off start at sign-in, exit JARVIS

  With -Ask (only from the sign-in task) it first asks, once:
  "Are you in the mood for JARVIS today?"

    Yes   the HUD opens; you power him up as usual (click or clap)
    No    nothing more happens: no HUD, no microphone, no voice, no popups.
          The button stays, and a click on it asks again at any time.

  The answer is written to ~/.jarvis/run/session.json, which the supervisor
  clears when it starts, so it is asked once per sign-in and never again in
  between, not even if this button is restarted.

  It talks to the supervisor only through files in ~/.jarvis/run, the same way
  `npm run jarvis:stop` does: open.request asks for the HUD, stop.request
  shuts JARVIS down. It runs as you, with no rights the supervisor lacks, and
  touches nothing the bridge's policy or approval prompts govern.

  ASCII only: Windows PowerShell 5.1 reads a BOM-less file as the ANSI code
  page, so any other character would be mangled.
#>
param(
  [Parameter(Mandatory = $true)][string]$RunDir,
  [Parameter(Mandatory = $true)][int]$SupervisorPid,
  [string]$Node = '',
  [string]$Root = '',
  [switch]$Ask
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

# One button per signed-in user, however many times this is started.
$created = $false
$script:mutex = New-Object System.Threading.Mutex($true, 'Local\JARVIS.DesktopButton', [ref]$created)
if (-not $created) {
  [Console]::Out.WriteLine('[button] already on screen; not adding another')
  exit 0
}

$HudTitle = 'J.A.R.V.I.S.'
$StateDir = Split-Path $RunDir -Parent
$StatusFile = Join-Path $RunDir 'status.json'
$SessionFile = Join-Path $RunDir 'session.json'
$OpenFile = Join-Path $RunDir 'open.request'
$StopFile = Join-Path $RunDir 'stop.request'
$PlaceFile = Join-Path $StateDir 'desktop-button.json'
$LogDir = Join-Path $StateDir 'logs'

$Cyan = '#4FD8FF'
$Amber = '#FFB547'
$Red = '#FF5A5A'

function Say([string]$m) {
  try { [Console]::Out.WriteLine($m); [Console]::Out.Flush() } catch { }
}
function Put([string]$file, [string]$text) {
  # .NET writes UTF-8 without a BOM, which is what JSON.parse in Node expects.
  [IO.File]::WriteAllText($file, $text)
}
function ReadJson([string]$file) {
  try { return (Get-Content -LiteralPath $file -Raw -ErrorAction Stop | ConvertFrom-Json) } catch { return $null }
}
function Brush([string]$hex) {
  return (New-Object Windows.Media.BrushConverter).ConvertFromString($hex)
}

# Finding the HUD's own window, so a click brings it forward instead of opening
# a second one (two HUDs would mean two microphones listening). Compiled once
# the button and the question are up, since compiling takes a few seconds.
$windowHelper = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class JarvisWindows {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);

  // exact: only the app window, whose title is the page title. Otherwise a
  // normal Chrome window whose active tab is the HUD matches too.
  static List<IntPtr> Find(string title, bool exact) {
    var hits = new List<IntPtr>();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, sb.Capacity);
      var t = sb.ToString();
      if (t == title || (!exact && t.StartsWith(title + " - "))) hits.Add(h);
      return true;
    }, IntPtr.Zero);
    return hits;
  }

  public static bool Focus(string title) {
    var hits = Find(title, false);
    if (hits.Count == 0) return false;
    if (IsIconic(hits[0])) ShowWindow(hits[0], 9);
    SetForegroundWindow(hits[0]);
    return true;
  }

  // Closes only HUD app windows, never a browser window that has other tabs.
  public static int Close(string title) {
    var hits = Find(title, true);
    foreach (var h in hits) PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero);
    return hits.Count;
  }
}
'@

# ---------------------------------------------------------------------------
# The button
# ---------------------------------------------------------------------------

$buttonXaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        Title="JARVIS button" Width="44" Height="44"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        Topmost="True" ShowInTaskbar="False" ResizeMode="NoResize"
        ShowActivated="False" Opacity="0.7">
  <Grid Cursor="Hand">
    <Ellipse Fill="#D908121A" />
    <Ellipse Name="Ring" Stroke="#4FD8FF" StrokeThickness="2.5" Margin="4">
      <Ellipse.Effect>
        <DropShadowEffect Color="#4FD8FF" BlurRadius="10" ShadowDepth="0" Opacity="0.7" />
      </Ellipse.Effect>
    </Ellipse>
    <Ellipse Name="Core" Fill="#4FD8FF" Width="11" Height="11" Opacity="0.9" />
  </Grid>
</Window>
'@

$script:button = [Windows.Markup.XamlReader]::Parse($buttonXaml)
$ring = $script:button.FindName('Ring')
$core = $script:button.FindName('Core')

function Place {
  $wa = [Windows.SystemParameters]::WorkArea
  $left = $wa.Right - 44 - 24
  $top = $wa.Bottom - 44 - 96
  $saved = ReadJson $PlaceFile
  if ($saved -and $null -ne $saved.left -and $null -ne $saved.top) {
    # Kept on a screen that still exists, in case a monitor was unplugged.
    $vl = [Windows.SystemParameters]::VirtualScreenLeft
    $vt = [Windows.SystemParameters]::VirtualScreenTop
    $vr = $vl + [Windows.SystemParameters]::VirtualScreenWidth - 44
    $vb = $vt + [Windows.SystemParameters]::VirtualScreenHeight - 44
    $left = [Math]::Min([Math]::Max([double]$saved.left, $vl), $vr)
    $top = [Math]::Min([Math]::Max([double]$saved.top, $vt), $vb)
  }
  $script:button.Left = $left
  $script:button.Top = $top
}

function SavePlace {
  try { Put $PlaceFile (@{ left = $script:button.Left; top = $script:button.Top } | ConvertTo-Json -Compress) } catch { }
}

function HelperReady { return [bool]('JarvisWindows' -as [type]) }

$script:lastAsked = [DateTime]::MinValue
function Activate([string]$why) {
  if ((HelperReady) -and [JarvisWindows]::Focus($HudTitle)) {
    Say ('[button] {0}: brought the open HUD to the front' -f $why)
    return
  }
  # Asked for one moments ago and it is still on its way: do not ask again.
  # Each request opened another window, and two HUDs mean two microphones
  # hearing each other and cancelling each other's questions.
  if (((Get-Date) - $script:lastAsked).TotalSeconds -lt 20) {
    Say ('[button] {0}: the HUD is already on its way' -f $why)
    return
  }
  $script:lastAsked = Get-Date
  # The supervisor opens it as soon as JARVIS is ready, or right away if it is.
  Put $OpenFile ((Get-Date).ToString('o'))
  Say ('[button] {0}: asked for the HUD' -f $why)
  Refresh
}

# "No": nothing listening. Closes the HUD app window(s), so no microphone and
# no voice, until the next Yes.
function Silence([string]$why) {
  $closed = if (HelperReady) { [JarvisWindows]::Close($HudTitle) } else { 0 }
  Remove-Item -LiteralPath $OpenFile -Force -ErrorAction SilentlyContinue
  Say ('[button] {0}: no - closed {1} HUD window(s)' -f $why, $closed)
}

$script:state = ''
function Refresh {
  if (-not (Get-Process -Id $SupervisorPid -ErrorAction SilentlyContinue)) {
    # JARVIS has stopped; a button that opens nothing should not linger.
    Say '[button] supervisor has stopped; removing the button'
    $script:app.Shutdown()
    return
  }
  $s = ReadJson $StatusFile
  $state = if ($s -and $s.state) { [string]$s.state } else { 'starting' }
  $waiting = Test-Path -LiteralPath $OpenFile
  switch ($state) {
    'running' {
      $colour = $Cyan
      $tip = 'JARVIS is ready. Click to open the HUD. Drag to move. Right-click for options.'
    }
    'failed' {
      $colour = $Red
      $tip = 'JARVIS could not start. Right-click > Open log folder.'
    }
    default {
      $colour = $Amber
      $tip = if ($waiting) { 'JARVIS is starting. The HUD opens as soon as it is ready.' } else { 'JARVIS is starting. Click and the HUD opens when it is ready.' }
    }
  }
  if ($state -ne $script:state) {
    $b = Brush $colour
    $ring.Stroke = $b
    $core.Fill = $b
    $ring.Effect.Color = [Windows.Media.ColorConverter]::ConvertFromString($colour)
    $script:state = $state
  }
  $script:button.ToolTip = $tip
  $script:statusItem.Header = ('Status: {0}' -f $state)
}

$script:button.Add_MouseEnter({ $script:button.Opacity = 1.0 })
$script:button.Add_MouseLeave({ $script:button.Opacity = 0.7 })
$script:button.Add_MouseLeftButtonDown({
  $x = $script:button.Left
  $y = $script:button.Top
  # DragMove returns when the mouse is released. Barely moved means a click.
  try { $script:button.DragMove() } catch { }
  if ([Math]::Abs($script:button.Left - $x) -lt 4 -and [Math]::Abs($script:button.Top - $y) -lt 4) {
    # Every press asks: Yes brings JARVIS up, No closes it.
    ShowPrompt 'button'
  } else {
    SavePlace
  }
})

# Right-click menu: the way out, without a terminal.
$menu = New-Object Windows.Controls.ContextMenu
$script:statusItem = New-Object Windows.Controls.MenuItem
$script:statusItem.IsEnabled = $false
$openItem = New-Object Windows.Controls.MenuItem
$openItem.Header = 'Open JARVIS'
$openItem.FontWeight = 'SemiBold'
$logItem = New-Object Windows.Controls.MenuItem
$logItem.Header = 'Open log folder'
$autoItem = New-Object Windows.Controls.MenuItem
$autoItem.Header = 'Turn off start at sign-in...'
$exitItem = New-Object Windows.Controls.MenuItem
$exitItem.Header = 'Exit JARVIS'
foreach ($i in @($script:statusItem, $openItem, (New-Object Windows.Controls.Separator), $logItem, $autoItem, (New-Object Windows.Controls.Separator), $exitItem)) {
  [void]$menu.Items.Add($i)
}
$script:button.ContextMenu = $menu

$openItem.Add_Click({ Activate 'menu' })
$logItem.Add_Click({
  if (-not (Test-Path -LiteralPath $LogDir)) { [void](New-Item -ItemType Directory -Path $LogDir) }
  Start-Process explorer.exe -ArgumentList ('"{0}"' -f $LogDir)
})
$autoItem.Add_Click({
  $ok = [Windows.MessageBox]::Show($script:button, "Stop starting JARVIS when you sign in to Windows?`n`nIt keeps running now. Turn it back on with: npm run jarvis:enable", 'JARVIS', 'YesNo', 'Question')
  if ($ok -ne 'Yes') { return }
  if (-not $Node -or -not $Root) {
    [void][Windows.MessageBox]::Show($script:button, 'Run this in the jarvis folder instead: npm run jarvis:disable', 'JARVIS')
    return
  }
  $cli = Join-Path $Root 'scripts\autostart.mjs'
  $p = Start-Process -FilePath $Node -ArgumentList @(('"{0}"' -f $cli), 'disable') -WorkingDirectory $Root -WindowStyle Hidden -Wait -PassThru
  Say ('[button] turn off start at sign-in: exit code {0}' -f $p.ExitCode)
  $msg = if ($p.ExitCode -eq 0) { 'JARVIS will no longer start at sign-in.' } else { 'That did not work. Run this in the jarvis folder: npm run jarvis:disable' }
  [void][Windows.MessageBox]::Show($script:button, $msg, 'JARVIS')
})
$exitItem.Add_Click({
  $ok = [Windows.MessageBox]::Show($script:button, 'Shut JARVIS down completely until you start it again?', 'JARVIS', 'YesNo', 'Question')
  if ($ok -ne 'Yes') { return }
  $closed = if (HelperReady) { [JarvisWindows]::Close($HudTitle) } else { 0 }
  Put $StopFile ((Get-Date).ToString('o'))
  Say ('[button] exit requested; closed {0} HUD window(s)' -f $closed)
  $script:app.Shutdown()
})

# ---------------------------------------------------------------------------
# The question
# ---------------------------------------------------------------------------

$promptXaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        Title="JARVIS" SizeToContent="WidthAndHeight"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        Topmost="True" ShowInTaskbar="False" ResizeMode="NoResize" ShowActivated="False">
  <Window.Resources>
    <Style TargetType="Button">
      <Setter Property="Foreground" Value="#CFE9F3" />
      <Setter Property="Background" Value="#14222A" />
      <Setter Property="BorderBrush" Value="#335A6B" />
      <Setter Property="Padding" Value="18,5" />
      <Setter Property="Margin" Value="8,0,0,0" />
      <Setter Property="Cursor" Value="Hand" />
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border Name="Box" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}"
                    BorderThickness="1" CornerRadius="5" Padding="{TemplateBinding Padding}">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center" />
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="Box" Property="BorderBrush" Value="#4FD8FF" />
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Window.Resources>
  <Border Background="#F00A141B" BorderBrush="#554FD8FF" BorderThickness="1" CornerRadius="10" Padding="16,12,16,14" Margin="12">
    <Border.Effect>
      <DropShadowEffect BlurRadius="18" ShadowDepth="0" Opacity="0.5" />
    </Border.Effect>
    <StackPanel Width="250">
      <TextBlock Text="J.A.R.V.I.S." Foreground="#4FD8FF" FontSize="10" FontWeight="SemiBold" />
      <TextBlock Text="Are you in the mood for JARVIS today?" Foreground="#E6F4FA" FontSize="14"
                 TextWrapping="Wrap" Margin="0,6,0,12" />
      <StackPanel Orientation="Horizontal" HorizontalAlignment="Right">
        <Button Name="No" Content="No" />
        <Button Name="Yes" Content="Yes" Background="#1F4FD8FF" BorderBrush="#4FD8FF" Foreground="#FFFFFF" />
      </StackPanel>
    </StackPanel>
  </Border>
</Window>
'@

$script:prompt = $null
$script:promptReason = ''

function Answer([string]$choice, [string]$how) {
  if (-not $script:prompt) { return }
  $reason = $script:promptReason
  # The sign-in answer is today's answer: the supervisor reads it, for one.
  if ($reason -eq 'sign-in') {
    try {
      Put $SessionFile (@{ choice = $choice; how = $how; at = (Get-Date).ToString('o'); supervisorPid = $SupervisorPid } | ConvertTo-Json -Compress)
    } catch {
      Say ('[button] could not record the answer: {0}' -f $_.Exception.Message)
    }
  }
  Say ('[button] {0} question: {1} ({2})' -f $reason, $choice, $how)
  if ($script:promptTimer) { $script:promptTimer.Stop() }
  $p = $script:prompt
  $script:prompt = $null
  $p.Close()
  if ($choice -eq 'yes') { Activate ('yes from ' + $reason) }
  elseif ($how -ne 'unanswered') { Silence ('no from ' + $reason) }
}

# The question, shown at sign-in and on every press of the button. Pressing
# again while it is up just brings it forward.
function ShowPrompt([string]$reason) {
  if ($script:prompt) {
    $script:prompt.Activate() | Out-Null
    return
  }
  $script:promptReason = $reason
  $script:prompt = [Windows.Markup.XamlReader]::Parse($promptXaml)
  $script:prompt.FindName('Yes').Add_Click({ Answer 'yes' 'clicked' })
  $script:prompt.FindName('No').Add_Click({ Answer 'no' 'clicked' })
  $script:prompt.Add_KeyDown({ if ($_.Key -eq 'Escape') { Answer 'no' 'escape' } })
  $script:prompt.Add_Loaded({
    # Just above the button, inside the screen.
    $wa = [Windows.SystemParameters]::WorkArea
    $w = $script:prompt.ActualWidth
    $h = $script:prompt.ActualHeight
    $left = $script:button.Left + 44 - $w + 12
    $top = $script:button.Top - $h
    $script:prompt.Left = [Math]::Min([Math]::Max($left, $wa.Left), $wa.Right - $w)
    $script:prompt.Top = [Math]::Min([Math]::Max($top, $wa.Top), $wa.Bottom - $h)
  })
  # Left alone, it goes away quietly: at sign-in that counts as no; after a
  # press it changes nothing.
  $script:promptTimer = New-Object Windows.Threading.DispatcherTimer
  $script:promptTimer.Interval = if ($reason -eq 'sign-in') { [TimeSpan]::FromMinutes(2) } else { [TimeSpan]::FromSeconds(45) }
  $script:promptTimer.Add_Tick({ Answer 'no' 'unanswered' })
  $script:promptTimer.Start()
  $script:prompt.Show()
  # Brought to the front, so a press is answered by a visible question.
  if ($reason -ne 'sign-in') { $script:prompt.Activate() | Out-Null }
  Say ('[button] asked ({0}): are you in the mood for JARVIS today?' -f $reason)
}

function AskOnce {
  # Already answered this sign-in (the button was restarted): not again at
  # start-up. A press of the button still asks, every time.
  if (Test-Path -LiteralPath $SessionFile) { return }
  ShowPrompt 'sign-in'
}

# ---------------------------------------------------------------------------

$script:promptTimer = $null
$script:app = New-Object Windows.Application
$script:app.ShutdownMode = 'OnExplicitShutdown'
$script:app.Add_DispatcherUnhandledException({
  Say ('[button] error: {0}' -f $_.Exception.Message)
  $_.Handled = $true
})

if (-not (Get-Process -Id $SupervisorPid -ErrorAction SilentlyContinue)) {
  Say '[button] supervisor is not running; nothing to show'
  exit 0
}
Place
$script:button.Show()
Refresh
Say '[button] on screen'
if ($Ask) { AskOnce }

# Compiled just after the windows have painted. A click before then still works,
# it just asks the supervisor for the HUD instead of looking for an open one.
$compile = New-Object Windows.Threading.DispatcherTimer
$compile.Interval = [TimeSpan]::FromMilliseconds(300)
$compile.Add_Tick({
  $compile.Stop()
  try { Add-Type -TypeDefinition $windowHelper } catch { Say ('[button] window helper unavailable: {0}' -f $_.Exception.Message) }
})
$compile.Start()

$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(2)
$timer.Add_Tick({ Refresh })
$timer.Start()

[void]$script:app.Run()
$script:mutex.ReleaseMutex()
