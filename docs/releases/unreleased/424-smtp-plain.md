## Improved

- Settings > Email offers "No encryption" next to STARTTLS and TLS, for example for an internal
  mail relay on port 25. It is plain SMTP to any host in your network and never switches to
  STARTTLS; a user and password stay possible. The page warns calmly that mails, the server
  address and, with a user, the password travel unencrypted, so use it only for a trusted relay in
  your own network. `security = "none"` in `kalzit.toml` or `KALZIT_SMTP_SECURITY` works the same
  way and is no longer limited to a relay on the same computer.

## Checklist for Windows (manual)

- Settings > Email: choose "No encryption", enter an internal relay in your network with port 25
  (or leave the port empty), send a test mail and save; the mail arrives, the test result shows no
  TLS version, and the warning under Encryption is shown (with a second sentence once a user is
  entered).
