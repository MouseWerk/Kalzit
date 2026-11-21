English | [Deutsch](de/alerting.md)

# Alerting

Alerting watches a query for you. A rule runs a stored query on a schedule, reduces its result to
a number, and reports when a condition on that number holds. Reports go to contact points (mail,
webhook, Slack, Microsoft Teams), directly or through a tree of notification policies that bundles
them and escalates them. The HTTP API is in [docs/api/alerting.md](../api/alerting.md).

**Alerting** in the sidebar shows with `alerts:read` while alerting is on for the server and the
organization, with the number of firing rules next to it. It has five pages: **Rules**,
**Contact points**, **Silences**, **History** and **Policies**.

> [!NOTE]
> If alerting is off for the server or the organization, rules are kept but not evaluated. The
> pages say so at the top.

## Before the first rule

1. A data source must be opted in to alerting: **Opt in to alerting** in the source's **Alerting**
   section. Whoever may edit data sources can do this (admins). Without the opt-in a rule cannot
   be saved on that source.
2. A contact point for the messages (an admin of the organization adds it, see below). A rule
   without a contact point is evaluated but sends nothing.
3. A rule: from a panel (panel menu > **Create alert rule**), from **New rule** on the Rules page,
   or by duplicating one.

Scheduled evaluations never run with your rights. They run as the organization's service identity
"Alerting", which may only query the opted-in data sources, read-only and within each source's
limits. A rule therefore does not depend on a person's account staying active. Evaluations never
read the query cache.

## Rules

A rule has three parts, all visible as steps in the editor, like the steps in
[Explore](explore.md):

- **Query**: a data source, the query in its language, optional steps after it, and a relative
  range such as "Last 10 minutes" that fills the time filter. Variables have fixed values stored
  in the rule. A rule holds its own copy of the query. If it came from a panel and the panel's
  query changes later, the editor says so and offers **Take over the query**.
- **Reduce**: turns the result into one number per instance, according to its shape. Nothing is
  converted implicitly: if you need numbers from documents in another form, add a visible step
  first (see [Calculated fields and statistics](calculated-fields.md)).
- **Condition**: compares the number with fixed values: greater than, greater than or equal,
  less than, less than or equal, equal to, unequal to, outside of or inside of (two bounds).

| Shape | Reduce | Instances |
|---|---|---|
| `frame` | `last`, `min`, `max`, `mean`, `sum` or `count` per series (for long tables per label combination); `last` takes the value with the latest time, or the last row without a time field | One per series, with its labels |
| `documents` | The number of documents, or a field value at a path such as `$.queue.depth` with `first`, `min`, `max`, `mean` or `sum`; documents without the field do not count, a field holding text gives the state Error | One per rule |
| `graph` | The number of nodes, edges or paths, optionally only for one label or edge type | One per rule |

For documents and graphs, 0 is a value (so OK), not missing data. A query that answers a trace
needs a table step first (span table or trace table); the table is then reduced.

**Evaluation** settings per rule: the interval (at least 30 seconds by default, at most a day), the
**Fires after** ("for") duration (a multiple of the interval, at most a day; "Right away" by
default), what happens **When no data comes** (state No data, OK or Firing) and **When the query
fails** (state Error or Keep the last state). Under **Labels and notification** a rule has labels
(`team=warehouse`, at most 20), a description, an optional runbook link, a **Reminder while firing**
and its notification route (see below). **Evaluate now** shows the result of every step and the
state each instance would have, with your rights. Nothing is saved before **Save**. A rule can be
paused; pausing ends its instances without a message, and resuming starts them at OK.

### States

| State | Meaning |
|---|---|
| OK | The condition does not hold |
| Pending | The condition holds, but not yet for the "for" duration |
| Firing | The condition has held for the "for" duration; this is reported |
| No data | The query returned nothing to reduce (if the rule is set to that) |
| Error | The evaluation failed: query error, time limit, wrong shape, a field that is not a number, a data source that is not opted in, or a result the source cut off |

Paused and Silenced show next to these. States are always written out; colour only adds to them.
When a firing instance returns to OK, its resolve goes out as its own message.

## Contact points

A contact point says where messages go. Organization admins (`alerts:contacts`) add and change
them; everyone with `alerts:read` sees them in a short form.

| Kind | What it needs | Notes |
|---|---|---|
| Mail | 1 to 20 recipients and a language (German or English) | Needs a mail server (Settings > Email) |
| Webhook | An `http://` or `https://` address and a language | Signed with HMAC-SHA256 in the header `Kalzit-Signature`; the signing secret is shown once, and after renewing it the old one stays valid for 24 hours; receivers should reject timestamps older than 5 minutes |
| Slack | The channel's incoming webhook URL (`https://` only) | The URL is the secret: stored encrypted, afterwards only its host and end are shown |
| Teams | The URL of a Teams workflow that posts when a webhook request arrives | As Slack; sent as an Adaptive Card |

Webhook, Slack and Teams addresses go through the same target check as data sources: private
networks are allowed, Kalzit itself and metadata addresses never, and redirects are not followed;
the outbound proxy is used when one is set. **Send test** (at most 5 a minute per contact point)
sends sample content. A contact point cannot be deleted while rules or policies use it.

Slack and Teams messages show state, group and, per instance, rule, labels, reduced value and
condition, with buttons to open the rule or panel and to silence; up to 10 instances, then "and N
more". Messages never hold rows, documents or nodes from the result.

## Notification routes

Each rule chooses how its instances are delivered, under **Notification**:

- **Directly to contact points**: up to 5 contact points, one message per evaluation, without the
  tree. The rule's own reminder applies.
- **Through policies**: the rule's labels decide where it goes, how it is bundled and when it
  escalates.

### Policies

**Policies** shows the organization's tree. Its root, **Standard**, matches every instance and can
be neither moved nor deleted; it sets every time itself. Every instance runs down from Standard.
On each level the first matching policy takes it; with **continue** the policies after it are
checked too, so an instance can take several ways (a contact point still gets it once). A policy
inherits the fields it leaves empty from the policy above.

A policy has:

- **Matches**: up to 10 conditions on labels (`=`, `!=`, `=~`, `!~`; regular expressions apply to
  the whole value, a missing label counts as empty). The labels are those of the instance and the
  rule, and the rule's name under `alertname`.
- **Contact points**: up to 5; left empty, they come from above.
- **Group by**: labels (instances with the same values come in one message, from different rules
  too), **All together** or **Each one apart**.
- **Group wait**, **Group interval** and **Repeat**: the wait before the first message of a new
  group (30 seconds at the root), the shortest time between messages for changes (5 minutes at the
  root) and the time after which a group that keeps firing unchanged is repeated as a reminder
  (4 hours at the root, or off).
- **Escalation**: up to 3 steps. If a group still fires after a step's wait (5 minutes to 24
  hours, counted from when the group started firing, each step later than the one before), the
  step's contact points get the whole group once; afterwards they also get its changes, reminders
  and the resolve. A silence on every firing instance holds the escalation.

Admins add, edit, move (row menu or drag), duplicate and delete policies. Everyone with
`alerts:read` can open the tree, see the active groups of each policy and use **Check way**: enter
labels or choose a rule to see which ways they would take. An organization may have up to 100
policies, five levels deep.

> [!TIP]
> Give your rules labels such as `team` and `severity`, then let policies route on them. A rule
> set to "Directly to contact points" does not go through the tree; the Policies page says how
> many rules are direct.

## Silences

A silence holds back messages, never the evaluation: matching instances are still evaluated and
recorded, they are only not reported. **Silence** creates one from conditions on labels (all must
match; `=`, `≠`, `=~`; `alertname` is the rule's name), a duration (1 hour, 4 hours, 1 day or until
a time, at most 90 days) and a required comment. The dialog shows which instances it affects now;
a silence that affects none can still be saved, for planned work. You can also start one from a
rule or an instance. Silences are listed as active, planned or ended; **End** ends one early. When
a silence ends while an instance still fires, the instance is reported once. Creating and ending
silences is in the audit log.

## History

**History** lists the changes of state and the deliveries of the organization. Filter by range
(last hour to last 30 days), rule, state, label and kind (changes or deliveries). A delivery shows
the contact point and the result: delivered, no answer within 10 seconds, address refused, no
connection, not sent because the organization's hourly limit is used up, and so on. History is
kept for 90 days by default. Panels that have rules show a badge, a dashed threshold line and a
quiet area for the time a rule fired; you can hide the last two in the panel menu.

## Permissions

| Permission | Built-in roles | Allows |
|---|---|---|
| `alerts:read` | Viewer and up | See rules with their states, silences, history, contact points in their short form, the policy tree with its groups, and **Check way** |
| `alerts:write` | Editor and up | Create, change, pause, resume and delete rules; create and end silences |
| `alerts:contacts` | Admin and up | Create, change and delete contact points and policies; renew webhook secrets; see contact point details and the last delivery |

All three can be given to custom roles. Saving a rule also needs `datasources:query` on its data
source, and a rule can only use contact points of its own organization.

### What people without access to the source see

Alerting does not give out more than a data source's rights allow. If you may neither read nor
query a rule's data source:

- You see its states and counts, but no labels, values or error details; instances show hidden
  fingerprints (`hidden-N`).
- The rule's query is hidden and the rule can only be viewed.
- Groups on the Policies page show no id, policy, contact point or position among a policy's
  groups; they are counted as hidden groups.
- **Check way** and the route of a rule follow only the rule's own labels and `alertname`; the real
  way can differ.

Contact points show recipients only as a count (or shortened) and webhooks only with their host.

## Limits and settings

Server admins set the limits under alerting in the server settings; organizations may only make
them stricter. By default: at most 500 rules and 50 contact points per organization, 100 instances
per rule, 5 contact points per rule, 200 active and planned silences, 1000 messages per hour and
90 days of history. At most 8 evaluations run at once on the server, 4 per organization and 2 per
data source (a data source may set fewer under its **Alerting** section). A rule that cannot start
before its next slot skips it; the rule shows "N evaluations skipped".
