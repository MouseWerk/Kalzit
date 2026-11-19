## Fixed

- Alerting: two changes of the same rule at the same time no longer skip ending its alerts when
  it moves to another data source, and pausing, resuming, deleting or changing a rule checks the
  data source it has at that moment.
- Alerting: Slack notifications with a long dotted title no longer exceed Slack's header limit.
- Alerting: alert groups from 0.7.2 that are given their data source no longer risk a database
  deadlock on PostgreSQL, and their waiting notifications keep the data source of their alerts.
- Alerting: the cache of notification policies is limited by the memory its patterns may take.
- Releases: a patch release from a release branch is only built when that branch is protected
  like main.
