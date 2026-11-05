---
id: fe-14
title: Routing with React Router
level: intermediate
minutes: 55
xp: 170
summary: URLs as state — routes, nested layouts, params, loaders and actions, navigation, protected routes, 404s, and the GitHub Pages hash-vs-browser routing trap.
---

A single-page app (SPA) has exactly one HTML file, yet users expect `/projects/42` to be a real place:
bookmarkable, shareable, refreshable, and reachable with the back button. **Client-side routing** makes
that work: JavaScript reads the URL, decides which components to render, and intercepts link clicks so
the page never fully reloads.

The mental model that makes routing click: **the URL is state**. It is the one piece of state that lives
*outside* React — in the browser's address bar and history stack — and the router is the bridge that
keeps the two in sync.

## Why not just `useState`?

You *could* write `const [page, setPage] = useState('home')`. You'd lose:

- **Deep links** — nobody can share "the settings page" with a colleague.
- **Refresh** — F5 drops you back on the home page.
- **Back/forward** — the browser history knows nothing about your state.
- **Opening in a new tab** — middle-click on a fake link does nothing.

Rule of thumb used by senior teams: *if a user would ever want to bookmark it, share it, or come back to it
with the back button, it belongs in the URL* — that includes the current tab, a search filter, a page
number, and the selected item.

## What a client-side router actually does

There is no magic — the browser gives you two building blocks, the **History API**:

- `history.pushState(state, '', '/projects/42')` changes the address bar and adds a history entry
  **without** asking the server for anything.
- The `popstate` event fires when the user presses Back/Forward, so your code can re-render for the new URL.

A router wraps those: its `<Link>` renders a real `<a href>`, but on a normal left-click it calls
`event.preventDefault()` (stopping the full page load) and `pushState` instead. Then it matches
`location.pathname` against your route table and renders the winning components. On first load (or a
refresh) the server has to return `index.html` for *any* path so that this JavaScript can boot — keep that
in mind, it comes back at the end of the lesson.

## React Router (v7+) in one page

React Router v7 merged the old `react-router-dom` into a single package `react-router` (since v7, the old
`react-router-dom` name only re-exports `react-router`; new code should import from `react-router`). v8 is
the current major; everything in this lesson works the same there. It can be used in three "modes":

| Mode | What you get | When |
|---|---|---|
| **Declarative** (`<BrowserRouter>` + `<Routes>`) | URL matching, links, params | Small apps, migrating old code |
| **Data** (`createBrowserRouter` + `RouterProvider`) | + loaders, actions, pending UI, error boundaries | Most SPAs built with Vite |
| **Framework** (Vite plugin, file-based routes) | + SSR, code splitting, type-safe route modules (the former Remix) | Full-stack React apps |

This course uses **data mode** — it's what you'll most often meet in a Vite SPA talking to an ASP.NET API.
Framework mode, Next.js and server rendering are compared in the rendering-strategies lesson after
**Server State with TanStack Query**.

```bash
npm install react-router
```

```tsx
// src/main.tsx
import { createRoot } from 'react-dom/client'
import { createBrowserRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'   // DOM build: integrates with react-dom (flushSync)
import { RootLayout } from './app/RootLayout'
import { RootErrorBoundary } from './app/RootErrorBoundary'
import { HomePage } from './pages/HomePage'
import { ProjectsPage } from './pages/ProjectsPage'
import { ProjectPage, projectLoader, renameAction } from './pages/ProjectPage'
import { NotFound } from './pages/NotFound'

const router = createBrowserRouter([
  {
    path: '/',
    element: <RootLayout />,              // header + nav + <Outlet />
    errorElement: <RootErrorBoundary />,  // thrown loader/action/render errors below this route
    children: [
      { index: true, element: <HomePage /> },               // matches exactly "/"
      { path: 'projects', element: <ProjectsPage /> },      // "/projects"
      {
        path: 'projects/:projectId',                        // "/projects/42"
        element: <ProjectPage />,
        loader: projectLoader,                              // runs before ProjectPage renders
        action: renameAction,                               // handles <Form method="post"> on this route
      },
      { path: '*', element: <NotFound /> },                 // catch-all inside the layout
    ],
  },
])

createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />)
```

Read the route objects top-down: each has a `path` (relative to its parent, so `'projects'` under `'/'`
means `/projects`), an `element` to render, and optionally `children`, `loader`, `action` and
`errorElement`. **`index: true`** marks the child that renders at the parent's own URL. The router picks
the **most specific** match (ranked, not first-come), so `projects/:projectId` beats `*` for
`/projects/42` regardless of the order in the array.

### Nested routes and `<Outlet />`

Nested routes mirror **nested layouts**. The parent renders the chrome (header, sidebar) once and an
`<Outlet />` where the matched child appears:

```tsx
import { NavLink, Outlet } from 'react-router'

export function RootLayout() {
  return (
    <div className="app">
      <header>
        <nav>
          <NavLink to="/" end>Home</NavLink>
          <NavLink to="/projects">Projects</NavLink>
        </nav>
      </header>
      <main>
        <Outlet />   {/* the matched child route renders here */}
      </main>
    </div>
  )
}
```

When you navigate from `/projects` to `/projects/42`, the layout **stays mounted** — only the outlet's
content changes. Sidebar scroll position, open menus and layout state survive. That is the real reason
nested routes exist, not just less typing.

`NavLink` is a `Link` that knows whether it's active: it adds an `active` class and
`aria-current="page"` (great for screen readers and for styling). Without extra props it is active on its
own URL and on every child URL (`to="/projects"` is active on `/projects/42`). `end` makes a link active only
on an exact match: `<NavLink to="/projects" end>` is active on `/projects` but not on `/projects/42`. (A link
to `/` is special-cased and is only ever active on `/`; many codebases still add `end` there for clarity.)

### Params and search params

```tsx
import { useParams, useSearchParams } from 'react-router'

export function ProjectPage() {
  const { projectId } = useParams()            // "/projects/42" → { projectId: "42" } (always strings!)
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = searchParams.get('tab') ?? 'overview'   // "/projects/42?tab=board"

  return (
    <>
      <h1>Project {projectId}</h1>
      <button onClick={() => setSearchParams({ tab: 'board' })}>Board</button>
      {tab === 'board' ? <Board /> : <Overview />}
    </>
  )
}
```

- **Path params** (`:projectId`) identify *which resource*. They are part of the route's identity.
- **Search params** (`?tab=board&page=2`) describe *how to view it*: filters, sort, pagination, tabs.

Both are **strings**. `Number(projectId)` before you send it to an API, and validate it (e.g. with Zod) —
a user can type anything into the address bar.

Two `setSearchParams` details worth knowing on day one:

- `setSearchParams({ tab: 'board' })` **replaces** the whole query string — `?page=2&tab=overview` becomes
  `?tab=board`. To change one key and keep the rest, use the callback form:
  `setSearchParams((prev) => { prev.set('tab', 'board'); return prev })`.
- Each call **pushes** a history entry by default. For values that change rapidly (typing in a search box),
  pass `{ replace: true }` as the second argument so Back doesn't step through every keystroke.

:::quiz id=fe-14-q4 xp=10
Spot the bug. The URL is `/projects/42`, and `projects` contains `{ id: 42, name: 'Apollo' }`.

```tsx
const { projectId } = useParams()
const project = projects.find((p) => p.id === projectId)
return <h1>{project?.name ?? 'Unknown project'}</h1>
```

- [ ] `useParams` returns `undefined` for numeric segments, so the route never matches
- [x] It always renders "Unknown project": `projectId` is the string `"42"`, and `42 === "42"` is `false`
- [ ] It works — `===` converts the string to a number first
- [ ] `useParams` must be called with the param name: `useParams('projectId')`
> Path and search params are always **strings** (or `undefined`). Strict equality never converts types, so
> `42 === "42"` is `false` and `find` returns `undefined`. Parse first — `const id = Number(projectId)` — and
> handle `NaN` (the user might type `/projects/abc`). `==` would "work", but hides the type confusion; parse instead.
:::

:::challenge id=fe-14-c1 lang=ts xp=40
title: Write your own matchPath
Routers boil down to one function: does this URL match this pattern, and what are the params?
Implement `matchPath(pattern, pathname)`:

- Split both on `/`, ignoring empty segments (so trailing slashes don't matter: `/projects/` matches `/projects`).
- A static segment must match exactly.
- A segment starting with `:` captures that segment into `params` (URL-decoded with `decodeURIComponent`).
- A final `*` segment matches the rest of the path (possibly nothing) and stores it, joined by `/`, under `params['*']`.
- Return the params object on a match, or `null`.

hint: `const parts = (s: string) => s.split('/').filter(Boolean)`
hint: Walk the pattern segments with an index; when you hit `*`, slice the rest of the path and return.
hint: Without a `*`, the segment counts must be equal.

```ts starter
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  return pattern === pathname ? {} : null
}
```

```ts solution
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const parts = (s: string) => s.split('/').filter(Boolean)
  const pat = parts(pattern)
  const path = parts(pathname)
  const params: Record<string, string> = {}
  for (let i = 0; i < pat.length; i++) {
    const seg = pat[i]
    if (seg === '*') {
      params['*'] = path.slice(i).join('/')
      return params
    }
    if (i >= path.length) return null
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(path[i])
    else if (seg !== path[i]) return null
  }
  return pat.length === path.length ? params : null
}
```

```ts tests
test('static match', () => {
  expect(matchPath('/projects', '/projects')).toEqual({})
})
test('trailing slash ignored', () => {
  expect(matchPath('/projects', '/projects/')).toEqual({})
  expect(matchPath('/', '/')).toEqual({})
})
test('static mismatch', () => {
  expect(matchPath('/projects', '/settings')).toBeNull()
})
test('captures params', () => {
  expect(matchPath('/projects/:projectId/tasks/:taskId', '/projects/42/tasks/7')).toEqual({ projectId: '42', taskId: '7' })
})
test('decodes params', () => {
  expect(matchPath('/users/:name', '/users/Ada%20Lovelace')).toEqual({ name: 'Ada Lovelace' })
})
test('segment count must match without a splat', () => {
  expect(matchPath('/projects/:id', '/projects')).toBeNull()
  expect(matchPath('/projects/:id', '/projects/1/extra')).toBeNull()
})
test('splat matches the rest', () => {
  expect(matchPath('/docs/*', '/docs/guides/routing')).toEqual({ '*': 'guides/routing' })
  expect(matchPath('/docs/*', '/docs')).toEqual({ '*': '' })
  expect(matchPath('*', '/anything/at/all')).toEqual({ '*': 'anything/at/all' })
})
```
:::

### Navigating

```tsx
<Link to="/projects/42">Open</Link>                   // declarative — renders a real <a href>
<Link to="../settings" relative="path">Settings</Link> // relative paths work like folders

const navigate = useNavigate()
navigate('/projects')                                  // imperative — after a form submit, a logout…
navigate(-1)                                           // back
navigate('/login', { replace: true, state: { from: location } })
```

Prefer `<Link>` whenever the user *clicks something to go somewhere*. It renders a real anchor, so
middle-click, "copy link address", and screen readers all work. Reserve `navigate()` for navigation that
**results from an action** (saved successfully → go to the detail page).

`replace: true` replaces the current history entry instead of pushing a new one — use it for redirects,
so the back button doesn't bounce the user straight into the redirect again.

:::quiz id=fe-14-q1 xp=10
A developer renders `<div onClick={() => navigate('/projects/42')}>Project 42</div>` in a list. What's wrong? (Select all that apply.)
- [x] It's not keyboard-focusable and screen readers don't announce it as a link
- [x] Middle-click / Ctrl+click to open in a new tab doesn't work
- [ ] `navigate` can't be used with params
- [x] "Copy link address" isn't available because there's no `href`
> Use `<Link to="/projects/42">`. It renders an `<a href>`, so the browser and assistive technology treat it
> as a real link, while React Router intercepts normal clicks for client-side navigation. `navigate` itself is
> fine with any path, params included — the problem is the `<div>`, not the function.
:::

:::quiz id=fe-14-q5 xp=10
The nav contains `<NavLink to="/projects">Projects</NavLink>` and
`<NavLink to="/projects" end>All projects</NavLink>`. The user is on `/projects/42`. Which links get the
`active` class?
- [x] Only "Projects"
- [ ] Both "Projects" and "All projects"
- [ ] Only "All projects"
- [ ] Neither, because `/projects/42` matches neither `to` exactly
> By default a `NavLink` is active when the current URL **starts with** its `to` path at a segment boundary,
> so a parent section stays highlighted on its child pages: `/projects` matches `/projects/42` (but not
> `/projectsX`). `end` limits a link to an exact match, so "All projects" is active only on `/projects` itself.
> One special case: `to="/"` is only ever active on exactly `/`, even without `end`.
:::

## Loaders and actions: data meets routes

In data mode each route can declare a **loader** (read data before rendering) and an **action** (handle a
form submission/mutation):

```tsx
// pages/ProjectPage.tsx
import { useLoaderData, Form, redirect, data, type LoaderFunctionArgs, type ActionFunctionArgs } from 'react-router'

export async function projectLoader({ params, request }: LoaderFunctionArgs) {
  // request.signal aborts the fetch if the user navigates away before it finishes
  const res = await fetch(`/api/projects/${params.projectId}`, { signal: request.signal })
  if (res.status === 404) throw data('Project not found', { status: 404 })  // → nearest errorElement
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as Project
}

export async function renameAction({ request, params }: ActionFunctionArgs) {
  const form = await request.formData()             // <Form> posts a normal form body
  const res = await fetch(`/api/projects/${params.projectId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' }, // without it ASP.NET Core answers 415
    body: JSON.stringify({ name: form.get('name') }),
  })
  if (!res.ok) throw new Error(`Rename failed: HTTP ${res.status}`)
  return redirect(`/projects/${params.projectId}`)   // loaders re-run automatically after an action
}

export function ProjectPage() {
  const project = useLoaderData<typeof projectLoader>()   // type inferred from the loader
  return (
    <>
      <h1>{project.name}</h1>
      <Form method="post"><input name="name" defaultValue={project.name} /><button>Rename</button></Form>
    </>
  )
}
```

How the pieces connect: `<Form method="post">` is a router-aware `<form>`. On submit, instead of a full
page POST, React Router serialises the inputs into a `FormData`, calls the **action** of the route that
rendered the form, and — when the action finishes — re-runs the loaders of the matched routes so the page
shows fresh data. `redirect()` returns a response that tells the router where to go next.

Why put data loading in the router instead of a `useEffect` in the component?

1. **No waterfalls.** With effects, the parent renders, *then* fetches, *then* the child renders, *then*
   fetches. The router knows every matched route up front and starts **all** their loaders in parallel the
   moment navigation starts.
2. **No "loading flash" of an empty component** — the router can keep showing the old page (with
   `useNavigation().state === 'loading'` for a progress bar) until the new data arrives.
3. **Errors go to the route's `errorElement`** — one consistent place for 404s and failures.
4. **Mutations revalidate.** After an action, loaders re-run so the UI isn't stale.

:::pro title="Loaders + TanStack Query is the common combo"
Many teams use loaders only to *kick off* fetching — `loader: () => queryClient.ensureQueryData(projectQuery(id))`
— and then read the data in the component with `useQuery`. The router prevents waterfalls; TanStack Query
handles caching, background refetching and mutations. You'll meet that library in the next lesson.
:::

## Protected routes

Some routes require a signed-in user. The common pattern is a **layout route** that guards its children:

```tsx
import { Navigate, Outlet, useLocation } from 'react-router'

export function RequireAuth() {
  const { user, isLoading } = useAuth()
  const location = useLocation()
  if (isLoading) return <Spinner />
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  return <Outlet />
}

// routes
{
  element: <RequireAuth />,      // pathless layout route: guards everything below
  children: [
    { path: 'settings', element: <SettingsPage /> },
    { path: 'billing', element: <BillingPage /> },
  ],
}

// after a successful login
const from = (location.state as { from?: string } | null)?.from ?? '/'
navigate(from, { replace: true })
```

Note the three details: `replace` (don't leave the protected URL in history), remembering **where the
user wanted to go** (`state.from`), and a **loading state** (on first load the auth check is still running —
without it you'd redirect a signed-in user to `/login` for a split second).

`location.state` is data attached to a history entry: it survives Back/Forward and a refresh of that tab,
but never appears in the URL — so it can't be bookmarked, and it can't be forged by a link someone sends you.

:::info title="Data-mode alternative: guard in a loader"
Because loaders run *before* rendering, you can also guard there:
`loader: async ({ request }) => { if (!(await getUser())) throw redirect('/login?from=' + encodeURIComponent(new URL(request.url).pathname)) }`.
The protected page never even starts rendering. Both styles are common; the component guard is simpler when
auth state already lives in React context. Note that `from` now travels in the **query string**, so anyone
can craft it: only navigate to it if it is an internal path (`from.startsWith('/') && !from.startsWith('//')`),
otherwise you've built an open redirect that bounces users to a phishing site.
:::

:::warn title="Client-side guards are UX, not security"
Anyone can open DevTools and render your settings page. The real protection is the **API returning 401/403**.
A route guard only avoids showing users screens they can't use. Never ship data to the client that the
user isn't allowed to see "because the route is protected".
:::

## 404s

Unknown URLs need a friendly page, not a blank screen. Two places to handle them:

- A `path: '*'` route as the **last child** of your layout — the 404 renders *inside* the app shell, so the
  nav stays usable.
- `errorElement` on the root — catches what loaders/actions throw (e.g. `data('Project not found', { status: 404 })`
  for "project 999 doesn't exist") and errors thrown while rendering. Use `useRouteError()` and
  `isRouteErrorResponse(error)` to show a 404 vs a 500 message:

```tsx
import { isRouteErrorResponse, useRouteError, Link } from 'react-router'

export function RootErrorBoundary() {
  const error = useRouteError()
  if (isRouteErrorResponse(error)) {           // something a loader/action threw with data(…, { status })
    return <><h1>{error.status === 404 ? 'Page not found' : `Error ${error.status}`}</h1><p>{error.data}</p><Link to="/">Home</Link></>
  }
  console.error(error)                          // a real bug — log it (Sentry, App Insights…)
  return <><h1>Something went wrong</h1><Link to="/">Home</Link></>
}
```

An `errorElement` **replaces** the element of the route it is defined on. On the root route that means
the whole layout (nav included) disappears; put another `errorElement` on a child route if you want errors
to render *inside* the shell. Errors thrown outside the router (in a widget, an event handler, an async
callback) need component-level error boundaries and reporting; that's the **Failing well** lesson.

:::challenge id=fe-14-c2 lang=tsx xp=70 preview=App
title: A mini router
Build a tiny in-memory router so you really understand what React Router does. A `matchPath(pattern, path)`
helper and the route table are provided in setup. Implement:

- `Router` — holds the current `path` in state (start at `initialPath`, default `/`) and provides
  `{ path, navigate }` via `RouterContext`.
- `Link` — renders an `<a href={to}>`; on click it calls `preventDefault()` and `navigate(to)`.
- `Routes` — renders the `element(params)` of the **first** route whose pattern matches, or
  `<h1>Page not found</h1>` if none do.

hint: `const [path, setPath] = useState(initialPath)` and provide `{ path, navigate: setPath }`.
hint: In `Routes`: loop over `routes`, call `matchPath(r.path, path)` and return the first non-null match's element.
hint: Without `preventDefault()` the browser would try a full page load.

```tsx setup
type Params = Record<string, string>
type RouteDef = { path: string; element: (params: Params) => React.ReactNode }

function matchPath(pattern: string, path: string): Params | null {
  const a = pattern.split('/').filter(Boolean)
  const b = path.split('/').filter(Boolean)
  if (a.length !== b.length) return null
  const params: Params = {}
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) params[a[i].slice(1)] = b[i]
    else if (a[i] !== b[i]) return null
  }
  return params
}

const routes: RouteDef[] = [
  { path: '/', element: () => <h1>Home</h1> },
  { path: '/projects', element: () => <h1>Projects</h1> },
  { path: '/projects/:id', element: (p) => <h1>Project {p.id}</h1> },
]
```

```tsx starter
import { createContext, useContext, useState } from 'react'

type RouterValue = { path: string; navigate: (to: string) => void }
const RouterContext = createContext<RouterValue | null>(null)

export function Router({ initialPath = '/', children }: { initialPath?: string; children: React.ReactNode }) {
  return <>{children}</>
}

function useRouter() {
  const ctx = useContext(RouterContext)
  if (!ctx) throw new Error('useRouter must be used within Router')
  return ctx
}

export function Link({ to, children }: { to: string; children: React.ReactNode }) {
  return <a href={to}>{children}</a>
}

export function Routes() {
  return <>{routes[0].element({})}</>
}

export function App() {
  return (
    <Router>
      <nav>
        <Link to="/">Home</Link> · <Link to="/projects">All projects</Link> ·{' '}
        <Link to="/projects/42">Project 42</Link> · <Link to="/nope">Broken link</Link>
      </nav>
      <Routes />
    </Router>
  )
}
```

```tsx solution
import { createContext, useContext, useState } from 'react'

type RouterValue = { path: string; navigate: (to: string) => void }
const RouterContext = createContext<RouterValue | null>(null)

export function Router({ initialPath = '/', children }: { initialPath?: string; children: React.ReactNode }) {
  const [path, setPath] = useState(initialPath)
  return <RouterContext value={{ path, navigate: setPath }}>{children}</RouterContext>
}

function useRouter() {
  const ctx = useContext(RouterContext)
  if (!ctx) throw new Error('useRouter must be used within Router')
  return ctx
}

export function Link({ to, children }: { to: string; children: React.ReactNode }) {
  const { navigate } = useRouter()
  return (
    <a href={to} onClick={(e) => { e.preventDefault(); navigate(to) }}>
      {children}
    </a>
  )
}

export function Routes() {
  const { path } = useRouter()
  for (const r of routes) {
    const params = matchPath(r.path, path)
    if (params) return <>{r.element(params)}</>
  }
  return <h1>Page not found</h1>
}

export function App() {
  return (
    <Router>
      <nav>
        <Link to="/">Home</Link> · <Link to="/projects">All projects</Link> ·{' '}
        <Link to="/projects/42">Project 42</Link> · <Link to="/nope">Broken link</Link>
      </nav>
      <Routes />
    </Router>
  )
}
```

```tsx tests
test('starts on Home', () => {
  render(<App />)
  expect(screen.getByRole('heading', { name: 'Home' })).toBeInTheDocument()
})
test('links navigate without leaving the page', async () => {
  render(<App />)
  await user.click(screen.getByRole('link', { name: 'All projects' }))
  expect(screen.getByRole('heading', { name: 'Projects' })).toBeInTheDocument()
  await user.click(screen.getByRole('link', { name: 'Home' }))
  expect(screen.getByRole('heading', { name: 'Home' })).toBeInTheDocument()
})
test('params reach the element', async () => {
  render(<App />)
  await user.click(screen.getByRole('link', { name: 'Project 42' }))
  expect(screen.getByRole('heading', { name: 'Project 42' })).toBeInTheDocument()
})
test('unknown paths show a 404', async () => {
  render(<App />)
  await user.click(screen.getByRole('link', { name: 'Broken link' }))
  expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
})
test('initialPath is respected', () => {
  render(<Router initialPath="/projects/7"><Routes /></Router>)
  expect(screen.getByRole('heading', { name: 'Project 7' })).toBeInTheDocument()
})
```
:::

:::challenge id=fe-14-c3 lang=tsx xp=60 preview=App
title: Protected route with return-to
The app below has a working mini router (`path` + `navigate` in state). `/settings` must be protected:

- `RequireAuth` — if there is no `user`, **redirect** to `/login` and remember the requested path in
  `from` (call `goLogin(path)`); render nothing meanwhile. With a user, render `children`.
- After clicking **Sign in** on the login page, the user must land on the page they originally wanted
  (`from`), or `/` if there is none.

Redirecting is a side effect — do it in `useEffect`, not during render.

hint: In `RequireAuth`: `useEffect(() => { if (!user) goLogin(path) }, [user, path])`, then `return user ? children : null`.
hint: In `LoginPage`'s handler: `onLogin()` then `navigate(from ?? '/')`.

```tsx starter
import { useEffect, useState } from 'react'

type User = { name: string }

export function RequireAuth({ user, path, goLogin, children }: {
  user: User | null; path: string; goLogin: (from: string) => void; children: React.ReactNode
}) {
  return <>{children}</>
}

export function LoginPage({ onLogin, from, navigate }: {
  onLogin: () => void; from: string | null; navigate: (to: string) => void
}) {
  return (
    <>
      <h1>Sign in</h1>
      <button onClick={() => { onLogin(); navigate('/') }}>Sign in</button>
    </>
  )
}

export function App() {
  const [path, navigate] = useState('/')
  const [from, setFrom] = useState<string | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const goLogin = (f: string) => { setFrom(f); navigate('/login') }

  let page: React.ReactNode
  if (path === '/') page = <h1>Home</h1>
  else if (path === '/login') page = <LoginPage from={from} navigate={navigate} onLogin={() => setUser({ name: 'Ada' })} />
  else if (path === '/settings') page = (
    <RequireAuth user={user} path={path} goLogin={goLogin}><h1>Settings</h1></RequireAuth>
  )
  else page = <h1>Page not found</h1>

  return (
    <>
      <nav>
        <button onClick={() => navigate('/')}>Go home</button>
        <button onClick={() => navigate('/settings')}>Go to settings</button>
      </nav>
      {page}
    </>
  )
}
```

```tsx solution
import { useEffect, useState } from 'react'

type User = { name: string }

export function RequireAuth({ user, path, goLogin, children }: {
  user: User | null; path: string; goLogin: (from: string) => void; children: React.ReactNode
}) {
  useEffect(() => {
    if (!user) goLogin(path)
  }, [user, path])
  return user ? <>{children}</> : null
}

export function LoginPage({ onLogin, from, navigate }: {
  onLogin: () => void; from: string | null; navigate: (to: string) => void
}) {
  return (
    <>
      <h1>Sign in</h1>
      <button onClick={() => { onLogin(); navigate(from ?? '/') }}>Sign in</button>
    </>
  )
}

export function App() {
  const [path, navigate] = useState('/')
  const [from, setFrom] = useState<string | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const goLogin = (f: string) => { setFrom(f); navigate('/login') }

  let page: React.ReactNode
  if (path === '/') page = <h1>Home</h1>
  else if (path === '/login') page = <LoginPage from={from} navigate={navigate} onLogin={() => setUser({ name: 'Ada' })} />
  else if (path === '/settings') page = (
    <RequireAuth user={user} path={path} goLogin={goLogin}><h1>Settings</h1></RequireAuth>
  )
  else page = <h1>Page not found</h1>

  return (
    <>
      <nav>
        <button onClick={() => navigate('/')}>Go home</button>
        <button onClick={() => navigate('/settings')}>Go to settings</button>
      </nav>
      {page}
    </>
  )
}
```

```tsx tests
test('signed-out users are redirected to sign in', async () => {
  render(<App />)
  await user.click(screen.getByRole('button', { name: 'Go to settings' }))
  expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'Settings' })).toBeNull()
})
test('after sign in, the user returns to the page they wanted', async () => {
  render(<App />)
  await user.click(screen.getByRole('button', { name: 'Go to settings' }))
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
  expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument()
})
test('signed-in users go straight through', async () => {
  render(<App />)
  await user.click(screen.getByRole('button', { name: 'Go to settings' }))
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
  await user.click(screen.getByRole('button', { name: 'Go home' }))
  await user.click(screen.getByRole('button', { name: 'Go to settings' }))
  expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument()
})
test('protected content never renders for signed-out users', () => {
  render(<RequireAuth user={null} path="/settings" goLogin={() => {}}><p>secret</p></RequireAuth>)
  expect(screen.queryByText('secret')).toBeNull()
})
```
:::

## Deploying an SPA: browser vs hash routing

Here's a trap almost everyone falls into once. Your app works locally, you deploy it to **GitHub Pages**,
click around happily — then press F5 on `/projects/42` and get GitHub's **404 page**.

Why? With `createBrowserRouter`, URLs look like `https://you.github.io/app/projects/42`. Clicking links is
fine (JavaScript handles it), but a **refresh asks the server** for `/app/projects/42`. GitHub Pages is a
dumb static host: there's no such file, so it returns 404. Your JavaScript never even loads.

Servers that host SPAs need an **SPA fallback**: "for any unknown path, serve `index.html`". Then the router
boots and reads the URL. Your options:

| Option | How | Trade-off |
|---|---|---|
| **Hash routing** — `createHashRouter` | URLs become `/app/#/projects/42`. The server only ever sees `/app/` | Works on any static host; uglier URLs; no SSR; anchors (`#section`) conflict |
| **404.html trick** on GitHub Pages | Copy `index.html` to `404.html` in the build | Clean URLs, but every deep link is served with HTTP **404 status** (bad for SEO/monitoring) |
| **A host with rewrites** | Netlify `_redirects`, Vercel/Azure Static Web Apps `navigationFallback`, nginx `try_files $uri /index.html` | Clean URLs + 200 status — the production choice |

Also set Vite's `base` when the app lives in a sub-path, and tell the router:

```ts
// vite.config.ts
export default defineConfig({ base: '/training/', plugins: [react()] })

// router
createBrowserRouter(routes, { basename: import.meta.env.BASE_URL })
```

```nginx
# nginx in a container (you'll do this in the Containers track)
location / {
  try_files $uri $uri/ /index.html;
}
```

:::job title="This exact question comes up in deployments"
"It works locally but refreshing gives 404 in prod" is a classic ticket. The answer is always the same: the
web server/CDN isn't configured with an SPA fallback to `index.html`. In ASP.NET Core hosting a SPA, that's
`app.MapFallbackToFile("index.html")` after your API routes.
:::

:::quiz id=fe-14-q2 xp=15
Your SPA uses `createBrowserRouter` and is deployed to GitHub Pages. Navigating with links works, but
refreshing `/app/settings` shows a 404. Which statements are true? (Select all that apply.)
- [x] The browser asked the server for `/app/settings`, which doesn't exist as a file
- [x] Switching to `createHashRouter` fixes it, because everything after `#` never reaches the server
- [ ] Adding `errorElement` to the root route fixes it
- [x] A host that rewrites unknown paths to `index.html` fixes it while keeping clean URLs
> On refresh your JavaScript hasn't loaded yet — the 404 comes from the static server. That's why the tempting
> `errorElement` answer is wrong: it only runs once the router is running, and here the router never boots.
> Hash routing or a server-side fallback to `index.html` are the fixes.
:::

:::quiz id=fe-14-q3 xp=10
Why do data-mode loaders avoid request waterfalls compared to `useEffect` fetching in each component?
- [ ] Loaders use a faster HTTP client
- [x] The router knows all matched routes before rendering and starts their loaders in parallel
- [ ] Loaders cache responses in `localStorage`
- [ ] Effects can't run `fetch`
> With effects, a child can only start fetching after its parent has fetched and rendered it. The router matches
> the whole route tree up front, so parent and child loaders start at the same time. Loaders use the same
> `fetch` as everyone else and have no built-in persistent cache — the win is **when** requests start, not how.
:::

## Lab: add routing to your app

:::lab id=fe-14-lab1 xp=80
title: Router, nested layout, params, guard and 404
Use the Vite + React + TS app you created in earlier lessons (or `npm create vite@latest routing-lab -- --template react-ts`).

1. Install: `npm install react-router` and (for tests) `npm install -D vitest jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom`.
2. Create `src/app/router.tsx` exporting a `routes` array (so tests can reuse it with a memory router) and the
   browser router:

```tsx
import { createBrowserRouter, type RouteObject } from 'react-router'
// …import RootLayout, HomePage, ProjectsPage, ProjectPage, RequireAuth, SettingsPage, LoginPage, NotFound

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <RootLayout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'projects', element: <ProjectsPage /> },
      { path: 'projects/:projectId', element: <ProjectPage /> },
      { element: <RequireAuth />, children: [{ path: 'settings', element: <SettingsPage /> }] },
      { path: 'login', element: <LoginPage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]

export const router = createBrowserRouter(routes, { basename: import.meta.env.BASE_URL })
```

3. In `src/main.tsx` render `<RouterProvider router={router} />` (import `RouterProvider` from `react-router/dom`)
   instead of `<App />`.
4. `RootLayout` renders a `<nav>` with `NavLink`s for **Home** (`to="/" end`) and **Projects**, styles `.active`,
   and an `<Outlet />`. Wrap the layout's content in your `AuthProvider` (a fake `useState` auth context with
   `user`, `isLoading: false`, `login()`, `logout()` is fine for now). Putting the provider *inside* the root
   route means the tests below, which only render the routes, get it too.
5. `ProjectPage` reads `projectId` with `useParams` and renders `<h1>Project {projectId}</h1>`; a `tab` search
   param (`?tab=board`) read with `useSearchParams` switches between an "Overview" and a "Board" section.
   `NotFound` renders `<h1>Page not found</h1>`.
6. `RequireAuth` is the guard from this lesson: `<Navigate to="/login" replace state={{ from: location.pathname }} />`
   when signed out. `LoginPage` has a "Sign in" button that calls `login()` and then
   `navigate(from ?? '/', { replace: true })`.
7. Tell Vitest to use jsdom. In `vite.config.ts` change the import to `import { defineConfig } from 'vitest/config'`
   (it accepts the `test` key with full types) and add `test: { environment: 'jsdom', globals: true }`.
   The testing lesson covers this setup in depth.
8. Add `src/app/router.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { expect, test } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { routes } from './router'

function renderAt(url: string) {
  const router = createMemoryRouter(routes, { initialEntries: [url] })
  render(<RouterProvider router={router} />)
  return router
}

test('shows the project id from the URL', async () => {
  renderAt('/projects/42')
  expect(await screen.findByRole('heading', { name: /project 42/i })).toBeInTheDocument()
})

test('unknown URLs render the 404 inside the layout', async () => {
  renderAt('/does-not-exist')
  expect(await screen.findByRole('heading', { name: /not found/i })).toBeInTheDocument()
  expect(screen.getByRole('navigation')).toBeInTheDocument()
})

test('settings redirects to login when signed out', async () => {
  const router = renderAt('/settings')
  // <Navigate> redirects in an effect, so wait for the navigation to finish
  await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
})

test('nav link marks the current page', async () => {
  renderAt('/')
  await userEvent.click(await screen.findByRole('link', { name: 'Projects' }))
  await waitFor(() =>
    expect(screen.getByRole('link', { name: 'Projects' })).toHaveAttribute('aria-current', 'page'),
  )
})
```

   Run it with `npx vitest run`. Expected output (timings will differ):

```text
 ✓ src/app/router.test.tsx (4 tests) 120ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
```

9. Build with `npm run build`, serve with `npx vite preview`, open `http://localhost:4173/projects/42` and
   **refresh** — Vite's preview server has an SPA fallback, so it works. Note in your README what a static
   host (GitHub Pages, S3, nginx) would need instead.

- [ ] Nested layout: the nav stays mounted while the outlet content changes, and "Home" is only active on `/`
- [ ] `/projects/42?tab=board` shows the id and the board tab
- [ ] `/settings` redirects to `/login` and comes back after signing in
- [ ] Unknown URLs show the 404 page inside the layout
- [ ] All four router tests pass with `npx vitest run`
- [ ] After `npm run build` + `npx vite preview`, refreshing `/projects/42` still shows the project page
:::

## Recap

- The **URL is state** that lives outside React; anything worth bookmarking or sharing belongs in it.
- Under the hood a router is the **History API** (`pushState` + `popstate`) plus route matching; `<Link>` prevents the full page load.
- React Router v7+ = one package `react-router`; data mode = `createBrowserRouter` + `RouterProvider` (from `react-router/dom`).
- **Nested routes** = nested layouts; the parent stays mounted and renders children in `<Outlet />`.
- **Path params** identify the resource, **search params** describe the view; both are strings — parse and validate them.
- Use `<Link>`/`<NavLink>` for clicks (`end` for exact-match links), `navigate()` for navigation after actions; `replace` for redirects.
- **Loaders** start data fetching for all matched routes in parallel; **actions** handle mutations and trigger revalidation.
- Protected routes are a **layout guard** with a loading state and a remembered `from`; real security is the API.
- Refresh-404 on static hosts → hash routing, the `404.html` trick, or (best) a server rewrite to `index.html`.

:::cards id=fe-14-cards1 xp=15 title="Routing"
Q: What does `<Outlet />` do?
A: Marks where a parent (layout) route renders its matched child route.
Q: Path params vs search params?
A: Path params identify the resource (`/projects/:id`); search params describe how to view it (`?tab=board&page=2`).
Q: When `navigate()` instead of `<Link>`?
A: For navigation that results from an action (after saving, after logout). Clicks on "go there" UI should be `<Link>`.
Q: Why `replace: true` on redirects?
A: So the redirect doesn't leave an entry in history that bounces the user back when they press Back.
Q: Why does refreshing a deep link 404 on GitHub Pages?
A: The static server looks for a file at that path. It needs an SPA fallback to `index.html` — or use hash routing.
Q: How do you test routed components?
A: `createMemoryRouter(routes, { initialEntries: ['/path'] })` + `<RouterProvider>` in the test.
Q: Are route guards security?
A: No — they're UX. The API must enforce authorization with 401/403.
Q: What does `setSearchParams({ tab: 'board' })` do to `?page=2`?
A: Drops it — the object form replaces the whole query string. Use the callback form and `prev.set('tab', 'board')` to keep other keys.
Q: How do you throw a 404 from a loader?
A: `throw data('Not found', { status: 404 })` — the nearest `errorElement` renders, and `isRouteErrorResponse(error)` is true there.
:::
