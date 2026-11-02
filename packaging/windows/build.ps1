<#
.SYNOPSIS
  Builds the Kalzit MSI package (kalzit-<version>-windows-x64.msi) from a built kalzit.exe.

.DESCRIPTION
  Needs WiX v5 and its UI extension:

    dotnet tool install --global wix --version 5.0.2
    wix extension add --global WixToolset.UI.wixext/5.0.2

  The release workflow (.github/workflows/release.yml) and the CI job `msi` run this script; it
  works the same on a development machine. The MSI version is the release version without a
  pre-release part (0.5.0-rc.1 becomes 0.5.0), since Windows Installer versions are numbers only.

.EXAMPLE
  ./packaging/windows/build.ps1 -Exe target/release/kalzit.exe -Version 0.5.0 -Out dist/kalzit-0.5.0-windows-x64.msi
#>
param(
    [Parameter(Mandatory)] [string] $Exe,
    [Parameter(Mandatory)] [string] $Version,
    [Parameter(Mandatory)] [string] $Out,
    # The WiX command, for a WiX that is not on PATH (for example `dotnet path\to\wix.dll`).
    [string[]] $Wix = @('wix'),
    # The UI extension by name (from the global cache) or as a path to its DLL.
    [string] $UiExtension = 'WixToolset.UI.wixext'
)

$ErrorActionPreference = 'Stop'

if ($Version -notmatch '^(\d+\.\d+\.\d+)([-+].*)?$') {
    throw "the version must look like 1.2.3 or 1.2.3-rc.1, not '$Version'"
}
$msiVersion = $Matches[1]
$exePath = (Resolve-Path $Exe).Path
$license = (Resolve-Path (Join-Path $PSScriptRoot '..\..\LICENSE')).Path
$outDir = Split-Path -Parent $Out
if ($outDir) { New-Item -ItemType Directory -Force $outDir | Out-Null }

. (Join-Path $PSScriptRoot 'language.ps1')

# One product code for every language of this build, so a language transform changes only texts.
$productCode = '{' + [guid]::NewGuid().ToString().ToUpperInvariant() + '}'

function Build-Package([string] $Culture, [string] $Path) {
    $command = $Wix[0]
    $arguments = @($Wix | Select-Object -Skip 1) + @(
        'build',
        '-arch', 'x64',
        '-culture', $Culture,
        '-ext', $UiExtension,
        '-loc', (Join-Path $PSScriptRoot 'Kalzit.en-US.wxl'),
        '-loc', (Join-Path $PSScriptRoot 'Kalzit.de-DE.wxl'),
        '-d', "Version=$msiVersion",
        '-d', "ProductCode=$productCode",
        '-d', "ExePath=$exePath",
        '-d', "LicensePath=$license",
        '-o', $Path,
        (Join-Path $PSScriptRoot 'Kalzit.wxs'),
        (Join-Path $PSScriptRoot 'KalzitUI.wxs')
    )
    & $command @arguments
    if ($LASTEXITCODE -ne 0) { throw "wix build ($Culture) failed with exit code $LASTEXITCODE" }
}

# English is the package itself; German goes inside it as the transform 1031, which Windows
# Installer applies on its own when the Windows display language is German. The release keeps
# one MSI file.
$work = Join-Path ([IO.Path]::GetTempPath()) ("kalzit-msi-build-" + [guid]::NewGuid())
New-Item -ItemType Directory $work | Out-Null
try {
    Build-Package 'en-US' $Out
    $german = Join-Path $work 'kalzit-de-DE.msi'
    Build-Package 'de-DE' $german
    $transformSize = Add-LanguageTransform -Base (Resolve-Path $Out).Path -Localized $german -LanguageId 1031 -Work $work
    # Texts only: a transform this large would carry a second copy of the program or the cabinet.
    if ($transformSize -gt 1MB) { throw "the German transform has $transformSize bytes; it should hold texts only" }
} finally {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $work
}
Write-Host "built $Out (MSI version $msiVersion; languages $((Get-PackageLanguages (Resolve-Path $Out).Path) -join ', '); German transform $transformSize bytes)"
