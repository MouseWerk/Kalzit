## Improved

- New page "Policies" in Alerting, between Rules and Contact points: a tree of notification
  policies from "Standard" down, with their conditions, contact points, grouping and times.
  Values a policy leaves empty are inherited from above and shown as "inherited". Organization
  admins add, edit, duplicate and delete policies and move them with the row menu, with Alt and
  the arrow keys, or by dragging; every move is saved at once and can be undone. Everyone who
  may read alert rules sees the tree read-only.
- A policy has conditions (=, !=, =~, !~), up to five contact points, "Group by", group wait,
  group interval, repeat, "continue" for a further way, and up to three escalation steps. Its
  page shows how it runs and its active groups.
- "Check way" on the Policies page shows which ways typed labels, or a rule's instances, take,
  with contact points, grouping and times, and why a matching policy is not reached.
- Slack and Microsoft Teams as contact points, with the channel's incoming webhook URL. The URL
  is kept as a secret and afterwards shown only by host and its last four characters; "Replace"
  sets a new one. The form shows what a message looks like and sends a test after saving.
- Rule editor, step 5: "Through policies" or "Directly to contact points". Through policies, the
  editor shows the way of each instance from "Evaluate now"; directly, it shows where the rule
  would go after switching. The message preview shows mail, Slack and Teams.
- The rules list has a column "Way" with the policy path, "+1 way" for further ways, and
  "Direct" for rules that go straight to their contact points.

## Checklist for Windows (manual)

- In Alerting > Policies, add a policy below "Standard", move it with Alt+Up and undo the move,
  then check a way with typed labels.
- Add a Slack contact point with an https URL, save it, and check that only host and the last
  four characters of the URL are shown afterwards.
