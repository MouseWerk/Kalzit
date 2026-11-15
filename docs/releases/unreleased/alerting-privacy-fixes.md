## Fixed

- Alerting groups: rules of different data sources no longer share a group, even with the same
  labels. A group with alerts from a data source you may not read or query is hidden as a whole
  and shows only its state and counts, without when it started, began firing or last notified;
  your own groups stay visible and are no longer affected by such alerts. Open groups move to the
  new grouping when the server starts and keep their repetitions, escalation steps and resolves.
- Alerting history: a group's notifications for alerts from a data source you may not read or
  query no longer appear, and a silence that matched such an alert is no longer named. Who sees an
  entry now follows the data source its rule had when the entry was written; moving a rule to
  another data source ends its open alerts without a notification.
- Contact points: when a contact point last delivered is shown only to people who manage contact
  points.
