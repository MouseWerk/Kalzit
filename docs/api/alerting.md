# Alerting API

Alert rules, contact points, silences, history and the per data source opt-in of an
organization (design in docs/PLAN.md, section 13, screens on the boards
`docs/design/blueprint/Alerting.dc.html` and `AlertingRouting.dc.html`): the stored model and its
rights, the preview of the rule editor, the panel badges, the notification policies with their
groups and escalation (0.7.1), and how rules are evaluated and their notifications delivered by
mail, webhook, Slack and Microsoft Teams.

All routes are under `/api/orgs/{orgId}/...` and follow the API conventions (JSON in camelCase,
times in Unix milliseconds, durations in seconds, lists as `Page<T>` = `{ items, nextCursor }`,
errors as `{ error: { code, message, field?, reason?, params? } }`).

## Rules of the API

- Everything belongs to one organization. An id of another organization answers `404 not_found`,
  like an id that does not exist.
- Rights (all three can be chosen in custom roles too):

  | Permission | Built-in roles | Allows |
  |---|---|---|
  | `alerts:read` | viewer and up | rules with states and instances, silences, history, the status, contact points in their short form, the policy tree, its groups and the route check (read-only) |
  | `alerts:write` | editor and up | create, change, pause, resume and delete rules (and choose their routing); create and end silences |
  | `alerts:contacts` | admin and up | create, change and delete contact points, rotate webhook secrets, see their details; create, change, move and delete notification policies |

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
  `alert_contact_point.created|updated|deleted|tested|secret_rotated` (Slack and Teams too),
  `alert_policy.created|updated|moved|deleted` (with name, matchers and contact point ids),
  `alert_silence.created|expired`, `datasource.alerting_changed`, and
  `alerting.settings_changed` for every `alerting.*` setting. Entries never hold a secret or a
  webhook URL (only its host); recipients are shortened (`j…@mousewerk.test`). A rule's change of
  `routing` is in its `alert_rule.updated` entry (`routing`). Evaluations, deliveries and
  escalations are in the history, not in the audit log.

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
    "historyRetentionDays": 90, "maxPoliciesPerOrg": 100, "maxPolicyDepth": 5, "maxActiveGroupsPerOrg": 1000
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
| `alerting.max_policies_per_org` | 100 | may only lower it; the root counts |
| `alerting.max_policy_depth` | 5 | may only lower it; levels below the root |
| `alerting.max_active_groups_per_org` | 1000 | may only lower it; beyond it new instances go to a catch-all group of their policy |

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
  "routing": "policies",
  "contactPointIds": [],
  "routes": [
    { "policyId": "…", "path": [{ "id": "…", "name": "Standard" }, { "id": "…", "name": "Lager" }],
      "contactPointIds": ["…"], "delivers": true, "instances": 2 }
  ],
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
- `reminderSecs`: 0 (off) or 60 to 604800 (default 14400, 4 hours). Used by `direct` rules
  only; a rule routed through policies is reminded by its policy's `repeatIntervalSecs`, the field
  is kept but has no effect.
- `routing`: `policies` (through the organization's policy tree, see "Notification policies") or
  `direct` (to the rule's own contact points, exactly as in 0.7.0: one message per rule and
  evaluation, the rule's reminder, no grouping across rules, no escalation). Never both. Without
  `routing` in the body it is `direct` when `contactPointIds` are given and `policies` otherwise.
  Rules of 0.7.0 with contact points became `direct` on the update, the others `policies`.
  Changing it between `policies` and `direct`: the instances already sent through a group get their
  resolve there (the group's next message), and a `direct` rule then sends its reported instances
  once to its own contact points (a contact point that had an instance from the group does not get
  it twice).
- `contactPointIds`: contact points of the organization, at most `maxContactPointsPerRule`; only
  with `routing: "direct"` (`alerts.routing_invalid` otherwise).
- `routes` (`policies` only, `[]` for `direct`): the ways the rule's instances take now, as the
  route check answers them for each instance's labels (the rule's labels and `alertname`
  included; without instances the rule's labels alone): distinct by `policyId`, in tree order,
  with how many instances take each (`instances`, 0 without instances). `delivers` is false when
  the policy has no contact point (its own, inherited, or of an escalation step): "Wird nicht
  zugestellt". For the column "Weg" of the rule list.
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
`reminderSecs`, `routing`, `contactPointIds`, `dashboardId`, `panelId`, and for `PUT` `version`.
Unknown fields are refused. Pausing has its own routes; a paused rule leaves its groups without a
notification (as its instances end).

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
is already decided at the count that arrived passes) and `alerting.no_paths` (counting paths, but
the query returned none).

Series of a `frame` result: every `number`, `int64` and `decimal` field; in a long table the text
fields label each row's series, so a numeric id column is a series of its own, not a label (cast
it to text in the query to make it one). A field without labels of its own carries the label
`__field__` with its name.

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

- **Direct rules: one message per rule, evaluation and contact point**, with every instance whose
  state change is notified (or whose reminder is due) in that evaluation. Rules routed through
  policies send per group instead (see "Groups, repetition and escalation"); everything below on
  attempts, channels and headers applies to both. A notification is recorded per
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
  no redirects followed, at most `webhookMaxBytes`: instances are left out from the end until the
  body fits (`omittedInstances`). With an outbound proxy (Administration > Settings, Network)
  webhooks go through it, except to the hosts `network.no_proxy` names, like the plugin catalog:
  the URL's host is resolved and every address checked against the target rules before anything
  is sent; a plain `http://` request goes to the checked address, an `https://` one through
  `CONNECT` by name, so the proxy must refuse private and metadata addresses itself. Without a
  proxy, or past it, the connection goes to the checked address. "Kalzit itself" is its public
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
    important event of the message's instances, in this order; `escalation` for an escalation
    step of a group.

  Body of a direct rule's message (`version: 1`, unchanged since 0.7.0):

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

  Body of a group's message (rules routed through policies, `version: 2`): one message can hold
  instances of several rules, so the group comes first and every instance carries its rule.

  ```json
  {
    "version": 2,
    "event": "firing",
    "deliveryId": "…",
    "organization": { "id": "…", "name": "MouseWerk" },
    "group": {
      "id": "…", "key": "…", "labels": { "alertname": "Lager-API Latenz p95", "team": "lager" },
      "catchAll": false,
      "policy": { "id": "…", "name": "Lager kritisch",
                  "path": [{ "id": "…", "name": "Standard" }, { "id": "…", "name": "Lager kritisch" }] },
      "kind": "change", "stage": "0", "level": 0, "repeat": 0,
      "firingSince": 0
    },
    "alerts": [
      { "fingerprint": "…", "labels": { "instance": "lager-api-3" }, "event": "firing", "state": "firing",
        "stateSince": 0, "value": 1.62, "error": null, "reminder": 0, "reason": null, "changed": true,
        "rule": { "id": "…", "name": "Lager-API Latenz p95", "description": "", "runbookUrl": null,
                  "labels": { "team": "lager" }, "reduce": { "shape": "frame", "function": "max" },
                  "condition": { "op": "gt", "value": 1.5 } },
        "links": { "rule": "https://kalzit.example/alerting/rules/…", "panel": null, "silence": "…" } }
    ],
    "links": { "silence": "https://kalzit.example/alerting/silences/new?matchers=…", "alerts": "https://kalzit.example/alerting/rules?…" },
    "sentAt": 0
  }
  ```

  `group.kind` is `change` (stage `0`), `repeat` (stage `1`, `2`, … with `repeat` its number,
  every instance an `event: "reminder"`) or `escalation` (stage `e1` to `e3`, `level` the step).
  `changed` is true for the instances that changed since the group's last message (newly
  reported, resolved, or another reported state) and false for the ones that keep firing;
  `reason` is `rerouted` for a resolve because the instance's way changed. Instances past the
  limit or `webhookMaxBytes` are left out from the end (`omittedAlerts`). `links.silence` opens
  "Stummschalten" with the group's labels as matchers, `links.alerts` the rule list.

- **Slack** and **Microsoft Teams**: a `POST` of JSON to the channel's incoming webhook URL (the
  contact point's secret), through the same way out as webhooks: the target check on every
  attempt, the outbound proxy, no redirects, 10 seconds per attempt, 3 attempts. An answer `429`
  with `Retry-After` of at most 60 seconds moves the next attempt that far (never sooner than its
  usual pause); the attempt's `result` is `429`. Slack gets Blocks (a header with the state, the
  group or rule and the organization; per instance a section with rule, labels, reduced value and
  condition; buttons "Regel öffnen", "Panel öffnen", "Stummschalten" while the server has a public
  address), Teams an Adaptive Card with the same content. At most 10 instances are written out,
  then "und 12 weitere" with a link; Slack messages stay under 50 blocks and Teams cards under 28
  KB. No mentions of people or `@channel`, no buttons that act in Kalzit. Texts in the contact
  point's language. Only reduced values.

  Test vector: secret `4f3c2b1a00112233445566778899aabbccddeeff00112233445566778899aabb`,
  `t = 1794319332`, body `{"version":1,"event":"test"}` gives
  `v1=54c9f745f2d47249ff0e616758f83cf4f52ae832a15b05f97f76203c3a35320d`.

## Notification policies

Since 0.7.1 every organization has a tree of notification policies (docs/PLAN.md, section 13,
"0.7.1"). Rules with `routing: "policies"` hand their instances to the tree; the labels decide
which contact points they go to, how they are grouped into messages, how often they are repeated
and when they escalate.

`Policy`:

```json
{
  "id": "…", "parentId": "…", "position": 0, "depth": 1, "isRoot": false,
  "name": "Lager kritisch",
  "matchers": [{ "label": "severity", "op": "=", "value": "kritisch" },
               { "label": "instance", "op": "!~", "value": "lager-api-test.*" }],
  "groupBy": ["alertname", "team"],
  "groupWaitSecs": 0, "groupIntervalSecs": 120, "repeatIntervalSecs": null,
  "continue": false,
  "contactPointIds": ["…"],
  "escalations": [{ "level": 1, "waitSecs": 900, "contactPointIds": ["…"] },
                  { "level": 2, "waitSecs": 2700, "contactPointIds": ["…"] }],
  "effective": {
    "groupBy": ["alertname", "team"], "groupWaitSecs": 0, "groupIntervalSecs": 120,
    "repeatIntervalSecs": 3600, "contactPointIds": ["…"], "contactPointsFrom": "…",
    "delivers": true
  },
  "activeGroups": 2,
  "version": 3,
  "createdBy": "…", "createdAt": 0, "updatedBy": "…", "updatedByName": "Lea Hoffmann", "updatedAt": 0
}
```

- The **root** is named "Standard" (`isRoot: true`, `parentId: null`, its id is the
  organization's id), exists exactly once per organization and can neither be deleted nor moved.
  It has no matchers (it matches everything), no `continue`, and sets every time and `groupBy`
  itself. An organization without one gets it with its first policy request; the update to 0.7.1
  made it in every organization without contact points, with `groupBy: ["alertname"]`, 30
  seconds, 5 minutes and 4 hours.
- `matchers`: 0 to 10 label conditions, all must match. `op` is `=`, `!=`, `=~` or `!~` (regular
  expressions over the whole value, linear time); a label the instance lacks counts as empty. The
  labels are the instance's (its series), the rule's and the rule's name under `alertname`.
- `groupBy`: `null` inherits; `[]` puts every instance of the policy in one group; `["..."]`
  ("Jede Instanz einzeln") makes one group per instance; otherwise 1 to 10 label names
  (`alertname` allowed).
- `groupWaitSecs` (0 to 3600), `groupIntervalSecs` (the organization's `minIntervalSecs`, at least
  30, to 86400), `repeatIntervalSecs` (0 = off, or the effective group interval to 604800): `null`
  inherits. Defaults of the root: 30, 300, 14400. A repeat interval inherited from above that is
  shorter than the effective group interval acts as the group interval.
- `continue`: when this policy matches, its following siblings are checked too, so an instance can
  take several ways.
- `contactPointIds`: 0 to 5 contact points of the organization. A policy without its own inherits
  its parent's (`effective.contactPointIds`; `contactPointsFrom` names the policy they come from,
  `null` when none has any).
- `escalations`: 0 to 3 steps, `level` 1, 2, 3 in order, `waitSecs` 300 to 86400 and each longer
  than the one before, 1 to 5 contact points each. Not inherited.
- `effective`: what applies to instances that end at this policy, inheritance resolved;
  `delivers` is false when neither the effective contact points nor an escalation step has a
  contact point ("Wird nicht zugestellt").
- `activeGroups`: groups of this policy that have instances now.
- `depth`: 0 for the root; at most `maxPolicyDepth` below it (`alerts.policy_depth`). At most
  `maxPoliciesPerOrg` policies (`409 alerts.too_many_policies`).

**Matching**: each instance goes through the tree on its own, from the root. At every policy the
children are checked in their order; the first that matches takes the instance and it continues
in that child's children. A matching child with `continue` lets the following siblings be checked
as well. When no child matches, the instance stays at the policy it is at. Every way ends at the
deepest matching policy, which gives the contact points, grouping, times and escalation. An
instance that reaches the same contact point on two ways gets there once (see "Groups, repetition
and escalation"). The way is decided anew at every evaluation; a changed tree applies from the
next one.

| Route | Permission | Answer |
|---|---|---|
| `GET /orgs/{orgId}/alerting/policies` | `alerts:read` | `200 Page<Policy>`: the whole tree, depth first in sibling order, in one page |
| `POST /orgs/{orgId}/alerting/policies` | `alerts:contacts` | `201 Policy`, appended as the last child of `parentId` |
| `GET /orgs/{orgId}/alerting/policies/{policyId}` | `alerts:read` | `200 Policy` |
| `PUT /orgs/{orgId}/alerting/policies/{policyId}` | `alerts:contacts` | `200 Policy`; the whole policy with the `version` it is based on, `409 version_conflict` with the stored policy as `current` when it is older |
| `DELETE /orgs/{orgId}/alerting/policies/{policyId}` | `alerts:contacts` | `204`; `409 alerts.policy_has_children` while it has children, `409 alerts.policy_root` for the root. Its groups go without a message; their instances take their new way at the next evaluation |
| `POST /orgs/{orgId}/alerting/policies/{policyId}/move` | `alerts:contacts` | `200 Page<Policy>` (the whole tree): body `{ parentId, position }`, at once; undo is another move |
| `POST /orgs/{orgId}/alerting/policies/route` | `alerts:read` | `200 { items }`: the route check, see below |
| `GET /orgs/{orgId}/alerting/groups?policyId=` | `alerts:read` | `200 Page<Group>`: the active groups (of one policy, or all), in one page; see below |

Body of `POST` and `PUT`: `{ parentId, name, matchers, groupBy, groupWaitSecs, groupIntervalSecs,
repeatIntervalSecs, continue, contactPointIds, escalations, version }` (`parentId` only for
`POST`, required there; `version` only for `PUT`; the other fields default to empty or `null`,
`continue` to `false`). A `PUT` never moves a policy. Unknown fields are refused.

**Move**: `parentId` is the new parent (the root or any policy that is not the moved one or below
it, `alerts.policy_move_invalid` otherwise), `position` the place among its new siblings (0 first;
larger than their number puts it last). The siblings close up behind it. The depth limit applies
to the moved subtree (`alerts.policy_depth`). Audited as `alert_policy.moved` with old and new
parent and position.

### Route check

`POST /orgs/{orgId}/alerting/policies/route` (`alerts:read`): "Weg prüfen" on the policies page
and in the rule editor. Body: either `{ "labels": [{ "team": "lager", "alertname": "…" }, …] }`
(1 to 100 label sets, used as they are, so the editor adds the rule's labels and `alertname`) or
`{ "ruleId": "…" }` (the stored rule's instances with its labels and `alertname`; without
instances the rule's labels alone).

```json
{
  "items": [
    {
      "labels": { "alertname": "Lager-API Latenz p95", "team": "lager", "instance": "lager-api-1" },
      "fingerprint": null,
      "routes": [
        {
          "policyId": "…",
          "path": [{ "id": "…", "name": "Standard" }, { "id": "…", "name": "Lager" }, { "id": "…", "name": "Lager kritisch" }],
          "contactPointIds": ["…"],
          "groupBy": ["alertname", "team"],
          "groupLabels": { "alertname": "Lager-API Latenz p95", "team": "lager" },
          "groupWaitSecs": 0, "groupIntervalSecs": 120, "repeatIntervalSecs": 3600,
          "escalations": [{ "level": 1, "waitSecs": 900, "contactPointIds": ["…"] }],
          "delivers": true
        }
      ]
    }
  ]
}
```

`fingerprint` is the instance's with `ruleId`, `null` for label sets. Contact points are ids; the
list of contact points (`alerts:read`) gives their names and kinds in the short form. With `ruleId`
the rule may be `direct`: the answer is where it would go through the policies ("Auf Richtlinien
umstellen").

### Groups

`Group`:

```json
{
  "id": "…", "policyId": "…", "labels": { "alertname": "Lager-API Latenz p95", "team": "lager" },
  "catchAll": false,
  "state": "firing",
  "instances": 3, "firingInstances": 3, "silencedInstances": 0,
  "createdAt": 0, "firingSince": 0, "lastSentAt": 0, "nextSendAt": 0, "nextRepeatAt": 0,
  "repeats": 0, "escalationLevel": 1, "escalationPaused": false, "nextEscalationAt": 0
}
```

- A group is the instances of one policy with the same values of its `groupBy` labels, across
  rules (`labels` are those values; for `["..."]` all of the instance's labels). Groups exist
  while they have instances; a group whose instances all resolved sends its resolve and is gone.
- `state`: `waiting` until the first message went out, then the most severe state of its
  instances (`firing`, `error`, `no_data`), `ok` while only resolves wait to be sent.
- `catchAll`: the organization had `maxActiveGroupsPerOrg` groups, so new instances of this policy
  were put in one group of the policy without labels (a note on the page).
- `firingSince`: the start of the group's firing for its escalation (the first firing instance
  that is not silenced), moved on by the time a silence held it; `null` while nothing fires.
- `nextSendAt`: the earliest time the next message with changes may go (first the group wait,
  then the group interval after each message); `nextRepeatAt` when the group is repeated if
  nothing changes (`null` while off or nothing was sent yet); `repeats` counts the repetitions
  since the first message; `escalationLevel` the step reached (0 to 3), `nextEscalationAt` when
  the next step is due (`null` without one, or while `escalationPaused`: every firing instance is
  silenced).

## Groups, repetition and escalation

- An evaluation of a `policies` rule stores, in the same transaction as its instances and
  transitions, each reported instance (firing, no data, error) in the group of every way it takes
  that delivers, and the resolve of an instance that left a group (resolved, its series gone, or
  its way changed). A new group's first message waits `groupWaitSecs`.
- A job on the leading server looks at the groups every 5 seconds. A group with changes (newly
  reported, resolved, a change between firing, no data and error) sends once its `nextSendAt` has
  come: one message per contact point with the changes first and the instances that keep firing
  after them (at most 20 written out in mail and webhook, 10 in Slack and Teams, then "and 12
  more"); then `nextSendAt` is the group interval later. Without changes, a group that still
  reports and was sent before is repeated after `repeatIntervalSecs` (0: never), with every
  instance as a reminder.
- **Escalation**: step n is due when the group has fired for its `waitSecs`, counted from
  `firingSince`. It sends the whole group once to the step's contact points ("[Eskaliert, Stufe
  2]"); from then on they also get the group's changes, repetitions and its resolve, until the
  group is resolved. A step that is due while nothing in the group fires is dropped; when the group
  fires again later, counting starts anew. While every firing instance is silenced the count
  holds; it goes on from where it was when the silence ends.
- **Silences** act per instance when the group sends: silenced instances are left out (and keep
  their change for later), a group whose instances are all silenced sends nothing. When the
  silence ends, the change goes with the group's next message.
- **Deduplication**: every instance is recorded per contact point under (fingerprint, contact
  point, state, start of the state, stage); the stage is `0` for the change itself, the number of
  the repetition (counted from the group's first message) and `e1` to `e3` for the escalation
  steps. A key recorded before is never sent again, so an instance that reaches one contact point
  on two ways goes there once, with the first group that sends. The keys of 0.7.0 keep their form.
- The groups, their waiting changes and their times are in the database: after a restart or a
  change of the leader the new leader continues with them, without a message twice or lost.

## Contact points

`ContactPoint`:

```json
{
  "id": "…", "name": "Lager-Webhook", "kind": "webhook", "language": "de", "details": true,
  "host": "hooks.lager.mousewerk.test", "url": "https://hooks.lager.mousewerk.test/kalzit",
  "insecure": false, "previousSecretUntil": null,
  "lastDelivery": { "at": 0, "ok": false, "error": "503" },
  "rules": 2, "policies": 1, "version": 1, "updatedAt": 0
}
```

A Slack contact point: `{ "kind": "slack", "host": "hooks.slack.com", "urlEnd": "9Qx2", "insecure":
false, … }` (no `url`, for anyone).

- `kind` is `mail` (`recipients`, 1 to 20 addresses), `webhook` (`url`), `slack` or `teams`
  (`url`: the channel's incoming webhook URL); `language` is `de` or `en`. The kind cannot change.
- `rules` counts the rules that notify it directly, `policies` the policies (and escalation
  steps) that use it.
- **Slack and Teams**: the URL is the secret. It is `https://` only, passes the target check, is
  stored encrypted like other secrets, and is never answered again, not even with
  `alerts:contacts`: every view has `host` and `urlEnd` (its last four characters, `…9Qx2`). A
  `PUT` without `url` keeps the stored one, with `url` replaces it. `insecure` is always false.
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
| `DELETE /orgs/{orgId}/alerting/contact-points/{contactPointId}` | `alerts:contacts` | `204`; `409 alerts.contact_point_in_use` while rules notify it or policies use it (params `rules`, the count, and `policies`, the names of the policies, comma separated) |
| `POST /orgs/{orgId}/alerting/contact-points/{contactPointId}/secret` | `alerts:contacts` | `200 { secret, previousSecretUntil }` |

Body of `POST` and `PUT`: `{ name, kind, language?, recipients?, url?, version? }` (`version`
for `PUT`; for `slack` and `teams` `url` is required by `POST` and optional for `PUT`).

### Test send

`POST /orgs/{orgId}/alerting/contact-points/{contactPointId}/test` (`alerts:contacts`), no body:
sends an example message now, in the contact point's language, with `Kalzit-Event: test` (one
firing instance with made-up values under the rule name "Beispielregel" or "Example rule"). At
most 5 per minute and contact point (`429 rate_limited` with `Retry-After`). The answer comes
when the attempt ended, within 10 seconds for a webhook:

```json
{ "ok": false, "result": "429", "durationMs": 182, "retryAfterSecs": 12 }
```

`retryAfterSecs` is the receiver's `Retry-After` of a `429` (Slack and Teams), else `null`.

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

- `matchers`: 1 to 20 label conditions, all must match. `op` is `=`, `!=`, `=~` or `!~` (a
  regular expression over the whole value, linear time). Label names as for rules; `alertname` is
  the rule's name. A label an instance lacks counts as empty. The labels are those policies see:
  the instance's, the rule's and `alertname`.
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
  "reason": null, "contactPointId": null, "event": null, "attempt": null, "result": null,
  "policyId": null, "groupId": null, "stage": null, "at": 0
}
```

A delivery of a group's message has `policyId`, `groupId` and `stage` (`0`, the repetition's
number, `e1` to `e3`); its `event` can also be `escalation`. Deliveries of direct rules and
transitions have them `null`.

`pendingTarget` is the state a change to `pending` waits for; `reason` is `series_gone` when an
instance went back to `ok` because its series was missing from three evaluations in a row, and
`replaced` when the instance without labels that stood for the whole rule (no series, or a
failed evaluation) ended because the result has series again. A reason given by a source for a cut
result that is not one of the built-in limits reads `other`.
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
| `alerts.kind_invalid` | | a contact point kind that is not `mail`, `webhook`, `slack` or `teams`, or a changed kind |
| `alerts.chat_url_invalid` | | a Slack or Teams URL that is not `https://`, has credentials or a fragment, or is missing on `POST` |
| `alerts.routing_invalid` | | `routing` is not `policies` or `direct`, or `contactPointIds` with `policies` |
| `alerts.policy_name_invalid` | | a policy without a name, or the root renamed |
| `alerts.policy_matchers_invalid` | `max` | more than 10 matchers, a bad label name or value, or matchers on the root |
| `alerts.group_by_invalid` | `max` | more than 10 labels, a bad label name, `...` with other labels, or `null` on the root |
| `alerts.policy_timing_invalid` | | a group wait, group interval or repeat interval outside its bounds, or `null` on the root |
| `alerts.policy_contact_points_invalid` | `max` | more than 5 contact points on a policy or a step |
| `alerts.escalations_invalid` | `max` | more than 3 steps, levels not 1, 2, 3 in order, a wait outside 300 to 86400 seconds or not longer than the step before, or a step without 1 to 5 contact points |
| `alerts.policy_continue_invalid` | | `continue` on the root |
| `alerts.too_many_policies` | `max` | `409 conflict`: the organization has as many policies as it may |
| `alerts.policy_depth` | `max` | `409 conflict`: the policy (or the moved subtree) would be deeper than `maxPolicyDepth` |
| `alerts.policy_root` | | `409 conflict`: deleting or moving the root |
| `alerts.policy_has_children` | | `409 conflict`: deleting a policy that has children |
| `alerts.policy_move_invalid` | | moving a policy below itself |
| `alerts.route_labels_invalid` | | a route check without 1 to 100 label sets or a `ruleId`, or with both |
| `alerts.language_invalid` | | `language` is not `de` or `en` |
| `alerts.recipients_invalid` | `max` | a mail contact point without 1 to 20 valid addresses, or a webhook with recipients |
| `alerts.webhook_url_invalid` | | a webhook URL that is not http or https, has credentials or a fragment, or is missing |
| `alerts.webhook_url_kalzit` | | `422 datasource_target_blocked`: the URL points at this Kalzit server |
| `alerts.mail_not_configured` | | `409 conflict`: a mail contact point without a mail server |
| `alerts.contact_point_name_taken` | | `409 conflict`: another contact point has the name |
| `alerts.contact_point_in_use` | `rules`, `policies` | `409 conflict`: deleting a contact point rules notify or policies use |
| `alerts.not_a_webhook` | | `409 conflict`: rotating the secret of a mail contact point |
| `alerts.matchers_invalid` | | a silence without 1 to 20 conditions, or with a bad label name or value |
| `alerts.matcher_regex_invalid` | | an `=~` or `!~` value that is not a regular expression |
| `alerts.silence_window_invalid` | | a silence starting in the past, ending before it starts or now, or longer than 90 days |
| `alerts.comment_required` | | a silence without a comment |
| `alerts.silence_ended` | | `409 conflict`: ending a silence that has ended |
| `alerts.status_invalid` | | a silence `status` filter that is not `active`, `pending` or `expired` |
| `alerts.history_kind_invalid` | | a history `kind` filter that is not `transition` or `delivery` |
| `alerts.label_filter_invalid` | | a history `label` filter that is not `name=value` |
| `alerts.max_concurrent_invalid` | | a data source's `maxConcurrent` outside 1 to 100 |
