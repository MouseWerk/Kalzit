<#
.SYNOPSIS
  Signs Windows files with Authenticode (SHA-256, RFC 3161 time stamp) and verifies each
  signature.

.DESCRIPTION
  Run by the release workflow (.github/workflows/release.yml, jobs `windows-sign-exe` and
  `windows-sign-msi`, environment `windows-signing`) for kalzit.exe and the MSI package. Two ways:

  - `-Mode artifact-signing` (recommended): Microsoft Artifact Signing (formerly Azure Trusted
    Signing). The private key stays in Microsoft's HSM; signtool signs through the signing client
    library (NuGet package Microsoft.ArtifactSigning.Client, pinned by version and SHA-256). The
    account comes from ARTIFACT_SIGNING_ENDPOINT, ARTIFACT_SIGNING_ACCOUNT and
    ARTIFACT_SIGNING_PROFILE; the credentials of an Entra ID app with the role "Artifact Signing
    Certificate Profile Signer" from AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET.
  - `-Mode pfx`: a code-signing certificate with an exportable key, CERT (the PFX in base64) and
    CERT_PASSWORD. The certificate is imported into the current user's store, without the
    password ever on a command line, used by its thumbprint and removed with its key afterwards;
    the PFX file exists only during the import.

  Nothing but signtool from the Windows SDK runs while the key material is present.
#>
param(
    [Parameter(Mandatory)] [string[]] $Files,
    [Parameter(Mandatory)] [ValidateSet('artifact-signing', 'pfx')] [string] $Mode,
    [string] $TimestampUrl
)

$ErrorActionPreference = 'Stop'

# The newest signtool of the installed Windows SDKs.
$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue |
    Sort-Object { [version]($_.Directory.Parent.Name) } -Descending |
    Select-Object -First 1
if (-not $signtool) { throw 'signtool.exe was not found (Windows SDK)' }
$signtool = $signtool.FullName

function Test-Signature([string] $File) {
    & $signtool verify /pa /v $File | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "the signature of $File does not verify" }
    Write-Host "signed $File"
}

$work = Join-Path ([IO.Path]::GetTempPath()) ("kalzit-sign-" + [guid]::NewGuid())
New-Item -ItemType Directory $work | Out-Null
try {
    if ($Mode -eq 'artifact-signing') {
        foreach ($name in 'ARTIFACT_SIGNING_ENDPOINT', 'ARTIFACT_SIGNING_ACCOUNT', 'ARTIFACT_SIGNING_PROFILE', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET') {
            if (-not [Environment]::GetEnvironmentVariable($name)) { throw "$name is not set" }
        }
        $version = '1.0.146'
        $sha256 = '7761E5D8F31E54B764DA21D33CD8B0A2940E1B05526C7DFCB5E94B0431426F70'
        $package = Join-Path $work 'client.zip'
        Invoke-WebRequest "https://www.nuget.org/api/v2/package/Microsoft.ArtifactSigning.Client/$version" -OutFile $package
        if ((Get-FileHash $package -Algorithm SHA256).Hash -ne $sha256) { throw 'the signing client package does not match its pinned SHA-256' }
        Expand-Archive $package (Join-Path $work 'client')
        $dlib = Join-Path $work 'client\bin\x64\Azure.CodeSigning.Dlib.dll'
        $metadata = Join-Path $work 'metadata.json'
        @{
            Endpoint = $env:ARTIFACT_SIGNING_ENDPOINT
            CodeSigningAccountName = $env:ARTIFACT_SIGNING_ACCOUNT
            CertificateProfileName = $env:ARTIFACT_SIGNING_PROFILE
        } | ConvertTo-Json | Set-Content -Encoding utf8 $metadata
        if (-not $TimestampUrl) { $TimestampUrl = 'http://timestamp.acs.microsoft.com' }
        foreach ($file in $Files) {
            & $signtool sign /v /fd SHA256 /tr $TimestampUrl /td SHA256 /d Kalzit /dlib $dlib /dmdf $metadata $file
            if ($LASTEXITCODE -ne 0) { throw "signing $file failed" }
            Test-Signature $file
        }
    } else {
        if (-not $env:CERT) { throw 'CERT (the PFX in base64) is not set' }
        if (-not $TimestampUrl) { $TimestampUrl = 'http://timestamp.digicert.com' }
        $pfx = Join-Path $work 'cert.pfx'
        [IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($env:CERT))
        $password = if ($env:CERT_PASSWORD) { ConvertTo-SecureString $env:CERT_PASSWORD -AsPlainText -Force } else { New-Object System.Security.SecureString }
        $cert = Import-PfxCertificate -FilePath $pfx -CertStoreLocation Cert:\CurrentUser\My -Password $password
        Remove-Item -Force $pfx
        try {
            $thumbprint = ($cert | Where-Object { $_.HasPrivateKey } | Select-Object -First 1).Thumbprint
            if (-not $thumbprint) { throw 'the PFX holds no certificate with a private key' }
            foreach ($file in $Files) {
                & $signtool sign /sha1 $thumbprint /s My /fd SHA256 /tr $TimestampUrl /td SHA256 /d Kalzit $file
                if ($LASTEXITCODE -ne 0) { throw "signing $file failed" }
                Test-Signature $file
            }
        } finally {
            foreach ($c in $cert) { Remove-Item -Force -DeleteKey "Cert:\CurrentUser\My\$($c.Thumbprint)" -ErrorAction SilentlyContinue }
        }
    }
} finally {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $work
}
