---
id: fe-28
title: "Rendering Strategies: CSR, SSR, SSG & Server Components"
level: advanced
minutes: 80
xp: 150
summary: How HTML actually reaches the screen — CSR, SSR, SSG/ISR, streaming and React Server Components — and how to pick the right one (and the right host) for a real project.
---

Everything you have built so far in this region is a **Vite single-page app**: the server sends an
almost empty `index.html`, the browser downloads JavaScript, and React builds the page *in the
browser*. That is one valid answer to the question "where and when does the HTML get made?" — but
not the only one. Next.js, React Router's framework mode and React Server Components give other
answers, and job ads increasingly mention them.

This lesson gives you a mental model for all of them, so that "should we use SSR?" stops being a
matter of taste and becomes a decision you can argue for with requirements: who needs to see the
content, how fresh it must be, whether it's per-user, and what you are able to host.

## The one question: where and when is the HTML made?

Every rendering strategy is an answer to two questions:

1. **Where** does React turn components into HTML — in the user's browser or on a server?
2. **When** does that happen — at build time, on each request, or "once, then reuse for a while"?

| Strategy | Where | When | What the first response contains |
|---|---|---|---|
| **CSR** (client-side rendering — a Vite SPA) | Browser | Every page view | An empty `<div id="root">` + `<script>` tags |
| **SSG** (static site generation) | Build server | At `npm run build` | Finished HTML for every page |
| **ISR** (incremental static regeneration) | Server | Build, then again at most every *N* seconds | Cached finished HTML, refreshed in the background |
| **SSR** (server-side rendering) | Server | Every request | Finished HTML for *this* request |
| **Streaming SSR** | Server | Every request, sent in chunks | The page shell immediately, slow parts later in the same response |
| **RSC** (React Server Components) | Server (build or request) | Per component, not per page | HTML + a serialized component tree; only *client* components ship JS |

Hold on to the first two columns. Everything else in this lesson — SEO, speed, caching, hosting,
cost — follows from them.

## CSR: the Vite SPA you already know

Here is what a Vite production build sends for *every* URL (you'll see this yourself in the lab):

```html
<!doctype html>
<html lang="en">
  <head>
    <title>Project Board</title>
    <script type="module" crossorigin src="/assets/index-B4x9kQ2a.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-Dk3mP1ws.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
```

The timeline of a first visit looks like this:

```text
browser ── GET /projects/42 ──────────────▶ static host
        ◀── index.html (empty root) ───────          TTFB: fast (it's a static file)
        ── GET /assets/index-B4x9.js ──────▶
        ◀── 250 kB of JavaScript ───────────          parse + execute
        React renders a spinner
        ── GET /api/projects/42 ───────────▶ ASP.NET Core API ──▶ PostgreSQL
        ◀── JSON ───────────────────────────
        React renders the real page                  LCP: late (after 3 round trips)
```

**Why teams pick it anyway:**

- **Hosting is trivial.** `dist/` is a folder of static files: any CDN, S3 bucket, nginx container or
  the `wwwroot` of your ASP.NET Core app. No Node.js process to run, patch, scale or monitor.
- **Clean separation.** The frontend is a static bundle; the backend is an HTTP API. Each team can
  deploy independently, and the same API serves a mobile app too.
- **After the first load it's fast.** Navigation is client-side (see *Routing with React Router*)
  and the server only sends JSON.

**What it costs:**

- **The first meaningful paint waits for JavaScript and data.** On a slow phone this is seconds.
- **Anything that doesn't run JavaScript sees nothing.** Googlebot does render JavaScript (with
  delay), but link-preview bots (Slack, Teams, LinkedIn, WhatsApp), many SEO tools and some search
  engines read only the raw HTML. Your `<title>` is the same for every URL unless you do extra work.
- **Data-fetching waterfalls** are easy to create: HTML → JS → fetch → render child → child fetches…

:::info title="CSR still has a server"
"No server rendering" doesn't mean "no server". A Vite SPA in production still needs something that
serves `index.html` for every unknown path (the SPA fallback from *Routing with React Router*) and an
API. With ASP.NET Core that can be one process: `app.MapStaticAssets(); app.MapFallbackToFile("index.html");`
next to your API endpoints.
:::

## SSR: run React on the server per request

With SSR, the server runs your components for each request and sends real HTML:

```text
browser ── GET /products/42 ──────────────▶ Node server ──▶ API / DB (fast, same datacenter)
        ◀── full HTML with product data ───          TTFB: slower (server had to work)
        page is visible                              LCP: early
        ── GET /assets/*.js ───────────────▶
        React "hydrates" — the page becomes interactive
```

Under the hood it's React's server API — frameworks call this for you:

```tsx
// server.tsx — roughly what Next.js / React Router framework mode do per request
import { renderToPipeableStream } from 'react-dom/server'

// app.use = "every path" (Express 5 no longer accepts a bare '*' route pattern)
app.use((req, res) => {
  const { pipe } = renderToPipeableStream(<App url={req.url} />, {
    bootstrapScripts: ['/assets/client.js'], // the JS that will hydrate this HTML
    onShellReady() {
      res.setHeader('Content-Type', 'text/html')
      pipe(res) // start sending HTML now
    },
    onShellError() {
      res.status(500).send('<h1>Something went wrong</h1>')
    },
  })
})

// client.tsx — runs in the browser. <App> renders the whole <html> document here,
// which is why we hydrate `document` instead of a <div id="root">.
import { hydrateRoot } from 'react-dom/client'
hydrateRoot(document, <App url={location.pathname} />)
```

Notice the **same `<App>`** runs twice: once on the server to produce HTML, once in the browser to
take it over. That "twice" is the source of every hydration problem below.

The trade-off: **TTFB** (time to first byte) gets *worse*, because the server must fetch data and
render before it can answer, but **LCP** (largest contentful paint — when the main content is
visible, from *React Performance*) usually gets *better*, because the content is in the first
response instead of after three round trips. And crawlers and link previews see real content and
per-page `<title>`/`<meta>` tags.

The cost is operational: you now run a **Node.js server** that executes your React code on every
request. It has to scale with traffic, it can crash, it has cold starts, and a slow API call now
slows down the HTML for everyone.

## Hydration: making server HTML interactive

The HTML from SSR is a picture of your app: it looks right, but buttons do nothing yet. Then the
JavaScript arrives and `hydrateRoot` runs. **Hydration** means React renders your components *again*
in the browser, but instead of creating DOM nodes it walks the existing ones and **attaches event
handlers and state** to them.

That only works if the browser render produces *exactly the same* output as the server render.
If it doesn't, you get a **hydration mismatch**: React 19 reports it as a recoverable error (in
development with a diff of what differed), throws away the server HTML up to the **nearest
`<Suspense>` boundary** (or the whole root, if there is none) and re-renders that part from scratch
on the client. The user sees a flicker, you lose the SSR benefit for that subtree, and you pay for
rendering twice. Wrapping risky widgets in their own `<Suspense>` keeps the damage local.

### The usual suspects

Anything whose value depends on *where* or *when* the render happens:

| Code in render | Why it differs | Fix |
|---|---|---|
| `Math.random()`, `crypto.randomUUID()` | Different number on each run | `useId()` for ids; generate data on the server and pass it down |
| `Date.now()`, `new Date()` | Server rendered seconds (or days, with SSG) earlier | Pass the timestamp from the server, or render time in an effect |
| `toLocaleString()`, `Intl.DateTimeFormat()` with no locale/time zone | Server is in UTC/`en-US`, user is in `Europe/Berlin`/`de-DE` | Pass an explicit locale *and* `timeZone`, or format on the client after mount |
| `typeof window !== 'undefined' ? A : B` | Server renders B, client renders A | Render B on both, switch to A in `useEffect` |
| `localStorage`, `window.innerWidth`, `navigator.language` | Don't exist on the server | Read in an effect, or use `useSyncExternalStore` with a `getServerSnapshot` |
| Invalid HTML nesting (`<p><div/></p>`, `<a>` in `<a>`) | The browser's HTML parser "repairs" the server HTML before React sees it | Write valid HTML |

The standard pattern for "this can only be known in the browser" is a **two-pass render**: render the
server-safe version first, then update after hydration.

```tsx
function LocalTime({ iso }: { iso: string }) {
  // Pass 1 (server AND first client render): identical, deterministic output
  const [text, setText] = useState(() => iso.slice(11, 16) + ' UTC')

  useEffect(() => {
    // Pass 2: only runs in the browser, after hydration
    setText(new Date(iso).toLocaleTimeString())
  }, [iso])

  return <time dateTime={iso}>{text}</time>
}
```

:::warn title="`suppressHydrationWarning` is not a fix"
`<time suppressHydrationWarning>` silences the warning for that one element's own attributes and
text (one level deep, not its children). It's acceptable for a timestamp you deliberately let
differ. It is not a way to make a whole component "work" — the output still differs, you just stop
hearing about it. Also note that browser extensions (password managers, translators, Grammarly)
modify the DOM before React hydrates and can cause mismatches you can't fix in your code. React 19
skips unexpected tags that scripts and extensions insert into `<head>`/`<body>`, but injected
attributes can still warn — which is why theme libraries tell you to put `suppressHydrationWarning`
on `<html>`.
:::

:::quiz id=fe-28-q1 xp=10
This component is server-rendered at 09:00:00 UTC and hydrated in a browser in Berlin a second
later. What happens?

```tsx
function Footer() {
  return <p>Last updated {new Date().toLocaleTimeString()}</p>
}
```

- [ ] Nothing — React re-reads the time during hydration and patches the DOM silently
- [x] A hydration mismatch: the server text (UTC, server locale) differs from the client text, so React logs an error and re-renders that part on the client
- [ ] A build error, because `Date` isn't available on the server
- [ ] The server time is shown forever, because hydration never changes text
> Hydration expects the client's first render to produce **identical** output. The server formatted
> 09:00:00 in UTC with its locale; the browser formats a second later in Berlin time and German
> locale, so the strings differ. React 19 reports the mismatch (with a diff in development) and
> falls back to client rendering up to the nearest `<Suspense>` boundary. `Date` exists fine on the server (Node has it) — the problem is that
> its value depends on *where and when* you render. Fix: pass the timestamp from the server and
> format it with an explicit locale and `timeZone`, or format it in an effect.
:::

## SSG and ISR: render once, serve many times

If the HTML for `/docs/getting-started` is the same for every visitor and only changes when you
deploy, rendering it per request is wasted work. **SSG** renders every page at build time into
`.html` files; you deploy them to a CDN like a Vite build. You get SSR's content-in-the-first-response
*and* CSR's trivial, cheap, globally cached hosting. Astro, Next.js (static pages are the default),
React Router's `prerender` option and Docusaurus all do this.

SSG breaks down when you have **many pages that change often**: rebuilding 50,000 product pages
because one price changed is not an option. **ISR** (a Next.js term — the general idea is
"stale-while-revalidate for pages") renders a page on first request (or at build), caches it, and
serves the cached copy to everyone. After the revalidation window (say 60 seconds) the next request
still gets the stale copy *instantly*, while the server re-renders in the background and swaps in
the fresh version.

```tsx
// Next.js App Router: app/products/[id]/page.tsx
export const revalidate = 60 // seconds — this route is ISR

// Pre-render no ids at build time; render each product on its first request, then cache it.
// (Without generateStaticParams, a dynamic [id] route is rendered per request instead.)
export async function generateStaticParams() {
  return []
}

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params // Next.js 15+: params is a Promise
  const product = await fetch(`${process.env.API_URL}/products/${id}`).then((r) => r.json())
  return <h1>{product.name}</h1>
}
```

ISR looks static to the visitor but needs a **running server** (to re-render) and a **shared cache**
(when you run several instances — otherwise each pod has its own copy and visitors see different
versions). That's the part people forget when they "just deploy Next.js to Kubernetes".

:::warn title="Next.js caching APIs move fast"
This lesson uses the route segment config (`export const revalidate`, `export const dynamic`), which
is the default model in Next.js 15 and 16. If a project enables `cacheComponents` in `next.config.ts`
(Next.js 16's opt-in "Cache Components" model), these exports are replaced by the `'use cache'`
directive and `cacheLife()`. The *ideas* — build vs request vs cached-and-revalidated — are the same;
check the "Caching" and "Route Segment Config" pages on nextjs.org/docs for the version you use.
:::

:::quiz id=fe-28-q2 xp=10
A company docs site: 300 pages written in Markdown, changed only by merging a PR, must rank well on
Google and show proper previews when pasted into Slack. Which strategy fits best?
- [ ] CSR (Vite SPA) — it's the simplest to build
- [ ] SSR — so every request gets the latest content
- [x] SSG — render all pages at build time and deploy them to a CDN
- [ ] ISR with a 60-second revalidation window
> Content changes only on deploy, so rendering at **build** time is enough, and the result is plain
> files on a CDN: fastest TTFB, cheapest hosting, nothing to crash. SSR would re-render identical
> HTML on every request and require a Node server for no benefit. ISR solves "content changes
> between deploys", which isn't the case here. CSR is tempting because it's simple, but Slack's
> link-preview bot doesn't run JavaScript, so every page would preview as the same empty shell.
:::

## Streaming SSR: don't let the slowest query hold the page hostage

Plain SSR has an all-or-nothing problem: if the "recommended for you" query takes 2 seconds, the
whole HTML waits 2 seconds. **Streaming SSR** sends the response in chunks. Wrap slow parts in
`<Suspense>`:

```tsx
export default function ProductPage({ id }: { id: string }) {
  return (
    <Layout>
      <ProductDetails id={id} />                       {/* fast: in the first chunk */}
      <Suspense fallback={<ReviewsSkeleton />}>
        <Reviews id={id} />                            {/* slow: streamed in later */}
      </Suspense>
    </Layout>
  )
}
```

1. The server immediately sends the **shell**: layout, product details and the skeleton.
2. The connection stays open. When `Reviews` finishes, React sends the HTML for it plus a tiny inline
   script that swaps it into the skeleton's place.
3. **Selective hydration**: React can hydrate parts as they arrive, and prioritises the part the
   user is clicking on.

So streaming gives you a fast TTFB (the shell) *and* real content early, and each Suspense boundary
is a decision about "what may appear later". In Next.js, a `loading.tsx` file is a Suspense boundary
around a route segment.

:::quiz id=fe-28-q3 xp=10
A server-rendered product page waits ~1.8 s for a slow "reviews" API before sending any HTML. The
product data itself takes 80 ms. What's the best fix that keeps SEO for the product details?
- [ ] Switch the whole page to CSR so the HTML is sent instantly
- [x] Wrap the reviews in `<Suspense>` with a skeleton fallback and use streaming SSR
- [ ] Increase the server's CPU and memory
- [ ] Add `suppressHydrationWarning` to the reviews section
> With streaming SSR the server flushes the shell and product details after ~80 ms, and the reviews
> arrive later **in the same response**. TTFB drops from 1.8 s to ~80 ms while the product content
> is still in the HTML for crawlers. Going to CSR would give an instant but *empty* response —
> you'd lose exactly the SEO you wanted to keep. More CPU doesn't help: the server is waiting on
> I/O, not computing. `suppressHydrationWarning` is about hydration text mismatches and has nothing
> to do with response time.
:::

## React Server Components: rendering per component, not per page

All strategies so far decide per **page**. RSC (the default in Next.js App Router; React Router,
Waku and Parcel have newer, partly experimental support) decides per **component**:

- **Server Components** (the default — no directive needed) run *only* on the server: at build time
  or per request. They can be `async`, can `await` the database or a secret-keyed API directly, and
  their code **never ships to the browser**. A Markdown parser or date library used only in a Server
  Component costs your users zero bytes.
- **Client Components** are files marked with `'use client'` at the top. They can use state,
  effects, event handlers and browser APIs. They are **still server-rendered to HTML** and then
  hydrated — `'use client'` means "this also ships to the client", not "this only runs in the client".

```tsx
// app/products/[id]/page.tsx — a Server Component (no directive)
import { db } from '@/lib/db'          // server-only: DB driver never reaches the browser
import { AddToCart } from './add-to-cart'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const product = await db.product.findUnique({ where: { id } })
  return (
    <article>
      <h1>{product.name}</h1>
      <p>{product.description}</p>
      <AddToCart productId={product.id} price={product.price} />
    </article>
  )
}
```

```tsx
// app/products/[id]/add-to-cart.tsx — a Client Component
'use client'
import { useState } from 'react'

export function AddToCart({ productId, price }: { productId: string; price: number }) {
  const [qty, setQty] = useState(1)
  return <button onClick={() => setQty(qty + 1)}>Add {qty} × €{price}</button>
}
```

### The boundary rules

`'use client'` marks a **boundary in the module graph**: that file *and everything it imports* becomes
client code. That gives four rules you will meet daily:

1. **Push `'use client'` down to the leaves.** Marking the page itself `'use client'` because one
   button needs `onClick` turns the whole tree into client code and ships all of it.
2. **Server → client props must be serializable.** The server sends client components their props
   over the network (the "RSC payload"). Strings, numbers, booleans, `null`, arrays, plain objects,
   `Date`, `Map`/`Set`, Promises and JSX are fine. Ordinary functions and class instances are not.
3. **A client component can't import a server component** — but it can *receive* one as `children`
   or another JSX prop. That's how a client `<Tabs>` can wrap server-rendered panels.
4. **Server-only code must stay on the server.** Install the `server-only` package and put
   `import 'server-only'` at the top of modules with secrets or DB access; the build then fails if a
   client component imports them by accident. (Without it, the module would silently be bundled
   for the browser — and only `NEXT_PUBLIC_*` environment variables exist there, so secrets read as
   `undefined` at best.)

:::quiz id=fe-28-q4 xp=10
A Server Component renders `<Chart ... />`, where `Chart` is a `'use client'` component. Which props
can it pass? (Select all that apply.)
- [x] `data={[{ month: 'Jan', total: 120 }]}`
- [x] `title={<h2>Revenue</h2>}`
- [x] `updatedAt={new Date()}`
- [ ] `onPointClick={(p) => console.log(p)}`
- [ ] `formatter={new Intl.NumberFormat('de-DE')}`
> Props crossing the server → client boundary are **serialized** into the RSC payload. Arrays of
> plain objects, JSX elements and `Date` are all supported by React's serializer. An inline arrow
> function can't be serialized — code that runs on the server can't be "sent" as a callback, so the
> build/render fails with an error about passing functions to Client Components (the one exception
> is a Server Function marked `'use server'`). An `Intl.NumberFormat` is a class instance; pass the
> locale string instead and create the formatter inside the client component.
:::

### `'use server'`: Server Functions (Server Actions)

`'use server'` does **not** mean "this is a Server Component" (those need no directive). It marks
**functions** that the client may call. The framework turns each one into an HTTP endpoint and gives
the client a reference to it:

```tsx
// app/todos/actions.ts
'use server'
import { revalidatePath } from 'next/cache'
import { auth } from '@/lib/auth' // your session helper (e.g. Auth.js)
import { db } from '@/lib/db'     // your DB client (e.g. Prisma, Drizzle)

export async function addTodo(formData: FormData) {
  const session = await auth()                          // 1. who is calling?
  if (!session) throw new Error('Unauthorized')
  const title = String(formData.get('title') ?? '').trim()
  if (title.length === 0 || title.length > 200) return  // 2. validate — never trust the form
  await db.todo.create({ data: { title, userId: session.userId } })
  revalidatePath('/todos')                              // 3. refresh the cached page
}
```

A function passed straight to `<form action>` must return nothing. To show a validation message,
return a state object instead and wire the action up with `useActionState` in a client component
(see the *Forms* lesson).

```tsx
// app/todos/page.tsx — Server Component; the form works even before JS loads
import { addTodo } from './actions'

export default function TodosPage() {
  return (
    <form action={addTodo}>
      <input name="title" aria-label="New todo" />
      <button>Add</button>
    </form>
  )
}
```

This is the same `<form action={fn}>` from the *Forms* lesson, but `fn` runs on the server. Because
the form is a real HTML form, it even works before hydration (progressive enhancement).

:::warn title="A server action is a public POST endpoint"
Anyone can call it with any payload, not just your form. Authenticate, authorize and validate
inside every action exactly like an ASP.NET Core controller action — the fact that the button is
only shown to admins protects nothing. See *Frontend Security & Auth*.
:::

:::quiz id=fe-28-q5 xp=10
A teammate adds `'use server'` to the top of `ProductList.tsx` "so it renders on the server and
doesn't ship JavaScript". What's wrong?
- [ ] Nothing — that's exactly what `'use server'` is for
- [x] Components are Server Components by default; `'use server'` marks Server Functions callable from the client, so this turns the file's exports into endpoints instead
- [ ] `'use server'` only works in `.server.ts` files
- [ ] It should be `'use client'`, because lists need hydration
> In the RSC model, **no directive** means Server Component. `'use server'` is for **functions** the
> client may call over the network — every exported async function in that file becomes a callable
> endpoint (and non-async exports are an error). The tempting answer "lists need hydration" is wrong:
> a list with no state or handlers is a perfect Server Component and ships zero JavaScript.
:::

## Where does data fetching live?

The rendering strategy decides where your data is fetched, which matters more for speed than
rendering itself:

| Strategy | Data fetched from | Typical tool |
|---|---|---|
| CSR | Browser → your public API (CORS, tokens in the browser) | TanStack Query (see *Server State with TanStack Query*) |
| CSR + router loaders | Browser, but in parallel with code loading | React Router `loader`s |
| SSR / framework mode | Server → API/DB, close to the data | `loader` in React Router framework mode, `getServerSideProps` (Pages Router) |
| RSC | Server, inside the component that needs it | `await` in an `async` Server Component |
| Server Functions | Server, triggered by the client | `'use server'` + `revalidatePath`/`revalidateTag` |

Fetching on the server is often faster not because servers are faster, but because the server sits
in the same datacenter as the API, and you skip the browser's round trips. The danger with RSC is
the **server-side waterfall**: a parent awaits its data, *then* renders a child that awaits its data.
Start independent requests in parallel (`Promise.all`, or let sibling Suspense boundaries fetch on
their own).

:::job title="What you'll actually see in a .NET shop"
Most companies with an ASP.NET Core backend run a **Vite SPA + ASP.NET Core API**: the SPA is built in
CI and served from a CDN or `wwwroot`, auth is OIDC with cookies or a BFF, and the API is the single
source of truth. Next.js shows up when there's a public, SEO-relevant surface (shop, marketing, docs),
often as a *separate* app that calls the same API. Be ready to explain why your team chose one or
the other — "we need SEO on 20k product pages" or "it's an internal app behind login" are good
reasons; "Next.js is faster" without context is not.
:::

## Caching and the CDN: the real performance lever

How cacheable your HTML is decides how fast and cheap the site is. Each strategy implies different
headers:

| Response | `Cache-Control` | Why |
|---|---|---|
| `/assets/index-B4x9kQ2a.js` (hashed filename) | `public, max-age=31536000, immutable` | The name changes when the content changes, so cache forever |
| SPA / SSG `index.html` | `no-cache` | Always revalidate, so a deploy is picked up immediately |
| SSR page, same for everyone | `public, s-maxage=60, stale-while-revalidate=300` | CDN may cache 60 s and serve stale while refreshing — this *is* ISR at the CDN layer |
| SSR page with user data | `private, no-store` | Must never be stored by a shared cache |

:::warn title="The most expensive caching bug"
If an SSR page that contains the user's name, cart or invoices is cached by a CDN, the **next visitor
gets the previous user's page**. This has caused real data leaks. Any HTML that depends on cookies or
an `Authorization` header must be `private`/`no-store` (or vary correctly), and you should verify with
`curl -I` after every infrastructure change.
:::

## Choosing: a decision you can defend

Start from the requirements, not the framework:

1. **Is it behind a login?** Crawlers never see it. CSR is usually right: simplest hosting, and the
   first-load cost is paid once per session.
2. **Must crawlers or link previews see the content?** If not, CSR.
3. **Is the HTML different per user?** Then it can't be shared or cached: SSR.
4. **How often does it change?** Only on deploy → SSG. Every few minutes → ISR (or SSR + CDN
   `s-maxage`). Must be current on every request → SSR.

Then check what you can **operate**:

| Strategy | Hosting | You must run |
|---|---|---|
| CSR, SSG | Any static host / CDN / `wwwroot` / nginx container | Nothing beyond the API |
| SSR, streaming, ISR, RSC with dynamic routes, server actions | Node.js runtime (container in Kubernetes, Vercel, Azure App Service…) | A scaled, monitored Node tier + cache for ISR |

Real apps mix strategies **per route**: a Next.js or React Router framework app can have SSG
marketing pages, ISR product pages and a CSR-heavy dashboard. React Router framework mode (React
Router v7 used as a Vite plugin, the successor of Remix) even has an SPA mode plus build-time
prerendering for chosen routes, so you can start as an SPA and add server rendering later without
changing routers:

```ts
// react-router.config.ts
import type { Config } from '@react-router/dev/config'

export default {
  ssr: false,                          // no Node server at runtime: build output is static files
  prerender: ['/', '/pricing', '/about'], // these URLs get real HTML at build time (SSG)
} satisfies Config
```

With `ssr: false` the build output is a folder you can host anywhere: the listed routes are
prerendered `.html` files, everything else falls back to the SPA shell. Flip `ssr` to `true` and the
same app needs a Node server (`react-router-serve` or your own Express adapter). Details:
reactrouter.com → "Rendering Strategies" and "Pre-Rendering".

### Next.js vs React Router framework mode vs "just Vite"

| | Vite SPA + ASP.NET Core API | React Router framework mode | Next.js (App Router) |
|---|---|---|---|
| Default rendering | CSR | SSR (or SPA/prerender via config) | RSC + SSG, dynamic per route |
| Server Components | No | Experimental | Yes, the core model |
| Needs Node at runtime | No | Only with `ssr: true` | Yes, except with `output: 'export'` |
| Data fetching | Browser → API (TanStack Query) | `loader`/`action` per route | `async` Server Components, Server Functions |
| Fits best | Internal apps, dashboards, apps behind login | SPA today, SSR/SSG for some routes tomorrow | Public, SEO-heavy, content- or shop-like sites |

:::pro title="How seniors argue the choice"
Seniors frame it as **cost of an extra tier vs. value of content in the first response**. A Node SSR
tier means another deployable, another thing on call, double the places auth logic lives, and a BFF
in front of your API. That's worth it for a shop's product pages, where LCP and SEO are revenue. For
a B2B admin panel it's pure cost. They also measure before deciding: Lighthouse/`web-vitals` on a
mid-range phone over 4G, not the dev laptop on fibre.
:::

:::quiz id=fe-28-q6 xp=10
Your team builds an internal timesheet app for 400 employees. Everything is behind company SSO.
The backend is an existing ASP.NET Core 10 API in Kubernetes. A colleague proposes Next.js with SSR
"for performance". What's the strongest response?
- [ ] Agree — SSR is always faster than CSR
- [ ] Agree — React 19 requires a framework for production apps
- [x] A Vite SPA served as static files (or from the API's `wwwroot`) fits better: no SEO need, users load it once a day, and you avoid running and securing a Node tier
- [ ] Use SSG, because static is always fastest
> Behind a login there is no SEO benefit, and the first-load cost is paid once per session by users
> on office machines. SSR would add a Node.js service to deploy, scale and monitor, plus a second
> place for auth — real cost for little gain. "SSR is always faster" is the tempting myth: it
> improves first paint, but TTFB gets worse and client-side navigation is the same. React doesn't
> require a framework (Vite SPAs are fully supported). SSG can't pre-render per-user timesheet data.
:::

:::quiz id=fe-28-q7 xp=10
An online shop has 60,000 product pages. Prices and stock change several times an hour, pages must
rank on Google, and the cart is per user. Which setup fits best?
- [ ] SSG for every page, rebuilt on every price change
- [x] ISR (or SSR behind a CDN with `s-maxage`) for product pages, with the per-user cart as a small client component
- [ ] SSR every product page with `Cache-Control: private, no-store`
- [ ] CSR for everything, with a sitemap for Google
> Product pages are the same for every visitor and may be a few minutes stale, so they are perfectly
> cacheable: ISR serves cached HTML instantly and refreshes it in the background. The per-user
> part (cart) is moved into a client component that fetches after load, so it never pollutes the
> shared cache. Full SSG would mean rebuilding 60,000 pages several times an hour. SSR with
> `no-store` works but renders every page on every request — expensive and slower under load, for
> data that isn't per-user. CSR hurts SEO and LCP on exactly the pages that make money.
:::

:::quiz id=fe-28-q8 xp=10
You use `curl -s https://app.example.com/products/42` and the output contains only
`<div id="root"></div>` and script tags. What can you conclude?
- [ ] The server is broken — the page should contain the product
- [x] It's a client-side-rendered SPA: the content is built by JavaScript in the browser, so non-JS clients (curl, many link-preview bots) see no product data
- [ ] It's streaming SSR and curl closed the connection too early
- [ ] It's a Server Components app; the content is in the RSC payload
> An empty root element plus script tags is the signature of CSR: the server sends the same shell for
> every URL. That's normal for a Vite SPA — but it means anything that doesn't execute JavaScript
> can't see the content. A streaming SSR response would contain the shell's real HTML and fallbacks
> (curl waits for the whole response by default). An RSC app sends real HTML *plus* an inline
> payload (`self.__next_f.push(...)` in Next.js), not an empty root.
:::

:::quiz id=fe-28-q9 xp=10
Your product is a Vite SPA (React Router) served as static files from a CDN, with an ASP.NET Core
API behind it. Marketing now needs five public landing pages that rank on Google and preview
correctly in LinkedIn. Ops has said: "no new server processes". Which option meets **both**
requirements?
- [ ] Rewrite the app in Next.js with SSR for every route
- [ ] Keep pure CSR and set `<title>`/`<meta>` tags from React with `useEffect` on each page
- [x] Move to React Router framework mode with `ssr: false` and `prerender` the five landing URLs, keeping static hosting
- [ ] Keep pure CSR and submit a sitemap to Google
> Prerendering produces real HTML for exactly those five URLs **at build time**, so crawlers and
> link-preview bots see the content, and the output is still a folder of static files — no Node
> process, which is Ops' constraint. Next.js SSR would work for SEO but adds the server tier Ops
> ruled out. Setting meta tags from JavaScript is the tempting fix, but LinkedIn's bot reads only the
> raw HTML, where those tags don't exist yet. A sitemap tells Google *which* URLs exist; it doesn't
> put content into an empty `<div id="root">`.
:::

## Practice: pick a strategy in code

:::challenge id=fe-28-c1 lang=ts xp=40
title: The rendering decision function
Encode this lesson's decision process. Implement `chooseRendering(req)` with these rules,
**checked in this order**:

1. `behindLogin` is `true` → `'CSR'`
2. `seo` is `false` → `'CSR'`
3. `perUser` is `true` → `'SSR'`
4. `freshness` is `'deploy'` → `'SSG'`, `'minutes'` → `'ISR'`, `'realtime'` → `'SSR'`

Also implement `needsNodeServer(strategy)`: `true` for strategies that need a running server at
request time (`'SSR'`, `'ISR'`), `false` for those a static host can serve (`'CSR'`, `'SSG'`).

hint: Early `return`s in the given order keep it readable: the first matching rule wins.
hint: For `freshness`, a `switch` or a lookup object `{ deploy: 'SSG', minutes: 'ISR', realtime: 'SSR' }` works.

```ts starter
type Freshness = 'deploy' | 'minutes' | 'realtime'
type Strategy = 'CSR' | 'SSG' | 'ISR' | 'SSR'

interface Requirements {
  seo: boolean          // must crawlers / link previews see the content?
  behindLogin: boolean
  perUser: boolean      // does the HTML differ per visitor?
  freshness: Freshness  // how fresh must the content be?
}

export function chooseRendering(req: Requirements): Strategy {
  return 'CSR'
}

export function needsNodeServer(strategy: Strategy): boolean {
  return false
}
```

```ts solution
type Freshness = 'deploy' | 'minutes' | 'realtime'
type Strategy = 'CSR' | 'SSG' | 'ISR' | 'SSR'

interface Requirements {
  seo: boolean
  behindLogin: boolean
  perUser: boolean
  freshness: Freshness
}

const BY_FRESHNESS: Record<Freshness, Strategy> = {
  deploy: 'SSG',
  minutes: 'ISR',
  realtime: 'SSR',
}

export function chooseRendering(req: Requirements): Strategy {
  if (req.behindLogin) return 'CSR'
  if (!req.seo) return 'CSR'
  if (req.perUser) return 'SSR'
  return BY_FRESHNESS[req.freshness]
}

export function needsNodeServer(strategy: Strategy): boolean {
  return strategy === 'SSR' || strategy === 'ISR'
}
```

```ts tests
const base = { seo: true, behindLogin: false, perUser: false, freshness: 'deploy' as const }

test('docs site: public, SEO, changes on deploy → SSG', () => {
  expect(chooseRendering(base)).toBe('SSG')
})
test('product pages: public, SEO, change every few minutes → ISR', () => {
  expect(chooseRendering({ ...base, freshness: 'minutes' })).toBe('ISR')
})
test('live scores page: public, SEO, realtime → SSR', () => {
  expect(chooseRendering({ ...base, freshness: 'realtime' })).toBe('SSR')
})
test('personalised public page → SSR even if it changes rarely', () => {
  expect(chooseRendering({ ...base, perUser: true })).toBe('SSR')
})
test('admin dashboard behind login → CSR, even with every other flag set', () => {
  expect(chooseRendering({ seo: true, behindLogin: true, perUser: true, freshness: 'realtime' })).toBe('CSR')
})
test('public tool without SEO needs → CSR', () => {
  expect(chooseRendering({ ...base, seo: false, freshness: 'minutes' })).toBe('CSR')
})
test('needsNodeServer: SSR and ISR need a server', () => {
  expect(needsNodeServer('SSR')).toBe(true)
  expect(needsNodeServer('ISR')).toBe(true)
})
test('needsNodeServer: CSR and SSG run on a static host', () => {
  expect(needsNodeServer('CSR')).toBe(false)
  expect(needsNodeServer('SSG')).toBe(false)
})
```
:::

## Practice: catch hydration bugs before they ship

:::challenge id=fe-28-c2 lang=ts xp=40
title: A tiny hydration-risk linter
Write `findHydrationRisks(source)` that scans component source code **line by line** and reports
patterns that commonly cause hydration mismatches. Return an array of `{ line, kind }` (lines are
1-based), ordered by line; within one line, report kinds in this order, each at most once:

| `kind` | The line contains any of |
|---|---|
| `'random'` | `Math.random(`, `crypto.randomUUID(` |
| `'time'` | `Date.now(`, `new Date()` (exactly — `new Date(post.createdAt)` is deterministic) |
| `'locale'` | `.toLocaleString(`, `.toLocaleDateString(`, `.toLocaleTimeString(` |
| `'browser-only'` | `typeof window`, `window.`, `localStorage`, `sessionStorage`, `navigator.`, `document.` |

Skip a line if its trimmed text starts with `//` (a comment) or if it contains `hydration-ok`
(an explicit opt-out, like `eslint-disable`). A real linter would also understand that code inside
`useEffect` is safe; this one keeps it simple.

hint: `source.split('\n').forEach((text, i) => …)` gives you the text and `i + 1` as the line number.
hint: Keep the rules in an ordered array of `[kind, needles]` pairs and use `needles.some(n => text.includes(n))`.

```ts starter
type RiskKind = 'random' | 'time' | 'locale' | 'browser-only'

export function findHydrationRisks(source: string): { line: number; kind: RiskKind }[] {
  return []
}
```

```ts solution
type RiskKind = 'random' | 'time' | 'locale' | 'browser-only'

const RISK_RULES: [RiskKind, string[]][] = [
  ['random', ['Math.random(', 'crypto.randomUUID(']],
  ['time', ['Date.now(', 'new Date()']],
  ['locale', ['.toLocaleString(', '.toLocaleDateString(', '.toLocaleTimeString(']],
  ['browser-only', ['typeof window', 'window.', 'localStorage', 'sessionStorage', 'navigator.', 'document.']],
]

export function findHydrationRisks(source: string): { line: number; kind: RiskKind }[] {
  const risks: { line: number; kind: RiskKind }[] = []
  source.split('\n').forEach((text, i) => {
    if (text.trim().startsWith('//') || text.includes('hydration-ok')) return
    for (const [kind, needles] of RISK_RULES) {
      if (needles.some((n) => text.includes(n))) risks.push({ line: i + 1, kind })
    }
  })
  return risks
}
```

```ts tests
test('clean, deterministic code has no risks', () => {
  const src = [
    'function Price({ amount }) {',
    '  return <p>{amount.toFixed(2)} EUR</p>',
    '}',
  ].join('\n')
  expect(findHydrationRisks(src)).toEqual([])
})
test('finds random ids', () => {
  const src = ['const id = Math.random()', 'const key = crypto.randomUUID()'].join('\n')
  expect(findHydrationRisks(src)).toEqual([
    { line: 1, kind: 'random' },
    { line: 2, kind: 'random' },
  ])
})
test('new Date() is a time risk, new Date(value) is not', () => {
  const src = ['const now = new Date()', 'const d = new Date(post.createdAt)', 'const t = Date.now()'].join('\n')
  expect(findHydrationRisks(src)).toEqual([
    { line: 1, kind: 'time' },
    { line: 3, kind: 'time' },
  ])
})
test('locale formatting is reported', () => {
  const src = '<span>{new Date(iso).toLocaleDateString()}</span>'
  expect(findHydrationRisks(src)).toEqual([{ line: 1, kind: 'locale' }])
})
test('browser-only APIs and typeof window branches', () => {
  const src = [
    "const theme = localStorage.getItem('theme')",
    "const isClient = typeof window !== 'undefined'",
    'const w = window.innerWidth',
    'const lang = navigator.language',
  ].join('\n')
  expect(findHydrationRisks(src).map((r) => r.kind)).toEqual([
    'browser-only', 'browser-only', 'browser-only', 'browser-only',
  ])
})
test('several kinds on one line come in rule order, each once', () => {
  const src = '  const label = `${new Date().toLocaleTimeString()} ${Math.random()} ${window.name} ${document.title}`'
  expect(findHydrationRisks(src)).toEqual([
    { line: 1, kind: 'random' },
    { line: 1, kind: 'time' },
    { line: 1, kind: 'locale' },
    { line: 1, kind: 'browser-only' },
  ])
})
test('skips comments and hydration-ok lines, keeps line numbers right', () => {
  const src = [
    '  // Math.random() is fine in a comment',
    '  const t = Date.now() // hydration-ok: only used in an effect',
    '',
    '  const r = Math.random()',
  ].join('\n')
  expect(findHydrationRisks(src)).toEqual([{ line: 4, kind: 'random' }])
})
```
:::

## Practice: draw the server/client boundary

The most common RSC refactoring task is taking a component that was written as one big client
component and splitting it: the **static, data-heavy part** becomes server-safe (no hooks, no event
handlers, so it could be a Server Component and ship no JS), and the **interactive part** becomes a
small client island that receives only serializable props.

:::challenge id=fe-28-c3 lang=tsx xp=50 preview=Demo
title: Split the product page
`ProductPage` below works, but because it uses `useState` the *whole* page would have to be a
client component. Split it into:

- `ProductPage({ product })` — **server-safe**: no hooks, and **no function-valued props anywhere**
  in the JSX it returns (no `onClick`, no callbacks). It renders an `<article>` with an `<h1>`
  (name), a `<p>` (description), the price as text like `€19.90` (`toFixed(2)`), and
  `<AddToCartButton productId={product.id} />` — passing **only** the `productId` prop, nothing else.
- `AddToCartButton({ productId })` — the **client island**, a separate top-level function with
  exactly that name: a `<button>` with the accessible name `Add to cart`. Before any click there is
  no status element; after N clicks it shows `<p role="status">In cart: N</p>`.

How the tests check "server-safe": they call `ProductPage({ product })` **as a plain function**
(as a server would, with no React renderer) and walk the returned element tree. A hook inside it
throws, and any function prop in the tree fails. Then they render the page normally and click the
button.

hint: Move `useState` and the `onClick` into a new `AddToCartButton` component; `ProductPage` just renders `<AddToCartButton productId={product.id} />`.
hint: Don't pass the whole `product` (or a callback) to the island — the boundary only carries what the client actually needs, and it must be serializable.

```tsx starter
import { useState } from 'react'

type Product = { id: string; name: string; description: string; price: number }

export function ProductPage({ product }: { product: Product }) {
  const [count, setCount] = useState(0)
  return (
    <article>
      <h1>{product.name}</h1>
      <p>{product.description}</p>
      <p>{`€${product.price.toFixed(2)}`}</p>
      <button type="button" onClick={() => setCount((c) => c + 1)}>Add to cart</button>
      {count > 0 && <p role="status">In cart: {count}</p>}
    </article>
  )
}

export function Demo() {
  return <ProductPage product={{ id: 'p1', name: 'Mechanical Keyboard', description: 'Tactile switches.', price: 89.9 }} />
}
```

```tsx solution
import { useState } from 'react'

type Product = { id: string; name: string; description: string; price: number }

// Server-safe: pure function of its props, no hooks, no handlers
export function ProductPage({ product }: { product: Product }) {
  return (
    <article>
      <h1>{product.name}</h1>
      <p>{product.description}</p>
      <p>{`€${product.price.toFixed(2)}`}</p>
      <AddToCartButton productId={product.id} />
    </article>
  )
}

// Client island ('use client' at the top of its own file in a real RSC app):
// state + events, serializable props only
export function AddToCartButton({ productId }: { productId: string }) {
  const [count, setCount] = useState(0)
  return (
    <div>
      <button type="button" data-product-id={productId} onClick={() => setCount((c) => c + 1)}>
        Add to cart
      </button>
      {count > 0 && <p role="status">In cart: {count}</p>}
    </div>
  )
}

export function Demo() {
  return <ProductPage product={{ id: 'p1', name: 'Mechanical Keyboard', description: 'Tactile switches.', price: 89.9 }} />
}
```

```tsx tests
const sample = { id: 'p1', name: 'Desk Lamp', description: 'Warm light for late debugging.', price: 19.9 }

function collectElements(node: any, out: any[] = []): any[] {
  if (Array.isArray(node)) {
    node.forEach((n) => collectElements(n, out))
  } else if (node && typeof node === 'object' && 'props' in node) {
    out.push(node)
    collectElements(node.props.children, out)
  }
  return out
}

test('ProductPage is server-safe: callable without a React renderer (no hooks)', () => {
  expect(() => ProductPage({ product: sample })).not.toThrow()
})
test('ProductPage passes no event handlers or other functions anywhere', () => {
  const elements = collectElements(ProductPage({ product: sample }))
  const fnProps = elements.flatMap((el) =>
    Object.entries(el.props).filter(([, v]) => typeof v === 'function').map(([k]) => k),
  )
  expect(fnProps).toEqual([])
})
test('the client island receives only a serializable productId', () => {
  const elements = collectElements(ProductPage({ product: sample }))
  const island = elements.find((el) => el.type === AddToCartButton)
  expect(island).toBeDefined()
  expect(island.props).toEqual({ productId: 'p1' })
  expect(JSON.parse(JSON.stringify(island.props))).toEqual(island.props)
})
test('renders name, description and formatted price', () => {
  const { container } = render(<ProductPage product={sample} />)
  expect(screen.getByRole('heading', { name: 'Desk Lamp' })).toBeInTheDocument()
  expect(container.textContent).toContain('Warm light for late debugging.')
  expect(container.textContent).toContain('€19.90')
})
test('the island counts clicks', async () => {
  render(<ProductPage product={sample} />)
  expect(screen.queryByRole('status')).toBeNull()
  const btn = screen.getByRole('button', { name: 'Add to cart' })
  await user.click(btn)
  expect(screen.getByRole('status')).toHaveTextContent('In cart: 1')
  await user.click(btn)
  expect(screen.getByRole('status')).toHaveTextContent('In cart: 2')
})
```
:::

## Lab: see the difference in the build output

Reading about rendering strategies is one thing; seeing an empty `<div id="root">` next to a
prerendered HTML file is what makes it stick. In this lab you build the same tiny page twice and
compare what each tool produces and what each one needs to run.

:::lab id=fe-28-lab1 xp=80
title: Vite SPA build vs Next.js build output
You need Node.js 22.12+ or 24 LTS (Vite 8 and Next.js 16 both support these) and `curl`. Work in an
empty folder. Commands are written for bash/zsh; `&` starts a server in the background and
`kill %1` stops it again.

**Part A — the Vite SPA**

```bash
npm create vite@latest csr-demo -- --template react-ts
cd csr-demo
npm install
npm run build
ls dist dist/assets
```

(If `create-vite` asks whether to install and start the dev server now, answer **No** — you want a
production build, not the dev server.)

Expected output (hashes differ, and the exact asset files depend on the template version — what
matters is that there is one `index.html` plus hashed static files):

```text
dist:
assets  index.html  vite.svg

dist/assets:
index-B4x9kQ2a.js  index-Dk3mP1ws.css  react-CHdo91hT.svg
```

That folder *is* the whole deployable. Serve it and look at the HTML that any non-JS client sees:

```bash
npx vite preview --port 4173 &
sleep 2
curl -s http://localhost:4173/ | grep -o '<div id="root"></div>'
curl -s http://localhost:4173/anything/at/all | grep -o '<div id="root"></div>'
kill %1
```

Expected output — the same empty shell for every URL:

```text
<div id="root"></div>
<div id="root"></div>
```

**Part B — the Next.js app (App Router, React Server Components)**

```bash
cd ..
npx create-next-app@latest rsc-demo --yes --ts --app --use-npm
cd rsc-demo
```

(`--yes` accepts the defaults for every question you didn't answer with a flag; if the installer
still asks something, accept the default.) Replace `app/page.tsx` with a static
Server Component that uses a Client Component:

```tsx
// app/page.tsx
import { Counter } from './counter'

export default function Home() {
  return (
    <main>
      <h1>Rendered on the server</h1>
      <p>Build time: {new Date().toISOString()}</p>
      <Counter />
    </main>
  )
}
```

```tsx
// app/counter.tsx
'use client'
import { useState } from 'react'

export function Counter() {
  const [n, setN] = useState(0)
  return <button onClick={() => setN(n + 1)}>Clicked {n} times</button>
}
```

Add a per-request (SSR) page and an ISR page:

```tsx
// app/time/page.tsx
export const dynamic = 'force-dynamic' // render on every request

export default function TimePage() {
  return <p>Request time: {new Date().toISOString()}</p>
}
```

```tsx
// app/isr/page.tsx
export const revalidate = 30 // re-render at most every 30 seconds

export default function IsrPage() {
  return <p>Generated at: {new Date().toISOString()}</p>
}
```

Build it:

```bash
npm run build
```

Expected output (the end of it, as printed by Next.js 16; Next.js 15 additionally shows `Size` and
`First Load JS` columns, and the layout may change between versions):

```text
Route (app)                Revalidate  Expire
┌ ○ /
├ ○ /_not-found
├ ○ /isr                          30s      1y
└ ƒ /time

○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand
```

Read the symbols: `/` was rendered **at build time** (SSG — note that `Build time` is frozen), `/isr`
is static but revalidates every 30 s (ISR), `/time` runs per request (SSR). Find the prerendered HTML
and compare it with Vite's `index.html`, then check which code ended up in the browser bundles
(`.next/static/chunks/` is everything the browser can download):

```bash
ls .next/server/app/ | grep -E '^(index|isr)\.html$'
grep -o 'Rendered on the server' .next/server/app/index.html
grep -rl 'Clicked' .next/static/chunks/ | head -n 1
grep -rl 'Rendered on the server' .next/static/chunks/ || echo 'not in any client chunk'
```

Expected output (the chunk name differs):

```text
index.html
isr.html
Rendered on the server
.next/static/chunks/0f3a9c1e2b7d4a55.js
not in any client chunk
```

The `Counter` text is in a client chunk because `'use client'` put it there; the Server Component's
text is only in the prerendered HTML. (These `.next/` paths are internal build details as of
Next.js 15/16 and may move in future versions.)

Now run it — note that this is a **Node.js server**, not a folder you can drop on a CDN:

```bash
npm start &
sleep 3
curl -s http://localhost:3000/ | grep -o 'Rendered on the server'
curl -s http://localhost:3000/ | grep -o 'self.__next_f.push' | wc -l
curl -s http://localhost:3000/time | grep -o 'Request time: [0-9T:.-]*'
sleep 1
curl -s http://localhost:3000/time | grep -o 'Request time: [0-9T:.-]*'
kill %1
```

Expected output: the heading is in the raw HTML, the page contains the inlined RSC payload (the count
is some number greater than 0 — the exact value varies), and the two `/time` requests show
**different** timestamps:

```text
Rendered on the server
4
Request time: 2026-11-05T10:15:02.118Z
Request time: 2026-11-05T10:15:03.164Z
```

Finally, see the same thing in the browser: start `npm start` again, open `http://localhost:3000/`,
open DevTools → Network, filter to **JS**, reload, and use the Network panel's search (Ctrl+F /
Cmd+F inside the panel searches response bodies). `Clicked` is found in a JS chunk; `Rendered on the
server` appears only in the HTML document (as markup and inside the inline RSC payload), never in a
`.js` file — `page.tsx`'s code, including its `Date` call, was never shipped.

:::tip title="Bonus: cause a hydration mismatch on purpose"
Run `npm run dev`, add `<p>{Math.random()}</p>` to `Counter`, and reload `http://localhost:3000/`.
The browser console and Next's error overlay show a hydration error with a diff of the two numbers.
Fix it with the two-pass pattern from this lesson (initial state `null`, set the number in
`useEffect`) and watch the error disappear.
:::

Write a short `NOTES.md` in `rsc-demo` answering: which of the three routes could you deploy to a
static host with `output: 'export'` in `next.config.ts`, and what would happen to the other ones?
Try it (add `output: 'export'` to the config object and run `npm run build` again), then read the
"Static Exports → Unsupported Features" section of the Next.js docs to explain what you see.

- [ ] `dist/` of the Vite build contains only static files, and `curl` shows the same empty `<div id="root"></div>` for every URL
- [ ] `next build` lists `/` as static (○), `/isr` with a 30 s revalidate and `/time` as dynamic (ƒ)
- [ ] `.next/server/app/index.html` exists and contains "Rendered on the server"; that text is in no file under `.next/static/chunks/`, but `Clicked` is
- [ ] Two requests to `/time` return different timestamps; `/` keeps the build timestamp
- [ ] In DevTools I found the `Counter` code in a client JS chunk, but not the code of `page.tsx`
- [ ] `NOTES.md` explains which routes survive `output: 'export'` and why the others need a Node server
:::

:::cards id=fe-28-cards1 xp=15 title="Rendering strategies"
Q: The two questions every rendering strategy answers?
A: WHERE the HTML is made (browser or server) and WHEN (build time, per request, or cached and revalidated).
Q: What does a CSR (Vite SPA) server send for every URL?
A: The same index.html with an empty root element and script tags; JavaScript builds the page in the browser.
Q: SSR's effect on TTFB and LCP?
A: TTFB usually gets worse (the server renders first); LCP usually gets better (content is in the first response).
Q: What is hydration?
A: React rendering again in the browser over existing server HTML, attaching event handlers and state instead of creating DOM nodes.
Q: Four common causes of hydration mismatches?
A: Random values, the current time, locale/time-zone formatting, and browser-only checks (typeof window, localStorage) in render. Also invalid HTML nesting.
Q: SSG vs ISR?
A: SSG renders at build time and changes only on deploy. ISR serves cached HTML and re-renders in the background after a revalidate window; it needs a running server.
Q: What does streaming SSR improve?
A: The shell is flushed immediately; slow parts wrapped in Suspense arrive later in the same response. Fast TTFB without losing server-rendered content.
Q: Does a 'use client' component render on the server?
A: Yes — it is still SSR'd to HTML and then hydrated. 'use client' marks a module boundary: this file and its imports ship to the browser.
Q: What does 'use server' mark?
A: Server Functions (Server Actions) callable from the client — public POST endpoints that must authenticate, authorize and validate. Not Server Components (those need no directive).
Q: What can cross the server → client props boundary?
A: Serializable values: primitives, arrays, plain objects, Date, Map/Set, Promises, JSX, and Server Functions. Not plain functions or class instances.
Q: Which strategies run on a static host, which need Node?
A: CSR and SSG: any static host/CDN. SSR, streaming, ISR, dynamic RSC routes and server actions: a Node.js runtime.
Q: How do you get SEO-ready HTML for a few routes of a React Router app without running a Node server?
A: Framework mode with ssr: false plus prerender: [...] in react-router.config.ts. The listed URLs become static HTML at build time; the rest stays an SPA.
Q: What happens on a hydration mismatch in React 19?
A: React reports a recoverable error (with a diff in dev) and client-renders from the nearest Suspense boundary (or the root), discarding that server HTML.
Q: Cache-Control for hashed assets vs index.html vs personalised SSR HTML?
A: Hashed assets: public, max-age=31536000, immutable. index.html: no-cache. Personalised HTML: private, no-store — never in a shared cache.
:::

## Recap

- Every strategy answers **where** (browser or server) and **when** (build, request, cached) the HTML is made.
- **CSR** (Vite SPA): trivial static hosting and clean API separation, but an empty first response — bad for SEO, link previews and LCP on slow devices.
- **SSR** puts content in the first response (better LCP, SEO) at the cost of a Node.js tier and slower TTFB; **streaming** with `<Suspense>` fixes TTFB.
- **SSG** is for content that changes on deploy; **ISR** (or CDN `s-maxage` + `stale-while-revalidate`) for many pages that change every few minutes.
- **Hydration** needs identical server and client output: no randomness, current time, locale formatting or browser-only checks in render — use `useId`, server-provided values or a two-pass render.
- **Server Components** are the default in RSC frameworks and ship no JS; `'use client'` marks a boundary and should sit at the leaves; props across it must be serializable.
- **`'use server'`** marks Server Functions — public endpoints that must authenticate, authorize and validate.
- Behind a login with an ASP.NET Core API, a **Vite SPA** is usually the right call; reach for Next.js / React Router framework mode when public, SEO-relevant, cacheable pages make the extra server worth running — or use `prerender` with `ssr: false` to get static HTML for a few routes without any server.
- Never cache personalised HTML in a shared cache: `private, no-store`.
