Recorded API answers for the warehouse sources (BigQuery, Snowflake, Databricks SQL), written
after the published API references with made-up sample data; no customer data. Each
`<kind>.json` holds the answers by name. The HTTP mock in `tests/support/warehouse_mock.rs` serves
them to the unit tests in `src/datasources` and to `tests/warehouses.rs`; `{base}` stands for the
mock's URL. `test-key.*.b64` is a throwaway RSA key generated for these tests only (base64 DER,
PKCS#8 and PKCS#1), never used anywhere else.
