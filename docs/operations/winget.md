# winget: operator guide

Kalzit's Windows installer (the MSI package) is offered through winget as `MouseWerk.Kalzit`, so
Windows administrators can install and upgrade it with:

```powershell
winget install MouseWerk.Kalzit
winget upgrade MouseWerk.Kalzit
```

winget runs the same MSI package as a download from the release (it checks its SHA-256 first),
with the defaults of a silent installation ([Installation](../guide/installation.md#silent-installation)).
Settings are passed as MSI properties with `--override`, for example
`winget install MouseWerk.Kalzit --override "/qn PORT=8080 FIREWALL=1"`.

## The manifests

- `packaging/winget/` holds the templates: the version, installer and default locale (en-US)
  manifests of winget's schema 1.9.0, with placeholders for the version, the release date and the
  MSI's address and SHA-256. `packaging/winget/render.sh` fills them in.
- The release workflow (`.github/workflows/release.yml`, job `publish`) renders them for every
  stable release (not for a pre-release) with the MSI's address in that release and the SHA-256
  it has checked, and attaches them as `kalzit-<version>-winget.zip`, already in the folder layout
  of the winget-pkgs repository (`manifests/m/MouseWerk/Kalzit/<version>/`).
- A change to the package's text (description, tags) goes into the templates, so the next
  release carries it.

## Submitting a release (project owner, manual)

Submitting to the community repository `microsoft/winget-pkgs` stays a manual step, since it is a
pull request in Microsoft's repository under the owner's GitHub account:

1. Download `kalzit-<version>-winget.zip` from the GitHub release and unpack it.
2. Check the manifests on a Windows computer:
   `winget validate --manifest manifests\m\MouseWerk\Kalzit\<version>`, and for a test
   installation in a VM or Windows Sandbox
   `winget settings --enable LocalManifestFiles` and
   `winget install --manifest manifests\m\MouseWerk\Kalzit\<version>`.
3. In a fork of `microsoft/winget-pkgs`, copy the folder `manifests\m\MouseWerk\Kalzit\<version>`
   to the same place, commit it and open a pull request (one version per pull request). Instead
   of the fork, `wingetcreate submit manifests\m\MouseWerk\Kalzit\<version>` (Windows Package
   Manager Manifest Creator) opens the pull request with a GitHub token.
4. Microsoft's validation installs the package in a sandbox; a maintainer merges the pull request
   once it passes. The first submission may take longer, since the package identifier is new.
   Answer questions in the pull request, and fix a rejected manifest in the templates too.

An unsigned MSI (a release without code signing) can be flagged by the validation; signed
packages pass more reliably ([Code signing](updates.md#code-signing-for-windows-project-owner-once)).
