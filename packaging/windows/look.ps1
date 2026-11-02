<#
.SYNOPSIS
  The installer's look that WiX cannot express: the license as RTF, and texts drawn opaque.

.DESCRIPTION
  Dot-sourced by build.ps1 after language.ps1 (it uses its Windows Installer helpers).

  ConvertTo-LicenseRtf turns the plain LICENSE into the RTF the license page shows: paragraphs
  flow with the box instead of keeping the file's line breaks, headings are bold, Segoe UI as in
  the rest of the wizard.

  Set-OpaqueTexts clears the Transparent flag of every text in the package. WixUI draws its page
  titles and descriptions transparently on the banner and the welcome picture, so in a contrast
  theme, whose text color is white or yellow, they would stand on the light picture and vanish.
  Opaque, each text gets the dialog background of the current theme behind it; with the normal
  theme that is the light grey the pictures leave free for the texts (art/*.svg), so nothing
  changes there.
#>

function ConvertTo-LicenseRtf([string] $License, [string] $Rtf) {
    $text = [IO.File]::ReadAllText($License) -replace "`r`n", "`n"
    $body = [Text.StringBuilder]::new()
    foreach ($block in ($text -split "\n[ \t]*\n")) {
        $lines = @($block -split "`n" | Where-Object { $_.Trim() })
        if ($lines.Count -eq 0) { continue }
        $indent = ($lines | ForEach-Object { $_.Length - $_.TrimStart().Length } | Measure-Object -Minimum).Minimum
        $flow = (($lines | ForEach-Object { $_.Trim() }) -join ' ') -replace '\s+', ' '
        $escaped = Get-RtfText $flow
        if ($indent -ge 8) {
            # Centered in the file: the title, "Preamble", "TERMS AND CONDITIONS" and the like.
            $joined = (($lines | ForEach-Object { Get-RtfText $_.Trim() }) -join '\line ')
            [void] $body.Append("\pard\qc\sb160\sa120\b $joined\b0\par`n")
        } elseif ($lines.Count -eq 1 -and $flow -match '^\d+\. .{1,80}\.$') {
            # A section heading, "0. Definitions."
            [void] $body.Append("\pard\sb160\sa80\b $escaped\b0\par`n")
        } elseif ($indent -ge 4) {
            [void] $body.Append("\pard\li360\sa120 $escaped\par`n")
        } else {
            [void] $body.Append("\pard\sa120 $escaped\par`n")
        }
    }
    $document = "{\rtf1\ansi\ansicpg1252\deff0{\fonttbl{\f0\fswiss\fcharset0 Segoe UI;}}\viewkind4\uc1\f0\fs16`n$body}"
    [IO.File]::WriteAllText($Rtf, $document, [Text.Encoding]::ASCII)
}

# Escapes RTF's special characters; anything beyond ASCII becomes a Unicode escape.
function Get-RtfText([string] $Value) {
    $out = [Text.StringBuilder]::new()
    foreach ($c in $Value.ToCharArray()) {
        if ($c -eq '\' -or $c -eq '{' -or $c -eq '}') { [void] $out.Append('\').Append($c) }
        elseif ([int] $c -gt 127) { [void] $out.Append("\u$([int16] [int] $c)?") }
        else { [void] $out.Append($c) }
    }
    $out.ToString()
}

$script:MsiViewModifyUpdate = 2
$script:MsiControlTransparent = 0x10000

function Set-OpaqueTexts([string] $Msi) {
    $installer = $null; $db = $null; $view = $null
    try {
        $installer = New-Object -ComObject WindowsInstaller.Installer
        $db = Invoke-Msi $installer 'OpenDatabase' @($Msi, $script:MsiTransact)
        $view = Invoke-Msi $db 'OpenView' @("SELECT ``Dialog_``, ``Control``, ``Attributes`` FROM ``Control`` WHERE ``Type`` = 'Text'")
        [void] (Invoke-Msi $view 'Execute')
        $changed = 0
        while ($null -ne ($record = Invoke-Msi $view 'Fetch')) {
            try {
                $attributes = [int] (Get-MsiProperty $record 'IntegerData' @(3))
                if ($attributes -band $script:MsiControlTransparent) {
                    Set-MsiProperty $record 'IntegerData' @(3, ($attributes -bxor $script:MsiControlTransparent))
                    Invoke-Msi $view 'Modify' @($script:MsiViewModifyUpdate, $record) | Out-Null
                    $changed++
                }
            } finally { Close-Msi @($record) }
        }
        Invoke-Msi $view 'Close' | Out-Null
        Invoke-Msi $db 'Commit' | Out-Null
        $changed
    } finally {
        Close-Msi @($view, $db, $installer)
    }
}
