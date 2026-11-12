## Fixed

- A slow or unreachable webhook receiver no longer delays alert messages of other contact points
  or organizations: messages go out as soon as a slot is free, organizations take turns, and a
  contact point that keeps timing out is paused for five minutes without using up attempts.
- An organization has at most 1000 alert messages waiting (a contact point at most 100) and
  sends at most "Alarm-Nachrichten je Organisation und Stunde" (new setting, default 1000) per
  hour; messages beyond that show in the history as "not queued" or "not sent". Resolves are
  always sent, so no alert stays open at a receiver. Messages that wait more than an hour are
  given up.
- Alert labels taken from query results are limited (at most 20 per series, names up to 64 and
  values up to 256 characters); a series beyond that puts the rule in the error state
  "labels too long" instead of storing them.
- Webhook messages never exceed the configured largest payload, even for a single instance with
  long labels; a shortened message is marked with `truncated`.
- A flapping series fills the alerting history with at most 20 state changes per instance and
  hour; further changes are counted in one entry.
- People who may neither read nor query a rule's data source see the states and counts of its
  instances, but no labels, values or error details, in the rule list, the history, the panel
  badges and the silence preview.
- The history's label filter is now case-sensitive on SQLite too.
- New setting "Kontaktpunkte je Organisation" (default 50; organizations can only lower it), and
  at most 20 test messages per organization and minute.
- The guide now explains which addresses the outbound proxy must refuse for HTTPS webhooks.

## Checklist for Windows (manual)

- Administration > Settings > Alerting: the new settings "Kontaktpunkte je Organisation" and
  "Alarm-Nachrichten je Organisation und Stunde" show with German and English texts, and an
  organization can only lower them.
- As a viewer, open Alerting > Regeln, expand a firing rule: the instances show "Labels
  verborgen" and "Wert verborgen"; the history shows no labels or values for that rule.
