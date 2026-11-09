# gui.ps1 - Windows GUI automation (UIA + screenshot + input)
# Run OUTSIDE the sandbox: powershell -NoProfile -ExecutionPolicy Bypass -File gui.ps1 ...
#
# Usage:
#   gui.ps1 windows                                   list visible top-level windows
#   gui.ps1 tree <title-substring> [-Depth N]         dump UIA tree of a window
#   gui.ps1 shot [-Window <title>] [-Out <file>]      screenshot (full screen or window)
#   gui.ps1 click -X N -Y N                          click screen coordinates
#   gui.ps1 click -Window <title> -Name <name>       click/invoke a control by name
#   gui.ps1 type "text"                              type Unicode text to focus
#   gui.ps1 key CTRL+S                               send key / combo

param(
  [Parameter(Position=0, Mandatory=$true)][string]$Command,
  [Parameter(Position=1)][string]$Arg,
  [string]$Window = '',
  [string]$Name = '',
  [int]$X = -99999,
  [int]$Y = -99999,
  [string]$Out = '',
  [int]$Depth = 4,
  [int]$MaxNodes = 600
)

$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class GInput {
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public MOUSEINPUT mi; [FieldOffset(8)] public KEYBDINPUT ki; }
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] p, int cb);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int nCmdShow);
  public const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  public const uint KEYEVENTF_KEYUP = 2, KEYEVENTF_UNICODE = 4;
  public const uint MOUSEEVENTF_LEFTDOWN = 2, MOUSEEVENTF_LEFTUP = 4;

  public static void SendText(string text) {
    foreach (char ch in text) {
      INPUT[] arr = new INPUT[2];
      arr[0].type = INPUT_KEYBOARD; arr[0].ki.wScan = (ushort)ch; arr[0].ki.dwFlags = KEYEVENTF_UNICODE;
      arr[1].type = INPUT_KEYBOARD; arr[1].ki.wScan = (ushort)ch; arr[1].ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
      SendInput(2, arr, Marshal.SizeOf(typeof(INPUT)));
    }
  }

  public static void SendKey(ushort vk, bool up) {
    INPUT[] arr = new INPUT[1];
    arr[0].type = INPUT_KEYBOARD;
    arr[0].ki.wVk = vk;
    arr[0].ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
    SendInput(1, arr, Marshal.SizeOf(typeof(INPUT)));
  }

  public static void ClickAt(int x, int y) {
    SetCursorPos(x, y);
    INPUT[] arr = new INPUT[2];
    arr[0].type = INPUT_MOUSE; arr[0].mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
    arr[1].type = INPUT_MOUSE; arr[1].mi.dwFlags = MOUSEEVENTF_LEFTUP;
    SendInput(2, arr, Marshal.SizeOf(typeof(INPUT)));
  }
}
"@

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$TC = [System.Windows.Automation.Condition]::TrueCondition

function Get-TopWindows {
  return $AE::RootElement.FindAll($TS::Children, $TC)
}

function Find-Window([string]$title) {
  foreach ($k in (Get-TopWindows)) {
    try {
      if ($k.Current.Name -like "*$title*") { return $k }
    } catch {}
  }
  return $null
}

function Get-NodeLine($el) {
  $name = ''
  $ct = ''
  $autoId = ''
  $rect = ''
  $value = ''
  try {
    $name = $el.Current.Name
    $ct = $el.Current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
    $autoId = $el.Current.AutomationId
    $r = $el.Current.BoundingRectangle
    if ($r.Width -gt 0 -and $r.Height -gt 0) { $rect = "@{0},{1} {2}x{3}" -f [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height }
  } catch {}
  try {
    $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $value = $vp.Current.Value
  } catch {}
  $line = "{0} [{1}]" -f $ct, $name
  if ($autoId) { $line += " id=$autoId" }
  if ($value) { $line += ' value="' + $value + '"' }
  if ($rect) { $line += " $rect" }
  return $line
}

function Dump-Tree($el, [int]$d, [int]$maxD, [int]$maxN, [ref]$count, [System.Text.StringBuilder]$sb) {
  if ($d -gt $maxD) { return }
  if ($count.Value -ge $maxN) { return }
  $count.Value++
  [void]$sb.AppendLine(('  ' * $d) + (Get-NodeLine $el))
  if ($d -eq $maxD) { return }
  try {
    foreach ($c in $el.FindAll($TS::Children, $TC)) {
      if ($count.Value -ge $maxN) { break }
      Dump-Tree $c ($d + 1) $maxD $maxN $count $sb
    }
  } catch {}
}

switch ($Command.ToLower()) {
  'windows' {
    $i = 0
    foreach ($k in (Get-TopWindows)) {
      try {
        $r = $k.Current.BoundingRectangle
        if ($r.Width -le 0 -or $r.Height -le 0) { continue }
        $i++
        Write-Output ("[{0}] {1} | pid={2} | @{3},{4} {5}x{6}" -f $i, $k.Current.Name, $k.Current.ProcessId, [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height)
      } catch {}
    }
  }
  'tree' {
    if (-not $Arg) { throw 'usage: gui.ps1 tree <window-title-substring> [-Depth N]' }
    $w = Find-Window $Arg
    if (-not $w) { throw "window not found: $Arg" }
    $sb = New-Object System.Text.StringBuilder
    $cnt = 0
    Dump-Tree $w 0 $Depth $MaxNodes ([ref]$cnt) $sb
    Write-Output ("window: " + $w.Current.Name + " | nodes=" + $cnt)
    Write-Output $sb.ToString()
  }
  'shot' {
    if ($Arg) { $Window = $Arg }
    if ($Window) {
      $w = Find-Window $Window
      if (-not $w) { throw "window not found: $Window" }
      $r = $w.Current.BoundingRectangle
      $w2 = [int]$r.Width
      $h2 = [int]$r.Height
      if ($w2 -le 0 -or $h2 -le 0) { throw "window not visible / zero size" }
      $hwnd = [IntPtr]$w.Current.NativeWindowHandle
      $bmp = New-Object System.Drawing.Bitmap $w2, $h2
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $captured = $false
      if ($hwnd -ne [IntPtr]::Zero) {
        $hdc = $g.GetHdc()
        $captured = [GInput]::PrintWindow($hwnd, $hdc, 2)  # PW_RENDERFULLCONTENT
        $g.ReleaseHdc($hdc)
      }
      if (-not $captured) {
        # fallback: bring to front then copy from screen
        $g.CopyFromScreen([int]$r.X, [int]$r.Y, 0, 0, (New-Object System.Drawing.Size $w2, $h2))
      }
      $g.Dispose()
    } else {
      $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($b.X, $b.Y, 0, 0, $b.Size)
      $g.Dispose()
    }
    $outPath = if ($Out) { $Out } else { Join-Path (Get-Location) 'shot.png' }
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output ("saved: " + $outPath)
  }
  'click' {
    if ($Window) {
      $w = Find-Window $Window
      if (-not $w) { throw "window not found: $Window" }
      $h = [IntPtr]$w.Current.NativeWindowHandle
      if ($h -ne [IntPtr]::Zero) {
        [void][GInput]::ShowWindow($h, 9)
        [void][GInput]::SetForegroundWindow($h)
        Start-Sleep -Milliseconds 300
      }
    }
    if ($X -ne -99999 -and $Y -ne -99999) {
      [GInput]::ClickAt($X, $Y)
      Write-Output ("clicked @{0},{1}" -f $X, $Y)
    } elseif ($Window -and $Name) {
      $w = Find-Window $Window
      if (-not $w) { throw "window not found: $Window" }
      $cond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $Name)
      $el = $w.FindFirst($TS::Descendants, $cond)
      if (-not $el) { throw "control not found: $Name" }
      try {
        $inv = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $inv.Invoke()
        Write-Output ("invoked: " + $Name)
      } catch {
        $r = $el.Current.BoundingRectangle
        [GInput]::ClickAt([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
        Write-Output ("clicked center: " + $Name)
      }
    } else {
      throw 'usage: gui.ps1 click -X N -Y N | gui.ps1 click -Window <title> -Name <name>'
    }
  }
  'type' {
    if (-not $Arg) { throw 'usage: gui.ps1 type "text"' }
    [GInput]::SendText($Arg)
    Write-Output ("typed: " + $Arg)
  }
  'key' {
    if (-not $Arg) { throw 'usage: gui.ps1 key CTRL+S' }
    $map = @{
      'CTRL' = 0x11; 'CONTROL' = 0x11; 'ALT' = 0x12; 'SHIFT' = 0x10; 'WIN' = 0x5B
      'ENTER' = 0x0D; 'RETURN' = 0x0D; 'TAB' = 0x09; 'ESC' = 0x1B; 'ESCAPE' = 0x1B
      'SPACE' = 0x20; 'BACKSPACE' = 0x08; 'DELETE' = 0x2E; 'UP' = 0x26; 'DOWN' = 0x28
      'LEFT' = 0x25; 'RIGHT' = 0x27; 'HOME' = 0x24; 'END' = 0x23; 'PAGEUP' = 0x21; 'PAGEDOWN' = 0x22
    }
    for ($i = 1; $i -le 12; $i++) { $map["F$i"] = 0x70 + $i - 1 }
    $parts = $Arg.ToUpper() -split '\+'
    $vks = @()
    foreach ($p in $parts) {
      if ($map.ContainsKey($p)) { $vks += $map[$p] }
      elseif ($p.Length -eq 1 -and $p -match '[A-Z0-9]') { $vks += [int][char]$p }
      else { throw "unknown key: $p" }
    }
    foreach ($vk in $vks) { [GInput]::SendKey([uint16]$vk, $false) }
    foreach ($vk in ($vks | Sort-Object -Descending)) { [GInput]::SendKey([uint16]$vk, $true) }
    Write-Output ("key sent: " + $Arg)
  }
  default {
    throw "unknown command: $Command (windows|tree|shot|click|type|key)"
  }
}
