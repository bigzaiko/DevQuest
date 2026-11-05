---
id: cap-05
title: "Frontend Shell: Modules, Auth & a Typed API Layer"
level: advanced
minutes: 270
xp: 200
summary: Turn the empty Vite app into a real product shell — feature modules, routing, TanStack Query over a typed client, design tokens, a small UI kit, sign-in and the share dialog.
---

The API from cap-02 … cap-04 can sign users in, store projects, refuse stale saves with **409**
and share projects with editors and viewers. Nobody can use it yet. In this lesson you build the
**shell** of the BranchStory web app: everything except the editor itself (that is cap-06).

A shell sounds boring, but it is where most frontend codebases rot. If you get these decisions
right now, every later feature drops into an obvious place:

| Decision | What we pick | Why |
|---|---|---|
| Folder layout | `src/modules/<feature>` + tiny `src/lib` | A feature's UI, hooks and API calls live together; deleting a feature is deleting a folder |
| Server state | **TanStack Query** | Caching, dedupe, retries, invalidation and optimistic updates without writing a store |
| Client state | React state / `useReducer` | The editor document is *local* state until it is saved; it does not belong in a cache |
| HTTP | one `apiFetch` + a typed `api` object | One place for the token, JSON, ProblemDetails and 401 handling |
| Routing | React Router (data router mode) | Nested layouts, auth guard as a layout route, lazy-loaded editor chunk |
| Auth | **dev token** first, OIDC PKCE optional | You can work offline today; swapping to Keycloak changes one module |
| Styling | CSS custom properties (design tokens) + a 5-component kit | No framework lock-in; dark mode for free; accessible by default |

## The module map

```text
web/src/
├── main.tsx                 # providers + router
├── env.d.ts                 # typed import.meta.env
├── app/
│   ├── router.tsx           # all routes in one place
│   └── AppLayout.tsx        # header, skip link, <Outlet/>
├── lib/                     # shared kernel — no React components here
│   ├── config.ts            # env → typed config
│   ├── session.ts           # the access token (observable store)
│   ├── api.ts               # apiFetch, ApiError, typed endpoints
│   ├── storyDoc.ts          # emptyDoc + normalizeDoc
│   └── types.ts             # DTOs shared with the API
├── modules/
│   ├── auth/                # AuthProvider, useAuth, LoginPage, RequireAuth, OIDC
│   ├── ui/                  # tokens.css, ui.css, Button, TextField, Dialog, Spinner …
│   ├── projects/            # queries, ProjectsPage, CreateProjectForm, ShareDialog
│   └── editor/              # cap-06 (a placeholder today)
└── test/                    # Vitest setup + render helpers
```

The one rule that keeps this clean: **modules may import from `lib/` and `modules/ui`, and from
another module only through what that module deliberately exports.** `lib/` never imports from
`modules/`.

:::job title="What reviewers look for in a frontend PR"
Teams rarely argue about *which* state library you use. They do push back on: fetch calls
scattered through components, tokens read from `localStorage` in five places, duplicated error
handling, components that can't be reached by keyboard, and tests that mock half the app. This
lesson gives each of those exactly one home.
:::

## The API contract this lesson relies on

These are the endpoints you built in cap-03/04 (JSON in camelCase):

| Method & path | Body | Success |
|---|---|---|
| `POST /api/dev/token` (Development only) | `{ username, displayName? }` | `200 { accessToken, expiresAt }` |
| `GET /api/me` | — | `200 { id, email, displayName, plan }` (creates the user row on first call) |
| `GET /api/projects` | — | `200 ProjectSummary[]` — `{ id, title, role, ownerName, version, updatedAt }` |
| `POST /api/projects` | `{ title }` | `201 ProjectDetail` — `{ id, title, role, ownerId, version, doc, updatedAt }` |
| `GET /api/projects/{id}` | — | `200 ProjectDetail` + `ETag: "<version>"` |
| `PUT /api/projects/{id}/doc` | `{ doc, expectedVersion }` | `200 { version, updatedAt }`; `409` (or `412` for `If-Match`) with `currentVersion` |
| `GET /api/projects/{id}/members` | — | `200 Member[]` — owner first: `{ userId, email, displayName, role }` |
| `PUT /api/projects/{id}/members` | `{ email, role: 'editor' \| 'viewer' }` | `200 Member` (adds or changes a seat; idempotent) |
| `DELETE /api/projects/{id}/members/{userId}` | — | `204` |

Errors are **ProblemDetails** (`application/problem+json`): `{ type, title, status, detail, errors?, currentVersion? }`.
Plan limits (cap-04) come back as `403` with `type: "https://branchstory.dev/problems/plan-limit"`.

:::lab id=cap-05-lab1 xp=150
title: Tooling, typed client and sign-in

You start in the `web/` folder that cap-01 created with `npm create vite@latest web -- --template react-ts`.
The API from cap-04 should be running on `http://localhost:5080` (`dotnet run --project api/BranchStory.Api`
with Postgres from compose).

**1. Install the dependencies**

```bash
cd web
npm install react-router @tanstack/react-query oidc-client-ts
npm install -D vitest jsdom @testing-library/react @testing-library/dom @testing-library/user-event @testing-library/jest-dom
```

Add two scripts to `web/package.json` (keep the existing ones):

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

Remove the template demo files — you replace all of them:

```bash
rm -f src/App.tsx src/App.css src/index.css
rm -rf src/assets
```

:::info
The template's `src/main.tsx` still imports `./App.tsx` and `./index.css`, so `npm run dev` and
`npx tsc -b` fail until lab 2 replaces `main.tsx`. That's expected. In this lab you only run
`npm test`, which compiles just the files the tests import.
:::

**2. Vite config: proxy + Vitest** — `web/vite.config.ts`

The proxy makes the browser talk to *one* origin (`localhost:5173`), so there is no CORS to
configure in development and cookies/tokens behave like production behind an ingress.
`ws: true` is required for SignalR in cap-07.

```ts
/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  // '' = load every variable, not only VITE_*; API_PROXY_TARGET is for the dev server only
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = env.API_PROXY_TARGET || 'http://localhost:5080'

  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
        '/hubs': { target: apiTarget, changeOrigin: true, ws: true },
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      css: false,
      restoreMocks: true,
      unstubGlobals: true,
    },
  }
})
```

**3. Environment** — `web/.env.development`

```bash
# dev = POST /api/dev/token ; oidc = Keycloak (Authorization Code + PKCE)
VITE_AUTH_MODE=dev
# empty = same origin (the Vite proxy in dev, the ingress in prod)
VITE_API_BASE=
VITE_OIDC_AUTHORITY=http://localhost:8080/realms/branchstory
VITE_OIDC_CLIENT_ID=branchstory-web
# not exposed to the browser (no VITE_ prefix): where the dev proxy forwards to
API_PROXY_TARGET=http://localhost:5080
```

`web/src/env.d.ts` — typed `import.meta.env`:

```ts
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AUTH_MODE?: 'dev' | 'oidc'
  readonly VITE_API_BASE?: string
  readonly VITE_OIDC_AUTHORITY?: string
  readonly VITE_OIDC_CLIENT_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
```

`web/src/lib/config.ts` — read the env **once** and give the rest of the app a typed object:

```ts
const authMode: 'dev' | 'oidc' = import.meta.env.VITE_AUTH_MODE === 'oidc' ? 'oidc' : 'dev'

export const config = {
  apiBase: (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, ''),
  authMode,
  oidc: {
    authority: import.meta.env.VITE_OIDC_AUTHORITY ?? '',
    clientId: import.meta.env.VITE_OIDC_CLIENT_ID ?? 'branchstory-web',
  },
} as const
```

:::warn title="VITE_ variables are public"
Everything prefixed `VITE_` is inlined into the JavaScript bundle and readable by anyone. Never
put a client secret, API key or database URL there. A public SPA client uses PKCE precisely
because it *cannot* keep a secret.
:::

**4. Shared DTO types** — `web/src/lib/types.ts`

```ts
export type Role = 'owner' | 'editor' | 'viewer'
export type ShareRole = Exclude<Role, 'owner'>

export interface Me {
  id: string
  email: string
  displayName: string
  plan: string
}

export interface DevTokenResponse {
  accessToken: string
  expiresAt: string
}

export interface StoryNode {
  id: string
  title: string
  text: string
  mediaUrl?: string | null
  x: number
  y: number
}

export interface StoryEdge {
  id: string
  from: string
  to: string
  label: string
}

/** The jsonb document stored in projects.doc */
export interface StoryDoc {
  startNodeId: string | null
  nodes: StoryNode[]
  edges: StoryEdge[]
}

export interface ProjectSummary {
  id: string
  title: string
  role: Role
  ownerName: string
  version: number
  updatedAt: string
}

export interface ProjectDetail {
  id: string
  title: string
  role: Role
  ownerId: string
  version: number
  doc: StoryDoc
  updatedAt: string
}

export interface SaveDocRequest {
  doc: StoryDoc
  expectedVersion: number
}

export interface SaveDocResponse {
  version: number
  updatedAt: string
}

export interface Member {
  userId: string
  email: string
  displayName: string
  role: Role
}

export interface ShareRequest {
  email: string
  role: ShareRole
}

/** RFC 9457 ProblemDetails, plus the extensions our API adds */
export interface ProblemDetails {
  type?: string
  title?: string
  status?: number
  detail?: string
  errors?: Record<string, string[]>
  currentVersion?: number
  [extension: string]: unknown
}
```

`web/src/lib/storyDoc.ts` — the server stores whatever jsonb it got; the client defends itself:

```ts
import type { StoryDoc } from './types'

export const emptyDoc: StoryDoc = { startNodeId: null, nodes: [], edges: [] }

/** Accept `{}` or a partially filled document from older versions of the app. */
export function normalizeDoc(raw: unknown): StoryDoc {
  const d = (raw ?? {}) as Partial<StoryDoc>
  return {
    startNodeId: typeof d.startNodeId === 'string' ? d.startNodeId : null,
    nodes: Array.isArray(d.nodes) ? d.nodes : [],
    edges: Array.isArray(d.edges) ? d.edges : [],
  }
}
```

**5. The session store** — `web/src/lib/session.ts`

Why not just `useState` in the `AuthProvider`? Because the token is needed **outside React**
too: `apiFetch` has to read it on every request, and on a 401 it has to clear it. If the token
lived in React state, plain modules couldn't read or change it. So it lives in a tiny observable
store: a variable, a way to change it, and a set of listeners to notify when it changes. Non-React
code (`apiFetch`, the SignalR client in cap-07) just calls `session.getToken()`. React subscribes
with `useSyncExternalStore(subscribe, getSnapshot)`, the hook built for exactly this: React calls
`getSnapshot` on render and re-renders whenever a listener fires and the snapshot changed.

```ts
type Listener = () => void

const KEY = 'branchstory.token'
const listeners = new Set<Listener>()
let token: string | null = sessionStorage.getItem(KEY)

function emit() {
  for (const l of listeners) l()
}

export const session = {
  getToken(): string | null {
    return token
  },
  setToken(next: string) {
    token = next
    sessionStorage.setItem(KEY, next)
    emit()
  },
  clear() {
    if (token === null) return
    token = null
    sessionStorage.removeItem(KEY)
    emit()
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}
```

:::pro title="sessionStorage, memory, or a cookie?"
`sessionStorage` survives a reload but not a new tab, and any XSS can read it. The most robust
production setup is a **BFF** (backend-for-frontend): the server does the OIDC dance and keeps the
token, the browser only holds an `HttpOnly; Secure; SameSite=Strict` cookie. For a learning project
a short-lived token in `sessionStorage` plus a strict Content-Security-Policy is a reasonable
trade-off — but know the stronger option exists, because interviewers ask.
:::

**6. The typed client** — `web/src/lib/api.ts`

```ts
import { config } from './config'
import { session } from './session'
import type {
  DevTokenResponse,
  Me,
  Member,
  ProblemDetails,
  ProjectDetail,
  ProjectSummary,
  SaveDocRequest,
  SaveDocResponse,
  ShareRequest,
} from './types'

export class ApiError extends Error {
  readonly status: number
  readonly problem: ProblemDetails

  constructor(status: number, problem: ProblemDetails) {
    super(problem.detail ?? problem.title ?? `HTTP ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.problem = problem
  }

  get isConflict(): boolean {
    return this.status === 409
  }

  /** On a 409 from PUT /doc the API tells us which version the server has. */
  get currentVersion(): number | undefined {
    return typeof this.problem.currentVersion === 'number' ? this.problem.currentVersion : undefined
  }
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown
}

async function readProblem(res: Response): Promise<ProblemDetails> {
  try {
    const text = await res.text()
    if (text) return JSON.parse(text) as ProblemDetails
  } catch {
    // not JSON (e.g. an HTML error page from a proxy)
  }
  return { status: res.status, title: res.statusText || `HTTP ${res.status}` }
}

export async function apiFetch<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers = new Headers(opts.headers)
  headers.set('Accept', 'application/json, application/problem+json')
  const token = session.getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)

  let body: BodyInit | undefined
  if (opts.body !== undefined) {
    headers.set('Content-Type', 'application/json')
    body = JSON.stringify(opts.body)
  }

  const res = await fetch(`${config.apiBase}${path}`, { ...opts, headers, body })
  if (res.status === 401) session.clear() // expired or revoked → back to the login page
  if (!res.ok) throw new ApiError(res.status, await readProblem(res))
  if (res.status === 204) return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

const enc = encodeURIComponent

export const api = {
  devToken: (username: string, displayName?: string) =>
    apiFetch<DevTokenResponse>('/api/dev/token', { method: 'POST', body: { username, displayName } }),
  me: () => apiFetch<Me>('/api/me'),

  listProjects: () => apiFetch<ProjectSummary[]>('/api/projects'),
  createProject: (title: string) => apiFetch<ProjectDetail>('/api/projects', { method: 'POST', body: { title } }),
  getProject: (id: string) => apiFetch<ProjectDetail>(`/api/projects/${enc(id)}`),
  saveDoc: (id: string, req: SaveDocRequest) =>
    apiFetch<SaveDocResponse>(`/api/projects/${enc(id)}/doc`, { method: 'PUT', body: req }),

  listMembers: (id: string) => apiFetch<Member[]>(`/api/projects/${enc(id)}/members`),
  shareProject: (id: string, req: ShareRequest) =>
    apiFetch<Member>(`/api/projects/${enc(id)}/members`, { method: 'PUT', body: req }),
  removeMember: (id: string, userId: string) =>
    apiFetch<void>(`/api/projects/${enc(id)}/members/${enc(userId)}`, { method: 'DELETE' }),
}
```

:::pro title="Generate the client instead?"
Your API publishes OpenAPI (cap-03). Tools like `openapi-typescript` turn that document into
types, so a renamed C# property breaks the frontend **build** instead of production. Many teams
commit the generated file and fail CI when it is stale. Hand-written types are fine while the API
is small — but put the generator on your list.
:::

**7. Auth module** — six small files.

`web/src/modules/auth/AuthContext.ts`

```ts
import { createContext, use } from 'react'
import type { Me } from '../../lib/types'

export interface AuthState {
  token: string | null
  user: Me | undefined
  isLoading: boolean
  error: Error | null
  signInDev(username: string, displayName?: string): Promise<void>
  signInOidc(): Promise<void>
  signOut(): void
}

export const AuthContext = createContext<AuthState | null>(null)

export function useAuth(): AuthState {
  const ctx = use(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
```

`web/src/modules/auth/oidc.ts` — only used when `VITE_AUTH_MODE=oidc`. `oidc-client-ts` does
Authorization Code + **PKCE** by default: it creates a random `code_verifier`, sends its SHA-256
hash as `code_challenge`, and later proves possession — so a stolen `code` is useless.

```ts
import { UserManager, WebStorageStateStore } from 'oidc-client-ts'
import { config } from '../../lib/config'
import { session } from '../../lib/session'

let manager: UserManager | null = null

export function oidc(): UserManager {
  if (!manager) {
    manager = new UserManager({
      authority: config.oidc.authority,
      client_id: config.oidc.clientId,
      redirect_uri: `${window.location.origin}/auth/callback`,
      post_logout_redirect_uri: `${window.location.origin}/login`,
      response_type: 'code',
      scope: 'openid profile email',
      userStore: new WebStorageStateStore({ store: window.sessionStorage }),
      automaticSilentRenew: true,
    })
    // Silent renew hands us fresh tokens before the old one expires. Registered once, here,
    // so it isn't added again on every sign-in (and isn't forgotten on other code paths).
    manager.events.addUserLoaded((u) => session.setToken(u.access_token))
  }
  return manager
}

export async function completeOidcSignIn(): Promise<void> {
  const user = await oidc().signinRedirectCallback()
  session.setToken(user.access_token)
}
```

`web/src/modules/auth/AuthProvider.tsx`

```tsx
import { useCallback, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { config } from '../../lib/config'
import { session } from '../../lib/session'
import { AuthContext, type AuthState } from './AuthContext'

export function AuthProvider({ children }: { children: ReactNode }) {
  const token = useSyncExternalStore(session.subscribe, session.getToken)
  const queryClient = useQueryClient()

  const me = useQuery({
    queryKey: ['me', token],
    queryFn: api.me,
    enabled: token !== null,
    staleTime: 5 * 60_000,
  })

  // Whenever the token goes away (Sign out, or a 401 that made apiFetch clear the session),
  // drop every cached query: the next person to sign in in this tab must never see the
  // previous user's projects. Doing it here, not only in signOut, covers the 401 path too.
  useEffect(() => {
    if (token === null) queryClient.clear()
  }, [token, queryClient])

  const signInDev = useCallback(async (username: string, displayName?: string) => {
    const res = await api.devToken(username, displayName)
    session.setToken(res.accessToken)
  }, [])

  const signInOidc = useCallback(async () => {
    const { oidc } = await import('./oidc')
    await oidc().signinRedirect()
  }, [])

  const signOut = useCallback(() => {
    session.clear() // → token becomes null → the effect above clears the cache
    if (config.authMode === 'oidc') {
      void import('./oidc').then(({ oidc }) => oidc().signoutRedirect())
    }
  }, [])

  const value = useMemo<AuthState>(
    () => ({
      token,
      user: me.data,
      isLoading: token !== null && me.isPending,
      error: me.error,
      signInDev,
      signInOidc,
      signOut,
    }),
    [token, me.data, me.isPending, me.error, signInDev, signInOidc, signOut],
  )

  return <AuthContext value={value}>{children}</AuthContext>
}
```

`web/src/modules/auth/RequireAuth.tsx` — the guard is a **layout route**: every child route is
protected without repeating anything.

```tsx
import { Navigate, Outlet, useLocation } from 'react-router'
import { Button, Spinner } from '../ui'
import { useAuth } from './AuthContext'

export function RequireAuth() {
  const { token, user, isLoading, error, signOut } = useAuth()
  const location = useLocation()

  if (!token) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  if (error) {
    return (
      <main className="bs-center">
        <p role="alert">Could not load your account: {error.message}</p>
        <Button onClick={signOut}>Sign in again</Button>
      </main>
    )
  }
  if (isLoading || !user) return <Spinner label="Loading your account" />
  return <Outlet />
}
```

`web/src/modules/auth/LoginPage.tsx`

```tsx
import { useState, type FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { config } from '../../lib/config'
import { Button, TextField } from '../ui'
import { useAuth } from './AuthContext'

export function LoginPage() {
  const { token, signInDev, signInOidc } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from ?? '/projects'
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (token) return <Navigate to={from} replace />

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await signInDev(username.trim(), displayName.trim() || undefined)
      void navigate(from, { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="bs-center">
      <div className="bs-card bs-stack bs-login">
        <h1>Sign in to BranchStory</h1>
        {config.authMode === 'oidc' ? (
          <Button variant="primary" onClick={() => void signInOidc()}>
            Sign in with Keycloak
          </Button>
        ) : (
          <form onSubmit={onSubmit} className="bs-stack">
            <TextField
              label="Username"
              required
              autoComplete="username"
              pattern="[a-z0-9\-]{2,64}"
              hint="Lowercase letters, digits and dashes. Your email becomes <username>@branchstory.test."
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <TextField label="Display name" autoComplete="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
            <p className="bs-muted">Development sign-in: the API issues a token for any username.</p>
          </form>
        )}
        {error && <p role="alert" className="bs-error">{error}</p>}
      </div>
    </main>
  )
}
```

:::warn title="The pattern attribute is a v-flag regex"
Browsers compile `pattern` with the RegExp `v` flag, where `-`, `(`, `)`, `[`, `{`, `|` and `/`
are syntax characters even inside `[...]`. An unescaped `[a-z0-9-]` is an **invalid** pattern: the
browser logs a console warning and silently skips the check. Escape the dash, `[a-z0-9\-]`. JSX
string attributes don't process backslash escapes, so `\-` reaches the browser unchanged. The API
validates the username anyway (cap-03); the pattern is just faster feedback.
:::

`web/src/modules/auth/AuthCallback.tsx` — the OIDC redirect target. The ref guard matters: in
StrictMode effects run twice, and an authorization `code` can be redeemed only **once**.

```tsx
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { Spinner } from '../ui'
import { completeOidcSignIn } from './oidc'

export function AuthCallback() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    completeOidcSignIn().then(
      () => void navigate('/projects', { replace: true }),
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    )
  }, [navigate])

  if (error) return <p role="alert">Sign-in failed: {error}</p>
  return <Spinner label="Finishing sign-in" />
}
```

:::info title="Optional: Keycloak instead of the dev issuer"
If you added Keycloak to compose (the cap-03 "Swapping in Keycloak" note), its realm `branchstory`
needs a **public** client `branchstory-web`: *Standard flow* on, *Direct access grants* off, *PKCE
method* `S256`, valid redirect URI `http://localhost:5173/auth/callback`, web origin
`http://localhost:5173`, plus an audience mapper adding `branchstory-api`. Start the API with
`Auth__Authority=http://localhost:8080/realms/branchstory`, set `VITE_AUTH_MODE=oidc` and restart Vite. No other file changes — that is the payoff of the module boundary.
:::

**8. Test setup** — `web/src/test/setup.ts`

```ts
import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { session } from '../lib/session'

afterEach(() => {
  cleanup()
  session.clear()
})
```

`web/src/test/http.ts` — a small helper to build fake responses:

```ts
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
  })
}
```

**9. Tests for the client** — `web/src/lib/api.test.ts`

```ts
import { describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'
import { session } from './session'
import { json } from '../test/http'

describe('apiFetch', () => {
  it('sends the bearer token', async () => {
    session.setToken('abc')
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json([]))
    vi.stubGlobal('fetch', fetchMock)

    await api.listProjects()

    const init = fetchMock.mock.calls[0][1]
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer abc')
  })

  it('turns a 409 ProblemDetails into an ApiError with currentVersion', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ title: 'Version conflict', status: 409, currentVersion: 7 }, 409)))

    const err = await api.saveDoc('p1', { expectedVersion: 5, doc: { startNodeId: null, nodes: [], edges: [] } }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).isConflict).toBe(true)
    expect((err as ApiError).currentVersion).toBe(7)
  })

  it('clears the session on 401', async () => {
    session.setToken('expired')
    vi.stubGlobal('fetch', vi.fn(async () => json({ title: 'Unauthorized', status: 401 }, 401)))

    await expect(api.me()).rejects.toBeInstanceOf(ApiError)
    expect(session.getToken()).toBeNull()
  })
})
```

Run it:

```bash
npm test
```

- [ ] `npm install` finished and the template demo files are gone
- [ ] `vite.config.ts` proxies `/api` and `/hubs` (with `ws: true`) to the API
- [ ] `src/lib/{config,types,storyDoc,session,api}.ts` and the six auth files (`AuthContext`, `oidc`, `AuthProvider`, `RequireAuth`, `LoginPage`, `AuthCallback`) exist
- [ ] `npm test` runs the three `apiFetch` tests and they pass
- [ ] I can explain why `VITE_` variables must never contain secrets
:::

## Error handling is a design decision

`ApiError` keeps the raw `ProblemDetails`. UI code then asks *questions* of it (“is this a
conflict?”, “which field is invalid?”) instead of parsing strings. The next challenge builds
exactly that translation layer, as a pure function you can unit test.

:::challenge id=cap-05-c1 lang=ts xp=50
title: Translate ProblemDetails into UI states
Write `describeApiError(status, problem)` returning an `ApiFailure`:

| status | result |
|---|---|
| 401 | `{ kind: 'unauthorized' }` |
| 403 | `{ kind: 'forbidden' }` |
| 404 | `{ kind: 'notFound' }` |
| 409 | `{ kind: 'conflict', currentVersion }` — the number from `problem.currentVersion`, or `null` if it is missing or not a number |
| 400 or 422 | `{ kind: 'validation', fields }` — for every key in `problem.errors` take the **first** message; lowercase the **first letter** of the key (`Name` → `name`, `Doc.Nodes` → `doc.Nodes`). No `errors` → `fields: {}` |
| anything else | `{ kind: 'server', status, message }` — `message` = `detail`, else `title`, else `` `HTTP ${status}` `` |

hint: A `switch (status)` with `case 400: case 422:` sharing one branch.
hint: `Object.entries(problem.errors ?? {})` gives you `[key, messages]` pairs.
hint: `key.charAt(0).toLowerCase() + key.slice(1)`

```ts setup
type Problem = {
  title?: string
  detail?: string
  errors?: Record<string, string[]>
  currentVersion?: unknown
}

type ApiFailure =
  | { kind: 'unauthorized' }
  | { kind: 'forbidden' }
  | { kind: 'notFound' }
  | { kind: 'conflict'; currentVersion: number | null }
  | { kind: 'validation'; fields: Record<string, string> }
  | { kind: 'server'; status: number; message: string }
```

```ts starter
export function describeApiError(status: number, problem: Problem): ApiFailure {
  return { kind: 'server', status, message: 'Something went wrong' }
}
```

```ts solution
export function describeApiError(status: number, problem: Problem): ApiFailure {
  switch (status) {
    case 401:
      return { kind: 'unauthorized' }
    case 403:
      return { kind: 'forbidden' }
    case 404:
      return { kind: 'notFound' }
    case 409:
      return {
        kind: 'conflict',
        currentVersion: typeof problem.currentVersion === 'number' ? problem.currentVersion : null,
      }
    case 400:
    case 422: {
      const fields: Record<string, string> = {}
      for (const [key, messages] of Object.entries(problem.errors ?? {})) {
        if (messages.length) fields[key.charAt(0).toLowerCase() + key.slice(1)] = messages[0]
      }
      return { kind: 'validation', fields }
    }
    default:
      return { kind: 'server', status, message: problem.detail ?? problem.title ?? `HTTP ${status}` }
  }
}
```

```ts tests
test('401, 403 and 404 map to their kinds', () => {
  expect(describeApiError(401, {})).toEqual({ kind: 'unauthorized' })
  expect(describeApiError(403, { title: 'Forbidden' })).toEqual({ kind: 'forbidden' })
  expect(describeApiError(404, {})).toEqual({ kind: 'notFound' })
})
test('409 carries the server version', () => {
  expect(describeApiError(409, { currentVersion: 12 })).toEqual({ kind: 'conflict', currentVersion: 12 })
})
test('409 without a numeric version gives null', () => {
  expect(describeApiError(409, { currentVersion: '12' })).toEqual({ kind: 'conflict', currentVersion: null })
  expect(describeApiError(409, {})).toEqual({ kind: 'conflict', currentVersion: null })
})
test('validation keeps the first message per field, camelCased', () => {
  const r = describeApiError(400, { errors: { Name: ['Required', 'Too short'], 'Doc.Nodes': ['Max 500 scenes'] } })
  expect(r).toEqual({ kind: 'validation', fields: { name: 'Required', 'doc.Nodes': 'Max 500 scenes' } })
})
test('422 is validation too, and missing errors is an empty map', () => {
  expect(describeApiError(422, { title: 'Unprocessable' })).toEqual({ kind: 'validation', fields: {} })
})
test('other statuses prefer detail, then title, then HTTP code', () => {
  expect(describeApiError(500, { title: 'Boom', detail: 'Database is down' })).toEqual({ kind: 'server', status: 500, message: 'Database is down' })
  expect(describeApiError(502, { title: 'Bad Gateway' })).toEqual({ kind: 'server', status: 502, message: 'Bad Gateway' })
  expect(describeApiError(503, {})).toEqual({ kind: 'server', status: 503, message: 'HTTP 503' })
})
```
:::

## Server state with TanStack Query

The projects list is not *your* data: the API owns it, and someone else can change it while you
look at it. Data like that is **server state**, and it needs things plain `useState` doesn't
give you: a cache shared by every component that needs it, deduplication when three components
ask at once, refetching when it gets old, and a way to say "this is out of date now" after you
change something. TanStack Query does exactly that, using five ideas you'll see in lab 2:

| Word | Meaning | In BranchStory |
|---|---|---|
| **query key** | The cache address of one piece of data. Same key = same cache entry, shared everywhere. | `['projects', 'detail', 'p1']` |
| **query function** | How to fetch it. Must throw on failure, which `apiFetch` already does. | `() => fetchProject('p1')` |
| **staleTime** | How long cached data counts as fresh. Fresh data is served without a request; stale data is shown *and* refetched in the background. | 30 s by default in `main.tsx` |
| **mutation** | A write (`POST`/`PUT`/`DELETE`), with `onMutate` / `onError` / `onSuccess` / `onSettled` hooks around it. | `useShareProject` |
| **invalidation** | Marking cached queries stale after a write, so active ones refetch. Keys are prefixes: invalidating `['projects']` hits the list, every detail and every member list. | `invalidateQueries({ queryKey: projectKeys.members(id) })` |

The rule that matters most: **everything a query function uses must be in its key.** The key is
how the cache tells "project p1" apart from "project p2". Leave the id out and both pages share
one cache entry.

:::quiz id=cap-05-q1 xp=15
Where should the list of projects (from `GET /api/projects`) live in the frontend?
- [ ] In a global Redux/Zustand store, filled by a `useEffect` in the layout
- [x] In the TanStack Query cache under a key like `['projects', 'list']`
- [ ] In `localStorage`, so it survives reloads
- [ ] In component state of `ProjectsPage`, re-fetched on every mount
> It is **server state**: owned by the API, possibly changed by other people, needing caching,
> refetching and invalidation after mutations. TanStack Query gives you all of that. A global
> store *can* hold it, which makes it tempting, but then you hand-write loading flags, error
> handling, deduplication and "refetch after save" yourself. `localStorage` serves stale data
> across sessions (and users), and component state throws the data away on every navigation.
> Client-only state (the unsaved editor document, a dialog being open) stays in React state.
:::

:::quiz id=cap-05-q5 xp=15
Spot the bug. A teammate writes this hook, and users report that opening story B briefly shows
story A's title, and sometimes it keeps showing it:

```ts
export function useProject(id: string) {
  return useQuery({ queryKey: ['projects', 'detail'], queryFn: () => fetchProject(id) })
}
```

What is wrong?
- [ ] `queryFn` must be an `async` function declared with `async`
- [x] The key doesn't include `id`, so every project shares one cache entry
- [ ] `useQuery` can't be wrapped in a custom hook
- [ ] `staleTime` is missing, so the query never refetches
> The query key is the cache address. Without the id, story A's data is served as fresh for story B
> until something refetches it, and after that the two pages overwrite each other. That's why
> `projectKeys.detail(id)` puts the id in the key. `queryFn` only has to return a promise, which
> `() => fetchProject(id)` does. Custom hooks around `useQuery` are the recommended pattern.
> `staleTime` changes *when* data refetches, but it doesn't fix two different resources sharing one key.
:::

## Design tokens and a small UI kit

A UI kit does not have to be a library. Five components with good defaults beat fifty with
props for everything. The important part is **tokens**: every colour, radius and spacing is a CSS
custom property, so dark mode, theming and a later brand refresh are one file.

:::lab id=cap-05-lab2 xp=150
title: UI kit, routing, projects list and the share dialog

**1. Tokens** — `web/src/modules/ui/tokens.css`

```css
:root {
  color-scheme: light dark;
  --bs-font: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --bs-mono: ui-monospace, 'Cascadia Code', 'SF Mono', monospace;

  --bs-space-1: 4px;
  --bs-space-2: 8px;
  --bs-space-3: 12px;
  --bs-space-4: 16px;
  --bs-space-6: 24px;
  --bs-radius: 8px;
  --bs-radius-lg: 14px;

  --bs-bg: #f6f6fa;
  --bs-surface: #ffffff;
  --bs-surface-2: #eeeef5;
  --bs-text: #1b1b24;
  --bs-muted: #555569;
  --bs-border: #d5d5e1;
  --bs-primary: #4338ca;
  --bs-primary-text: #ffffff;
  --bs-danger: #b42318;
  --bs-danger-text: #ffffff;
  --bs-success: #067647;
  --bs-focus: #2563eb;
  --bs-shadow: 0 10px 30px rgb(0 0 0 / 0.14);
}

@media (prefers-color-scheme: dark) {
  :root {
    --bs-bg: #101017;
    --bs-surface: #1a1a24;
    --bs-surface-2: #242432;
    --bs-text: #ececf3;
    --bs-muted: #a9a9bd;
    --bs-border: #36364a;
    --bs-primary: #8b85ff;
    --bs-primary-text: #10101a;
    --bs-danger: #ff8a80;
    --bs-danger-text: #1a0f0f;
    --bs-success: #6ce9a6;
    --bs-focus: #93c5fd;
    --bs-shadow: 0 10px 30px rgb(0 0 0 / 0.5);
  }
}
```

**2. Base + component styles** — `web/src/modules/ui/ui.css`

```css
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; font-family: var(--bs-font); background: var(--bs-bg); color: var(--bs-text); line-height: 1.5; }
h1, h2, h3 { line-height: 1.2; margin: 0; }
a { color: var(--bs-primary); }
:focus-visible { outline: 3px solid var(--bs-focus); outline-offset: 2px; }

.bs-visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.bs-skip { position: absolute; left: -999px; }
.bs-skip:focus { left: var(--bs-space-4); top: var(--bs-space-2); z-index: 10; background: var(--bs-surface); padding: var(--bs-space-2); }
.bs-muted { color: var(--bs-muted); }
.bs-error { color: var(--bs-danger); margin: 0; }
.bs-stack { display: flex; flex-direction: column; gap: var(--bs-space-4); }
.bs-row { display: flex; flex-wrap: wrap; gap: var(--bs-space-2); align-items: center; }
.bs-row--end { align-items: flex-end; }
.bs-center { min-height: 100vh; display: grid; place-items: center; padding: var(--bs-space-4); }
.bs-card { background: var(--bs-surface); border: 1px solid var(--bs-border); border-radius: var(--bs-radius-lg); padding: var(--bs-space-4); }
.bs-login { width: min(420px, 100%); }

.bs-header { display: flex; align-items: center; gap: var(--bs-space-4); padding: var(--bs-space-3) var(--bs-space-6); background: var(--bs-surface); border-bottom: 1px solid var(--bs-border); }
.bs-header__brand { font-weight: 700; text-decoration: none; color: var(--bs-text); }
.bs-header__spacer { flex: 1; }
.bs-page { padding: var(--bs-space-6); max-width: 1100px; margin: 0 auto; }

.bs-btn { font: inherit; border-radius: var(--bs-radius); border: 1px solid var(--bs-border); padding: 6px 14px; cursor: pointer; background: var(--bs-surface); color: var(--bs-text); }
.bs-btn:disabled { opacity: 0.55; cursor: not-allowed; }
.bs-btn--primary { background: var(--bs-primary); color: var(--bs-primary-text); border-color: transparent; }
.bs-btn--danger { background: var(--bs-danger); color: var(--bs-danger-text); border-color: transparent; }
.bs-btn--ghost { background: transparent; border-color: transparent; }

.bs-field { display: flex; flex-direction: column; gap: var(--bs-space-1); min-width: 200px; }
.bs-field label { font-size: 0.875rem; font-weight: 600; }
.bs-field input, .bs-field textarea, .bs-field select { font: inherit; color: inherit; background: var(--bs-surface); border: 1px solid var(--bs-border); border-radius: var(--bs-radius); padding: 6px 10px; }
.bs-field [aria-invalid='true'] { border-color: var(--bs-danger); }
.bs-field__hint { font-size: 0.8rem; color: var(--bs-muted); }

.bs-badge { display: inline-block; font-size: 0.75rem; padding: 1px 8px; border-radius: 999px; background: var(--bs-surface-2); text-transform: capitalize; }
.bs-badge--owner { background: var(--bs-primary); color: var(--bs-primary-text); }

.bs-spinner { display: grid; place-items: center; padding: var(--bs-space-6); }
.bs-spinner::before { content: ''; width: 28px; height: 28px; border-radius: 50%; border: 3px solid var(--bs-border); border-top-color: var(--bs-primary); animation: bs-spin 0.8s linear infinite; }
@keyframes bs-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .bs-spinner::before { animation: none; } }

.bs-dialog-backdrop { position: fixed; inset: 0; background: rgb(0 0 0 / 0.45); display: grid; place-items: center; padding: var(--bs-space-4); z-index: 50; }
.bs-dialog { background: var(--bs-surface); border-radius: var(--bs-radius-lg); box-shadow: var(--bs-shadow); padding: var(--bs-space-6); width: min(560px, 100%); display: flex; flex-direction: column; gap: var(--bs-space-4); max-height: 90vh; overflow: auto; }

.bs-project-list, .bs-member-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--bs-space-2); }
.bs-project-list li, .bs-member-list li { display: flex; align-items: center; gap: var(--bs-space-3); }
.bs-project-list a { font-weight: 600; flex: 1; }
.bs-member-list li > span:first-child { flex: 1; }
```

**3. Components** — each is small on purpose.

`web/src/modules/ui/Button.tsx`

```tsx
import type { ComponentProps } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'

export function Button({
  variant = 'secondary',
  type = 'button',
  className = '',
  ...rest
}: ComponentProps<'button'> & { variant?: ButtonVariant }) {
  // type="button" by default: a button inside a form must not submit by accident
  return <button type={type} className={`bs-btn bs-btn--${variant} ${className}`.trim()} {...rest} />
}
```

`web/src/modules/ui/TextField.tsx` — the label is always wired up, the error is announced via
`aria-describedby`, so screen readers and `getByLabelText` both just work.

```tsx
import { useId, type ComponentProps, type ReactNode } from 'react'

interface FieldProps {
  label: string
  error?: string
  hint?: string
}

function describedBy(id: string, error?: string, hint?: string) {
  return [error && `${id}-error`, hint && `${id}-hint`].filter(Boolean).join(' ') || undefined
}

function FieldShell({ id, label, error, hint, children }: FieldProps & { id: string; children: ReactNode }) {
  return (
    <div className="bs-field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <span id={`${id}-hint`} className="bs-field__hint">{hint}</span>}
      {error && <span id={`${id}-error`} className="bs-error">{error}</span>}
    </div>
  )
}

export function TextField({ label, error, hint, id, ...rest }: FieldProps & ComponentProps<'input'>) {
  const auto = useId()
  const fid = id ?? auto
  return (
    <FieldShell id={fid} label={label} error={error} hint={hint}>
      <input id={fid} aria-invalid={error ? true : undefined} aria-describedby={describedBy(fid, error, hint)} {...rest} />
    </FieldShell>
  )
}

export function TextAreaField({ label, error, hint, id, ...rest }: FieldProps & ComponentProps<'textarea'>) {
  const auto = useId()
  const fid = id ?? auto
  return (
    <FieldShell id={fid} label={label} error={error} hint={hint}>
      <textarea id={fid} aria-invalid={error ? true : undefined} aria-describedby={describedBy(fid, error, hint)} {...rest} />
    </FieldShell>
  )
}

export function SelectField({ label, error, hint, id, children, ...rest }: FieldProps & ComponentProps<'select'>) {
  const auto = useId()
  const fid = id ?? auto
  return (
    <FieldShell id={fid} label={label} error={error} hint={hint}>
      <select id={fid} aria-invalid={error ? true : undefined} aria-describedby={describedBy(fid, error, hint)} {...rest}>
        {children}
      </select>
    </FieldShell>
  )
}
```

`web/src/modules/ui/Dialog.tsx` — modal, labelled by its title, focus moves in on open and back
out on close, `Tab` is trapped, `Escape` closes unless `dismissible={false}`. An element with
`data-autofocus` gets the initial focus.

```tsx
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

export interface DialogProps {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  dismissible?: boolean
}

export function Dialog({ open, title, onClose, children, dismissible = true }: DialogProps) {
  const titleId = useId()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const previouslyFocused = document.activeElement as HTMLElement | null
    const el = ref.current
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE)
    ;(first ?? el)?.focus()
    return () => previouslyFocused?.focus()
  }, [open])

  if (!open) return null

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape' && dismissible) {
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key !== 'Tab') return
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
    if (items.length === 0) return
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div
      className="bs-dialog-backdrop"
      onMouseDown={(e) => {
        if (dismissible && e.target === e.currentTarget) onClose()
      }}
    >
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="bs-dialog" onKeyDown={onKeyDown}>
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  )
}
```

`web/src/modules/ui/Spinner.tsx`

```tsx
export function Spinner({ label }: { label: string }) {
  return (
    <div role="status" className="bs-spinner">
      <span className="bs-visually-hidden">{label}</span>
    </div>
  )
}
```

`web/src/modules/ui/index.ts` — the module's public surface:

```ts
export { Button, type ButtonVariant } from './Button'
export { TextField, TextAreaField, SelectField } from './TextField'
export { Dialog, type DialogProps } from './Dialog'
export { Spinner } from './Spinner'
```

**4. Projects module.** Query keys live in **one** object, so invalidation can never typo a key.

`web/src/modules/projects/queries.ts`

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { normalizeDoc } from '../../lib/storyDoc'
import type { Member, ProjectDetail, ShareRequest } from '../../lib/types'

export const projectKeys = {
  all: ['projects'] as const,
  list: () => [...projectKeys.all, 'list'] as const,
  detail: (id: string) => [...projectKeys.all, 'detail', id] as const,
  members: (id: string) => [...projectKeys.all, 'members', id] as const,
}

export async function fetchProject(id: string): Promise<ProjectDetail> {
  const p = await api.getProject(id)
  return { ...p, doc: normalizeDoc(p.doc) }
}

export function useProjects() {
  return useQuery({ queryKey: projectKeys.list(), queryFn: api.listProjects })
}

export function useProject(id: string) {
  return useQuery({ queryKey: projectKeys.detail(id), queryFn: () => fetchProject(id) })
}

export function useCreateProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (title: string) => api.createProject(title),
    onSuccess: (created) => {
      qc.setQueryData(projectKeys.detail(created.id), { ...created, doc: normalizeDoc(created.doc) })
      return qc.invalidateQueries({ queryKey: projectKeys.list() })
    },
  })
}

export function useMembers(projectId: string) {
  return useQuery({ queryKey: projectKeys.members(projectId), queryFn: () => api.listMembers(projectId) })
}

/** PUT is idempotent: adding someone twice, or changing their role, is the same call. */
export function useShareProject(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (req: ShareRequest) => api.shareProject(projectId, req),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectKeys.members(projectId) }),
  })
}

/** Optimistic: the row disappears at once and comes back if the server says no. */
export function useRemoveMember(projectId: string) {
  const qc = useQueryClient()
  const key = projectKeys.members(projectId)
  return useMutation({
    mutationFn: (userId: string) => api.removeMember(projectId, userId),
    onMutate: async (userId) => {
      await qc.cancelQueries({ queryKey: key })
      const previous = qc.getQueryData<Member[]>(key)
      qc.setQueryData<Member[]>(key, (old) => old?.filter((m) => m.userId !== userId))
      return { previous }
    },
    onError: (_err, _userId, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  })
}
```

`web/src/modules/projects/RoleBadge.tsx`

```tsx
import type { Role } from '../../lib/types'

export function RoleBadge({ role }: { role: Role }) {
  return <span className={`bs-badge bs-badge--${role}`}>{role}</span>
}
```

`web/src/modules/projects/CreateProjectForm.tsx`

```tsx
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { Button, TextField } from '../ui'
import { useCreateProject } from './queries'

export function CreateProjectForm() {
  const [title, setTitle] = useState('')
  const create = useCreateProject()
  const navigate = useNavigate()

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const trimmed = title.trim()
    if (!trimmed) return
    try {
      const project = await create.mutateAsync(trimmed)
      setTitle('')
      void navigate(`/projects/${project.id}`)
    } catch {
      // the error is rendered below from create.error
    }
  }

  return (
    <form onSubmit={onSubmit} className="bs-row bs-row--end" aria-label="Create a story">
      <TextField label="Story title" required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
      <Button type="submit" variant="primary" disabled={create.isPending}>
        Create story
      </Button>
      {create.isError && <p role="alert" className="bs-error">{create.error.message}</p>}
    </form>
  )
}
```

`web/src/modules/projects/ShareDialog.tsx` — only the **owner** sees the Share button, but the
API re-checks it anyway (cap-04). The UI hides what you can't do; the server forbids it.

```tsx
import { useState, type FormEvent } from 'react'
import { ApiError } from '../../lib/api'
import type { ProjectSummary, ShareRole } from '../../lib/types'
import { Button, Dialog, SelectField, Spinner, TextField } from '../ui'
import { RoleBadge } from './RoleBadge'
import { useMembers, useRemoveMember, useShareProject } from './queries'

function shareErrorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return err instanceof Error ? err.message : 'Could not invite'
  switch (err.status) {
    case 404:
      return err.problem.detail ?? 'Nobody with that email has signed in to BranchStory yet.'
    case 403:
      // plan limits (seats are billed to the owner) or "only the owner can share"
      return err.problem.detail ?? 'Only the owner can share this story.'
    case 400: {
      const first = Object.values(err.problem.errors ?? {})[0]?.[0]
      return first ?? err.problem.title ?? err.message
    }
    default:
      return err.message
  }
}

export function ShareDialog({ project, onClose }: { project: ProjectSummary; onClose: () => void }) {
  const members = useMembers(project.id)
  const share = useShareProject(project.id)
  const remove = useRemoveMember(project.id)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<ShareRole>('editor')

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    try {
      await share.mutateAsync({ email: email.trim(), role })
      setEmail('')
    } catch {
      // rendered from share.error
    }
  }

  return (
    <Dialog open title={`Share “${project.title}”`} onClose={onClose}>
      <form onSubmit={onSubmit} className="bs-row bs-row--end">
        <TextField label="Email" type="email" required autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
        <SelectField label="Role" value={role} onChange={(e) => setRole(e.target.value as ShareRole)}>
          <option value="editor">Editor</option>
          <option value="viewer">Viewer</option>
        </SelectField>
        <Button type="submit" variant="primary" disabled={share.isPending}>
          Invite
        </Button>
      </form>
      {share.isError && <p role="alert" className="bs-error">{shareErrorMessage(share.error)}</p>}

      <h3>People with access</h3>
      {members.isPending ? (
        <Spinner label="Loading members" />
      ) : members.isError ? (
        <p role="alert" className="bs-error">Could not load members.</p>
      ) : (
        <ul className="bs-member-list">
          {members.data.map((m) => (
            <li key={m.userId}>
              <span>
                {m.displayName} <span className="bs-muted">{m.email}</span>
              </span>
              <RoleBadge role={m.role} />
              {m.role !== 'owner' && (
                <Button variant="ghost" aria-label={`Remove ${m.email}`} onClick={() => remove.mutate(m.userId)}>
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="bs-row">
        <Button onClick={onClose}>Close</Button>
      </div>
    </Dialog>
  )
}
```

`web/src/modules/projects/ProjectsPage.tsx`

```tsx
import { useState } from 'react'
import { Link } from 'react-router'
import type { ProjectSummary } from '../../lib/types'
import { Button, Spinner } from '../ui'
import { CreateProjectForm } from './CreateProjectForm'
import { RoleBadge } from './RoleBadge'
import { ShareDialog } from './ShareDialog'
import { useProjects } from './queries'

export function ProjectsPage() {
  const projects = useProjects()
  const [sharing, setSharing] = useState<ProjectSummary | null>(null)

  return (
    <section className="bs-stack" aria-labelledby="projects-heading">
      <h1 id="projects-heading">Your stories</h1>
      <CreateProjectForm />

      {projects.isPending ? (
        <Spinner label="Loading stories" />
      ) : projects.isError ? (
        <div role="alert" className="bs-row">
          <span className="bs-error">Could not load stories: {projects.error.message}</span>
          <Button onClick={() => void projects.refetch()}>Retry</Button>
        </div>
      ) : projects.data.length === 0 ? (
        <p className="bs-muted">No stories yet — create your first one above.</p>
      ) : (
        <ul className="bs-project-list">
          {projects.data.map((p) => (
            <li key={p.id} className="bs-card">
              <Link to={`/projects/${p.id}`}>{p.title}</Link>
              <RoleBadge role={p.role} />
              <span className="bs-muted">
                {p.role === 'owner' ? '' : `by ${p.ownerName} · `}v{p.version} · {new Date(p.updatedAt).toLocaleString()}
              </span>
              {p.role === 'owner' && (
                <Button aria-label={`Share ${p.title}`} onClick={() => setSharing(p)}>
                  Share
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {sharing && <ShareDialog project={sharing} onClose={() => setSharing(null)} />}
    </section>
  )
}
```

`web/src/modules/projects/index.ts`

```ts
export { ProjectsPage } from './ProjectsPage'
export { projectKeys, fetchProject, useProject, useProjects } from './queries'
export { RoleBadge } from './RoleBadge'
```

**5. Editor placeholder** — `web/src/modules/editor/EditorPage.tsx` (replaced in cap-06):

```tsx
import { useParams } from 'react-router'

export function EditorPage() {
  const { projectId } = useParams()
  return <p>Editor for {projectId} arrives in cap-06.</p>
}
```

**6. Layout, router, entry point.**

`web/src/app/AppLayout.tsx`

```tsx
import { Link, Outlet } from 'react-router'
import { useAuth } from '../modules/auth/AuthContext'
import { Button } from '../modules/ui'

export function AppLayout() {
  const { user, signOut } = useAuth()
  return (
    <>
      <a className="bs-skip" href="#main">Skip to content</a>
      <header className="bs-header">
        <Link to="/projects" className="bs-header__brand">BranchStory</Link>
        <span className="bs-header__spacer" />
        <span className="bs-muted">{user?.displayName}</span>
        <Button variant="ghost" onClick={signOut}>Sign out</Button>
      </header>
      <main id="main" className="bs-page">
        <Outlet />
      </main>
    </>
  )
}
```

`web/src/app/NotFound.tsx`

```tsx
import { Link } from 'react-router'

export function NotFound() {
  return (
    <main className="bs-center">
      <div className="bs-stack">
        <h1>Page not found</h1>
        <Link to="/projects">Back to your stories</Link>
      </div>
    </main>
  )
}
```

`web/src/app/router.tsx` — the editor and the OIDC callback are **lazy** routes: users who only
browse the list never download the editor, and dev-sign-in users never download `oidc-client-ts`.

```tsx
import { createBrowserRouter, Navigate } from 'react-router'
import { LoginPage } from '../modules/auth/LoginPage'
import { RequireAuth } from '../modules/auth/RequireAuth'
import { ProjectsPage } from '../modules/projects'
import { AppLayout } from './AppLayout'
import { NotFound } from './NotFound'

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/auth/callback',
    lazy: async () => {
      const { AuthCallback } = await import('../modules/auth/AuthCallback')
      return { Component: AuthCallback }
    },
  },
  {
    path: '/',
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { index: true, element: <Navigate to="/projects" replace /> },
          { path: 'projects', element: <ProjectsPage /> },
          {
            path: 'projects/:projectId',
            lazy: async () => {
              const { EditorPage } = await import('../modules/editor/EditorPage')
              return { Component: EditorPage }
            },
          },
        ],
      },
    ],
  },
  { path: '*', element: <NotFound /> },
])
```

`web/src/main.tsx`

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from 'react-router/dom'
import { router } from './app/router'
import { ApiError } from './lib/api'
import { AuthProvider } from './modules/auth/AuthProvider'
import './modules/ui/tokens.css'
import './modules/ui/ui.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // retrying a 403 or 404 only delays the error; retry network/5xx twice
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
)
```

**7. A component test with real providers** — `web/src/test/render.tsx`

```tsx
import type { ReactElement } from 'react'
import { render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'

export function renderWithProviders(ui: ReactElement, { route = '/', path = '/' } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path={path} element={ui} />
          <Route path="/projects/:projectId" element={<p>editor stub</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
```

`web/src/modules/projects/ProjectsPage.test.tsx` — mock only the network edge (`fetch`), keep
everything else real:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProjectsPage } from './ProjectsPage'
import { renderWithProviders } from '../../test/render'
import { json } from '../../test/http'

const lighthouse = {
  id: 'p1',
  title: 'The Lighthouse',
  role: 'owner',
  ownerName: 'Ada',
  version: 3,
  updatedAt: '2026-01-01T00:00:00Z',
}

describe('ProjectsPage', () => {
  it('lists stories and opens the editor after creating one', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/api/projects') && method === 'GET') return json([lighthouse])
      if (url.endsWith('/api/projects') && method === 'POST') {
        return json({ id: 'p2', title: 'Night Train', role: 'owner', ownerId: 'u1', version: 1, doc: {}, updatedAt: '2026-01-02T00:00:00Z' }, 201)
      }
      return json({ title: 'not mocked' }, 500)
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    renderWithProviders(<ProjectsPage />, { route: '/projects', path: '/projects' })

    expect(await screen.findByRole('link', { name: 'The Lighthouse' })).toHaveAttribute('href', '/projects/p1')
    expect(screen.getByRole('button', { name: 'Share The Lighthouse' })).toBeInTheDocument()

    await user.type(screen.getByLabelText('Story title'), 'Night Train')
    await user.click(screen.getByRole('button', { name: 'Create story' }))

    expect(await screen.findByText('editor stub')).toBeInTheDocument()
    const post = fetchMock.mock.calls.find(([, i]) => i?.method === 'POST')
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ title: 'Night Train' })
  })

  it('shows an alert with a retry button when loading fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ title: 'Database unavailable', status: 503 }, 503)))

    renderWithProviders(<ProjectsPage />, { route: '/projects', path: '/projects' })

    expect(await screen.findByRole('alert')).toHaveTextContent('Database unavailable')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})
```

**8. Run everything**

```bash
npm test          # 5 tests green
npx tsc -b        # no type errors
npm run dev       # http://localhost:5173
```

Sign in as `cleo` (not `ada`: she already owns 3 projects from the cap-03/04 labs, the free-plan
limit, so her Create story would get a 403), create a story, go back, click **Share**, invite
`grace@branchstory.test` as viewer (sign in as `grace` once in a private window first, so the
account exists — cap-04 only shares with people who have signed in), and check that Grace sees the
story with a `viewer` badge, "by cleo", and **no** Share button.

- [ ] `npm test` passes all five tests and `npx tsc -b` reports no errors
- [ ] Signing in, creating a story and landing on `/projects/<id>` works against the real API
- [ ] The share dialog traps `Tab`, closes on `Escape`, and returns focus to the Share button
- [ ] A viewer sees the project with a `viewer` badge and no Share button
- [ ] In the Network tab the editor route loads its own JS chunk only when opened
- [ ] Sign out clears the projects cache (a second user never sees the first user's list)
:::

## When the SPA breaks in prod

On localhost you see every error in DevTools. In production the errors happen on other people's
machines, and you hear about them only if you planned for it. Three failures are common in
production and almost never show up locally:

* **A render throws** on data you didn't expect, such as a scene without a title from an old
  document. Without an error boundary React unmounts the whole tree, and the user sees a blank
  white page.
* **A deploy removes the chunks an open tab still needs.** The tab loaded `index.html` yesterday.
  Today's image only has today's hashed files in `/assets`, so opening the lazy editor route fails
  with *"Failed to fetch dynamically imported module"*.
* **The bundle grows quietly.** Each dependency is "only 30 kB". A year later the first load on a
  mid-range phone takes four seconds, and no single PR was to blame.

The fixes are small: a route error element, a reload-once rule for stale chunks, one error
reporter, and a bundle budget that CI enforces.

:::lab id=cap-05-lab3 xp=60
title: Make the SPA fail well

**1. One place that reports errors**: `web/src/lib/telemetry.ts`. This example uses Sentry
(`npm install @sentry/react`). GlitchTip is a self-hosted alternative that speaks the same
protocol, and the OpenTelemetry web SDK can export to the same collector as the API (cap-10). The
rest of the app only ever calls `reportError`, so swapping vendors later touches just this file.

```ts
import * as Sentry from '@sentry/react'

type Context = Record<string, string | number | boolean | undefined>

const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined

export function initTelemetry() {
  if (!dsn) return
  Sentry.init({
    dsn,
    release: import.meta.env.VITE_RELEASE as string | undefined,   // the git SHA, set at build time
    // no user info (IP addresses), cookies or headers. @sentry/react 11 replaced the old
    // `sendDefaultPii` flag with these per-category switches.
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false },
    tracesSampleRate: 0.1,
  })
}

export function reportError(error: unknown, context: Context = {}) {
  const err = error instanceof Error ? error : new Error(String(error))
  if (import.meta.env.DEV || !dsn) {
    console.error('[reportError]', err, context)
    return
  }
  // Never attach story text, tokens or emails: ids and a short "where" are enough to debug.
  Sentry.captureException(err, { extra: context })
}
```

**2. A route error element**: `web/src/app/RouteError.tsx`. React Router catches errors thrown
while rendering or loading a route and renders the nearest `errorElement` instead of a blank page.

```tsx
import { useEffect } from 'react'
import { isRouteErrorResponse, Link, useRouteError } from 'react-router'
import { reportError } from '../lib/telemetry'
import { Button } from '../modules/ui'

export function RouteError() {
  const error = useRouteError()
  const notFound = isRouteErrorResponse(error) && error.status === 404

  useEffect(() => {
    if (!notFound) reportError(error, { where: 'route', path: window.location.pathname })
  }, [error, notFound])

  return (
    <main className="bs-center">
      <div className="bs-stack" role="alert">
        <h1>{notFound ? 'Page not found' : 'Something went wrong'}</h1>
        <p>{notFound ? 'This page does not exist.' : 'Everything that was autosaved is safe. Reload to try again.'}</p>
        <Button onClick={() => window.location.reload()}>Reload</Button>
        <Link to="/projects">Back to your stories</Link>
      </div>
    </main>
  )
}
```

In `web/src/app/router.tsx`, add `errorElement: <RouteError />` to the `'/'` route and to the
`/auth/callback` route. Errors bubble up to the nearest route that has one, so these two cover the
editor, the list and the sign-in callback.

**3. Stale chunks, global handlers and query errors**: in `web/src/main.tsx`, before `createRoot`:

```tsx
import { QueryCache } from '@tanstack/react-query'
import { initTelemetry, reportError } from './lib/telemetry'

initTelemetry()

// A deploy replaced the hashed chunks this tab expects. Reload once to fetch the new index.html
// (nginx serves it with no-cache, cap-10). The timestamp stops a reload loop if the chunk is
// really broken: the second failure reaches RouteError instead.
window.addEventListener('vite:preloadError', (event) => {
  const key = 'bs:chunk-reload-at'
  if (Date.now() - Number(sessionStorage.getItem(key) ?? 0) > 10_000) {
    sessionStorage.setItem(key, String(Date.now()))
    event.preventDefault()
    window.location.reload()
  }
})
window.addEventListener('error', (e) => reportError(e.error ?? e.message, { where: 'window.error' }))
window.addEventListener('unhandledrejection', (e) => reportError(e.reason, { where: 'unhandledrejection' }))
```

and give the `QueryClient` a cache that reports what *you* should fix, which is network failures
and 5xx responses. A 403 or 409 is the API working as designed, so it is not reported:

```tsx
const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (err) => {
      if (!(err instanceof ApiError) || err.status >= 500) reportError(err, { where: 'query' })
    },
  }),
  defaultOptions: { /* unchanged */ },
})
```

**4. Slow and offline networks.** TanStack Query already pauses queries and mutations while the
browser is offline and resumes them when it comes back. Show users that this is happening:

```tsx
// web/src/lib/useOnline.ts
import { useSyncExternalStore } from 'react'
import { onlineManager } from '@tanstack/react-query'

export const useOnline = () =>
  useSyncExternalStore((cb) => onlineManager.subscribe(cb), () => onlineManager.isOnline())
```

Render `{!online && <p role="status" className="bs-banner">Offline: changes will sync when you're back.</p>}`
in `AppLayout`, and give it a style in `web/src/modules/ui/ui.css`:

```css
.bs-banner { margin: 0; padding: var(--bs-space-2) var(--bs-space-4); background: var(--bs-surface-2); border-bottom: 1px solid var(--bs-border); color: var(--bs-text); text-align: center; }
```

Then use DevTools → Network → *Offline* and *Slow 4G* to check that every button
that waits shows a spinner and that no action fails silently.

**5. A bundle budget**: `web/scripts/check-bundle.mjs`, run after `npm run build`.

```js
import { readdirSync, readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const BUDGET_KB = { entry: 150, totalJs: 450 }   // gzipped; raise them in a reviewed PR, never silently

const gz = (file) => gzipSync(readFileSync(`dist/assets/${file}`)).length / 1024
const html = readFileSync('dist/index.html', 'utf8')
const entry = html.match(/<script[^>]*type="module"[^>]*src="\/assets\/([^"]+\.js)"/)?.[1]
if (!entry) throw new Error('no entry chunk found in dist/index.html')

const js = readdirSync('dist/assets').filter((f) => f.endsWith('.js'))
const sizes = { entry: gz(entry), totalJs: js.reduce((sum, f) => sum + gz(f), 0) }

let failed = false
for (const [name, kb] of Object.entries(sizes)) {
  const ok = kb <= BUDGET_KB[name]
  failed ||= !ok
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${kb.toFixed(1)} kB gzip (budget ${BUDGET_KB[name]} kB)`)
}
process.exit(failed ? 1 : 0)
```

Add `"check:bundle": "node scripts/check-bundle.mjs"` to the scripts in `web/package.json`.
cap-09's CI runs it right after `npm run build`. The *entry* budget is the one users feel, because
the editor and `oidc-client-ts` are lazy chunks and don't count against it.

- [ ] Temporarily throwing inside `ProjectsPage` shows the "Something went wrong" page with a Reload button, not a blank page, and `reportError` logs it
- [ ] With `npm run build && npx vite preview` open on the projects list, deleting the editor chunk from `dist/assets` and then opening a story reloads the page once, then shows `RouteError` instead of looping
- [ ] A 500 from `/api/projects` is reported; a 403 is not
- [ ] With DevTools set to *Offline* the banner appears, and it disappears when you go back online
- [ ] `npm run build && npm run check:bundle` passes, and lowering the entry budget to 10 kB makes it fail
:::

:::quiz id=cap-05-q7 xp=15
You deploy a new web image at 14:00. Ada has had the projects list open since 09:00, and at 14:05
she opens a story for the first time today. The editor is a lazy route. What happens without the
`vite:preloadError` handler?
- [ ] Nothing special: the browser fetches the new editor chunk automatically
- [x] The import of yesterday's hashed chunk returns 404 (it isn't in the new image), the route fails, and she sees an error until she reloads
- [ ] nginx's SPA fallback returns `index.html` for the missing chunk, so the editor loads with the old code
- [ ] The service worker serves the old chunk from its cache
> Her tab still runs the 09:00 `index.html`, which only knows the 09:00 chunk names. Content hashes change whenever code changes, and the new image only contains the new files, so the request 404s. cap-10's nginx answers missing `/assets/` files with `=404`, not with the SPA fallback, which is good: serving HTML as JavaScript would fail with a confusing MIME error instead. BranchStory has no service worker. Reloading once fetches the new `index.html`, so the reload-once handler fixes it, and the timestamp guard keeps a truly broken chunk from causing a reload loop. Some teams also keep the previous release's assets for a day.
:::

:::quiz id=cap-05-q2 xp=15
The Share button is hidden for editors and viewers. Is that enough to stop a viewer from adding members?
- [ ] Yes — without the button there is no way to call the endpoint
- [ ] Yes, as long as the role comes from the signed JWT
- [x] No — the API must check the caller's role on every sharing request; hiding the button is only UX
- [ ] No — the frontend should also encrypt the request body
> Anyone can call `PUT /api/projects/{id}/members` with `curl` and their own token. Authorization
> lives on the server (resource-based checks from cap-03/04). The UI only avoids showing actions
> that would fail. The JWT option is tempting, but a signed token proves *who* the caller is, not
> that the browser respected the hidden button. And BranchStory deliberately keeps roles out of
> the token so removing a member takes effect immediately. Encryption is unrelated: HTTPS already
> protects the body in transit, and the attacker is the token's legitimate owner.
:::

:::quiz id=cap-05-q3 xp=15
Why does `useRemoveMember` snapshot the old list in `onMutate` and restore it in `onError`?
- [ ] TanStack Query requires every mutation to have an `onMutate`
- [x] It removes the row optimistically for instant feedback and must roll back if the server refuses
- [ ] To avoid sending the DELETE request twice
- [ ] Because `invalidateQueries` cannot run after an error
> Optimistic updates assume success. When the assumption fails (403, network error) you put the
> cache back exactly as it was, then `onSettled` refetches to be sure you match the server.
> `onMutate` is optional, and `invalidateQueries` works fine after an error (that's exactly what
> `onSettled` does). The `await qc.cancelQueries(...)` at the start matters too: it stops an
> in-flight refetch from landing *after* the optimistic update and putting the removed row back.
:::

:::quiz id=cap-05-q6 xp=15
Ada's token expires while she's on the projects page. Her next request gets a **401**. Walk
through what the shell does. Which step comes **first**?
- [ ] `RequireAuth` notices the 401 and redirects to `/login`
- [x] `apiFetch` calls `session.clear()`, so every `useSyncExternalStore` subscriber re-renders with `token === null`
- [ ] TanStack Query retries the request twice before giving up
- [ ] `AuthProvider` refreshes the token automatically in dev mode
> The 401 is handled at the network edge: `apiFetch` clears the session *before* throwing the
> `ApiError`. That change re-renders everyone subscribed to the store: `RequireAuth` now sees no
> token and renders `<Navigate to="/login">`, and `AuthProvider`'s effect clears the query cache.
> `RequireAuth` never looks at HTTP statuses, it only reacts to the token. There are no retries
> either: the `retry` function in `main.tsx` refuses to retry any `ApiError` below 500. Dev tokens
> are never refreshed; you simply sign in again.
:::

:::quiz id=cap-05-q4 xp=15
Which statements about the Vite dev proxy for `/api` and `/hubs` are true? (Select all that apply.)
- [x] The browser sees one origin, so no CORS configuration is needed in development
- [x] `ws: true` is needed so SignalR's WebSocket upgrade is forwarded
- [ ] It is also used by `vite build` output in production
- [ ] It hides the access token from the browser
> The proxy only exists in `vite dev`. In production the same single-origin shape comes from an
> ingress or nginx routing `/api` and `/hubs` to the API (cap-10). `vite build` just writes static
> files to `dist/`; there is no server left to proxy anything. The token is still in the browser:
> `apiFetch` adds the `Authorization` header itself, and the proxy only forwards it.
:::

:::cards id=cap-05-cards1 xp=20 title="Frontend shell"
Q: Server state vs client state?
A: Server state is owned by the API (projects, members) → TanStack Query cache. Client state is local (unsaved editor doc, open dialogs) → React state/reducers.
Q: Why one `projectKeys` object?
A: Every query and invalidation uses the same key factory, so a typo can't silently skip a cache entry.
Q: What does PKCE protect against?
A: A stolen authorization code: only the client holding the random `code_verifier` can exchange it for tokens. Required for public SPA clients.
Q: Why is `RequireAuth` a layout route?
A: Every child route is guarded by one element with an `<Outlet/>`, instead of repeating checks in each page.
Q: What should `apiFetch` do on a 401?
A: Clear the session so the guard sends the user to sign in again; throw an `ApiError` for the caller.
Q: Why `type="button"` as the Button default?
A: A plain `<button>` inside a form submits it; defaulting to `button` prevents accidental submits.
Q: Why lazy-load the editor route?
A: Smaller initial bundle; the heavy editor code downloads only when someone opens a story.
Q: Why keep the token in an external store instead of React state?
A: Non-React code (`apiFetch`, SignalR) must read and clear it; React subscribes with `useSyncExternalStore`.
Q: The one rule for query keys?
A: Everything the query function depends on (ids, filters) goes into the key, otherwise different resources share one cache entry.
Q: What does `staleTime` control?
A: How long cached data counts as fresh. Fresh data is served without a request; stale data is shown and refetched in the background.
:::

## Recap

- `src/modules/<feature>` keeps UI, hooks and API calls together; `lib/` is a small shared kernel that never imports modules.
- One `apiFetch` handles token, JSON and ProblemDetails; `ApiError` exposes `status`, `isConflict`, `currentVersion`.
- TanStack Query owns server state with a single key factory; mutations invalidate or update the cache, optimistically when it helps UX.
- Auth is a module: dev token today, OIDC + PKCE by flipping `VITE_AUTH_MODE`. The token lives in a small external store; when it disappears (sign-out or 401) the guard redirects and the query cache is cleared.
- Design tokens + a handful of accessible components (labelled fields, a focus-trapping dialog) carry the whole app.
- Tests mock only `fetch` and render real providers — fast, and they catch wiring bugs.
- In production the SPA fails well: a route `errorElement`, a reload-once rule for stale chunks, one `reportError` seam, an offline banner, and a bundle budget CI enforces.
