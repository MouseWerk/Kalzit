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

    # The wizard in German: the package lists the language and its embedded transform turns the
    # settings page German without touching what gets installed.
    . (Join-Path $PSScriptRoot 'language.ps1')
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
