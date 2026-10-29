<#
.SYNOPSIS
  Checks that an MSI package carries exactly the given kalzit.exe: the installed file (unpacked
  with an administrative installation, `msiexec /a`, which installs nothing) and the copy the
  package's setup steps run from (the Binary table, exported with `wix msi decompile -x`).

.DESCRIPTION
  The release workflow runs this before the MSI is signed (job `windows-msi`), so only a package
  built from the signed program gets a signature; the CI job `msi` runs it as well.
#>
param(
    [Parameter(Mandatory)] [string] $Msi,
    [Parameter(Mandatory)] [string] $Exe,
    [string[]] $Wix = @('wix')
)

$ErrorActionPreference = 'Stop'
$Msi = (Resolve-Path $Msi).Path
$expected = (Get-FileHash (Resolve-Path $Exe).Path -Algorithm SHA256).Hash
$work = Join-Path ([IO.Path]::GetTempPath()) ("kalzit-msi-check-" + [guid]::NewGuid())
New-Item -ItemType Directory $work | Out-Null
try {
    $image = Join-Path $work 'image'
    $p = Start-Process msiexec.exe -ArgumentList @('/a', "`"$Msi`"", '/qn', "TARGETDIR=`"$image`"") -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "msiexec /a ended with $($p.ExitCode)" }
    $installed = @(Get-ChildItem $image -Recurse -Filter kalzit.exe)
    if ($installed.Count -ne 1) { throw "the package holds $($installed.Count) kalzit.exe files, expected 1" }
    if ((Get-FileHash $installed[0].FullName -Algorithm SHA256).Hash -ne $expected) {
        throw 'the kalzit.exe the package installs is not the given program'
    }

    $export = Join-Path $work 'export'
    $command = $Wix[0]
    $arguments = @($Wix | Select-Object -Skip 1) + @('msi', 'decompile', $Msi, '-x', $export, '-o', (Join-Path $work 'package.wxs'))
    & $command @arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "wix msi decompile failed with exit code $LASTEXITCODE" }
    $setup = @(Get-ChildItem $export -Recurse -File | Where-Object { $_.Name -like 'KalzitSetup*' })
    if ($setup.Count -ne 1) { throw "the package holds $($setup.Count) setup copies, expected 1" }
    if ((Get-FileHash $setup[0].FullName -Algorithm SHA256).Hash -ne $expected) {
        throw 'the copy of kalzit.exe the setup steps run is not the given program'
    }
    Write-Host "$Msi carries $Exe (SHA-256 $expected) as the installed program and as the setup copy"
} finally {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $work
}
