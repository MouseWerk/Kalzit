# Records the TCP connections of a Windows runner while the end-to-end tests run, for failures
# such as net::ERR_NO_BUFFER_SPACE (Winsock WSAENOBUFS: no port or buffer left for a new
# connection).
#
#   tcp-watch.ps1 start    prints the dynamic port range and the excluded port ranges, then
#                          counts the connections per state every ten seconds in the background
#   tcp-watch.ps1 report   stops the counting (only the process `start` began, by its PID) and
#                          prints the highest counts and when they were reached
#
# The counts go to $env:RUNNER_TEMP\tcp-watch.csv. While $env:RUNNER_TEMP\tcp-watch.pause exists
# (the performance budgets create it, see KALZIT_E2E_QUIET_FILE in ci.yml), nothing is counted.
param([Parameter(Mandatory = $true)][ValidateSet("start", "report", "sample")][string]$Mode)
$ErrorActionPreference = "Stop"
$csv = Join-Path $env:RUNNER_TEMP "tcp-watch.csv"
$pidFile = Join-Path $env:RUNNER_TEMP "tcp-watch.pid"
$pauseFile = Join-Path $env:RUNNER_TEMP "tcp-watch.pause"

switch ($Mode) {
  "start" {
    netsh int ipv4 show dynamicport tcp
    netsh int ipv4 show excludedportrange protocol=tcp
    "time,total,established,time_wait,close_wait,fin_wait,loopback_time_wait" | Set-Content $csv
    $process = Start-Process pwsh -ArgumentList @("-NoProfile", "-File", $PSCommandPath, "sample") `
      -WindowStyle Hidden -PassThru
    $process.Id | Set-Content $pidFile
    "counting TCP connections every 10 s (PID $($process.Id))"
  }
  "sample" {
    while ($true) {
      if (Test-Path $pauseFile) {
        Start-Sleep -Seconds 1
        continue
      }
      $all = @(Get-NetTCPConnection -ErrorAction SilentlyContinue)
      $by = $all | Group-Object State -AsHashTable -AsString
      $count = { param($state) if ($by -and $by.ContainsKey($state)) { $by[$state].Count } else { 0 } }
      $finWait = (& $count "FinWait1") + (& $count "FinWait2")
      $loopTimeWait = @($all | Where-Object { $_.State -eq "TimeWait" -and $_.RemoteAddress -eq "127.0.0.1" }).Count
      $line = "{0},{1},{2},{3},{4},{5},{6}" -f (Get-Date -Format "HH:mm:ss"), $all.Count,
        (& $count "Established"), (& $count "TimeWait"), (& $count "CloseWait"), $finWait, $loopTimeWait
      Add-Content $csv $line
      Start-Sleep -Seconds 10
    }
  }
  "report" {
    if (Test-Path $pidFile) {
      $id = [int](Get-Content $pidFile)
      Stop-Process -Id $id -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path $csv)) {
      "no counts recorded"
      return
    }
    $rows = @(Import-Csv $csv)
    "$($rows.Count) samples"
    foreach ($column in "total", "established", "time_wait", "loopback_time_wait", "close_wait", "fin_wait") {
      $top = $rows | Sort-Object { [int]$_.$column } -Descending | Select-Object -First 1
      if ($top) { "highest {0}: {1} at {2}" -f $column, $top.$column, $top.time }
    }
    "every 3rd sample:"
    for ($i = 0; $i -lt $rows.Count; $i += 3) { ($rows[$i].PSObject.Properties.Value) -join "," }
  }
}
