---
id: fe-20
title: Modular Frontend Architecture
level: advanced
minutes: 55
xp: 190
summary: Organise a growing React app into feature modules with public APIs, enforce dependency rules with ESLint, and know when a monorepo is worth it.
---

A 10-file project needs no architecture. A 1 000-file project with eight developers needs it badly. The
symptoms of "no architecture" are always the same: a `components/` folder with 300 files, a `utils.ts`
that everybody imports and nobody owns, changes in the billing screen that break the project board, and
pull requests that touch twelve folders for one feature.

This lesson is about the structure used by most serious React SaaS codebases today: **feature modules**
with **public APIs** and **enforced dependency rules**. None of it is React-specific magic — it's the same
idea as namespaces/assemblies in C#, applied to a frontend.

## Organise by feature, not by file type

The tutorial layout groups files by *what they are*:

```text
src/
  components/   ProjectCard.tsx  InvoiceTable.tsx  Button.tsx  UserAvatar.tsx …
  hooks/        useProjects.ts   useInvoices.ts    useDebounce.ts …
  services/     projectsApi.ts   invoicesApi.ts …
  types/        project.ts       invoice.ts …
```

To change "projects" you open four folders. To delete the billing feature you hunt through all of them. And
nothing stops `InvoiceTable` from importing `useProjects` internals — so everything slowly couples to everything.

The feature-module layout groups files by *what they are for*:

```text
src/
  app/                      # the shell: providers, router, layouts, global error boundary
    App.tsx
    router.tsx
    providers.tsx
  modules/                  # one folder per business feature
    projects/
      components/           ProjectBoard.tsx  ProjectCard.tsx  ProjectCard.test.tsx
      hooks/                useProjects.ts    useProjects.test.ts
      services/             projectsService.ts
      types/                project.ts
      index.ts              # ← the PUBLIC API of the module
    billing/
      …
      index.ts
  ui/                       # design system: Button, Input, Dialog, Tabs — no business logic
    Button.tsx
    index.ts
  shared/                   # framework-agnostic helpers: http client, formatters, date utils
    http.ts
    format.ts
```

Why this works:

- **Cohesion** — everything for one feature lives together. A feature PR touches one folder.
- **Deletability** — removing a feature is `rm -rf modules/billing` plus fixing the few imports of its `index.ts`.
- **Ownership** — a `CODEOWNERS` line per module: `src/modules/billing/ @team-payments`. (`CODEOWNERS` is a
  GitHub/GitLab file that automatically requests a review from the owning team when a PR touches their paths.)
- **Clear boundaries** — other code may only use what the module exports from `index.ts`.

:::info title="Same idea, other names"
You'll meet this as "feature-sliced design", "vertical slices", "screaming architecture" or "domain modules".
On the backend you'll see the same in a .NET **modular monolith** (one project per module with `internal`
types). The vocabulary differs; the rules — cohesion, public API, one-way dependencies — are identical.
:::

## The public API: `index.ts`

Each module has exactly one entry point:

```ts
// src/modules/projects/index.ts
export { ProjectBoard } from './components/ProjectBoard'
export { useProjects } from './hooks/useProjects'
export type { Project, ProjectId } from './types/project'
// NOT exported: ProjectCard, projectsService internals, mapping helpers…
```

Everything else is **private by convention** (and, as you'll see, by lint rule). The app shell imports:

```ts
import { ProjectBoard } from '@/modules/projects'           // ✅ public API
import { ProjectCard } from '@/modules/projects/components/ProjectCard'  // ❌ deep import
```

Why so strict? A public API is a **contract**. Inside the module you can rename files, split components,
swap the service from REST to GraphQL — as long as `index.ts` keeps exporting the same things, nobody
outside breaks. Deep imports turn every internal file into accidental public API, and refactoring becomes a
company-wide search-and-replace.

`@/` is a **path alias** so imports don't become `../../../../shared/http`:

```json
// tsconfig.app.json (excerpt) — in Vite's react-ts template the root tsconfig.json only holds "references"
{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }
```

```ts
// vite.config.ts (excerpt) — Vite 8 can read tsconfig paths natively (off by default)
export default defineConfig({ resolve: { tsconfigPaths: true }, plugins: [react()] })
```

The alias has to be known to **two** tools: TypeScript (for type-checking and editor go-to-definition) and Vite
(for actually resolving the import when bundling). A common mistake is configuring only one: the editor is happy
but `vite build` fails with *"Failed to resolve import '@/shared/http'"*, or the other way round. Since TS 4.1,
`paths` works without `baseUrl`; the paths are relative to the tsconfig file.

:::tip title="Inside a module, use relative imports"
Within `modules/projects/` import siblings with `./` and `../`. Use `@/modules/<other>` only to reach *other*
modules. This makes the lint rule below simple: "any `@/modules/x/<something>` import is a deep import".
:::

## Dependency rules: arrows point one way

The architecture only holds if dependencies flow in **one direction**:

```text
          app (shell)
            │  may import everything
            ▼
     modules/<feature>   ──►  other modules ONLY via their index.ts
            │
            ▼
           ui            (design system, no business knowledge)
            │
            ▼
         shared          (pure helpers, no React components, no features)
```

| Layer | May import | Must NOT import |
|---|---|---|
| `app` | modules (via index), ui, shared | — |
| `modules/x` | itself (any file), other modules' `index.ts`, ui, shared | other modules' internals, `app` |
| `ui` | ui, shared | modules, app |
| `shared` | shared | ui, modules, app |

The rules exist to prevent two diseases:

1. **Cycles.** `projects` imports `billing` imports `projects`. ES modules allow cycles, but one of the two
   modules necessarily runs first and sees the other half-initialised: touching an exported `const` or `class`
   too early throws `ReferenceError: Cannot access 'X' before initialization` (in Vite dev and build alike; only code
   down-levelled to `var` or CommonJS sees a silent `undefined` instead). Which one breaks depends on which file happens to be imported first, so
   the bug appears and disappears as code moves. Cycles also make bundles impossible to split and tests that need
   the whole app. A one-way graph can't cycle across layers.
2. **Upward leaks.** If `ui/Button` imports `useCurrentUser` from a feature, the design system now depends on
   auth — it can't be reused, documented in Storybook or extracted to a package.

Cross-feature communication should be rare and deliberate: through the other module's public API, through the
URL (route params), through the server (TanStack Query cache keys), or by the app shell composing two modules side by side.

:::quiz id=fe-20-q1 xp=15
Which imports **violate** the dependency rules above? (Select all that apply.)
- [x] `src/ui/Avatar.tsx` imports `useCurrentUser` from `@/modules/auth`
- [ ] `src/modules/board/components/Board.tsx` imports `{ Button }` from `@/ui`
- [x] `src/modules/board/hooks/useBoard.ts` imports `@/modules/projects/services/projectsService`
- [ ] `src/app/router.tsx` imports `{ ProjectBoard }` from `@/modules/projects`
- [x] `src/shared/format.ts` imports `{ Badge }` from `@/ui`
> `ui` must not know about features (Avatar should take the user as a prop). `useBoard` reaches into another
> module's internals — it should use what `@/modules/projects` exports. `shared` is the bottom layer and must
> not import UI components. Features using `ui`, and the shell using a module's public API, are exactly what the rules intend.
:::

## Inside a module: components, hooks, services, types

Each sub-folder has a job. Keeping the jobs separate makes each part testable on its own.

| Folder | Job | Knows about React? |
|---|---|---|
| `types/` | domain types (`Project`, `ProjectStatus`) — what the *UI* works with | no |
| `services/` | talk to the API: build URLs, call the http client, **map DTOs → domain types**, translate errors | no |
| `hooks/` | connect services to React: loading/error state, TanStack Query, subscriptions | yes |
| `components/` | render; call hooks; contain as little logic as possible | yes |

The **service** layer deserves special attention. First a term: a **DTO** (*data transfer object*) is the exact
shape of data on the wire, as the backend serialises it. A **domain type** is the shape your UI code wants to work
with. They often differ, and they change for different reasons. The API speaks the backend's language
(`created_at: "2026-03-01T10:00:00Z"`, numeric ids, `null` everywhere). Your components should speak *your*
language (`createdAt: Date`, string ids). The service is the translation boundary, so a backend rename is a
one-line change in one file instead of a hunt through 40 components.

Services take their dependencies as **parameters** (here: the http client). That's dependency injection
without a container: in tests you pass a fake; in the app you pass the real client. Compare it with a service that
does `import { http } from '@/shared/http'` at the top. To test that one you have to mock the module system
(`vi.mock`), which is slower, more magical, and couples the test to file paths.

:::quiz id=fe-20-q4 xp=10
The backend renames `created_at` to `createdUtc`. In a well-structured module, how many files should change in the frontend?
- [x] One: the service's DTO type and mapper; components keep using `project.createdAt`
- [ ] Every component that shows a date, because they all read `created_at`
- [ ] None: TypeScript renames the field automatically
- [ ] The `index.ts` of every module that uses projects
> That's the whole point of mapping DTOs to domain types at one boundary: the backend's naming leaks into exactly
> one file. If components read DTO fields directly, the rename becomes a search-and-replace across the app, and
> any place you miss silently shows `undefined`. TypeScript only *finds* the broken places if the DTO type is
> updated; it doesn't change your code for you.
:::

```ts
// src/shared/http.ts — one http client for the whole app
export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}
export interface HttpClient {
  get(url: string): Promise<unknown>
  post(url: string, body: unknown): Promise<unknown>
}
```

:::challenge id=fe-20-c1 lang=ts xp=60
title: The projects service
Implement `createProjectsService(http)` — the service layer of the `projects` module. The `setup` code
(shown above your editor) provides `HttpError`, the `HttpClient` interface and the DTO type.

Return an object with:

- `list()` — `GET /api/projects`, map every DTO to a `Project`: `id` becomes a **string**, `created_at`
  becomes `createdAt: Date`, `archived` stays. Exclude archived projects and sort by `name`.
- `get(id)` — `GET /api/projects/<id>` mapped to a `Project`. If the http client throws an `HttpError` with
  `status` 404, return `null`. Any other error is re-thrown unchanged.
- `create(name)` — trims the name; an empty name throws `Error('Project name is required')` **without**
  calling the API. Otherwise `POST /api/projects` with body `{ name }` and return the mapped project.

hint: Write one private `toProject(dto)` mapper and reuse it in all three methods.
hint: `catch (e) { if (e instanceof HttpError && e.status === 404) return null; throw e }`
hint: `[...projects].sort((a, b) => a.name.localeCompare(b.name))`

```ts setup
class HttpError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}
interface HttpClient {
  get(url: string): Promise<unknown>
  post(url: string, body: unknown): Promise<unknown>
}
type ProjectDto = { id: number; name: string; created_at: string; archived: boolean }
type Project = { id: string; name: string; createdAt: Date; archived: boolean }
```

```ts starter
export function createProjectsService(http: HttpClient) {
  return {
    async list(): Promise<Project[]> {
      return (await http.get('/api/projects')) as Project[]
    },
    async get(id: string): Promise<Project | null> {
      return null
    },
    async create(name: string): Promise<Project> {
      return (await http.post('/api/projects', { name })) as Project
    },
  }
}
```

```ts solution
export function createProjectsService(http: HttpClient) {
  const toProject = (dto: ProjectDto): Project => ({
    id: String(dto.id),
    name: dto.name,
    createdAt: new Date(dto.created_at),
    archived: dto.archived,
  })
  return {
    async list(): Promise<Project[]> {
      const dtos = (await http.get('/api/projects')) as ProjectDto[]
      return dtos
        .map(toProject)
        .filter((p) => !p.archived)
        .sort((a, b) => a.name.localeCompare(b.name))
    },
    async get(id: string): Promise<Project | null> {
      try {
        return toProject((await http.get(`/api/projects/${id}`)) as ProjectDto)
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) return null
        throw e
      }
    },
    async create(name: string): Promise<Project> {
      const trimmed = name.trim()
      if (!trimmed) throw new Error('Project name is required')
      return toProject((await http.post('/api/projects', { name: trimmed })) as ProjectDto)
    },
  }
}
```

```ts tests
const dto = (id: number, name: string, archived = false) => ({ id, name, created_at: '2026-03-01T10:00:00Z', archived })
const fakeHttp = () => ({ get: fn(), post: fn() })

test('list maps, filters archived and sorts by name', async () => {
  const http = fakeHttp()
  http.get.mockResolvedValue([dto(2, 'Zeta'), dto(1, 'Alpha'), dto(3, 'Old', true)])
  const list = await createProjectsService(http as any).list()
  expect(http.get).toHaveBeenCalledWith('/api/projects')
  expect(list.map((p) => p.name)).toEqual(['Alpha', 'Zeta'])
  expect(list[0].id).toBe('1')
  expect(list[0].createdAt).toBeInstanceOf(Date)
  expect(list[0].createdAt.toISOString()).toBe('2026-03-01T10:00:00.000Z')
  expect(list[0]).not.toHaveProperty('created_at')
})
test('get returns a mapped project', async () => {
  const http = fakeHttp()
  http.get.mockResolvedValue(dto(7, 'Seven'))
  const p = await createProjectsService(http as any).get('7')
  expect(http.get).toHaveBeenCalledWith('/api/projects/7')
  expect(p).toMatchObject({ id: '7', name: 'Seven', archived: false })
})
test('get returns null on 404', async () => {
  const http = fakeHttp()
  http.get.mockImplementation(() => Promise.reject(new HttpError(404, 'Not found')))
  expect(await createProjectsService(http as any).get('9')).toBeNull()
})
test('get re-throws other errors', async () => {
  const http = fakeHttp()
  http.get.mockImplementation(() => Promise.reject(new HttpError(500, 'Boom')))
  await expect(createProjectsService(http as any).get('9')).rejects.toThrow('Boom')
})
test('create trims and posts', async () => {
  const http = fakeHttp()
  http.post.mockResolvedValue(dto(5, 'New board'))
  const p = await createProjectsService(http as any).create('  New board  ')
  expect(http.post).toHaveBeenCalledWith('/api/projects', { name: 'New board' })
  expect(p.id).toBe('5')
})
test('create rejects empty names without calling the API', async () => {
  const http = fakeHttp()
  await expect(createProjectsService(http as any).create('   ')).rejects.toThrow('Project name is required')
  expect(http.post).not.toHaveBeenCalled()
})
```
:::

### The hook: connecting the service to React

The hook owns the *React* concerns: loading state, error state, re-fetching, ignoring stale responses. In the
TanStack Query lesson you saw that a real app would write `useQuery({ queryKey: ['projects'], queryFn: service.list })`.
Writing it by hand once is the best way to understand what such libraries do for you.

:::challenge id=fe-20-c2 lang=tsx xp=70 preview=Demo
title: `useProjects` — a hook over a service
Implement `useProjects(service)` returning `{ status, projects, error, reload }`:

- `status` is `'loading'` until `service.list()` settles, then `'success'` or `'error'`.
- `projects` is the resolved array (empty array before that), `error` the error's `message` (or `null`).
- `reload()` sets `status` back to `'loading'` and calls `service.list()` again.
- Ignore the result of a request whose component unmounted or that was superseded (the "ignore flag" pattern:
  a local `let ignore = false` in the effect that the cleanup sets to `true`, so a late response from an old
  request can't overwrite newer state).

`ProjectList` (the consumer) and `Demo` are given — only implement the hook.

hint: Keep a `reloadKey` number in state; `reload = () => { setStatus('loading'); setReloadKey(k => k + 1) }`.
hint: `useEffect(() => { let ignore = false; service.list().then(…); return () => { ignore = true } }, [service, reloadKey])`
hint: In `.then`/`.catch` check `if (!ignore)` before setting state.

```tsx starter
import { useEffect, useState } from 'react'

type Project = { id: string; name: string }
type ProjectsService = { list(): Promise<Project[]> }
type Status = 'loading' | 'success' | 'error'

export function useProjects(service: ProjectsService) {
  const [projects] = useState<Project[]>([])
  return { status: 'loading' as Status, projects, error: null as string | null, reload: () => {} }
}

export function ProjectList({ service }: { service: ProjectsService }) {
  const { status, projects, error, reload } = useProjects(service)
  if (status === 'loading') return <p>Loading projects…</p>
  if (status === 'error') return (
    <div role="alert">
      Could not load projects: {error} <button onClick={reload}>Retry</button>
    </div>
  )
  return (
    <div>
      <ul>{projects.map((p) => <li key={p.id}>{p.name}</li>)}</ul>
      <button onClick={reload}>Refresh</button>
    </div>
  )
}

const demoService = { list: () => new Promise<Project[]>((r) => setTimeout(() => r([{ id: '1', name: 'Website relaunch' }, { id: '2', name: 'Mobile app' }]), 600)) }
export function Demo() {
  return <ProjectList service={demoService} />
}
```

```tsx solution
import { useEffect, useState } from 'react'

type Project = { id: string; name: string }
type ProjectsService = { list(): Promise<Project[]> }
type Status = 'loading' | 'success' | 'error'

export function useProjects(service: ProjectsService) {
  const [status, setStatus] = useState<Status>('loading')
  const [projects, setProjects] = useState<Project[]>([])
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let ignore = false
    service.list().then(
      (data) => {
        if (ignore) return
        setProjects(data)
        setError(null)
        setStatus('success')
      },
      (e: unknown) => {
        if (ignore) return
        setError(e instanceof Error ? e.message : String(e))
        setStatus('error')
      },
    )
    return () => { ignore = true }
  }, [service, reloadKey])

  const reload = () => {
    setStatus('loading')
    setReloadKey((k) => k + 1)
  }
  return { status, projects, error, reload }
}

export function ProjectList({ service }: { service: ProjectsService }) {
  const { status, projects, error, reload } = useProjects(service)
  if (status === 'loading') return <p>Loading projects…</p>
  if (status === 'error') return (
    <div role="alert">
      Could not load projects: {error} <button onClick={reload}>Retry</button>
    </div>
  )
  return (
    <div>
      <ul>{projects.map((p) => <li key={p.id}>{p.name}</li>)}</ul>
      <button onClick={reload}>Refresh</button>
    </div>
  )
}

const demoService = { list: () => new Promise<Project[]>((r) => setTimeout(() => r([{ id: '1', name: 'Website relaunch' }, { id: '2', name: 'Mobile app' }]), 600)) }
export function Demo() {
  return <ProjectList service={demoService} />
}
```

```tsx tests
test('shows loading, then the projects', async () => {
  const service = { list: fn(() => Promise.resolve([{ id: '1', name: 'Alpha' }, { id: '2', name: 'Beta' }])) }
  render(<ProjectList service={service} />)
  expect(screen.getByText('Loading projects…')).toBeInTheDocument()
  expect(await screen.findByText('Alpha')).toBeInTheDocument()
  expect(screen.getAllByRole('listitem')).toHaveLength(2)
  expect(service.list).toHaveBeenCalledTimes(1)
})
test('shows the error and retries', async () => {
  let calls = 0
  const service = { list: fn(() => (++calls === 1 ? Promise.reject(new Error('Network down')) : Promise.resolve([{ id: '1', name: 'Alpha' }]))) }
  render(<ProjectList service={service} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load projects: Network down')
  await user.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByText('Alpha')).toBeInTheDocument()
  expect(service.list).toHaveBeenCalledTimes(2)
})
test('refresh goes back to loading and refetches', async () => {
  let resolveSecond: (v: { id: string; name: string }[]) => void = () => {}
  let calls = 0
  const service = { list: fn(() => (++calls === 1 ? Promise.resolve([{ id: '1', name: 'Alpha' }]) : new Promise((r) => { resolveSecond = r }))) }
  render(<ProjectList service={service} />)
  await screen.findByText('Alpha')
  await user.click(screen.getByRole('button', { name: 'Refresh' }))
  expect(screen.getByText('Loading projects…')).toBeInTheDocument()
  await act(async () => resolveSecond([{ id: '1', name: 'Alpha' }, { id: '3', name: 'Gamma' }]))
  expect(await screen.findByText('Gamma')).toBeInTheDocument()
})
```
:::

:::warn title="Pass a stable service"
`service` is an effect dependency. If a component does `useProjects(createProjectsService(http))`, every render
creates a *new* service object, so the effect re-runs, which sets state, which re-renders... an endless request loop.
Create services once at module level (or in the app shell / a context provider) and pass that same instance.
:::

## Enforcing the rules with ESLint

Rules in a wiki page are suggestions. Rules in CI are architecture. The cheapest enforcement is ESLint's
built-in `no-restricted-imports` in a flat config:

```js
// eslint.config.js (excerpt)
export default [
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['@/modules/*/*'],                    // anything deeper than the module root
          message: 'Import other modules through their public API: @/modules/<name>',
        }],
      }],
    },
  },
  {
    files: ['src/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['@/modules/*', '@/app/*'], message: 'ui/ must not depend on features or the app shell' }],
      }],
    },
  },
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['@/ui', '@/ui/*', '@/modules/*', '@/app/*', 'react'], message: 'shared/ is framework-free' }],
      }],
    },
  },
]
```

How to read it: each object applies its `rules` to the files matched by `files`. `patterns.group` uses
**gitignore-style** globs against the import string, so `@/modules/*/*` matches `@/modules/projects/services/x`
but not `@/modules/projects`. Two things trip people up:

- **Later objects replace a rule's options, they don't merge them.** A `src/ui/` file matches both the first and the
  second object; because both configure `no-restricted-imports` with options, only the second object's patterns
  apply to it. That's why each block lists *everything* that layer must not import.
- **Relative paths aren't covered.** `import x from '../../billing/services/x'` doesn't start with `@/modules`, so
  this rule doesn't see it. The dedicated tools below resolve real file paths and catch it.

For bigger codebases, dedicated tools model the layers explicitly:

- **`eslint-plugin-boundaries`** — declare element types (`app`, `feature`, `ui`, `shared`) by folder pattern
  and allowed dependencies between them; it also catches relative-path escapes like `../../billing/...`.
- **`dependency-cruiser`** — graphs the whole import tree, forbids cycles, and can render the architecture as an SVG for docs.
- **Nx / Turborepo module boundaries** — in monorepos, tag projects (`type:ui`, `scope:billing`) and lint
  which tags may depend on which (`@nx/enforce-module-boundaries`, `turbo boundaries`).

:::quiz id=fe-20-q5 xp=10
With the `eslint.config.js` above, which import in `src/ui/Dialog.tsx` is **not** reported by ESLint?
- [ ] `import { useCurrentUser } from '@/modules/auth'`
- [ ] `import { router } from '@/app/router'`
- [x] `import { useCurrentUser } from '../modules/auth/hooks/useCurrentUser'`
- [ ] `import { useCurrentUser } from '@/modules/auth/hooks/useCurrentUser'`
> `no-restricted-imports` matches the import *string*. The relative path `../modules/...` doesn't match any
> `@/modules/*` pattern, so it slips through even though it's the worst violation of the four (a deep import from
> `ui` into a feature). The other three all match the `ui/` block's `@/modules/*` or `@/app/*` patterns.
> Catch relative escapes with `eslint-plugin-boundaries` or `dependency-cruiser`, which resolve imports to real files first.
:::

:::challenge id=fe-20-c3 lang=ts xp=60
title: Write a tiny boundaries checker
Tools like `eslint-plugin-boundaries` boil down to: classify each file into a layer, then check every import
edge. Implement `findViolations(edges)` that returns the edges (in input order) breaking these rules. Paths are
already resolved and always start with `src/`.

(This checker trusts the app shell completely; the ESLint setup above is a bit stricter and still asks `app` to
use modules' public APIs. Real tools let you choose either policy.)

- `src/app/**` may import anything.
- `src/modules/<name>/**` may import: any file in **its own** module; another module **only** via
  `src/modules/<other>/index.ts`; anything in `src/ui/**` or `src/shared/**`. Never `src/app/**`.
- `src/ui/**` may import only `src/ui/**` and `src/shared/**`.
- `src/shared/**` may import only `src/shared/**`.

hint: Split the path: `const [, top, name, ...rest] = path.split('/')` gives e.g. `top = 'modules'`, `name = 'projects'`.
hint: For `src/modules/projects/index.ts`, `name` is `projects` and `rest` is `['index.ts']` — that exact shape is the public entry. `src/modules/projects/components/index.ts` is not.
hint: Write `allowed(from, to): boolean` and return `edges.filter(e => !allowed(e.from, e.to))`.

```ts starter
type Edge = { from: string; to: string }

export function findViolations(edges: Edge[]): Edge[] {
  return []
}
```

```ts solution
type Edge = { from: string; to: string }

function info(path: string) {
  const [, top, name, ...rest] = path.split('/')
  return { top, module: top === 'modules' ? name : null, isIndex: top === 'modules' && rest.length === 1 && rest[0] === 'index.ts' }
}

function allowed(from: string, to: string): boolean {
  const f = info(from)
  const t = info(to)
  switch (f.top) {
    case 'app':
      return true
    case 'modules':
      if (t.top === 'modules') return t.module === f.module || t.isIndex
      return t.top === 'ui' || t.top === 'shared'
    case 'ui':
      return t.top === 'ui' || t.top === 'shared'
    case 'shared':
      return t.top === 'shared'
    default:
      return true
  }
}

export function findViolations(edges: Edge[]): Edge[] {
  return edges.filter((e) => !allowed(e.from, e.to))
}
```

```ts tests
const e = (from: string, to: string) => ({ from, to })

test('the app shell may import anything', () => {
  expect(findViolations([
    e('src/app/router.tsx', 'src/modules/projects/components/Board.tsx'),
    e('src/app/App.tsx', 'src/ui/Button.tsx'),
  ])).toEqual([])
})
test('a module may use its own files, ui, shared and other public APIs', () => {
  expect(findViolations([
    e('src/modules/board/components/Board.tsx', 'src/modules/board/hooks/useBoard.ts'),
    e('src/modules/board/hooks/useBoard.ts', 'src/modules/projects/index.ts'),
    e('src/modules/board/components/Board.tsx', 'src/ui/Button.tsx'),
    e('src/modules/board/services/boardService.ts', 'src/shared/http.ts'),
  ])).toEqual([])
})
test('deep imports into another module are violations', () => {
  const bad = e('src/modules/board/hooks/useBoard.ts', 'src/modules/projects/services/projectsService.ts')
  expect(findViolations([bad])).toEqual([bad])
})
test('a nested index.ts is not the public API', () => {
  const bad = e('src/modules/board/hooks/useBoard.ts', 'src/modules/projects/components/index.ts')
  expect(findViolations([bad])).toEqual([bad])
})
test('modules must not import the app shell', () => {
  const bad = e('src/modules/board/components/Board.tsx', 'src/app/providers.tsx')
  expect(findViolations([bad])).toEqual([bad])
})
test('ui and shared stay at the bottom; result keeps input order', () => {
  const a = e('src/ui/Avatar.tsx', 'src/modules/auth/index.ts')
  const ok = e('src/ui/Avatar.tsx', 'src/shared/format.ts')
  const b = e('src/shared/format.ts', 'src/ui/Badge.tsx')
  const c = e('src/ui/Dialog.tsx', 'src/app/App.tsx')
  expect(findViolations([a, ok, b, c])).toEqual([a, b, c])
})
```
:::

## Barrel files: useful at the edge, harmful everywhere

A **barrel** is a file that re-exports others (`export * from './Button'`). One barrel per module as its
public API is great. Barrels *everywhere* cause real problems:

- **Slow dev server and tests.** Vite serves native ES modules in dev. `import { Button } from '@/ui'`
  makes the browser load *every* file the barrel re-exports — 200 components to render one button. Vitest
  pays the same cost for every test file.
- **Tree-shaking surprises.** *Tree-shaking* is the bundler removing exports nobody imports. Production
  bundlers usually manage it through a barrel, but a module with side effects (CSS imports, top-level
  registration code) must be kept in case the side effect matters, and drags its imports along. Declaring
  `"sideEffects": false` (or a list of the CSS files that *do* have effects) in `package.json` tells the bundler it may drop unused modules.
- **Circular imports.** `components/index.ts` re-exports `A` and `B`; `A` imports `B` *through the barrel*;
  the barrel imports `A`… and suddenly `A` throws "Cannot access 'B' before initialization" (or gets `undefined`
  in CommonJS) depending on which file loads first.
- **`export *` hides collisions.** If two files both export `formatDate`, the barrel's `export *` makes the name
  *ambiguous* and the ES module system silently leaves it out. TypeScript reports it (error TS2308), but plain JS
  only fails when someone actually imports `formatDate`. Named re-exports make the conflict a visible line of code.

Practical rules teams use:

1. Exactly **one** `index.ts` per feature module — no nested `components/index.ts`.
2. Inside a module, import the file directly (`./components/ProjectCard`), never via your own index.
3. Prefer **named re-exports** (`export { ProjectBoard } from …`) over `export *` — the public API is then
   readable as a list.
4. For a large `ui/` kit, either keep a flat barrel and accept it, or import per component (`@/ui/Button`) —
   pick one and lint for it.

:::pro title="Colocate tests — and everything else"
Put `ProjectCard.test.tsx` right next to `ProjectCard.tsx`, and the same for stories (`.stories.tsx`) and
styles (`.module.css`). When you move or delete the component, its tests and stories move with it, and a
reviewer sees immediately that a new component shipped without tests. Only end-to-end tests live in a
separate top-level `e2e/` folder, because they test the app, not a file.
:::

## Monorepos and workspaces: when one package isn't enough

At some point the design system is used by two apps (the customer app and an admin portal), or the API types
are generated once and shared. That's when a **monorepo** with **workspaces** pays off:

A **monorepo** is one Git repository holding several packages; **workspaces** is the package-manager feature
that installs them together and links them to each other locally.

```text
repo/
  package.json              # "workspaces": ["apps/*", "packages/*"]  (npm/yarn/bun)
  pnpm-workspace.yaml       # packages: ['apps/*', 'packages/*']     (pnpm)
  apps/
    web/                    # the Vite SaaS app
    admin/
  packages/
    ui/                     # @acme/ui — design system
    api-client/             # @acme/api-client — generated from the backend's OpenAPI document
    eslint-config/          # shared lint rules
    tsconfig/               # shared tsconfig bases
```

```json
// apps/web/package.json (excerpt) — pnpm, Yarn (Berry) and Bun syntax
{ "dependencies": { "@acme/ui": "workspace:*", "@acme/api-client": "workspace:*" } }
```

The package manager links `@acme/ui` to the local folder — no publishing needed. The `workspace:` protocol is
supported by pnpm, Yarn 2+ and Bun; **npm does not understand it** (`npm install` fails with
*Unsupported URL Type "workspace:"*). With npm workspaces you write a normal range such as `"@acme/ui": "*"` and npm
links the local package automatically.

A package's `package.json` `exports` field is its public API, enforced by the resolver itself: with
`"exports": { ".": "./src/index.ts" }`, a deep import like `@acme/ui/src/Button` fails in Node, in Vite and in
TypeScript (with `"moduleResolution": "bundler"` or `"nodenext"`). Build orchestrators (**Turborepo**, **Nx**)
add task caching (`turbo run build` only rebuilds packages whose inputs changed) and affected-only CI.

:::warn title="Don't start with a monorepo"
A monorepo adds tooling, build steps and versioning questions. Start with feature modules in one app. Extract a
package when a second consumer actually exists. Folders that already follow the dependency rules are trivially
extractable — that's the payoff of doing modules right from the start.
:::

:::quiz id=fe-20-q2 xp=10
Your team's `src/ui/index.ts` re-exports 180 components with `export *`. Developers complain that every Vitest
file takes ~2 s to start, even tiny ones. What's the most likely cause?
- [ ] Vitest doesn't support TypeScript path aliases
- [x] Each test imports from `@/ui`, so the barrel forces every one of the 180 component modules (and their imports) to load
- [ ] `export *` is deprecated in ES2025
- [ ] Tests should never import UI components
> Unbundled dev tooling (Vite dev server, Vitest) loads every module a barrel re-exports. Importing per file
> (`@/ui/Button`) or trimming the barrel fixes it. Production builds are less affected because bundlers tree-shake.
:::

:::quiz id=fe-20-q3 xp=10
Feature `board` needs to show the name of the current project, owned by the `projects` module. Which option
keeps the architecture healthy?
- [ ] Copy `projectsService.ts` into `board/services/`
- [ ] Import `projects/hooks/useProjectQuery.ts` directly — it's only one file
- [x] Have `projects/index.ts` export `useProject(id)` and use that from `board`
- [ ] Move all of `board` into `projects`
> Cross-module use goes through the public API. If the module doesn't export what you need, add it deliberately
> to `index.ts` — that's a visible, reviewable change to the contract. Copying code forks the logic; deep imports
> make internals public by accident.
:::

:::lab id=fe-20-lab1 xp=100
title: Refactor an app into feature modules with enforced boundaries
Take any React + Vite + TS project of yours (or `npm create vite@latest modular-lab -- --template react-ts` and
add two small features, e.g. a project list and a user profile).

**1. Create the skeleton**

```bash
mkdir -p src/app src/ui src/shared src/modules/projects/{components,hooks,services,types}
```

**2. Add the alias** in `tsconfig.app.json` (`"paths": { "@/*": ["./src/*"] }` inside `compilerOptions`) and in
`vite.config.ts` (`resolve: { tsconfigPaths: true }`, or the `vite-tsconfig-paths` plugin on Vite 7 and older).
Check both halves: `npx tsc -b` and `npm run build` must succeed with one `@/` import in place.

**3. Move code**: providers/router/layout → `app/`; generic buttons/inputs → `ui/`; the http client and
formatters → `shared/`; everything about projects → `modules/projects/`. Write `modules/projects/index.ts`
with **named** exports only for what the shell needs.

**4. Enforce it.** The Vite template already ships ESLint with `typescript-eslint` (otherwise
`npm i -D eslint typescript-eslint`). Append the three `no-restricted-imports` objects from this lesson to the
array in `eslint.config.js`, *after* the template's own entries. Then prove the rule works:

```ts
// temporarily add to src/app/App.tsx
import '@/modules/projects/services/projectsService'
```

(A bare side-effect import is still checked by `no-restricted-imports`, but creates no binding, so the template's
`@typescript-eslint/no-unused-vars` rule doesn't add a second error.)

```bash
npx eslint src
```

Expected output (paths and line numbers will differ):

```text
/home/you/modular-lab/src/app/App.tsx
  3:1  error  '@/modules/projects/services/projectsService' import is restricted from being used by a pattern. Import other modules through their public API: @/modules/<name>  no-restricted-imports

✖ 1 problem (1 error, 0 warnings)
```

Remove the line again, then repeat the experiment from a `ui/` file with `import '@/modules/projects'`. (If you
write `import { useProjects } from '@/modules/projects'` instead, expect an extra no-unused-vars error next to it.)

**5. Optional, bigger league:** `npm i -D dependency-cruiser && npx depcruise --init`, then
`npx depcruise src --output-type dot | dot -T svg > architecture.svg` to *see* your graph (the `dot` command
comes from Graphviz: `sudo apt install graphviz`, `brew install graphviz` or `winget install graphviz`).

:::tip
Add `"lint": "eslint src"` to `package.json` scripts and run it in CI — a boundary that isn't checked on every
pull request will be violated within a month.
:::

- [ ] The app builds and runs with the `app/ modules/ ui/ shared/` layout
- [ ] `src/modules/projects/index.ts` exports only the module's public API (named exports)
- [ ] `npx tsc -b` and `npm run build` both resolve `@/` imports
- [ ] A deep import into a module fails `npx eslint src` with the custom message
- [ ] A `ui/` file importing from `@/modules/...` fails lint
- [ ] Tests are colocated next to the code they test
:::

:::job title="Day one in a modular codebase"
Before writing code, read the root `README`/`ARCHITECTURE.md`, `eslint.config.js` and `CODEOWNERS`. Find the
module closest to your ticket and copy its structure. When you need something from another module, check its
`index.ts` first; if it isn't exported, ask the owning team rather than deep-importing — that conversation is
exactly what the boundary is for.
:::

## Recap

- Organise by **feature** (`modules/<feature>/{components,hooks,services,types,index.ts}`), not by file type.
- `index.ts` is the module's **public API**; everything else is private. Use relative imports inside a module,
  `@/modules/<name>` from outside.
- Dependencies flow one way: **app → modules → ui → shared**. No upward imports, no deep imports, no cycles.
- **Services** translate API DTOs into domain types and take the http client as a parameter (easy to fake);
  **hooks** add React state; **components** render.
- Enforce rules with `no-restricted-imports`, `eslint-plugin-boundaries` or `dependency-cruiser` in CI. Remember
  that later flat-config objects replace a rule's options, and that `no-restricted-imports` doesn't see relative escapes.
- One barrel per module is good; barrels everywhere slow down dev/tests and invite cycles.
- Colocate tests, stories and styles. Reach for a **workspace monorepo** only when a second consumer appears.

:::cards id=fe-20-cards1 xp=15 title="Modular architecture"
Q: What goes in a feature module's `index.ts`?
A: Only its public API — named exports of what other parts of the app may use. Everything else is private.
Q: The four layers and the direction of dependencies?
A: app → modules → ui → shared. Each layer may only import layers below it (modules may use other modules only via index.ts).
Q: Why must `ui/` never import a feature module?
A: The design system would depend on business logic, couldn't be reused, documented or extracted, and cycles become possible.
Q: What is the service layer's main job?
A: Talk to the API and translate DTOs (backend shape) into domain types (UI shape), plus translate errors.
Q: Two problems with barrel files everywhere?
A: They force dev servers/test runners to load every re-exported module, and they make circular imports likely.
Q: Built-in ESLint rule for simple boundaries?
A: `no-restricted-imports` with `patterns` (e.g. ban `@/modules/*/*` deep imports).
Q: What does `"@acme/ui": "workspace:*"` mean?
A: Link the local workspace package `@acme/ui` instead of downloading a published version. Supported by pnpm, Yarn 2+ and Bun; npm uses a normal range like `"*"` instead.
Q: What is a DTO, and where is it turned into a domain type?
A: The data shape on the wire (backend's naming and types). The module's service maps it to domain types, so backend changes touch one file.
Q: When should you create a monorepo?
A: When a second real consumer of shared code exists (e.g. a second app), not on day one.
:::
