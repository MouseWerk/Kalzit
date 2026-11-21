## Fixed

- Kalzit's own PostgreSQL database is now refused as a plugin or mail target however its address is
  written: several hosts in one URL, `host`, `hostaddr` and `port` parameters, key=value strings,
  IPv6 addresses and unix-socket directories (a socket database counts as on this machine).
