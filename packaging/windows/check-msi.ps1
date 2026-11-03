<#
.SYNOPSIS
  Checks that an MSI package carries exactly the given kalzit.exe and nothing it should not, with
  Windows' own tools only: the installed file (unpacked with an administrative installation,
  `msiexec /a`, which installs nothing) and every row of the tables that run code or put files on
  disk (CustomAction, Binary, File, ServiceInstall), read through the Windows Installer
  automation interface and compared with packaging/windows/msi-expected.psd1, in English and with
  the German transform applied.

.DESCRIPTION
  The release workflow runs this before the MSI is signed (job `windows-msi`), so only a package
  built from the signed program, with no custom action, stream, file or service beyond the listed
  ones, gets a signature; the CI job `msi` runs it as well. The copy of kalzit.exe the package's
  setup steps run from (the Binary stream KalzitSetup) must be the given program too, and WiX's
  dialog DLL must carry the WiX Toolset's valid Authenticode signature.
#>
param(
    [Parameter(Mandatory)] [string] $Msi,
    [Parameter(Mandatory)] [string] $Exe,
    [string] $ExpectedRows = (Join-Path $PSScriptRoot 'msi-expected.psd1')
)

$ErrorActionPreference = 'Stop'
$Msi = (Resolve-Path $Msi).Path
$expected = (Get-FileHash (Resolve-Path $Exe).Path -Algorithm SHA256).Hash
$rows = Import-PowerShellDataFile $ExpectedRows
. (Join-Path $PSScriptRoot 'language.ps1')

# The differences between the rows a table has and the rows it must have, as readable lines.
function Compare-Rows([string] $Table, [int] $LanguageId, [string[]] $Actual, [string[]] $Wanted) {
    foreach ($row in $Actual) {
        if ($Wanted -cnotcontains $row) { "$Table (transform $LanguageId) has a row not in the list: $row" }
    }
    foreach ($row in $Wanted) {
        if ($Actual -cnotcontains $row) { "$Table (transform $LanguageId) lacks the listed row: $row" }
    }
}

# What a stream of the Binary table must be (msi-expected.psd1); the problem, or nothing.
function Test-Stream([string] $Name, [string] $Kind, [string] $File, [int] $LanguageId) {
    switch ($Kind) {
        'Program' {
            if ((Get-FileHash $File -Algorithm SHA256).Hash -ne $expected) {
                "the copy of kalzit.exe the setup steps run ($Name, transform $LanguageId) is not the given program"
            }
        }
        'WixDll' {
            $signature = Get-AuthenticodeSignature $File
            if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notlike 'CN=WiX Toolset (.NET Foundation),*') {
                "$Name (transform $LanguageId) is not signed by the WiX Toolset: $($signature.Status), $($signature.SignerCertificate.Subject)"
            }
        }
        'Picture' {
            $head = [IO.File]::ReadAllBytes($File)
            $bitmap = $head.Length -gt 2 -and $head[0] -eq 0x42 -and $head[1] -eq 0x4D
            $icon = $head.Length -gt 4 -and $head[0] -eq 0 -and $head[1] -eq 0 -and $head[2] -eq 1 -and $head[3] -eq 0
            if (-not ($bitmap -or $icon)) { "$Name (transform $LanguageId) is neither a bitmap nor an icon" }
        }
        default { throw "msi-expected.psd1 names the unknown kind '$Kind' for $Name" }
    }
}

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

    # The rows that run code or land on disk, in English and with the German transform: exactly
    # those of msi-expected.psd1. Targets are compared where the list gives one.
    $problems = [Collections.Generic.List[string]]::new()
    $streamNames = @($rows.Binary.Keys | Sort-Object)
    $serviceColumns = 'ServiceInstall', 'Name', 'DisplayName', 'ServiceType', 'StartType', 'ErrorControl',
    'LoadOrderGroup', 'Dependencies', 'StartName', 'Password', 'Arguments', 'Component_', 'Description'
    foreach ($id in 0, 1031) {
        $actions = @(Get-TransformedRows $Msi $id 'SELECT `Action`, `Type`, `Source`, `Target` FROM `CustomAction`')
        @(Compare-Rows 'CustomAction' $id @($actions | ForEach-Object { "$($_[0]) (type $($_[1]), source $($_[2]))" }) `
                @($rows.CustomAction | ForEach-Object { "$($_.Action) (type $($_.Type), source $($_.Source))" })) |
            ForEach-Object { $problems.Add($_) }
        foreach ($want in $rows.CustomAction | Where-Object { $_.ContainsKey('Target') }) {
            $have = $actions | Where-Object { $_[0] -ceq $want.Action } | Select-Object -First 1
            if ($null -ne $have -and $have[3] -cne $want.Target) {
                $problems.Add("CustomAction $($want.Action) (transform $id) has the target '$($have[3])', expected '$($want.Target)'")
            }
        }
        @(Compare-Rows 'Binary' $id @(Get-TransformedValues $Msi $id 'SELECT `Name` FROM `Binary`') $streamNames) |
            ForEach-Object { $problems.Add($_) }
        @(Compare-Rows 'File' $id @(Get-TransformedRows $Msi $id 'SELECT `File`, `Component_`, `FileName`, `Attributes` FROM `File`' |
                    ForEach-Object { $_ -join ' | ' }) `
                @($rows.File | ForEach-Object { @($_.File, $_.Component, $_.FileName, $_.Attributes) -join ' | ' })) |
            ForEach-Object { $problems.Add($_) }
        $serviceQuery = 'SELECT `' + ($serviceColumns -join '`, `') + '` FROM `ServiceInstall`'
        @(Compare-Rows 'ServiceInstall' $id @(Get-TransformedRows $Msi $id $serviceQuery | ForEach-Object { $_ -join ' | ' }) `
                @($rows.ServiceInstall | ForEach-Object { $s = $_; @($serviceColumns | ForEach-Object { $s[$_ -replace '_$', ''] }) -join ' | ' })) |
            ForEach-Object { $problems.Add($_) }

        # The streams as Windows Installer exports them (Binary\<name>.ibd).
        $streams = Join-Path $work "binary-$id"
        Export-TransformedTable $Msi $id 'Binary' $streams
        foreach ($name in $streamNames) {
            $file = Join-Path $streams "Binary\$name.ibd"
            if (Test-Path $file) {
                @(Test-Stream $name $rows.Binary[$name] $file $id) | ForEach-Object { $problems.Add($_) }
            }
        }
    }
    if ($problems.Count -gt 0) {
        $problems | ForEach-Object { Write-Host "::error::$_" }
        throw "the package differs from packaging/windows/msi-expected.psd1 in $($problems.Count) places"
    }
    $export = Join-Path $work 'binary-0'
    Write-Host "$Msi carries $Exe (SHA-256 $expected) as the installed program and as the setup copy"
    Write-Host "$Msi has exactly the custom actions, streams, files and service of msi-expected.psd1, in English and German"

    # The wizard in German: the package lists the language and its embedded transform turns the
    # settings page German without touching what gets installed.
    $languages = @(Get-PackageLanguages $Msi)
    if ($languages -notcontains '1033' -or $languages -notcontains '1031') {
        throw "the package lists the languages '$($languages -join ',')', expected 1033 and 1031"
    }
    $title = @(Get-TransformedValues $Msi 1031 "SELECT ``Text`` FROM ``Control`` WHERE ``Dialog_`` = 'KalzitSettingsDlg' AND ``Control`` = 'Title'")
    if ($title.Count -ne 1 -or $title[0] -notlike '*Servereinstellungen') {
        throw "the German settings page is titled '$($title -join ' | ')', expected 'Servereinstellungen'"
    }
    $german = @(Get-TransformedValues $Msi 1031 "SELECT ``Value`` FROM ``Property`` WHERE ``Property`` = 'ProductLanguage'")
    if ($german.Count -ne 1 -or $german[0] -ne '1031') { throw "the German transform sets ProductLanguage '$german', expected 1031" }
    # The look: no text drawn transparently on a picture (look.ps1), the license as RTF on its
    # page, and Kalzit's pictures at twice WixUI's size (art/build-art.mjs).
    foreach ($id in 0, 1031) {
        $transparent = @(Get-TransformedValues $Msi $id "SELECT ``Attributes`` FROM ``Control`` WHERE ``Type`` = 'Text'" |
            Where-Object { [int] $_ -band 0x10000 })
        if ($transparent.Count -ne 0) { throw "$($transparent.Count) texts are drawn transparently (transform $id)" }
        $license = @(Get-TransformedValues $Msi $id "SELECT ``Text`` FROM ``Control`` WHERE ``Dialog_`` = 'KalzitLicenseDlg' AND ``Control`` = 'LicenseText'")
        if ($license.Count -ne 1 -or $license[0] -notlike '{\rtf1*GNU AFFERO GENERAL PUBLIC LICENSE*') {
            throw "the license page does not show the AGPL as RTF (transform $id)"
        }
    }
    foreach ($picture in @(@('WixUI_Bmp_Banner', 986, 116), @('WixUI_Bmp_Dialog', 986, 624))) {
        $file = @(Get-ChildItem $export -Recurse -File | Where-Object { $_.Name -like "$($picture[0])*" })
        if ($file.Count -ne 1) { throw "the package holds $($file.Count) files for $($picture[0]), expected 1" }
        $header = [IO.File]::ReadAllBytes($file[0].FullName)
        $size = @([BitConverter]::ToInt32($header, 18), [BitConverter]::ToInt32($header, 22))
        if ($size[0] -ne $picture[1] -or $size[1] -ne $picture[2]) {
            throw "$($picture[0]) is $($size -join ' x '), expected Kalzit's $($picture[1]) x $($picture[2])"
        }
    }
    $codeQuery = "SELECT ``Value`` FROM ``Property`` WHERE ``Property`` = 'ProductCode'"
    if ("$(Get-TransformedValues $Msi 0 $codeQuery)" -ne "$(Get-TransformedValues $Msi 1031 $codeQuery)") {
        throw 'the German transform changes the product code'
    }
    # Upgrades and the downgrade guard match every language: no Upgrade row names one.
    $upgradeQuery = 'SELECT `Language` FROM `Upgrade`'
    foreach ($id in 0, 1031) {
        $upgradeLanguages = @(Get-TransformedValues $Msi $id $upgradeQuery)
        if ($upgradeLanguages.Count -lt 1 -or @($upgradeLanguages | Where-Object { $_ }).Count -ne 0) {
            throw "the Upgrade table names the languages '$($upgradeLanguages -join ',')' (transform $id); it must name none"
        }
    }
    # The finish page opens the setup page (checked by default), never with the setup code in it.
    $open = @(Get-TransformedValues $Msi 0 "SELECT ``Target`` FROM ``CustomAction`` WHERE ``Action`` = 'KalzitOpenSetup'")
    if ($open.Count -ne 1 -or $open[0] -notlike '*http://localhost:`[PORT`]/setup' -or $open[0] -like '*code*') {
        throw "the finish page opens '$($open -join ' | ')', expected http://localhost:[PORT]/setup"
    }
    $openHttps = @(Get-TransformedValues $Msi 0 "SELECT ``Target`` FROM ``CustomAction`` WHERE ``Action`` = 'KalzitOpenSetupHttps'")
    if ($openHttps.Count -ne 1 -or $openHttps[0] -notlike '*https://localhost:`[HTTPSPORT`]/setup' -or $openHttps[0] -like '*code*') {
        throw "the finish page opens '$($openHttps -join ' | ')' over HTTPS, expected https://localhost:[HTTPSPORT]/setup"
    }
    # Each runs only for its listener and only with a port from 1 to 65535, so a property that is
    # no port never ends up in the address handed to the browser.
    foreach ($case in @(@('KalzitOpenSetup', 'HTTPS = "off"', 'PORT'), @('KalzitOpenSetupHttps', 'HTTPS <> "off"', 'HTTPSPORT'))) {
        $conditions = @(Get-TransformedValues $Msi 0 "SELECT ``Condition`` FROM ``ControlEvent`` WHERE ``Dialog_`` = 'ExitDialog' AND ``Control_`` = 'Finish' AND ``Argument`` = '$($case[0])'")
        $wanted = @($case[1], "$($case[2]) >= 1", "$($case[2]) <= 65535", 'NOT Installed')
        if ($conditions.Count -ne 1 -or @($wanted | Where-Object { $conditions[0] -notlike "*$_*" }).Count -ne 0) {
            throw "the finish page runs $($case[0]) when '$($conditions -join ' | ')', expected a condition with $($wanted -join ', ')"
        }
    }
    $checked = @(Get-TransformedValues $Msi 0 "SELECT ``Value`` FROM ``Property`` WHERE ``Property`` = 'WIXUI_EXITDIALOGOPTIONALCHECKBOX'")
    if ($checked.Count -ne 1 -or $checked[0] -ne '1') { throw "the option to open setup is not checked by default ('$checked')" }
    foreach ($case in @(@(0, 'Open setup in the'), @(1031, 'Einrichtung im'))) {
        $text = @(Get-TransformedValues $Msi $case[0] "SELECT ``Target`` FROM ``CustomAction`` WHERE ``Action`` = 'KalzitOpenSetupText'")
        if ($text.Count -ne 1 -or $text[0] -notlike "$($case[1])*") {
            throw "the finish page option reads '$($text -join ' | ')' (transform $($case[0])), expected '$($case[1]) ...'"
        }
    }
    $files = @(Get-TransformedValues $Msi 1031 "SELECT ``File`` FROM ``File``")
    if ($files.Count -ne 2) { throw "the German transform leaves $($files.Count) files, expected 2" }
    Write-Host "$Msi carries the wizard in English and German (languages $($languages -join ', '))"
} finally {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $work
}
