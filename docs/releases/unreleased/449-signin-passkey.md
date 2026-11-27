## Improved

- Sign in with a passkey alone: "Sign in with a passkey" on the sign-in page, and browsers that can also suggest saved passkeys in the email field. A passkey that checks it is you counts as both steps, so no second step follows. It signs in only where your password could, and it is off where passkeys are off.
- "Shared or borrowed computer" now also ends the session when the browser closes, at the latest after 12 hours.
- New passkeys are saved so the browser can offer them without an email address.
- Recent sign-ins name sign-ins with a passkey alone.

## Checklist for Windows (manual)

- Open Kalzit by its host name (not an IP address) in Edge with Windows Hello, add a passkey under Settings > Sign-in and security, sign out, and choose "Sign in with a passkey": Windows Hello asks for the PIN or face, and you are signed in without a second step.
- On the sign-in page, click into the email field: Edge offers the saved passkey there.
- Tick "Shared or borrowed computer", sign in, close every Edge window and open Kalzit again: you are signed out.
