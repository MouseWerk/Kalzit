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

$command = $Wix[0]
$arguments = @($Wix | Select-Object -Skip 1) + @(
    'build',
    '-arch', 'x64',
    '-culture', 'en-US',
    '-ext', $UiExtension,
    '-d', "Version=$msiVersion",
    '-d', "ExePath=$exePath",
    '-d', "LicensePath=$license",
    '-o', $Out,
    (Join-Path $PSScriptRoot 'Kalzit.wxs'),
    (Join-Path $PSScriptRoot 'KalzitUI.wxs')
)
& $command @arguments
if ($LASTEXITCODE -ne 0) { throw "wix build failed with exit code $LASTEXITCODE" }
Write-Host "built $Out (MSI version $msiVersion)"
