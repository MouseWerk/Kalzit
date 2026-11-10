# Alerting API

Alert rules, contact points, silences, history and the per data source opt-in of an
organization (design in docs/PLAN.md, section 13, screens on the board
`docs/design/blueprint/Alerting.dc.html`). This part is the stored model and its rights; the
scheduled evaluation and the delivery of notifications build on it.

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
message (that goes to the server log):

```json
{ "code": "alerting.not_a_number", "params": { "field": "$.queue.depth", "found": "text" } }
```

Codes: `alerting.query_failed`, `alerting.timeout`, `alerting.source_not_enabled`,
`alerting.invalid_rule`, `alerting.wrong_shape` (`expected`, `got`), `alerting.not_a_number`
(`field`, `found`: `text`, `bool`, `array`, `object` or a database type), `alerting.nan` (`field`),
`alerting.too_many_series` (`limit`), `alerting.duplicate_series` (`labels`),
`alerting.truncated` (`limit`, `reason`: the source cut the result; only a count whose condition
is already decided at the count that arrived passes) and `alerting.no_paths` (counting paths, but
the query returned none).

Series of a `frame` result: every `number`, `int64` and `decimal` field; in a long table the text
fields label each row's series, so a numeric id column is a series of its own, not a label (cast
it to text in the query to make it one). A field without labels of its own carries the label
`__field__` with its name.

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
for `PUT`). The test send (`POST .../contact-points/{contactPointId}/test`, `alerts:contacts`, at
most 5 per minute and contact point) comes with the delivery.

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
| `POST /orgs/{orgId}/alerting/silences/preview` | `alerts:write` | `200 Page<{ ruleId, ruleName, fingerprint, labels, state }>`: the instances `{ matchers }` match now (at most 500) |
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
instance went back to `ok` because its series was missing from three evaluations in a row.
`error` is, as `lastError` of an instance, an evaluation error as `{ code, params }`.

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
