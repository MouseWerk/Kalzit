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
  a provider; results are cut to `ai.max_rows_to_model` rows, documents or nodes.
- Keys are stored encrypted like data source secrets and are write-only: answers carry
  `apiKeySet`, never the key. Errors are scrubbed of the key, also when a provider echoes it.
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
  "provider": { "id": "0192f0c1-...", "kind": "openai", "model": "example-model",
                "host": "llm.intern", "scope": "server" },
  "usage": { "requests": 3, "tokens": 5120, "requestsLimit": 200, "tokensLimit": 200000,
             "orgTokensMonth": 1250000, "orgTokensMonthLimit": 20000000 }
}
```

`reason` is set when AI is on but not usable (`ai.no_provider`). `provider.host` is where data
goes (the host of the base URL, never the whole URL); `provider.scope` is `org` when the
organization's own provider is in effect. `usage` holds the caller's calls and tokens today (UTC)
in this organization and the organization's tokens this calendar month; a limit of 0 means none.
The UI asks this once per organization and renders AI only when `enabled` and `usable` are both
true (`ui/src/features/ai`, `AiGate`).

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
- `isDefault`: the provider used within its scope. The first provider of a scope becomes its
  default; making another one default unsets the old one; deleting the default makes the oldest
  remaining one the default.
- `lastTest`: the outcome of the last connection test (`ok`, `reason` when it failed, `at`).
- `PATCH` needs `expectedUpdatedAt` (the `updatedAt` last read); a provider saved in the meantime
  answers `409 version_conflict` with the stored one as `current`.

Base URLs follow the data source target policy (docs/ARCHITECTURE.md, "Data sources"): private
networks and localhost are allowed, link-local and cloud metadata addresses are refused, and
`datasources.allowed_targets` restricts providers as it restricts data sources. The address is
checked when it is saved and again on every connection. An address that is this Kalzit server
itself (its public URL, or a loopback or listening address on one of its ports) is refused
(`ai.base_url_kalzit`). Requests never follow redirects, so the key reaches only the configured
address.

### Test

`POST .../providers/{providerId}/test` sends a tiny prompt (`Reply with the single word OK.`,
at most 16 tokens) and answers `200` either way:

```json
{ "ok": true, "latencyMs": 412, "reply": "OK", "usage": { "inputTokens": 14, "outputTokens": 1 } }
{ "ok": false, "latencyMs": 98, "reason": "ai.provider_unauthorized", "params": { "status": "401" }, "message": "..." }
```

It works while AI is off, so a provider can be checked before AI is turned on. It is not counted
against the limits; it is audited and kept as `lastTest`. At most 20 tests per user and minute
(`429 rate_limited`, `ai.test_rate_limited`).

## Settings, limits and usage

Server settings (`/admin/settings`):

| Key | Default | What |
|---|---|---|
| `ai.enabled` | `false` | every AI function on or off |
| `ai.allow_org_providers` | `true` | organizations may connect their own provider |
| `ai.user_requests_per_day` | 200 | calls per person and day (UTC) in one organization; 0: none |
| `ai.user_tokens_per_day` | 200000 | tokens per person and day; 0: none |
| `ai.org_tokens_per_month` | 20000000 | tokens of an organization per calendar month (UTC); 0: none |
| `ai.max_rows_to_model` | 200 | rows, documents or nodes of one result AI receives |
| `ai.max_tool_calls` | 10 | tool calls per chat answer (with the chat) |
| `ai.max_concurrent` | 8 | calls running at once on the server |
| `ai.max_concurrent_per_user` | 2 | calls running at once per person |
| `ai.request_timeout_secs` | 120 | one call, including the streamed answer |
| `ai.chat_retention_days` | 30 | days chats are kept after their last message; 0 keeps none |

Organization settings (`/orgs/{orgId}/settings`, `settings:write`): `ai.org_enabled` (default
`true`) and, starting as `inherit`, `ai.user_requests_per_day`, `ai.user_tokens_per_day`,
`ai.org_tokens_per_month` and `ai.chat_retention_days`. An organization can only lower them: the
stricter of the server's and the organization's value applies (a limit of 0 in the organization
follows the server).

A call counts when it starts, its tokens when it ends; calls running at the same time can pass a
limit together by at most their number. A used-up daily limit answers `429 rate_limited` with
`Retry-After` until midnight UTC, the monthly one until the month ends; a concurrency limit asks
to retry after 5 seconds.

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
  result of the source; `iban` covers `konto.iban` in a document), without regard to case.
  Graph properties match by name or `Label.property`. The list is kept while the source is closed.
- Every change is audited (`datasource.ai_access_changed`, with `readable` and the number of
  excluded fields).

`GET /orgs/{orgId}/ai/datasources` (every member): the sources open to AI among those the caller
may read, as `{"items": [{"datasourceId": "..."}]}`.

## Errors

`409 ai_unavailable`: AI is off, no provider is in effect, the notice is not acknowledged, or the
source is closed to AI. `502 ai_provider_error` (`504` for a timeout): the provider failed.
`422 datasource_target_blocked`: the target policy refused the address. Calls are retried with
backoff (0.5 s, 1 s, ...; at most 3 attempts, honouring a `Retry-After` up to 10 s) while the
provider answers 408, 425, 429, 500, 502, 503, 504 or 529 or cannot be reached, as long as nothing
of the answer arrived yet.

## Reasons

As in docs/api/datasources.md, "Reasons": `reason` and `params` next to `code`, translated by the
UI, with `message` as the English fallback. The `target.*` and `request.*` reasons are the data
sources' own.

| Reason | Params | When |
|---|---|---|
| `ai.disabled` | | `ai.enabled` is off |
| `ai.org_disabled` | | `ai.org_enabled` of the organization is off |
| `ai.no_provider` | | no provider is in effect for the organization |
| `ai.notice_required` | | the caller has not acknowledged the notice for the provider in effect |
| `ai.notice_provider_changed` | | the acknowledged provider is not the one in effect (`409 conflict`) |
| `ai.datasource_not_readable` | | a result of a source closed to AI was to be sent |
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
