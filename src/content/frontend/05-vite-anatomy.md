---
id: fe-05
title: Anatomy of a Vite Project
level: beginner
minutes: 45
xp: 130
summary: What Vite does in dev and in build, the files of a React + TS project, HMR, env variables and modes, base paths, aliases and proxying to your ASP.NET API.
---

Browsers don't understand TypeScript, JSX or `import logo from './logo.svg'`. Something has to turn
your project into files a browser can load, and do it fast enough that you see every change
instantly. On modern React teams that something is **Vite** (French for "quick", pronounced *veet*).
Create React App is deprecated; Next.js and React Router (framework mode) are alternatives for
server-rendered apps, but a single-page app talking to an ASP.NET Core API is classic Vite territory.
(When server rendering *is* the better call is the topic of the rendering-strategies lesson — CSR vs SSR vs
SSG vs Server Components — later in this track, right after the server-state lesson.)

## What Vite actually does

Two terms first. A **bundler** takes your many source files and their imports and combines them
into a few optimised files. **ES modules** (ESM) are JavaScript's built-in module system —
`import`/`export` — which every modern browser can load natively with `<script type="module">`.

Vite has two very different jobs:

**1. Dev server (`npm run dev`).** Vite does **not** bundle your app in development. It serves your
source files as **native ES modules**: the browser requests `/src/main.tsx`, Vite transforms
*that one file* (strip TS types, compile JSX — done by a very fast Rust-based transformer, Oxc in
Vite 8) on demand and sends it back; the browser sees its `import` statements and requests those
files too. Startup is near-instant no matter how big the app is, because only the files the
current page actually imports get transformed.

Two extra tricks make that fast:

- **Dependency pre-bundling**: packages in `node_modules` (React, lodash…) are often CommonJS (the
  old Node `require()` format browsers can't load) or hundreds of tiny files. On first start Vite
  converts each dependency once into a single ESM file and caches it in `node_modules/.vite`, so
  the browser doesn't fire 600 requests for `lodash-es`. (If a dependency ever seems stale after an
  upgrade, `vite --force` rebuilds that cache.)
- **Hot Module Replacement (HMR)**: when you save a file, Vite pushes the update over a WebSocket and
  swaps just that module in the running page — no full reload. With React Fast Refresh (enabled by
  `@vitejs/plugin-react`), component **state is kept** — you edit a button's colour without losing
  the form you'd filled in.

:::warn title="Common mistake: HMR keeps doing full reloads"
Fast Refresh can only hot-swap a file that exports **only React components**. Export a constant or a
helper function from `Button.tsx` too, and Vite has to reload the page (or remount the component),
losing state. Move non-component exports to their own file — the template's ESLint rule
`react-refresh/only-export-components` warns you about exactly this.
:::

**2. Production build (`npm run build`).** Unbundled ESM is great locally, but in production
hundreds of requests and no minification would be slow. `vite build` **bundles** the app with
**Rolldown** (Vite 8's Rust-based bundler, API-compatible with Rollup, which older Vite versions
used): tree-shaking (dropping code nothing imports), code splitting at `import()` boundaries,
minification, hashed file names for caching, CSS extraction. The output is plain static files in
`dist/` that any web server or CDN can serve — no Node.js needed in production.

:::quiz id=fe-05-q1 xp=10
Why does Vite's dev server start almost instantly even for a large app?

- [ ] It caches the last production build
- [x] It serves source files as native ES modules and transforms them on demand, instead of bundling the whole app first
- [ ] It skips TypeScript entirely and runs `.ts` files directly in the browser
- [ ] It only works for small apps
> Older tools (webpack-based CRA) had to bundle everything before the first page load. Vite lets
> the browser's own module loader request files and only transforms what's actually imported.
> "Skips TypeScript" is the tempting wrong answer: browsers can't run TS, so Vite *does* strip the
> types from every file — it just doesn't type-check them. It doesn't reuse a production build
> either (dev and build are completely separate pipelines), and it's designed for large apps.
:::

## Creating a project

```bash
npm create vite@latest my-app -- --template react-ts
cd my-app
npm install
npm run dev       # → http://localhost:5173
```

(`npm create vite` runs the `create-vite` package. The `--` tells npm "the rest is for the package,
not for npm", so `--template` reaches `create-vite`. Recent versions may ask whether to install and
start right away — answering yes simply runs the next two commands for you. Use
`pnpm create vite` / `yarn create vite` / `bun create vite` if your team uses another package manager.
Vite 8 needs Node.js 20.19+ or 22.12+.)

The structure you get (details vary slightly between template versions):

```text
my-app/
├── index.html            ← the entry point (yes, HTML — see below)
├── package.json          ← scripts: dev, build, preview, lint
├── vite.config.ts        ← Vite config + plugins
├── tsconfig.json         ← references the two below
├── tsconfig.app.json     ← TS settings for your src/ code (browser)
├── tsconfig.node.json    ← TS settings for vite.config.ts (Node)
├── eslint.config.js
├── public/               ← copied as-is to dist/ (favicon, robots.txt)
└── src/
    ├── main.tsx          ← mounts React into #root
    ├── App.tsx
    ├── App.css / index.css
    ├── assets/           ← imported assets (get hashed names)
    └── vite-env.d.ts     ← types for import.meta.env + asset imports (newer templates put
                            "types": ["vite/client"] in tsconfig.app.json instead)
```

Why two tsconfigs? Your `src/` code runs in the **browser** (DOM types, no Node APIs), while
`vite.config.ts` runs in **Node** (no `document`, but `node:url`, `process`…). Separate configs give
each the right set of global types; `tsc -b` ("build mode") checks both projects.

### `index.html` is the entry

Unlike older tools, `index.html` sits in the project root and is the real entry point. Vite reads
it, finds the module script and follows the imports from there:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

```tsx
// src/main.tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

`createRoot` hands React the `#root` div; from then on React owns everything inside it. Note the
`!` (non-null assertion) — `getElementById` returns `HTMLElement | null`, and we know the div is in
`index.html`. `<StrictMode>` turns on extra development-only checks (more on it in **Components & JSX**).
The `import './index.css'` line shows that Vite lets you import CSS from JavaScript: in dev it's
injected with a `<style>` tag, in the build it's extracted into a hashed `.css` file.

### `public/` vs `src/assets/`

- `import logo from './assets/logo.svg'` → Vite processes it: the build outputs `logo-3f9a1c.svg`
  (content hash in the name, so it can be cached forever — a changed file gets a new name) and
  `logo` is the final URL string you put in `<img src={logo} />`. Small files (under 4 KiB by
  default) may be inlined as data URLs. Missing files are a **build error** — good.
- Files in `public/` are copied verbatim and referenced by absolute path (`/robots.txt`, not
  `/public/robots.txt`). Use it for files that must keep their exact name: `favicon.ico`,
  `robots.txt`, a `manifest.webmanifest`.

### The scripts

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "lint": "eslint .",
    "preview": "vite preview"
  }
}
```

Note `tsc -b &&` in `build`: **Vite itself never type-checks** — it only strips types (fast, file by
file). The `tsc -b` step is what fails the build on type errors. `vite preview` serves the built
`dist/` folder locally so you can test the real production bundle (it is *not* a production server).

:::quiz id=fe-05-q2 xp=10
You fixed a bug, `npm run dev` works, but CI's `npm run build` fails with
`TS2322: Type 'string' is not assignable to type 'number'`. Why didn't you see it in dev?

- [ ] The dev server uses an older TypeScript version
- [x] The dev server only strips types without checking them; `tsc -b` in the build script type-checks
- [ ] Type errors only exist in production mode
> Vite transforms each file in isolation and ignores types for speed — type-checking needs the whole
> program, which is exactly the slow work Vite avoids. Your editor's TS language server and `tsc` are
> the type checkers. The TypeScript version isn't the issue (Vite doesn't run `tsc` at all in dev),
> and types are identical in every mode — the error was always there, nobody checked. Many teams also
> run `tsc --noEmit` in a pre-commit hook or CI step, or use `vite-plugin-checker` to see type errors
> in the dev overlay.
:::

## Environment variables and modes

Your API lives at `http://localhost:5080` locally and `https://api.example.com` in production. You
don't want to edit code to switch between them, so the value comes from **environment variables**,
and Vite loads them from env files in the project root:

```text
.env                  # loaded in every mode
.env.local            # every mode, git-ignored (your machine only)
.env.[mode]           # only in that mode, e.g. .env.production
.env.[mode].local     # that mode, git-ignored
```

More specific files win: `.env.[mode].local` > `.env.[mode]` > `.env.local` > `.env`. Variables
already set in the shell environment win over all files.

The **mode** is a name that picks which `.env.[mode]` files load: `development` for `vite` (dev
server) and `production` for `vite build`, or whatever you pass, e.g. `vite build --mode staging`
loads `.env.staging`. Typical use: one build per environment with a different API URL.

Only variables prefixed with **`VITE_`** are exposed to your code, through `import.meta.env`:

```bash
# .env.development
VITE_API_URL=http://localhost:5080
DB_PASSWORD=hunter2         # NOT exposed to client code
```

```ts
const apiUrl = import.meta.env.VITE_API_URL   // "http://localhost:5080"
import.meta.env.MODE        // "development"
import.meta.env.DEV         // true in the dev server
import.meta.env.PROD        // true in a build (opposite of DEV)
import.meta.env.BASE_URL    // the `base` config, e.g. "/"
```

`MODE` and `PROD` are different questions. `PROD` follows `NODE_ENV`, which `vite build` sets to
`production` for **every** mode — so `vite build --mode staging` gives `MODE === 'staging'` but
`PROD === true` (minified, no dev warnings). Use `MODE` (or your own `VITE_` variable) to tell
staging from production; use `DEV`/`PROD` for "debug code on or off".

:::warn title="Everything VITE_ ends up in the browser"
At build time Vite **replaces** `import.meta.env.VITE_API_URL` with the literal string. Anyone can
read it in DevTools. The prefix exists precisely so you don't leak server secrets by accident. Never
put API keys with real privileges, connection strings or tokens in a `VITE_` variable — secrets
belong to the backend.
:::

Values are always **strings** (`VITE_PAGE_SIZE=20` gives `"20"`, so convert with
`Number(import.meta.env.VITE_PAGE_SIZE)`). Out of the box every `VITE_` variable is typed loosely; to
get autocomplete and catch typos, declare them in `src/vite-env.d.ts` (create the file if your
template doesn't have one — anything under `src/` is picked up by `tsconfig.app.json`):

```ts
/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_API_URL: string
  readonly VITE_FEATURE_CHAT?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
```

These `interface` declarations *merge* with the ones Vite ships (that's how TypeScript treats two
interfaces with the same name), so you add fields rather than replace them.

:::quiz id=fe-05-q4 xp=10
`.env.production` contains `VITE_FEATURE_CHAT=false`. What does the production build do?

```tsx
{import.meta.env.VITE_FEATURE_CHAT && <ChatWidget />}
```

- [ ] Hides the chat widget, because the variable is `false`
- [x] Shows the chat widget, because the value is the non-empty string `"false"`, which is truthy
- [ ] Fails the build, because a `VITE_` variable can't hold a boolean
> Env values are always strings, and every non-empty string is truthy in JavaScript — including
> `"false"` and `"0"`. Compare explicitly: `import.meta.env.VITE_FEATURE_CHAT === 'true'`. Nothing
> fails at build time; this is a silent logic bug, which is what makes it a classic.
:::

:::challenge id=fe-05-c1 lang=ts xp=40
title: Simulate Vite's env loading
To really understand the precedence rules, implement them. `loadClientEnv(mode, files, shell)`:

- `files` maps file names to parsed contents, e.g. `{ '.env': { VITE_A: '1' }, '.env.production': { … } }` (any file may be missing)
- merge in this order, later wins: `.env`, `.env.local`, `.env.<mode>`, `.env.<mode>.local`, then `shell` (real environment variables)
- return only keys starting with `VITE_`, plus `MODE` (the mode), `DEV` (`mode !== 'production'`) and `PROD` (`mode === 'production'`)

(The `DEV`/`PROD` rule is a simplification for this exercise — as explained above, real Vite derives
them from `NODE_ENV`, so a `--mode staging` build has `PROD: true`. The tests use the simplified rule.)

hint: ``const order = ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]``
hint: `Object.assign({}, ...order.map(f => files[f] ?? {}), shell)` merges in order.
hint: Filter with `Object.entries(...).filter(([k]) => k.startsWith('VITE_'))` and `Object.fromEntries`.

```ts starter
type EnvFiles = Record<string, Record<string, string>>

export function loadClientEnv(mode: string, files: EnvFiles, shell: Record<string, string> = {}) {
  return { ...files['.env'], MODE: mode }
}
```

```ts solution
type EnvFiles = Record<string, Record<string, string>>

export function loadClientEnv(mode: string, files: EnvFiles, shell: Record<string, string> = {}) {
  const order = ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]
  const merged: Record<string, string> = Object.assign({}, ...order.map((f) => files[f] ?? {}), shell)
  const exposed = Object.fromEntries(Object.entries(merged).filter(([k]) => k.startsWith('VITE_')))
  return { ...exposed, MODE: mode, DEV: mode !== 'production', PROD: mode === 'production' }
}
```

```ts tests
const files = {
  '.env': { VITE_TITLE: 'Shop', VITE_API_URL: 'http://localhost:5080', SECRET: 'x' },
  '.env.local': { VITE_API_URL: 'http://localhost:9999' },
  '.env.production': { VITE_API_URL: 'https://api.example.com' },
  '.env.production.local': { VITE_TITLE: 'Shop (local prod)' },
  '.env.staging': { VITE_API_URL: 'https://staging.example.com' },
}
test('development: .env.local beats .env', () => {
  expect(loadClientEnv('development', files)).toEqual({
    VITE_TITLE: 'Shop', VITE_API_URL: 'http://localhost:9999', MODE: 'development', DEV: true, PROD: false,
  })
})
test('production: mode files beat generic ones', () => {
  expect(loadClientEnv('production', files)).toEqual({
    VITE_TITLE: 'Shop (local prod)', VITE_API_URL: 'https://api.example.com', MODE: 'production', DEV: false, PROD: true,
  })
})
test('custom mode', () => {
  expect(loadClientEnv('staging', files).VITE_API_URL).toBe('https://staging.example.com')
})
test('non-VITE_ variables are never exposed', () => {
  const env = loadClientEnv('development', files, { PATH: '/usr/bin' })
  expect(env).not.toHaveProperty('SECRET')
  expect(env).not.toHaveProperty('PATH')
})
test('shell variables win', () => {
  expect(loadClientEnv('production', files, { VITE_API_URL: 'https://ci.example.com' }).VITE_API_URL).toBe('https://ci.example.com')
})
```
:::

## vite.config.ts: the settings you'll actually touch

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react()],

  // Where the app is served from. '/' by default. For https://example.com/shop/ use '/shop/'.
  base: '/',

  resolve: {
    alias: {
      // import { Button } from '@/components/Button' instead of '../../../components/Button'
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  server: {
    port: 5173,
    proxy: {
      // During dev, /api/* is forwarded to the ASP.NET Core backend.
      '/api': {
        target: 'http://localhost:5080',
        changeOrigin: true,
      },
    },
  },
})
```

**`base`** matters when the app isn't served at the domain root (GitHub Pages, a sub-path behind a
reverse proxy, an app embedded in a larger site). Vite rewrites asset URLs in the build; use
`import.meta.env.BASE_URL` when you build URLs yourself, and tell your router (`basename`).

**Aliases** are configured in two places because two different tools resolve imports: Vite (which
actually loads the file) and TypeScript (which type-checks it). Add `paths` to the **existing**
`compilerOptions` in `tsconfig.app.json`, otherwise the editor and `tsc -b` report
*Cannot find module '@/components/Button'* even though the dev server works:

```json
// tsconfig.app.json (merge into what's already there)
{
  "compilerOptions": {
    "paths": { "@/*": ["./src/*"] }
  }
}
```

(`node:url` in the config is a Node API; if TypeScript can't find its types, install them with
`npm i -D @types/node`.)

**The dev proxy** solves CORS during development. An **origin** is scheme + host + port, so
`http://localhost:5173` (your page) and `http://localhost:5080` (the API) are *different* origins.
Browsers block a page from reading responses from another origin unless that server opts in with
**CORS** headers (`Access-Control-Allow-Origin`, …). With the proxy, the browser calls
`/api/products` on *its own* origin and the Vite server forwards the request to the API — server to
server, where CORS doesn't apply. `changeOrigin: true` rewrites the `Host` header to the target's,
which some backends and virtual hosts require. Code uses relative URLs (`fetch('/api/products')`)
and works unchanged in production when a reverse proxy (nginx, YARP, a Kubernetes Ingress) routes
`/api` to the backend on the same domain.

:::quiz id=fe-05-q3 xp=10
With the proxy config above, the React app calls `fetch('/api/orders/7')` during `npm run dev`.
What happens?

- [ ] The browser calls `http://localhost:5080/api/orders/7` directly, so the API needs CORS headers
- [x] The browser calls `http://localhost:5173/api/orders/7`; Vite forwards it to `http://localhost:5080/api/orders/7`
- [ ] Vite forwards it to `http://localhost:5080/orders/7` (the prefix is stripped automatically)
- [ ] The proxy also applies to the production build in `dist/`
> A relative URL always goes to the page's own origin (`:5173`), so there's no cross-origin request
> and no CORS — the first option describes what happens *without* a proxy and with an absolute URL.
> Vite then forwards the request server-side. The path is kept as-is unless you add
> `rewrite: (p) => p.replace(/^\/api/, '')`. The proxy only exists in the dev server (and
> `vite preview`, which reuses `server.proxy`) — `dist/` is just static files, so production needs a
> real reverse proxy or CORS on the API.
:::

:::job title="The full-stack dev loop on a real team"
Typical setup: `dotnet watch` runs the API on `:5080`, `npm run dev` runs Vite on `:5173` with
`/api` proxied, both started by one command (a `docker compose up`, a `Makefile`, .NET Aspire, or
the `concurrently` package). In production the Vite build is either served by the ASP.NET app
itself (`dist/` copied to `wwwroot/`, served with `app.UseStaticFiles()` or `app.MapStaticAssets()`
plus `app.MapFallbackToFile("index.html")`) or by nginx/a CDN with `/api` routed to the backend.
Expect a `VITE_API_URL` (or just relative `/api` URLs) and a `.env.example` committed to the repo
listing every variable the app needs — never the real `.env.local`.
:::

:::pro title="SPA fallback"
A client-side router means `/orders/7` doesn't exist as a file on the server. Your production
web server must answer unknown paths with `index.html` (nginx `try_files $uri /index.html`,
ASP.NET `MapFallbackToFile`), otherwise refreshing a deep link gives a 404. `vite preview` already
does this for you, which is why "works in preview, 404 in prod" is a classic.

Caching pairs with it: serve `/assets/*` (hashed names) with
`Cache-Control: public, max-age=31536000, immutable`, but `index.html` with `no-cache`, so users
always fetch the HTML that points at the newest hashed files.
:::

:::quiz id=fe-05-q5 xp=10
The app is deployed to `https://example.com/shop/`. The page loads, but every JS and CSS request
fails with 404 for URLs like `https://example.com/assets/index-a1b2.js`. What's the fix?

- [ ] Move the files from `src/assets/` to `public/` so they keep their names
- [x] Set `base: '/shop/'` in `vite.config.ts` and rebuild
- [ ] Add a `server.proxy` entry for `/assets`
- [ ] Add `VITE_BASE_URL=/shop/` to `.env.production`
> With the default `base: '/'`, the build references assets from the domain root. `base: '/shop/'`
> makes Vite prefix every asset URL with `/shop/` (and sets `import.meta.env.BASE_URL`); remember the
> router's `basename` too. `public/` wouldn't help — those URLs are root-absolute as well. The proxy
> only exists in the dev server, not in `dist/`. And an env variable named `VITE_BASE_URL` is just a
> string your code can read; Vite's config doesn't look at it (you *could* read it in
> `vite.config.ts` yourself, but `base` is what actually changes the URLs).
:::

:::lab id=fe-05-lab1 xp=100
title: Create a React + TypeScript app with Vite
You need Node.js 20.19+ or 22.12+ — the current LTS is best (`node -v`).

**1. Scaffold and run**

```bash
npm create vite@latest devquest-shop -- --template react-ts
cd devquest-shop
npm install
npm run dev
```

Expected output (versions and timing will differ):

```text
  VITE v8.x.x  ready in 300 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
```

Open the URL. Click the counter a few times, then change the `<h1>` text in `src/App.tsx` and save.
The text updates **and the count is kept** — that's HMR + Fast Refresh.

**2. An env variable**

Create `.env.development` in the project root (next to `package.json`):

```bash
VITE_APP_TITLE="DevQuest Shop (dev)"
```

Replace the `<h1>` in `App.tsx` with `<h1>{import.meta.env.VITE_APP_TITLE}</h1>`. Then type it: open
`src/vite-env.d.ts` (create it if your template doesn't have one) and make it:

```ts
/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_APP_TITLE: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
```

Env values are read when the server starts. Vite notices changes to `.env` files and restarts the
dev server itself (watch the terminal for "server restarted"); if the heading doesn't update, stop it
with `Ctrl+C` and run `npm run dev` again. The heading now reads **DevQuest Shop (dev)**.

**3. A fake backend + proxy**

Create `api.mjs` in the project root — a tiny API using only Node built-ins:

```js
import { createServer } from 'node:http'
createServer((req, res) => {
  if (req.url === '/api/products') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify([{ id: 1, name: 'Keyboard' }, { id: 2, name: 'Mouse' }]))
  } else { res.writeHead(404); res.end() }
}).listen(5080, () => console.log('API on http://localhost:5080'))
```

Run it in a **second** terminal with `node api.mjs` (it prints `API on http://localhost:5080`). Add
the proxy to `vite.config.ts` and restart `npm run dev` (config changes also need a restart, though
Vite usually restarts itself when it notices one):

```ts
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: 'http://localhost:5080', changeOrigin: true },
    },
  },
})
```

Check it from a third terminal — the request goes to **Vite's** port and still reaches the API:

```bash
curl http://localhost:5173/api/products
# [{"id":1,"name":"Keyboard"},{"id":2,"name":"Mouse"}]
```

Now fetch in `App.tsx` and render the names. Add `useEffect` to the existing React import
(`import { useEffect, useState } from 'react'`), then inside `App`:

```tsx
const [products, setProducts] = useState<{ id: number; name: string }[]>([])
useEffect(() => {
  fetch('/api/products').then((r) => r.json()).then(setProducts)
}, [])
// … and somewhere in the returned JSX:
<ul>{products.map((p) => <li key={p.id}>{p.name}</li>)}</ul>
```

(Effects get a full lesson later — this is just to prove the proxy works.) The page lists
*Keyboard* and *Mouse*. In DevTools → Network, the request goes to `localhost:5173`, not `5080`.

**4. An alias**

Add the `resolve.alias` block from the config above to `vite.config.ts` (including the
`node:url` import) and the `paths` entry to `tsconfig.app.json`. Then move the fetch into
`src/api/products.ts`:

```ts
export type Product = { id: number; name: string }

export async function getProducts(): Promise<Product[]> {
  const res = await fetch('/api/products')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}
```

and use it in `App.tsx` with `import { getProducts } from '@/api/products'` and
`useEffect(() => { getProducts().then(setProducts) }, [])`. The list still loads, and hovering the
import in your editor shows no error.

**5. Build and preview**

```bash
npm run build
npm run preview
```

`npm run build` first runs `tsc -b` (any type error stops here), then prints the files it wrote —
something like `dist/index.html`, `dist/assets/index-<hash>.css`, `dist/assets/index-<hash>.js`.
`npm run preview` serves `dist/` on **http://localhost:4173**.

Open `dist/index.html` in an editor and find the `<script type="module" crossorigin src="/assets/index-….js">`
Vite injected. In the preview the heading is **empty**: the build runs in `production` mode, so
`.env.development` isn't loaded. Create `.env.production` with
`VITE_APP_TITLE="DevQuest Shop"`, run `npm run build` again, and the preview shows it. (The product
list also works in preview, because `vite preview` reuses `server.proxy` — a real production server
wouldn't.)

:::tip
If port 5173 is taken, Vite picks the next free one — read the URL it prints. `npm run dev -- --host`
exposes the dev server on your LAN, handy for testing on a phone.
:::

- [ ] `npm run dev` runs, and editing `App.tsx` hot-updates without losing the counter state
- [ ] The heading shows `VITE_APP_TITLE` from `.env.development`
- [ ] `curl http://localhost:5173/api/products` returns the JSON, and the page lists Keyboard and Mouse (Network tab shows `localhost:5173/api/products`)
- [ ] `@/api/products` resolves in both Vite and the editor (no red squiggle)
- [ ] `npm run build` succeeds and `npm run preview` serves the built app on port 4173
- [ ] After adding `.env.production` and rebuilding, the preview shows the production title
:::

:::cards id=fe-05-cards1 xp=15 title="Vite essentials"
Q: How does Vite's dev server serve code?
A: As native ES modules, transformed on demand per file; dependencies are pre-bundled once into node_modules/.vite.
Q: What does `vite build` use?
A: Rolldown (Vite 8; Rollup-compatible) to bundle, tree-shake, code-split and minify into dist/.
Q: Does Vite type-check?
A: No. It strips types. `tsc -b`/`tsc --noEmit` (or your editor) does the checking.
Q: What is the entry point of a Vite app?
A: `index.html` in the project root, which loads `/src/main.tsx` as a module script.
Q: Which env variables reach client code?
A: Only `VITE_`-prefixed ones, via `import.meta.env`. They're inlined at build time — never secrets.
Q: Env file precedence?
A: Shell env > `.env.[mode].local` > `.env.[mode]` > `.env.local` > `.env`.
Q: What is `base` for?
A: The public path the app is served from (e.g. `/shop/`); Vite prefixes asset URLs with it.
Q: Why use `server.proxy`?
A: To forward `/api` from the Vite origin to the backend in dev — no CORS, same relative URLs as production.
Q: `public/` vs `src/assets/`?
A: `public/` is copied verbatim (fixed names); imported assets are processed and get content-hashed names.
Q: `MODE` vs `PROD`?
A: `MODE` is the name passed with `--mode` (picks the .env files). `PROD` is true for any `vite build`, even `--mode staging`.
Q: What type are env values?
A: Always strings. `VITE_FLAG=false` is the truthy string `"false"` — compare with `=== 'true'`.
:::

## Recap

- Dev: native ESM + on-demand transforms + pre-bundled deps + HMR. Build: Rolldown bundle into `dist/`.
- `index.html` is the entry; `main.tsx` mounts React with `createRoot`.
- Vite strips types but doesn't check them — keep `tsc` in your build/CI.
- Env files by mode; only `VITE_` variables are exposed, they are strings, and they are public.
- `base`, `resolve.alias` (+ tsconfig `paths`) and `server.proxy` are the config you'll touch most.
- `vite preview` tests the production build locally; real servers need an SPA fallback.
