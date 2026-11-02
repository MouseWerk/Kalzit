<#
.SYNOPSIS
  Walks through the installer's wizard on a CI runner and saves a picture of every page, in
  English and German: installs through each page, then removes Kalzit and its data through the
  removal pages. With -HighContrast it then turns on a contrast theme and shows the first pages in
  it (stopped before anything is installed).

  Only for a disposable machine (the CI job `msi`): it installs and removes a Windows service and
  changes the display's contrast setting. The pictures go to -Out as <language>-<nn>-<page>.png.
#>
param(
    [Parameter(Mandatory)] [string] $Msi,
    [Parameter(Mandatory)] [string] $Out,
    [int] $Port = 8473,
    [switch] $HighContrast
)

$ErrorActionPreference = 'Stop'
$Msi = (Resolve-Path $Msi).Path
New-Item -ItemType Directory -Force $Out | Out-Null
$Out = (Resolve-Path $Out).Path

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class KalzitScreens {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct HIGHCONTRAST { public int cbSize; public int dwFlags; public string lpszDefaultScheme; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool SystemParametersInfo(int action, int param, ref HIGHCONTRAST value, int winIni);
    public static bool SetHighContrast(bool on, string scheme) {
        var hc = new HIGHCONTRAST();
        hc.cbSize = Marshal.SizeOf(typeof(HIGHCONTRAST));
        hc.dwFlags = on ? 1 : 0;
        hc.lpszDefaultScheme = scheme;
        // SPI_SETHIGHCONTRAST, SPIF_SENDCHANGE
        return SystemParametersInfo(0x43, hc.cbSize, ref hc, 2);
    }
}
'@
[void] [KalzitScreens]::SetProcessDPIAware()
$ua = [System.Windows.Automation.AutomationElement]
$buttonType = [System.Windows.Automation.ControlType]::Button
$checkBoxType = [System.Windows.Automation.ControlType]::CheckBox

$texts = @{
    'en' = @{
        Next = 'Next'; Install = 'Install'; Finish = 'Finish'; Remove = 'Remove'; Cancel = 'Cancel'; Yes = 'Yes'
        RemoveData = 'Also remove the data folder and the configuration (cannot be undone)'
    }
    'de' = @{
        Next = 'Weiter'; Install = 'Installieren'; Finish = 'Fertig stellen'; Remove = 'Entfernen'; Cancel = 'Abbrechen'; Yes = 'Ja'
        RemoveData = 'Auch Datenordner und Konfiguration löschen (endgültig)'
    }
}

# The installer's top-level windows: the wizard page and, while open, a dialog over it.
function Get-Windows([int] $ProcessId) {
    $condition = New-Object System.Windows.Automation.PropertyCondition($ua::ProcessIdProperty, $ProcessId)
    @($ua::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition))
}

function Find-Control([int] $ProcessId, [string] $Name, $Type) {
    $byType = New-Object System.Windows.Automation.PropertyCondition($ua::ControlTypeProperty, $Type)
    foreach ($window in Get-Windows $ProcessId) {
        foreach ($control in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $byType)) {
            if (($control.Current.Name -replace '&', '') -eq $Name -and $control.Current.IsEnabled) { return $control }
        }
    }
    $null
}

# The first of the named buttons that is there and enabled; waits for one of them.
function Wait-Button([int] $ProcessId, [string[]] $Names, [int] $Seconds = 120) {
    $until = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $until) {
        foreach ($name in $Names) {
            try { $button = Find-Control $ProcessId $name $buttonType } catch { $button = $null }
            if ($button) { return $button }
        }
        Start-Sleep -Milliseconds 300
    }
    throw "none of the buttons '$($Names -join "', '")' appeared within $Seconds s"
}

function Get-Name($Control) { $Control.Current.Name -replace '&', '' }

function Invoke-Button($Button) {
    $Button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
}

function Save-Window([int] $ProcessId, [string] $File) {
    Start-Sleep -Milliseconds 700
    $window = @(Get-Windows $ProcessId)[0]
    [void] [KalzitScreens]::SetForegroundWindow([IntPtr] $window.Current.NativeWindowHandle)
    Start-Sleep -Milliseconds 300
    $r = $window.Current.BoundingRectangle
    $bitmap = New-Object System.Drawing.Bitmap ([int] $r.Width), ([int] $r.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen([int] $r.X, [int] $r.Y, 0, 0, $bitmap.Size)
        $bitmap.Save((Join-Path $Out $File), [System.Drawing.Imaging.ImageFormat]::Png)
        Write-Host "saved $File ($([int] $r.Width) x $([int] $r.Height))"
    } finally {
        $graphics.Dispose(); $bitmap.Dispose()
    }
}

function Start-Wizard([string[]] $Arguments, [string] $Log) {
    Start-Process msiexec.exe -ArgumentList ($Arguments + @('/l*v', "`"$(Join-Path $Out $Log)`"")) -PassThru
}

# Runs a walk through the wizard; the installer process started here is stopped if it fails.
function Invoke-Walk($Process, [scriptblock] $Walk) {
    try {
        & $Walk
        if (-not $Process.WaitForExit(60000)) { throw "the installer (process $($Process.Id)) did not end" }
    } catch {
        if (-not $Process.HasExited) { Stop-Process -Id $Process.Id -Force }
        throw
    }
}

function Invoke-Language([string] $Language, [string[]] $Transform) {
    $t = $texts[$Language]
    $p = Start-Wizard (@('/i', "`"$Msi`"", "PORT=$Port") + $Transform) "$Language-install.log"
    Invoke-Walk $p {
        $next = Wait-Button $p.Id $t.Next 60
        Save-Window $p.Id "$Language-01-welcome.png"
        Invoke-Button $next
        $next = Wait-Button $p.Id $t.Next
        Save-Window $p.Id "$Language-02-license.png"
        Invoke-Button $next
        $next = Wait-Button $p.Id $t.Next
        Save-Window $p.Id "$Language-03-folder.png"
        Invoke-Button $next
        # The settings page; skipped when an earlier kalzit.toml is still there.
        $button = Wait-Button $p.Id @($t.Next, $t.Install)
        if ((Get-Name $button) -eq $t.Next) {
            Save-Window $p.Id "$Language-04-settings.png"
            Invoke-Button $button
        }
        $install = Wait-Button $p.Id $t.Install
        Save-Window $p.Id "$Language-05-ready.png"
        Invoke-Button $install
        # The progress page, once the Install button is gone (unless it is over by then).
        $until = (Get-Date).AddSeconds(60)
        while ((Get-Date) -lt $until -and (Find-Control $p.Id $t.Install $buttonType)) { Start-Sleep -Milliseconds 100 }
        if (-not (Find-Control $p.Id $t.Finish $buttonType)) { Save-Window $p.Id "$Language-06-progress.png" }
        $finish = Wait-Button $p.Id $t.Finish 300
        Save-Window $p.Id "$Language-07-finish.png"
        Invoke-Button $finish
    }

    # The same package again: Windows Installer opens the maintenance pages.
    $p = Start-Wizard @('/i', "`"$Msi`"") "$Language-remove.log"
    Invoke-Walk $p {
        $next = Wait-Button $p.Id $t.Next 60
        Save-Window $p.Id "$Language-08-maintenance.png"
        Invoke-Button $next
        $remove = Wait-Button $p.Id $t.Remove
        Save-Window $p.Id "$Language-09-repair-or-remove.png"
        Invoke-Button $remove
        $next = Wait-Button $p.Id $t.Next
        Save-Window $p.Id "$Language-10-remove-data.png"
        # The data goes too, so the runner is left as it was.
        $box = Find-Control $p.Id $t.RemoveData $checkBoxType
        if (-not $box) { throw "no check box '$($t.RemoveData)'" }
        $box.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle()
        Invoke-Button $next
        $remove = Wait-Button $p.Id $t.Remove
        Save-Window $p.Id "$Language-11-ready-to-remove.png"
        Invoke-Button $remove
        $finish = Wait-Button $p.Id $t.Finish 300
        Save-Window $p.Id "$Language-12-removed.png"
        Invoke-Button $finish
    }
}

Invoke-Language 'en' @()
Invoke-Language 'de' @('TRANSFORMS=:1031')

if ($HighContrast) {
    if (-not [KalzitScreens]::SetHighContrast($true, 'High Contrast Black')) {
        Write-Warning 'could not turn on high contrast; no contrast pictures'
        return
    }
    Start-Sleep -Seconds 3
    try {
        $t = $texts['en']
        $p = Start-Wizard @('/i', "`"$Msi`"") 'contrast.log'
        Invoke-Walk $p {
            $next = Wait-Button $p.Id $t.Next 60
            Save-Window $p.Id 'contrast-01-welcome.png'
            Invoke-Button $next
            $next = Wait-Button $p.Id $t.Next
            Save-Window $p.Id 'contrast-02-license.png'
            Invoke-Button $next
            $next = Wait-Button $p.Id $t.Next
            Save-Window $p.Id 'contrast-03-folder.png'
            Invoke-Button $next
            [void] (Wait-Button $p.Id @($t.Next, $t.Install))
            Save-Window $p.Id 'contrast-04-settings.png'
            Invoke-Button (Wait-Button $p.Id $t.Cancel)
            Invoke-Button (Wait-Button $p.Id $t.Yes)
            $finish = Wait-Button $p.Id $t.Finish
            Save-Window $p.Id 'contrast-05-stopped.png'
            Invoke-Button $finish
        }
    } finally {
        [void] [KalzitScreens]::SetHighContrast($false, $null)
    }
}
