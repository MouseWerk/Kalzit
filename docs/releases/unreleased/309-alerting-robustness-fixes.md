## Fixed

- Slack and Teams messages no longer turn addresses in rule names, labels or errors into
  clickable links; only Kalzit's own buttons link.
- Notification policies are no longer rebuilt for every evaluation and page view: their regular
  expressions are compiled once until the policies change, so large policy trees keep evaluations
  and the policy pages fast, and a change on another server of a cluster still applies at once.
  The size limit of a regular expression stays 64 KiB.
- "Weg prüfen" checks each label set against the label limits of the data, answers at most 500
  ways (with a note when the answer was cut) and allows 120 checks a minute per person; the rule
  editor checks once typing pauses.
- Creating, changing or moving a notification policy while another one changes can no longer go
  past the depth limit or leave a repeat interval shorter than the group interval it inherits.
- Rules with many instances in large groups are stored faster after each evaluation.

## Checklist for Windows (manual)

- Send an alert whose rule name and labels hold `https://example.com/x`, `www.example.com` and
  `host.example.com` to a Slack and a Teams channel: the addresses read normally but are not
  links, and the buttons still open Kalzit.
