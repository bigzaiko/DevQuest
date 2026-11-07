---
id: bc-05
title: GitHub Flow & Pull Requests
level: intermediate
minutes: 45
xp: 100
summary: How teams actually ship on GitHub — issues, branches, pull requests, reviews, branch protection, CODEOWNERS and the gh CLI.
---

Git is the tool on your machine. **GitHub** is where your team meets: it stores the shared
repository, but more importantly it hosts the *conversation* around code — issues, pull requests,
reviews, automated checks. On a new job you will spend as much time in pull requests as in your
editor, so learning the workflow well pays off from day one.

This lesson covers the workflow almost every product team uses (**GitHub flow**), the anatomy of a
good pull request, how protection rules keep `main` safe, and the `gh` command-line tool that lets
you do all of it without leaving the terminal.

:::info title="What you need now vs later"
The flow, issues, branch names, PR anatomy and reviews are everyday skills from week one. The
sections on **protection rules, rulesets, merge queues and CODEOWNERS** are repo *administration* —
usually set up by a lead or the platform team. As a newcomer you mainly need to **read** them: why a
PR says "Merging is blocked", and why certain reviewers were requested automatically.
:::

## GitHub flow in one picture

GitHub flow is deliberately simple. There is one long-lived branch — `main` — and it is **always
deployable**. Every change, no matter how small, goes through the same loop:

```text
main ──●──────────────●────────────●──▶   (always green, always deployable)
        \            /            /
         ●──●──●────●  feat/42-export-csv
              │
          push → open PR → CI runs → review → fixes → approve → merge → deploy
```

1. **Pick or create an issue** that describes the problem.
2. **Create a branch** from an up-to-date `main` (`git switch main && git pull`, then
   `git switch -c feat/42-export-csv`).
3. **Commit** in small, meaningful steps and **push** early.
4. **Open a pull request** (often as a *draft* while you are still working).
5. **CI runs** — *continuous integration*: an automated pipeline (usually GitHub Actions) that
   builds, lints, tests and scans the code on every push. Each job reports a **status check**
   (green tick or red cross) on the PR.
6. **Review**: teammates comment, you respond and push fixes.
7. **Merge** once approved and green. The branch is deleted.
8. **Deploy** — often automatically from `main`.

Why does this work so well? Because every change is small, reviewed and tested *before* it touches
`main`. If something breaks, it is one small PR to revert, not a three-week merge of a "develop"
branch.

:::info title="GitHub flow vs Git Flow"
**Git Flow** (with `develop`, `release/*`, `hotfix/*` branches) was popular for software shipped in
versions, like desktop apps. Most web teams today use **GitHub flow** or **trunk-based development**
(even shorter branches, feature flags for unfinished work). If your new team uses Git Flow, the
concepts in this lesson still apply — PRs just target `develop` instead of `main`.
:::

:::quiz id=bc-05-q1 xp=10
In GitHub flow, what is true about `main`?
- [ ] It is only updated once per sprint, at release time
- [x] It should always be in a deployable state; changes arrive through reviewed PRs
- [ ] Developers push directly to it for small fixes
- [ ] It is a backup; real work happens on `develop`
> The whole flow is built around a `main` that is always green, because anything on `main` may be
> deployed at any moment. Pushing small fixes directly is the tempting exception — but skipping
> review and CI "because it's just a typo" is exactly how production gets broken on a Friday.
> A `develop` branch and release-time updates belong to Git Flow, not GitHub flow.
:::

## Issues: the "why" behind the code

An **issue** is a unit of work or a bug report. It is where the *why* lives, so that six months
later somebody running `git blame` can follow a link from the commit to the discussion.

A good issue contains:

- **Title** that states the problem or outcome: *"CSV export ignores date filter"*, not *"export bug"*.
- **Context / user story**: who needs this and why.
- **Steps to reproduce** (for bugs): exact steps, expected vs actual, screenshots, browser/OS.
- **Acceptance criteria**: a checklist that says when it is done.
- **Labels** (`bug`, `feature`, `good first issue`, `priority:high`), an **assignee** and often a
  **milestone** or **project board** column.

```md
### Bug: CSV export ignores date filter

**Steps**
1. Go to /reports, set range 2026-01-01 → 2026-01-31
2. Click "Export CSV"

**Expected:** only January rows. **Actual:** all rows since 2024.

**Acceptance criteria**
- [ ] Export uses the same filter as the table
- [ ] Unit test covers the date range
```

:::job title="Many teams use Jira or Linear instead"
Plenty of companies track work in Jira, Linear or Azure Boards and only use GitHub for code. The
habits are the same: one ticket per change, the ticket key in the branch name and PR title
(`ABC-123`), and the integration links them automatically. Ask on day one: "Where do tickets live,
and how do you link them to PRs?"
:::

## Branch names

A naming convention makes branches sortable, searchable and linkable to tickets. Common ones:

| Pattern | Example |
|---|---|
| `type/issue-short-description` | `feat/42-csv-export`, `fix/57-login-redirect` |
| `ticket-description` | `ABC-123-csv-export` |
| `username/description` | `ana/csv-export` |

Short, lowercase, hyphens, and the issue number. That's it. Check `CONTRIBUTING.md` — the
convention is often written down there.

## Pull requests: the heart of the workflow

A **pull request (PR)** says: *"Here is a branch. Please review it and merge it into `main`."*
GitHub shows the diff, runs checks, and gives everyone a place to comment line by line. Every new
push to the branch updates the PR automatically — you never "re-open" it.

### Anatomy of a good PR

```md
## Export CSV respects the date filter  (closes #42)

### What
The export endpoint now receives `from`/`to` from the UI and filters in SQL.

### Why
Users exported years of data by accident (#42); support got 9 tickets last week.

### How to test
1. `npm run dev` and `dotnet run` in /api
2. Reports → pick January → Export → file has only January rows

### Notes
- Added an index on `orders(created_at)`; migration is backwards compatible.
- Screenshot of the new filter chip below.
```

The rules of thumb:

- **Small.** A few hundred changed lines review well. 2,000 lines get rubber-stamped or ignored.
- **One concern per PR.** Don't mix a refactor, a feature and a dependency bump.
- **Self-review first.** Open the "Files changed" tab and read your own diff before asking anyone.
  You will catch debug logs, commented-out code and typos.
- **Explain the why**, link the issue, give test steps, add screenshots for UI.
- **Keep it green.** Don't request review while CI is red.

### Linking issues

If the PR description (or a commit message) contains a closing keyword followed by an issue
reference, GitHub closes the issue when the PR merges into the **default branch** (usually `main`):

```text
Closes #42
Fixes #57, fixes #58
Resolves octo-org/api#12      ← issue in another repo
```

Keywords: `close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves`, `resolved`
(case doesn't matter). Each issue needs its own keyword — `Fixes #57, #58` only closes #57. Writing
just `#42` (without a keyword) only *mentions* it: a cross-reference appears in the issue's timeline,
which is what you want for "related to". A PR that targets a non-default branch (e.g. `develop`)
does not close issues on merge.

:::quiz id=bc-05-q2 xp=10
Your PR description says `Related to #42`. What happens to issue #42 when the PR is merged into `main`?
- [ ] It is closed automatically
- [x] Nothing — it is mentioned/cross-referenced but stays open
- [ ] It is moved to the "Done" column and locked
- [ ] GitHub refuses to merge until #42 is closed
> Only closing keywords (`closes`, `fixes`, `resolves` …) directly before the issue reference close
> it on merge. "Related to" isn't one of them, so #42 just gets a cross-reference in its timeline —
> exactly what you want for "this is part of #42". Moving board columns is a project automation
> setting, not something a mention does.
:::

### Draft pull requests

Open a PR as a **draft** when you want CI feedback or early eyes on the direction, but it is not
ready to merge. Drafts can't be merged and don't automatically request reviews from code owners.
When ready, click **Ready for review** (or `gh pr ready`).

:::pro title="Open the draft early"
Seniors often push a draft PR after the first meaningful commit with a short note: *"Approach: add
a filter param to the export service, not the controller — shout if that's wrong."* Five minutes of
early feedback beats three days of work in the wrong direction.
:::

### Merge strategies

When you click the green button you usually get three choices (the repo admin may restrict them):

| Strategy | What lands on `main` | Good for |
|---|---|---|
| **Create a merge commit** | All branch commits + a merge commit | Keeping full history of the branch |
| **Squash and merge** | One new commit containing the whole PR | Clean, linear history; most popular for product teams |
| **Rebase and merge** | Each commit replayed on top of `main`, no merge commit | Linear history while keeping individual commits |

With **squash**, the commit message of a multi-commit PR is pre-filled from the PR title (plus the
PR number, e.g. `feat(reports): export respects date filter (#87)`); for a single-commit PR GitHub
uses that commit's message unless the repo is set to always use the PR title. Either way: another
reason to write good titles in Conventional Commits style. Your messy "fix typo" commits on the branch never reach `main`.

:::quiz id=bc-05-q6 xp=10
Your PR has 6 commits: `wip`, `more wip`, `fix tests`, `fix typo`, `address review`, `lint`. The repo
uses **Squash and merge**. What does `main` get?
- [ ] All six commits, in order, plus a merge commit
- [x] One new commit with all the changes, titled from the PR title
- [ ] All six commits replayed on top of `main` without a merge commit
- [ ] Only the last commit, `lint`
> Squash combines the whole PR diff into **one** new commit on `main`, so the branch's messy history
> disappears and the PR title becomes the commit subject. Six commits plus a merge commit is
> "Create a merge commit"; six replayed commits is "Rebase and merge". The *last commit only* would
> lose the other five commits' changes — no strategy does that.
:::

## Reviews

A reviewer can leave three kinds of review:

- **Comment** — feedback without a verdict.
- **Approve** — "good to merge".
- **Request changes** — when approvals are required, this blocks merging until that reviewer
  approves or their review is dismissed.

You can't approve your own PR — reviews have to come from someone else. GitHub also supports
**suggestions**: the reviewer proposes exact replacement code in a comment, and you click
**Commit suggestion**. You respond to each thread, push fixes, and click **Resolve conversation**
when done. Re-request review with the circular-arrows icon next to the reviewer's name.

This section is written from the author's side. The other side — **reviewing a teammate's PR**: what
to look for, how to phrase comments, when to approve — is covered in the Pro Skills lesson
**Teamwork, Agile & Code Review**.

:::warn title="Don't force-push over an active review without saying so"
Rewriting history (`git push --force-with-lease` after a rebase) makes GitHub's "changes since last
review" view less useful and can orphan comments. During review, prefer adding fix-up commits (they
disappear anyway with squash merge); if you must rebase, say so in a comment. Never use plain
`--force` on a shared branch — `--force-with-lease` refuses if someone else pushed in the meantime.
:::

## Protecting `main`: rules and required checks

Without protection, anyone with write access can push straight to `main` — skipping review and CI.
Teams configure **branch protection rules** or the newer **rulesets** (Settings → Rules → Rulesets)
for `main`. Typical settings:

- **Require a pull request before merging** — no direct pushes.
- **Require approvals** — e.g. 1 or 2 approving reviews.
- **Dismiss stale approvals when new commits are pushed** — approving an old version doesn't count.
- **Require review from Code Owners** (see below).
- **Require status checks to pass** — pick the CI jobs that must be green (e.g. `build`, `test`,
  `lint`). These are the **required checks**.
- **Require branches to be up to date before merging** — your branch must include the latest `main`,
  so checks ran against what will actually be merged. (Busy repos use a **merge queue** instead,
  which tests each PR combined with the ones queued ahead of it.)
- **Require conversation resolution**, **require signed commits**, **block force pushes**.

When a PR shows *"Merging is blocked"*, read the box at the bottom of the PR: it lists exactly which
rule isn't satisfied yet.

:::quiz id=bc-05-q3 xp=15
Which of these does a typical branch protection rule / ruleset on `main` enforce? (Select all that apply.)
- [x] Changes must come through a pull request
- [x] Specific CI checks must pass before merging
- [x] A minimum number of approving reviews
- [ ] The PR author approves their own PR before merging
- [ ] Only the repo owner may open pull requests
> PR-required, approvals and required status checks are the core three. GitHub never counts an
> author's approval of their own PR — the whole point of a review is a second pair of eyes. And
> rules control what may be *merged*, not who may *open* a PR: anyone with access can open one.
:::

:::quiz id=bc-05-q7 xp=10
`main` requires 1 approval and has **Dismiss stale approvals when new commits are pushed** enabled.
Ana approves your PR, then you push one more commit fixing a typo. What happens?
- [ ] The PR can still be merged — Ana already approved it
- [x] Ana's approval is dismissed; the PR needs a fresh approval before it can merge
- [ ] The new commit is rejected because the PR is already approved
- [ ] GitHub merges the PR automatically
> With stale-approval dismissal, any new commit invalidates earlier approvals, because the reviewer
> approved a different version of the code. "It's only a typo" is the tempting reasoning — but GitHub
> can't know that, and that rule exists precisely so nobody can sneak changes in after approval.
:::

## CODEOWNERS

Why? In a big repo you want the right experts to see changes to "their" code automatically, without
the author having to know who they are. A `CODEOWNERS` file (in `.github/`, the repo root or `docs/`)
maps path patterns to the people or teams responsible for them. Code owners are **automatically
requested** for review when a PR touches their files, and with "Require review from Code Owners"
their approval is mandatory. GitHub reads the CODEOWNERS file from the PR's **base** branch (usually
`main`), so a CODEOWNERS file added in a PR only takes effect for later PRs, after it's merged.

```text
# .github/CODEOWNERS — later lines win when several patterns match
*                       @acme/maintainers
/web/                   @acme/frontend
/api/                   @acme/backend
/api/Migrations/        @acme/backend @acme/dba
*.tf                    @acme/platform
/.github/workflows/     @acme/platform
```

The important rule: **the last matching pattern takes precedence** (it *replaces* earlier matches,
it doesn't add to them). So a change in `/api/Migrations/2026_add_index.cs` needs
`@acme/backend @acme/dba`, not `@acme/maintainers`. That's why the catch-all `*` goes **first**.

:::quiz id=bc-05-q4 xp=15
With the `CODEOWNERS` file above, who is auto-requested for a PR that only changes `web/src/App.tsx`?
- [ ] `@acme/maintainers` only
- [x] `@acme/frontend`
- [ ] Both `@acme/maintainers` and `@acme/frontend`
- [ ] Nobody — `.tsx` files aren't listed
> The last matching pattern wins. Both `*` and `/web/` match, and `/web/` comes later, so only
> `@acme/frontend` owns that file. "Both" is the tempting answer, but CODEOWNERS matches don't
> accumulate — a later match replaces earlier ones.
:::

:::quiz id=bc-05-q8 xp=10
Spot the bug: a teammate "tidied up" CODEOWNERS like this. What's the effect?

```text
/web/      @acme/frontend
/api/      @acme/backend
*          @acme/maintainers
```

- [ ] Nothing — the order of lines doesn't matter
- [x] `@acme/maintainers` now owns every file; frontend and backend are never auto-requested
- [ ] The file is invalid and GitHub ignores it
- [ ] Each PR now needs approval from all three teams
> `*` matches every file and it is the **last** line, so it wins for every path and replaces the
> specific owners above it. The fix is to put the catch-all first and the more specific paths below it.
:::

## Forks vs branches

There are two ways to propose a change:

| | **Branch in the same repo** | **Fork** |
|---|---|---|
| Who | Team members with write access | Anyone (open source, external contributors) |
| Where | `origin/feat/42-…` | Your own copy: `you/project`, PR back to `upstream` |
| CI secrets | Available (careful!) | Not exposed to fork PRs by default |
| Typical at work | Almost always | Rare (sometimes for inner-source across orgs) |

A **fork** is your own server-side copy of someone else's repository. At work you will usually just
push branches to the company repo. For open source you **fork**, clone your fork (it becomes
`origin`), add the original as `upstream`, and keep in sync:

```bash
git remote add upstream https://github.com/original/project.git
git fetch upstream
git switch main && git merge upstream/main   # or: gh repo sync
```

Secrets aren't given to workflows triggered by PRs from forks for a good reason: otherwise anyone
could open a PR that prints your deploy keys.

## The `gh` CLI

`gh` is GitHub's official CLI. It is the fastest way to do everyday GitHub tasks, and it's great
for scripts. Install it (`winget install GitHub.cli`, `brew install gh`, or your Linux package
manager), then run `gh auth login` once — it opens the browser to authenticate and can also set up
Git to push over HTTPS with that login.

```bash
# Repos
gh repo clone acme/shop               # clone with auth set up
gh repo view --web                    # open the repo in the browser

# Issues
gh issue list --assignee @me
gh issue create --title "CSV export ignores date filter" --label bug
gh issue view 42

# Branch + PR
git switch -c fix/42-csv-date-filter
# ...commit...
git push -u origin HEAD               # HEAD = "the branch I'm on"
gh pr create --draft --fill           # title/body from commits; --fill-first, --web also exist
gh pr ready                           # mark draft as ready for review
# or, in one go, with an explicit title/body:
gh pr create --title "fix(reports): export respects date filter" --body "Closes #42" --reviewer ana

# Reviewing others
gh pr list --search "review-requested:@me"
gh pr checkout 87                     # check out someone's PR locally to run it
gh pr diff 87
gh pr review 87 --approve             # or --request-changes -b "…", --comment -b "…"

# Status & merging
gh pr status                          # your PRs, their checks and reviews
gh pr checks --watch                  # live CI status
gh pr merge --squash --delete-branch  # or --auto to merge once requirements are met (repo setting "Allow auto-merge" must be on)
gh run list                           # recent GitHub Actions runs
gh run view --log-failed              # logs of the failed steps only
```

Commands like `gh pr ready`, `gh pr checks` and `gh pr merge` act on the PR for your **current
branch** if you don't pass a number, URL or branch name.

:::pro title="gh pr checkout is a review superpower"
Reading a diff isn't the same as running it. `gh pr checkout 87 && npm run dev` lets you click
through a UI change in two commands. Reviewers who actually run the code catch the bugs that a
diff hides.
:::

:::quiz id=bc-05-q5 xp=10
You want to run a colleague's PR #87 on your machine to test it. Fastest way?
- [ ] Download the diff from the browser and `git apply` it
- [x] `gh pr checkout 87`
- [ ] `git clone` the repo again into a new folder
- [ ] Ask them to send you a zip
> `gh pr checkout` fetches the PR's head (even from a fork) into a local branch and switches to it,
> so you get the exact commits — and `git pull` later picks up their new pushes. Applying a downloaded
> diff works but gives you an untracked copy that goes stale; recloning is slow and still doesn't
> check out the PR branch for you.
:::

:::lab id=bc-05-lab1 xp=80
title: Your first full GitHub flow loop
You will run the whole loop on a throwaway repository you own. It takes about 15 minutes. You need
`git` and `gh` installed.

**1. Create a repo and clone it.** It's public so rulesets work on the free plan (it only contains a
README — nothing secret).

```bash
gh auth login                                  # once
gh repo create devquest-flow --public --clone --add-readme
cd devquest-flow
```

**2. Protect `main`.** In the browser: **Settings → Rules → Rulesets → New ruleset → New branch
ruleset**. Name it `main`, set *Enforcement status* to **Active**, under *Target branches* click
**Add target → Include default branch**, then enable **Require a pull request before merging**
(leave *Required approvals* at **0** — you can't approve your own PR) and **Block force pushes**.
Click **Create**.

**3. Create an issue**

```bash
gh issue create --title "Add a CONTRIBUTING guide" --body "We need branch naming and PR rules written down."
```

It prints the issue URL ending in `/issues/1`.

**4. Branch, commit, push, draft PR**

```bash
git switch -c docs/1-contributing
printf '# Contributing\n\n- Branches: type/issue-description\n- PRs: small, linked to an issue\n' > CONTRIBUTING.md
git add CONTRIBUTING.md
git commit -m "docs: add contributing guide"
git push -u origin HEAD
gh pr create --draft --title "docs: add contributing guide" --body "Closes #1"
```

It prints the PR URL, ending in `/pull/2` (issues and PRs share one number sequence).

**5. Add a CODEOWNERS file** on the same branch and watch the PR's diff update (it only takes effect
for future PRs, once it's on `main` — so nobody is auto-requested on this one):

```bash
mkdir -p .github
printf '* @<your-username>\n' > .github/CODEOWNERS
git add .github/CODEOWNERS && git commit -m "chore: add CODEOWNERS" && git push
```

**6. Review yourself.** Open the PR in the browser (`gh pr view --web`), go to **Files changed**,
leave a line comment on the diff, then **Resolve conversation**. Mark it ready: `gh pr ready`.

**7. Try to push to `main` directly** and read the error — that's protection working:

```bash
git switch main
echo "direct edit" >> README.md
git commit -am "docs: direct edit"
git push
```

The push is rejected with something like:

```text
remote: error: GH013: Repository rule violations found for refs/heads/main.
remote: - Changes must be made through a pull request.
 ! [remote rejected] main -> main (push declined due to repository rule violations)
```

Undo the local commit with `git reset --hard origin/main`.

**8. Squash-merge** the PR (you are on `main` now, so name the branch):

```bash
gh pr merge docs/1-contributing --squash --delete-branch
git pull
git log --oneline -3     # one squash commit: "docs: add contributing guide (#2)"
```

:::tip
`gh pr status` and `gh issue view 1` show the state at any time. After the merge, issue #1 should be
closed automatically because of `Closes #1`.
:::

- [ ] A draft PR was opened from a properly named branch and marked ready
- [ ] The PR body linked the issue with a closing keyword
- [ ] A `.github/CODEOWNERS` file exists on `main` after the merge
- [ ] A direct push to `main` was rejected by the ruleset
- [ ] The PR was squash-merged and issue #1 closed automatically
:::

:::cards id=bc-05-cards1 xp=15 title="GitHub flow"
Q: The golden rule of GitHub flow?
A: `main` is always deployable; every change goes branch → PR → checks → review → merge.
Q: Draft PR — why use one?
A: To get CI and early feedback on direction without it being mergeable or auto-requesting code owners.
Q: Which words in a PR body close an issue on merge?
A: close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved + `#number` — only when merged into the default branch.
Q: What is a required status check?
A: A CI job that branch protection says must pass before the PR can be merged.
Q: What does "dismiss stale approvals" do?
A: Any new commit invalidates earlier approvals, so the reviewed version is the merged version.
Q: CODEOWNERS: which rule wins when several match?
A: The last matching pattern in the file — so the catch-all `*` goes first.
Q: Squash vs merge commit?
A: Squash lands the whole PR as one commit (PR title = message); merge commit keeps all branch commits plus a merge commit.
Q: Fork or branch at work?
A: Usually a branch in the company repo. Forks are for contributing to repos you can't write to.
Q: `--force` vs `--force-with-lease`?
A: `--force-with-lease` refuses to overwrite the remote if someone else pushed since your last fetch. Never plain `--force` on shared branches.
Q: How do you test a colleague's PR locally?
A: `gh pr checkout <number>` and run it.
:::

## Recap

- **GitHub flow**: issue → branch → small commits → (draft) PR → CI → review → squash-merge → deploy.
- Good PRs are **small, single-purpose, self-reviewed**, explain *what/why/how to test*, and link
  issues with **closing keywords**.
- **Branch protection / rulesets** require PRs, approvals and **required status checks** on `main`;
  stale approvals can be dismissed on new pushes.
- **CODEOWNERS** auto-requests the right reviewers; the last matching pattern wins.
- Use **branches** at work, **forks** for repos you can't write to.
- `gh` does it all from the terminal: `gh pr create`, `gh pr checkout`, `gh pr checks --watch`, `gh pr merge --squash`.
