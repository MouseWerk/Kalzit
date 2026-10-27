# AI API

Configuration and status of the built-in AI functions (M4; design in docs/ARCHITECTURE.md,
"AI", screens on the board `docs/design/blueprint/AI.dc.html`). This part holds the switches, the
providers, the limits, the first-use notice and what AI may read of each data source; the AI
functions themselves (explain or draft a query, summarize a result, chat) build on it.

## Rules

- AI is off by default. `ai.enabled` (server setting) turns all of it on or off; an organization
  can turn it off for its members (`ai.org_enabled`, organization setting). Off, the status answers
  only `{"enabled": false, "usable": false}` and every AI call is refused with
  `409 ai_unavailable` (`ai.disabled`, `ai.org_disabled`); the UI shows no AI button, menu entry or
  hint, not even greyed out.
- AI can only be switched on (`ai.enabled` on the server, `ai.org_enabled` back on in an
  organization) while a provider in effect passed its connection test since its base URL, model,
  key or `tokenLimitField` last changed; for the server switch that is the server's default
  provider (or, without one, an organization's default). Otherwise the change answers
  `409 conflict` (`ai.enable_needs_tested_provider`). Such a change clears the provider's
  `lastTest`; AI that is already on stays on.
- A provider is in effect for an organization when the organization has a default provider of its
  own (and the server allows that, `ai.allow_org_providers`), else when the server has a default
  provider. Without one AI is not usable (`ai.no_provider`), and the UI shows nothing of it either.
- Before a person's first AI call through a provider, the UI shows what leaves the server and to
  which host; the person acknowledges it once per provider (`POST .../ai/notice`). Until then AI
  calls are refused (`ai.notice_required`). A new provider asks again.
- AI runs with the signed-in user's rights only and only reads. It may read a data source's schema
  and results only when that source was opened to AI (off by default, see "Data sources"). For a
  closed source, explain and draft send only the query text the user typed, never the schema.
- Fields excluded on a data source keep their name and lose their value before anything goes to
  a provider; results are cut to `ai.max_rows_to_model` rows, documents or nodes. Excluding works
  by name and is best effort, not a security boundary (see "Data sources").
- Keys are stored encrypted like data source secrets and are write-only: answers carry
  `apiKeySet`, never the key. Errors are scrubbed of the key, also of a partial echo (its start or
  end), when a provider repeats it.
- Kalzit itself is never a target: besides the checks when a base URL is saved, every connection
  to one of Kalzit's own listening ports refuses all addresses of this computer (loopback, the
  addresses of its interfaces, unspecified, also as IPv4-mapped IPv6), whatever name resolves
  there (`ai.base_url_kalzit`).
- Usage is shown as token and call counts; Kalzit shows no prices or currencies.
- Every AI call is audited (`ai.called`: purpose, provider kind and scope, model, tokens, outcome),
  never with the prompt or the answer. Configuration changes are audited as well
  (`ai.provider_created`, `ai.provider_updated`, `ai.provider_deleted`, `ai.provider_tested`,
  `ai.notice_acknowledged`, `datasource.ai_access_changed`), never with a key or field names.

## Status

`GET /orgs/{orgId}/ai/status` (every member)

```json
{
  "enabled": true,
  "usable": true,
  "noticeAcknowledged": false,
  "provider": { "id": "0192f0c1-...", "name": "Lokal", "kind": "openai", "model": "example-model",
                "host": "llm.intern", "scope": "server" },
  "usage": { "requests": 3, "tokens": 5120, "requestsLimit": 200, "tokensLimit": 200000,
             "orgTokensMonth": 1250000, "orgTokensMonthLimit": 20000000 },
  "noticeText": "Fragen zum Datenschutz an datenschutz@example.org.",
  "maxRowsToModel": 200
}
```

`reason` is set when AI is on but not usable (`ai.no_provider`). `provider.host` is where data
goes (the host of the base URL, never the whole URL); `provider.scope` is `org` when the
organization's own provider is in effect. `usage` holds the caller's calls and tokens today (UTC)
in this organization and the organization's tokens this calendar month; a limit of 0 means none.
`noticeText` is the administrators' own paragraph for the first-use notice (`ai.notice_text`, left
out while empty) and `maxRowsToModel` the row limit the notice names. The UI asks this once per
organization and renders AI only when `enabled` and `usable` are both true (`ui/src/features/ai`,
`AiGate`).

## First-use notice

`POST /orgs/{orgId}/ai/notice` with `{"providerId": "..."}` (every member): the caller read the
notice for the provider in effect. `204`; again is harmless. A `providerId` that is not the one in
effect answers `409 conflict` (`ai.notice_provider_changed`): the UI shows the notice of the new
provider instead.

## Providers

Server-wide providers (server administrators):

| Method | Path |
|---|---|
| `GET` | `/admin/ai/providers` |
| `POST` | `/admin/ai/providers` |
| `PATCH` | `/admin/ai/providers/{providerId}` |
| `DELETE` | `/admin/ai/providers/{providerId}` |
| `POST` | `/admin/ai/providers/{providerId}/test` |

An organization's own providers (`settings:read` to list, `settings:write` for the rest), used
for its members instead of the server's. Creating one needs `ai.allow_org_providers`
(`403 forbidden`, `ai.org_providers_not_allowed`); while it is off, existing ones are not used.

| Method | Path |
|---|---|
| `GET` | `/orgs/{orgId}/ai/providers` |
| `POST` | `/orgs/{orgId}/ai/providers` |
| `PATCH` | `/orgs/{orgId}/ai/providers/{providerId}` |
| `DELETE` | `/orgs/{orgId}/ai/providers/{providerId}` |
| `POST` | `/orgs/{orgId}/ai/providers/{providerId}/test` |

A provider of one scope is `404 not_found` through the routes of another.

```json
{
  "id": "0192f0c1-...",
  "scope": "server",
  "name": "Lokal",
  "kind": "openai",
  "baseUrl": "http://llm.intern:11434/v1",
  "model": "example-model",
  "isDefault": true,
  "tokenLimitField": "auto",
  "apiKeySet": false,
  "createdAt": 1800000000000,
  "updatedAt": 1800000000000,
  "lastTest": { "ok": true, "at": 1800000000000 }
}
```

- `kind`: `openai` for the OpenAI chat completions API and every server that speaks it (OpenAI,
  LiteLLM, Ollama, vLLM, LM Studio), or `anthropic` for the Anthropic Messages API. It cannot be
  changed; create another provider instead.
- `baseUrl`: the API's base including its version path for `openai`
  (`https://api.openai.com/v1`, `http://localhost:11434/v1` for Ollama,
  `http://litellm:4000/v1`); for `anthropic` the host (`https://api.anthropic.com`; a base ending
  in `/v1` is taken as it is). Requests go to `{baseUrl}/chat/completions` and
  `{baseUrl}/v1/messages`. http and https only, without credentials, query or fragment.
- `model`: the model id exactly as the provider lists it (for Ollama the name of a pulled model).
  Kalzit has no built-in model list and no default model; the administrator picks one.
- `apiKey` (write only): required for `anthropic`, optional for `openai` (local servers often
  have none). On `PATCH`: absent keeps it, `null` removes it, a text sets it. Changing `baseUrl`
  needs `apiKey` in the same request (the key again, or `null`), so a key never reaches another
  server unasked (`ai.key_resend_on_target_change`).
- `tokenLimitField` (`openai` only): the request field that carries the answer's token budget.
  `auto` (default) sends `max_completion_tokens` to api.openai.com, whose newer models refuse
  `max_tokens`, and `max_tokens` to every other server; `max_tokens` or `max_completion_tokens`
  fix it. A compatible server that answers 400 to `stream_options` is asked once more without
  it; its usage is then estimated (see "Settings, limits and usage").
- `isDefault`: the provider used within its scope. The first provider of a scope becomes its
  default; making another one default unsets the old one; deleting the default makes the oldest
  remaining one the default.
- `lastTest`: the outcome of the last connection test (`ok`, `reason` when it failed, `at`). A
  change of `baseUrl`, `model`, `apiKey` or `tokenLimitField` clears it, and a change of `baseUrl`
  also clears every acknowledgement of the notice for the provider (the destination changed).
- `PATCH` needs `expectedUpdatedAt` (the `updatedAt` last read); a provider saved in the meantime
  answers `409 version_conflict` with the stored one as `current`.

Base URLs follow the data source target policy (docs/ARCHITECTURE.md, "Data sources"): private
networks and localhost are allowed, link-local and cloud metadata addresses are refused, and
`datasources.allowed_targets` restricts providers as it restricts data sources. The address is
checked when it is saved and again on every connection. An address that is this Kalzit server
itself is refused (`ai.base_url_kalzit`): when saved, its public URL or a loopback or listening
address on one of its ports (IPv4-mapped IPv6 included); on every connection to one of its
ports, every address of this computer, also behind a host name. Requests never follow
redirects, so the key reaches only the configured address. One time limit,
`ai.request_timeout_secs`, covers the whole call: every attempt, the waits between them and the
streamed answer.

### Test

`POST .../providers/{providerId}/test` sends a tiny prompt (`Reply with the single word OK.`,
an answer budget of 512 tokens, room for models that reason before they answer) and answers
`200` either way:

```json
{ "ok": true, "latencyMs": 412, "reply": "OK", "usage": { "inputTokens": 14, "outputTokens": 1 } }
{ "ok": false, "latencyMs": 98, "reason": "ai.provider_status", "params": { "status": "400", "detail": "..." }, "message": "..." }
```

A failed test shows up to 300 characters of the provider's own error text (`detail`, from its
`error.message` or the start of its answer), scrubbed of the key; it is meant for administrators
and can name the provider's view of the request. It works while AI is off, so a provider can be
checked before AI is turned on. It is not counted against the limits; it is audited and kept as
`lastTest`. At most 20 tests per user and minute (`429 rate_limited`, `ai.test_rate_limited`).

## Settings, limits and usage

Server settings (`/admin/settings`):

| Key | Default | What |
|---|---|---|
| `ai.enabled` | `false` | every AI function on or off (on only with a tested provider, see "Rules") |
| `ai.allow_org_providers` | `true` | organizations may connect, change, test and use their own provider |
| `ai.user_requests_per_day` | 200 | calls per person and day (UTC) in one organization; 0: none |
| `ai.user_tokens_per_day` | 200000 | tokens per person and day; 0: none |
| `ai.org_tokens_per_month` | 20000000 | tokens of an organization per calendar month (UTC); 0: none |
| `ai.max_rows_to_model` | 200 | rows, documents or nodes of one result AI receives |
| `ai.max_tool_calls` | 10 | tool calls per chat answer (applies with the chat) |
| `ai.max_concurrent` | 8 | calls running at once on the server |
| `ai.max_concurrent_per_org` | 4 | calls running at once in one organization |
| `ai.max_concurrent_per_user` | 2 | calls running at once per person |
| `ai.request_timeout_secs` | 120 | one call, including retries and the streamed answer |
| `ai.chat_retention_days` | 30 | days chats are kept after their last message; 0 keeps none; applies once chats are stored (the chat package) |
| `ai.notice_text` | empty | a paragraph of the administrators under the first-use notice, at most 2000 characters |

Organization settings (`/orgs/{orgId}/settings`, `settings:write`): `ai.org_enabled` (default
`true`) and, starting as `inherit`, `ai.user_requests_per_day`, `ai.user_tokens_per_day`,
`ai.org_tokens_per_month` and `ai.chat_retention_days`. An organization can only lower them: the
stricter of the server's and the organization's value applies (a limit of 0 in the organization
follows the server).

A call counts and reserves its budget when it starts: its estimated input (four characters a
token) plus its answer budget (`max_tokens`, 4096 when the feature names none). The check of the
limits and the reservation are one step, and reservations count as used, so calls that start
together cannot pass a limit; within one server process, that is (with several processes on one
database each may admit one call too many). When the call ends, fails or is dropped, the
reservation is replaced by what it used, in one statement, and the call is audited; this runs in
a task of its own, so a caller that goes away still leaves the call counted. When a provider sent
no usage (a compatible server without `stream_options`, or a call cut short before the usage
came), the tokens are estimated from the request and what arrived, and the audit entry says
`"estimated": true`; a call cut short counts at least what arrived. Usage rows stay with the
organization when a user is deleted, so the month keeps counting.

A used-up daily limit answers `429 rate_limited` with `Retry-After` until midnight UTC, the
monthly one until the month ends; a concurrency limit asks to retry after 5 seconds.

`GET /admin/ai/usage?days=7` (server administrators): calls and tokens per day and organization.
`GET /orgs/{orgId}/ai/usage?days=7` (`settings:read`): per day and member. `days` is 1 to 90,
today included; newest day first.

```json
{ "items": [{ "day": "2027-01-15", "orgId": "...", "requests": 12, "inputTokens": 30210, "outputTokens": 2210 }] }
```

## Data sources

`GET /orgs/{orgId}/datasources/{datasourceId}/ai-access` (who may read the source) and `PUT` (who
may edit it: `datasources:write`, org-wide or by a grant on the source):

```json
{ "datasourceId": "...", "readable": true, "excludedFields": ["kunden.email", "kunden.iban"] }
```

- `readable` opens the source to AI (default closed): its schema for explain and draft, its
  results for summarize and the chat, always with the rights of the person asking.
- `excludedFields` (on `PUT` optional; absent keeps the list): field names or dotted paths whose
  values AI never receives; at most 200 entries of 1 to 256 characters. The server replaces their
  values with `[excluded]`; the model sees only the name. Matching is broad on purpose, since
  results do not always name their table: an entry matches a field whose name or path equals it,
  or where one is a dotted suffix of the other (`kunden.email` covers the column `email` in every
  result of the source; `iban` covers `konto.iban` in a document or a JSON column), after Unicode
  NFKC and case folding (`Straße` matches `STRASSE`). Graph properties match by name or
  `Label.property`. The list is kept while the source is closed.
- Excluding is best effort by name, not a security boundary: a query that renames a field
  (`email AS kontakt`) or computes from it (`lower(email)`) returns its values under another
  name. Whatever must never reach a provider belongs in a source that stays closed to AI, or
  behind the database's own rights.
- Every change is audited (`datasource.ai_access_changed`, with `readable` and the number of
  excluded fields).

`GET /orgs/{orgId}/ai/datasources` (every member): the sources open to AI among those the caller
may read, as `{"items": [{"datasourceId": "..."}]}`.

## Explain, draft and summarize

The plain AI calls. Each one runs through the AI core (switch, provider in effect, notice, limits,
audit as `ai.called` with `purpose` and `promptVersion`) with the caller's rights, and only reads.

| Method | Path | Who | Purpose |
|---|---|---|---|
| `POST` | `/orgs/{orgId}/ai/explain` | `datasources:query` on the source | `explain_query` |
| `POST` | `/orgs/{orgId}/ai/draft` | `datasources:query` on the source | `draft_query` |
| `POST` | `/orgs/{orgId}/ai/summarize` | `datasources:query` on the source | `summarize_result` |
| `POST` | `/orgs/{orgId}/dashboards/{dashboardId}/panels/{panelId}/ai/summarize` | `dashboards:read` on the dashboard | `summarize_result` |

```json
{ "datasourceId": "...", "query": { "sql": "SELECT ..." }, "language": "de" }
{ "datasourceId": "...", "request": "Neukunden je Region", "query": { "sql": "..." }, "language": "de" }
{ "query": { "refId": "A", "datasourceId": "...", "query": { "sql": "..." } },
  "timeRange": { "from": 1800000000000, "to": 1800003600000 }, "variables": {}, "language": "en" }
{ "timeRange": { "from": 1800000000000, "to": 1800003600000 }, "variables": {}, "language": "de" }
```

- **Explain** sends the query text and, only for a source open to AI, its schema (names and
  types; `ai::redact`). For a closed source it sends the query text alone.
- **Draft** sends the request (1 to 4000 characters), the query in the editor as context and,
  only for an open source, the schema. The answer's first code block becomes `draft` in the
  source's query form (`{sql}`, `{expr}`, `{cypher}`, `{gsql}`, `{lucene}`, MongoDB
  `{collection, pipeline}`; `null` when it does not fit) and `draftText`. A draft is never run: the
  UI offers it, and when the person runs it, it passes the same read-only checks as any query.
- **Summarize** runs the query again on the server as the caller (Explore: a free query, which
  needs `datasources:query`; a panel: the panel's stored queries with the dashboard's variables,
  as `.../panels/{panelId}/query` runs them, so viewers can summarize panels they can read). Every
  source involved must be open to AI, else `409 ai_unavailable` (`ai.datasource_not_readable`)
  before anything runs. The results go through `ai::redact` (excluded values replaced, cut to
  `ai.max_rows_to_model`), with the panel's title, the queries and the time range.
- The switch, the provider, the notice and the daily and monthly limits are checked before a
  query runs or a schema is read; a refusal is an ordinary JSON error (`409`, `429`, `403`).
- `language` (`de` or `en`, default `en`) is the language of the answer.

The answer is a stream of server-sent events (`text/event-stream`), so it shows as it is written.
The existing live channel (a WebSocket for panel data) is not used: these calls are one request
and one answer, which a `POST` with an event stream fits, and closing the request cancels the
call (it is then counted with what arrived and audited as `cancelled`).

```
event: meta
data: {"provider":{"id":"...","name":"Lokal","kind":"openai","model":"example-model","host":"llm.intern","scope":"server"},"schema":true}

event: text
data: {"text":"Die Abfrage summiert "}

event: done
data: {"usage":{"inputTokens":812,"outputTokens":95},"draft":{"sql":"SELECT ..."},"draftText":"SELECT ..."}
```

- `meta` comes first: the provider, and what was sent: `schema` (explain, draft) or `results`
  (summarize: per query `refId`, `rows` sent, `truncated`, `excludedValues`) and `title`.
- `text` carries the next part of the answer.
- `done` ends a complete answer, with `usage` when the provider reported it and, for a draft,
  `draft` and `draftText`.
- `error` (`{"error": {...}}` as in the error envelope) ends a failed answer, such as
  `ai_provider_error` with `ai.provider_timeout`.

Prompts (`server/src/ai/prompts.rs`) are versioned per feature. Everything from a source or typed
by a person goes into the user message inside `<kalzit:...>` blocks that cannot be closed from
inside; the system prompt says the blocks are data whose instructions are never followed. The
answer is shown as text; nothing in it is run.

## Errors

`409 ai_unavailable`: AI is off, no provider is in effect, the notice is not acknowledged, or the
source is closed to AI. `502 ai_provider_error` (`504` for a timeout): the provider failed.
`422 datasource_target_blocked`: the target policy refused the address. Calls are retried with
backoff (0.5 s, 1 s, ...; at most 3 attempts, honouring a `Retry-After` up to 10 s) while the
provider answers 408, 425, 429, 500, 502, 503, 504 or 529 or cannot be reached, as long as nothing
of the answer arrived yet and the time limit leaves room for it.

## Reasons

As in docs/api/datasources.md, "Reasons": `reason` and `params` next to `code`, translated by the
UI, with `message` as the English fallback. The `target.*` and `request.*` reasons are the data
sources' own.

| Reason | Params | When |
|---|---|---|
| `ai.disabled` | | `ai.enabled` is off |
| `ai.org_disabled` | | `ai.org_enabled` of the organization is off |
| `ai.enable_needs_tested_provider` | | `409 conflict` on turning `ai.enabled` or `ai.org_enabled` on without a provider in effect that passed its test since its last change |
| `ai.limit_org_concurrent` | `max` | the organization has `max` calls running already |
| `ai.token_limit_field_unknown` | | `tokenLimitField` is not `auto`, `max_tokens` or `max_completion_tokens` |
| `ai.no_provider` | | no provider is in effect for the organization |
| `ai.notice_required` | | the caller has not acknowledged the notice for the provider in effect |
| `ai.notice_provider_changed` | | the acknowledged provider is not the one in effect (`409 conflict`) |
| `ai.datasource_not_readable` | `name`, `datasourceId` | a result of a source closed to AI was to be sent (the params name the source where the call knows it) |
| `ai.query_empty` | | there is no query to explain or summarize |
| `ai.query_too_large` | `bytes` | the query is larger than `bytes` as JSON |
| `ai.request_invalid` | `max` | the request of a draft is empty, longer than `max` characters or has control characters |
| `ai.key_unreadable` | | the stored key cannot be decrypted (another secrets key); enter it again |
| `ai.limit_user_requests` | `max` | the caller used their calls for today |
| `ai.limit_user_tokens` | `max` | the caller used their tokens for today |
| `ai.limit_org_tokens` | `max` | the organization used its tokens for this month |
| `ai.limit_concurrent` | `max` | `max` calls run on the server already |
| `ai.limit_user_concurrent` | `max` | the caller has `max` calls running already |
| `ai.cancelled` | | the call was cancelled (the client left, or the caller stopped it) |
| `ai.provider_timeout` | | no whole answer within `ai.request_timeout_secs` |
| `ai.provider_unreachable` | `detail` | the connection failed |
| `ai.provider_unauthorized` | `status` | the provider answered 401 or 403 |
| `ai.provider_overloaded` | `status`, `detail` | 429, 503 or 529 after the retries, or an overload event in the stream |
| `ai.provider_status` | `status`, `detail` | any other error answer or error event |
| `ai.provider_protocol` | `detail` | an answer that is not the expected format, or ended early |
| `ai.provider_too_large` | `bytes` | the answer is larger than 16 MiB |
| `ai.kind_unknown` | `kind` | `kind` is not `openai` or `anthropic` |
| `ai.model_invalid` | `max` | `model` is empty, longer than `max` or has control characters |
| `ai.key_invalid` | `max` | `apiKey` is empty, longer than `max` or has control characters |
| `ai.key_required` | `kind` | an `anthropic` provider without a key |
| `ai.base_url_invalid` | | `baseUrl` is not an http or https URL, or has credentials, a query or a fragment |
| `ai.base_url_kalzit` | | `baseUrl` is this Kalzit server |
| `ai.key_resend_on_target_change` | | `baseUrl` changed while a key is stored and `apiKey` was not sent |
| `ai.org_providers_not_allowed` | | an organization's own provider while `ai.allow_org_providers` is off (`403 forbidden`) |
| `ai.excluded_fields_invalid` | `max` | `excludedFields` has more than `max` entries, or an empty, too long or malformed one |
| `ai.test_rate_limited` | `max` | more than `max` tests per minute |
