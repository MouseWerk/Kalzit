## Fixed

- Alerting history: notifications of a group no longer show entries for alerts from a data source
  you may not read or query, so they no longer reveal which group, policy or escalation such an
  alert was in. Your own alerts in the same notification are shown as before. A silence that
  matched such an alert is no longer named.
- Alerting groups: a group with alerts from a data source you may not read or query now shows
  only its state and counts, without when it started, began firing or last notified.
