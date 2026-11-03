# What the MSI package may contain that runs code or lands on disk, checked by check-msi.ps1 before
# the package is signed (release.yml, job `windows-msi`; ci.yml, job `msi`). Every row of these
# tables, in the English package and with its German transform applied, must be listed here, and
# nothing listed may be missing. A change to Kalzit.wxs or KalzitUI.wxs that adds or changes such a
# row changes this file in the same pull request, so a reviewer sees it.
@{
    # Every custom action with its type and source. Target is compared where it is code or a
    # command; the texts of the finish page differ per language and are checked by check-msi.ps1.
    CustomAction   = @(
        @{ Action = 'SetDATADIR'; Type = 51; Source = 'DATADIR'; Target = '[CommonAppDataFolder]Kalzit\data' }
        # Kalzit's own steps, run as LocalSystem from the package's copy of kalzit.exe.
        @{
            Action = 'KalzitConfigure'; Type = 3074; Source = 'KalzitSetup'
            Target = 'service configure --program "[#KalzitExe] " --config "[CommonAppDataFolder]Kalzit\kalzit.toml" --data-dir "[DATADIR] " --port "[PORT]" --https "[HTTPS]" --https-port "[HTTPSPORT]" --cert-file "[CERTFILE] " --key-file "[KEYFILE] " --open-firewall "[FIREWALL]" --self-update "[SELFUPDATE]"'
        }
        @{
            Action = 'KalzitCleanup'; Type = 3138; Source = 'KalzitSetup'
            Target = 'service cleanup --config "[CommonAppDataFolder]Kalzit\kalzit.toml" --remove-data "[REMOVEDATA]"'
        }
        @{ Action = 'KalzitExitTextNew'; Type = 51; Source = 'WIXUI_EXITDIALOGOPTIONALTEXT' }
        @{ Action = 'KalzitExitTextKept'; Type = 51; Source = 'WIXUI_EXITDIALOGOPTIONALTEXT' }
        @{ Action = 'KalzitOpenSetupText'; Type = 51; Source = 'WIXUI_EXITDIALOGOPTIONALCHECKBOXTEXT' }
        @{
            Action = 'KalzitOpenSetup'; Type = 226; Source = 'INSTALLFOLDER'
            Target = '"[System64Folder]rundll32.exe" url.dll,FileProtocolHandler http://localhost:[PORT]/setup'
        }
        @{
            Action = 'KalzitOpenSetupHttps'; Type = 226; Source = 'INSTALLFOLDER'
            Target = '"[System64Folder]rundll32.exe" url.dll,FileProtocolHandler https://localhost:[HTTPSPORT]/setup'
        }
        # WixUI's check of the folder typed on the folder page, from WiX's own signed DLL.
        @{ Action = 'WixUIValidatePath_X64'; Type = 65; Source = 'WixUiCa_X64'; Target = 'ValidatePath' }
    )

    # Every stream of the Binary table and what it must be: Program is exactly the given
    # kalzit.exe; WixDll is a DLL with a valid Authenticode signature of the WiX Toolset;
    # Picture is a bitmap or icon of the wizard (never run).
    Binary         = @{
        KalzitSetup      = 'Program'
        WixUiCa_X64      = 'WixDll'
        WixUI_Bmp_Banner = 'Picture'
        WixUI_Bmp_Dialog = 'Picture'
        WixUI_Bmp_New    = 'Picture'
        WixUI_Bmp_Up     = 'Picture'
        WixUI_Ico_Exclam = 'Picture'
        WixUI_Ico_Info   = 'Picture'
    }

    # Every installed file.
    File           = @(
        @{ File = 'KalzitExe'; Component = 'KalzitExe'; FileName = 'kalzit.exe'; Attributes = 512 }
        @{ File = 'KalzitLicense'; Component = 'KalzitLicense'; FileName = 'LICENSE.txt'; Attributes = 512 }
    )

    # The one service: own process (16), automatic start (2), normal errors that fail the
    # installation (32769: msidbServiceInstallErrorNormal plus Vital), as its virtual account.
    ServiceInstall = @(
        @{
            ServiceInstall = 'KalzitService'; Name = 'Kalzit'; DisplayName = 'Kalzit'
            ServiceType = 16; StartType = 2; ErrorControl = 32769
            LoadOrderGroup = ''; Dependencies = ''; StartName = 'NT SERVICE\Kalzit'; Password = ''
            Arguments = 'service run --config "[CommonAppDataFolder]Kalzit\kalzit.toml"'
            Component = 'KalzitExe'; Description = 'Kalzit: visualize and analyze your data.'
        }
    )
}
