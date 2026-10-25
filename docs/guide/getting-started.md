# Getting started

This page takes you from a fresh server to a first query on a dashboard. Installing and starting
the server is described in the [README](../../README.md#quick-start); an operator also finds
backups and services in [ARCHITECTURE](../ARCHITECTURE.md).

## First setup

On the first start Kalzit asks for a one-time **setup code**.

1. Open the server's address, by default `http://localhost:3000`.
2. Read the code from the file `setup-token.txt` in the data directory (or use the value of
   `KALZIT_SETUP_TOKEN`, if one is set). The page has three steps:
   - **Confirm this server**: enter the **Setup code**.
   - **Name the organization**: the **Organization name**. More organizations can be added later.
   - **Create the owner account**: your name, email address and a password of at least the shown
     length. A strength hint appears while you type.
3. Press **Set up**. You are the owner of the first organization.

If Kalzit is already set up, the page says so and links to sign-in.

![The sign-in page](../screenshots/sign-in.png)

## Sign in

Enter the **Email address** and **Password** of your account and press **Sign in**. The password
field can show what you typed and warns when Caps Lock is on. After too many failed sign-ins you
have to wait a few minutes. Accounts are local for now; sign-in through OIDC or LDAP is planned
(M5).

A language or theme you choose on the sign-in page becomes your preference when you sign in,
unless you already have one.

## Your first data source

A data source is a connection to a database or service. Only admins and owners add them.

1. Open **Data sources** and press **Add data source**.
2. Pick the kind (for example PostgreSQL) from the cards, grouped as Tables (SQL), Metrics and
   search, Documents and graphs, Files and APIs. The search box finds a kind by name.
3. Enter the connection, either as fields or as a connection string, and a name.
4. Press **Save and test**. Kalzit stores the source and checks the connection with what you
   entered.

Use a database login that can only read; see [Data sources](data-sources.md) for every kind and
what the check does.

![Data source kinds as cards](../screenshots/data-source-kinds-dark.png)

## Your first query in Explore

1. Open **Explore**, pick the data source and write a query, for example a `SELECT` on a SQL
   source.
2. Press **Run query** or Ctrl+Enter.
3. The result appears in a visualization that fits its shape (a table, a time series, documents or
   a graph). The **Inspect** tab shows the executed query and the server's notes.

Details: [Explore](explore.md).

![Explore with a SQL query and a time series](../screenshots/explore.png)

## Your first dashboard

The quickest way: in Explore press **Add to dashboard...**, choose **A new dashboard** and press
**Add panel**. The dashboard opens with the panel.

Or start from the dashboard list: **Dashboards**, **New dashboard**, a title, **Create**; then
**Edit**, **Add** and pick a visualization. In the panel editor choose the data source, write the
query and press **Apply**, then **Save...** to keep the dashboard as a new version.

Details: [Dashboards](dashboards.md) and [Panels](panels.md).

## First steps card

Until you have done the basics, the sidebar shows a **First steps** card: **Add a data source**,
**Create a dashboard**, **Invite a colleague**. It ticks off what is done and can be hidden.

## Next

- Invite colleagues: [Administration](administration.md#members).
- Make the numbers meaningful: [calculated fields and statistics](calculated-fields.md).
- Learn the keys: press `?` anywhere.
