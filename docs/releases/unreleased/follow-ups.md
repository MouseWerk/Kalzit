## Improved

- Einstellungen > Allgemein shows the Windows event log option (`log.event_log`: errors, warnings
  and errors, or off) next to the other logging options, read-only like every option from the
  configuration file.

## Fixed

- An email address with an internationalized domain (such as `anna@bücher.example`) is one
  address in every spelling: signing in, asking for a password link and adding a member find the
  account whether the domain is typed in Unicode or in its `xn--` form, and two accounts can no
  longer be created at the same moment with two spellings of one address.
- A custom accent color now needs at least 3:1 contrast on every surface of the light and dark
  themes, not only on the lightest and darkest one, so the accent swatch, primary buttons and the
  chosen color stay visible everywhere. A custom color saved before that falls short is shown as
  the default copper until an admin chooses a new one.
- A directory sign-in that enables an account the directory sync had disabled no longer undoes an
  admin's or a sync run's change made to the account at the same moment.
- The dashboard's "More" menu and the other toolbar menus stay inside the page's main area for
  screen readers.

## Checklist for Windows (manual)

- Settings: as a server admin, open Einstellungen > Allgemein and check that "Windows-
  Ereignisprotokoll" shows the value of `log.event_log` from `kalzit.toml` (default "Fehler") and
  cannot be changed on the page.
- Internationalized address: create a user with an address like `lea@xn--bcher-kva.example`, then
  sign in with `lea@bücher.example` and check that it works.
- Accent: in Einstellungen > Darstellung, open "Eigene Farbe", enter `#7c3aed` and check that the
  dialog refuses it for too little contrast; `#2563eb` is accepted.
