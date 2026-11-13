# Alerting API

Alert rules, contact points, silences, history and the per data source opt-in of an
organization (design in docs/PLAN.md, section 13, screens on the board
`docs/design/blueprint/Alerting.dc.html`): the stored model and its rights, the preview of the
rule editor, the panel badges, and how rules are evaluated and their notifications delivered by
mail and webhook.

All routes are under `/api/orgs/{orgId}/...` and follow the API conventions (JSON in camelCase,
times in Unix milliseconds, durations in seconds, lists as `Page<T>` = `{ items, nextCursor }`,
errors as `{ error: { code, message, field?, reason?, params? } }`).

## Rules of the API

- Everything belongs to one organization. An id of another organization answers `404 not_found`,
  like an id that does not exist.
- Rights (all three can be chosen in custom roles too):

  | Permission | Built-in roles | Allows |
  |---|---|---|
  | `alerts:read` | viewer and up | rules with states and instances, silences, history, the status, contact points in their short form |
  | `alerts:write` | editor and up | create, change, pause, resume and delete rules; create and end silences |
  | `alerts:contacts` | admin and up | create, change and delete contact points, rotate webhook secrets, see their details |

- Saving a rule (`POST`, `PUT`) also needs `datasources:query` on its data source for the person
  saving it, and the source's alerting opt-in. Changing, pausing, resuming or deleting a stored
  rule also needs `datasources:query` on the source it uses now (`403 alerts.datasource_forbidden`).
  A rule can only use contact points and dashboards of its own organization.
- A data source with alert rules cannot be purged from the trash (`409 datasource.in_use` with
  `alertRules`); the automatic trash purge leaves it in the trash. Purging a dashboard keeps the
  rules made from its panels and clears their `dashboardId` and `panelId`.
- The scheduled evaluation never runs as the person who wrote a rule, but as the organization's
  **alerting identity**: a service account of the kind `alerting`, made at the first opt-in of a
  data source or the first rule (reading the status never makes it), fixed: no
  role or membership, no API tokens, no sign-in, not listed or changed by the service account
  routes, not deletable. Its only right is `datasources:query`, and only on sources with the
  alerting opt-in; the evaluation gets its caller context per data source
  (`service_account::context_for_source`), which checks the opt-in every time.
- Alerting can be turned off for the server (`alerting.enabled`) or an organization
  (`alerting.org_enabled`); rules are kept but not evaluated.
- Every change is audited: `alert_rule.created|updated|deleted|paused|resumed`,
  `alert_contact_point.created|updated|deleted|tested|secret_rotated`,
  `alert_silence.created|expired`, `datasource.alerting_changed`, and
  `alerting.settings_changed` for every `alerting.*` setting. Entries never hold a secret or a
  webhook URL (only its host); recipients are shortened (`j…@mousewerk.test`). Evaluations are
  in the history, not in the audit log.

## Status

`GET /orgs/{orgId}/alerting/status` (`alerts:read`)

```json
{
  "enabled": true,
  "serverEnabled": true,
  "orgEnabled": true,
  "limits": {
    "minIntervalSecs": 30, "evaluationTimeoutSecs": 30, "maxConcurrent": 8,
    "maxConcurrentPerOrg": 4, "maxConcurrentPerDatasource": 2, "maxRulesPerOrg": 500,
    "maxInstancesPerRule": 100, "maxContactPointsPerRule": 5, "maxSilencesPerOrg": 200, "webhookMaxBytes": 262144,
    "historyRetentionDays": 90
  },
  "serviceAccount": { "id": "…", "name": "Alerting", "permissions": ["datasources:query"] },
  "mailConfigured": true,
  "rules": 8,
  "pausedRules": 1,
  "instances": { "firing": 2, "ok": 5 }
}
```

`limits` are those in force for the organization: the server's, or the organization's where it
is stricter (see "Settings"). `serviceAccount` is `null` until the alerting identity is made.

## Settings

Through the settings routes (`/admin/settings`, `/orgs/{orgId}/settings`, docs/api/access.md);
each change is audited as `alerting.settings_changed`.

| Server setting | Default | Organization |
|---|---|---|
| `alerting.enabled` | `true` | `alerting.org_enabled` (`true`) turns it off for the organization |
| `alerting.min_interval_secs` | 30 | may only raise it |
| `alerting.evaluation_timeout_secs` | 30 | may only lower it |
| `alerting.max_concurrent` | 8 | |
| `alerting.max_concurrent_per_org` | 4 | may only lower it |
| `alerting.max_concurrent_per_datasource` | 2 | a source may set fewer (see "Data sources"); the lower of both applies |
| `alerting.max_rules_per_org` | 500 | may only lower it |
| `alerting.max_instances_per_rule` | 100 | may only lower it |
| `alerting.max_contact_points_per_rule` | 5 | may only lower it |
| `alerting.max_silences_per_org` | 200 | may only lower it; active and planned silences count, ended ones do not |
| `alerting.max_contact_points_per_org` | 50 | may only lower it |
| `alerting.max_messages_per_org_hour` | 1000 | may only lower it; first attempts count, retries and test sends do not |
| `alerting.webhook_max_bytes` | 262144 | |
| `alerting.history_retention_days` | 90 | may only shorten it |

Organization values are `"inherit"` by default. A value beyond the server's (a higher limit, a
longer retention, a shorter interval) is stored but has no effect; the stricter one applies.

## Rules

`Rule`:

```json
{
  "id": "…",
  "name": "Lager-API Latenz p95",
  "description": "",
  "runbookUrl": "https://wiki.example/lager-api",
  "datasourceId": "…",
  "query": { "query": "histogram_quantile(0.95, …)", "steps": [], "variables": {} },
  "queryHidden": false,
  "rangeSecs": 600,
  "reduce": { "shape": "frame", "function": "last" },
  "condition": { "op": "gt", "value": 1.5 },
  "intervalSecs": 60,
  "forSecs": 300,
  "noDataState": "no_data",
  "errorState": "error",
  "labels": { "team": "lager" },
  "reminderSecs": 14400,
  "paused": false,
  "contactPointIds": ["…"],
  "dashboardId": "…",
  "panelId": "p1",
  "version": 3,
  "createdBy": "…", "createdAt": 0, "updatedBy": "…", "updatedByName": "Lea Hoffmann", "updatedAt": 0,
  "lastEvaluatedAt": null, "lastDurationMs": null, "lastError": null, "skippedEvaluations": 0,
  "state": "firing",
  "instanceCounts": { "firing": 1, "ok": 1 }
}
```

- `query` is the rule's own copy: `query` is the source's query as `POST /query` takes it in a
  `QueryItem`, `steps` the visible steps after it (at most 20), `variables` fixed values (at most
  50); at most 64 KB together. `null` with `queryHidden: true` when the caller may neither read nor query the
  data source.
- `rangeSecs`: the relative range that fills `$__timeFilter` and `$__interval` (1 second to 30
  days, default 600).
- `reduce`, by the shape of the result:
  - `{ "shape": "frame", "function": "last|min|max|mean|sum|count" }`: one instance per series.
  - `{ "shape": "documents", "mode": "count" }`, or
    `{ "shape": "documents", "mode": "field", "path": "$.queue.depth", "function": "first|min|max|mean|sum" }`:
    one instance per rule.
  - `{ "shape": "graph", "count": "nodes|edges|paths", "label": "Dienst" }` (`label` optional, not
    for paths): one instance per rule.
- `condition`: `{ "op": "gt|gte|lt|lte|eq|ne", "value": n }` or
  `{ "op": "outside|inside", "low": n, "high": n }` with `low < high`; `inside` includes both
  bounds.
- `intervalSecs`: from the organization's `minIntervalSecs` to 86400 (default 60). `forSecs`: a
  multiple of the interval, 0 to 86400 (default 0).
- `noDataState`: `no_data` (default), `ok` or `firing`. `errorState`: `error` (default) or `keep`
  (hold the last state).
- `labels`: at most 20; names are letters, digits and `_`, starting with a letter or `_`, not
  `alertname` (every instance carries the rule's name under it) and not starting with `__`;
  values 1 to 256 characters.
- `reminderSecs`: 0 (off) or 60 to 604800 (default 14400, 4 hours).
- `contactPointIds`: contact points of the organization, at most `maxContactPointsPerRule`.
- `dashboardId` and `panelId`: the panel the rule was made from, for the badge and "Abfrage
  übernehmen". The dashboard must be in the organization and readable for the person saving;
  `panelId` needs `dashboardId`. Both are `null` in answers for people who may not read the
  dashboard.
- `state`: the most severe state of the instances (`firing`, `error`, `no_data`, `pending`,
  `ok`), `null` while there are none (not evaluated yet, or paused).

| Route | Permission | Answer |
|---|---|---|
| `GET /orgs/{orgId}/alerting/rules?datasourceId=&dashboardId=&panelId=&state=` | `alerts:read` | `200 Page<Rule>`, by name, all in one page; `dashboardId` also needs read access to the dashboard |
| `POST /orgs/{orgId}/alerting/rules` | `alerts:write` | `201 Rule` |
| `GET /orgs/{orgId}/alerting/rules/{ruleId}` | `alerts:read` | `200 Rule & { instances: Instance[] }` |
| `PUT /orgs/{orgId}/alerting/rules/{ruleId}` | `alerts:write` | `200 Rule`; the body is a whole rule with the `version` it is based on, `409 version_conflict` with the stored rule as `current` when it is older |
| `DELETE /orgs/{orgId}/alerting/rules/{ruleId}` | `alerts:write` | `204`; instances go with it, the history stays |
| `POST /orgs/{orgId}/alerting/rules/{ruleId}/pause` | `alerts:write` | `200 Rule`; its instances end without a notification |
| `POST /orgs/{orgId}/alerting/rules/{ruleId}/resume` | `alerts:write` | `200 Rule`; everything starts at OK |

The body of `POST` and `PUT` is the rule's editable fields: `name` (required), `description`,
`runbookUrl`, `datasourceId` (required), `query` (required), `rangeSecs`, `reduce` (required),
`condition` (required), `intervalSecs`, `forSecs`, `noDataState`, `errorState`, `labels`,
`reminderSecs`, `contactPointIds`, `dashboardId`, `panelId`, and for `PUT` `version`. Unknown
fields are refused. Pausing has its own routes.

`Instance`:

```json
{
  "fingerprint": "…", "labels": { "instance": "lager-api-1" }, "state": "firing",
  "stateSince": 0, "pendingSince": null, "pendingTarget": null, "lastEvaluatedAt": 0, "lastValue": 1.84,
  "lastError": null, "lastNotifiedAt": 0, "lastNotifiedState": "firing", "silencedBy": ["…"]
}
```

`fingerprint` is the SHA-256 of the rule id and the sorted labels; `silencedBy` names the active
silences that match the instance's labels with `alertname`. `pendingTarget` is the state the
instance waits for during the for-duration (`firing`, `no_data` or `error`). `lastError` is why the
last evaluation failed, as a code with parameters the UI translates, never the source's own
message (that goes to the server log); a rule's `lastError` has the same form:

```json
{ "code": "alerting.not_a_number", "params": { "field": "$.queue.depth", "found": "text" } }
```

Codes: `alerting.query_failed`, `alerting.timeout`, `alerting.source_not_enabled`,
`alerting.invalid_rule`, `alerting.wrong_shape` (`expected`, `got`), `alerting.not_a_number`
(`field`, `found`: `text`, `bool`, `array`, `object` or a database type), `alerting.nan` (`field`),
`alerting.too_many_series` (`limit`), `alerting.duplicate_series` (`labels`),
`alerting.truncated` (`limit`, `reason`: the source cut the result; only a count whose condition
is already decided at the count that arrived passes), `alerting.no_paths` (counting paths, but
the query returned none) and `alerting.label_too_long` (`what`: `count`, `name` or `value`;
`max`: a series carries more than 20 labels from the data, a label name longer than 64 or a value
longer than 256 characters; labels are never cut silently).

Series of a `frame` result: every `number`, `int64` and `decimal` field; in a long table the text
fields label each row's series, so a numeric id column is a series of its own, not a label (cast
it to text in the query to make it one). A field without labels of its own carries the label
`__field__` with its name.

**What the data says is for people who may read or query the source.** Without
`datasources:read` or `datasources:query` on the rule's source (a viewer, or an editor the source
is not shared with) a rule answers `dataHidden: true` (as `queryHidden`): its instances have
empty `labels`, `lastValue: null` and a `fingerprint` that is only an id within the answer
(`hidden-0`, ...), and `lastError` of the rule and its instances is `{ code }` without `params`
(except `alerting.label_too_long`, whose parameters are the server's limits). `silencedBy` then
lists only silences that match the rule's name (`alertname`), so it tells nothing about hidden
labels. States, counts and times stay. The same holds for panel badges, the history and the
silence preview.

### Preview

`POST /orgs/{orgId}/alerting/rules/preview` (`alerts:write`, and `datasources:query` on the
source for the caller): "Jetzt auswerten" in the editor. Evaluates a draft once **with the rights
of the person editing it**, not as the alerting identity, at the current time; nothing is stored,
the query cache is neither read nor filled, the source's opt-in is not needed (it is answered as
`datasourceOptedIn`). At most 20 previews per person and minute (`429 rate_limited`). The time
limit is the scheduled evaluation's.

Body: the rule's fields as for `POST /rules` (`datasourceId`, `query`, `reduce`, `condition`
required; `rangeSecs`, `intervalSecs`, `forSecs`, `noDataState`, `errorState`, `name`,
`description`, `runbookUrl`, `labels` optional), and `language` (`de`, default, or `en`) for the
message preview. Other fields of a draft are ignored. The same checks and reasons as saving
(`alerts.query_invalid`, `alerts.reduce_invalid`, `alerts.condition_invalid`, ...), except that
`intervalSecs` is 1 to 86400 and `forSecs` 0 to 86400 here.

```json
{
  "evaluatedAt": 0,
  "datasourceOptedIn": true,
  "shape": "frame",
  "queryError": null,
  "error": null,
  "truncated": null,
  "series": [
    { "labels": { "instance": "lager-api-1" }, "field": "p95", "value": 1.84, "conditionMet": true }
  ],
  "valueFields": ["p95"], "labelFields": ["instance"], "skippedDocuments": 0,
  "maxInstances": 100,
  "instances": [
    { "fingerprint": "…", "labels": { "instance": "lager-api-1" }, "state": "pending",
      "pendingTarget": "firing", "value": 1.84, "error": null }
  ],
  "message": { "subject": "[Feuert] Lager-API Latenz p95 · MouseWerk", "text": "…", "webhook": { "version": 1 } }
}
```

- `shape`: the shape the query answered in, `null` when it failed. `queryError` is the source's
  error as `POST /query` answers it (`{ code, message, reason?, params? }`), for this caller only;
  the scheduled evaluation never stores or sends it.
- `error`: why the evaluation ends in the state Error, as `{ code, params }` (the codes of
  "Rules"). `truncated`: the source cut the result (`alerting.truncated`); a count whose condition
  is decided at the count that arrived still has series and instances.
- `series`: the result after the reduce step, one per instance in result order, with the frame
  field it came from (empty for documents and graphs); `value` and `conditionMet` are `null` for a
  series without a value. `valueFields` and `labelFields` name the frame fields that became series
  and the text fields that labelled them; `skippedDocuments` counts documents without the field.
- `instances`: the state each instance would have now, starting from nothing: with a `forSecs`
  above 0 a met condition is `pending` with its `pendingTarget`, with 0 it is `firing` at once. No
  data and errors as the rule's `noDataState` and `errorState` say.
- `message`: the message (mail subject and text in `language`, and the webhook body) the
  instances that are or would become `firing`, `no_data` or `error` would send; `null` when none
  would. Without links, since the rule is not saved.

## Panel badges

`GET /orgs/{orgId}/alerting/panels?dashboardId=` (`alerts:read`, and read access to the
dashboard; `404 not_found` otherwise): the rules made from the dashboard's panels, per panel.

```json
{
  "items": [
    {
      "panelId": "p1", "state": "firing", "silenced": false,
      "rules": [
        {
          "id": "…", "name": "Lager-API Latenz p95", "state": "firing", "paused": false,
          "condition": { "op": "gt", "value": 1.5 },
          "instanceCounts": { "firing": 1, "pending": 1, "ok": 3 },
          "silenced": false,
          "instances": [
            { "labels": { "instance": "lager-api-1" }, "state": "firing", "stateSince": 0,
              "pendingTarget": null, "lastValue": 1.84, "silenced": false }
          ]
        }
      ]
    }
  ],
  "nextCursor": null
}
```

- Panels without rules are not listed. `state` is the most severe state of the panel's rules
  (`firing`, `error`, `no_data`, `pending`, `ok`), `null` while none has instances.
- A rule's `instances` are the ones that are not OK, most severe first, at most 10;
  `instanceCounts` counts all. `silenced` is true when an active silence matches every one of them
  (a panel's: every rule that is not OK is silenced), for the badge "Stumm".
- `condition` is the rule's condition, for the dashed line of the limit in the panel.
- `dataHidden: true` on a rule whose source the caller may neither read nor query: its instances
  have empty `labels` and `lastValue: null`.

## Evaluation

- A scheduler on the leading server evaluates every rule that is not paused, of organizations
  with alerting on (`alerting.enabled` and `alerting.org_enabled`), at its interval. Each rule has
  a fixed offset within its interval, from its id, so rules do not all run at the full minute.
  The evaluation's scheduled time (`tick`) fills the range (`tick - rangeSecs` to `tick`) and is
  the rule's `lastEvaluatedAt`; `lastDurationMs` is how long it took.
- At most `maxConcurrent` evaluations on the server, `maxConcurrentPerOrg` per organization and
  the source's limit (`Limits::datasource_concurrency`) run at once; organizations take turns. A
  rule that could not start before its next slot (still running, or no place free) skips that
  slot: it is not caught up, but counted in `skippedEvaluations` and the metric
  `kalzit_alert_evaluations_skipped_total`.
- Each evaluation runs as the alerting identity, which needs the source's opt-in every time;
  without it the result is `alerting.source_not_enabled`. It never reads or fills the query cache.
  Its time limit is the lower of the interval and `evaluationTimeoutSecs`
  (`alerting.timeout` beyond); the source's own limits apply as always. A failed query is
  `alerting.query_failed`; the source's text goes to the server log only.
- The instances, their transitions and the messages to send are stored in one transaction; the
  delivery starts after the commit. After a restart or a change of the leader the rules continue
  with their current slot; slots missed while no server ran are neither caught up nor counted.

## Delivery

- **One message per rule, evaluation and contact point**, with every instance whose state change
  is notified (or whose reminder is due) in that evaluation; resolves go in a second message of
  their own (`Kalzit-Event: resolved`). A notification is recorded per
  contact point under its deduplication key (fingerprint, contact point, state, start of the
  state, reminder number); a key that was recorded before is never sent again, after a restart
  or a change of the leader too.
- Messages are sent in the background by the leading server: right after the evaluation, again
  after 10 seconds and after 1 minute if that failed, 3 attempts at most. A webhook attempt has
  10 seconds; a mail attempt 10 seconds per recipient and at most 1 minute, and it stops at the
  first failure of the mail server or the connection (a refused recipient does not stop it). An
  attempt counts when it starts, so a message whose sender stopped mid-send is tried again (with
  the same `Kalzit-Delivery` id, once its claim of 5 minutes ran out) only while attempts are
  left, and then ends with the result `interrupted`. Receivers drop a `Kalzit-Delivery` they have
  seen. Every mail recipient reached is stored at once, so a later attempt does not mail them
  again. Claims are judged by the leading server's clock alone; a change of the leader during a
  send can repeat that one attempt, with the same id.
- Every attempt is a history entry of kind `delivery` per instance of the message (`event`,
  `attempt`, `result`) and the contact point's `lastDelivery`.
- **Fairness and limits.** Up to 16 messages are on their way at once; more are claimed
  whenever a slot is free (a send ended, an evaluation recorded a message, or a second passed),
  so new messages never wait for slow sends. Organizations take turns, oldest due first, with at
  most 4 messages of one organization and 2 to one contact point at once, so a slow receiver
  does not hold up others. After 3 attempts in a row to a contact point that did not reach it
  (`timeout`, `connection`, a mail server that cannot be reached), its waiting messages pause for
  5 minutes (their `result` reads `circuit_open`; no attempt is used up); an answer from the
  receiver releases them. An organization has at most 1000 messages waiting and a contact point
  at most 100: a further one is not queued and is in the history at once with
  `result: "queue_full"` (`attempt` 0). A message still waiting an hour after it was recorded is
  given up with `result: "expired"`. At most `alerting.max_messages_per_org_hour` messages of an
  organization go out per hour, counted by their first attempt: a further one is not sent and
  ends with `result: "rate_limited"`. Resolves go to a contact point in a message of their own
  (separate from firings, errors and reminders of the same evaluation); such a message is exempt
  from the waiting and hourly limits and does not expire, since each reported firing owes at most
  one resolve. Its attempts still end it. `queue_full` and
  `rate_limited` do not count as failed deliveries (metrics, `lastDelivery`).
- Silenced instances are evaluated and in the history but not sent. When a silence ends while an
  instance is still reported, it is sent once; a reported instance that resolved while silenced,
  its series gone included, sends its resolve once when no silence matches it any more.
- **Mail** goes through the mail server of Administration > Mail, one mail per recipient, as
  text and HTML in the contact point's language: subject `[Feuert] Regelname · Organisation`
  (`Behoben`, `Keine Daten`, `Fehler`, `Erinnerung`, `Test`; in English `Firing`, `Resolved`, `No
  data`, `Error`, `Reminder`, `Test`), per instance its labels, the reduce step with the reduced
  value, the condition and since when, then the rule's labels, description and the links. Only
  reduced values, never rows, documents or nodes of the result.
- **Webhook**: `POST` to the URL with `Content-Type: application/json`, the target check of data
  sources on every attempt (private networks allowed, metadata addresses and Kalzit itself never),
  no redirects followed, never more than `webhookMaxBytes`: instances are left out from the end
  until the body fits (`omittedInstances`). When one instance alone is still too large, the body
  carries `truncated: true` and, step by step until it fits, the instance's label values are
  shortened to 64 characters (the last one `…`), its labels and error are left out, the rule's
  description and labels are left out, the instance is left out, and at last only `version`,
  `event`, `deliveryId`, the organization's and the rule's `id`, `omittedInstances` and
  `evaluatedAt` remain. With an outbound proxy (Administration > Settings, Network)
  webhooks go through it, except to the hosts `network.no_proxy` names, like the plugin catalog:
  the URL's host is resolved and every address checked against the target rules before anything
  is sent; a plain `http://` request goes to the checked address, an `https://` one through
  `CONNECT` by name, because the receiver's certificate is checked against the name. The proxy
  resolves that name again, so a name whose answer changes in between (DNS rebinding) is stopped
  only by the proxy's own rules: **the proxy must refuse private, loopback, link-local and
  metadata addresses and the addresses of the Kalzit server itself** (docs/guide/administration.md,
  "Outbound proxy"). Without a proxy, or past it, the connection goes to the checked address. "Kalzit itself" is its public
  address and, on Kalzit's own listening ports, every address of the computer it runs on; a
  reverse proxy in front of Kalzit on other ports (80, 443) is unknown to Kalzit, so a webhook to
  it is refused only by the public address. When the proxy setting cannot be read, nothing is
  sent (`failed`). Headers:
  - `Kalzit-Signature: t=<Unix seconds>,v1=<hex>`: HMAC-SHA256 with the contact point's secret
    (as text) over `<t>.<raw body>`. For 24 hours after a rotation it carries a second `v1` with
    the previous secret: `t=…,v1=<current>,v1=<previous>`. Receivers accept the message when one
    `v1` matches, and refuse a `t` older than 5 minutes.
  - `Kalzit-Delivery`: the message's id, the same for every attempt.
  - `Kalzit-Event`: `firing`, `resolved`, `no_data`, `error`, `reminder` or `test`: the most
    important event of the message's instances, in this order.

  Body:

  ```json
  {
    "version": 1,
    "event": "firing",
    "deliveryId": "…",
    "organization": { "id": "…", "name": "MouseWerk" },
    "rule": {
      "id": "…", "name": "Lager-API Latenz p95", "description": "", "runbookUrl": null,
      "labels": { "team": "lager" },
      "reduce": { "shape": "frame", "function": "max" },
      "condition": { "op": "gt", "value": 1.5 }
    },
    "instances": [
      { "fingerprint": "…", "labels": { "instance": "lager-api-1" }, "event": "firing",
        "state": "firing", "stateSince": 0, "value": 1.84, "error": null, "reminder": 0, "reason": null }
    ],
    "links": { "rule": "https://kalzit.example/alerting/rules/…", "panel": "https://kalzit.example/dashboards/…?panel=p1",
               "silence": "https://kalzit.example/alerting/silences/new?ruleId=…" },
    "evaluatedAt": 0
  }
  ```

  `state` is `ok` for a resolve, with `stateSince` the start of the state that ended and `reason`
  `series_gone` or `replaced` when it ended that way; `error` is `{ code, params }`. `links` are
  `null` while the server has no public address (`server.public_url`).

  Test vector: secret `4f3c2b1a00112233445566778899aabbccddeeff00112233445566778899aabb`,
  `t = 1794319332`, body `{"version":1,"event":"test"}` gives
  `v1=54c9f745f2d47249ff0e616758f83cf4f52ae832a15b05f97f76203c3a35320d`.

## Contact points

`ContactPoint`:

```json
{
  "id": "…", "name": "Lager-Webhook", "kind": "webhook", "language": "de", "details": true,
  "host": "hooks.lager.mousewerk.test", "url": "https://hooks.lager.mousewerk.test/kalzit",
  "insecure": false, "previousSecretUntil": null,
  "lastDelivery": { "at": 0, "ok": false, "error": "503" },
  "rules": 2, "version": 1, "updatedAt": 0
}
```

- `kind` is `mail` (`recipients`, 1 to 20 addresses) or `webhook` (`url`); `language` is `de` or
  `en`. The kind cannot change.
- With `alerts:contacts`, `details` is `true` and the answer carries the full `recipients` and
  `url`. Without it (`alerts:read` only), `recipients` are shortened (`j…@mousewerk.test`), `url`
  and `previousSecretUntil` are left out, and `host` is all of the address.
- A mail contact point needs a mail server (Administration > Mail).
- A webhook URL is `http://` or `https://` (`insecure: true` for `http://`), without credentials
  or fragment; it passes the same target check as data sources (private networks allowed, Kalzit
  itself and metadata addresses never). Redirects are not followed when sending.
- A webhook gets a signing secret (32 random bytes as 64 hex digits), shown once in the answer to
  `POST` and to the rotation as `secret`. It is stored encrypted like data source secrets. After a
  rotation the previous secret still signs for 24 hours (`previousSecretUntil`): during that time
  `Kalzit-Signature` carries two `v1` values.

| Route | Permission | Answer |
|---|---|---|
| `GET /orgs/{orgId}/alerting/contact-points` | `alerts:read` | `200 Page<ContactPoint>`, by name |
| `POST /orgs/{orgId}/alerting/contact-points` | `alerts:contacts` | `201 ContactPoint & { secret?: string }` |
| `GET /orgs/{orgId}/alerting/contact-points/{contactPointId}` | `alerts:read` | `200 ContactPoint` |
| `PUT /orgs/{orgId}/alerting/contact-points/{contactPointId}` | `alerts:contacts` | `200 ContactPoint`; with `version`, `409 version_conflict` when older |
| `DELETE /orgs/{orgId}/alerting/contact-points/{contactPointId}` | `alerts:contacts` | `204`; `409 alerts.contact_point_in_use` while rules notify it |
| `POST /orgs/{orgId}/alerting/contact-points/{contactPointId}/secret` | `alerts:contacts` | `200 { secret, previousSecretUntil }` |

Body of `POST` and `PUT`: `{ name, kind, language?, recipients?, url?, version? }` (`version`
for `PUT`).

### Test send

`POST /orgs/{orgId}/alerting/contact-points/{contactPointId}/test` (`alerts:contacts`), no body:
sends an example message now, in the contact point's language, with `Kalzit-Event: test` (one
firing instance with made-up values under the rule name "Beispielregel" or "Example rule"). At
most 5 per minute and contact point and 20 per minute and organization (`429 rate_limited` with
`Retry-After`). The answer comes
when the attempt ended, within 10 seconds for a webhook:

```json
{ "ok": false, "result": "503", "durationMs": 182 }
```

`result` is `ok`, the status of the receiver's answer (`503`; a redirect is not followed and
answers its status, `302`), or why there was none: `timeout`, `blocked` (the target check refused
the address, or it is Kalzit itself), `connection`, `failed`, and for mail the mail reason
(`mail.not_configured`, `mail.connection_lost`, ...). Never content. The attempt becomes the
contact point's `lastDelivery`, a history entry of kind `delivery` with `event: "test"` and an
empty `ruleId`, and the audit entry `alert_contact_point.tested` (with `ok` and `result`, the
recipients shortened, the URL as its host).

## Silences

`Silence`:

```json
{
  "id": "…",
  "matchers": [{ "label": "team", "op": "=", "value": "lager" }, { "label": "instance", "op": "=~", "value": "lager-api-[23]" }],
  "startsAt": 0, "endsAt": 0, "comment": "Umzug Rechenzentrum", "status": "active",
  "createdBy": "…", "createdByName": "Lea Hoffmann", "createdAt": 0,
  "endedBy": null, "endedByName": null, "endedAt": null
}
```

- `matchers`: 1 to 20 label conditions, all must match. `op` is `=`, `!=` or `=~` (a regular
  expression over the whole value, linear time). Label names as for rules; `alertname` is the
  rule's name. A label an instance lacks counts as empty.
- `startsAt` (default now) to `endsAt`: after now, at most 90 days. `comment` is required (at
  most 500 characters).
- `status`: `pending` (starts later), `active`, or `expired` (ended early or past its end).
  Expired silences stay listed until the history retention ends.
- Silences hold back notifications only; instances are evaluated and in the history as always.
- At most `maxSilencesPerOrg` active and planned silences (`409 alerts.too_many_silences`).

| Route | Permission | Answer |
|---|---|---|
| `GET /orgs/{orgId}/alerting/silences?status=&limit=&cursor=` | `alerts:read` | `200 Page<Silence>`, latest end first |
| `POST /orgs/{orgId}/alerting/silences` | `alerts:write` | `201 Silence` |
| `POST /orgs/{orgId}/alerting/silences/preview` | `alerts:write` | `200 Page<{ ruleId, ruleName, fingerprint, labels, dataHidden, state }>`: the instances `{ matchers }` match now (at most 500); an instance whose rule's source the caller may not read is matched by `alertname` only and listed without labels (`dataHidden: true`) |
| `POST /orgs/{orgId}/alerting/silences/{silenceId}/expire` | `alerts:write` | `200 Silence`; `409 alerts.silence_ended` when it has ended |

## History

`GET /orgs/{orgId}/alerting/history?ruleId=&state=&label=name=value&kind=&from=&to=&limit=&cursor=`
(`alerts:read`): `200 Page<Entry>`, newest first, never older than the retention.

```json
{
  "id": "…", "ruleId": "…", "ruleName": "Lager-API Latenz p95", "fingerprint": "…",
  "labels": { "instance": "lager-api-2" }, "kind": "transition", "fromState": "ok",
  "toState": "pending", "pendingTarget": "firing", "value": 1.62, "error": null, "silenceId": null,
  "reason": null, "contactPointId": null, "event": null, "attempt": null, "result": null, "at": 0
}
```

`pendingTarget` is the state a change to `pending` waits for; `reason` is `series_gone` when an
instance went back to `ok` because its series was missing from three evaluations in a row, and
`replaced` when the instance without labels that stood for the whole rule (no series, or a
failed evaluation) ended because the result has series again. A reason given by a source for a cut
result that is not one of the built-in limits reads `other`.
`error` is, as `lastError` of an instance, an evaluation error as `{ code, params }`.
`dataHidden: true` marks an entry of a rule whose source the caller may neither read nor query
(for a deleted rule, the caller's organization-wide rights decide): `labels` is empty, `value`
`null`, `fingerprint` an id within the answer and `error` `{ code }` only. A `label` filter
(`name=value`, case-sensitive) searches only rules whose data the caller sees, in the query
itself.

An instance records at most 20 transitions per rolling hour one by one. Further transitions in
that hour (a flapping series) are counted in one entry per instance: `kind: "transition"`,
`reason: "flapping"`, `at` the first of them, `fromState` the state it left, `toState` the state
after the latest, and `attempt` the number of transitions it stands for. So a rule's history
grows by at most 21 transition entries per instance and hour.

`kind` is `transition` (a state change, `state` filters on `toState`) or `delivery` (a send to
`contactPointId`: `event` is `firing`, `resolved`, `no_data`, `error`, `reminder` or `test`,
`attempt` 1 to 3, `result` `ok` or why it failed, never content). Entries stay after their rule is
deleted. An hourly job on the leading server deletes entries past the retention, silences that
ended (early or at their end) before it, and webhook secrets whose 24 hours after a rotation are
over.

## Data sources

| Route | Permission | Answer |
|---|---|---|
| `GET /orgs/{orgId}/datasources/{datasourceId}/alerting` | `datasources:read` on the source | `200 { datasourceId, enabled, maxConcurrent, rules, firingRules }` |
| `PUT /orgs/{orgId}/datasources/{datasourceId}/alerting` | `datasources:write` on the source | `200` as `GET`; body `{ enabled, maxConcurrent? }` |
| `GET /orgs/{orgId}/alerting/datasources` | `alerts:read` | `200 Page<{ datasourceId, name, kind }>`: opted-in sources the caller may query, for the rule editor |

- The opt-in is off by default. `maxConcurrent` (1 to 100, or `null`) limits evaluations on the
  source at once; the evaluation uses the lower of it and the server's
  `alerting.max_concurrent_per_datasource` (`Limits::datasource_concurrency`).
- Turned off, the source's rules stay and go to the error state at their next evaluation
  ("source not opted in to alerting"), which is notified.

## Reasons

As in docs/api/datasources.md, "Reasons": `reason` and `params` next to `code`, translated by the
UI, with `message` as the English fallback. `request.*` and `target.*` reasons are the data
sources' own.

| Reason | Params | When |
|---|---|---|
| `alerts.datasource_not_opted_in` | | `409 conflict`: the rule's data source is not opted in to alerting |
| `alerts.datasource_forbidden` | | `403 forbidden`: changing, pausing, resuming or deleting a rule whose current data source the caller may not query |
| `alerts.too_many_silences` | `max` | `409 conflict`: the organization has as many active and planned silences as it may |
| `alerts.query_invalid` | | the query is missing, has too many steps or variables, or is larger than 64 KB |
| `alerts.reduce_invalid` | | the reduce step does not fit its shape |
| `alerts.reduce_path_invalid` | | a documents field path is not like `$.queue.depth` |
| `alerts.condition_invalid` | | a comparison without one finite value, or `outside`/`inside` without `low < high` |
| `alerts.interval_invalid` | `min`, `max` | `intervalSecs` outside the organization's bounds |
| `alerts.for_invalid` | `max` | `forSecs` not a multiple of the interval, or too long |
| `alerts.range_invalid` | | `rangeSecs` outside 1 second to 30 days |
| `alerts.state_option_invalid` | | `noDataState`, `errorState` or a `state` filter not one of its values |
| `alerts.reminder_invalid` | | `reminderSecs` neither 0 nor 60 to 604800 |
| `alerts.labels_invalid` | | too many labels, a bad or reserved name, or a bad value |
| `alerts.runbook_url_invalid` | | `runbookUrl` is not an http or https address without credentials |
| `alerts.panel_invalid` | | `panelId` too long, or without `dashboardId` |
| `alerts.too_many_contact_points` | `max` | more contact points than the organization allows per rule |
| `alerts.too_many_contact_points_in_org` | `max` | `409 conflict`: the organization has as many contact points as it may |
| `alerts.too_many_rules` | `max` | `409 conflict`: the organization has as many rules as it may |
| `alerts.version_required` | | `PUT` without `version` |
| `alerts.version_unexpected` | | `POST` with `version` |
| `alerts.kind_invalid` | | a contact point kind that is not `mail` or `webhook`, or a changed kind |
| `alerts.language_invalid` | | `language` is not `de` or `en` |
| `alerts.recipients_invalid` | `max` | a mail contact point without 1 to 20 valid addresses, or a webhook with recipients |
| `alerts.webhook_url_invalid` | | a webhook URL that is not http or https, has credentials or a fragment, or is missing |
| `alerts.webhook_url_kalzit` | | `422 datasource_target_blocked`: the URL points at this Kalzit server |
| `alerts.mail_not_configured` | | `409 conflict`: a mail contact point without a mail server |
| `alerts.contact_point_name_taken` | | `409 conflict`: another contact point has the name |
| `alerts.contact_point_in_use` | `rules` | `409 conflict`: deleting a contact point rules notify |
| `alerts.not_a_webhook` | | `409 conflict`: rotating the secret of a mail contact point |
| `alerts.matchers_invalid` | | a silence without 1 to 20 conditions, or with a bad label name or value |
| `alerts.matcher_regex_invalid` | | an `=~` value that is not a regular expression |
| `alerts.silence_window_invalid` | | a silence starting in the past, ending before it starts or now, or longer than 90 days |
| `alerts.comment_required` | | a silence without a comment |
| `alerts.silence_ended` | | `409 conflict`: ending a silence that has ended |
| `alerts.status_invalid` | | a silence `status` filter that is not `active`, `pending` or `expired` |
| `alerts.history_kind_invalid` | | a history `kind` filter that is not `transition` or `delivery` |
| `alerts.label_filter_invalid` | | a history `label` filter that is not `name=value` |
| `alerts.max_concurrent_invalid` | | a data source's `maxConcurrent` outside 1 to 100 |
