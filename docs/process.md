# How Kalzit is built

This page describes the working process for Kalzit: who does what, how a change goes from a
decision to a release, and where the work runs. `CLAUDE.md` holds the binding rules. This page
gives the overview, and `CLAUDE.md` wins where the two differ.

## Roles

| Role | Does | Never does |
|---|---|---|
| Owner | Decides direction and design questions, approves boards, changes repository and machine settings, installs releases on the demo system | |
| Orchestrator | Plans the work, writes the briefs, starts and steers the agents, integrates branches, resolves conflicts, enqueues pull requests, runs the release gate, reports to the owner | Pushes to `main`, force-pushes, changes settings without the owner |
| Design director | Draws the boards in `docs/design/blueprint/`, reviews the look and wording of UI pull requests against the approved board, advises on product questions at milestone starts | Works on several things at once (there is one design director at a time) |
| Builders | Implement one scoped part each, in their own worktree and branch, with tests, docs and a release fragment; open the pull request | Merge, enqueue, or touch another builder's files |
| Reviewers | Read a pull request (diff, files on the branch, the board, `CLAUDE.md`) and report findings with severity and a concrete fix | Check out branches in the main folder, edit, commit or push |
| Research agents | Surveys, audits and code searches that end in a report | Change code |

Builders with complex, UI-heavy or security-relevant parts get a stronger model. Clearly
specified parts and read-only reviews get a lighter one. Expensive models are used where their
judgement matters most, so the usage limits last through the day.

## From decision to release

```mermaid
flowchart TD
  D[Owner decision<br/>menu, recommended option first] --> B[Plan and board<br/>design director draws, owner approves]
  B --> W[Build in parallel<br/>one worktree and branch per part]
  W --> P[Pull request<br/>feature branch, release fragment]
  P --> R[Review agent<br/>read-only findings]
  R -- findings --> W
  R -- clean --> C[CI on Linux and Windows<br/>all required checks]
  C -- red --> W
  C -- green --> Q[Merge queue<br/>up to 4 tested together, squash]
  Q --> M[main<br/>branch and worktree deleted]
  M --> G[Release<br/>fragments assembled, 3 green runs, tag]
  G --> S[Two independent security reviews<br/>fixes as normal pull requests]
```

1. **Decision.** Open questions go to the owner as a selection menu with the recommended option
   first. Decisions that change the plan are recorded in `docs/PLAN.md` and, when standing, in
   `CLAUDE.md`.
2. **Board.** A new screen or a larger UI change starts with a board. Implementation follows the
   approved board. A review that finds a gap in a board turns it into a decision for the owner.
3. **Build.** Larger stages are split into parts with clear file ownership. Each part has its own
   branch (`m<n>/`, `fix/`, `feat/`, `ux/`, `docs/`) and worktree. Shared files get small,
   documented interfaces, so the parts can merge in any order.
4. **Pull request.** It contains the change, its tests, its docs and a fragment in
   `docs/releases/unreleased/`. Commits are authored as the owner and carry no trailers.
5. **Review.** Every pull request gets a read-only review. Its findings go back to the builder.
   The pull request moves on only when the review has no open findings.
6. **CI.** Required checks on `main`: server, UI and end-to-end tests on Linux and Windows, plus
   PostgreSQL, data sources and audit. A red check goes back to the builder. Tests are never
   weakened or skipped to get green.
7. **Merge queue.** Pull requests merge only through the queue. It builds up to four at once on
   top of each other and squash-merges them. `main` takes no direct or force pushes.
8. **After the merge.** The branch and its worktree are deleted, together with local build
   folders.
9. **Release.** The release pull request assembles the fragments into
   `docs/releases/v<version>.md` and bumps the version. The tag follows three consecutive green
   CI runs on the release commit. Releases are published on GitHub only.
10. **Security.** After each milestone release, two independent security reviews take place.
    Their fixes are normal pull requests.

## Where the work runs

```mermaid
flowchart LR
  subgraph PC[Development machine]
    MC[Main checkout]
    WT[Agent worktrees<br/>.claude/worktrees]
    BD[Rust build folders<br/>one per topic, cleaned afterwards]
    LX[Linux environment<br/>WSL]
    WS[Watcher scripts<br/>enqueue once CI is green]
  end
  subgraph GH[GitHub: MouseWerk/Kalzit]
    PR[Pull requests]
    CI[CI: Linux and Windows]
    MQ[Merge queue]
    MN[Protected main]
    RL[Releases: tag, signed assets, images]
  end
  WT -- push --> PR
  PR --> CI --> MQ --> MN --> RL
  WS -- status, enqueue --> MQ
```

- **Machine:**
  - Builds use a dedicated folder per topic and are cleaned up afterwards, so the disk does not
    fill up.
  - Unit tests run with limited workers.
  - Targeted tests run locally. The full suites run in CI.
  - Port 3000 is reserved for the owner's demo. Nothing else starts or updates the demo.
- **GitHub:**
  - `main` is protected: merge queue only, no force push.
  - Releases are built by the release workflow from a tag.
  - Signing keys and CI secrets live only in GitHub environments.

## Keeping things clean

- One topic per branch and pull request. Unrelated findings become their own task.
- Worktrees, branches and build folders of merged work are removed right away.
- README screenshots in `docs/screenshots/` are refreshed after visible UI changes.
- The website describes only published releases.
