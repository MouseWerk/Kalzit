## Fixed

- Kalzit's own PostgreSQL database is now refused as a plugin, mail or outbound proxy target however
  its address is written: several hosts in one URL, `host`, `hostaddr` and `port` parameters (also
  percent-encoded), key=value strings, IPv6 addresses, unix-socket directories (a socket database
  counts as on this machine) and the `PGHOST`, `PGHOSTADDR` and `PGPORT` defaults. While one of its
  host names cannot be resolved, its port is refused on every address.
