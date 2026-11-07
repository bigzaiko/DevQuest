---
id: fe-16
title: Styling, Design Tokens & Themes
level: intermediate
minutes: 75
xp: 170
summary: Tailwind v4's CSS-first @theme, CSS Modules, design tokens as CSS custom properties, dark/light themes, and composing classes with cn() and variants.
---

Styling is where many React codebases quietly rot. Not because CSS is hard, but because nobody decided
**where values come from**. One developer writes `#2563eb`, another `#2463EB`, a third `rgb(37 99 235)` —
and six months later "make the brand colour slightly darker" is a two-day search-and-replace.

This lesson is about the system behind the styles: **design tokens**, a styling approach that scales
(Tailwind v4 or CSS Modules), **themes** that switch without re-rendering React, and the small helpers
(`cn()`, variants) every component library uses. It assumes the layout fundamentals (semantic HTML, flexbox,
grid, media and container queries) from the HTML & CSS layout lesson earlier in the track; tokens and Tailwind
sit on top of those, they don't replace them.

## The landscape in one table

| Approach | How it works | Strengths | Weaknesses |
|---|---|---|---|
| Global CSS | `.btn { … }` in a stylesheet | Simple, zero tooling | Name collisions, dead CSS nobody dares delete |
| **CSS Modules** | `Button.module.css`, class names hashed per file | Real CSS, locally scoped, zero runtime | Separate file per component, variants are manual |
| **Tailwind CSS** | Utility classes in markup: `px-4 py-2 rounded-lg` | Fast, consistent scale, tiny CSS output, no naming | Long class lists, needs discipline for variants |
| CSS-in-JS (runtime) | styled-components, Emotion | Co-located, dynamic | Runtime cost, problems with Server Components and streaming |

In 2026 most new React projects pick **Tailwind** or **CSS Modules**; runtime CSS-in-JS has largely fallen
out of favour (zero-runtime variants like vanilla-extract and Panda CSS remain). Both modern choices compile
to plain CSS at build time — and both work best on top of **design tokens**.

## Design tokens: named decisions

A design token is a **named design decision**: "the brand colour is this blue", "card corners are 12 px",
"the base spacing step is 4 px". Code references the **name**, never the raw value.

Mature design systems organise tokens in three tiers:

```text
Primitive (raw palette)     Semantic (meaning)                Component (optional)
--blue-600: #2563eb   ──►   --color-primary: var(--blue-600) ──►  --button-bg: var(--color-primary)
--gray-50:  #f9fafb   ──►   --color-surface: var(--gray-50)
--gray-900: #111827   ──►   --color-text:    var(--gray-900)
```

- **Primitives** describe *what it is* (`blue-600`). Components should almost never use them directly.
- **Semantic tokens** describe *what it's for* (`primary`, `surface`, `danger`, `border-muted`). Components use these.
- **Component tokens** are optional fine-tuning hooks for one component.

The payoff: a **theme** is just a different mapping from semantic to primitive. Dark mode doesn't change
any component — it re-points `--color-surface` from `gray-50` to `gray-900`.

### CSS custom properties are the runtime for tokens

A **CSS custom property** (a "CSS variable") is any property whose name starts with `--`. You declare it on
a selector like any other property, and read it anywhere below with `var(--name)` (optionally with a fallback:
`var(--name, blue)`).

```css
:root {
  /* primitives */
  --blue-600: #2563eb;
  --gray-50: #f9fafb;
  --gray-900: #111827;
  --white: #ffffff;

  /* semantic tokens */
  --color-primary: var(--blue-600);
  --color-on-primary: var(--white);   /* text that sits ON the primary colour */
  --color-surface: var(--gray-50);
  --color-text: var(--gray-900);
  --radius-md: 0.5rem;
  --space-2: 0.5rem;
  --space-4: 1rem;
}

[data-theme='dark'] {
  --color-surface: var(--gray-900);
  --color-text: var(--gray-50);
}

.card {
  background: var(--color-surface);
  color: var(--color-text);
  border-radius: var(--radius-md);
  padding: var(--space-4);
}
```

Custom properties **cascade and inherit**, and they're **live**: change the attribute on `<html>` and the
browser restyles the whole page in one pass, **without React re-rendering anything**. That's why tokens
belong in CSS variables rather than in a JS theme object passed through Context: changing a Context value
re-renders every component that reads it, just to produce the same markup with different colours.

Two common mistakes:

- **Using primitives in components** (`background: var(--blue-600)`). It looks like a token, but a dark theme
  can't re-point it without making "blue-600" mean something that isn't blue-600. Components reference
  *semantic* names.
- **Naming semantic tokens after looks** (`--color-blue-button`). The day the brand turns green, the name lies.
  Name the *role*: `--color-primary`, `--color-danger`, `--color-border-muted`.

:::pro title="Tokens as a source of truth"
Larger teams keep tokens in a tool-neutral JSON format (the W3C Design Tokens format, often exported from
Figma variables) and generate CSS variables, Tailwind `@theme` blocks and even native app constants from it
with a build step (Style Dictionary or Terrazzo). Designers change a value in Figma, CI opens a PR — the
code never contains a hand-typed hex colour.
:::

:::challenge id=fe-16-c1 lang=ts xp=50
title: Tokens to CSS variables
This is the core of what tools like Style Dictionary do (simplified: the real W3C format wraps each value in
`{ "$value": …, "$type": … }`, but the idea is identical). Write `tokensToCssVars(tokens)` that flattens a
nested token object into CSS custom properties:

- Nested keys join with `-` and get a `--` prefix: `{ color: { blue: { 600: '#2563eb' } } }` → `'--color-blue-600': '#2563eb'`.
- A value that is a **reference** like `'{color.blue.600}'` becomes `'var(--color-blue-600)'`
  (dots become dashes). References keep the theme switchable — don't inline the raw value.
- A value only counts as a reference when the braces wrap the **whole** string: `'Inter {x}'` stays as it is.
- Numbers are converted to strings (`50` → `'50'`).
- Return a plain object `Record<string, string>`.

hint: Recurse with a `prefix: string[]` path; when the value is not an object, write `out['--' + path.join('-')]`.
hint: References match `/^\{(.+)\}$/` — replace with `` `var(--${ref.split('.').join('-')})` ``.

```ts starter
type TokenTree = { [key: string]: string | number | TokenTree }

export function tokensToCssVars(tokens: TokenTree): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(tokens)) out['--' + k] = String(v)
  return out
}
```

```ts solution
type TokenTree = { [key: string]: string | number | TokenTree }

export function tokensToCssVars(tokens: TokenTree): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (node: TokenTree, path: string[]) => {
    for (const [k, v] of Object.entries(node)) {
      const p = [...path, k]
      if (v !== null && typeof v === 'object') walk(v, p)
      else {
        const s = String(v)
        const ref = /^\{(.+)\}$/.exec(s)
        out['--' + p.join('-')] = ref ? `var(--${ref[1].split('.').join('-')})` : s
      }
    }
  }
  walk(tokens, [])
  return out
}
```

```ts tests
test('flattens nested primitives', () => {
  expect(tokensToCssVars({ color: { blue: { 600: '#2563eb' }, gray: { 50: '#f9fafb' } } })).toEqual({
    '--color-blue-600': '#2563eb',
    '--color-gray-50': '#f9fafb',
  })
})
test('numbers become strings', () => {
  expect(tokensToCssVars({ z: { modal: 50 } })).toEqual({ '--z-modal': '50' })
})
test('references become var()', () => {
  expect(tokensToCssVars({ color: { primary: '{color.blue.600}' } })).toEqual({ '--color-primary': 'var(--color-blue-600)' })
})
test('mixed tree', () => {
  const out = tokensToCssVars({
    radius: { md: '0.5rem' },
    color: { blue: { 600: '#2563eb' }, primary: '{color.blue.600}' },
  })
  expect(out).toEqual({ '--radius-md': '0.5rem', '--color-blue-600': '#2563eb', '--color-primary': 'var(--color-blue-600)' })
})
test('braces only count as a reference when they wrap the whole value', () => {
  expect(tokensToCssVars({ font: { body: 'Inter {x}' } })).toEqual({ '--font-body': 'Inter {x}' })
})
```
:::

## Tailwind CSS v4: CSS-first configuration

Tailwind v4 (2025) was a rewrite. The big change: **configuration lives in CSS**, not in
`tailwind.config.js`. Your tokens *become* the utility classes.

```bash
npm install tailwindcss @tailwindcss/vite
```

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({ plugins: [react(), tailwindcss()] })
```

```css
/* src/index.css */
@import "tailwindcss";

@theme {
  --color-brand-50:  oklch(0.97 0.02 260);
  --color-brand-600: oklch(0.55 0.2 260);
  --color-brand-700: oklch(0.48 0.2 260);
  --font-sans: "Inter Variable", system-ui, sans-serif;
  --radius-card: 0.75rem;
  --breakpoint-3xl: 120rem;
}
```

`@theme` looks like a `:root` block, but it's a Tailwind directive with extra meaning. Every variable in it
does two things:

1. It's emitted as a normal CSS variable on `:root`, so `var(--color-brand-600)` works in any hand-written CSS
   (by default Tailwind only emits the variables your code actually uses; `@theme static { … }` emits all of them).
2. Its **namespace** (the prefix before the name) generates utilities: `--color-*` → `bg-brand-600`,
   `text-brand-600`, `border-brand-600`…; `--radius-*` → `rounded-card`; `--font-*` → `font-sans`;
   `--breakpoint-*` → a `3xl:` responsive variant.

A plain `:root { --x: … }` block, by contrast, creates a variable but **no utilities**. That distinction is
the key to the theming setup below.

:::info title="Why oklch()?"
`oklch(L C H)` describes a colour by **L**ightness (0–1), **C**hroma (colourfulness) and **H**ue (an angle).
Unlike hex or `hsl()`, equal steps in L *look* equally bright, so building a palette means changing one number,
and dark-mode variants are predictable. Tailwind v4's default palette is defined in OKLCH, and every current
browser supports it. Hex still works everywhere — OKLCH is just easier to reason about.
:::

There's no `content: [...]` array any more either — v4 **detects your source files automatically** (respecting
`.gitignore`) and scans them for class names. Add `@source "../packages/ui";` for files it can't find on its own,
such as a UI package in a monorepo or a library inside `node_modules`.

:::warn title="Coming from Tailwind v3"
A few renames bite everyone: `shadow-sm` → `shadow-xs`, `shadow` → `shadow-sm`, `rounded` → `rounded-sm`,
`outline-none` → `outline-hidden`, and the default border colour is now `currentColor` instead of gray.
`npx @tailwindcss/upgrade` migrates a v3 project (config, CSS and class names) in one go.
:::

### Semantic tokens + Tailwind = themes without `dark:` everywhere

The naive way to theme with Tailwind is to sprinkle `bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-50`
on every element. It works, but every component now encodes both themes, and a third theme ("high contrast")
means touching everything. The scalable way is **semantic tokens**:

```css
@import "tailwindcss";

:root {
  --surface: oklch(0.99 0 0);
  --fg: oklch(0.2 0 0);
  --primary: oklch(0.55 0.2 260);
  --on-primary: oklch(0.99 0 0);   /* text that sits ON the primary colour */
}
[data-theme='dark'] {
  --surface: oklch(0.18 0 0);
  --fg: oklch(0.95 0 0);
  --primary: oklch(0.7 0.16 260);
  --on-primary: oklch(0.15 0 0);   /* lighter primary in dark mode needs dark text */
}

/* inline = utilities use var(--surface) directly, resolved on the element itself
   (so nested data-theme sections work too) */
@theme inline {
  --color-surface: var(--surface);
  --color-fg: var(--fg);
  --color-primary: var(--primary);
  --color-on-primary: var(--on-primary);
}

/* make `dark:` follow the data-theme attribute instead of only the OS setting */
@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));
```

Read it as three layers:

1. `:root` and `[data-theme='dark']` hold the **values** per theme (plain variables, no utilities).
2. `@theme inline` creates the **utilities** `bg-surface`, `text-fg`, `bg-primary`… that point at those variables.
3. `@custom-variant` keeps `dark:` available and wires it to the same attribute.

Why `inline`? Without it, Tailwind emits `--color-surface: var(--surface)` on `:root`, and the utility uses
`var(--color-surface)`. A variable that references another variable is resolved **where it is declared** — on
`:root` — and the resolved colour is what child elements inherit. So a nested `<section data-theme="dark">`
would still get the light value. With `inline`, the utility contains `var(--surface)` directly, which is
resolved on the element itself and always follows the nearest theme. (For a single `data-theme` on `<html>`,
plain `@theme` would also switch correctly, because `<html>` *is* `:root`; `inline` is what makes nested and
scoped themes work.)

One gap to know about: the one-line `@custom-variant` above only fires when `data-theme="dark"` is set
explicitly. In **System** mode (no attribute, OS set to dark, see "Dark and light themes done right" below) the
tokens turn dark via a media query, but every `dark:` exception stays inactive, so light-mode exception styles
land on a dark page. If you use `dark:` at all and offer a System option, cover both cases:

```css
@custom-variant dark {
  &:where([data-theme=dark], [data-theme=dark] *) { @slot; }
  @media (prefers-color-scheme: dark) {
    &:where(:root:not([data-theme]), :root:not([data-theme]) *) { @slot; }
  }
}
```

Now components write `bg-surface text-fg` and **never mention dark mode**. You still have `dark:` for the
rare exception. This is the approach used by shadcn/ui and most modern design systems.

:::quiz id=fe-16-q1 xp=15
A component builds its class with `` `bg-${color}-600` `` where `color` is a prop (`'red' | 'green'`). In
production the background is missing. Why?
- [ ] Tailwind v4 doesn't support red and green
- [x] Tailwind scans source files for complete class names as plain text; `bg-red-600` never appears, so its CSS isn't generated
- [ ] Template literals aren't allowed in `className`
- [ ] The class is generated, but `dark:` overrides it
> Tailwind's scanner doesn't run your code — it reads your files as plain text and looks for whole class strings.
> Map props to **complete** class names: `const bg = { red: 'bg-red-600', green: 'bg-green-600' }[color]`.
> It isn't a v4 limitation (v3 behaves the same) and template literals in `className` are perfectly legal React —
> the string just never appears in the source for the scanner to find. In dev it may *seem* to work if some other
> file happens to contain `bg-red-600`, which is why this bug often shows up only later.
:::

## CSS Modules: scoped real CSS

If your team prefers writing CSS (or you're styling something Tailwind is clumsy at, like complex
animations), Vite supports **CSS Modules** out of the box — any file named `*.module.css`:

```css
/* Button.module.css */
.button {
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-md);
  background: var(--color-primary);
  color: var(--color-on-primary);
}
.button:hover { filter: brightness(1.1); }
.ghost { background: transparent; color: var(--color-primary); }
```

```tsx
import styles from './Button.module.css'

export function Button({ ghost, ...props }: { ghost?: boolean } & React.ComponentProps<'button'>) {
  return <button className={ghost ? `${styles.button} ${styles.ghost}` : styles.button} {...props} />
}
```

At build time `.button` becomes something like `._button_x7f2a_1` — **unique per file**, so two components can
both have a `.button` class without colliding. The import gives you an object that maps your names to the
hashed ones (`styles.button === '_button_x7f2a_1'`). You get real CSS (pseudo-classes, media queries, container
queries, nesting) with no global namespace. Note how the module still uses the **same tokens** — tokens are
independent of the styling approach.

Two gotchas: a class you write in the module but never reference via `styles.x` still ships (nothing removes
dead module CSS for you), and `styles.typo` is just `undefined` at runtime — enable TypeScript checking of
module class names (for example with the `typescript-plugin-css-modules` editor plugin) if your team relies
heavily on modules.

:::job title="What you'll find in real projects"
Expect Tailwind in most greenfield React codebases, CSS Modules in many established ones, and often both:
Tailwind for layout and spacing, a module for the one complicated animated component. What matters in review
is that colours, spacing and radii come from **tokens**, not literals. A raw `#3b82f6` or `13px` in a PR
usually gets a comment.
:::

## Composing classes: `cn()`

Components need conditional classes and must accept a `className` from the caller. String concatenation gets
ugly fast (`'btn ' + (active ? 'active ' : '') + className`). Every React UI kit uses a small helper,
conventionally called `cn`:

```ts
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

cn('px-4 py-2', isActive && 'bg-primary', { 'opacity-50': disabled }, className)
```

- **`clsx`** accepts strings, falsy values (skipped), arrays, and objects (`{ class: condition }`).
- **`tailwind-merge`** resolves Tailwind conflicts so the **last one wins**: `cn('px-4', 'px-2')` → `'px-2'`.
  Without it, both classes end up on the element and whichever comes *later in the generated CSS* wins —
  not the one the caller passed. That's why a `className="px-2"` override sometimes "doesn't work".

:::challenge id=fe-16-c2 lang=ts xp=40
title: Implement clsx
Write `cx(...inputs)` that behaves like `clsx`:

- Strings and numbers are included (non-empty only).
- `false`, `null`, `undefined`, `0` and `''` are skipped.
- Arrays are flattened recursively.
- Objects include each key whose value is truthy.
- Result is joined with single spaces, no leading/trailing space.

hint: Collect into an array and `join(' ')` at the end.
hint: Recurse for arrays: `for (const x of input) walk(x)`.

```ts starter
type ClassValue = string | number | null | undefined | false | ClassValue[] | Record<string, unknown>

export function cx(...inputs: ClassValue[]): string {
  return inputs.join(' ')
}
```

```ts solution
type ClassValue = string | number | null | undefined | false | ClassValue[] | Record<string, unknown>

export function cx(...inputs: ClassValue[]): string {
  const out: string[] = []
  const walk = (v: ClassValue) => {
    if (!v) return
    if (typeof v === 'string' || typeof v === 'number') out.push(String(v))
    else if (Array.isArray(v)) v.forEach(walk)
    else for (const [k, on] of Object.entries(v)) if (on) out.push(k)
  }
  inputs.forEach(walk)
  return out.join(' ')
}
```

```ts tests
test('joins strings', () => {
  expect(cx('a', 'b c')).toBe('a b c')
})
test('skips falsy values', () => {
  expect(cx('a', false, null, undefined, 0, '', 'b')).toBe('a b')
})
test('objects include truthy keys', () => {
  expect(cx({ active: true, disabled: false, 'text-sm': 1 })).toBe('active text-sm')
})
test('arrays flatten recursively', () => {
  expect(cx(['a', ['b', { c: true }], [false, ['d']]])).toBe('a b c d')
})
test('numbers are kept', () => {
  expect(cx('col', 2)).toBe('col 2')
})
test('nothing → empty string', () => {
  expect(cx()).toBe('')
  expect(cx(false, null)).toBe('')
})
```
:::

## Variants: one API instead of many booleans

A button with `primary`, `secondary`, `ghost` and `danger` looks, plus three sizes, quickly turns into
`className={primary ? '…' : secondary ? '…' : …}` soup. The industry pattern (popularised by **cva** —
class-variance-authority — and Tailwind Variants) is a **variant config**:

```ts
import { cva, type VariantProps } from 'class-variance-authority'

export const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-md font-medium focus-visible:outline-2 disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-on-primary hover:bg-primary/90',
        secondary: 'bg-surface text-fg border border-fg/20',
        ghost: 'bg-transparent hover:bg-fg/5',
      },
      size: { sm: 'h-8 px-3 text-sm', md: 'h-10 px-4', lg: 'h-12 px-6 text-lg' },
    },
    compoundVariants: [{ variant: 'ghost', size: 'sm', class: 'px-2' }],
    defaultVariants: { variant: 'primary', size: 'md' },
  },
)

type ButtonProps = React.ComponentProps<'button'> & VariantProps<typeof buttonVariants>

export function Button({ variant, size, className, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
```

Why it's better than booleans: **impossible states disappear** (you can't be `primary` *and* `ghost`),
TypeScript autocompletes the options, and all styling decisions for the component sit in one readable table.
You'll build a full Button on this pattern in the Component Forge lesson.

:::challenge id=fe-16-c3 lang=ts xp=60
title: A mini cva
Implement `variants(base, config)` returning a function `(props?) => string`:

- Start with `base`.
- For each variant name in `config.variants`, use `props[name]` or else `config.defaultVariants[name]`,
  and append that option's classes (skip if neither is set).
- Then append the `class` of every entry in `config.compoundVariants` whose conditions **all** match the
  resolved values.
- Finally append `props.className` if given. Join everything with single spaces.

hint: Resolve the values first: `const resolved = { ...defaultVariants, ...definedProps }` — but ignore `undefined` props so they don't overwrite defaults.
hint: A compound variant matches when `Object.entries(rest).every(([k, v]) => resolved[k] === v)` (with `rest` = the entry without `class`).

```ts starter
type Config = {
  variants: Record<string, Record<string, string>>
  defaultVariants?: Record<string, string>
  compoundVariants?: ({ class: string } & Record<string, string>)[]
}

export function variants(base: string, config: Config) {
  return (props: Record<string, string | undefined> = {}) => base
}
```

```ts solution
type Config = {
  variants: Record<string, Record<string, string>>
  defaultVariants?: Record<string, string>
  compoundVariants?: ({ class: string } & Record<string, string>)[]
}

export function variants(base: string, config: Config) {
  return (props: Record<string, string | undefined> = {}) => {
    const resolved: Record<string, string> = { ...(config.defaultVariants ?? {}) }
    for (const [k, v] of Object.entries(props)) if (v !== undefined && k !== 'className') resolved[k] = v
    const out = [base]
    for (const [name, options] of Object.entries(config.variants)) {
      const value = resolved[name]
      if (value !== undefined && options[value]) out.push(options[value])
    }
    for (const cv of config.compoundVariants ?? []) {
      const { class: cls, ...conds } = cv
      if (Object.entries(conds).every(([k, v]) => resolved[k] === v)) out.push(cls)
    }
    if (props.className) out.push(props.className)
    return out.filter(Boolean).join(' ')
  }
}
```

```ts tests
const button = variants('btn', {
  variants: {
    variant: { primary: 'bg-primary', ghost: 'bg-transparent' },
    size: { sm: 'h-8', md: 'h-10' },
  },
  compoundVariants: [{ variant: 'ghost', size: 'sm', class: 'px-2' }],
  defaultVariants: { variant: 'primary', size: 'md' },
})

test('defaults', () => {
  expect(button()).toBe('btn bg-primary h-10')
})
test('explicit variants override defaults', () => {
  expect(button({ variant: 'ghost', size: 'md' })).toBe('btn bg-transparent h-10')
})
test('undefined props fall back to defaults', () => {
  expect(button({ variant: undefined, size: 'sm' })).toBe('btn bg-primary h-8')
})
test('compound variants apply only when all conditions match', () => {
  expect(button({ variant: 'ghost', size: 'sm' })).toBe('btn bg-transparent h-8 px-2')
  expect(button({ variant: 'primary', size: 'sm' })).toBe('btn bg-primary h-8')
})
test('className goes last', () => {
  expect(button({ className: 'w-full' })).toBe('btn bg-primary h-10 w-full')
})
test('works without defaults', () => {
  const badge = variants('badge', { variants: { tone: { info: 'blue', danger: 'red' } } })
  expect(badge()).toBe('badge')
  expect(badge({ tone: 'danger' })).toBe('badge red')
})
```
:::

## Dark and light themes done right

A good theme switcher has three options — **Light**, **Dark**, **System** — and a few details people miss:

1. **System** follows `prefers-color-scheme` and must react when the OS setting changes (many OSes switch
   automatically at sunset). The cleanest way is to let **CSS** do it: "System" means *no* `data-theme` attribute,
   and a media query supplies the dark values. The browser re-evaluates media queries live, so no JS is needed.
   Only if JS itself must know the effective theme (say, to pick a chart palette) do you subscribe with
   `matchMedia('(prefers-color-scheme: dark)').addEventListener('change', …)`.
2. Set the theme as an **attribute on `<html>`** (`data-theme="dark"`), so the token overrides apply to
   everything, including portals rendered outside your React root.
3. Set the CSS `color-scheme` property so **native UI** (scrollbars, form controls, date pickers, the default
   page background) matches. Forget it and you get a dark page with glaring white scrollbars and `<select>` menus:

```css
:root { color-scheme: light dark; }
[data-theme='light'] { color-scheme: light; }
[data-theme='dark'] { color-scheme: dark; }

@media (prefers-color-scheme: dark) {
  /* must repeat EVERY value from [data-theme='dark'] (or generate both blocks from one token source) */
  :root:not([data-theme]) {
    --surface: oklch(0.18 0 0);
    --fg: oklch(0.95 0 0);
    --primary: oklch(0.7 0.16 260);
    --on-primary: oklch(0.15 0 0);
  }
}
```

4. Avoid the **flash of the wrong theme** on load. Your React bundle is a `type="module"` script, and module
   scripts are *deferred*: the browser parses and paints the HTML first, then runs React. If the theme is applied
   in a `useEffect`, a dark-mode user sees a white page for a moment on every reload. The fix is a tiny
   **classic inline script in the `<head>` of `index.html`**. Classic scripts block parsing, so it runs before
   the body is painted:

```html
<head>
  <!-- … -->
  <script>
    try {
      const t = localStorage.getItem('theme')
      if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t
    } catch {}  /* storage can throw (privacy modes, sandboxed iframes): fall back to System */
  </script>
</head>
```

   Keep it small, synchronous and dependency-free — it runs on every page load before anything else. Vite leaves
   classic inline scripts in `index.html` untouched (only `type="module"` scripts are bundled). If your site sends
   a strict Content-Security-Policy, allow this one script with a hash or nonce.

5. Respect contrast: semantic tokens must pass **WCAG AA** (4.5:1 for body text) in *both* themes. Check them
   once, at the token level, instead of per component.

:::challenge id=fe-16-c4 lang=tsx xp=60 preview=ThemeSwitcher
title: Light / Dark / System switcher
Build `ThemeSwitcher` — a group of three buttons `Light`, `Dark`, `System`:

- Wrap them in `<div role="group" aria-label="Theme">`.
- The selected button has `aria-pressed="true"`, the others `"false"`. Start with `defaultTheme`
  (default `'system'`).
- Apply the choice to `document.documentElement` in an **effect**: `light`/`dark` set the
  `data-theme` attribute; `system` **removes** it (so the CSS media query takes over).
- Call the optional `onChange(theme)` prop when the user picks a theme.

hint: `useEffect(() => { const root = document.documentElement; theme === 'system' ? root.removeAttribute('data-theme') : root.setAttribute('data-theme', theme) }, [theme])`
hint: Render the buttons from an array: `(['light', 'dark', 'system'] as const).map(...)`.

```tsx starter
import { useEffect, useState } from 'react'

type Theme = 'light' | 'dark' | 'system'

export function ThemeSwitcher({ defaultTheme = 'system', onChange }: { defaultTheme?: Theme; onChange?: (t: Theme) => void }) {
  const [theme, setTheme] = useState<Theme>(defaultTheme)
  return (
    <div>
      <button onClick={() => setTheme('light')}>Light</button>
      <button onClick={() => setTheme('dark')}>Dark</button>
      <button onClick={() => setTheme('system')}>System</button>
    </div>
  )
}
```

```tsx solution
import { useEffect, useState } from 'react'

type Theme = 'light' | 'dark' | 'system'
const LABELS: Record<Theme, string> = { light: 'Light', dark: 'Dark', system: 'System' }

export function ThemeSwitcher({ defaultTheme = 'system', onChange }: { defaultTheme?: Theme; onChange?: (t: Theme) => void }) {
  const [theme, setTheme] = useState<Theme>(defaultTheme)

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
  }, [theme])

  return (
    <div role="group" aria-label="Theme">
      {(['light', 'dark', 'system'] as const).map((t) => (
        <button
          key={t}
          aria-pressed={theme === t}
          onClick={() => { setTheme(t); onChange?.(t) }}
        >
          {LABELS[t]}
        </button>
      ))}
    </div>
  )
}
```

```tsx tests
test('is a labelled group with System selected by default', () => {
  render(<ThemeSwitcher />)
  expect(screen.getByRole('group', { name: 'Theme' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'System' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'false')
  expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
})
test('dark and light set data-theme on <html>', async () => {
  render(<ThemeSwitcher />)
  await user.click(screen.getByRole('button', { name: 'Dark' }))
  expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
  expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('button', { name: 'System' })).toHaveAttribute('aria-pressed', 'false')
  await user.click(screen.getByRole('button', { name: 'Light' }))
  expect(document.documentElement).toHaveAttribute('data-theme', 'light')
})
test('system removes the attribute', async () => {
  render(<ThemeSwitcher defaultTheme="dark" />)
  expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
  await user.click(screen.getByRole('button', { name: 'System' }))
  expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
})
test('calls onChange', async () => {
  const onChange = fn()
  render(<ThemeSwitcher onChange={onChange} />)
  await user.click(screen.getByRole('button', { name: 'Light' }))
  expect(onChange).toHaveBeenCalledWith('light')
})
```
:::

:::quiz id=fe-16-q2 xp=15
Your team adds a "high contrast" theme. With which setup is that the **smallest** change? (Select all that apply.)
- [x] Components use semantic tokens (`bg-surface`, `text-fg`, `border-muted`); add a `[data-theme='contrast']` block that re-maps them
- [ ] Components use `bg-white dark:bg-gray-900`; add `contrast:` variants to every component
- [x] CSS Modules that reference `var(--color-surface)` etc.; add one CSS block overriding the variables
- [ ] A JS theme object in React Context that every component reads to build inline styles
> Semantic tokens in CSS variables make a theme a single block of overrides, regardless of whether components use
> Tailwind or CSS Modules. Per-component `dark:` classes and JS theme objects require touching every component
> (and the Context approach re-renders the whole tree on every theme change).
:::

:::quiz id=fe-16-q3 xp=10
A `Button` does `className={'px-4 ' + className}` and the caller passes `className="px-2"`. The padding stays at
`px-4`. Why, and what fixes it?
- [ ] Props can't contain class names; use `style`
- [x] Both classes apply and the winner is decided by order in the generated CSS, not in the attribute; use `cn()` with `tailwind-merge`
- [ ] `px-2` isn't a valid Tailwind class
- [ ] React ignores the second class with the same prefix
> The order of classes in the `class` attribute never matters — CSS specificity and source order of the *rules* do.
> Both utilities have the same specificity, so whichever rule Tailwind happened to emit later wins, regardless of
> what the caller meant. `tailwind-merge` removes the conflicting `px-4` so the caller's override wins. React
> doesn't inspect class names at all, and `style` would work but throws away the token scale.
:::

:::quiz id=fe-16-q4 xp=15
Spot the bug. Users with dark mode saved complain that every reload "flashes white" for a moment:

```tsx
function ThemeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const t = localStorage.getItem('theme')
    if (t) document.documentElement.dataset.theme = t
  }, [])
  return children
}
```

- [ ] `localStorage` is asynchronous, so the value arrives too late
- [x] The effect runs only after React has mounted and the browser has already painted the default (light) theme
- [ ] `dataset.theme` doesn't set the `data-theme` attribute
- [ ] The effect needs `[theme]` in its dependency array
> The HTML is painted before the deferred module bundle runs, and `useEffect` runs after React's first commit —
> so the first frames use the light tokens. Move this logic into a classic inline script in `<head>`, which runs
> before the body is painted. `localStorage` is synchronous, and `dataset.theme = 'dark'` does set
> `data-theme="dark"`; changing the dependency array can't make an effect run earlier than the first paint.
:::

:::quiz id=fe-16-q5 xp=15
Design wants the **danger** colour a bit lighter in dark mode only, for better contrast. Your tokens follow
primitive → semantic → component. What's the right change?
- [ ] Change `--red-600` (the primitive) to a lighter red
- [x] In the `[data-theme='dark']` block, re-point the semantic token: `--danger: var(--red-400)`
- [ ] Add `dark:text-red-400` to every component that shows an error
- [ ] Add a new `--danger-dark` token and an `isDark` prop to components
> Themes are exactly "a different mapping from semantic to primitive", so the change is one line in the dark
> block. Editing the primitive is tempting but wrong: `--red-600` would no longer be red-600, and it changes the
> light theme too (and everything else using that primitive). Per-component `dark:` classes or an `isDark` prop
> push theme knowledge back into every component — the problem tokens were meant to remove.
:::

## Lab: tokens + Tailwind v4 + themes

:::lab id=fe-16-lab1 xp=80
title: Set up a token-driven theme
You need a Vite + React + TypeScript app (`npm create vite@latest my-app -- --template react-ts` if you don't
have one).

1. In your Vite app: `npm install tailwindcss @tailwindcss/vite clsx tailwind-merge class-variance-authority`
   and add `tailwindcss()` to `vite.config.ts` plugins (exactly as shown earlier in this lesson), and put
   `@import "tailwindcss";` at the top of `src/index.css` (step 2 replaces the rest of that file).
   *Expected:* `npm run dev` starts without errors, and a test `<div className="bg-red-600 p-4">` shows a red box.
2. Replace `src/index.css` with: `@import "tailwindcss";`, a `:root` block with semantic variables (`--surface`,
   `--surface-raised`, `--fg`, `--fg-muted`, `--primary`, `--danger`, `--border`), a `[data-theme='dark']` block
   with dark values for the same names, the `@media (prefers-color-scheme: dark)` fallback for
   `:root:not([data-theme])`, an `@theme inline` block mapping each one to `--color-*`
   (`--color-surface: var(--surface);` …), and the `@custom-variant dark` rule from this lesson (the block
   version, since you offer a System option).
   *Expected:* `bg-surface`, `text-fg`, `border-border` now autocomplete in an editor with the Tailwind extension.
3. Add `--radius-card` and a font to a regular `@theme` block; use `rounded-card` and `font-sans` somewhere.
4. Create `src/shared/ui/cn.ts` with the `cn()` helper. *Expected:* `cn('px-4', 'px-2')` returns `'px-2'`.
5. Build `ThemeSwitcher` (from the challenge) and also write the choice to `localStorage` (`'light'`, `'dark'`,
   or remove the key for System). Add the inline `<head>` script to `index.html` so a reload in dark mode doesn't
   flash white.
6. Refactor two existing components to use **only** semantic utilities (`bg-surface`, `text-fg`, `border-border`).
   Search your components: `grep -rnE "#[0-9a-fA-F]{3,6}\b|bg-(white|black)" src --include=*.tsx`.
   *Expected:* no output (hex values belong in `index.css` only).
7. Check contrast of `--fg` on `--surface` and `--fg-muted` on `--surface` in both themes with the DevTools colour
   picker (or webaim.org/resources/contrastchecker): ≥ 4.5:1.

:::tip
In DevTools → Rendering you can emulate `prefers-color-scheme: dark` to test the **System** option without
changing your OS setting.
:::

- [ ] `bg-surface` / `text-fg` utilities exist and `cn('px-4', 'px-2')` returns `'px-2'`
- [ ] Switching themes restyles the page instantly and the React DevTools profiler shows no re-render of unrelated components
- [ ] **System** follows the emulated OS preference
- [ ] Reloading in dark mode shows no white flash
- [ ] No raw hex colours or `bg-white` in component files
- [ ] Body text passes 4.5:1 contrast in both themes
:::

## Recap

- **Design tokens** are named design decisions; use three tiers — primitive → semantic → component — and let
  components reference **semantic** tokens.
- **CSS custom properties** are the runtime for tokens: they cascade, inherit, and switch themes without React re-rendering.
- **Tailwind v4** is configured in CSS: `@import "tailwindcss"` + `@theme { --color-…; --radius-… }` generates
  utilities; `@theme inline` maps semantic variables so utilities resolve them on the element (and follow
  nested themes); `@custom-variant dark` ties `dark:` to your attribute.
- Tailwind only generates classes it can **see as complete strings** — never build class names dynamically.
- **CSS Modules** give locally scoped real CSS with zero runtime; they use the same tokens.
- `cn()` = `clsx` (conditional classes) + `tailwind-merge` (last conflicting class wins).
- **Variants** (cva) replace boolean soup with a typed table of options, defaults and compound rules.
- Themes: Light/Dark/System, `data-theme` on `<html>`, `color-scheme`, an inline script against flashes, AA contrast at the token level.

:::cards id=fe-16-cards1 xp=15 title="Styling & tokens"
Q: What is a design token?
A: A named design decision (colour, spacing, radius, font…) that code references by name instead of a raw value.
Q: Primitive vs semantic token?
A: Primitive = what it is (`blue-600`). Semantic = what it's for (`primary`, `surface`). Components use semantic ones; themes remap them.
Q: Where does Tailwind v4 configuration live?
A: In CSS — `@import "tailwindcss"` plus `@theme { … }` blocks; no `tailwind.config.js` needed.
Q: What does `@theme inline` do?
A: Makes utilities contain `var(--surface)` directly instead of `var(--color-surface)`, so the value is resolved on each element and follows nested or scoped themes, not just the one on `<html>`.
Q: Why does `` `bg-${color}-600` `` break?
A: Tailwind scans files for complete class names; a constructed string never appears, so no CSS is generated.
Q: What do `clsx` and `tailwind-merge` each do?
A: clsx builds a class string from conditionals/arrays/objects; tailwind-merge removes conflicting Tailwind classes so the last wins.
Q: How do you prevent a flash of the wrong theme?
A: A classic inline script in the `<head>` of `index.html` sets `data-theme` from storage before the first paint, before React loads.
Q: What does the CSS `color-scheme` property do?
A: Tells the browser which scheme native UI (scrollbars, form controls, default background) should use, so it matches your theme.
:::
