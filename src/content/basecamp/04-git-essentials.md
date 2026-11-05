---
id: bc-04
title: Git Essentials
level: intermediate
minutes: 50
xp: 120
summary: The Git mental model, branching, merge vs rebase, resolving conflicts, stash, reset vs revert, reflog rescues and good commit messages.
---

Git is the one tool every developer on your team uses dozens of times a day. Most Git fear comes from
memorising commands without a **mental model**. Once you know what Git actually stores, commands
like `rebase`, `reset` and `reflog` stop being scary — and you can rescue yourself (and colleagues)
from almost anything.

:::tip title="Two layers: everyday Git and Git rescue"
This is the densest lesson in Basecamp. The everyday parts — the mental model and the everyday loop
at the start, plus stash, `.gitignore` and good commit messages further down — are what you need
from day one. The Git-rescue parts in between (merge vs rebase, conflicts, reset modes, reflog) are
**intermediate**: read them once now, then come back the first time a rebase or a reset goes wrong.
Nobody memorises them on the first pass.
:::

## The mental model: three places and a graph

Why does Git have a "staging" step at all, when other tools just save? Because a good commit is a
*deliberate* package: you often have five things changed on disk but only want to record two of them
together. So your changes move through three areas:

```text
 working tree          index (staging area)          repository (.git)
 your files on disk -> what goes in the next commit -> commits, forever
      edit                git add                        git commit
```

- **Working tree** — the actual files you edit.
- **Index / staging area** — a draft of the next commit. `git add` copies a file's *current* content
  here. This is why you can commit *part* of your changes (`git add -p` picks individual hunks), and
  why editing a file again after `git add` means you have to `add` it again.
- **Repository** — the `.git` folder: every commit ever made, as a graph.

A **commit** is a snapshot of the whole project (not a diff!) plus metadata: author, date, message,
and a pointer to its **parent** commit(s). Its id (the **SHA**, e.g. `b81e7d4…`) is a hash of all of
that — change anything, even the message, and you get a different id. That is why commits are
immutable: "changing" a commit always means creating a new one. Git shows diffs by comparing a
snapshot with its parent's snapshot.

**Refs** are just names pointing at commits:

- A **branch** (`main`, `feat/12-login-form`) is a movable pointer to one commit. Committing on a branch
  moves that pointer forward to the new commit.
- **HEAD** means "where you are now". Normally it points at a branch (the one you have checked out).
  If it points directly at a commit (e.g. after `git switch --detach <sha>` or checking out a tag),
  you are in **detached HEAD**: new commits there belong to no branch — create one with
  `git switch -c <name>` if you want to keep them.
- **Tags** (`v1.4.0`) are pointers that don't move — used to mark releases.
- **Remote-tracking branches** (`origin/main`) are your local memory of where the remote's branches
  were at your last `fetch`. They only change when you talk to the remote.

```text
          C---D   <- feat/12-login-form  <- HEAD
         /
  A---B---E       <- main, origin/main
```

Here you are on `feat/12-login-form` (HEAD), which has two commits (`C`, `D`) that `main` doesn't have,
and `main` has one (`E`) that your branch doesn't have.

Creating a branch costs nothing: it writes a tiny file containing one commit id (40 hex characters).
No files are copied. That's why teams create a branch for every change. Branch names in this course
follow the common `type/issue-short-description` convention (`feat/12-login-form`,
`fix/88-checkout-total`) that bc-05 explains.

### Naming commits: SHAs, `HEAD~1` and friends

Many commands take a commit as an argument. You can name it by:

- its SHA — the first 7+ characters are enough: `git show b81e7d4`
- a ref: `main`, `origin/main`, `v1.4.0`, `HEAD`
- a relative position: `HEAD~1` = the parent of HEAD, `HEAD~3` = three commits back,
  `main~2` = two commits before `main`.

:::quiz id=bc-04-q1 xp=10
What exactly is a Git branch?
- [ ] A copy of all the project's files in a separate folder
- [ ] A list of diffs that are applied on top of main
- [x] A movable named pointer to a single commit
- [ ] A remote repository on GitHub
> A branch is just a ref: a name → one commit id. The history comes from that commit's parent
> pointers. That's why creating a branch is instant and copies nothing. "A list of diffs on top of
> main" is the tempting wrong answer: it describes how a branch *looks* in a PR, but Git stores
> snapshots and parent links, not a diff list owned by the branch.
:::

## The everyday loop

```bash
git status                      # what's changed, what's staged, which branch — run it constantly
git diff                        # working tree vs index (unstaged changes)
git diff --staged               # index vs last commit (what you're about to commit)
git add src/Login.tsx           # stage one file
git add -p                      # stage hunk by hunk — review while you stage
git commit -m "feat(auth): add login form"
git log --oneline --graph --decorate --all   # the graph, readable
git show HEAD                   # what the last commit changed
```

Working with the remote (the shared copy, usually on GitHub, conventionally named `origin`):

```bash
git clone git@github.com:acme/shop.git
git fetch                       # download new commits, move origin/* — touches none of your files
git pull                        # fetch + integrate origin/<branch> into your current branch
git push -u origin feat/12-login-form   # first push of a new branch; -u sets the upstream so
                                        # plain `git push` / `git pull` know where to go later
```

`fetch` is always safe — it only updates `origin/*`. `pull` also changes your branch (by merging or
rebasing, depending on config), which is where conflicts can appear. When in doubt: `git fetch`,
look at `git log --oneline --graph --all`, then decide.

Modern commands for branches and files (Git split the overloaded `checkout` into two clearer ones):

```bash
git switch -c feat/12-login-form   # create a branch at HEAD and switch to it
git switch main                    # switch branches
git restore src/App.tsx            # discard unstaged changes to a file (careful: gone for good)
git restore --staged src/App.tsx   # unstage, keep the changes in the working tree
git branch -d feat/12-login-form   # delete a merged branch (-D forces, even if unmerged)
```

:::tip title="Make the log readable"
`git config --global alias.lg "log --oneline --graph --decorate --all"` — then `git lg`. Most
editors (VS Code's Source Control graph, GitLens, Rider's Git log) show the same graph visually.
:::

## Merge vs rebase

Your branch `feature` started from `main`, and meanwhile `main` moved on. Sooner or later the two
lines of work have to be combined. There are two ways to do that.

**Merge** creates a new *merge commit* (`M`) with two parents. History shows exactly what happened,
in the order it happened.

```text
git switch main && git merge feature

  A---B---E---F---M   <- main
       \         /
        C-------D     <- feature
```

:::info title="Fast-forward: the merge that isn't"
If `main` has **not** moved since you branched, there is nothing to combine: Git simply slides the
`main` pointer forward to your last commit — a **fast-forward**, no merge commit. The reverse matters
for `git push`: the remote only accepts a push that is a fast-forward of what it has. If the remote
branch has commits yours doesn't contain, the push is rejected as **non-fast-forward**.
:::

**Rebase** replays your commits on top of the new base, creating **new** commits (`C'`, `D'` — same
changes, new parents, therefore new ids). History becomes a straight line. The old `C` and `D` still
exist for a while but no branch points at them any more.

```text
git switch feature && git rebase main

  A---B---E---F            <- main
               \
                C'---D'    <- feature
```

| | Merge | Rebase |
|---|---|---|
| History | True, with merge commits | Linear, "as if you started today" |
| Rewrites commits? | No | Yes — new ids |
| Safe on shared branches? | Yes | Only on branches nobody else builds on |
| Conflicts | Resolved once | Possibly once per replayed commit |

:::warn title="The golden rule of rebasing"
Never rebase commits that others have already pulled (e.g. `main`, or a branch a colleague is also
working on). You'd replace commits they have with different ones, and their next pull becomes a mess.
Rebasing **your own** feature branch before opening or updating a PR is normal and fine — then push
with `git push --force-with-lease`, which refuses to overwrite remote commits you haven't seen (it
compares against your `origin/<branch>`, so a background auto-fetch by your editor can defeat it; add
`--force-if-includes` to close that gap). One exception: once teammates are reviewing your PR, prefer
adding new commits over rebasing and force-pushing, or say so in the PR — bc-05 explains why.
:::

:::job title="What teams actually do"
Most teams use short-lived feature branches and merge via pull requests (bc-05). The PR's merge
button decides the final shape: **merge commit**, **squash** (all PR commits become one commit on
main — very common), or **rebase and merge**. Locally, many devs set
`git config --global pull.rebase true` so `git pull` on their branch replays local commits on top
instead of creating noisy "Merge branch 'main'" commits. Check the team's CONTRIBUTING guide for the
convention.
:::

:::quiz id=bc-04-q2 xp=10
You rebased your feature branch onto the latest `main` and `git push` is rejected
("non-fast-forward"). Nobody else works on your branch. What do you do?
- [ ] `git pull` and merge the remote branch back in
- [x] `git push --force-with-lease`
- [ ] Delete the remote branch on GitHub and push again
- [ ] `git push --force` to main
> Rebase created new commits, so the remote branch still has the *old* copies, which your branch no
> longer contains — that's why the push isn't a fast-forward. `--force-with-lease` replaces the remote
> branch, but only if it is still where you last fetched it. `git pull` is the tempting wrong answer:
> it would merge the old copies back in and you'd end up with every commit twice. Deleting the remote
> branch would close your open PR, and force-pushing `main` rewrites everyone's shared history.
> (If the PR is already in review, add a fix-up commit instead of rebasing, or tell your reviewers
> before you force-push — see bc-05.)
:::

## Resolving conflicts

A conflict happens when both sides changed the **same lines** (or one side deleted a file the other
edited). Git merges everything it can automatically and stops, marking the rest in the file:

```text
export function priceLabel(cents: number) {
<<<<<<< HEAD
  return `€${(cents / 100).toFixed(2)}`
=======
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(cents / 100)
>>>>>>> feat/31-intl-prices
}
```

- Between `<<<<<<<` and `=======`: **ours** — `HEAD`, the branch you're on. During
  `git switch main && git merge feat/31-intl-prices`, that's `main`.
- Between `=======` and `>>>>>>>`: **theirs** — what's coming in (`feat/31-intl-prices`).

Resolving means: edit the file into the version you actually want (often a combination of both),
delete **all three** marker lines, then tell Git it's resolved:

```bash
git status                  # lists conflicted files as "both modified"
# … edit files, run the build and tests …
git add src/price.ts        # "add" = mark as resolved
git commit                  # merge: creates the merge commit (accept the default message)
git rebase --continue       # rebase: continues with the next commit instead
git merge --abort           # or bail out completely and return to before the merge
git rebase --abort          # same for a rebase
```

:::warn title="Ours and theirs flip during rebase"
During a **rebase**, Git first moves `HEAD` to the branch you're rebasing *onto* (e.g. `main`) and
then replays your commits one by one. So "ours" is `main` and "theirs" is your own commit being
replayed — and `git checkout --ours file` means "take main's version". When unsure, read the
content, not the labels.
:::

:::pro title="Fewer, smaller conflicts"
Conflicts grow with branch age. Keep branches short-lived (hours to a couple of days), bring `main`
into them often, avoid mass reformatting in feature PRs (do it in a separate, agreed PR), and turn on
`git config --global rerere.enabled true` — Git then remembers how you resolved a conflict and
reapplies it next time. A 3-way merge view (VS Code's merge editor, Rider) helps a lot.
:::

:::quiz id=bc-04-q3 xp=10
You're in the middle of a merge with three conflicted files and realise you merged the wrong
branch. What's the clean way out?
- [ ] Delete the `.git` folder and clone again
- [x] `git merge --abort`
- [ ] Commit the conflict markers and fix it in the next commit
- [ ] `git stash`
> `git merge --abort` puts the branch, index and working tree back to exactly how they were before
> the merge started. `git stash` sounds plausible but doesn't cancel the merge — Git refuses to stash
> while files are still conflicted. Committing conflict markers breaks the build for everyone, and
> deleting `.git` throws away all unpushed work.
:::

## Stash: put work aside

You're halfway through something and need to switch branches for an urgent fix. Switching with
half-done changes either drags them along to the other branch or is refused. A **stash** is a shelf
for uncommitted changes:

```bash
git stash push -m "wip: login validation"    # saves tracked changes (staged + unstaged), cleans the working tree
git stash push -u -m "incl. new files"       # -u also stashes untracked (new) files
git stash list                               # stash@{0}: On feat/12-login-form: wip: login validation
git switch fix/88-checkout-total             # do the urgent work
git switch feat/12-login-form
git stash pop                                # reapply and drop it from the stash
git stash apply                              # reapply but keep a copy in the stash
```

Without `-u`, brand-new files that were never `git add`ed stay in the working tree and travel with
you to the other branch — a classic surprise. If `pop` hits a conflict, Git keeps the stash entry so
nothing is lost; resolve, then `git stash drop`. By default `pop`/`apply` restore everything as
unstaged changes; use `git stash pop --index` to restore what was staged as staged.

:::tip
Stashes are easy to forget. For anything longer than a quick context switch, a real WIP commit on
your branch (`git commit -m "wip"`, squash or amend later) is safer — it's pushed, backed up, and
visible. Or use `git worktree add ../shop-hotfix main` to get a second working folder for another branch.
:::

## Undoing things: amend, restore, reset, revert

First ask one question: **has anybody else got this commit yet** (is it pushed to a shared branch)?
If not, you may rewrite history. If yes, add a new commit that undoes it instead.

| Situation | Command | Rewrites history? |
|---|---|---|
| Typo in the last commit message | `git commit --amend -m "fix: new message"` | Yes (last commit) |
| Forgot a file in the last commit | `git add file && git commit --amend --no-edit` | Yes (last commit) |
| Discard unstaged changes in a file | `git restore file` | No (but changes are gone) |
| Unstage a file | `git restore --staged file` | No |
| Undo the last commit, keep changes staged | `git reset --soft HEAD~1` | Yes |
| Undo the last commit, keep changes unstaged | `git reset HEAD~1` (`--mixed`, the default) | Yes |
| Throw away the last commit **and** all uncommitted changes | `git reset --hard HEAD~1` | Yes — dangerous |
| Undo a commit that is already on `main` / pushed | `git revert <sha>` | No — adds a new "inverse" commit |

`reset` **moves the current branch pointer** to another commit (the three modes only differ in what
happens to the index and working tree). `revert` keeps history and adds a commit that applies the
opposite changes — the only polite way to undo something others have already pulled.

```text
reset:   A---B---C   main        ->   A---B   main   (C is no longer on the branch)
revert:  A---B---C   main        ->   A---B---C---R  main   (R undoes C)
```

:::warn title="--hard also wipes work you never committed"
`git reset --hard` resets the working tree too: **every** uncommitted change in every tracked file
is discarded, not just the ones from the last commit. Committed work can be found again (see reflog
below); uncommitted work cannot. Run `git status` first, and stash or commit anything you care about.
:::

:::quiz id=bc-04-q4 xp=10
A commit that broke checkout was merged to `main` an hour ago; three colleagues have pulled since.
How do you undo it?
- [ ] `git reset --hard HEAD~1` on main and force-push
- [x] `git revert <sha>` and push (ideally via a PR)
- [ ] Delete the commit on GitHub
- [ ] `git commit --amend` on main
> Shared history should not be rewritten. `revert` creates a new commit that inverts the bad one, and
> everyone simply pulls it. `reset --hard` + force-push is the tempting one because it makes the commit
> "disappear" — but your colleagues still have it, so their next pull re-introduces it or conflicts,
> and any commits pushed after it are lost too. (For reverting a merge commit you'd use
> `git revert -m 1 <sha>` to say which parent is the "main line".)
:::

:::quiz id=bc-04-q6 xp=10
You have uncommitted edits in `cart.ts` and `api.ts`. You meant to undo only your last commit, but
typed `git reset --hard HEAD~1`. What can `git reflog` bring back?
- [ ] Both the last commit and the uncommitted edits
- [x] The last commit — but not the uncommitted edits
- [ ] Only the uncommitted edits
- [ ] Nothing — `--hard` deletes the commit permanently
> The reflog records where HEAD has been, so the "lost" commit's SHA is right there and
> `git reset --hard <sha>` (or `git branch rescue <sha>`) restores it. The uncommitted edits were
> never stored in any commit or stash, so Git has no copy — that's the trap. If the edits had been
> `git add`ed, fragments might still be found with `git fsck --lost-found`, but don't count on it.
:::

## Reflog: the safety net

"I did `reset --hard` and lost my commits!" — almost always recoverable. Git keeps a **reflog**: a
local diary of every position HEAD (and each branch) has been at. Entries are kept for 90 days by
default (30 days for commits no branch can reach any more).

```bash
git reflog
# 3f2a9c1 HEAD@{0}: reset: moving to HEAD~2
# b81e7d4 HEAD@{1}: commit: feat: add coupon codes      <- the "lost" work
# 9c04aa2 HEAD@{2}: commit: test: coupon edge cases

git branch rescue b81e7d4     # put a branch on it — saved
# or: git reset --hard b81e7d4   to move your current branch back there
```

Commits aren't deleted when no branch points at them — they become *unreachable* and are only
garbage-collected much later. The reflog is **local only**: it's not pushed, and a fresh clone has
an empty one. What reflog **cannot** save: changes that were never committed or stashed. Hence the
habit: **commit early, commit often** (you can always squash later).

:::pro
Before any scary operation (big rebase, history rewrite), create a backup pointer:
`git branch backup/before-rebase`. Costs nothing; delete it when you're happy.
:::

## .gitignore: keep junk and secrets out

Why bother? Build output and `node_modules/` are huge, machine-specific and regenerated anyway;
editor files differ per person; and `.env` files contain secrets. A `.gitignore` lists patterns Git
should not track. For this stack:

```text
# dependencies & builds
node_modules/
dist/
bin/
obj/
*.tsbuildinfo

# editors & OS
.vs/
.idea/
.vscode/*
!.vscode/extensions.json
!.vscode/settings.json
.DS_Store
Thumbs.db

# env & secrets
.env
.env.*
!.env.example
appsettings.*.local.json

# test & coverage output
coverage/
TestResults/
playwright-report/
```

A trailing `/` matches directories only, `*` is a wildcard, and a leading `!` re-includes something
an earlier pattern excluded (so `.env.example`, a template without real values, *is* committed).

`dotnet new gitignore` generates a thorough .NET one; GitHub's `github/gitignore` repo has templates
for everything. Note: `.gitignore` only affects **untracked** files. If a file is already committed,
ignoring it does nothing until you `git rm --cached path` and commit (removes it from the repo,
keeps it on disk). For local .NET secrets, prefer `dotnet user-secrets`, which stores them outside
the repo folder entirely.

:::warn title="A committed secret is a leaked secret"
Deleting a committed `.env` in the next commit does not remove it from history — anyone with the
repo can still read it. Treat the secret as compromised: **rotate it** first, then clean history if
needed. Pro-02 covers secret handling in depth.
:::

:::quiz id=bc-04-q7 xp=10
`appsettings.Development.json` was committed months ago. Today you add it to `.gitignore`, edit it,
and run `git status`. What do you see?
- [x] It still shows as modified — `.gitignore` doesn't apply to files Git already tracks
- [ ] Nothing — the file is now ignored
- [ ] Git deletes the file from the repository on the next commit
- [ ] An error, because an ignored file can't be tracked
> `.gitignore` only stops *untracked* files from being added. A tracked file stays tracked, so your
> edit shows up as usual. To stop tracking it: `git rm --cached appsettings.Development.json`, commit,
> and keep the `.gitignore` entry. And if it ever contained secrets, rotate them — they're in history.
:::

## Good commit messages

The diff shows *what* changed; the message explains **why**. Future you, reading `git blame` at 2 a.m.
during an incident, will thank you.

```text
fix(cart): keep coupon when quantity changes

Changing the quantity re-created the cart DTO and dropped the applied
coupon, so customers saw the full price at checkout.

Copy the coupon code when rebuilding the DTO and add a regression test.

Closes #482
```

- Subject line: imperative mood ("add", not "added" — it completes "If applied, this commit will …"),
  ≤ ~72 chars (50 is the classic ideal), no full stop.
- Blank line, then a body explaining the problem and the reasoning.
- Reference the issue/ticket (`Closes #482`, `PROJ-1234`).
- One logical change per commit — easier to review, revert and bisect.

**Conventional Commits** is a widely used convention: `type(scope): subject`.

| Type | Use for |
|---|---|
| `feat` | A new feature (→ minor version bump) |
| `fix`, `perf` | A bug fix / a speed-up (→ patch bump; semantic-release's default releases `perf` as a patch) |
| `docs`, `test`, `refactor`, `style` | Docs, tests, restructuring, formatting — no release by default |
| `build`, `ci`, `chore` | Tooling, pipelines, dependency bumps |
| `feat!:` or a `BREAKING CHANGE:` footer | Breaking change (→ major bump) |

Tools like **semantic-release**, **release-please** and **commitlint** read these to generate
changelogs and version numbers automatically — that's why many teams enforce them.

:::quiz id=bc-04-q5 xp=10
Which commit messages follow Conventional Commits and good practice? (select all that apply)
- [x] `fix(api): return 404 instead of 500 for unknown project id`
- [ ] `fixed stuff`
- [x] `feat(web): add dark mode toggle`
- [ ] `WIP final final v2`
- [x] `refactor(orders): extract price calculation into PriceService`
> The three correct ones have a type, an optional scope, and an imperative subject that says what
> and where. "fixed stuff" has no type and tells the reader nothing; WIP commits are fine locally but
> should be squashed or reworded before merging.
:::

:::lab id=bc-04-lab1 xp=100
title: Branch, conflict, rescue
Create a throwaway repo and walk through the whole toolbox. Set up the `lg` alias first
(`git config --global alias.lg "log --oneline --graph --decorate --all"`) and run `git lg` after
every step to watch the graph change.

```bash
mkdir git-dojo && cd git-dojo && git init -b main   # -b main: don't depend on the default branch name
printf 'export const greeting = "Hello"\n' > greet.ts
git add greet.ts && git commit -m "feat: add greeting"

# branch A changes the line
git switch -c feat/formal-greeting
printf 'export const greeting = "Good day"\n' > greet.ts
git commit -am "feat: formal greeting"

# main changes the same line
git switch main
printf 'export const greeting = "Hi there"\n' > greet.ts
git commit -am "feat: casual greeting"

git merge feat/formal-greeting
```

The merge stops with:

```text
Auto-merging greet.ts
CONFLICT (content): Merge conflict in greet.ts
Automatic merge failed; fix conflicts and then commit the result.
```

1. **Merge conflict:** open `greet.ts`, look at the markers (`"Hi there"` is ours, `"Good day"` is
   theirs), decide on a final version (e.g. `"Good day"`), remove all marker lines, then
   `git add greet.ts` and `git commit --no-edit`. `git lg` now shows a merge commit with two parents.
2. **Rebase instead:** undo the merge with `git reset --hard HEAD~1` (main goes back to "casual
   greeting"), then `git switch feat/formal-greeting && git rebase main`. Resolve the same conflict — note
   that now `"Hi there"` (main) is "ours" — then `git add greet.ts` and
   `git -c core.editor=true rebase --continue` (skips the message editor). Compare the graph with
   step 1: no merge commit, and "formal greeting" has a new SHA.
3. **Stash:** edit `greet.ts` without committing, `git stash push -m "wip"`, check that
   `git status` is clean, `git switch main`, `git switch feat/formal-greeting`, `git stash pop`.
   Then `git restore greet.ts` to discard the edit.
4. **Revert:** `git switch main`, make a commit you regret (e.g. append a line and
   `git commit -am "feat: oops"`), then `git revert --no-edit HEAD`. Both commits stay in the log and
   the file is back to before.
5. **Rescue:** make two more commits, run `git reset --hard HEAD~2`, then find them with `git reflog`
   and restore them with `git branch rescue <sha>` (use the SHA of the newer one).
   `git lg` shows the `rescue` branch with both commits.
6. Add a `.gitignore` with `node_modules/` and `.env`, create both
   (`mkdir node_modules && touch node_modules/lib.js .env` — Git ignores empty folders anyway, so put a
   file inside), and confirm `git status` lists only `.gitignore` as untracked.
7. Commit it sloppily (`git add .gitignore && git commit -m "stuff"`), then reword it into
   Conventional Commits style with `git commit --amend -m "chore: ignore node_modules and env files"`.

- [ ] I resolved a merge conflict and can explain ours vs theirs
- [ ] I resolved the same conflict during a rebase and saw the linear history
- [ ] I stashed and restored work-in-progress
- [ ] I undid a commit with `git revert` and know why it's safe on shared branches
- [ ] I recovered "lost" commits with `git reflog`
- [ ] `.gitignore` keeps `node_modules/` and `.env` out of `git status`
- [ ] My last commit message follows `type(scope): subject`
:::

:::cards id=bc-04-cards1 xp=20 title="Git essentials"
Q: The three areas in Git?
A: Working tree (files on disk), index/staging area (the next commit's draft), repository (commits in `.git`).
Q: What is a commit?
A: An immutable snapshot of the whole project plus author, message and parent pointer(s), identified by a SHA hash.
Q: What is HEAD?
A: "Where you are": a pointer to the current branch (or directly to a commit in "detached HEAD").
Q: What does `HEAD~2` mean?
A: The commit two steps back from HEAD (the grandparent, following first parents).
Q: fetch vs pull?
A: `fetch` downloads commits and updates `origin/*` only; `pull` = fetch + merge/rebase into your current branch.
Q: What is a fast-forward?
A: When the target hasn't diverged, Git just moves the branch pointer forward — no merge commit. Pushes must be fast-forwards unless forced.
Q: Merge vs rebase in one sentence each?
A: Merge joins histories with a merge commit (no rewriting). Rebase replays your commits on a new base, creating new commits and a linear history.
Q: The golden rule of rebasing?
A: Don't rebase commits others already have. Rebase your own branch, then `push --force-with-lease` — unless a review is in progress (then add commits, or tell reviewers first; see bc-05).
Q: Ours vs theirs during a rebase?
A: Flipped: "ours" is the branch you rebase onto (e.g. main), "theirs" is your commit being replayed.
Q: reset vs revert?
A: `reset` moves the branch pointer back (rewrites history — local only). `revert` adds a new commit that undoes one (safe on shared branches).
Q: reset --soft / --mixed / --hard?
A: All move the branch. Soft keeps changes staged, mixed keeps them unstaged, hard discards them — including any other uncommitted work.
Q: How do you recover commits after a bad reset?
A: `git reflog` to find the old SHA, then `git branch rescue <sha>` or `git reset --hard <sha>`.
Q: A file is committed but now in .gitignore — why is it still tracked?
A: .gitignore only affects untracked files. Run `git rm --cached <file>` and commit.
Q: Conventional Commits format?
A: `type(scope): subject`, e.g. `fix(api): handle empty cart`. `feat` → minor, `fix` → patch, `!`/BREAKING CHANGE → major.
Q: `--force` vs `--force-with-lease`?
A: `--force-with-lease` only overwrites the remote branch if it's still where you last fetched it, so you won't accidentally wipe a colleague's new commits.
:::

## Recap

- Git = working tree → index → commits; branches and HEAD are just **pointers** to commits.
- Name commits by SHA, ref or relative position (`HEAD~1`).
- **Merge** preserves history; **rebase** rewrites your own branch into a straight line — never rebase shared commits.
- A push must be a **fast-forward**; after rebasing your own branch use `--force-with-lease`.
- Conflicts: edit to the intended result, remove markers, `add`, then `commit` / `rebase --continue` (or `--abort`).
- `stash` for quick context switches; **reset** for local undo, **revert** for shared history.
- **Reflog** rescues almost anything that was ever committed — so commit often. `reset --hard` destroys uncommitted work for good.
- Keep secrets and build output out with `.gitignore`; write `type(scope): why` commit messages.
