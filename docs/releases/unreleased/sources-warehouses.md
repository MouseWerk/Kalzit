## Improved

- New data sources for data warehouses: Google BigQuery (service account key or workload identity
  federation), Snowflake (key-pair authentication) and Databricks SQL (personal access token or
  OAuth machine-to-machine), with connection test, schema browsing and Explore starters.
- BigQuery estimates every query in a dry run first, shows the estimated bytes with the result
  and refuses a query above the source's maximum bytes billed.
- Queries in the three warehouses are read-only, are cancelled in the warehouse when Kalzit stops
  waiting for them, and are kept in the query cache by default to save costs.
