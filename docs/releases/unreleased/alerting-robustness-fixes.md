## Fixed

- Slack and Teams messages no longer turn addresses in rule names, labels or errors into
  clickable links; only Kalzit's own buttons link.
- Notification policies are no longer rebuilt for every evaluation and page view, so large policy
  trees with many regular expressions keep evaluations and the policy pages fast; a change on
  another server of a cluster still applies at once.
- A new regular expression in a notification policy may compile to at most 8 KiB; expressions
  saved before keep working.
- "Weg prüfen" checks each label set against the label limits of the data, answers at most 500
  ways (marked as cut beyond that) and allows 30 checks a minute per person.
- Creating a notification policy while another one is moved or changed can no longer go past the
  depth limit or the parent's group interval.
- Rules with many instances in large groups are stored faster after each evaluation.
