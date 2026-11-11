## Improved

- New main navigation entry "Alerting" between "Ask" and the data sources, with the number of
  firing rules. It shows for everyone with `alerts:read` while alerting is on.
- Alert rules list with state, shape, condition and interval, filters by state, text and shape,
  and each rule's instances with their values; pause, resume, duplicate and delete from the row
  menu.
- Rule editor in five steps (query, reduce, condition, evaluation, labels and notification): an
  explicit reduce step per result shape (series, documents, graph), "Evaluate now" with the
  state each instance would have, and a preview of the message. A rule made from a panel keeps a
  copy of its query and offers "Take over the query" when the panel changes. Saving over a newer
  version shows that version instead of overwriting it.
- Contact points: organization admins add mail and webhook contact points, see a webhook's
  signing secret once, renew it and send a test; everyone else sees them read-only.
- Silences with conditions, a duration and a required comment, the instances they affect while
  typing, and ending them early; also straight from an instance.
- History of state changes and deliveries with a timeline per instance and filters by range,
  rule, state and label.
- Panels show an alert badge with their rules; time series draw the rule's threshold dashed and
  the time it fired as a quiet area, both can be hidden in the panel menu. The panel menu offers
  "Create alert rule".
- Data sources have an Alerting section to opt in and to limit evaluations at once.

## Checklist for Windows (manual)

- Opt a data source in to alerting, add a webhook contact point (the secret shows once), create
  a rule from a panel, run "Evaluate now" and save it; the rule appears under Alerting and the
  panel shows its badge.
- As an editor, Alerting > Contact points is read-only; add and end a silence.
