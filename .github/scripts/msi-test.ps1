<#
.SYNOPSIS
  Installs the Kalzit MSI package on a CI runner and checks the result: folders someone else
  prepared are refused (a configuration folder open to Users, a program folder under C:\, a kept
  data folder with a file others may read), then service running as NT SERVICE\Kalzit with only
  SeChangeNotifyPrivilege, HTTP health, data and program folder access lists, firewall rule,
  recovery actions, a graceful stop, an uninstallation that keeps the data, a reinstallation on the
  kept data, an uninstallation that removes it, and the same through `kalzit service install|uninstall`.

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

# An installation that is refused (a launch condition, or Kalzit's setup step): it fails, rolls
# back, and the MSI log or the event log (source Kalzit, where the setup step reports) says why.
function Invoke-MsiRefused([string[]] $Arguments, [string] $Log, [string] $Why) {
    $path = Join-Path $Logs $Log
    $start = Get-Date
    $all = $Arguments + @('/qn', '/norestart', '/l*v', $path)
    $p = Start-Process msiexec.exe -ArgumentList $all -Wait -PassThru
    if ($p.ExitCode -eq 0) { Fail "msiexec $($Arguments -join ' ') succeeded, but should be refused ($Why)" }
    if (Get-KalzitService) { Fail "the service is left after the refused installation ($Why)" }
    $texts = @()
    if (Test-Path $path) { $texts += Get-Content $path -Raw }
    try {
        $texts += Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'Kalzit'; StartTime = $start } -ErrorAction Stop |
            ForEach-Object { $_.Properties | ForEach-Object { "$($_.Value)" } }
    } catch { }
    if (-not ($texts | Where-Object { $_ -match [regex]::Escape($Why) })) {
        Fail "neither the log $Log nor the event log says '$Why'"
    }
    Write-Host "refused as expected: $Why"
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

Step 'Refuse folders someone else prepared'
# A quote in a setting stops the installation before anything runs.
Invoke-MsiRefused @('/i', $Msi, 'DATADIR="C:\Kalzit""Data"') 'refused-quote.log' 'contains a quote'
# A configuration folder Users may write, as a user could create it in %ProgramData%.
$configFolder = Split-Path -Parent $configFile
New-Item -ItemType Directory -Force $configFolder | Out-Null
icacls $configFolder /grant '*S-1-5-32-545:(OI)(CI)M' | Out-Null
Invoke-MsiRefused @('/i', $Msi, "PORT=$Port") 'refused-config-folder.log' 'not as Kalzit''s installer makes it'
Remove-Item -Recurse -Force $configFolder
# A program folder directly under C:\, where Authenticated Users may change what is created.
Invoke-MsiRefused @('/i', $Msi, "PORT=$Port", 'INSTALLFOLDER=C:\KalzitOpen\') 'refused-program-folder.log' 'not a safe program folder'
if (Test-Path $configFolder) { Fail 'a refused program folder still let the setup touch the configuration folder' }
Remove-Item -Recurse -Force 'C:\KalzitOpen' -ErrorAction SilentlyContinue
EndStep

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
if ($path -match [regex]::Escape('Program Files\Kalzit')) { Fail 'the program folder is on the system PATH' }
$privs = sc.exe qprivs Kalzit | Out-String
Write-Host $privs
if ($privs -notmatch 'SeChangeNotifyPrivilege' -or $privs -match 'SeImpersonatePrivilege|SeAssignPrimaryTokenPrivilege') {
    Fail "the service may hold more than SeChangeNotifyPrivilege: $privs"
}
$programFolder = Join-Path ${env:ProgramFiles} 'Kalzit'
$programAcl = Get-Acl $programFolder
if (-not $programAcl.AreAccessRulesProtected) { Fail 'the program folder inherits access rules' }
$writers = $programAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) |
    Where-Object { ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::Write) -ne 0 } |
    ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique
# Self-update is off by default: only SYSTEM and Administrators may change the program.
$expectedWriters = @('S-1-5-18', 'S-1-5-32-544') | Sort-Object
if (($writers -join ',') -ne ($expectedWriters -join ',')) {
    Fail "the program folder may be changed by $($writers -join ', '), expected SYSTEM and Administrators"
}
$token = Join-Path $dataDir 'setup-token.txt'
if (-not (Test-Path $token) -or -not (Get-Content $token -Raw).Trim()) { Fail "no setup code in $token" }
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

Step 'A kept data folder with a file others may read is refused'
$logsFolder = Join-Path $dataDir 'logs'
icacls $logsFolder /grant '*S-1-5-32-545:(OI)(CI)R' | Out-Null
Invoke-MsiRefused @('/i', $Msi) 'refused-data-folder.log' 'was not private to Kalzit'
icacls $logsFolder /remove:g '*S-1-5-32-545' | Out-Null
EndStep

Step 'Reinstall on the kept data, then uninstall with REMOVEDATA=1'
Invoke-Msi @('/i', $Msi, 'PORT=1', 'SELFUPDATE=1') 'reinstall.log'
Assert-Running | Out-Null
# The kept configuration wins over the PORT given now.
Wait-Ready "http://127.0.0.1:$Port/readyz"
# With SELFUPDATE=1 the service account may replace the program.
$writers = (Get-Acl (Join-Path ${env:ProgramFiles} 'Kalzit')).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) |
    Where-Object { ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::Write) -ne 0 } |
    ForEach-Object { $_.IdentityReference.Value }
if ($writers -notcontains (Get-ServiceSid)) { Fail 'SELFUPDATE=1 did not let the service account update the program' }
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
