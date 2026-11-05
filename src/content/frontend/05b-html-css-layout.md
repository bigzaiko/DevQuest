---
id: fe-27
title: Semantic HTML & CSS Layout
level: beginner
minutes: 75
xp: 150
summary: Landmarks, headings, buttons vs links and labelled forms, then the box model, flexbox, grid, positioning, units, responsive and modern CSS, and the layout recipes you'll build every week.
---

Every React component you write ends up as **HTML elements styled by CSS**. React decides *when*
the DOM changes; HTML decides *what the things are* (a button, a heading, a navigation area); CSS
decides *where they go and how they look*. Frameworks, component libraries and Tailwind all sit on
top of these two layers — when a layout "just won't behave", the fix is almost always plain CSS.

This lesson gives you the mental models for both. It sits between **Anatomy of a Vite Project**
(where your files come from) and **Components & JSX** (how React produces this HTML). The
challenges use JSX, which looks like HTML with two renames you need today: `class` is written
`className` and `for` is written `htmlFor`. Everything else about JSX comes in the next lesson.

## Part 1 — Semantic HTML

### Why the element matters, not just the look

You can make a `<div>` look exactly like a button. It still isn't one. The browser builds an
**accessibility tree** next to the DOM: for every element it records a **role** (button, link,
heading, navigation…), an **accessible name** ("Save", "Main menu") and a **state** (checked,
expanded, current page). Screen readers, voice control, browser extensions, search engines — and
your tests — read that tree, not your CSS.

Choosing the right element gives you three things for free:

| Who benefits | What they get from semantic HTML |
|---|---|
| **People using assistive tech** | Jump between landmarks and headings, hear "button, Save", operate everything with the keyboard. |
| **Search engines and previews** | Understand which text is the title, the main content, the navigation. |
| **Your tests** | Testing Library and Playwright find elements **by role and name** (`getByRole('button', { name: 'Save' })`). Semantic markup is what makes those queries work — and if a test can't find "the Save button", neither can a screen reader. |

There's also a fourth: **behaviour**. A real `<button>` is focusable with Tab, fires `click` on
Enter *and* Space, can be `disabled`, and submits its form. A `<div onClick>` does none of that
until you re-implement it (`tabIndex`, `role`, `onKeyDown` for two keys, disabled styling…), and
people usually forget at least one piece.

### Landmarks: the page's table of contents

Landmarks are the big regions of a page. Screen reader users can list them and jump straight to
"main" or "navigation", the way you'd scan a page visually.

```html
<body>
  <a class="skip-link" href="#main">Skip to content</a>

  <header>                          <!-- role: banner (site header) -->
    <a href="/">DevQuest Boards</a>
    <nav aria-label="Main">         <!-- role: navigation -->
      <ul>
        <li><a href="/boards" aria-current="page">Boards</a></li>
        <li><a href="/reports">Reports</a></li>
      </ul>
    </nav>
  </header>

  <aside aria-label="Projects">…</aside>   <!-- role: complementary -->

  <main id="main">                  <!-- role: main — exactly one per page -->
    <h1>Boards</h1>
    <section aria-labelledby="todo">  <!-- role: region (only when it has a name) -->
      <h2 id="todo">To do</h2>
      <article>…</article>          <!-- role: article — a self-contained item -->
    </section>
  </main>

  <footer>© 2026 DevQuest</footer>  <!-- role: contentinfo (site footer) -->
</body>
```

The rules people actually get wrong:

- **One `<main>` per page.** It holds the content that is unique to this page; the skip link
  points at it so keyboard users don't tab through 20 nav links on every page.
- `<header>` / `<footer>` are the site **banner** / **contentinfo** only when they're *not* inside
  an `<article>`, `<aside>`, `<main>`, `<nav>` or `<section>`. Inside an article they're just that
  article's header — which is fine and common.
- If you have **more than one `<nav>`** (main menu, breadcrumbs, pagination), give each a name with
  `aria-label` so the list of landmarks reads "Main navigation, Breadcrumb navigation".
- A navigation menu is a **list of links**: `<nav><ul><li><a>`. The list lets a screen reader
  announce "list, 4 items" so users know how long the menu is.
- Mark the current page with `aria-current="page"` — both for screen readers and as a styling hook
  (`a[aria-current='page'] { … }`) instead of an extra `active` class.
- `<section>` without a heading or name is just a `<div>` with a different spelling. Use it for a
  thematic group **with a heading**; use `<div>` for pure layout wrappers. Divs are fine — the
  goal is not "no divs", it's "no divs pretending to be something else".

### Headings are an outline, not font sizes

Headings (`<h1>`…`<h6>`) build the outline of the page. Many screen reader users navigate by
heading first, so the outline should read like a table of contents:

```text
h1 Website relaunch            ← one per page: what this page is
  h2 To do                     ← major sections
    h3 Write release notes     ← items within a section
    h3 Fix login redirect
  h2 In progress
    h3 New pricing page
```

- **Don't skip levels** going down (an `h2` followed by an `h4` leaves a hole). Going back up any
  number of levels is fine.
- **Pick the level by structure, never by size.** Want a small `h2`? Style it. Want big bold text
  that isn't a heading? Use a `<p>` with a class.
- A reusable component (a card) shouldn't hard-code `h1`. Its level depends on where it's used —
  often the component takes the level as a prop, or the card list documents "cards render `h3`,
  put them under an `h2`".

### Buttons vs links

This single decision causes more accessibility bugs than anything else in this lesson.

| | `<a href="…">` link | `<button>` |
|---|---|---|
| **Means** | "Go somewhere" — a URL | "Do something" — an action on this page |
| **Examples** | Open project, Settings page, Next page of results | Save, Delete, Open menu, Add card, Toggle theme |
| **Keyboard** | Enter | Enter **and** Space |
| **Free extras** | Middle-click / Cmd-click opens a new tab, right-click "Copy link", history | `disabled`, submits forms, `type="button"` |

The test: *would it make sense to open this in a new tab or bookmark it?* Then it's a link. In a
React app with a router, the router's `<Link>` component still renders a real `<a href>` — that's
the point.

:::warn title="Common mistake: the default button type"
A `<button>` inside a `<form>` is `type="submit"` **by default**. Put a "Show password" or
"Add another row" button in a form without `type="button"` and clicking it submits the form.
Always write `type="button"` on buttons that aren't the submit button.
:::

:::quiz id=fe-27-q1 xp=10
A project card has an **Archive** control (moves the project to the archive via an API call) and a
**Details** control (shows the project's own page at `/projects/42`). Which markup is right?

- [ ] Both as `<a>` tags styled the same, with `onClick` handlers
- [ ] Both as `<div onClick>` with `cursor: pointer` so the design stays consistent
- [x] Archive as `<button type="button">`, Details as `<a href="/projects/42">`
- [ ] Archive as `<a href="#">`, Details as `<button>` that calls `navigate('/projects/42')`
> Archive *does something* on this page → button. Details *goes somewhere* with its own URL → link,
> so middle-click, "open in new tab" and copying the URL all work. The tempting `<a href="#">` for
> actions is wrong: it's announced as a link, jumps the page to the top, and puts a meaningless `#`
> in the URL. A `<button>` that calls `navigate()` loses every link feature. And `<div onClick>`
> isn't focusable or announced at all — keyboard users simply can't use it.
:::

### Forms: every input needs a label

A visible `<label>` connected to its input is the single most important form rule:

```html
<!-- explicit: for/htmlFor points at the input's id -->
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="email" required />

<!-- implicit: the input is inside the label -->
<label><input type="checkbox" name="remember" /> Remember me</label>

<!-- a group of related controls gets a fieldset + legend -->
<fieldset>
  <legend>Role</legend>
  <label><input type="radio" name="role" value="editor" checked /> Editor</label>
  <label><input type="radio" name="role" value="viewer" /> Viewer</label>
</fieldset>
```

What the label buys you: the input gets an accessible name ("Email, edit text"), clicking the label
focuses or toggles the input (a much bigger click target on mobile), and `getByLabelText('Email')`
works in tests.

- **`placeholder` is not a label.** It disappears as soon as you type, is usually low-contrast, and
  isn't reliably announced. Use it for an example value at most.
- Use the right **`type`** (`email`, `tel`, `url`, `number`, `date`, `search`): mobile keyboards
  adapt and the browser validates for free. Add **`autocomplete`** (`email`, `name`,
  `current-password`, `new-password`) so password managers and autofill work.
- Radio buttons in one group share the same **`name`** — that's what makes them mutually exclusive.
- Validation, error messages and submitting to a server are covered properly in the **Forms**
  lesson; here we care about structure.

:::job title="What reviewers flag on day one"
In real code reviews the semantic-HTML comments are always the same handful: "this `div` with
`onClick` should be a `button`", "this needs a label, not a placeholder", "two `h1`s on this page",
"icon-only button has no accessible name — add `aria-label`". Teams increasingly enforce them
automatically with `eslint-plugin-jsx-a11y` and an axe check in Playwright (see **End-to-End
Testing with Playwright**). Getting them right first time is an easy way to look senior.
:::

:::quiz id=fe-27-q2 xp=15
Which of these give an `<input>` a proper accessible name? (select all that apply)

- [x] `<label for="q">Search</label><input id="q" />`
- [x] `<label>Search <input /></label>`
- [ ] `<input placeholder="Search" />` on its own
- [x] `<input aria-label="Search" />` next to a magnifier icon button
- [ ] `<span>Search</span><input />` placed right next to each other
> Explicit `for`/`id`, wrapping the input in the label, and `aria-label` all set the accessible name
> (`aria-label` is the right tool when there's no visible text, like a compact search field). A
> placeholder is only a last-resort fallback: browsers may use it when nothing else names the input,
> but support across screen readers is inconsistent, it's often low-contrast, and it vanishes while
> typing — so it isn't a *proper* name and audits flag it. A
> `<span>` that merely sits next to the input has no programmatic link at all: *you* see the
> connection, the accessibility tree doesn't.
:::

### Challenge: an accessible page shell

:::challenge id=fe-27-c1 lang=tsx xp=40 preview=AppShell
title: Turn div soup into landmarks
`AppShell` renders the outer layout of the Project-board app, but it's built from `div`s and
`span`s only. Rewrite it with semantic elements so that:

1. The **first focusable element** is a link `Skip to content` with `href="#main"`.
2. A site `<header>` contains a link `DevQuest Boards` to `/` and a `<nav>` named **Main**
   (`aria-label="Main"`).
3. The nav holds a **list** (`<ul>`) of three links: `Boards` → `/boards`, `Reports` → `/reports`,
   `Settings` → `/settings`. `Boards` is the current page: `aria-current="page"` (only on that one).
4. A `<main id="main">` contains the page's **only** `<h1>`, `Boards`, plus the paragraph.
5. A site `<footer>` contains `© 2026 DevQuest`.

hint: Landmark elements: `<header>`, `<nav aria-label="Main">`, `<main id="main">`, `<footer>`. Put the skip link before the header.
hint: Navigation markup is `<nav><ul><li><a href="/boards" aria-current="page">Boards</a></li>…</ul></nav>`.
hint: `onClick` on a `span` is not a link. Use `<a href="/">DevQuest Boards</a>` — no JavaScript needed.

```tsx starter
export function AppShell() {
  return (
    <div className="page">
      <div className="top-bar">
        <span className="logo" onClick={() => (window.location.href = '/')}>DevQuest Boards</span>
        <div className="nav">
          <div className="nav-item active">Boards</div>
          <div className="nav-item">Reports</div>
          <div className="nav-item">Settings</div>
        </div>
      </div>
      <div className="content">
        <div className="title">Boards</div>
        <p>Pick a board to see its columns and cards.</p>
      </div>
      <div className="bottom">© 2026 DevQuest</div>
    </div>
  )
}
```

```tsx solution
export function AppShell() {
  return (
    <div className="page">
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="top-bar">
        <a className="logo" href="/">DevQuest Boards</a>
        <nav aria-label="Main">
          <ul className="nav">
            <li><a href="/boards" aria-current="page">Boards</a></li>
            <li><a href="/reports">Reports</a></li>
            <li><a href="/settings">Settings</a></li>
          </ul>
        </nav>
      </header>
      <main id="main" className="content">
        <h1>Boards</h1>
        <p>Pick a board to see its columns and cards.</p>
      </main>
      <footer className="bottom">© 2026 DevQuest</footer>
    </div>
  )
}
```

```tsx tests
test('has banner, main and contentinfo landmarks', () => {
  render(<AppShell />)
  expect(screen.getByRole('banner')).toBeInTheDocument()
  expect(screen.getByRole('main')).toBeInTheDocument()
  expect(screen.getByRole('contentinfo')).toHaveTextContent('© 2026 DevQuest')
})
test('the logo is a real link to the home page', () => {
  render(<AppShell />)
  const logo = screen.getByRole('link', { name: 'DevQuest Boards' })
  expect(logo).toHaveAttribute('href', '/')
  expect(screen.getByRole('banner').contains(logo)).toBe(true)
})
test('a navigation named "Main" inside the header holds a list of three links', () => {
  render(<AppShell />)
  const nav = screen.getByRole('navigation', { name: 'Main' })
  expect(screen.getByRole('banner').contains(nav)).toBe(true)
  const list = nav.querySelector('ul')
  expect(list).not.toBeNull()
  const items = Array.from(list!.children)
  expect(items).toHaveLength(3)
  for (const li of items) {
    expect(li.tagName).toBe('LI')
    expect(li.querySelector('a[href]')).not.toBeNull()
  }
  expect(screen.getByRole('link', { name: 'Boards' })).toHaveAttribute('href', '/boards')
  expect(screen.getByRole('link', { name: 'Reports' })).toHaveAttribute('href', '/reports')
  expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings')
})
test('only the current page link has aria-current="page"', () => {
  render(<AppShell />)
  expect(screen.getByRole('link', { name: 'Boards' })).toHaveAttribute('aria-current', 'page')
  expect(screen.getByRole('link', { name: 'Reports' })).not.toHaveAttribute('aria-current')
  expect(screen.getByRole('link', { name: 'Settings' })).not.toHaveAttribute('aria-current')
})
test('exactly one h1, inside main', () => {
  render(<AppShell />)
  const main = screen.getByRole('main')
  expect(main).toHaveAttribute('id', 'main')
  const h1s = document.querySelectorAll('h1')
  expect(h1s).toHaveLength(1)
  expect(h1s[0]).toHaveTextContent('Boards')
  expect(main.contains(h1s[0])).toBe(true)
})
test('the skip link is the first thing Tab reaches', async () => {
  render(<AppShell />)
  await user.tab()
  const skip = screen.getByRole('link', { name: 'Skip to content' })
  expect(skip).toHaveFocus()
  expect(skip).toHaveAttribute('href', '#main')
})
```
:::

### Challenge: a card grid with the right heading levels

:::challenge id=fe-27-c2 lang=tsx xp=45 preview=ProjectGrid
title: Project cards that make sense to a screen reader
`ProjectGrid` lists projects as cards. Rebuild it so that:

1. Everything sits in a `<section>` named by its heading: an `<h2 id="projects-heading">Projects</h2>`
   and `aria-labelledby="projects-heading"` on the section.
2. The cards are a **list**: one `<ul>` with one `<li>` per project (in the given order), and each
   `<li>`'s **direct child** is an `<article>`. Don't add any other lists or list items.
3. Each article's **only heading is an `<h3>`** (it sits under the `h2`) and that heading contains a
   **link** with the project name to `/projects/<id>`.
4. Each card has an **Archive** `<button type="button">` whose accessible name includes the
   project: `aria-label="Archive <name>"`. Clicking it calls `onArchive(id)`. These are the **only**
   buttons in the component (the project link is a link, not a button).
5. With no projects, render the section with its `h2` and a paragraph `No projects yet.` — and
   **no list**.

`Project` and `sampleProjects` are defined for you (setup code).

hint: Three identical "Archive" buttons are ambiguous in a screen reader's list of buttons — that's why each gets `aria-label={`Archive ${p.name}`}`. Start the label with the visible word ("Archive …") so voice-control users can still say "click Archive" (WCAG "label in name").
hint: Putting the link inside the heading (`<h3><a href=…>{p.name}</a></h3>`) gives one clear, named link per card.
hint: Render the empty state with a ternary: `{projects.length === 0 ? <p>No projects yet.</p> : <ul>…</ul>}`.

```ts setup
type Project = { id: string; name: string; description: string; openTasks: number }
const sampleProjects: Project[] = [
  { id: 'web', name: 'Website relaunch', description: 'New marketing site and blog.', openTasks: 7 },
  { id: 'app', name: 'Mobile app', description: 'iOS and Android client.', openTasks: 3 },
  { id: 'billing', name: 'Billing v2', description: 'Invoices and usage-based plans.', openTasks: 12 },
]
```

```tsx starter
export function ProjectGrid({
  projects = sampleProjects,
  onArchive = () => {},
}: {
  projects?: Project[]
  onArchive?: (id: string) => void
}) {
  return (
    <div className="grid">
      <div className="grid-title">Projects</div>
      {projects.map((p) => (
        <div className="card" key={p.id}>
          <h4 onClick={() => (window.location.href = `/projects/${p.id}`)}>{p.name}</h4>
          <p>{p.description}</p>
          <p>{p.openTasks} open tasks</p>
          <span className="icon-btn" onClick={() => onArchive(p.id)}>Archive</span>
        </div>
      ))}
    </div>
  )
}
```

```tsx solution
export function ProjectGrid({
  projects = sampleProjects,
  onArchive = () => {},
}: {
  projects?: Project[]
  onArchive?: (id: string) => void
}) {
  return (
    <section aria-labelledby="projects-heading">
      <h2 id="projects-heading">Projects</h2>
      {projects.length === 0 ? (
        <p>No projects yet.</p>
      ) : (
        <ul className="card-grid">
          {projects.map((p) => (
            <li key={p.id}>
              <article className="card">
                <h3>
                  <a href={`/projects/${p.id}`}>{p.name}</a>
                </h3>
                <p>{p.description}</p>
                <p>{p.openTasks} open tasks</p>
                <button type="button" aria-label={`Archive ${p.name}`} onClick={() => onArchive(p.id)}>
                  Archive
                </button>
              </article>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
```

```tsx tests
test('a region named "Projects" with an h2', () => {
  render(<ProjectGrid />)
  const region = screen.getByRole('region', { name: 'Projects' })
  const h2 = region.querySelector('h2')
  expect(h2).not.toBeNull()
  expect(h2).toHaveTextContent('Projects')
})
test('cards are articles inside list items', () => {
  render(<ProjectGrid />)
  const list = screen.getByRole('list')
  expect(screen.getAllByRole('listitem')).toHaveLength(3)
  const articles = screen.getAllByRole('article')
  expect(articles).toHaveLength(3)
  for (const a of articles) expect(a.parentElement!.tagName).toBe('LI')
  expect(list.tagName).toBe('UL')
})
test('each card has exactly one heading, an h3 with the project name', () => {
  render(<ProjectGrid />)
  const articles = screen.getAllByRole('article')
  articles.forEach((a, i) => {
    const headings = a.querySelectorAll('h1,h2,h3,h4,h5,h6')
    expect(headings).toHaveLength(1)
    expect(headings[0].tagName).toBe('H3')
    expect(headings[0]).toHaveTextContent(sampleProjects[i].name)
  })
})
test('the heading contains a link to the project page', () => {
  render(<ProjectGrid />)
  const link = screen.getByRole('link', { name: 'Billing v2' })
  expect(link).toHaveAttribute('href', '/projects/billing')
  expect(link.closest('h3')).not.toBeNull()
})
test('archive buttons are real, named buttons that call onArchive(id)', async () => {
  const onArchive = fn()
  render(<ProjectGrid onArchive={onArchive} />)
  const btn = screen.getByRole('button', { name: 'Archive Mobile app' })
  expect(btn).toHaveAttribute('type', 'button')
  await user.click(btn)
  expect(onArchive).toHaveBeenCalledWith('app')
  expect(screen.getAllByRole('button')).toHaveLength(3)
})
test('empty state: heading and message, no list', () => {
  render(<ProjectGrid projects={[]} />)
  expect(screen.getByRole('region', { name: 'Projects' })).toBeInTheDocument()
  expect(screen.getByText('No projects yet.')).toBeInTheDocument()
  expect(screen.queryByRole('list')).toBeNull()
})
```
:::

### Challenge: a form a screen reader can fill in

:::challenge id=fe-27-c3 lang=tsx xp=40 preview=InviteForm
title: Label the invite form
`InviteForm` invites a teammate to a board. Today it has placeholder-only inputs, a fake radio
group and a button that isn't connected to a form. Rebuild it:

1. A `<form aria-label="Invite teammate">`. Its `onSubmit` calls `e.preventDefault()` and then
   `onInvite({ email, role })` with the values read via `new FormData(e.currentTarget)`.
2. An `<input id="invite-email">` labelled **Email** by `<label htmlFor="invite-email">Email</label>`,
   with `type="email"`, `name="email"`, `autoComplete="email"` and `required`. Remove the
   `placeholder="Email"` — the label replaces it.
3. A `<fieldset>` with `<legend>Role</legend>` and two radios with `name="role"`, each wrapped in
   its label: **Editor** (`value="editor"`, checked by default via `defaultChecked`) and **Viewer**
   (`value="viewer"`).
4. A `<button type="submit">Send invite</button>` inside the form. Submitting calls `onInvite`
   exactly once, e.g. `{ email: 'ada@example.com', role: 'viewer' }` after typing that address and
   picking Viewer.

hint: In JSX, a label's `for` is `htmlFor`: `<label htmlFor="invite-email">Email</label><input id="invite-email" … />`.
hint: Read the values on submit: `const data = new FormData(e.currentTarget); onInvite({ email: String(data.get('email')), role: String(data.get('role')) })`.
hint: Uncontrolled inputs use `defaultChecked` / `defaultValue` (not `checked` without an `onChange`). The **Forms** lesson explains controlled vs uncontrolled.

```tsx starter
export function InviteForm({
  onInvite = () => {},
}: {
  onInvite?: (invite: { email: string; role: string }) => void
}) {
  return (
    <div className="invite">
      <input placeholder="Email" />
      <div className="roles">
        <span className="role selected">Editor</span>
        <span className="role">Viewer</span>
      </div>
      <div className="btn" onClick={() => onInvite({ email: '', role: 'editor' })}>Send invite</div>
    </div>
  )
}
```

```tsx solution
export function InviteForm({
  onInvite = () => {},
}: {
  onInvite?: (invite: { email: string; role: string }) => void
}) {
  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const data = new FormData(e.currentTarget)
    onInvite({ email: String(data.get('email')), role: String(data.get('role')) })
  }

  return (
    <form aria-label="Invite teammate" onSubmit={handleSubmit}>
      <label htmlFor="invite-email">Email</label>
      <input id="invite-email" name="email" type="email" autoComplete="email" required />

      <fieldset>
        <legend>Role</legend>
        <label>
          <input type="radio" name="role" value="editor" defaultChecked /> Editor
        </label>
        <label>
          <input type="radio" name="role" value="viewer" /> Viewer
        </label>
      </fieldset>

      <button type="submit">Send invite</button>
    </form>
  )
}
```

```tsx tests
test('the form has an accessible name', () => {
  render(<InviteForm />)
  expect(screen.getByRole('form', { name: 'Invite teammate' })).toBeInTheDocument()
})
test('the email input is labelled, typed and required', () => {
  render(<InviteForm />)
  const email = screen.getByLabelText('Email')
  expect(email.tagName).toBe('INPUT')
  expect(email).toHaveAttribute('type', 'email')
  expect(email).toHaveAttribute('name', 'email')
  expect(email).toHaveAttribute('autocomplete', 'email')
  expect((email as HTMLInputElement).required).toBe(true)
  expect(email).not.toHaveAttribute('placeholder', 'Email')
})
test('role radios share a name, live in a fieldset with legend "Role", Editor is default', () => {
  render(<InviteForm />)
  const editor = screen.getByRole('radio', { name: 'Editor' })
  const viewer = screen.getByRole('radio', { name: 'Viewer' })
  expect(editor).toBeChecked()
  expect(viewer).not.toBeChecked()
  expect(editor).toHaveAttribute('name', 'role')
  expect(viewer).toHaveAttribute('name', 'role')
  const fieldset = editor.closest('fieldset')
  expect(fieldset).not.toBeNull()
  expect(fieldset!.querySelector('legend')).toHaveTextContent('Role')
  expect(fieldset!.contains(viewer)).toBe(true)
})
test('the submit button lives inside the form', () => {
  render(<InviteForm />)
  const btn = screen.getByRole('button', { name: 'Send invite' })
  expect(btn).toHaveAttribute('type', 'submit')
  expect(btn.closest('form')).toBe(screen.getByRole('form', { name: 'Invite teammate' }))
})
test('submitting reports the typed email and the chosen role', async () => {
  const onInvite = fn()
  render(<InviteForm onInvite={onInvite} />)
  await user.type(screen.getByLabelText('Email'), 'ada@example.com')
  await user.click(screen.getByRole('radio', { name: 'Viewer' }))
  await user.click(screen.getByRole('button', { name: 'Send invite' }))
  expect(onInvite).toHaveBeenCalledTimes(1)
  expect(onInvite).toHaveBeenCalledWith({ email: 'ada@example.com', role: 'viewer' })
})
```
:::

## Part 2 — The box model and `display`

### Every element is a box

CSS lays out **boxes**. Each box has four layers, inside out:

```text
┌──────────────── margin ────────────────┐   space outside, between boxes (transparent)
│ ┌───────────── border ───────────────┐ │
│ │ ┌────────── padding ─────────────┐ │ │   space inside, takes the background
│ │ │          content               │ │ │   text, images, children
│ │ └────────────────────────────────┘ │ │
│ └────────────────────────────────────┘ │
└────────────────────────────────────────┘
```

The question that bites everyone: **what does `width` measure?** By default
(`box-sizing: content-box`) it's only the content, so padding and border are *added* on top. A
`width: 100%` box with padding therefore overflows its parent. Every modern reset fixes that:

```css
*, *::before, *::after {
  box-sizing: border-box;   /* width/height now include padding and border */
}
```

With `border-box`, `width: 300px` means the box is 300px on screen, full stop. Tailwind's
preflight, every CSS framework and the Vite template's CSS assume it.

Two more box-model facts you'll trip over:

- **Vertical margins collapse.** Two block siblings with `margin-bottom: 24px` and `margin-top: 16px`
  are 24px apart, not 40px — the larger one wins. Margins between a parent and its first child can
  collapse *through* the parent too ("why is my heading's margin pushing the whole card down?").
  Margins **don't** collapse inside flex or grid containers, which is one more reason to prefer
  `gap` for spacing.
- **`padding` percentages refer to the parent's *width*** — even `padding-top`. (That used to be the
  trick for fixed aspect ratios; today use `aspect-ratio: 16 / 9`.)

:::quiz id=fe-27-q3 xp=10
No reset stylesheet is loaded. How wide is this box on screen?

```css
.card {
  width: 200px;
  padding: 20px;
  border: 2px solid;
  margin: 10px;
}
```

- [ ] 200px
- [x] 244px
- [ ] 264px
- [ ] 240px
> The default is `box-sizing: content-box`, so `width` is the content only: 200 + 2×20 padding + 2×2
> border = **244px** of visible box. 264px is the tempting wrong answer because it includes the
> margin — but margin is space *outside* the box, not part of its size. With
> `box-sizing: border-box` the answer would be 200px, which is why every project sets it globally.
:::

### `display`: how a box behaves

| Value | Behaviour | Typical elements |
|---|---|---|
| `block` | Starts on a new line, fills the available width, respects width/height/margins. | `div`, `p`, `h1`, `section`, `ul` |
| `inline` | Flows inside a line of text. **Ignores `width`, `height` and vertical margins.** | `span`, `a`, `strong`, `code` |
| `inline-block` | Flows in a line *but* respects width/height/padding. | Badges, old-school buttons |
| `flex` / `grid` | The element is a block; its **children** are laid out by flexbox / grid. | Toolbars, layouts |
| `inline-flex` | Same, but the container itself flows inline. | Icon + text buttons |
| `none` | Removed from layout **and** the accessibility tree. | Hidden things |

`display` describes two things: how the box behaves **outside** (block or inline) and how it
lays out its **children** (normal flow, flex or grid). That's why "add `display: flex`" changes
the children, not the element's own position.

:::tip title="Hiding things the right way"
`display: none` (or the `hidden` attribute) hides from everyone. To hide something **visually but
keep it for screen readers** — like a label for an icon-only button — use a "visually hidden" class
(`position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%);
white-space: nowrap;`), Tailwind calls it `sr-only`. To hide something only from assistive tech
(a decorative icon), use `aria-hidden="true"`.
:::

## Part 3 — Flexbox: one dimension

Flexbox lays out children **in a line** — a row or a column — and distributes the leftover space.
Reach for it when you think "these things go next to each other": a toolbar, a nav list, an icon
with a label, a card's footer with buttons pushed to the right.

### The two axes

Everything in flexbox is relative to two axes:

- The **main axis** follows `flex-direction` (`row` = left → right, `column` = top → bottom).
- The **cross axis** is perpendicular to it.

```css
.toolbar {
  display: flex;
  flex-direction: row;          /* main axis: horizontal (default) */
  justify-content: space-between; /* distribute along the MAIN axis */
  align-items: center;           /* align along the CROSS axis */
  gap: 0.5rem;                   /* space between items — no margins needed */
  flex-wrap: wrap;               /* allow a second line when there's no room */
}
```

| Property | Axis | Common values |
|---|---|---|
| `justify-content` | main | `flex-start`, `center`, `space-between`, `flex-end` |
| `align-items` | cross | `stretch` (default!), `center`, `flex-start`, `baseline` |
| `align-self` | cross, one item | same as `align-items` |
| `gap` | both | `1rem`, or `row-gap column-gap` like `0.5rem 1rem` |

The trap: `justify-*` is **not** "horizontal". Switch to `flex-direction: column` and
`justify-content` moves things vertically, `align-items` horizontally.

### Sizing items: `flex: grow shrink basis`

```css
.search { flex: 1; }        /* = 1 1 0%  → take all leftover space */
.logo   { flex: none; }     /* = 0 0 auto → never grow or shrink */
.side   { flex: 0 0 16rem; } /* fixed 16rem column */
.push-right { margin-left: auto; } /* auto margin eats free space: pushes it to the end */
```

`margin-left: auto` on one item is the cleanest way to say "everything after this goes to the right"
(e.g. a user menu at the end of a header).

:::warn title="Common mistake: a flex item that refuses to shrink"
Flex items have `min-width: auto` by default: they won't shrink below their content's minimum
size. A long URL, a `<pre>` block or a wide table inside a `flex: 1` column will push the layout
wider than the screen instead of wrapping or scrolling. The fix is `min-width: 0` on the flex item
(for columns: `min-height: 0`), then `overflow: auto` or `overflow-wrap: anywhere` on the content.
The same applies to grid items in `1fr` tracks.
:::

:::quiz id=fe-27-q4 xp=10
In this sidebar, the links are stacked vertically. Which property, added to `.sidebar`, centres the
link **boxes** horizontally (each link only as wide as its text, sitting in the middle)?

```css
.sidebar {
  display: flex;
  flex-direction: column;
}
```

- [ ] `justify-content: center`
- [x] `align-items: center`
- [ ] `text-align: center`
- [ ] `vertical-align: middle`
> With `flex-direction: column` the **main axis is vertical**, so horizontal is the **cross axis** —
> controlled by `align-items`. `justify-content: center` is the tempting answer if you remember it as
> "the horizontal one", but it works along the main axis and would centre the links *vertically*.
> `text-align` centres the text *inside* each link, but the boxes still stretch across the full width
> (`align-items` defaults to `stretch`), so a hover background would still span the sidebar;
> `vertical-align` only applies to inline and table-cell content.
:::

## Part 4 — Grid: two dimensions

Grid lays out children in **rows and columns at the same time**. Use flexbox when content decides
the sizes along one line; use grid when **you** decide the structure — page layouts, card grids,
forms with aligned labels.

### Tracks, `fr` and `gap`

```css
.layout {
  display: grid;
  grid-template-columns: 16rem 1fr;    /* sidebar 16rem, content takes the rest */
  grid-template-rows: auto 1fr auto;   /* header, body, footer */
  gap: 1rem;
}
```

`fr` means "a fraction of the **free** space" — after fixed tracks and gaps are subtracted.
`1fr 2fr` gives the second column twice the leftover space. `minmax(12rem, 1fr)` means "at least
12rem, at most one share".

### Template areas: draw the layout

`grid-template-areas` lets you draw the layout as ASCII art, and then move areas around in a media
query without touching the HTML:

```css
.app {
  display: grid;
  grid-template-columns: 15rem 1fr;
  grid-template-rows: auto 1fr auto;
  grid-template-areas:
    "header  header"
    "sidebar main"
    "footer  footer";
  min-height: 100dvh;
}
.app > header { grid-area: header; }
.app > aside  { grid-area: sidebar; }
.app > main   { grid-area: main; }
.app > footer { grid-area: footer; }
```

Each string is a row; each word is a cell; repeating a name spans cells; a `.` is an empty cell.
Areas must be rectangles.

:::warn title="Visual order is not reading order"
Grid areas, `order` and `flex-direction: row-reverse` change where things *appear*, not their order
in the HTML. Screen readers and the Tab key follow the **DOM order**. If you visually move the
sidebar before the main content but it's after it in the HTML, keyboard focus jumps around the
screen. Keep the DOM in a sensible reading order and use layout only for arrangement.
:::

### The responsive card grid in one line

```css
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(16rem, 100%), 1fr));
  gap: 1rem;
}
```

Read it inside out: every column is **at least 16rem and at most 1fr**; `repeat(auto-fit, …)` makes
**as many columns as fit**. On a phone that's one column, on a laptop three or four — no media
query. The `min(16rem, 100%)` stops a single column from overflowing a screen narrower than 16rem.

`auto-fill` vs `auto-fit`: both create as many tracks as fit. With **few items**, `auto-fill` keeps
the empty tracks (items stay card-sized, leaving a gap on the right); `auto-fit` collapses empty
tracks so the existing items **stretch** to fill the row.

:::quiz id=fe-27-q5 xp=10
The container is 1000px wide, holds **two** cards, and `gap` is 0. What happens with
`grid-template-columns: repeat(auto-fill, minmax(200px, 1fr))`?

- [ ] Two columns of 500px each
- [x] Five 200px tracks are created; the two cards take the first two, three tracks stay empty
- [ ] One column, because `1fr` takes all the space
- [ ] It's invalid — `auto-fill` needs a fixed track size
> `auto-fill` creates as many 200px-minimum tracks as fit (1000 / 200 = 5) and **keeps** them even
> when empty, so the cards stay 200px wide. "Two columns of 500px" is what **`auto-fit`** does: it
> collapses the three empty tracks to zero, and `1fr` lets the two real ones stretch. Use `auto-fit`
> when a lonely card should fill the row, `auto-fill` when cards should keep a consistent size.
:::

## Part 5 — Positioning and stacking

Normal flow (blocks stacking, inline text wrapping) plus flex and grid handle 95 % of layouts.
`position` is for the rest: things that overlap or stick.

| `position` | Where it goes | Still takes up space? |
|---|---|---|
| `static` (default) | Normal flow; `top/left` ignored. | Yes |
| `relative` | Normal flow, then nudged by `top/left`. Mainly used as the **anchor** for absolute children. | Yes (original spot) |
| `absolute` | Relative to the nearest **positioned ancestor** (anything not `static`), else the page. | No |
| `fixed` | Relative to the viewport — stays put while scrolling. | No |
| `sticky` | Normal flow until it would scroll past `top: …`, then sticks **within its parent**. | Yes |

```css
/* a badge in the corner of a card */
.card { position: relative; }
.card .badge { position: absolute; top: 0.5rem; right: 0.5rem; }

/* a sticky header */
.site-header { position: sticky; top: 0; z-index: 10; }
```

:::warn title="Common mistake: position: sticky does nothing"
Three usual causes: (1) you forgot `top: 0` — sticky needs a threshold; (2) an ancestor has
`overflow: hidden` / `auto`, which makes *that* ancestor the scroll container, so the element sticks
inside a box that never scrolls; (3) the parent is only as tall as the sticky element, so there's no
room to stick in. And `fixed` breaks the same way: an ancestor with `transform` or `filter` becomes
its containing block, so the "fixed" element scrolls with that ancestor.
:::

### Stacking contexts: why `z-index: 9999` doesn't work

First, the default: when boxes overlap and nobody sets `z-index`, **later in the HTML paints on
top**, and positioned elements paint above non-positioned ones. `z-index` overrides that — but it
only works on **positioned elements** (`relative`, `absolute`, `fixed`, `sticky`) and on **flex /
grid items**. `z-index: 10` on a plain `position: static` block does nothing at all.

And it only compares boxes in the **same stacking context**. A stacking context is a group that's
painted as one unit; its children can never escape it, however high their `z-index`.

Things that create a new stacking context include:

- `position: relative`/`absolute` **with** a `z-index` other than `auto`; `position: fixed`/`sticky` always
- a flex or grid **child** with `z-index` other than `auto`
- `opacity` below 1, `transform`, `filter`, `backdrop-filter`
- `isolation: isolate` (the intentional one — use it to contain a component's z-indexes)

```html
<header style="position: sticky; top: 0; z-index: 10">…</header>
<main>
  <div class="card" style="transform: translateY(-2px)">   <!-- new stacking context! -->
    <div class="dropdown" style="position: absolute; z-index: 9999">…</div>
  </div>
</main>
```

The dropdown's 9999 only counts *inside the card*. The card itself sits at the `auto` level of the
page, below the header's `z-index: 10`, so the dropdown slides under the sticky header. Fixes, from
simplest to most robust:

- **Remove the `transform`** from the card (it was only a hover nudge) — then the dropdown's z-index
  competes at page level again and 9999 beats 10.
- **Raise the card itself** (`position: relative; z-index: 11`) — works, but now the whole card paints
  over the sticky header when you scroll, so it usually just moves the bug.
- **Take the popup out of the card**: the HTML `popover` attribute puts an element in the browser's
  **top layer**, above every stacking context; component libraries do the same with a **portal** that
  renders the popup at the end of `<body>` (covered in **Accessible Modals & Dialogs**).

:::quiz id=fe-27-q6 xp=15
A tooltip with `position: absolute; z-index: 1000` appears **under** a neighbouring card. Which of
these on the tooltip's **parent** could be the cause? (select all that apply)

- [x] `opacity: 0.95`
- [x] `transform: scale(1.02)` on hover
- [x] `position: relative; z-index: 1`
- [ ] `display: block`
- [ ] `padding: 1rem`
> `opacity < 1`, any `transform`, and a positioned element with a non-`auto` `z-index` all create a
> **new stacking context**. The tooltip's 1000 is then only compared with its siblings inside the
> parent; the parent as a whole competes with the neighbouring card at its own level. `display:
> block` and `padding` change size and flow but never stacking. The tempting fix — "set the tooltip
> to 99999" — can't work, because the number never leaves its context.
:::

## Part 6 — Units and fluid sizes

| Unit | Relative to | Use it for |
|---|---|---|
| `px` | Nothing (a CSS pixel) | Borders, hairlines, shadows |
| `rem` | The **root** (`html`) font size — 16px by default, changed by the user's browser setting | Font sizes, spacing, layout widths — respects user zoom preferences |
| `em` | The **element's own** font size (for `font-size` itself: the parent's) | Padding that scales with a button's text, icon sizes next to text |
| `%` | The parent (containing block) — width for widths **and** padding | Fluid widths inside a container |
| `vw` / `vh` | 1 % of the viewport width / height | Full-bleed sections, fluid type |
| `dvh` / `svh` / `lvh` | Dynamic / small / large viewport height | `min-height: 100dvh` that respects mobile browser toolbars |
| `ch` | Width of the `0` character | Readable line length: `max-width: 65ch` |
| `fr` | Free space in a grid | Grid tracks only |

`em` **compounds**: a `1.2em` list inside a `1.2em` list is 1.44× the text. `rem` doesn't, which is
why most teams use `rem` for font sizes and spacing and keep `em` for "relative to this text".

:::warn title="Why not px for font sizes?"
Users with low vision often raise the browser's default font size (in Chrome: Settings → Appearance →
Font size). `rem` scales with that setting; `px` font sizes ignore it. Page zoom works either way, but the
font-size preference doesn't — WCAG reviews and accessibility audits check for this.
:::

### `clamp()`: fluid without breakpoints

`clamp(MIN, PREFERRED, MAX)` returns PREFERRED, but never below MIN or above MAX:

```css
h1 {
  font-size: clamp(1.5rem, 1rem + 2.5vw, 3rem);  /* grows with the viewport, within limits */
}
.page {
  width: min(100% - 2rem, 70rem);  /* 1rem gutter each side, but never wider than 70rem */
  margin-inline: auto;             /* centred */
}
```

Keep a `rem` part in the preferred value (`1rem + 2.5vw`, not just `5vw`): pure `vw` text doesn't
respond to the user's font-size setting.

:::quiz id=fe-27-q7 xp=10
The root font size is 16px. What is the computed font size of the inner `<li>`?

```css
ul { font-size: 1.25em; }
```

```html
<body>            <!-- 16px -->
  <ul>
    <li>Outer
      <ul><li>Inner</li></ul>
    </li>
  </ul>
</body>
```

- [ ] 20px
- [x] 25px
- [ ] 16px
- [ ] 32px
> `em` on `font-size` is relative to the **parent's** font size, so it compounds: the outer `ul` is
> 16 × 1.25 = 20px, the inner `ul` is 20 × 1.25 = **25px**, and its `li` inherits that. 20px is the
> tempting answer — it's what `1.25rem` would give, because `rem` always refers to the root and
> doesn't compound. That difference is exactly why teams prefer `rem` for font sizes.
:::

### Challenge: compute a fluid `clamp()`

:::challenge id=fe-27-c4 lang=ts xp=35
title: Fluid type calculator
Design tools hand you "16px on a 320px phone, 24px on a 1280px desktop". Write
`fluidClamp(minPx, maxPx, minViewport = 320, maxViewport = 1280)` that returns the CSS `clamp()`
string that grows linearly between those two points.

The math (all inputs in px, 1rem = 16px):

- `slope = (maxPx - minPx) / (maxViewport - minViewport)` — px of font per px of viewport
- `vw = slope * 100` — because 1vw is 1 % of the viewport
- `intercept = minPx - slope * minViewport` (in px) → convert to rem by dividing by 16
- Result: `clamp(<minPx/16>rem, <intercept>rem + <vw>vw, <maxPx/16>rem)`

Round every number to **4 decimals** and drop trailing zeros (`Number(x.toFixed(4))`). Throw an
`Error` if `maxPx < minPx` or `maxViewport <= minViewport`.

Example: `fluidClamp(16, 24)` → `"clamp(1rem, 0.8333rem + 0.8333vw, 1.5rem)"`.

hint: Write a tiny helper `const r = (n: number) => Number(n.toFixed(4))` and use it in a template literal.
hint: Check it: at a 320px viewport, 0.8333rem + 0.8333vw = 13.33px + 2.67px = 16px. At 1280px it's 13.33 + 10.67 = 24px.

```ts starter
export function fluidClamp(minPx: number, maxPx: number, minViewport = 320, maxViewport = 1280): string {
  return `clamp(${minPx}px, ${maxPx}px, ${maxPx}px)`
}
```

```ts solution
export function fluidClamp(minPx: number, maxPx: number, minViewport = 320, maxViewport = 1280): string {
  if (maxPx < minPx) throw new Error('maxPx must be >= minPx')
  if (maxViewport <= minViewport) throw new Error('maxViewport must be > minViewport')
  const r = (n: number) => Number(n.toFixed(4))
  const slope = (maxPx - minPx) / (maxViewport - minViewport)
  const intercept = minPx - slope * minViewport
  return `clamp(${r(minPx / 16)}rem, ${r(intercept / 16)}rem + ${r(slope * 100)}vw, ${r(maxPx / 16)}rem)`
}
```

```ts tests
test('body text 16px → 24px with default viewports', () => {
  expect(fluidClamp(16, 24)).toBe('clamp(1rem, 0.8333rem + 0.8333vw, 1.5rem)')
})
test('a heading 32px → 48px', () => {
  expect(fluidClamp(32, 48)).toBe('clamp(2rem, 1.6667rem + 1.6667vw, 3rem)')
})
test('custom viewport range 400px → 1200px', () => {
  expect(fluidClamp(16, 20, 400, 1200)).toBe('clamp(1rem, 0.875rem + 0.5vw, 1.25rem)')
})
test('throws when max is smaller than min', () => {
  expect(() => fluidClamp(24, 16)).toThrow()
})
test('throws when the viewport range is empty', () => {
  expect(() => fluidClamp(16, 24, 800, 800)).toThrow()
})
```
:::

## Part 7 — Responsive design

### Mobile-first media queries

Write the base styles for the **smallest** screen, then add `min-width` queries that layer on more
complex layouts as space appears:

```css
.app { display: grid; gap: 1rem; }            /* phone: one column, everything stacked */

@media (width >= 48rem) {                     /* tablet and up */
  .app { grid-template-columns: 15rem 1fr; }
}

@media (width >= 80rem) {                     /* wide desktop */
  .app { grid-template-columns: 18rem 1fr 20rem; }
}
```

Why mobile-first? The phone layout is usually the simplest (one column), so the base CSS stays
small, and each query only **adds** — you rarely have to undo styles. Desktop-first (`max-width`)
queries tend to pile up overrides that reset what the desktop rules did.

- `(width >= 48rem)` is the modern **range syntax**, supported in all current browsers; it means the
  same as `(min-width: 48rem)`. `rem` in media queries uses the browser's *default* font size, so
  breakpoints move sensibly when users enlarge text.
- Pick breakpoints where **your content** breaks, not at device widths — there are thousands of
  devices.
- Don't forget the `<meta name="viewport" content="width=device-width, initial-scale=1">` tag in
  `index.html` (Vite's template has it). Without it, phones render a 980px "desktop" page and
  shrink it.
- Media queries can also ask about preferences: `(prefers-color-scheme: dark)`,
  `(prefers-reduced-motion: reduce)`, `(hover: hover)` — the theming lesson uses the first one.

### Container queries: components that respond to their own space

A media query asks "how wide is the **viewport**?". But a card in a narrow sidebar and the same
card in a wide main column live in the same viewport. A **container query** asks "how wide is **my
container**?" — exactly what a reusable component needs.

```css
.column {
  container-type: inline-size;   /* this element can be queried by its width */
  container-name: column;        /* optional: target it by name */
}

.card { display: grid; gap: 0.5rem; }

@container column (width > 22rem) {
  .card { grid-template-columns: 4rem 1fr; }  /* thumbnail beside text when there's room */
}
```

Rule of thumb: **media queries for the page layout** (how many columns, where the sidebar goes),
**container queries for components** (how a card arranges itself). Container units like `cqi`
(1 % of the container's inline size) work like `vw` for the container.

Two ways container queries silently "don't work":

- **An element can't query itself.** `@container` looks for the nearest **ancestor** with a
  `container-type`. Putting `container-type` on `.card` and querying it from `.card`'s own rule does
  nothing — put it on the wrapper (the column, the list item) and style the card inside.
- **`container-type: inline-size` stops the container from sizing to its content** (that's how the
  browser avoids an infinite loop: the children depend on the width, so the width can't depend on
  the children). On a block that fills its parent you won't notice; on something shrink-to-fit — an
  `inline-block`, a flex item with no `flex-grow`, an absolutely positioned popup — the container
  can collapse to zero width. Give it a width (or let it stretch) when that happens.

:::quiz id=fe-27-q8 xp=10
The same `TaskCard` component appears in a 280px-wide sidebar and in a 900px-wide main column on a
1440px screen. You want it compact in the sidebar and two-column in the main area. What's the right
tool?

- [ ] `@media (min-width: 900px)` on the card
- [x] `container-type: inline-size` on each card's wrapper and `@container (width > 30rem)` in the card's CSS
- [ ] Two separate components, `SidebarTaskCard` and `MainTaskCard`
- [ ] A `ResizeObserver` in React that sets a `compact` prop
> A media query only sees the viewport — 1440px in both places — so both cards would get the same
> layout. A container query asks about the space the card actually has, which is exactly the
> difference here. Two components duplicate code for a pure styling concern, and a
> `ResizeObserver` re-implements in JavaScript (with extra renders and a flash of the wrong layout)
> what CSS now does natively.
:::

## Part 8 — Modern CSS you'll see in real code

### Native nesting

CSS now supports nesting directly — no Sass required:

```css
.card {
  padding: 1rem;
  border: 1px solid var(--border);

  & h3 { margin: 0 0 0.5rem; }          /* .card h3 */
  &:hover { border-color: var(--accent); } /* .card:hover */
  &.is-selected { outline: 2px solid var(--accent); }

  @media (width >= 48rem) { padding: 1.5rem; }  /* media queries nest too */
}
```

Keep nesting shallow (one or two levels). Deep nesting produces long, very specific selectors that
are hard to override — the same lesson Sass users learned years ago.

### `:has()` — the "parent selector"

`:has()` matches an element **based on what it contains** (or what follows it). Things that used to
need JavaScript or an extra class:

```css
.card:has(img) { grid-template-rows: 10rem auto; }    /* cards with an image get a media row */
.field:has(input:user-invalid) label { color: var(--danger); }  /* red label after the user edits */
.column:has(.card) .empty-hint { display: none; }    /* hide the hint once a card exists */
body:has(dialog[open]) { overflow: hidden; }        /* scroll lock while a dialog is open */
```

`:user-invalid` is the friendlier cousin of `:invalid`: it only matches once the user has interacted
with the field, so an empty `required` input isn't red before anyone typed. Read selectors with
`:has()` right to left: `.column:has(.card) .empty-hint` is "an `.empty-hint` inside a `.column` that
contains a `.card`".

:::info title="Can I use all this?"
Native nesting, `:has()`, container queries, `:user-invalid`, `dvh` units and the media-query range
syntax are all **Baseline** — supported in Chrome, Edge, Firefox and Safari since the end of 2023.
Very old browsers (or an old WebView in an embedded app) may lack them; check the "Baseline" badge
on each feature's MDN page (developer.mozilla.org) or caniuse.com when your project has to support
older targets.
:::

### Custom properties (a preview)

**Custom properties** (CSS variables) are named values that **inherit** down the tree and can be
changed at runtime:

```css
:root {
  --space: 1rem;
  --radius: 0.5rem;
  --accent: #3355ff;
}
.card { padding: var(--space); border-radius: var(--radius); }
.compact { --space: 0.5rem; }      /* everything inside .compact gets tighter */
.badge { color: var(--badge-color, var(--accent)); }   /* fallback value */
```

Unlike Sass variables they exist in the browser, so a parent class, a media query or a line of
JavaScript can change them and everything using them updates. That's the foundation of design
tokens and dark mode — the full story is in **Styling, Design Tokens & Themes**.

:::quiz id=fe-27-q9 xp=10
Which selector gives a red border to every `.field` whose input is currently invalid — without
adding any class from JavaScript?

- [ ] `.field input:invalid { border: 1px solid red; }`
- [x] `.field:has(input:invalid) { border: 1px solid red; }`
- [ ] `input:invalid < .field { border: 1px solid red; }`
- [ ] `.field:invalid { border: 1px solid red; }`
> `:has()` matches the `.field` **because of** something inside it, so the border lands on the
> wrapper. The first option is tempting and valid CSS — but it styles the *input*, not the `.field`.
> There is no `<` parent combinator in CSS; `:has()` is how you express it. And `.field:invalid` only
> works on form controls (and `form`/`fieldset`), not an arbitrary wrapper `div`.
:::

## Part 9 — Layout recipes

These five cover most screens you'll build. Learn them by heart; they're also classic interview
"live CSS" tasks.

**1. Centre anything (both axes)**

```css
.center {
  display: grid;
  place-items: center;   /* align-items + justify-items in one */
  min-height: 100dvh;
}
```

(The flexbox version: `display: flex; justify-content: center; align-items: center;`. For a block
with a known width, `margin-inline: auto` centres it horizontally only.)

**2. Holy grail (header, footer, sidebar, content — footer at the bottom even on short pages)**

```css
.app {
  display: grid;
  min-height: 100dvh;
  grid-template-rows: auto auto 1fr auto;  /* the 1fr row eats the extra height */
  grid-template-areas: "header" "sidebar" "main" "footer";   /* phone: stacked in DOM order */
}
.app > header { grid-area: header; }
.app > aside  { grid-area: sidebar; }
.app > main   { grid-area: main; }
.app > footer { grid-area: footer; }

@media (width >= 48rem) {
  .app {
    grid-template-columns: 15rem 1fr;
    grid-template-rows: auto 1fr auto;
    grid-template-areas: "header header" "sidebar main" "footer footer";
  }
}
```

Every child that uses `grid-area: sidebar` needs a `sidebar` cell in **every** template — if a
breakpoint's template forgets one, the browser silently adds extra implicit rows/columns for it and
the layout goes strange.

**3. Responsive card grid** — `repeat(auto-fit, minmax(min(16rem, 100%), 1fr))` from Part 4.

**4. Sticky header** — `position: sticky; top: 0; z-index: 10;` plus a background (otherwise
content shows through) and no `overflow: hidden` on its ancestors.

**5. Toolbar with a pushed-right item**

```css
.toolbar { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.toolbar .spacer { margin-left: auto; }
```

:::quiz id=fe-27-q10 xp=10
Which rule centres `.child` both horizontally **and** vertically inside `.parent`, whatever the
child's size?

```css
.parent { height: 400px; /* + ??? */ }
```

- [ ] `.child { margin: auto; }` with `.parent` left as `display: block`
- [ ] `.parent { text-align: center; vertical-align: middle; }`
- [x] `.parent { display: grid; place-items: center; }`
- [ ] `.parent { display: flex; justify-content: center; }`
> Grid with `place-items: center` centres the child on both axes. `margin: auto` is the tempting one:
> in normal block flow it only centres horizontally (and only if the child has a width) — auto
> vertical margins compute to 0 in block layout. It *does* centre both ways inside a flex or grid
> parent. The flex option with only `justify-content` centres along the main axis (horizontal) but
> not vertically: the child is stretched to the full 400px (the default `align-items: stretch`) or,
> if it has its own height, sits at the top. `vertical-align` doesn't apply to block children.
:::

:::pro title="How experienced devs debug layout"
They don't guess-and-reload. They open DevTools and: (1) hover the element to see the **box model
overlay** — margins in orange, padding in green; (2) click the **grid** / **flex** badge next to the
element in the Elements panel to draw tracks, gaps and line numbers; (3) check the **Computed** tab
to see which rule actually won; (4) for "why is the page scrolling sideways", run
`document.querySelectorAll('*').forEach(e => e.getBoundingClientRect().right > document.documentElement.clientWidth && console.log(e))`
in the Console to list every element sticking out past the right edge, or
temporarily add `* { outline: 1px solid red }`. Nine times out of ten the culprit is a `width:
100vw` (which includes the scrollbar) or a flex item missing `min-width: 0`.
:::

## Lab: a responsive Project-board layout

:::lab id=fe-27-lab1 xp=90
title: Build the Project-board shell with landmarks, grid, flexbox and a container query
You'll build the static layout for the Project board you'll make interactive later in the track:
a sticky header with the main nav, a projects sidebar, and a board with three columns of cards. It
must be one column on a phone and sidebar + columns on a laptop — and pass three accessibility-tree
tests.

**1. Create the app** (Node 20.19+ or 22.12+):

```bash
npm create vite@latest project-board-layout -- --template react-ts
cd project-board-layout
npm install
npm install -D vitest jsdom @testing-library/react @testing-library/dom
```

(If `create vite` asks whether to install and start now, answer **No** — you'll run the steps
yourself.)

:::warn title="If npm reports a peer-dependency conflict"
Vitest declares which Vite majors it supports. If `npm install -D vitest …` fails with `ERESOLVE`
mentioning `vite`, the newest Vitest doesn't list your Vite version yet (or the other way round):
install the Vitest major the Vitest docs (vitest.dev, "Getting Started") list for your Vite major,
e.g. `npm install -D vitest@<major>`. Don't use `--force`.
:::

**2. Replace `src/App.tsx`** with:

```tsx
type Card = { id: string; title: string; tag: string; due?: string; urgent?: boolean }
type Column = { id: string; title: string; cards: Card[] }

const projects = [
  { id: 'web', name: 'Website relaunch' },
  { id: 'app', name: 'Mobile app' },
  { id: 'billing', name: 'Billing v2' },
]

const columns: Column[] = [
  {
    id: 'todo',
    title: 'To do',
    cards: [
      { id: 'c1', title: 'Write release notes', tag: 'Docs', due: '2026-11-20' },
      { id: 'c2', title: 'Fix login redirect loop', tag: 'Bug', urgent: true },
      { id: 'c3', title: 'Audit colour contrast', tag: 'A11y' },
    ],
  },
  {
    id: 'doing',
    title: 'In progress',
    cards: [{ id: 'c4', title: 'New pricing page', tag: 'Feature', due: '2026-11-12' }],
  },
  {
    id: 'done',
    title: 'Done',
    cards: [
      { id: 'c5', title: 'Set up CI pipeline', tag: 'Ops' },
      { id: 'c6', title: 'Design tokens v1', tag: 'Design' },
    ],
  },
]

export default function App() {
  return (
    <div className="app">
      <a className="skip-link" href="#main">Skip to content</a>

      <header className="site-header">
        <a className="logo" href="/">DevQuest Boards</a>
        <nav aria-label="Main">
          <ul className="nav-list">
            <li><a href="/boards" aria-current="page">Boards</a></li>
            <li><a href="/reports">Reports</a></li>
            <li><a href="/settings">Settings</a></li>
          </ul>
        </nav>
      </header>

      <aside className="sidebar" aria-labelledby="projects-title">
        <h2 id="projects-title">Projects</h2>
        <ul className="project-list">
          {projects.map((p) => (
            <li key={p.id}>
              <a href={`/projects/${p.id}`} aria-current={p.id === 'web' ? 'page' : undefined}>
                {p.name}
              </a>
            </li>
          ))}
        </ul>
      </aside>

      <main id="main" className="board" tabIndex={-1}>
        <h1>Website relaunch</h1>
        <div className="columns">
          {columns.map((col) => (
            <section key={col.id} className="column" aria-labelledby={`col-${col.id}`}>
              <h2 id={`col-${col.id}`}>
                {col.title} <span className="count">{col.cards.length}</span>
              </h2>
              <ul className="cards">
                {col.cards.map((card) => (
                  <li key={card.id}>
                    <article className="card">
                      <h3>{card.title}</h3>
                      <p className="meta">
                        <span className={card.urgent ? 'tag tag-urgent' : 'tag'}>{card.tag}</span>
                        {card.due && <time dateTime={card.due}>Due {card.due}</time>}
                      </p>
                    </article>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </main>

      <footer className="site-footer">© 2026 DevQuest</footer>
    </div>
  )
}
```

**3. Replace `src/index.css`** with the following, then **delete `src/App.css`** (nothing imports it
any more). Read the comments — every technique from this lesson is in here.

```css
/* ---- reset & tokens ---- */
*, *::before, *::after { box-sizing: border-box; }

:root {
  --space: 1rem;
  --radius: 0.5rem;
  --surface: #f5f6f8;
  --raised: #ffffff;
  --fg: #1d2330;
  --muted: #535c6e;
  --border: #d9dde5;
  --accent: #2f4fe0;
  --danger: #c62828;
  font-family: system-ui, sans-serif;
  line-height: 1.5;
  color: var(--fg);
  background: var(--surface);
}

body { margin: 0; }
ul { list-style: none; margin: 0; padding: 0; }
h1, h2, h3 { line-height: 1.2; }

/* ---- skip link: off-screen until focused ---- */
.skip-link {
  position: absolute;
  left: var(--space);
  top: -10rem;
  z-index: 100;
  padding: 0.5rem 1rem;
  background: var(--accent);
  color: #fff;
  border-radius: var(--radius);
}
.skip-link:focus { top: var(--space); }

/* ---- page layout: mobile-first grid with template areas ---- */
.app {
  min-height: 100dvh;
  display: grid;
  grid-template-rows: auto auto 1fr auto;
  /* phone: stacked in the SAME order as the HTML, so Tab order matches what you see */
  grid-template-areas: "header" "sidebar" "main" "footer";
}

.site-header {
  grid-area: header;
  position: sticky;            /* stays on top while the page scrolls */
  top: 0;
  z-index: 10;
  display: flex;               /* one-dimensional: logo + nav in a row */
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem 1rem;
  padding: 0.75rem var(--space);
  background: var(--raised);   /* sticky needs a background */
  border-bottom: 1px solid var(--border);
}
.logo { font-weight: 700; color: inherit; text-decoration: none; }

.nav-list { display: flex; gap: 0.25rem; }
.nav-list a,
.project-list a {
  display: block;
  padding: 0.4rem 0.75rem;
  border-radius: var(--radius);
  color: inherit;
  text-decoration: none;
}
.nav-list a:hover,
.project-list a:hover { background: var(--surface); }
.nav-list a[aria-current='page'],
.project-list a[aria-current='page'] { background: var(--accent); color: #fff; }

.sidebar {
  grid-area: sidebar;
  padding: var(--space);
  border-bottom: 1px solid var(--border);
  & h2 { font-size: 1rem; margin: 0 0 0.5rem; }
}
/* phone: project links wrap in a compact row so the board isn't pushed far down */
.project-list { display: flex; flex-wrap: wrap; gap: 0.25rem; }

.board {
  grid-area: main;
  min-width: 0;                /* let wide content shrink instead of overflowing */
  padding: var(--space);
  & h1 { font-size: clamp(1.5rem, 1.2rem + 1.5vw, 2.25rem); margin: 0 0 var(--space); }
}

.site-footer {
  grid-area: footer;
  padding: var(--space);
  color: var(--muted);
  border-top: 1px solid var(--border);
}

/* ---- board columns: as many as fit, no media query ---- */
.columns {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(17rem, 100%), 1fr));
  gap: var(--space);
  align-items: start;
}

.column {
  container-type: inline-size;  /* cards inside can respond to the column's width */
  padding: 0.75rem;
  background: var(--raised);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  & h2 {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 1rem;
    margin: 0 0 0.75rem;
  }
}
.count {
  min-width: 1.75rem;
  padding: 0 0.5rem;
  border-radius: 999px;
  background: var(--surface);
  color: var(--muted);
  font-size: 0.8rem;
  text-align: center;
}

.cards { display: flex; flex-direction: column; gap: 0.5rem; }

.card {
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  & h3 { font-size: 0.95rem; margin: 0 0 0.5rem; }
  &:has(.tag-urgent) { border-left: 4px solid var(--danger); }  /* style the card by its content */
}

.meta {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin: 0;
  font-size: 0.85rem;
  color: var(--muted);
}
.tag { font-weight: 600; }
.tag-urgent { color: var(--danger); }

/* the card rearranges when ITS COLUMN is wide, not the viewport */
@container (width > 22rem) {
  .meta { flex-direction: row; justify-content: space-between; align-items: center; }
}

/* ---- tablet and up: sidebar beside the board ---- */
@media (width >= 48rem) {
  .app {
    grid-template-columns: 15rem 1fr;
    grid-template-rows: auto 1fr auto;
    grid-template-areas:
      "header  header"
      "sidebar main"
      "footer  footer";
  }
  .sidebar { border-bottom: 0; border-right: 1px solid var(--border); }
  .project-list { flex-direction: column; }   /* a vertical list beside the board */
}
```

:::info title="Why the sidebar sits above the board on phones"
In the HTML the `<aside>` comes before `<main>`, so on a phone it's stacked in that order too. If CSS
put it *below* the board, Tab would first jump down past the whole board to the project links and
then back up — the "visual order is not reading order" trap from Part 4. The skip link still lets
keyboard users jump straight to the board.
:::

:::info title="list-style: none and Safari"
Safari/VoiceOver has historically stopped announcing a `<ul>` as a list when it's styled with
`list-style: none` (lists inside `<nav>` are still announced). It's a deliberate WebKit heuristic,
not a bug in your markup. If the "list, 3 items" announcement matters for a styled list, add
`role="list"` to the `<ul>` explicitly.
:::

**4. Add the tests.** Replace `vite.config.ts` with:

```ts
/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: { environment: 'jsdom' },
})
```

Create `src/App.test.tsx`:

```tsx
import { afterEach, expect, test } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import App from './App'

afterEach(cleanup)

test('has the page landmarks', () => {
  render(<App />)
  expect(screen.getByRole('banner')).toBeTruthy()
  expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy()
  expect(screen.getByRole('complementary', { name: 'Projects' })).toBeTruthy()
  expect(screen.getByRole('main')).toBeTruthy()
  expect(screen.getByRole('contentinfo')).toBeTruthy()
})

test('heading outline: one h1, one h2 per board column', () => {
  render(<App />)
  expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  const main = screen.getByRole('main')
  expect(within(main).getAllByRole('heading', { level: 2 })).toHaveLength(3)
})

test('every card is an article with a level-3 heading', () => {
  render(<App />)
  const cards = screen.getAllByRole('article')
  expect(cards).toHaveLength(6)
  for (const card of cards) {
    expect(within(card).getByRole('heading', { level: 3 })).toBeTruthy()
  }
})
```

Run them:

```bash
npx vitest run
```

*Expected* (timings differ):

```text
 ✓ src/App.test.tsx (3 tests) 85ms

 Test Files  1 passed (1)
      Tests  3 passed (3)
```

**5. Look at it.** Run `npm run dev` and open the URL it prints (usually
`http://localhost:5173/`). In DevTools, toggle the device toolbar (Ctrl/⌘ + Shift + M):

- At **375px** wide: header on top, the project links in a compact row below it, then the board
  columns stacked in one column, **no horizontal scrollbar**.
- At **1280px**: sidebar on the left, three board columns side by side, footer across the bottom.
- Drag the width slowly: the number of board columns changes on its own (auto-fit), and the card's
  tag/date line switches from stacked to one row whenever a **column** is wider than 22rem — not at
  a fixed viewport width. For example, at about **800px** the board has room for only one wide column
  and the line is one row; at **1280px** the three columns are narrower and it's stacked again. A
  media query could never do that.
- Scroll on a short window: the header stays at the top.
- Press Tab once on a fresh load: the **Skip to content** link appears; Enter moves focus to the
  board.
- Elements panel: click the `grid` badge on `.app` to see the named areas.

**6. Build it:** `npm run build` — *expected:* TypeScript passes and Vite prints the `dist/` files
with sizes and `✓ built in …`.

:::tip title="Stretch goals"
Add a fourth column ("Review") to the data and watch the grid absorb it. Then move the sidebar to
the *right* only by changing `grid-template-areas` — and notice that Tab order still follows the
HTML, which is why you shouldn't do that for content users read in sequence.
:::

- [ ] `npx vitest run` shows 3 passing tests
- [ ] At 375px the layout is one column (header, projects, board, footer) with no horizontal scrolling
- [ ] At 1280px the sidebar sits left of three side-by-side columns and the footer spans the bottom
- [ ] The header stays visible while scrolling (sticky) and the skip link appears on the first Tab
- [ ] The card meta line switches layout based on the column width (container query), and the urgent card has a red left border (`:has()`)
- [ ] `npm run build` completes without errors
:::

## Flashcards

:::cards id=fe-27-cards1 xp=20 title="HTML & CSS layout"
Q: Name the five main landmark elements and their roles.
A: `header` → banner, `nav` → navigation, `main` → main (one per page), `aside` → complementary,
   `footer` → contentinfo. A `section` with an accessible name becomes a region.
Q: Link or button — how do you decide?
A: Goes somewhere with a URL (could open in a new tab) → `<a href>`. Does something on this page → `<button type="button">`.
Q: What's the default `type` of a `<button>` inside a `<form>`?
A: `submit` — so non-submit buttons need `type="button"`.
Q: Why is a placeholder not a label?
A: It disappears while typing, is often low-contrast and isn't reliably announced. Use a `<label>` (or `aria-label` when there's no visible text).
Q: What does `box-sizing: border-box` change?
A: `width`/`height` include padding and border, so `width: 300px` is 300px on screen.
Q: In flexbox, which axis do `justify-content` and `align-items` work on?
A: `justify-content` → main axis (follows `flex-direction`); `align-items` → cross axis.
Q: Why might a `flex: 1` item overflow instead of shrinking?
A: Flex items default to `min-width: auto` (can't shrink below their content). Set `min-width: 0`.
Q: The one-line responsive card grid?
A: `grid-template-columns: repeat(auto-fit, minmax(min(16rem, 100%), 1fr))`.
Q: auto-fill vs auto-fit?
A: Both create as many tracks as fit; auto-fill keeps empty tracks, auto-fit collapses them so items stretch.
Q: Why doesn't `z-index: 9999` put my popup on top?
A: It's trapped in a stacking context (parent with `transform`, `opacity < 1`, positioned + z-index…). z-index only competes within the same context. Fix the parent or use a portal.
Q: rem vs em?
A: `rem` = root font size, doesn't compound. `em` = the element's (or parent's, for font-size) font size, compounds when nested.
Q: Media query vs container query?
A: Media query = viewport size, for page layout. Container query = the component's container size, for reusable components.
Q: What does `clamp(1rem, 0.8rem + 1vw, 1.5rem)` do?
A: Uses the fluid middle value, but never below 1rem or above 1.5rem.
Q: How do you centre something on both axes?
A: `display: grid; place-items: center;` on the parent (or flex with `justify-content` + `align-items: center`).
:::

## Recap

- HTML gives elements **roles, names and states** in the accessibility tree; assistive tech, search
  engines and `getByRole` tests all read it. Pick the element for what it *is*, then style it.
- Use **landmarks** (`header`, `nav`, `main` — one —, `aside`, `footer`), a **heading outline**
  without skipped levels, **links to go, buttons to do**, and a **label** for every input
  (`fieldset`/`legend` for groups).
- Set `box-sizing: border-box` globally; remember margins collapse in normal flow but not in flex/grid,
  and prefer `gap` for spacing.
- **Flexbox** = one line, sizes from content (`justify-content` main axis, `align-items` cross axis,
  `min-width: 0` for shrinking). **Grid** = rows and columns you define (`fr`, `minmax`, template
  areas, `repeat(auto-fit, …)`).
- `position: relative` anchors `absolute` children; `sticky` needs `top` and no `overflow` ancestor;
  `z-index` only works on positioned or flex/grid items and only competes inside its **stacking
  context** — escape it with `popover` / a portal, not a bigger number.
- Use `rem` for sizes, `ch` for line length, `dvh` for full height, `clamp()` for fluid type.
- Go **mobile-first** with `min-width` media queries for the page; use **container queries** for
  components (the container must be an *ancestor* with `container-type`). Native nesting, `:has()` and custom properties are everyday modern CSS.
- Visual order isn't reading order: keep the DOM in a sensible sequence.
