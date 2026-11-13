## Improved

- Alerting: notification policies decide by the labels of an instance where it goes. Each organization has a tree starting at "Standard"; a policy matches labels with `=`, `!=`, `=~` and `!~`, the first matching policy takes the instance, and "weiter prüfen" lets it take further ways.
- Alerting: instances of several rules with the same labels arrive together in one message per group, after a group wait (30 seconds by default), at most once per group interval (5 minutes), and as a repetition while they keep firing (every 4 hours, or off).
- Alerting: up to three escalation steps per policy send a group that keeps firing to further contact points, for example after 15 minutes to the on-call team. A silence holds the escalation.
- Alerting: Slack and Microsoft Teams as contact points, with formatted messages in German or English. The incoming webhook URL is stored encrypted and shown only by host and its last four characters.
- Alerting: a rule goes either through the policies or directly to its contact points. Rules with contact points from 0.7.0 stay direct, so the update changes no delivery.
- Alerting: the route check shows for any labels, or for a rule's instances, which policies they reach, with contact points and times.
- Alerting: silences can also use `!~`; for rules routed through policies they also see the rule's labels, direct rules match as before.
- Webhooks of rules routed through policies send `version: 2` with the group and every instance's rule; direct rules keep `version: 1`.

## Checklist for Windows (manual)

- Create a Slack or Teams contact point with a real incoming webhook URL, send a test, and check the message arrives formatted in the chosen language.
- Build a small tree ("Standard" with a contact point, one child for `team=lager` with an escalation step of 5 minutes), let two rules with `team=lager` fire, and check they arrive in one message, then the escalation after 5 minutes.
- Silence the firing group and check the escalation pauses; end the silence and check it continues.
- Update a server with 0.7.0 rules that have contact points and check they are listed as "Direkt" and keep notifying as before.
