---
id: pro-05
title: Teamwork, Agile & Code Review
level: beginner
minutes: 55
xp: 120
summary: Scrum and Kanban in practice, user stories and acceptance criteria, estimation, standups, PR descriptions, code review etiquette, definition of done, on-call, SLOs and postmortems.
---

Software is a team sport. The best engineers aren't the ones who type fastest — they're the ones
whose work fits smoothly into the team: tickets that are clear, PRs that are easy to review,
reviews that make code better without making people defensive, and calm behaviour when production
is on fire. This lesson covers the processes you'll meet at almost every company and, more
importantly, how to be good at them.

## Agile in one paragraph

Agile is not a ceremony checklist. It's an idea: **deliver small increments often, get feedback,
adapt.** Instead of a six-month plan followed by a big-bang release, you ship something small every
week or two, learn from real users and adjust. Scrum and Kanban are two popular ways to organise
that.

:::info title="Agile vs. 'agile'"
Many companies say "we do Scrum" and mean "we have standups and two-week sprints". That's fine.
Your job is to understand the *intent* of each practice, so you can contribute — and politely
suggest improvements when a ritual has lost its purpose.
:::

## Scrum in practice

Scrum organises work in **sprints** — fixed time boxes, usually 2 weeks. Why a fixed box? It
forces the team to finish *something* usable regularly, gives stakeholders a predictable moment to
give feedback, and limits how far the team can drift before someone notices. Each sprint has a
**Sprint Goal** — one sentence saying what this sprint is for ("Customers can export reports"),
so the team can make trade-offs when a ticket turns out bigger than expected.

The official Scrum events (from the [Scrum Guide](https://scrumguides.org/)) plus refinement,
which almost every team schedules even though the guide calls it an ongoing *activity*:

| Event | Purpose | Typical length (2-week sprint) |
|---|---|---|
| **Sprint planning** | Agree the Sprint Goal and pick the backlog items that serve it | 1–3 h |
| **Daily standup** (daily scrum) | Sync on progress toward the goal, surface blockers | 15 min |
| **Refinement** (grooming) — *activity* | Clarify, split and estimate upcoming backlog items | ~1 h/week |
| **Sprint review** (demo) | Show working software to stakeholders, get feedback | 1–2 h |
| **Retrospective** | Improve how the team works | 1–1.5 h |

The sprint itself is the fifth event — the container for all the others.

Roles (the Scrum Guide calls them *accountabilities*):

- **Product Owner (PO)** — owns the backlog and priorities; decides *what* and *why*.
- **Scrum Master** — helps the team use Scrum well: facilitates events, removes impediments,
  coaches. (In practice it's often a part-time role or done by the team lead.)
- **Developers** — everyone who builds the increment (devs, QA, designers): decide *how*.

:::warn title="'Commitment' vs forecast"
The team doesn't promise to finish every ticket in the sprint — the plan is a **forecast**.
What it commits to is the Sprint Goal. If halfway through it's clear a ticket won't fit, you say
so in the standup and talk to the PO *then*, not on the last day.
:::

Artifacts: the **product backlog** (ordered list of everything that might be done), the **sprint
backlog** (what's in this sprint) and the **increment** (working, potentially releasable software).

## Kanban in practice

Kanban has no sprints. Its starting observation: a team that works on ten things at once finishes
each of them late, because every item waits while people switch between the others. So instead of
planning in batches, Kanban **limits how much is in progress** and lets work flow continuously
across a board:

```text
Backlog │ Ready │ In progress (WIP 3) │ Review (WIP 2) │ Testing │ Done
```

Key ideas:

- **WIP limits** — a column may only hold N items. If Review is full, you stop starting and go
  review. *"Stop starting, start finishing."*
- **Pull, don't push** — you pull the next item when you have capacity.
- **Measure flow** — **cycle time** (start → done) and **throughput** (items per week) instead of
  velocity.

Kanban suits teams with lots of unplanned work (platform, support, ops). Many teams use a hybrid
("Scrumban"): sprints for planning, a Kanban board with WIP limits for flow.

:::quiz id=pro-05-q1 xp=10
Your team's board has a WIP limit of 2 on "Review" and it's full. You just finished coding your
ticket. What does Kanban suggest?
- [ ] Move your ticket into Review anyway — limits are guidelines
- [ ] Start a new ticket from the backlog while you wait
- [x] Help review the items already in Review before adding yours
- [ ] Merge without review to keep things moving
> WIP limits expose bottlenecks. The fastest way to get your own work through is to help unblock
> the column ahead of you — "stop starting, start finishing". Starting a new ticket is the tempting
> answer because it *feels* productive, but it adds more half-done work and leaves the real
> bottleneck (review) untouched; ignoring the limit or skipping review defeats the system.
:::

## User stories & acceptance criteria

A **user story** describes value from the user's perspective:

```text
As a <role>, I want <capability>, so that <benefit>.

As a project manager, I want to export the report as CSV
so that I can share it with finance in Excel.
```

The "so that" is the most important part: it tells you *why*, which helps you make good decisions
when details are unclear.

**Acceptance criteria (AC)** define when the story is done. They must be testable. A popular format
is **Given / When / Then** (from BDD), which maps neatly onto automated tests:

```text
Scenario: Export respects the date filter
  Given the report is filtered to January 2026
  When I click "Export CSV"
  Then the downloaded file contains only rows dated January 2026
  And the header row matches the visible table columns

Scenario: Empty range
  Given a date range with no data
  When I export
  Then I get a CSV with only the header row
```

A good story is **INVEST**: **I**ndependent, **N**egotiable, **V**aluable, **E**stimable, **S**mall,
**T**estable.

:::job title="Refinement is where you earn your salary"
The cheapest place to fix a bug is before it's written. In refinement, ask: *What happens on an
empty list? What about permissions — who may export? How many rows max? Is there a design for the
error state?* Developers who raise edge cases early are the ones POs love working with.
:::

:::quiz id=pro-05-q2 xp=15
Which acceptance criteria are well written (testable and unambiguous)? (Select all that apply.)
- [x] Given an unauthenticated user, when they open /reports, then they are redirected to /login
- [ ] The export should be fast
- [x] Exports with more than 50,000 rows are generated in the background and the user gets an email with a link
- [ ] The page should be user-friendly
> A criterion is good if two people would agree whether it passes. The redirect rule and the
> 50,000-row rule both describe observable behaviour with a clear threshold — the second isn't in
> Given/When/Then form, and that's fine: the format is a tool, testability is the requirement.
> "Fast" and "user-friendly" can't be verified. Turn them into numbers or behaviour: "the export of
> 10,000 rows completes within 3 seconds (p95)" — *p95* meaning 95% of exports are at least that fast.
:::

## Estimation

Teams estimate to plan, not to predict the future precisely. The number is less important than
the conversation: when estimates differ, someone has spotted a risk or a shortcut the others
haven't. Common approaches:

- **Story points** — relative size (complexity + uncertainty + effort), often on a Fibonacci-ish
  scale `1, 2, 3, 5, 8, 13`. A "5" is roughly twice a "2-3". Points are team-specific and *not hours*.
- **Planning poker** — everybody reveals their estimate at once (to avoid anchoring). If one person
  says 2 and another 13, they discuss: usually one of them knows something the other doesn't.
- **T-shirt sizes** (S/M/L/XL) — for rough roadmap planning.
- **No estimates / counting items** — split everything to roughly the same small size and count
  throughput. Works well with Kanban.

**Velocity** = points completed per sprint, averaged over a few sprints. It's for the team's own
planning, never for comparing teams or people.

Practical rules:

- **On most teams, anything ≥ 13 points is too big** — big items hide unknowns and sit "in
  progress" for weeks. Split it (by workflow step, by user role, by happy path vs edge cases, by
  "read" vs "write").
- Include testing, code review, migrations and docs in the estimate — not only coding.
- When unsure, a **spike** (time-boxed investigation, e.g. 1 day) produces knowledge, not features.

### Split vertically, not by layer

The most common splitting mistake is cutting a story into **layers**: "DB table", "API endpoint",
"React form". None of those delivers anything a user can try, none can be demoed, and integration
problems hide until the last one is done. Split **vertically** instead: each slice goes through
every layer, but does less.

```text
❌ Horizontal (by layer)            ✅ Vertical (thin end-to-end slices)
1. Create invites table             1. Owner invites an existing user by email (happy path)
2. POST /api/invites endpoint       2. Invite a person without an account (sign-up link)
3. Invite form in React             3. Revoke a pending invite
4. Email sending                    4. Invites expire after 7 days
```

Each vertical slice touches DB, API and UI, can be reviewed and shipped on its own, and gives
feedback early.

:::quiz id=pro-05-q3 xp=10
In planning poker, you vote 3 and a senior colleague votes 13 for the same story. What's the best next step?
- [ ] Take the average, 8
- [ ] Go with the senior's 13
- [x] Both explain their reasoning; the gap usually reveals hidden complexity or a simpler approach
- [ ] Re-vote until everyone picks the same number without discussing
> The *discussion* is the value of planning poker. Maybe they know the export touches the legacy
> billing module, or maybe you know there's already a CSV helper. Then re-vote. Averaging or
> deferring to seniority are tempting shortcuts, but both throw away exactly the information the
> gap revealed — and a junior sometimes knows the detail that makes it a 3.
:::

:::quiz id=pro-05-q7 xp=10
The story "Users can invite teammates by email" is too big. Which split is best?
- [ ] Ticket 1: database table · Ticket 2: API endpoint · Ticket 3: React form · Ticket 4: email sending
- [x] Ticket 1: invite an existing user (end to end) · Ticket 2: invite someone without an account · Ticket 3: revoke an invite
- [ ] Ticket 1: backend work · Ticket 2: frontend work
- [ ] Keep it as one ticket and give it 21 points
> Each ticket in the correct option is a **vertical slice**: it touches every layer, can be demoed
> and shipped alone, and delivers value. The layer split looks tidy, but nothing works until all
> four are done, so feedback and integration bugs arrive at the very end. A 21-point ticket
> hides its risks instead of exposing them.
:::

## Standups that don't waste time

The daily standup is a **15-minute sync**, not a status report to the manager. Common formats:

- *Yesterday / today / blockers* per person — classic.
- **Walk the board** right to left — focus on items closest to done and what's stuck.

Good standup updates are short and specific:

```text
❌ "Yesterday I worked on the export thing, today I'll continue on it, no blockers."

✅ "CSV export: backend done and merged, frontend PR is up — need one review, ideally from
    someone who knows the filter state. Blocked on the finance team telling us the decimal
    separator they want; I pinged them and will follow up at 2pm."
```

Deep-dive discussions go **after** standup with just the people involved ("let's take that offline").

## Writing a good PR description

Your PR description is a message to a busy reviewer — and to whoever reads `git log` in two years.
The reviewer sees only the diff; they don't know the ticket, the Slack thread or the dead ends you
tried. Two minutes of context saves them twenty minutes of guessing (and saves you a round of
"why did you…?" comments).

```md
## feat(reports): CSV export respects date filter

Closes #42

### What & why
The export ignored the UI date range and dumped all history (9 support tickets last week).
The endpoint now takes `from`/`to`; the frontend passes the active filter.

### How
- `ReportExportService` filters in SQL (no in-memory filtering → works for 1M rows)
- New index `ix_orders_created_at` (migration is additive, safe to deploy before code)

### How to test
1. Reports → set range to January → Export
2. File contains only January rows; empty range → header only

### Screenshots
(before / after of the filter chip)

### Risk / rollout
Low. Behind no flag; old clients that don't send the range get the previous behaviour.
```

Two conventions in that example you'll see everywhere:

- **`Closes #42`** is a GitHub/GitLab *closing keyword*: when the PR merges into the default
  branch, issue #42 is closed automatically and linked to the PR. (`Fixes` and `Resolves` work too.)
- **`feat(reports): …`** follows [Conventional Commits](https://www.conventionalcommits.org/):
  `type(scope): summary`, with types like `feat`, `fix`, `docs`, `refactor`, `test`, `chore`.
  Many teams squash-merge PRs and use the title as the commit message, and tools generate
  changelogs from it.

Checklist for authors:

- Self-review the diff first; remove debug code; run lint/tests locally.
- Keep it **small and focused** (one concern) — review quality drops sharply after a few hundred
  lines. If a feature is big, **stack** PRs: PR 2 branches off PR 1 and is reviewed while PR 1 is
  still open, so each diff stays small.
- Point reviewers to the tricky parts: *"The interesting bit is the transaction in X; the rest is plumbing."*
- Leave comments on your own PR where a decision needs context.

## Code review etiquette

Code review has two goals: **better code** and **shared knowledge**. Catching bugs is a nice side
effect — tests catch more bugs than humans do.

### Giving reviews

- **Review the code, not the person.** "This function does X" — not "you did X wrong".
- **Ask, don't command** when it's a judgment call: *"What do you think about extracting this into
  a helper? It's duplicated in `OrderService`."*
- **Label your comments** so the author knows what's blocking. Many teams use
  **Conventional Comments**:

| Prefix | Meaning |
|---|---|
| `issue:` | A concrete problem (bug, security, data loss). Add the decoration `(blocking)` / `(non-blocking)` to say whether it stops the merge, e.g. `issue (blocking): …` |
| `suggestion:` | Improvement worth considering |
| `nitpick:` (often shortened to `nit:`) | Tiny, non-blocking (naming, style) |
| `question:` | I don't understand — please explain (maybe add a comment in code) |
| `praise:` | Something done well — say it! |

- **Explain why** and link to docs or examples.
- **Automate style** — if a linter or formatter could catch it, configure the tool instead of
  commenting on it.
- **Be timely.** A review waiting two days kills flow. Many teams aim for a first response within
  a few working hours.
- **Approve with comments** when remaining points are nits — don't block on taste.

### Receiving reviews

- Assume good intent. The reviewer is spending their time to help you.
- **Don't take it personally**; the code isn't you.
- Respond to every comment: fix it, or explain why not, then resolve.
- If a thread goes back and forth more than twice, **switch to a call** — then summarise the
  decision in the PR.
- Say thanks. Seriously.

:::warn title="Review red flags"
- Rubber-stamping ("LGTM 👍" on a 1,500-line PR after 2 minutes).
- Gatekeeping on personal taste or blocking for issues unrelated to the PR.
- Sarcasm or "Why would you ever…" — it's in writing, forever, and the tone reads worse than intended.
- Requesting a full redesign at the final review instead of at the draft/design stage.
:::

:::quiz id=pro-05-q4 xp=15
Which review comment is the most helpful?
- [ ] "This is wrong."
- [ ] "Why didn't you use a dictionary like a normal person?"
- [x] "suggestion: `FindUser` loops over all users for every order — with 10k orders that's slow. A `Dictionary<Guid, User>` built once would make it O(1) per lookup. Not blocking if the list is always small?"
- [ ] "nit: I'd have done this completely differently."
> It's labelled, explains the problem and its impact, proposes a concrete fix, and asks about
> context instead of assuming. "This is wrong." gives the author nothing to act on; the
> "normal person" comment attacks the person; and the `nit:` one is mislabelled — "completely
> differently" isn't a tiny style point, and it still doesn't say *what* or *why*.
:::

## Definition of Done

The **Definition of Done (DoD)** is a team-wide checklist that applies to *every* item, on top of
its acceptance criteria. Without it, "done" means "works on my machine". Example:

```md
- [ ] Acceptance criteria met and verified by someone other than the author
- [ ] Unit/integration tests added; CI green
- [ ] Code reviewed and approved
- [ ] No new lint warnings, no TODOs without ticket
- [ ] DB migrations are backwards compatible (expand/contract, see below)
- [ ] Logs/metrics for new behaviour; feature flag if risky
- [ ] Docs/README/API docs updated
- [ ] Deployed to staging (or production) and smoke-tested
```

Acceptance criteria are *per story* ("export respects the date filter"); the DoD is *per team*
("every story is tested, reviewed and deployed").

:::quiz id=pro-05-q5 xp=10
What's the difference between acceptance criteria and the Definition of Done?
- [ ] They're the same thing with different names
- [x] AC are specific to one story; the DoD is a shared quality checklist for every story
- [ ] The DoD is written by the customer; AC by developers
- [ ] AC are only for bugs
> AC describe *what* this story must do. The DoD describes the quality bar *every* story must
> meet before anyone calls it done. They are easy to confuse because both are checklists, but a
> story can meet all its AC and still not be done (no tests, not reviewed, not deployed). Neither
> is owned by "the customer" alone: AC are agreed between the PO and the team, the DoD by the team.
:::

## On-call, incidents & postmortems

Many teams practise "you build it, you run it": developers take turns being **on call** for their
services, typically a week at a time, with a pager app (PagerDuty, Opsgenie, incident.io).

### On-call basics

- Know the **runbooks**: for each alert, what does it mean and what are the first steps?
- Have **access ready** before your shift: VPN, dashboards, logs, `kubectl` context, DB read access.
- **Acknowledge** alerts quickly, even if you don't know the fix yet.
- **Escalate early.** Paging a second person at 3am is better than a 4-hour outage.
- Alerts that wake you up but need no action are bugs — fix or delete them.

### Which alerts deserve a page: SLIs, SLOs and error budgets

On-call only works if the pager is trustworthy. A pager that fires on "CPU > 80 %" at 3 a.m.,
while every user is happy, teaches people to ignore it. So teams page on what **users feel**, and
they write that down with three terms:

- **SLI** (service level *indicator*): a measurement of user experience, as a ratio. "Share of
  checkout requests that succeed in under 500 ms."
- **SLO** (service level *objective*): the target for that SLI over a window. "99.5 % over 30 days."
- **Error budget**: what the SLO allows to fail. 0.5 % of a month is about 3.6 hours of bad
  requests. While budget is left, the team ships features; when it's burned, the team slows down
  and spends time on reliability. That turns "is it stable enough?" from an argument into a number.

A good page means *the error budget is burning fast* (users are hurting now). CPU, memory and
queue length are still useful, but on a dashboard or in a ticket, not on the pager. (An **SLA** is
the contractual promise to customers, usually looser than your internal SLO.)

:::tip title="Going deeper"
Defining SLIs, writing burn-rate alerts in Prometheus and building the dashboard that goes with
them is taught hands-on in **Observability: OpenTelemetry, Prometheus, Grafana, Loki** (Cloud-Native
Toolkit track). For your first on-call week, it's enough to know which alerts page you, which
runbook goes with each, and which dashboard shows the SLO.
:::

:::quiz id=pro-05-q9 xp=10
Your API's SLO is "99.9 % of requests succeed, over 30 days". Which alert should **page** the
on-call engineer at night?
- [ ] CPU on one API pod is above 85 % for 10 minutes
- [x] 2 % of requests have been failing for the last 15 minutes
- [ ] A Dependabot PR has been open for a week
- [ ] Disk usage on the log server reached 60 %
> Page on **symptoms users feel**. 2 % failures is twenty times the 0.1 % the SLO allows, so the
> month's error budget is burning fast, and someone has to act now. High CPU on one pod is the
> tempting answer, but by itself it hurts nobody (the other replicas may be fine, and the HPA may
> already be adding pods): that's a dashboard or ticket signal. The other two can wait until
> working hours.
:::

### During an incident

1. **Declare it** in the incident channel with a severity (SEV1 = major outage … SEV3 = minor).
2. Assign roles: an **incident commander** (coordinates, decides), a **communicator** (status page,
   stakeholders), **responders** (investigate).
3. **Mitigate first, fix later.** Roll back the deploy, flip the feature flag off, scale up, fail
   over. Root-causing comes after users are OK.
4. Keep a **timeline** in the channel: what was seen, what was tried, when.

### Postmortems (blameless)

After a significant incident, the team writes a **postmortem** (incident review). It is
**blameless**: it assumes people acted reasonably with the information they had, and focuses on
*systems* that allowed the failure.

```md
## Postmortem: Orders API 5xx for 38 minutes (SEV2)
**Impact:** 12% of checkout requests failed 14:02–14:40 UTC; ~430 orders delayed.
**Timeline:** 13:58 deploy v2.31 → 14:02 alert 5xx > 5% → 14:09 IC declared → 14:18 rollback to v2.30 (no effect) → 14:31 hotfix: column made nullable (`ALTER TABLE orders ALTER COLUMN … DROP NOT NULL`) → 14:40 recovered
**Root cause:** Migration added a NOT NULL column without default; old pods (still running v2.30
during the rolling deploy) didn't know the column, so their inserts failed.
**What went well:** Alert fired within 4 min; the schema hotfix was quick once identified.
**What went poorly:** Took 20 min to suspect the migration. Rolling back the code alone didn't help —
the schema stayed migrated, so every v2.30 pod's inserts kept failing; the runbook didn't cover rollbacks + migrations.
**Action items:**
- [ ] CI check: flag NOT NULL columns without default (owner: Ana, due 2026-11-20)
- [ ] Expand/contract migration guideline in CONTRIBUTING (owner: Sam)
- [ ] Add "recent deploys" panel to the API dashboard (owner: Lee)
```

*Expand/contract* (the second action item) means changing a schema in safe steps: first **expand**
(add the column as nullable or with a default, so old and new code both work), deploy the code
that uses it, and only later **contract** (make it required, drop the old column). You'll work
through a full expand/contract migration, run from the pipeline and survivable by a rollback, in
the **Shipping Safely** lesson later in this track.

Why blameless? If people get punished for mistakes, they hide them — and the next postmortem is
written with half the facts. Engineers who feel safe say "I ran that command because the runbook
was ambiguous", which is exactly the information you need to fix the runbook.

:::pro title="The 'five whys' — but for systems"
"The engineer ran the wrong migration" is never a root cause. Ask *why was that possible?* →
no CI check → no guideline → … Good action items change tools and processes so the next person
can't make the same mistake, rather than telling people to "be more careful".
:::

:::quiz id=pro-05-q6 xp=10
You're on call and an alert fires: error rate jumped right after today's deploy. What should you do first?
- [ ] Start reading the diff to find the exact bug before touching anything
- [x] Mitigate: roll back (or disable the feature flag), then investigate the root cause
- [ ] Wait to see if it resolves itself
- [ ] Write the postmortem
> Users first. A rollback takes minutes; finding the bug may take hours. Investigate once the
> bleeding has stopped. Reading the diff is the tempting answer because it feels responsible, but
> every minute spent reading is a minute users keep seeing errors — and the old version is still
> there to investigate after the rollback. (Acknowledging the alert and posting in the incident
> channel take seconds and come along with the rollback.)
:::

:::quiz id=pro-05-q8 xp=10
A postmortem draft says: *"Root cause: Sam ran the cleanup script against production instead of
staging."* Which action item best fits a blameless postmortem?
- [ ] Sam must take extra training on the database
- [ ] Remind everyone in the channel to be more careful with scripts
- [x] Make the script require an explicit `--env` flag and refuse to run against production without a confirmation
- [ ] Only seniors may run scripts from now on
> Blameless postmortems ask *why the system made the mistake easy*. A guard in the tool protects
> every future person, at 3 a.m., tired. Training Sam or "being careful" relies on humans never
> slipping — the most tempting answer, and the one that changes nothing. Restricting to seniors
> just moves the same risk to fewer people.
:::

:::lab id=pro-05-lab1 xp=80
title: Practise the team artefacts
Pick a feature from a project you know (or use: *"Users can invite teammates to a project by email"*,
which is the sharing feature of **BranchStory**, the app you build in the Capstone track).
Write the following in a Markdown file — this is exactly what you'll produce at work.

**1. A user story with acceptance criteria.** One story in "As a… I want… so that…" form and at least
three Given/When/Then scenarios, including one error case (invalid email, already a member, or no
permission).

**2. A split.** Your story is probably too big. Split it into 2–4 smaller **vertical** stories that each deliver
value on their own (e.g. "invite by email" / "accept invite" / "revoke invite").

**3. A PR description** for the first slice, using the template from this lesson: what & why, how,
how to test, risk/rollout, and a closing keyword.

**4. Three review comments** you might leave on such a PR, each labelled with a Conventional
Comments prefix (`issue:`, `suggestion:`, `nit:`, `question:`, `praise:`) — at least one must be
`praise:`.

**5. A mini postmortem.** Imagine invites were sent twice to every user for 2 hours after deploy.
Write impact, timeline, root cause (invent a plausible one), and two blameless action items with owners.

:::tip
If you have a team: ask a colleague to review your story and AC. If they find a question you didn't
answer, that's refinement working.
:::

- [ ] I wrote a user story with ≥3 Given/When/Then scenarios including an error case
- [ ] I split it into smaller, independently valuable stories
- [ ] I wrote a full PR description with test steps and a closing keyword
- [ ] I wrote three labelled review comments, including one praise
- [ ] I wrote a blameless mini postmortem with owned action items
:::

:::cards id=pro-05-cards1 xp=20 title="Teamwork & process"
Q: The five Scrum events?
A: Sprint (container), sprint planning, daily scrum, sprint review, sprint retrospective. (Refinement is an ongoing activity.)
Q: Product Owner vs developers?
A: The PO decides what and why (backlog order); developers decide how.
Q: What is a WIP limit for?
A: Capping items in a column to expose bottlenecks and finish work before starting more.
Q: Cycle time vs throughput?
A: Cycle time = time from start to done for one item; throughput = items finished per period.
Q: User story template?
A: As a <role>, I want <capability>, so that <benefit>.
Q: What does INVEST stand for?
A: Independent, Negotiable, Valuable, Estimable, Small, Testable.
Q: Are story points hours?
A: No — relative size (complexity, uncertainty, effort), specific to one team.
Q: What is a spike?
A: A time-boxed investigation whose output is knowledge, not a feature.
Q: Conventional Comments prefixes?
A: issue, suggestion, nitpick (nit), question, praise (also thought, chore, todo, note); decorations like (blocking) / (non-blocking) say whether it must be fixed.
Q: Acceptance criteria vs Definition of Done?
A: AC are per story; the DoD is the team-wide quality bar for every story.
Q: SLI, SLO, error budget?
A: SLI = a measured ratio of good user experiences (e.g. requests OK in < 500 ms). SLO = the target for it (99.5 % / 30 days). Error budget = the allowed failures (0.5 %); page when it burns fast.
Q: First priority in an incident?
A: Mitigate (rollback, flag off, scale) — root cause later.
Q: What makes a postmortem blameless?
A: It focuses on systems and process gaps, not individuals, assuming people acted reasonably with what they knew.
Q: A review thread has gone back and forth three times. Now what?
A: Switch to a quick call, then write the decision in the PR.
Q: Vertical vs horizontal story split?
A: Vertical = thin end-to-end slices that each deliver value (DB + API + UI, but less). Horizontal = by layer (DB / API / UI) — nothing works until all are done. Prefer vertical.
Q: What does `Closes #42` in a PR description do?
A: It's a closing keyword: merging the PR into the default branch closes issue #42 and links them.
Q: What is a Sprint Goal?
A: One sentence describing what the sprint is for — the team commits to the goal; the selected tickets are a forecast.
:::

## Recap

- **Agile** = small increments, feedback, adaptation. **Scrum** uses sprints and events;
  **Kanban** uses continuous flow and **WIP limits**.
- Stories say *who, what, why*; **acceptance criteria** make them testable (Given/When/Then).
- Estimate relatively, discuss outliers, **split anything big** into **vertical slices**; velocity
  is for the team only.
- Standups are short syncs; deep dives happen afterwards.
- PR descriptions explain **what, why, how to test, risk**. Reviews are kind, labelled, explained and timely.
- The **Definition of Done** is the shared quality bar for every item.
- On call: page on **symptoms** (SLOs and error budgets), not on CPU; acknowledge, **mitigate
  first**, escalate early; follow up with a **blameless postmortem** with owned action items.
