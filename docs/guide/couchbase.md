# Couchbase

Kalzit reads Couchbase Server 7.x through its query service. Queries are SQL++ (N1QL) `SELECT`
statements, and every result row stays a **document**, as Couchbase returns it.

## Connecting

Add a data source of the kind **Couchbase** under **Administration > Data sources**.

| Setting | Meaning |
|---|---|
| Query service URL | Such as `http://couchbase.intern:8093`, or `https://...:18093` with TLS |
| User name, Password | The login; the password is stored encrypted |
| CA certificate | A private CA in PEM, for HTTPS with a certificate of your own CA |
| Allow a user that may write | Off by default; see below |
| Bucket (for the schema) | Lists only this bucket's collections in the schema |

**Test connection** shows the Couchbase version and edition, and whether the user may write.

## Read-only

1. **The statement.** Kalzit runs exactly one `SELECT` (also after `WITH`, in parentheses or after
   `EXPLAIN`). Statements that write, change indexes, users or transactions are refused before
   anything is sent.
2. **The request.** Every statement is sent with `readonly: true`, so the query service itself
   refuses a write.
3. **The user.** Create a user with only the roles `query_select` and `data_reader` on the buckets
   to show:

   ```sh
   couchbase-cli user-manage -c couchbase.intern -u Administrator -p '...' \
     --set --rbac-username kalzit --rbac-password 'a long password' \
     --roles 'query_select[travel-sample],data_reader[travel-sample]' --auth-domain local
   ```

   Kalzit reads the user's roles (`system:my_user_info`) when the source is set up and on **Test
   connection**, and refuses a user with any role beyond reading, or whose roles it cannot read.
   Where the edition has no such roles, a data source admin can turn on **Allow a user that may
   write**; then the statement check and the read-only request keep queries read-only.

## Queries

```sql
SELECT a.name, a.country
FROM `travel-sample`.inventory.airline AS a
WHERE a.country = $land
ORDER BY a.name
LIMIT 100
```

Dashboard variables are named parameters: `$land` takes the variable `land`. `$__timeFrom` and
`$__timeTo` are the time range in Unix milliseconds (`STR_TO_MILLIS()` reads a date text),
`$__interval_ms` the interval. Positional parameters (`$1`, `?`) are refused. A query needs an
index on its collection, at least a primary one (`CREATE PRIMARY INDEX`, by an administrator).

Each row is one document; `SELECT RAW` values that are not objects become `{"value": ...}`. The
query time limit is sent as the request's `timeout`.

## Schema and Explore

The schema lists every `bucket.scope.collection` with its indexes and the fields of a sample of the
first 50 collections that can be read. Explore offers starters for the picked collection: documents,
a count, a count per value and the document keys. More examples are in the query language guide
([SQL++](query-languages.md#couchbase)).

## When something goes wrong

- **The Couchbase user has roles beyond reading**: give the user only `query_select` and
  `data_reader`, or let a data source admin allow it.
- **has no index this query can use**: the collection has no index; an administrator can create a
  primary index.
- **Couchbase refused the statement in a read-only request**: the statement would have written.
