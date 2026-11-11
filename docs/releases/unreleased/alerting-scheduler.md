## Improved

- Alert rules are evaluated on their interval: each rule's query runs as the organization's
  alerting identity on opted-in sources, its reduced values are checked against the condition,
  and states, history and notifications follow. Evaluations are spread within their interval and
  limited per server, organization and data source; an evaluation that cannot start in time is
  skipped and counted on the rule instead of piling up.
- Notifications go out by mail in the contact point's language (German or English) and by
  webhook as signed JSON (`Kalzit-Signature`, `Kalzit-Delivery`, `Kalzit-Event`), with up to three
  attempts. They carry reduced values only, never rows, documents or nodes, and are never sent
  twice, also not after a restart.
- A resolve that a silence held back is sent once the silence ends, also when the series has
  disappeared in the meantime.
- Contact points can send a test message, and the rule editor can evaluate a draft rule once with
  your own rights before you save it.
- Dashboards can show the alert rules of each panel with their state.
- `/metrics` counts alert evaluations, skipped evaluations and delivery attempts.

## Checklist for Windows (manual)

- With a webhook contact point pointing at a local receiver and a rule on an opted-in source,
  the receiver gets a signed message when the rule fires and one when it resolves, and the test
  send answers with the receiver's status.
- A mail contact point in German and one in English each receive a mail in their language.
