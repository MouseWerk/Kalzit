# Administration (Verwaltung)

Organizations, members, teams, roles, the audit log, server settings and updates. Sections appear
only to those who may open them. API: [access](../api/access.md),
[settings and dashboards](../api/settings-dashboards.md) and [updates](../api/updates.md).

**Administration** in the **Organization** group lists the sections, split into **Organization**
(for the organization you work in) and **Server** (for server admins). **Members** also has its
own entry in the sidebar.

## Your account

Open your name at the bottom of the sidebar, then your account (**Your account**):

- **Profile**: your name; the email address is changed by a server admin.
- **Password**: **Current password**, **New password**, **Repeat new password**. Changing it signs
  you out everywhere else.
- **Sessions**: browsers where you are signed in, **End this session** and **Sign out everywhere
  else...**.
- **Your permissions**: what your role allows in the current organization.
- **Preferences**: **Language**, **Theme** (System, Light, Dark, High contrast), **Time zone**
  (all times in Kalzit follow it), **Start dashboard**, **First day of the week**. They apply at
  once, can be undone, and follow you to every browser.

![Sessions of the signed-in account](../screenshots/account.png)

## Organizations

A server can hold several organizations. Server admins create and rename them under
**Administration** > **Organizations** (**New organization...**, with a first owner who manages it).
Server admins are not members of every organization. The organization card at the top of the
sidebar switches between the organizations you belong to (server admins see all).

## Members

**Members** lists the people of the organization and their roles.

![Members of an organization with their roles](../screenshots/admin-members.png)

- **Invite** invites people by email address, with a role and, if you may change teams, a team
  (see "Invitations" below). Needs the `users:invite` permission (admins and owners).
- **Add member...** adds an existing account by email address and role. The person needs an
  account on this server; a server admin creates accounts under **Users**.
- Change a role in the list; **Remove...** takes a member out of the organization (their account
  stays and they lose access at once).
- An organization always keeps at least one owner. You can only give a role, change or remove a
  member whose permissions you hold yourself.
- The menu of a member (**More for ...**) has **Send password link**: the member gets the same
  mail as with **Forgot password?**. It needs a mail server.

### Invitations

**Invite** takes one or several email addresses (separated by comma, space or Enter), a role and
an optional team. Each invitation link works for seven days and once.

- With a mail server (Settings > Email), Kalzit sends each person a mail in their language (or the
  server's default language) with the link; nothing in it tracks the reader.
- Without a mail server, **Invitation created** shows each link to pass on yourself, for example
  in a chat.
- **Open invitations** above the members shows every invitation that is not accepted yet: role
  and team, who invited, until when it is valid and how its mail went (**Delivered**, or
  **Refused** with the mail server's answer). **Copy link** copies a pending link again; **Send
  again** makes a new link (the old one stops working) and starts the seven days again;
  **Revoke** withdraws it. Expired invitations can be invited again or removed.
- Links point to the server's public address (`server.public_url` in `kalzit.toml` or
  `KALZIT_SERVER_PUBLIC_URL`); without it Kalzit makes no links and says so.
- Every invitation, resend, revoke, copied link, refused mail and acceptance is in the audit log;
  links themselves never are.

## Teams

**Teams** are groups of members that receive roles and access together.

- **New team...**, rename and delete. A team member is a **Member** or a **Maintainer** (who can add
  and remove members of that team).
- **Roles of the team**: every member gets the permissions of these roles on top of their own
  (at most 20; never the owner role).
- Teams can be given access to folders, dashboards and data sources like individual users.
- A team can own **team spaces**, folders and dashboards (see
  [Dashboards](dashboards.md#team-spaces-and-team-ownership)). Adding members to such a team is for
  its maintainers and admins; an admin doing it is recorded in the audit log.
- Deleting a team asks who takes over what it owns: another team, or the organization. Handed to
  the organization, team-only content stays hidden from everyone but admins and grants, until an
  admin decides otherwise.

## Roles and permissions

**Roles** are sets of permissions. The built-in roles cannot be changed:

| Role | Can |
|---|---|
| Viewer | Open dashboards and folders and see their data through the stored queries; see teams |
| Editor | Everything a viewer can, plus create, change, delete and share dashboards, manage folders, run own queries in Explore and read data sources, save analyses, export data, annotate, see members |
| Admin | Everything except deleting the organization |
| Owner | Everything |

Custom roles (**New role**) combine permissions as you need them, grouped as Dashboards and
folders, Data sources and analyses, People and roles, Organization and Other. Examples of
permissions: `dashboards:read`, `dashboards:write`, `dashboards:share`, `folders:permissions`,
`datasources:query`, `datasources:write`, `data:export`, `annotations:write`, `audit:read`,
`settings:write`. You can only give permissions you hold yourself, and the owner-only permissions
cannot be part of a custom role. A role that is still given to members cannot be deleted.

Beyond roles, **Access...** on a folder, dashboard or data source gives users, teams or roles
**Can view / Can edit / Can manage** (data sources: **Can query / Can edit / Can manage**). A
folder marked **Restricted** hides itself and everything in it from everyone without access; the
nearest restricted folder above a resource decides. For everyone else it does not exist ("not
found").

Every request is checked on the server for every resource.

## Audit log

**Audit log** answers who changed what and when in the organization: sign-ins, changes to
dashboards, folders, data sources, members, roles, settings, exports and more. Filter by **Person**,
**Action** or area and a date range; page with **Newer** and **Older**. Events about restricted
folders you cannot see are left out. Events are deleted after the retention time (365 days by
default, setting `audit.retention_days`). Server admins also have a server-wide audit log under
**Server**.

## Users (server admins)

**Administration** > **Users** lists every account on the server: create users, rename, set a
password, make a user a server admin, **Lock** and unlock (a locked user is signed out and cannot
sign in). The last server admin and the last owner who can sign in are protected.

## Settings

**Settings** in the sidebar holds one page of sections, for the **Server**, your **Organization**
and **Personal**, with a **Search settings** box that finds a setting by its German or English
name, description or key and jumps to it; every section and setting has its own address.

- Changes apply at once and can be undone.
- Values from `kalzit.toml` or the environment show as **locked** with their source. Network, TLS,
  proxy, session, security and log settings are read-only here: they are set in `kalzit.toml` or
  the environment only, so a wrong value can never lock you out.
- Sections: Appearance and brand, General, Network HTTPS and proxy, Sessions and security,
  Sign-in (OIDC, LDAP, planned for M5), Email, Data sources and targets, Plugins
  ([Plugins](plugins.md)), AI ([AI](ai.md)), Storage and retention, Updates, This organization,
  AI of the organization, Plugins of the organization, Profile and language, Keyboard shortcuts,
  and Export / import settings.

![Settings: appearance and brand](../screenshots/settings-dark.png)

### Email (mail server)

**Settings** > **Email** (Verwaltung > E-Mail) sets the mail server Kalzit sends invitations and
password links with. Without one, invitations appear as links to copy and admins set passwords
under **Users**.

- **Set up mail server**, then enter **Server** (host and port), **Encryption** (STARTTLS, usually
  port 587, or TLS, usually port 465), **User** and **Password** if the server wants a sign-in,
  **Sender name**, **Sender address** and optionally **Reply to**.
- The fields depend on each other, so they are saved together: **Send test mail** sends one mail
  with the values in the form and shows what the server answered, how long it took, the TLS
  version and until when its certificate is valid. **Save** waits for a successful test mail with
  these values, then checks the connection and sign-in once more; a problem is shown at its field
  (for example "535: sign-in refused" at Password, or "port 465 speaks TLS directly" at Port).
  Until then the previous settings apply.
- The password is stored encrypted with the secrets key and never shown again; leave the field
  empty to keep it. Changing the server or user needs the password again.
- The mail server is a target like a data source: the allowed targets apply, and metadata
  addresses and Kalzit's own address and database are refused. Credentials only go over TLS, and
  the server's certificate must be trusted by the computer Kalzit runs on.
- `[smtp]` in `kalzit.toml` or `KALZIT_SMTP_HOST`, `KALZIT_SMTP_PORT`, `KALZIT_SMTP_SECURITY`,
  `KALZIT_SMTP_USERNAME`, `KALZIT_SMTP_PASSWORD`, `KALZIT_SMTP_FROM_NAME`,
  `KALZIT_SMTP_FROM_ADDRESS` and `KALZIT_SMTP_REPLY_TO` set the mail server instead; then the page
  shows it read-only with its source, and the test mail still works. Give the password in the
  environment rather than the file. `security = "none"` (no encryption) is possible only there,
  and only for a relay on the same computer (`localhost`).
- **Remove mail server** goes back to links to copy. Every change is in the audit log.

### Appearance and brand

Through checked options, never custom CSS: **Default theme**, **Accent color** (eight checked
colors, or **Custom...** as `#rrggbb` when its contrast is high enough: 3:1 against the light and
the dark page and 4.5:1 for the label), **Product name**, **Logo** (PNG, JPEG or WebP, at most 256
KiB; in the sidebar, on the sign-in page and as the browser tab icon; upload, replace and remove
can be undone), density (Compact, Balanced, Comfortable), font size, start page, time zone and
first day of the week, with a live preview. An organization can set its own accent, density, font
size, start page, time zone and week start or follow the server (**Like the server**).

The **Sign-in page** can show your own **Welcome text** (up to 280 characters) and a **Notice**
(up to 2000), with bold, italic and links.

### Export and import settings

**Export / import settings** downloads the server's settings, or those of one organization, as a
JSON file; only settings you may change are exported and never secrets. **Import** shows every
change ("Will change", "Unchanged", "Locked", "Refused", "Unknown here") before anything is
applied, applies all of them together and can be undone.

### Data and retention settings

Under **Data sources and targets**: the allowed folders for SQLite and file sources, an optional
list of allowed targets, the query time limit (30 s), the row limit (100,000) and the query cache
with its memory limit and **Empty cache** ([Performance and caching](performance.md)). Under **Storage
and retention**: the audit log retention and how many dashboard versions are kept (100; 0 keeps
every version). Settings can also come from `KALZIT_SETTING_<KEY>` variables; every key is listed
in [settings and dashboards](../api/settings-dashboards.md#settings).

## Updates

**Administration** > **Updates** (server admins). Kalzit installs only releases signed with its
built-in key; an older version, a changed file or a package for another platform is refused. The
full operator guide, including the release key, command line and recovery, is
[docs/operations/updates.md](../operations/updates.md).

![Updates](../screenshots/updates.png)

### Online

1. **Check now** (or **Check automatically**, daily, off by default; **Channel** Stable or
   Preview). A new version shows with its release notes, size and verified signature.
2. **Download**, then **Install now**, or plan it: **Plan for today ...** or **Plan for tomorrow
   ...** starts in the **Maintenance window** (02:00 to 04:00 unless you change it).
3. Kalzit backs up its database, replaces itself, restarts and checks that it is healthy. If it
   is not healthy within the timeout (60 s by default), it returns to the previous version and
   database on its own.

Online installation is automatic on Linux under systemd (when the service account may replace the
binary). Elsewhere, such as Windows, Kalzit downloads and verifies the release and shows the
command to run with Kalzit stopped (`kalzit update apply`); the next start checks itself and
returns on its own when it is not healthy. In a container, update the image.

### Offline

For servers without internet access: download the `.kalzit-update` package from the GitHub release
of `MouseWerk/Kalzit`, carry it over and drop it on the Updates page. It is verified (Ed25519
against the built-in key, the version must be newer) and then installed like an online update.

### Backups and rollback

- **Before the update** shows what is ready: a backup of the database (with its size), free disk
  space, and the number of active users who will see a short interruption. With PostgreSQL as
  Kalzit's own database, Kalzit makes no backup: use `pg_dump` and confirm it.
- **Backups** lists them, **Back up now** adds a manual one, each can be downloaded (the download
  is audited). Backups contain password hashes and encrypted secrets: keep downloads safe.
  Older backups are removed automatically.
- **History** lists every update with who started it, how long it took and how it ended
  (Succeeded, Returned, Stopped nothing changed). **Return to this version** puts back a kept
  earlier version; if the database schema changed since, the backup taken when that version was
  left replaces the database and later changes are lost, which Kalzit asks about first. From the
  command line, `kalzit update rollback <version>` with Kalzit stopped.
- Back up the secrets key along with the database; see
  [ARCHITECTURE](../ARCHITECTURE.md#backups).
