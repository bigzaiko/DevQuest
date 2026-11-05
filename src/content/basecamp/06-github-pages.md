---
id: bc-06
title: Publish DevQuest on GitHub Pages
level: beginner
minutes: 35
xp: 100
summary: Put this academy online at https://<you>.github.io/DevQuest/ — repo, GitHub Desktop or git, Pages via GitHub Actions, and how it works.
---

You are about to ship a real website. DevQuest itself is a **React 19 + Vite + TypeScript** app, so
publishing it is also your first deployment pipeline: push code → CI builds and tests it → the
result is served to the world.

## What GitHub Pages is

GitHub Pages is free static hosting built into GitHub. "Static" means it serves files (`.html`,
`.js`, `.css`, images) exactly as they are stored — there is **no server-side code** (no C#, no
database, nothing that runs per request). That's perfect for a Vite app: `npm run build` turns the
project into a folder of plain static files (`dist/`), and all the logic runs in the visitor's
browser. Pages just has to hand out that folder.

| Thing | DevQuest's answer |
|---|---|
| URL | `https://<username>.github.io/<repo>/` → e.g. `https://bigzaiko.github.io/DevQuest/` |
| What gets served | the `dist/` folder produced by `vite build` |
| Who builds it | a **GitHub Actions** workflow (`.github/workflows/deploy.yml`) on every push to `main` |
| Cost | free for **public** repositories |
| Limits | published site up to 1 GB; a soft bandwidth limit of 100 GB per month |
| Where your progress lives | your browser's `localStorage` — Pages never sees it |

The repo name is part of the URL: a repo called `DevQuest` is served at `/DevQuest/`, one called
`academy` at `/academy/`.

:::info title="Public vs private repositories"
On the **free** GitHub plan, Pages only publishes from **public** repositories. With GitHub Pro or
Team you can publish from a private repo, but the *website* is still public. If you want private code
*and* free hosting, connect the repo to Cloudflare Pages, Netlify or Vercel instead (they all run
`npm run build` and serve `dist/`).
:::

:::quiz id=bc-06-q1 xp=10
Why can GitHub Pages host DevQuest, but not an ASP.NET Core API?
- [ ] Pages only supports React
- [x] Pages serves static files only — there is no server process to run C# code
- [ ] ASP.NET Core apps are too big
- [ ] Pages doesn't support HTTPS
> A Vite build is just files; the browser runs the JavaScript. An API needs a running process
> (Kestrel) that executes C# for every request — that's what containers, App Service or Kubernetes
> are for (see the Containers region). "Only supports React" is wrong: Pages serves *any* static
> files (plain HTML, Vue, Blazor WebAssembly…). Size isn't the issue, and Pages serves HTTPS by default.
:::

## Two details that make Vite work on Pages

**1. The sub-path.** Your site lives at `/DevQuest/`, not at `/`. By default Vite writes absolute
asset URLs like `/assets/index-abc123.js`, which on Pages would point to
`https://<you>.github.io/assets/…` — outside your site → 404 and a blank page. DevQuest sets
`base: './'` in `vite.config.ts`, which makes every asset URL *relative* (`./assets/index-abc123.js`),
so the same build works at `/`, `/DevQuest/` or any other path.

```ts
// vite.config.ts (simplified)
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',            // or base: '/DevQuest/' for an absolute sub-path
  plugins: [react()],
})
```

**2. Client-side routing.** In a single-page app, the *browser* decides which screen to show for a
URL. If an app uses "real" URLs like `/DevQuest/lesson/fe-01`, clicking around works — but a refresh
or a shared link makes the browser ask Pages for a file at `lesson/fe-01`, which doesn't exist →
**404**. DevQuest uses **hash routing** instead: `/DevQuest/#/lesson/fe-01`. The part after `#` (the
*fragment*) is never sent to the server, so Pages always serves `index.html`, and the app reads the
hash to pick the lesson.

:::quiz id=bc-06-q2 xp=10
A teammate switches DevQuest to browser routing (`/DevQuest/lesson/fe-01` without `#`). What happens when someone refreshes a lesson page on GitHub Pages?
- [ ] It works, Pages understands React Router
- [x] GitHub Pages returns 404, because no file exists at that path
- [ ] The browser shows a CORS error
- [ ] It works, but only in Chrome
> Pages is a plain file server: it looks for a file at that path, finds none, and returns 404. It knows
> nothing about your router — routing only happens in JavaScript *after* `index.html` has loaded. Fixes:
> hash routing (what we use), or the "SPA fallback" trick of copying `index.html` to `404.html` so
> Pages serves the app for unknown paths. That trick needs an absolute `base` like `'/DevQuest/'`
> (relative `./assets` would resolve under `/lesson/`), and the response still has a 404 status, which
> search engines dislike. CORS is about cross-origin requests, not missing files.
:::

## How the deploy pipeline works

```text
 git push main ──▶ GitHub Actions: deploy.yml
                     job "build"
                     1. checkout + setup Node 24
                     2. npm ci                  (exact versions from package-lock.json)
                     3. npm run validate        (runs every challenge solution against its tests!)
                     4. npm run typecheck
                     5. npm run build           (→ dist/)
                     6. upload-pages-artifact   (packs dist/)
                     job "deploy" (needs: build)
                     7. deploy-pages ──▶ https://<you>.github.io/DevQuest/
```

If any build step fails, the deploy job never runs — the site keeps serving the **last good
version**, so visitors never see broken content. That's exactly how real teams use CI as a
**quality gate**.

### Inside `deploy.yml`

Here are the parts of the repo's workflow worth understanding (open the full file in
`.github/workflows/deploy.yml`):

```yaml
on:
  push:
    branches: [main]      # every push to main deploys
  workflow_dispatch:       # plus a "Run workflow" button in the Actions tab

permissions:
  contents: read          # read the code
  pages: write            # publish to Pages
  id-token: write         # request an OIDC token to prove "I am this repo's workflow"

concurrency:
  group: pages
  cancel-in-progress: true   # a newer push cancels an older run still in progress

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      # … checkout, setup-node, npm ci, validate, typecheck, build …
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist
  deploy:
    needs: build              # only runs if build succeeded
    runs-on: ubuntu-latest
    environment:
      name: github-pages      # shows the URL on the run and in the repo sidebar
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

Note what's **missing**: there's no stored password or token. `id-token: write` lets the job ask
GitHub for a short-lived **OIDC** token (a signed statement: "this is workflow X in repo Y on branch
`main`"), and `deploy-pages` uses it to publish. The same keyless pattern is used to deploy to Azure,
AWS or GCP from Actions — you'll meet it again in the Pro region.

:::tip title="How to read any workflow file"
Every GitHub Actions workflow has the same skeleton, so once you can read this one you can read
your team's: **`on`** = which events start it (a push, a PR, a button), **`jobs`** = units of work
that run on fresh machines (`runs-on`), in parallel unless one `needs` another, **`steps`** = what a
job does in order — either **`uses:`** (run a published action such as `actions/checkout`) or
**`run:`** (a shell command, e.g. `npm ci`). A step that exits non-zero (bc-03) fails the job, and
that red cross is what a ruleset's *required status check* (bc-05) turns into "Merging is blocked".
The Pro Skills lesson **CI with GitHub Actions** builds a full CI pipeline from scratch.
:::

:::quiz id=bc-06-q3 xp=10
Why `npm ci` instead of `npm install` in CI?
- [ ] It's faster because it skips tests
- [x] It installs exactly what `package-lock.json` says (and fails if it's out of sync) — reproducible builds
- [ ] It doesn't need internet access
> `npm ci` deletes `node_modules`, installs the exact versions from the lockfile and never changes
> it — if `package.json` and the lockfile disagree, it fails instead of guessing. `npm install` may
> resolve newer versions and rewrite the lockfile, so CI could build something you never tested.
> It still downloads packages (it needs internet or a cache), and it has nothing to do with tests.
:::

:::quiz id=bc-06-q4 xp=10
Yesterday's deploy is live. Today you push a lesson whose challenge solution fails its tests, so
`npm run validate` fails in CI. What do visitors see?
- [ ] A blank page until you fix it
- [ ] The new version, with the broken challenge
- [x] Yesterday's version — the deploy job never ran
- [ ] A GitHub "Site not found" 404 page
> The `deploy` job `needs: build`, and a failed step stops the build job, so nothing new is uploaded
> or deployed. Pages keeps serving the last successful deployment. The tempting wrong answer is
> "blank page" — but a failed pipeline doesn't *remove* anything; it just doesn't replace it.
:::

:::quiz id=bc-06-q5 xp=10
You finish five lessons on your laptop, then open your Pages site on your phone. Where is your progress?
- [ ] On the phone too — GitHub Pages stores it per user
- [x] Only on the laptop's browser — it lives in that browser's `localStorage`
- [ ] In the repo, as a commit made by the site
- [ ] Nowhere — static sites can't save anything
> `localStorage` is browser storage, per device, per browser and per *origin*. A static host has no
> database and can't write to your repo, so it never sees your progress. "Static sites can't save
> anything" is the tempting wrong one: they can — just in the visitor's browser, not on the server.
:::

## Set it up

:::lab id=bc-06-lab1 xp=60
title: Ship DevQuest to GitHub Pages
**1. Create the repository** on github.com (**+ → New repository**, name `DevQuest`, no README —
your folder already has files). Skip this if `github.com/<you>/DevQuest` already exists. It must be
**public** on the free plan.

**2. Connect your local folder and push.** Either way works:

*GitHub Desktop:* if you use Desktop, you can skip step 1 — Desktop creates the GitHub repo for you.
**File → Add local repository…** → choose the `devquest` folder (if Desktop says it isn't a
repository yet, let it create one). Commit everything ("Initial commit"), then press **Publish
repository**, keep the name `DevQuest` and **untick "Keep this code private"** (it's ticked by
default, and a private repo can't use Pages on the free plan). If you already created the repo in
step 1, *Publish repository* would fail with "name already exists" — instead set the remote under
**Repository → Repository settings… → Remote** (`https://github.com/<you>/DevQuest.git`), then press
**Publish branch** / **Push origin**.

*Terminal:*

```bash
cd devquest
git init -b main                     # skip if the folder is already a repo
git remote add origin https://github.com/<you>/DevQuest.git   # skip if `git remote -v` already shows it
git add .
git status                           # check: no node_modules/ or dist/ in the list (.gitignore)
git commit -m "feat: DevQuest academy"
git push -u origin main
```

:::info title="Pushing straight to main? Here, yes."
bc-05 says every change goes through a PR — so why push directly to `main` here? Because this is a
**solo repo with no protection yet**: you're the only contributor, there's nobody to review, and no
ruleset blocks direct pushes. That's normal for a brand-new personal repo. On a team repo (or once
you add a ruleset like the one in the bc-05 lab), the same change would go branch → PR → green
checks → merge, and the *merge* is the push to `main` that triggers the deploy.
:::

:::tip title="Push asks for a password?"
GitHub doesn't accept account passwords for Git over HTTPS. Run `gh auth login` (and answer *yes*
to "authenticate Git with your GitHub credentials"), or let Git Credential Manager / GitHub Desktop
sign you in through the browser.
:::

**3. Turn on Pages with Actions.** On github.com open the repo → **Settings → Pages** →
*Build and deployment* → **Source: GitHub Actions**. (Not "Deploy from a branch" — that would serve
the raw source files; our workflow builds and uploads `dist/` itself.)

**4. Run the pipeline.** Open the **Actions** tab. If the first run already failed because Pages
wasn't enabled yet, open it and click **Re-run all jobs** (or use **Run workflow** on "Deploy to
GitHub Pages"). The run shows two jobs: `build` (validate → typecheck → build) and `deploy`. When
both are green, the `deploy` job shows the URL.

**5. Open your site:** `https://<you>.github.io/DevQuest/`. The first deploy can take a minute to
appear.

:::tip title="Make it a nice link"
Add the URL to the repo's **About** box (gear icon on the repo home page → Website), so it shows at
the top of your repo.
:::

:::warn title="If the deploy fails"
- *"Failed to create deployment (status: 404)… Ensure GitHub Pages has been enabled"* → Pages isn't
  enabled or Source isn't "GitHub Actions" (step 3). Fix it, then re-run the workflow.
- *"Branch … is not allowed to deploy to github-pages due to environment protection rules"* → you
  ran the workflow from a branch other than `main`. Deploy from `main`.
- *Validate failed* → a lesson's challenge solution doesn't pass its tests. Run `npm run validate`
  locally; it prints the file and the failing test.
- *Blank page* → open DevTools → Console/Network. 404s on `/assets/...` mean the `base` setting was
  changed — keep `base: './'`.
:::

- [ ] The repo is public and my local folder is pushed to `main`
- [ ] Settings → Pages → Source is **GitHub Actions**
- [ ] The Actions run is green (both `build` and `deploy`)
- [ ] I opened `https://<me>.github.io/DevQuest/` and my site loads
:::

## Updating the site later

Every `git push` to `main` redeploys automatically — on a protected repo, that means every merged
PR. Locally, use:

```bash
npm install          # once, after cloning (or when dependencies change)
npm run dev          # http://localhost:5173 with hot reload
npm run validate     # check all lessons (run before pushing)
npm run build        # production build into dist/
npm run preview      # serve dist/ locally (http://localhost:4173) — the real build, like Pages will
```

Why `npm install` here when CI insists on `npm ci`? On your own machine both are fine after a fresh
clone: `npm install` also installs from `package-lock.json`, and it only changes the locked versions when
`package.json` asks for something the lockfile doesn't satisfy — which is exactly what you want when
you add or upgrade a dependency (then commit the updated lockfile). CI must never change the
lockfile, so it uses the strict `npm ci`. If your `node_modules` ever gets into a weird state,
`npm ci` is also the quickest clean reinstall.

`npm run dev` serves your source files through Vite's dev server; `npm run preview` serves the
*built* `dist/` folder. Bugs that only appear in production builds (wrong `base`, missing assets)
show up in `preview`, not in `dev` — so check it before pushing a config change.

Want to add your own lessons (e.g. XAML / Avalonia / MAUI)? Read `docs/CONTENT_FORMAT.md` and
`AGENTS.md` in the repo: a lesson is one Markdown file, and a new folder + one entry in
`src/content/tracks.ts` is a new region on the map.

:::job
At work, the same pattern deploys real products: a pipeline that **builds, tests and only then
deploys**, triggered by merging to `main`. Static frontends often go to a CDN (Azure Static Web
Apps, Cloudflare Pages, S3 + CloudFront); APIs go to containers. You just built the frontend half.
:::

:::pro title="Custom domains and the shared origin"
Every project site of one account lives on the same **origin** (`https://<you>.github.io`), so they
share `localStorage` and cookies: another of your Pages projects could read or overwrite DevQuest's
saved progress. Real products avoid that with a **custom domain** (Settings → Pages → Custom domain,
e.g. `academy.example.com`, plus a DNS `CNAME` record and *Enforce HTTPS*) — which also gives the
site its own origin and lets you use `base: '/'`.
:::

:::cards id=bc-06-cards1 xp=10 title="GitHub Pages"
Q: What does GitHub Pages serve?
A: Static files only — HTML, JS, CSS, images. No server-side code.
Q: Why does DevQuest use `base: './'` in Vite?
A: Relative asset URLs work under any sub-path like `/DevQuest/`; Vite's default absolute `/assets/…` would point outside the site.
Q: Why hash routing (`#/lesson/…`)?
A: The part after `#` never reaches the server, so refreshes/deep links never 404 on a static host.
Q: Which Pages source must be selected for our workflow?
A: **GitHub Actions** (Settings → Pages → Build and deployment).
Q: What stops broken content from being deployed?
A: The workflow runs `npm run validate` and `npm run typecheck` before building; the `deploy` job `needs: build`, so any failure stops it and the last good version stays live.
Q: Why does the workflow need `id-token: write`?
A: To get a short-lived OIDC token that proves to Pages which repo/workflow is deploying — no stored secret needed.
Q: `npm run dev` vs `npm run preview`?
A: `dev` = Vite dev server on your source with hot reload; `preview` = serves the production `dist/` build.
:::

## Recap

- GitHub Pages = free static hosting; DevQuest is static, so it fits. APIs need a real server.
- `base: './'` + hash routing make a Vite app work under `/<repo>/`.
- `.github/workflows/deploy.yml` validates, typechecks, builds and deploys on every push to `main`;
  a failure means the last good version stays live.
- Deploys use an **OIDC token** (`id-token: write`), not a stored secret.
- One-time switch: **Settings → Pages → Source: GitHub Actions**.
- Progress lives in each browser's `localStorage`, never on Pages.
