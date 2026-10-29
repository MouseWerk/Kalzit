<#
.SYNOPSIS
  Installs the Kalzit MSI package on a CI runner and checks the result: service running as
  NT SERVICE\Kalzit, HTTP health, data folder access list, firewall rule, recovery actions, a
  graceful stop, an uninstallation that keeps the data, a reinstallation on the kept data, an
  uninstallation that removes it, and the same through `kalzit service install|uninstall`.

  Only for a disposable machine (the CI job `msi`): it installs and removes a Windows service.
#>
param(
    [Parameter(Mandatory)] [string] $Msi,
    # The built kalzit.exe, for the `kalzit service install` part.
    [Parameter(Mandatory)] [string] $Exe,
    [Parameter(Mandatory)] [string] $Logs,
    [int] $Port = 8471
)

$ErrorActionPreference = 'Stop'
# msiexec does not resolve paths against PowerShell's location.
$Msi = (Resolve-Path $Msi).Path
$Exe = (Resolve-Path $Exe).Path
New-Item -ItemType Directory -Force $Logs | Out-Null
$Logs = (Resolve-Path $Logs).Path
$programData = [Environment]::GetFolderPath('CommonApplicationData')
$configFile = Join-Path $programData 'Kalzit\kalzit.toml'
$dataDir = Join-Path $programData 'Kalzit\data'

function Step($text) { Write-Host "::group::$text" }
function EndStep { Write-Host '::endgroup::' }
function Fail($text) { throw "FAILED: $text" }

function Invoke-Msi([string[]] $Arguments, [string] $Log) {
    $all = $Arguments + @('/qn', '/norestart', '/l*v', (Join-Path $Logs $Log))
    $p = Start-Process msiexec.exe -ArgumentList $all -Wait -PassThru
    if ($p.ExitCode -ne 0) { Fail "msiexec $($Arguments -join ' ') ended with $($p.ExitCode) (log: $Log)" }
}

function Get-KalzitService { Get-CimInstance Win32_Service -Filter "Name='Kalzit'" }

function Wait-Ready([string] $Url, [int] $Seconds = 90) {
    $until = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $until) {
        try {
            $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5 -SkipCertificateCheck
            if ($r.StatusCode -eq 200) { Write-Host "$Url answered 200"; return }
        } catch { }
        Start-Sleep -Seconds 1
    }
    Fail "$Url did not answer 200 within $Seconds s"
}

function Assert-Running([string] $Account = 'NT SERVICE\Kalzit') {
    $svc = Get-KalzitService
    if (-not $svc) { Fail 'the service Kalzit does not exist' }
    if ($svc.State -ne 'Running') { Fail "the service is $($svc.State), not Running" }
    if ($svc.StartName -ne $Account) { Fail "the service runs as $($svc.StartName), not $Account" }
    if ($svc.StartMode -ne 'Auto') { Fail "the service starts $($svc.StartMode), not Auto" }
    $svc
}

function Get-ServiceSid {
    $line = (sc.exe showsid Kalzit) | Select-String 'S-1-5-80-[0-9-]+'
    if (-not $line) { Fail 'sc showsid Kalzit names no SID' }
    $line.Matches[0].Value
}

function Assert-PrivateDataDir([string] $Dir) {
    $acl = Get-Acl $Dir
    $sid = Get-ServiceSid
    $owner = (New-Object System.Security.Principal.NTAccount($acl.Owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value
    if ($owner -ne 'S-1-5-32-544') { Fail "the data folder belongs to $($acl.Owner), not Administrators" }
    if (-not $acl.AreAccessRulesProtected) { Fail 'the data folder inherits access rules' }
    $sids = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) |
        ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique
    $expected = @('S-1-5-32-544', $sid) | Sort-Object
    if (($sids -join ',') -ne ($expected -join ',')) {
        Fail "the data folder grants access to $($sids -join ', '), expected Administrators and NT SERVICE\Kalzit ($sid)"
    }
    Write-Host "data folder access: Administrators and $sid only"
}

# --- MSI ------------------------------------------------------------------------------------

Step 'Install silently with properties'
Invoke-Msi @('/i', $Msi, "PORT=$Port", 'FIREWALL=1') 'install.log'
$svc = Assert-Running
Wait-Ready "http://127.0.0.1:$Port/readyz"
if (-not (Test-Path $configFile)) { Fail "$configFile was not written" }
Get-Content $configFile
if (-not (Select-String -Path $configFile -Pattern "0.0.0.0:$Port" -Quiet)) { Fail "the configuration does not listen on $Port" }
EndStep

Step 'Data folder, log, firewall, recovery, PATH'
Assert-PrivateDataDir $dataDir
$log = Join-Path $dataDir 'logs\kalzit.log'
if (-not (Test-Path $log)) { Fail "no log at $log" }
Get-Content $log -Tail 20
$rule = Get-NetFirewallRule -DisplayName 'Kalzit' -ErrorAction SilentlyContinue
if (-not $rule) { Fail 'the firewall rule Kalzit is missing' }
$ports = ($rule | Get-NetFirewallPortFilter).LocalPort
if ($ports -notcontains "$Port") { Fail "the firewall rule opens $ports, not $Port" }
$flag = sc.exe qfailureflag Kalzit | Out-String
if ($flag -notmatch 'TRUE') { Fail "recovery on non-crash failures is off: $flag" }
sc.exe qfailure Kalzit
$path = [Environment]::GetEnvironmentVariable('Path', 'Machine')
if ($path -notmatch [regex]::Escape('Program Files\Kalzit')) { Fail 'the program folder is not on the system PATH' }
$exeInstalled = Join-Path ${env:ProgramFiles} 'Kalzit\kalzit.exe'
$code = & $exeInstalled setup-code --config $configFile
if ($LASTEXITCODE -ne 0 -or -not $code) { Fail 'kalzit setup-code printed no code' }
Write-Host 'setup code readable from an elevated prompt'
EndStep

Step 'The service manager starts Kalzit again after a crash'
$before = (Get-KalzitService).ProcessId
Stop-Process -Id $before -Force
$until = (Get-Date).AddSeconds(60)
do {
    Start-Sleep -Seconds 1
    $now = Get-KalzitService
} while ((Get-Date) -lt $until -and ($now.State -ne 'Running' -or $now.ProcessId -eq $before -or $now.ProcessId -eq 0))
if ($now.State -ne 'Running' -or $now.ProcessId -eq $before) { Fail 'the service was not restarted after its process ended' }
Wait-Ready "http://127.0.0.1:$Port/readyz"
EndStep

Step 'Graceful stop and start'
Stop-Service Kalzit
if ((Get-KalzitService).State -ne 'Stopped') { Fail 'the service did not stop' }
$exit = (Get-KalzitService).ExitCode
if ($exit -ne 0) { Fail "the service stopped with exit code $exit" }
if (-not (Select-String -Path $log -Pattern 'stopped' -Quiet)) { Fail 'the log does not record the stop' }
Start-Service Kalzit
Assert-Running | Out-Null
Wait-Ready "http://127.0.0.1:$Port/readyz"
EndStep

Step 'Uninstall keeps the data'
Invoke-Msi @('/x', $Msi) 'uninstall.log'
if (Get-KalzitService) { Fail 'the service is still there' }
if (Get-NetFirewallRule -DisplayName 'Kalzit' -ErrorAction SilentlyContinue) { Fail 'the firewall rule is still there' }
if (-not (Test-Path (Join-Path $dataDir 'kalzit.db'))) { Fail 'the database is gone' }
if (-not (Test-Path $configFile)) { Fail 'the configuration is gone' }
if (Test-Path (Join-Path ${env:ProgramFiles} 'Kalzit\kalzit.exe')) { Fail 'the program is still there' }
EndStep

Step 'Reinstall on the kept data, then uninstall with REMOVEDATA=1'
Invoke-Msi @('/i', $Msi, 'PORT=1') 'reinstall.log'
Assert-Running | Out-Null
# The kept configuration wins over the PORT given now.
Wait-Ready "http://127.0.0.1:$Port/readyz"
Invoke-Msi @('/x', $Msi, 'REMOVEDATA=1') 'uninstall-remove-data.log'
if (Test-Path $dataDir) { Fail 'the data folder is still there' }
if (Test-Path $configFile) { Fail 'the configuration is still there' }
EndStep

# --- kalzit service install|uninstall -----------------------------------------------------------

Step 'kalzit service install with a self-signed certificate'
$cliDir = Join-Path ${env:ProgramFiles} 'KalzitCli'
New-Item -ItemType Directory -Force $cliDir | Out-Null
Copy-Item $Exe (Join-Path $cliDir 'kalzit.exe')
$cli = Join-Path $cliDir 'kalzit.exe'
$cliPort = $Port + 2
& $cli service install --port $cliPort --https self-signed --https-port ($Port + 3)
if ($LASTEXITCODE -ne 0) { Fail 'kalzit service install failed' }
Assert-Running | Out-Null
Wait-Ready "http://127.0.0.1:$cliPort/readyz"
Wait-Ready "https://127.0.0.1:$($Port + 3)/readyz"
Assert-PrivateDataDir $dataDir
& $cli service install --port $cliPort
if ($LASTEXITCODE -eq 0) { Fail 'a second install did not refuse' }
& $cli service uninstall --remove-data
if ($LASTEXITCODE -ne 0) { Fail 'kalzit service uninstall failed' }
if (Get-KalzitService) { Fail 'the service is still there' }
if (Test-Path $dataDir) { Fail 'the data folder is still there' }
EndStep

Write-Host 'The MSI package and the service commands passed.'
