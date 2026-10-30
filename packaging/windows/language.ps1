<#
.SYNOPSIS
  Language transforms inside one MSI package, through the Windows Installer automation interface.

.DESCRIPTION
  Dot-sourced by build.ps1 and check-msi.ps1. The package is built once per language; each further
  language becomes a transform (the difference to the English package) stored inside the English
  one under its language ID, and the package's Template summary lists the languages
  ("x64;1033,1031"). Windows Installer then applies the transform by itself when the Windows
  display language matches, so the release keeps a single MSI file. `TRANSFORMS=:1031` on the
  msiexec command line applies it on any Windows.
#>

$script:MsiReadOnly = 0
$script:MsiTransact = 1
$script:MsiViewModifyAssign = 3
$script:MsiSummaryTemplate = 7

# Late-bound calls; arguments are unwrapped from PowerShell's wrappers (a string from Join-Path
# would otherwise reach the interface as an object and fail with a type mismatch).
function Invoke-MsiMember($Object, [string] $Name, [Reflection.BindingFlags] $Kind, [object[]] $Arguments) {
    $plain = [object[]]::new($Arguments.Count)
    for ($n = 0; $n -lt $Arguments.Count; $n++) {
        $a = $Arguments[$n]
        $plain[$n] = if ($null -eq $a) { $null } else { $a.psobject.BaseObject }
    }
    $Object.GetType().InvokeMember($Name, $Kind, $null, $Object, $plain)
}

function Invoke-Msi($Object, [string] $Method, [object[]] $Arguments = @()) {
    Invoke-MsiMember $Object $Method ([Reflection.BindingFlags]::InvokeMethod) $Arguments
}

function Get-MsiProperty($Object, [string] $Name, [object[]] $Arguments = @()) {
    Invoke-MsiMember $Object $Name ([Reflection.BindingFlags]::GetProperty) $Arguments
}

function Set-MsiProperty($Object, [string] $Name, [object[]] $Arguments) {
    [void] (Invoke-MsiMember $Object $Name ([Reflection.BindingFlags]::SetProperty) $Arguments)
}

function Close-Msi([object[]] $Objects) {
    foreach ($o in $Objects) {
        if ($null -ne $o) { [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($o) }
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}

# Stores the difference from $Base to $Localized inside $Base as the transform $LanguageId and
# adds the language to the package's Template summary. Returns the transform's size in bytes.
function Add-LanguageTransform([string] $Base, [string] $Localized, [int] $LanguageId, [string] $Work) {
    $transform = Join-Path $Work "$LanguageId.mst"
    $installer = $null; $baseDb = $null; $localizedDb = $null
    $db = $null; $view = $null; $record = $null; $summary = $null
    try {
        $installer = New-Object -ComObject WindowsInstaller.Installer
        $baseDb = Invoke-Msi $installer 'OpenDatabase' @($Base, $script:MsiReadOnly)
        $localizedDb = Invoke-Msi $installer 'OpenDatabase' @($Localized, $script:MsiReadOnly)
        if (-not (Invoke-Msi $localizedDb 'GenerateTransform' @($baseDb, $transform))) {
            throw "the $LanguageId package does not differ from the base package"
        }
        # No error suppressed and no validation: the transform belongs to this one package.
        [void] (Invoke-Msi $localizedDb 'CreateTransformSummaryInfo' @($baseDb, $transform, 0, 0))
        # The base package is opened for writing below; its read-only handle goes first.
        Close-Msi @($localizedDb, $baseDb)
        $localizedDb = $null; $baseDb = $null

        $db = Invoke-Msi $installer 'OpenDatabase' @($Base, $script:MsiTransact)
        $view = Invoke-Msi $db 'OpenView' @('SELECT `Name`, `Data` FROM `_Storages`')
        [void] (Invoke-Msi $view 'Execute')
        $record = Invoke-Msi $installer 'CreateRecord' @(2)
        Set-MsiProperty $record 'StringData' @(1, "$LanguageId")
        Invoke-Msi $record 'SetStream' @(2, $transform) | Out-Null
        Invoke-Msi $view 'Modify' @($script:MsiViewModifyAssign, $record) | Out-Null
        Invoke-Msi $view 'Close' | Out-Null

        $summary = Get-MsiProperty $db 'SummaryInformation' @(1)
        $template = [string] (Get-MsiProperty $summary 'Property' @($script:MsiSummaryTemplate))
        if ($template -notmatch '^([^;]*);(.+)$') { throw "unexpected package template '$template'" }
        $languages = @($Matches[2] -split ',') + @("$LanguageId") | Select-Object -Unique
        Set-MsiProperty $summary 'Property' @($script:MsiSummaryTemplate, "$($Matches[1]);$($languages -join ',')")
        Invoke-Msi $summary 'Persist' | Out-Null
        Invoke-Msi $db 'Commit' | Out-Null
        (Get-Item $transform).Length
    } finally {
        Close-Msi @($summary, $record, $view, $db, $localizedDb, $baseDb, $installer)
    }
}

# The languages of the package's Template summary, for example @('1033', '1031').
function Get-PackageLanguages([string] $Msi) {
    $installer = $null; $db = $null; $summary = $null
    try {
        $installer = New-Object -ComObject WindowsInstaller.Installer
        $db = Invoke-Msi $installer 'OpenDatabase' @($Msi, $script:MsiReadOnly)
        $summary = Get-MsiProperty $db 'SummaryInformation' @(0)
        $template = [string] (Get-MsiProperty $summary 'Property' @($script:MsiSummaryTemplate))
        @(($template -split ';', 2)[1] -split ',')
    } finally {
        Close-Msi @($summary, $db, $installer)
    }
}

# Runs a query on the package with its embedded transform $LanguageId applied (in memory only;
# the file is not changed; 0 applies none) and returns the first column of each row (an empty
# string for an empty cell).
function Get-TransformedValues([string] $Msi, [int] $LanguageId, [string] $Query) {
    $installer = $null; $db = $null; $view = $null
    try {
        $installer = New-Object -ComObject WindowsInstaller.Installer
        $db = Invoke-Msi $installer 'OpenDatabase' @($Msi, $script:MsiReadOnly)
        if ($LanguageId -ne 0) { Invoke-Msi $db 'ApplyTransform' @(":$LanguageId", 0) | Out-Null }
        $view = Invoke-Msi $db 'OpenView' @($Query)
        [void] (Invoke-Msi $view 'Execute')
        while ($null -ne ($record = Invoke-Msi $view 'Fetch')) {
            try { [string] (Get-MsiProperty $record 'StringData' @(1)) } finally { Close-Msi @($record) }
        }
    } finally {
        Close-Msi @($view, $db, $installer)
    }
}
