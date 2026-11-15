## Fixed

- Alerting history: when a group's notification also contained an alert from a data source you
  may not read or query, none of its entries show the group, policy, stage or contact point any
  more, and reminders and escalations in it read "Notification". A silence that matched such an
  alert is no longer named.
- Alerting groups: a group with alerts from a data source you may not read or query now shows
  only its state and counts, without when it started, began firing or last notified.
