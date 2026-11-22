## Fixed

- Start-up no longer waits for DNS: a PostgreSQL host given by name is looked up in the
  background, so an unreachable name server cannot delay the start of Kalzit or the first mail.
- About: the license text opens from Kalzit itself instead of a page on another site, so it is
  readable without internet.

## Improved

- New guide "Offline and air-gapped operation" (English and German): what works without
  internet, which features reach outside and when they are off, and how to update with an
  offline package.
