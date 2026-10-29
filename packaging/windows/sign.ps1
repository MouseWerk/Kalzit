<#
.SYNOPSIS
  Signs Windows files with Authenticode (SHA-256, RFC 3161 time stamp) using the code-signing
  certificate in the environment: CERT is the PFX file in base64, CERT_PASSWORD its password.

.DESCRIPTION
  Run by the release workflow (.github/workflows/release.yml, job `windows-package`) for
  kalzit.exe and the MSI package. The PFX is written to the runner's temporary folder only for
  the signing and removed afterwards; every signature is verified.
#>
param(
    [Parameter(Mandatory)] [string[]] $Files,
    [string] $TimestampUrl = 'http://timestamp.digicert.com'
)

$ErrorActionPreference = 'Stop'
if (-not $env:CERT) { throw 'CERT (the PFX in base64) is not set' }

# The newest signtool of the installed Windows SDKs.
$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue |
    Sort-Object { [version]($_.Directory.Parent.Name) } -Descending |
    Select-Object -First 1
if (-not $signtool) { throw 'signtool.exe was not found (Windows SDK)' }

$pfx = Join-Path ([IO.Path]::GetTempPath()) ("kalzit-sign-" + [guid]::NewGuid() + ".pfx")
try {
    [IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($env:CERT))
    foreach ($file in $Files) {
        $arguments = @('sign', '/f', $pfx, '/fd', 'SHA256', '/tr', $TimestampUrl, '/td', 'SHA256', '/d', 'Kalzit')
        if ($env:CERT_PASSWORD) { $arguments += @('/p', $env:CERT_PASSWORD) }
        & $signtool.FullName @arguments $file
        if ($LASTEXITCODE -ne 0) { throw "signing $file failed" }
        & $signtool.FullName verify /pa /v $file | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "the signature of $file does not verify" }
        Write-Host "signed $file"
    }
} finally {
    Remove-Item -Force -ErrorAction SilentlyContinue $pfx
}
