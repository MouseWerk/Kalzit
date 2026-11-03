# MongoDB, OpenSearch and Neo4j for the end-to-end specs of document, search and graph sources
# (ui/e2e/documents.spec.ts, ui/e2e/opensearch.spec.ts, ui/e2e/graph.spec.ts and the specs that
# read them beside other sources) on Windows runners, which cannot run the Linux containers of
# e2e-services.sh. The servers run as their native Windows builds, the same major versions as the
# containers, downloaded from their publishers and checked against the SHA-256 pinned below.
# Memgraph has no Windows build, so its one spec skips on Windows with that reason; the Bolt
# connection and Memgraph's privilege check are covered by the server tests (fake Bolt servers)
# on both systems and by the Linux e2e job against a real Memgraph.
#
# The same commands run on a Windows machine with Java 21 or later (JAVA_HOME) for the specs.
#
#   e2e-services.ps1 install   downloads and unpacks the servers into -Tools, unless a complete
#                              copy is there (ci.yml keeps it in the Actions cache)
#   e2e-services.ps1 start     starts them in the background with their data and logs under
#                              -Data (early in the job, so they are up once the build is done)
#   e2e-services.ps1 ready     waits for all three, seeds MongoDB with
#                              ui/e2e/fixtures/mongo-orders.js and Neo4j with
#                              ui/e2e/fixtures/graph-shop.cypher, and writes KALZIT_E2E_MONGODB,
#                              KALZIT_E2E_OPENSEARCH and KALZIT_E2E_NEO4J to $GITHUB_ENV
#
# The ports and passwords are those of e2e-services.sh. The passwords belong to throwaway servers
# reachable only from this runner, on 127.0.0.1; they protect nothing and are not secrets.
param(
    [Parameter(Mandatory)] [ValidateSet('install', 'start', 'ready')] [string] $Command,
    [string] $Tools = (Join-Path ($env:RUNNER_TOOL_CACHE ?? $env:LOCALAPPDATA) 'kalzit-e2e-services'),
    [string] $Data = (Join-Path ($env:RUNNER_TEMP ?? $env:TEMP) 'kalzit-e2e-data'),
    # A folder with the archives already downloaded (for a run on a developer's machine); they are
    # checked like a download.
    [string] $Archives = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$RootPassword = 'kalzit-e2e-root'
# Also in GRAPH_FIXTURE (ui/e2e/support/services.ts).
$Neo4jPassword = 'kalzit-e2e-neo4j'
$Fixtures = Join-Path $PSScriptRoot '..\..\ui\e2e\fixtures'

# What each server needs from its archive; `Keep` lists the paths unpacked (all when empty) and
# `Skip` what is left out. OpenSearch runs without its plugins (security, SQL, ML and the like):
# the specs use the core search and aggregation API, as with the container's security disabled.
$Packages = @(
    @{
        Name   = 'mongodb'
        Url    = 'https://fastdl.mongodb.org/windows/mongodb-windows-x86_64-8.2.12.zip'
        Sha256 = 'a45fca0ea0ff5dd8ab00bc10b103df33177cb519839e05f36dfe841a84cd21cd'
        Folder = 'mongodb-win32-x86_64-windows-8.2.12'
        Keep   = @('bin/mongod.exe')
        Skip   = @()
    },
    @{
        Name   = 'mongosh'
        Url    = 'https://downloads.mongodb.com/compass/mongosh-2.14.1-win32-x64.zip'
        Sha256 = 'be58d3c67a2bca990c790b359c99fa9b5da1b12bb5b01e8442bea5998b1a38e2'
        Folder = 'mongosh-2.14.1-win32-x64'
        Keep   = @('bin/mongosh.exe', 'bin/mongosh_crypt_v1.dll')
        Skip   = @()
    },
    @{
        Name   = 'opensearch'
        Url    = 'https://artifacts.opensearch.org/releases/bundle/opensearch/3.9.0/opensearch-3.9.0-windows-x64.zip'
        Sha256 = '82cf611bc9868266e04fa9d957b03aeaa4dd12002d207fd41cf0360b281e1593'
        Folder = 'opensearch-3.9.0'
        Keep   = @()
        Skip   = @('plugins/*')
    },
    @{
        Name   = 'neo4j'
        Url    = 'https://dist.neo4j.org/neo4j-community-2026.10.0-windows.zip'
        Sha256 = '3afef638787e4434ff6b0f90fc3f497b6a69772756a034a681a7e11f420d272f'
        Folder = 'neo4j-community-2026.10.0'
        Keep   = @()
        Skip   = @()
    }
)

function Get-Home([string] $Name) {
    $package = $Packages | Where-Object { $_.Name -eq $Name }
    Join-Path (Join-Path $Tools $Name) $package.Folder
}

# Java for Neo4j: the runner's Java 21 when it names one, otherwise the JAVA_HOME in effect.
# OpenSearch brings its own (jdk in its folder).
function Get-JavaHome {
    if ($env:JAVA_HOME_21_X64) { return $env:JAVA_HOME_21_X64 }
    if ($env:JAVA_HOME) { return $env:JAVA_HOME }
    throw 'no Java for Neo4j: set JAVA_HOME (Java 21 or later)'
}

function Install-Package($Package) {
    $target = Join-Path $Tools $Package.Name
    $marker = Join-Path $target ".complete-$($Package.Sha256)"
    if (Test-Path $marker) {
        Write-Host "$($Package.Name): unpacked copy in $target"
        return
    }
    if (Test-Path $target) { Remove-Item -Recurse -Force $target }
    New-Item -ItemType Directory -Force $target | Out-Null
    $archive = Join-Path ([IO.Path]::GetTempPath()) "kalzit-e2e-$($Package.Name)-$([guid]::NewGuid()).zip"
    $local = if ($Archives) { Join-Path $Archives ([IO.Path]::GetFileName($Package.Url)) } else { '' }
    try {
        if ($local -and (Test-Path $local)) { Copy-Item $local $archive }
        for ($attempt = 1; -not (Test-Path $archive); $attempt++) {
            try {
                Invoke-WebRequest -Uri $Package.Url -OutFile $archive -TimeoutSec 600
            } catch {
                Remove-Item -Force -ErrorAction SilentlyContinue $archive
                if ($attempt -ge 3) { throw }
                Write-Host "::warning::downloading $($Package.Name) failed (attempt $attempt of 3): $_"
                Start-Sleep -Seconds 5
            }
        }
        $hash = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($hash -ne $Package.Sha256) {
            throw "$($Package.Name): the download has SHA-256 $hash, expected $($Package.Sha256)"
        }
        # Windows' own tar (bsdtar) reads zip archives and unpacks only the listed paths.
        $arguments = @('-xf', $archive, '-C', $target)
        foreach ($skip in $Package.Skip) { $arguments += @('--exclude', "$($Package.Folder)/$skip") }
        foreach ($keep in $Package.Keep) { $arguments += "$($Package.Folder)/$keep" }
        & tar.exe @arguments
        if ($LASTEXITCODE -ne 0) { throw "$($Package.Name): unpacking failed with exit code $LASTEXITCODE" }
        New-Item -ItemType File $marker | Out-Null
        Write-Host "$($Package.Name): unpacked into $target"
    } finally {
        Remove-Item -Force -ErrorAction SilentlyContinue $archive
    }
}

# Starts a program in the background, its output in the log folder, with the given environment
# variables, and records its PID. Through WMI (Win32_Process.Create) rather than Start-Process:
# the Actions runner ends every process a step started when the step ends (they belong to the
# step's job object), and a process created by WMI belongs to none, so the servers outlive the
# `start` step. Such a process does not inherit this one's environment, so cmd sets it first.
function Start-Server([string] $Name, [string] $Program, [string[]] $Arguments, [hashtable] $Environment = @{}) {
    $logs = Join-Path $Data 'logs'
    $quote = { param($text) '"' + $text + '"' }
    $settings = @($Environment.GetEnumerator() | ForEach-Object { 'set ' + (& $quote "$($_.Key)=$($_.Value)") + ' && ' }) -join ''
    $command = (@(& $quote $Program) + @($Arguments | ForEach-Object { & $quote $_ })) -join ' '
    $line = 'cmd.exe /d /s /c "' + $settings + $command + ' > ' + (& $quote (Join-Path $logs "$Name.out.log")) +
        ' 2> ' + (& $quote (Join-Path $logs "$Name.err.log")) + '"'
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = $line; CurrentDirectory = (Split-Path $Program)
    }
    if ($result.ReturnValue -ne 0) { throw "starting $Name failed (Win32_Process.Create returned $($result.ReturnValue))" }
    Add-Content (Join-Path $Data 'pids.txt') "$Name $($result.ProcessId)"
    Write-Host "started $Name (PID $($result.ProcessId))"
}

function Start-Servers {
    foreach ($dir in 'logs', 'mongodb', 'opensearch', 'neo4j') {
        New-Item -ItemType Directory -Force (Join-Path $Data $dir) | Out-Null
    }

    # With --auth and no user yet, MongoDB lets a client on 127.0.0.1 create the first one (the
    # localhost exception); `ready` creates the root user that way, as the container's init does.
    $mongod = Join-Path (Get-Home 'mongodb') 'bin\mongod.exe'
    Start-Server 'mongodb' $mongod @('--dbpath', (Join-Path $Data 'mongodb'), '--port', '27017',
        '--bind_ip', '127.0.0.1', '--auth', '--logpath', (Join-Path $Data 'logs\mongod.log'))

    $opensearch = Get-Home 'opensearch'
    $javaOptions = @{ OPENSEARCH_JAVA_HOME = (Join-Path $opensearch 'jdk'); OPENSEARCH_JAVA_OPTS = '-Xms512m -Xmx512m' }
    Start-Server 'opensearch' (Join-Path $opensearch 'bin\opensearch.bat') -Environment $javaOptions -Arguments @(
        '-Ediscovery.type=single-node', '-Enetwork.host=127.0.0.1', '-Ehttp.port=9201',
        '-Ecluster.routing.allocation.disk.threshold_enabled=false',
        "-Epath.data=$(Join-Path $Data 'opensearch')", "-Epath.logs=$(Join-Path $Data 'logs')")

    # Neo4j reads its settings from the environment (NEO4J_<setting>, dots as underscores, an
    # underscore doubled) only in its container, so they go into its configuration file here.
    $neo4j = Get-Home 'neo4j'
    $env:JAVA_HOME = Get-JavaHome
    $env:NEO4J_CONF = Join-Path $Data 'neo4j\conf'
    New-Item -ItemType Directory -Force $env:NEO4J_CONF | Out-Null
    $settings = [ordered] @{
        'server.default_listen_address'   = '127.0.0.1'
        'server.bolt.listen_address'      = '127.0.0.1:7687'
        'server.http.enabled'             = 'false'
        'server.https.enabled'            = 'false'
        'server.directories.data'         = (Join-Path $Data 'neo4j\data').Replace('\', '/')
        'server.directories.logs'         = (Join-Path $Data 'neo4j\logs').Replace('\', '/')
        'server.memory.heap.initial_size' = '256m'
        'server.memory.heap.max_size'     = '512m'
        'server.memory.pagecache.size'    = '128m'
    }
    # The shipped file with these settings replaced: Neo4j refuses a setting declared twice.
    $lines = @(Get-Content (Join-Path $neo4j 'conf\neo4j.conf') |
            Where-Object { $_ -notmatch '^\s*([\w.]+)\s*=' -or -not $settings.Contains($Matches[1]) }) +
        @($settings.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" })
    Set-Content (Join-Path $env:NEO4J_CONF 'neo4j.conf') $lines
    & (Join-Path $neo4j 'bin\neo4j-admin.bat') dbms set-initial-password $Neo4jPassword
    if ($LASTEXITCODE -ne 0) { throw "setting Neo4j's password failed with exit code $LASTEXITCODE" }
    Start-Server 'neo4j' (Join-Path $neo4j 'bin\neo4j.bat') @('console') @{ JAVA_HOME = $env:JAVA_HOME; NEO4J_CONF = $env:NEO4J_CONF }
    # The configuration folder for `ready`, which runs in a later step.
    Set-Content (Join-Path $Data 'neo4j-conf.txt') $env:NEO4J_CONF
}

function Invoke-Quiet([string] $Program, [string[]] $Arguments) {
    & $Program @Arguments *> $null
    $LASTEXITCODE -eq 0
}

function Invoke-Mongosh([string[]] $Arguments) {
    & (Join-Path (Get-Home 'mongosh') 'bin\mongosh.exe') --quiet @Arguments
}

function Invoke-CypherShell([string[]] $Arguments) {
    & (Join-Path (Get-Home 'neo4j') 'bin\cypher-shell.bat') -a 'neo4j://127.0.0.1:7687' -u neo4j -p $Neo4jPassword @Arguments
}

function Test-Ready([string] $Name) {
    switch ($Name) {
        'mongodb' {
            Invoke-Quiet (Join-Path (Get-Home 'mongosh') 'bin\mongosh.exe') @('--quiet', 'mongodb://127.0.0.1:27017/admin', '--eval', 'db.runCommand({ ping: 1 }).ok')
        }
        'opensearch' {
            try {
                Invoke-RestMethod 'http://127.0.0.1:9201/_cluster/health?wait_for_status=yellow&timeout=1s' -TimeoutSec 5 | Out-Null
                $true
            } catch { $false }
        }
        'neo4j' {
            Invoke-Quiet (Join-Path (Get-Home 'neo4j') 'bin\cypher-shell.bat') @('-a', 'neo4j://127.0.0.1:7687', '-u', 'neo4j', '-p', $Neo4jPassword, 'RETURN 1;')
        }
    }
}

# Runs a seed a few times: a server may answer a first query before it takes writes. Each fixture
# starts by deleting what an earlier try left.
function Invoke-Seed([string] $Name, [scriptblock] $Seed) {
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        & $Seed
        if ($LASTEXITCODE -eq 0) { return }
        Write-Host "seeding $Name failed (attempt $attempt of 5), trying again"
        Start-Sleep -Seconds 3
    }
    throw "seeding $Name failed"
}

function Wait-Servers {
    $env:JAVA_HOME = Get-JavaHome
    $env:NEO4J_CONF = Get-Content (Join-Path $Data 'neo4j-conf.txt')
    $pending = [Collections.Generic.List[string]] @('mongodb', 'opensearch', 'neo4j')
    $deadline = (Get-Date).AddMinutes(4)
    while ($pending.Count -gt 0 -and (Get-Date) -lt $deadline) {
        foreach ($name in @($pending)) {
            if (Test-Ready $name) {
                Write-Host "$name is up"
                [void] $pending.Remove($name)
            }
        }
        if ($pending.Count -gt 0) { Start-Sleep -Seconds 2 }
    }
    if ($pending.Count -gt 0) {
        foreach ($log in Get-ChildItem (Join-Path $Data 'logs') -File -Recurse) {
            Write-Host "--- $($log.Name)"
            Get-Content $log.FullName -Tail 40 | Write-Host
        }
        throw "$($pending -join ', ') did not become ready"
    }

    Invoke-Seed 'MongoDB' {
        # The root user, through the localhost exception; on a later try it exists already and
        # MongoDB refuses this, which the seed below shows to be harmless.
        Invoke-Mongosh @('mongodb://127.0.0.1:27017/admin', '--eval',
            "db.createUser({ user: 'root', pwd: '$RootPassword', roles: ['root'] })") *> $null
        Invoke-Mongosh @('-u', 'root', '-p', $RootPassword, '--authenticationDatabase', 'admin',
            'mongodb://127.0.0.1:27017/admin', '--file', (Join-Path $Fixtures 'mongo-orders.js'))
    }
    # Without the comment lines, as e2e-services.sh feeds it to cypher-shell and mgconsole.
    $graph = Join-Path $Data 'graph-shop.cypher'
    Get-Content (Join-Path $Fixtures 'graph-shop.cypher') | Where-Object { $_ -notmatch '^//' } | Set-Content $graph
    Invoke-Seed 'Neo4j' { Invoke-CypherShell @('--file', $graph) }

    if ($env:GITHUB_ENV) {
        Add-Content $env:GITHUB_ENV @(
            'KALZIT_E2E_MONGODB=127.0.0.1:27017',
            'KALZIT_E2E_OPENSEARCH=http://127.0.0.1:9201',
            'KALZIT_E2E_NEO4J=127.0.0.1:7687'
        )
    }
    Write-Host 'MongoDB, OpenSearch and Neo4j are ready'
}

switch ($Command) {
    'install' { foreach ($package in $Packages) { Install-Package $package } }
    'start' { Start-Servers }
    'ready' { Wait-Servers }
}
