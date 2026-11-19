## Fixed

- A stopping server lets running live updates finish their current query before it closes the
  databases, so the files of SQLite data sources are always closed when the stop completes.
