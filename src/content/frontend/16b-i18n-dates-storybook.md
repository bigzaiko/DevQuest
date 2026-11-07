---
id: fe-30
title: i18n, Dates & Storybook
level: intermediate
minutes: 95
xp: 150
summary: Format money, numbers, dates and plurals correctly for every locale with the built-in Intl APIs, survive time zones and DST, and document and test your UI kit in Storybook.
---

Three topics that look unrelated, but that all fail in the same way: **the code works on the developer's
machine and breaks for someone else.** A price renders as `$1234.5` for a German customer. A due date
shows "April 30" in New York when the invoice says May 1. A button looks fine in English and overflows in
German, and nobody noticed because nobody ever looked at it in German.

The fix for all three is the same habit: make the *other* cases visible and testable. `Intl` gives you
correct output for every locale without shipping data, a clear mental model of time stops the date bugs,
and Storybook gives you a place where every state of every component (long German text, Arabic RTL,
loading, disabled) can be seen and tested in isolation.

This lesson builds on **Styling, Design Tokens & Themes** (tokens, logical CSS) and **Component Forge I:
UI Primitives** (the `Button` you'll put into Storybook). **Rendering Strategies: CSR, SSR, SSG & Server
Components** covered the hydration mismatches caused by time zones; here we fix the date logic itself.

## Words first: i18n, l10n, locale

- **Internationalization (i18n)** is engineering: making the code *able* to support many languages and
  regions (no hard-coded strings, no hand-built date formats, layouts that survive RTL and long words).
- **Localization (l10n)** is content: actually providing German texts, Arabic texts, a Japanese date format.
- A **locale** is a [BCP 47](https://www.rfc-editor.org/info/bcp47) tag like `en-US`, `de-DE`, `de-AT`,
  `pt-BR`, `ar-EG`, `zh-Hant-TW`: language, optionally script and region. The **region matters**: `en-US`
  writes `3/14/2026`, `en-GB` writes `14/03/2026`; `de-DE` and `de-CH` group thousands differently.

The mental model that prevents most bugs: **data is locale-free; only the last step, rendering, is
localized.** Your API sends `123450` (cents), `"EUR"` and `"2026-03-14T15:09:00Z"`. The browser turns that
into `1.234,50 €` and `14.03.2026, 16:09` for a viewer in Berlin. Never store or send a formatted string,
and never parse one back.

## Intl: the formatting engine already in your browser

Every modern browser and Node ship the **ECMAScript Internationalization API** (`Intl`) with full CLDR data
(the Unicode Common Locale Data Repository, the same data Android, iOS and ICU use). You don't need a
library to format numbers, currencies, dates, lists or plurals, and you shouldn't write that logic by hand.

### Numbers, currency, units, compact

```ts
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
usd.format(1234.5)                                            // "$1,234.50"

new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(1234.5)  // "1.234,50 €"
new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' }).format(1234.5)  // "€1,234.50"
new Intl.NumberFormat('en-US', { style: 'currency', currency: 'JPY' }).format(1234)    // "¥1,234"   (no decimals!)
new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD',
  currencySign: 'accounting' }).format(-5)                    // "($5.00)"

new Intl.NumberFormat('en-US', { notation: 'compact' }).format(1234567)  // "1.2M"
new Intl.NumberFormat('de-DE', { notation: 'compact' }).format(1234567)  // "1,2 Mio."
new Intl.NumberFormat('en-US', { style: 'unit', unit: 'kilometer-per-hour' }).format(50)  // "50 km/h"
new Intl.NumberFormat('en-US', { style: 'unit', unit: 'megabyte', unitDisplay: 'narrow' }).format(1.5) // "1.5MB"
new Intl.NumberFormat('de-DE', { style: 'percent' }).format(0.256)       // "26 %"
```

Notice two separate inputs: the **locale** decides *how it looks* (separator, symbol position, spacing);
the **currency** is *data* that comes with the amount. A German user looking at a US-dollar invoice sees
`1.234,50 $`, not euros. Deriving the currency from the locale is a classic bug: the locale is a display
preference, the currency is a fact about the money.

`formatToParts()` gives you the pieces (`currency`, `integer`, `group`, `decimal`, `fraction`, …) when you
need to style them separately, e.g. a smaller font for the cents, without parsing strings.

:::warn title="The invisible spaces"
`Intl` output often contains **no-break spaces**: `1.234,50 €` has U+00A0 before the `€`, French uses
U+202F (narrow no-break space) as a thousands separator, and some ICU versions put U+202F before `AM`/`PM`.
They look like spaces and are not `' '`. So `expect(format(x)).toBe('1.234,50 €')` can fail even though it
looks identical, and it can fail on one Node version but not another. In tests, normalize first:
`s.replace(/[\u00a0\u202f]/g, ' ')` (type the escapes, not the invisible characters themselves, or an
editor or formatter may silently turn them into plain spaces). In UI code keep them: they stop the browser
from breaking `1.234,50` and `€` onto different lines.

Exact strings also depend on the CLDR data shipped with the runtime. Every expected string in this lesson
was checked on Node 22, 24 and 26 (ICU 78 / CLDR 48); a future CLDR release can still change a detail, so
pin tests to explicit locales and `timeZone: 'UTC'`, and assert only what your feature actually promises.
:::

### Money is an integer of minor units

```ts
0.1 + 0.2        // 0.30000000000000004
19.99 * 3        // 59.97 — lucky this time; sums of many prices are not
```

JavaScript numbers are binary floating point; most decimal fractions (0.1, 0.2, 19.99) can't be
represented exactly. A few rounding errors are invisible until the invoice total is off by a cent and
finance opens a ticket. The standard fix: **store and send money as an integer number of minor units**
(cents for EUR/USD) plus an ISO 4217 currency code, do arithmetic on integers, and divide only at the very
end for display. On the backend use C# `decimal` or PostgreSQL `numeric`/`bigint` (see the Database and
Backend regions); tax and discount calculations belong on the server, not in the browser.

"Minor units" is not always cents: **JPY has 0 decimals, KWD and BHD have 3.** `Intl` knows this:
`new Intl.NumberFormat('en', { style: 'currency', currency: 'JPY' }).resolvedOptions().maximumFractionDigits`
is `0`. In a real system the backend usually sends the exponent (or the API contract fixes it), because
CLDR's display digits and ISO 4217 disagree for a handful of currencies.

:::challenge id=fe-30-c1 lang=ts xp=40
title: Format money from minor units
Write `formatMoney(minor, currency, locale)`:

- `minor` is an **integer** amount in minor units (`123450` EUR = 1 234.50 €; `1234` JPY = ¥1,234).
  If it isn't an integer, `throw new RangeError('minor must be an integer')`.
- Use `new Intl.NumberFormat(locale, { style: 'currency', currency })` (no other options) and ask the
  formatter how many fraction digits the currency has (`resolvedOptions().maximumFractionDigits`) to
  convert minor → major units. Don't hard-code `/ 100`: the tests include JPY (0 digits) and KWD (3 digits).
- The currency always comes from the `currency` argument, never from the locale (`EUR` in `en-US` is `€1,234.50`).
- Return the formatted string. The tests normalize no-break spaces with `clean()` (from setup).

hint: `const nf = new Intl.NumberFormat(locale, { style: 'currency', currency })`
hint: `const digits = nf.resolvedOptions().maximumFractionDigits ?? 2` then `nf.format(minor / 10 ** digits)`.
hint: `Number.isInteger(minor)` rejects `12.5`, `NaN` and `Infinity` in one go.

```ts setup
// Intl uses no-break spaces (U+00A0 / U+202F) in some locales; tests compare normalized strings.
const clean = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ')
```

```ts starter
export function formatMoney(minor: number, currency: string, locale: string): string {
  return '$' + (minor / 100).toFixed(2)
}
```

```ts solution
export function formatMoney(minor: number, currency: string, locale: string): string {
  if (!Number.isInteger(minor)) throw new RangeError('minor must be an integer')
  const nf = new Intl.NumberFormat(locale, { style: 'currency', currency })
  const digits = nf.resolvedOptions().maximumFractionDigits ?? 2
  return nf.format(minor / 10 ** digits)
}
```

```ts tests
test('en-US dollars', () => {
  expect(clean(formatMoney(123450, 'USD', 'en-US'))).toBe('$1,234.50')
})
test('de-DE euros', () => {
  expect(clean(formatMoney(123450, 'EUR', 'de-DE'))).toBe('1.234,50 €')
})
test('currency is data, locale is presentation', () => {
  expect(clean(formatMoney(123450, 'EUR', 'en-US'))).toBe('€1,234.50')
})
test('yen has no minor unit', () => {
  expect(clean(formatMoney(1234, 'JPY', 'en-US'))).toBe('¥1,234')
})
test('dinar has three decimals', () => {
  expect(clean(formatMoney(1234567, 'KWD', 'en-US'))).toBe('KWD 1,234.567')
})
test('negative amounts', () => {
  expect(clean(formatMoney(-1250, 'USD', 'de-DE'))).toBe('-12,50 $')
})
test('zero', () => {
  expect(clean(formatMoney(0, 'USD', 'en-US'))).toBe('$0.00')
})
test('rejects non-integers', () => {
  expect(() => formatMoney(12.5, 'EUR', 'de-DE')).toThrow('integer')
})
```
:::

:::pro title="Create formatters once"
Constructing an `Intl.*` formatter parses options and loads locale data; calling `.format()` is cheap.
In a table with 2 000 prices, `new Intl.NumberFormat(...)` per cell is measurable. Cache formatters per
`locale + options` (a module-level `Map`) or `useMemo` them in the component, and reuse one instance.
:::

### Dates and times: DateTimeFormat

```ts
const when = new Date('2026-03-14T15:09:00Z')

new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(when)
// "Mar 14, 2026, 3:09 PM"
new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(when)
// "14.03.2026, 15:09"
new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/New_York' }).format(when)
// "Mar 14, 2026, 11:09 AM"
new Intl.DateTimeFormat('de-DE', { dateStyle: 'long', timeZone: 'UTC' }).format(when)
// "14. März 2026"

Intl.DateTimeFormat().resolvedOptions().timeZone   // the viewer's zone, e.g. "Europe/Berlin"
```

`dateStyle`/`timeStyle` (`'full' | 'long' | 'medium' | 'short'`) give you the locale's *idiomatic* format;
prefer them over building `day/month/year` by hand. You can use individual fields instead
(`{ weekday: 'short', day: 'numeric', month: 'long' }`), but not both at once: mixing `dateStyle` with
`timeZoneName` or `month` throws a `TypeError`.

If you leave out `timeZone`, the formatter uses the zone of the machine it runs on. That's correct in the
browser (the viewer's zone) and wrong on a server, which is usually UTC. **Always pass `timeZone` when the
code can run on a server**, in tests, or when the user picked a zone in their profile.

### Relative time, plural rules, lists and sorting

```ts
const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
rtf.format(-1, 'day')      // "yesterday"   (numeric: 'always' would say "1 day ago")
rtf.format(-3, 'hour')     // "3 hours ago"
rtf.format(2, 'week')      // "in 2 weeks"
new Intl.RelativeTimeFormat('de', { numeric: 'auto' }).format(2, 'day')   // "übermorgen"

new Intl.PluralRules('en').select(1)     // "one"
new Intl.PluralRules('en').select(0)     // "other"
new Intl.PluralRules('fr').select(0)     // "one"   — French treats 0 as singular
new Intl.PluralRules('ru').select(3)     // "few"
new Intl.PluralRules('ru').select(5)     // "many"
new Intl.PluralRules('ru').select(21)    // "one"
new Intl.PluralRules('en', { type: 'ordinal' }).select(22)   // "two"  → "22nd"

new Intl.ListFormat('en', { type: 'conjunction' }).format(['Ada', 'Linus', 'Grace'])  // "Ada, Linus, and Grace"
new Intl.ListFormat('de', { type: 'conjunction' }).format(['Ada', 'Linus', 'Grace'])  // "Ada, Linus und Grace"
new Intl.ListFormat('en', { type: 'disjunction' }).format(['PDF', 'CSV'])             // "PDF or CSV"

['b', 'a', 'Z'].sort()                                       // ["Z", "a", "b"]  — UTF-16 code units, not language
['b', 'a', 'Z'].sort(new Intl.Collator('en').compare)        // ["a", "b", "Z"]
['ä', 'a', 'z'].sort(new Intl.Collator('de').compare)        // ["a", "ä", "z"]
['ä', 'a', 'z'].sort(new Intl.Collator('sv').compare)        // ["a", "z", "ä"]  — Swedish puts ä after z
['item10', 'item2'].sort(new Intl.Collator('en', { numeric: true }).compare)  // ["item2", "item10"]
```

**Plural rules** are the one people underestimate. English has two forms (`one`, `other`). Russian,
Polish and Czech have three or four, Arabic has six (`zero`, `one`, `two`, `few`, `many`, `other`),
Japanese and Chinese have one. `count === 1 ? 'item' : 'items'` is an English rule hard-coded into your
app. `PluralRules` returns the CLDR **category** for a number; your translation provides one string per
category the language uses.

**Collator** sorts and compares strings the way humans in that language expect. Use it for every
user-visible sort (customer names, tags), with `sensitivity: 'base'` when "ä", "A" and "a" should
compare equal (search, de-duplication). As with formatters, create one and reuse its `compare`.

:::challenge id=fe-30-c2 lang=ts xp=40
title: Event times and calendar dates
Two functions for an events page:

1. `formatEventTime(iso, locale, timeZone)`: `iso` is a UTC instant like `"2026-03-14T15:09:00Z"`. Return it
   formatted with `dateStyle: 'medium'` and `timeStyle: 'short'` **in the given time zone**.
2. `formatDay(isoDate, locale, viewerTimeZone)`: `isoDate` is a **calendar date** like `"2026-05-01"` (a
   birthday, an invoice due date). It must show **that** day for every viewer, whatever their time zone,
   with `dateStyle: 'long'`. The viewer's zone is passed in because the rest of the page uses it; don't
   let it shift the date.

Use only the options named here (no extra fields), so the output is the locale's standard
`medium`/`short` or `long` pattern, e.g. `"Mar 14, 2026, 3:09 PM"` (en-US, UTC) or `"1. Mai 2026"` (de-DE).
The tests normalize no-break spaces with `clean()` (from setup).

hint: `new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(iso))`
hint: `new Date('2026-05-01')` is **midnight UTC**. In Los Angeles that instant is still April 30.
hint: A calendar date has no zone. Format the UTC-midnight instant *in UTC* (`timeZone: 'UTC'`) and ignore the viewer zone.

```ts setup
const clean = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ')
```

```ts starter
export function formatEventTime(iso: string, locale: string, timeZone: string): string {
  return new Date(iso).toISOString()
}

export function formatDay(isoDate: string, locale: string, viewerTimeZone: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: viewerTimeZone }).format(new Date(isoDate))
}
```

```ts solution
export function formatEventTime(iso: string, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(iso))
}

export function formatDay(isoDate: string, locale: string, viewerTimeZone: string): string {
  // A calendar date is not an instant: viewerTimeZone is deliberately unused.
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(isoDate))
}
```

```ts tests
test('en-US in UTC', () => {
  expect(clean(formatEventTime('2026-03-14T15:09:00Z', 'en-US', 'UTC'))).toBe('Mar 14, 2026, 3:09 PM')
})
test('de-DE in UTC', () => {
  expect(clean(formatEventTime('2026-03-14T15:09:00Z', 'de-DE', 'UTC'))).toBe('14.03.2026, 15:09')
})
test('same instant in New York (EDT, UTC-4)', () => {
  expect(clean(formatEventTime('2026-03-14T15:09:00Z', 'en-US', 'America/New_York'))).toBe('Mar 14, 2026, 11:09 AM')
})
test('New Year in Berlin starts before New Year in UTC', () => {
  expect(clean(formatEventTime('2026-12-31T23:30:00Z', 'de-DE', 'Europe/Berlin'))).toBe('01.01.2027, 00:30')
})
test('en-GB', () => {
  expect(clean(formatEventTime('2026-03-14T15:09:00Z', 'en-GB', 'UTC'))).toBe('14 Mar 2026, 15:09')
})
test('calendar date does not shift in Los Angeles', () => {
  expect(clean(formatDay('2026-05-01', 'en-US', 'America/Los_Angeles'))).toBe('May 1, 2026')
})
test('calendar date in German, viewer in Tokyo', () => {
  expect(clean(formatDay('2026-05-01', 'de-DE', 'Asia/Tokyo'))).toBe('1. Mai 2026')
})
```
:::

:::challenge id=fe-30-c3 lang=ts xp=50
title: "3 hours ago" in any language
Write `timeAgo(then, now, locale)` using `Intl.RelativeTimeFormat(locale, { numeric: 'auto' })`.

- `diff` = `then - now` in **seconds** (negative = past, positive = future).
- Pick the **largest** unit whose size is `<= |diff|`, from: year (365 days), month (30 days), week (7 days),
  day, hour, minute; otherwise second.
- The value is `Math.trunc(diff / unitSize)` (90 minutes ago → "1 hour ago", not 2).

Examples (en): 0 s → `"now"`, −59 s → `"59 seconds ago"`, −1 day → `"yesterday"`, +2 h → `"in 2 hours"`,
−10 days → `"last week"`.

hint: A table `[['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]` and a loop.
hint: `const diff = (then.getTime() - now.getTime()) / 1000`
hint: Fall back to `rtf.format(Math.trunc(diff), 'second')` after the loop.

```ts starter
export function timeAgo(then: Date, now: Date, locale: string): string {
  const minutes = Math.round((now.getTime() - then.getTime()) / 60000)
  return `${minutes} minutes ago`
}
```

```ts solution
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31536000],
  ['month', 2592000],
  ['week', 604800],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
]

export function timeAgo(then: Date, now: Date, locale: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const diff = (then.getTime() - now.getTime()) / 1000
  for (const [unit, size] of UNITS) {
    if (Math.abs(diff) >= size) return rtf.format(Math.trunc(diff / size), unit)
  }
  return rtf.format(Math.trunc(diff), 'second')
}
```

```ts tests
const NOW = new Date('2026-03-14T12:00:00Z')
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000)
const ahead = (seconds: number) => new Date(NOW.getTime() + seconds * 1000)

test('same moment is "now"', () => {
  expect(timeAgo(NOW, NOW, 'en')).toBe('now')
})
test('seconds', () => {
  expect(timeAgo(ago(59), NOW, 'en')).toBe('59 seconds ago')
})
test('minutes', () => {
  expect(timeAgo(ago(5 * 60), NOW, 'en')).toBe('5 minutes ago')
})
test('truncates instead of rounding', () => {
  expect(timeAgo(ago(90 * 60), NOW, 'en')).toBe('1 hour ago')
})
test('yesterday', () => {
  expect(timeAgo(ago(86400), NOW, 'en')).toBe('yesterday')
})
test('future', () => {
  expect(timeAgo(ahead(2 * 3600), NOW, 'en')).toBe('in 2 hours')
})
test('weeks, months, years', () => {
  expect(timeAgo(ago(10 * 86400), NOW, 'en')).toBe('last week')
  expect(timeAgo(ago(65 * 86400), NOW, 'en')).toBe('2 months ago')
  expect(timeAgo(ago(800 * 86400), NOW, 'en')).toBe('2 years ago')
})
test('German', () => {
  expect(timeAgo(ago(3 * 3600), NOW, 'de')).toBe('vor 3 Stunden')
  expect(timeAgo(ago(86400), NOW, 'de')).toBe('gestern')
})
```
:::

:::quiz id=fe-30-q1 xp=10
A product costs `19.99` and the cart computes totals with `price * qty` and `+` on JavaScript numbers.
What is the most robust fix?
- [ ] Round every result with `toFixed(2)` before showing it
- [x] Send prices as integer minor units (`1999`) plus a currency code, compute on integers, format only for display
- [ ] Use `parseFloat(total.toPrecision(15))` after every operation
- [ ] Store the formatted string (`"19,99 €"`) so the value never changes
> Integers are exact in JavaScript up to 2^53, so `1999 * 3` is exactly `5997` and sums never drift; you
> divide by `10 ** digits` only when formatting. `toFixed(2)` is tempting but only hides the error at the
> end: intermediate sums keep drifting and `toFixed` itself rounds binary values unexpectedly
> (`(1.005).toFixed(2)` is `"1.00"`). A formatted string is presentation; you can't add it up and it's
> wrong for a viewer in another locale.
:::

## Messages and pluralization

Formatting numbers is half the job. The other half is **sentences**, and sentences are where
hand-written code breaks:

```tsx
// Every line here is an i18n bug
<p>You have {count} {count === 1 ? 'item' : 'items'} in your cart</p>   // English plural rule hard-coded
<p>{'Hello, ' + name + '!'}</p>                                         // word order fixed by concatenation
<p>{t('deleted')} {fileName} {t('by')} {user}</p>                       // translator can't reorder the pieces
```

Translators need **whole messages with placeholders**, because word order changes between languages
(German puts verbs at the end, Japanese puts the object before the verb). The industry standard is
**ICU MessageFormat**:

```text
{count, plural,
  =0    {Your cart is empty}
  one   {You have # item}
  other {You have # items}
}

{gender, select, female {She replied} male {He replied} other {They replied}}

Deleted {fileName} by {user} on {date, date, medium}
```

- `plural` picks a branch by the `Intl.PluralRules` category; `=0` is an **exact match** tried first.
- `#` is the count, formatted with the locale's number format (`1,000` / `1.000`).
- `select` picks a branch by a string (grammatical gender, user role, …).
- A Russian translator writes `one`, `few`, `many`, `other` branches for the same key; your code doesn't change.

The libraries you'll meet:

| Library | Message format | Notes |
|---|---|---|
| **react-intl** (FormatJS) | ICU natively | `<FormattedMessage>`, `useIntl().formatNumber/formatDate`; thin layer over `Intl` |
| **i18next** + react-i18next | Own JSON format; ICU via `i18next-icu` | Most popular; plurals as `item_one` / `item_other` keys picked with `Intl.PluralRules`; namespaces, lazy loading, many backends |
| **Lingui** | ICU, compiled at build time | Macros like `` t`Hello ${name}` ``, extracts messages from source automatically |

```tsx
// react-intl
<FormattedMessage
  id="cart.summary"
  defaultMessage="{count, plural, =0 {Your cart is empty} one {You have # item} other {You have # items}}"
  values={{ count }}
/>

// i18next: en/translation.json → { "cart_one": "You have {{count}} item", "cart_other": "You have {{count}} items" }
const { t } = useTranslation()
t('cart', { count })
```

Under the hood they all do what you'll implement now: pick the plural category, then substitute
locale-formatted values.

:::challenge id=fe-30-c4 lang=ts xp=50
title: A plural-aware message function
Write `formatPlural(locale, count, forms)` where `forms` maps plural branches to strings:

```ts
formatPlural('en', 0, { '=0': 'Your cart is empty', one: '# item', other: '# items' })  // "Your cart is empty"
formatPlural('en', 1000, { one: '# item', other: '# items' })                           // "1,000 items"
formatPlural('ru', 3, { one: '# файл', few: '# файла', many: '# файлов', other: '# файла' }) // "3 файла"
```

Rules, in order:

1. An exact key `=<count>` (like `'=0'`) wins if present.
2. Otherwise use the category from `new Intl.PluralRules(locale).select(count)`.
3. If the translation lacks that category, fall back to `other`.
4. Replace **every** `#` with `count` formatted by `new Intl.NumberFormat(locale)`.

hint: Look up the exact key first (build it with a template literal: `'=' + count`), then `forms[new Intl.PluralRules(locale).select(count)]`, then `forms.other`, chained with `??`.
hint: `form.replaceAll('#', new Intl.NumberFormat(locale).format(count))`

```ts setup
const clean = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ')
type PluralForms = Partial<Record<Intl.LDMLPluralRule | `=${number}`, string>> & { other: string }
```

```ts starter
export function formatPlural(locale: string, count: number, forms: PluralForms): string {
  const form = count === 1 ? forms.one ?? forms.other : forms.other
  return form.replace('#', String(count))
}
```

```ts solution
export function formatPlural(locale: string, count: number, forms: PluralForms): string {
  const exact = forms[`=${count}` as `=${number}`]
  const category = new Intl.PluralRules(locale).select(count)
  const form = exact ?? forms[category] ?? forms.other
  return form.replaceAll('#', new Intl.NumberFormat(locale).format(count))
}
```

```ts tests
const cart = { '=0': 'Your cart is empty', one: 'You have # item', other: 'You have # items' } as PluralForms
const files = { one: '# файл', few: '# файла', many: '# файлов', other: '# файла' } as PluralForms

test('English one / other', () => {
  expect(formatPlural('en', 1, cart)).toBe('You have 1 item')
  expect(formatPlural('en', 2, cart)).toBe('You have 2 items')
})
test('exact match wins', () => {
  expect(formatPlural('en', 0, cart)).toBe('Your cart is empty')
})
test('count is locale-formatted', () => {
  expect(formatPlural('en', 1000, cart)).toBe('You have 1,000 items')
  expect(formatPlural('de', 1000, { one: '# Datei', other: '# Dateien' })).toBe('1.000 Dateien')
})
test('Russian one / few / many', () => {
  expect(formatPlural('ru', 1, files)).toBe('1 файл')
  expect(formatPlural('ru', 3, files)).toBe('3 файла')
  expect(formatPlural('ru', 5, files)).toBe('5 файлов')
  expect(formatPlural('ru', 21, files)).toBe('21 файл')
})
test('French treats 0 as singular', () => {
  expect(formatPlural('fr', 0, { one: '# fichier', other: '# fichiers' })).toBe('0 fichier')
})
test('missing category falls back to other', () => {
  expect(formatPlural('pl', 5, { one: '# plik', other: '# plików' })).toBe('5 plików')
})
test('replaces every #', () => {
  expect(clean(formatPlural('en', 2, { other: '# of # selected' }))).toBe('2 of 2 selected')
})
```
:::

:::quiz id=fe-30-q2 xp=10
Your Polish translator reports that "5 plików" shows as "5 pliki". The code is
`count === 1 ? t('file_one') : t('file_few')`. What's the real fix?
- [ ] Add a third branch: `count >= 5 ? t('file_many') : …`
- [x] Let the plural category come from `Intl.PluralRules('pl')` (or an ICU/i18next plural message) and give the translator one string per category
- [ ] Ask the translator to rephrase so the noun doesn't change
- [ ] Use English plurals for all languages and translate only the noun
> Plural rules are data in CLDR, not logic for you to rewrite per language. Polish uses `few` for 2–4,
> 22–24, 32–34… but `many` for 5–21, 25–31… so "`count >= 5`" breaks again at 22. Asking for rephrasing
> produces stilted text and doesn't scale to 40 languages. With `PluralRules` (which ICU messages and
> i18next use internally) the translator fills `one/few/many/other` and the code never changes.
:::

## Locale negotiation: which language does this user get?

The browser tells you what the user's system prefers; your app decides what it can offer.

1. **An explicit choice** the user made in your app (language picker, saved in their profile or a cookie)
   always wins.
2. Otherwise the **URL**, if you have localized routes (`/de/pricing`), which also lets search engines index
   each language.
3. Otherwise the **browser preference**: `navigator.languages` on the client (`['de-AT', 'de', 'en-US']`),
   the `Accept-Language` header on the server. Match it against your **supported** locales with fallback:
   `de-AT` → `de-DE`? → `de` → your default.
4. Otherwise your default locale.

Don't guess language from IP geolocation: a Turkish engineer in Berlin, a tourist, a VPN user all get the
wrong language. Region (for prices, tax) and language are separate decisions.

```ts
const SUPPORTED = ['en-US', 'de-DE', 'ar-EG'] as const

export function pickLocale(requested: readonly string[], fallback = 'en-US'): string {
  for (const tag of requested) {
    if ((SUPPORTED as readonly string[]).includes(tag)) return tag                           // exact
    const lang = new Intl.Locale(tag).language
    const sameLanguage = SUPPORTED.find((s) => new Intl.Locale(s).language === lang)          // de-AT → de-DE
    if (sameLanguage) return sameLanguage
  }
  return fallback
}

pickLocale(navigator.languages)   // e.g. "de-DE" for ['de-AT', 'en']
```

Two failure modes to know: `new Intl.Locale('*')` (a valid `Accept-Language` entry) and other junk
tags throw a `RangeError`, so on the server parse defensively and skip invalid entries; and
`Accept-Language` carries quality weights (`de-AT,de;q=0.9,en;q=0.5`) that you must sort by before matching.

In production, use `@formatjs/intl-localematcher` (implements the spec's lookup/best-fit algorithm) or
your i18n library's detector. On an ASP.NET Core backend the equivalent is `UseRequestLocalization`, which
reads query string, cookie and `Accept-Language` in that order. Whatever you pick, set
`<html lang="de-DE">`: screen readers choose their pronunciation from it, and browsers use it for
hyphenation and spell-checking.

### Right-to-left basics

Arabic, Hebrew, Persian and Urdu are written **right to left**. Setting `<html dir="rtl">` makes the browser
mirror text alignment, flex/grid direction and scrollbars. What it can't mirror is CSS you wrote with
physical directions:

```css
/* LTR-only: wrong side in Arabic */
.card-icon { margin-right: 0.5rem; }
.toast     { left: 1rem; text-align: left; }

/* Logical properties: follow the writing direction automatically */
.card-icon { margin-inline-end: 0.5rem; }
.toast     { inset-inline-start: 1rem; text-align: start; }
```

Tailwind has logical utilities (`ms-2`, `me-2`, `ps-4`, `start-0`, `text-start`) and `rtl:`/`ltr:` variants for
the few things that must differ (e.g. `rtl:rotate-180` on a "next" arrow icon). Icons that show
*direction* (arrows, "back", progress) should flip; icons that show *objects* (a clock, a checkmark, a play
button) should not. For user-generated text inside a sentence (names, file names), wrap it in `<bdi>` so a
Hebrew user name doesn't scramble the punctuation around it.

:::quiz id=fe-30-q3 xp=10
A tooltip is positioned with `left: 100%; margin-left: 8px`. After you add Arabic with `<html dir="rtl">`,
it appears on the wrong side. Best fix?
- [ ] Add `[dir='rtl'] .tooltip { left: auto; right: 100%; margin-left: 0; margin-right: 8px }`
- [x] Use logical properties: `inset-inline-start: 100%; margin-inline-start: 8px`
- [ ] Set `direction: ltr` on the tooltip so it always behaves the same
- [ ] Detect Arabic in JavaScript and swap the class
> Logical properties are defined relative to the writing direction, so one rule is correct in both LTR
> and RTL, and nobody has to remember the override. The `[dir='rtl']` override works but doubles every
> rule and is forgotten for the next component. Forcing `direction: ltr` breaks the Arabic text inside the
> tooltip, and JavaScript detection is slower and duplicates what CSS already does.
:::

## Dates and time zones without tears

Most date bugs come from treating three different things as one. Before writing any date code, ask
**which of these is it?**

| Kind | Example | Store as | Display |
|---|---|---|---|
| **Instant**: a moment that happened or will happen everywhere at once | order placed, message sent, token expiry | UTC: `timestamptz` in Postgres, `DateTimeOffset`/`DateTime` UTC in C#, ISO string with `Z` in JSON | In the **viewer's** zone |
| **Local event**: a wall-clock time in a specific place | dentist at 09:00 in Berlin next June, a weekly stand-up | Local date-time **plus IANA zone** (`2027-06-10T09:00` + `Europe/Berlin`) | In the event's zone (and optionally the viewer's) |
| **Calendar date**: a day, not a moment | birthday, invoice due date, holiday | `date` / `DateOnly` / `"2026-05-01"` | As is, never converted |

**Store instants in UTC, display in the user's zone** is the rule you'll hear, and it is right for the first
row. For future local events it is subtly wrong: if a government changes its DST rules (it happens several
times a year somewhere), a stored UTC instant now points at 10:00 instead of the agreed 09:00. Store what
the human agreed on: wall time + zone, and compute the instant when needed.

Some pitfalls in the `Date` object itself:

```ts
new Date('2026-05-01')          // date-only ISO string → parsed as UTC midnight
new Date('2026-05-01T00:00')    // date-time without Z → parsed as LOCAL midnight
new Date(2026, 4, 1)            // months are 0-based: 4 = May
date.getHours()                 // in the machine's zone; getUTCHours() for UTC
```

`"UTC+1"` is an **offset**, not a time zone. `Europe/Berlin` is UTC+1 in winter and UTC+2 in summer; the
**IANA zone id** carries the rules, so store and send ids, never offsets, for anything that must follow
local time.

### DST: the two days a year your tests should cover

In the EU, clocks jump from 02:00 to 03:00 on the last Sunday of March (29 March 2026) and back from 03:00
to 02:00 on the last Sunday of October (25 October 2026). The US switches on different dates (8 March and
1 November 2026), so for about four weeks a year (three in March, one around the end of October) the
New York–Berlin difference is 5 hours instead of 6. A meeting invite computed with a fixed "+6 h" is wrong
for exactly those weeks.

- **Adding 24 hours is not adding a day.** Saturday 28 March 2026 12:00 Berlin + `24 * 3600 * 1000` ms is
  Sunday **13:00**. "Same time tomorrow" needs calendar arithmetic in the zone.
- **Some local times don't exist** (29 March 2026, 02:30 Berlin) and **some exist twice** (25 October 2026,
  02:30 Berlin). A scheduler that runs "every night at 02:30 local" skips one night and runs twice on
  another. Schedule jobs in UTC, or pick a time outside 01:00–03:00.
- **"Days between two dates"** computed as `ms / 86400000` is off by an hour across DST; round, or better,
  compute on calendar dates.

### Temporal and date libraries

`Date` was copied from Java 1.0 in 1995 and has every problem above. **Temporal** is its replacement, built
into the language, with separate types for each kind in the table: `Temporal.Instant`,
`Temporal.ZonedDateTime` (instant + zone, DST-aware arithmetic), `Temporal.PlainDate`,
`Temporal.PlainDateTime`, `Temporal.Duration`.

```ts
const meeting = Temporal.ZonedDateTime.from('2026-03-28T12:00[Europe/Berlin]')
meeting.add({ days: 1 }).toString()    // "2026-03-29T12:00:00+02:00[Europe/Berlin]"  — same wall time, DST handled
meeting.add({ hours: 24 }).toString()  // "2026-03-29T13:00:00+02:00[Europe/Berlin]"  — 24 real hours
Temporal.PlainDate.from('2026-05-01').toLocaleString('en-US', { dateStyle: 'long' })   // "May 1, 2026", no zone involved
```

:::warn title="Temporal support moves fast"
Temporal is a finished TC39 proposal shipped in Firefox (139+) and Chrome/Edge (144+). In Node it is
available by default in Node 26 (the output above was checked there) and is **missing in Node 22 and 24**
(`typeof Temporal === 'undefined'`). Safari support was still rolling out at the time of writing. Check
[caniuse.com/temporal](https://caniuse.com/temporal) and the
[MDN Temporal page](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Temporal)
against your support matrix, and feature-detect plus load a polyfill (`temporal-polyfill`,
`@js-temporal/polyfill`) where it's missing. In TypeScript you may also need a recent `lib` setting
(`esnext`) or the polyfill's types.
:::

Until your support matrix allows Temporal everywhere, you'll meet these libraries in existing codebases:

| Library | Style | Time zones |
|---|---|---|
| **date-fns** (v4) | Small pure functions on `Date` (`addDays`, `format`, `differenceInCalendarDays`), tree-shakeable | Via `@date-fns/tz` (`TZDate`) |
| **Day.js** | Tiny Moment-like chainable API | Via `utc` + `timezone` plugins |
| **Luxon** | Immutable `DateTime` with zones built in (on top of `Intl`), from a Moment maintainer | Built in |
| Moment.js | The old standard | Maintenance mode; don't add it to new code |

Whichever you use, the rule is the same: the library does **arithmetic and parsing**; the final
human-readable string should still come from `Intl` (directly or via the library) with the user's locale.

:::quiz id=fe-30-q4 xp=10
A user in New York (`America/New_York`) opens an invoice whose API field is `"dueDate": "2026-05-01"`.
The UI does `new Date(dueDate).toLocaleDateString('en-US')`. What do they see, and why?
- [ ] `5/1/2026`: `Date` keeps the date as written
- [x] `4/30/2026`: a date-only ISO string is parsed as UTC midnight, which is still April 30 in New York
- [ ] `5/1/2026` in New York but `4/30/2026` in Berlin
- [ ] An `Invalid Date` error, because there's no time part
> The spec parses date-only ISO strings (`YYYY-MM-DD`) as **UTC**, and `toLocaleDateString` formats in the
> machine's zone; UTC midnight is 20:00 the previous day in New York (EDT, UTC-4). Berlin is *ahead* of UTC,
> so users there see the correct day, which is exactly why this bug survives testing in Europe. Treat
> calendar dates as dates: format with `timeZone: 'UTC'`, use `Temporal.PlainDate`, or keep them as strings.
:::

:::quiz id=fe-30-q5 xp=15
Which should be stored as a UTC instant? (Select all that apply.)
- [x] When an order was placed
- [x] When a password-reset token expires
- [ ] A user's date of birth
- [ ] A recurring team meeting "every Monday at 09:30 Berlin time"
- [x] When a chat message was sent
> Things that *happened* (or will happen) at one moment for everyone are instants: store UTC, show in
> the viewer's zone. A birth date is a calendar date; converting it to an instant makes it shift by a day
> for some viewers. A recurring local meeting must stay at 09:30 across DST, so store the wall time plus
> `Europe/Berlin` and compute each occurrence; a stored UTC instant would drift by an hour twice a year.
:::

:::job title="What you'll find on day one"
A typical product has `locales/en.json`, `locales/de.json` (often managed in a translation platform like
Crowdin, Lokalise or Phrase and synced by CI), a CLI step that extracts message ids from code, and a lint
rule against string literals in JSX. Expect code review comments like "no concatenated strings", "pass
`timeZone`", "this should be `toLocaleString` with the user's locale, not `toFixed(2)`". On the backend,
dates arrive as ISO 8601 with `Z` and money as integer minor units; if your API returns `"19,99 €"`, raise it.
:::

:::pro title="Pseudo-localization"
Before any translator is involved, switch the app to a fake locale that transforms every message, for
example `Save changes` → `[!! Šåvéé çĥåñĝéš !!]`: accents prove the font has the glyphs, the padding
simulates German (often 30 % longer than English), and the brackets reveal truncation. Any plain English
string left on screen is a hard-coded string. FormatJS and Lingui support pseudo-locales out of the box.
:::

## A localized component

In React, the locale is **app-wide state that rarely changes**: a perfect fit for Context (see
**Context & useReducer**). Components read it and format with `Intl`; they never receive pre-formatted
strings.

:::challenge id=fe-30-c5 lang=tsx xp=60 preview=Shop
title: Localized prices with a language switcher
Finish the shop:

- `PriceTag({ minor, currency })` reads the locale from `LocaleContext` (default `'en-US'`) and renders a
  `<span className="price">` with the amount formatted by `Intl.NumberFormat` (`style: 'currency'`). Convert
  minor units with the currency's `maximumFractionDigits` (JPY has 0). Memoize the formatter.
- `Shop` keeps the current locale in state (start with `'en-US'`), provides it with
  `<LocaleContext value={locale}>`, and renders one button per entry in `LOCALES` with `aria-pressed`
  showing the active one and `lang` set to that locale (language names are written in their own language).
- The wrapper `div` (`data-testid="shop"`) gets `lang={locale}` and `dir="rtl"` for right-to-left
  languages (`RTL_LANGUAGES` contains the language part, e.g. `ar` from `ar-EG`), `"ltr"` otherwise.

hint: `const locale = useContext(LocaleContext)` and `useMemo(() => new Intl.NumberFormat(locale, { style: 'currency', currency }), [locale, currency])`
hint: `new Intl.Locale('ar-EG').language` is `'ar'`.
hint: React 19 lets you render the context itself as a provider: `<LocaleContext value={locale}>…</LocaleContext>`.

```tsx starter
import { createContext, useContext, useMemo, useState } from 'react'

export const LocaleContext = createContext('en-US')
const RTL_LANGUAGES = ['ar', 'he', 'fa', 'ur']
const LOCALES = [
  { tag: 'en-US', label: 'English' },
  { tag: 'de-DE', label: 'Deutsch' },
  { tag: 'ar-EG', label: 'العربية' },
]
const PRODUCTS = [
  { id: 1, name: 'Keyboard', minor: 12999, currency: 'EUR' },
  { id: 2, name: 'Mouse', minor: 4950, currency: 'USD' },
  { id: 3, name: 'Cable', minor: 1500, currency: 'JPY' },
]

export function PriceTag({ minor, currency }: { minor: number; currency: string }) {
  return <span className="price">${(minor / 100).toFixed(2)}</span>
}

export function Shop() {
  return (
    <div data-testid="shop">
      <div role="group" aria-label="Language">
        {LOCALES.map((l) => (
          <button key={l.tag}>{l.label}</button>
        ))}
      </div>
      <ul>
        {PRODUCTS.map((p) => (
          <li key={p.id}>
            {p.name}: <PriceTag minor={p.minor} currency={p.currency} />
          </li>
        ))}
      </ul>
    </div>
  )
}
```

```tsx solution
import { createContext, useContext, useMemo, useState } from 'react'

export const LocaleContext = createContext('en-US')
const RTL_LANGUAGES = ['ar', 'he', 'fa', 'ur']
const LOCALES = [
  { tag: 'en-US', label: 'English' },
  { tag: 'de-DE', label: 'Deutsch' },
  { tag: 'ar-EG', label: 'العربية' },
]
const PRODUCTS = [
  { id: 1, name: 'Keyboard', minor: 12999, currency: 'EUR' },
  { id: 2, name: 'Mouse', minor: 4950, currency: 'USD' },
  { id: 3, name: 'Cable', minor: 1500, currency: 'JPY' },
]

export function PriceTag({ minor, currency }: { minor: number; currency: string }) {
  const locale = useContext(LocaleContext)
  const nf = useMemo(() => new Intl.NumberFormat(locale, { style: 'currency', currency }), [locale, currency])
  const digits = nf.resolvedOptions().maximumFractionDigits ?? 2
  return <span className="price">{nf.format(minor / 10 ** digits)}</span>
}

export function Shop() {
  const [locale, setLocale] = useState('en-US')
  const dir = RTL_LANGUAGES.includes(new Intl.Locale(locale).language) ? 'rtl' : 'ltr'
  return (
    <LocaleContext value={locale}>
      <div data-testid="shop" lang={locale} dir={dir}>
        <div role="group" aria-label="Language">
          {LOCALES.map((l) => (
            <button key={l.tag} lang={l.tag} aria-pressed={l.tag === locale} onClick={() => setLocale(l.tag)}>
              {l.label}
            </button>
          ))}
        </div>
        <ul>
          {PRODUCTS.map((p) => (
            <li key={p.id}>
              {p.name}: <PriceTag minor={p.minor} currency={p.currency} />
            </li>
          ))}
        </ul>
      </div>
    </LocaleContext>
  )
}
```

```tsx tests
const norm = (s: string | null | undefined) => (s ?? '').replace(/[\u00a0\u202f]/g, ' ')
const prices = (c: HTMLElement) => Array.from(c.querySelectorAll('.price')).map((p) => norm(p.textContent))

test('PriceTag defaults to en-US', () => {
  const { container } = render(<PriceTag minor={123450} currency="USD" />)
  expect(prices(container)).toEqual(['$1,234.50'])
})
test('PriceTag reads the locale from context', () => {
  const { container } = render(
    <LocaleContext value="de-DE">
      <PriceTag minor={123450} currency="EUR" />
    </LocaleContext>
  )
  expect(prices(container)).toEqual(['1.234,50 €'])
})
test('PriceTag respects zero-decimal currencies', () => {
  const { container } = render(<PriceTag minor={1500} currency="JPY" />)
  expect(prices(container)).toEqual(['¥1,500'])
})
test('Shop starts in English, left to right', () => {
  const { container } = render(<Shop />)
  expect(prices(container)).toEqual(['€129.99', '$49.50', '¥1,500'])
  const shop = screen.getByTestId('shop')
  expect(shop).toHaveAttribute('lang', 'en-US')
  expect(shop).toHaveAttribute('dir', 'ltr')
  expect(screen.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('button', { name: 'Deutsch' })).toHaveAttribute('aria-pressed', 'false')
})
test('switching to German reformats every price', async () => {
  const { container } = render(<Shop />)
  await user.click(screen.getByRole('button', { name: 'Deutsch' }))
  expect(prices(container)).toEqual(['129,99 €', '49,50 $', '1.500 ¥'])
  expect(screen.getByTestId('shop')).toHaveAttribute('lang', 'de-DE')
  expect(screen.getByRole('button', { name: 'Deutsch' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('button', { name: 'Deutsch' })).toHaveAttribute('lang', 'de-DE')
})
test('Arabic switches the direction', async () => {
  render(<Shop />)
  await user.click(screen.getByRole('button', { name: 'العربية' }))
  const shop = screen.getByTestId('shop')
  expect(shop).toHaveAttribute('dir', 'rtl')
  expect(shop).toHaveAttribute('lang', 'ar-EG')
})
```
:::

## Storybook: a workshop for your components

Open any real app and try to look at your `Button` in its *loading* state, or the empty state of a table,
or the error banner with a 120-character German message, or the whole page in Arabic. You'd have to click
through flows, fake a slow network or log in as a special user. That friction is why those states ship
broken.

**Storybook** is a separate dev server that renders components **in isolation**, one state per **story**.
It runs on your project's own Vite config (`@storybook/react-vite`), so your CSS, aliases and plugins
work. Teams use it for three jobs at once:

1. **Development**: build a component state by state without the rest of the app.
2. **Documentation**: a living catalogue of the design system with props tables, generated from your types.
3. **Testing**: every story is a test case: render tests, interaction tests, accessibility checks, visual
   snapshots.

### Stories, args and controls (CSF)

Stories are written in **Component Story Format** (CSF): a default export (the *meta*) describing the
component, and one named export per story.

```tsx
// src/shared/ui/Button.stories.tsx
import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { Button } from './Button'

const meta = {
  title: 'UI/Button',              // sidebar path
  component: Button,
  tags: ['autodocs'],              // generate a Docs page from props + JSDoc
  args: { children: 'Save changes', onClick: fn() },   // defaults for every story
  argTypes: {
    variant: { control: 'inline-radio', options: ['primary', 'secondary', 'danger'] },
  },
} satisfies Meta<typeof Button>

export default meta
type Story = StoryObj<typeof meta>

export const Primary: Story = {}
export const Danger: Story = { args: { variant: 'danger', children: 'Delete project' } }
```

- **Args** are the props a story renders with. Stories merge their args over the meta's args, so each
  story only states what's different.
- **Controls** are generated from args and your TypeScript prop types; anyone (a designer, a PM) can
  change `variant` or `children` live in the browser. Paste a German string into `children` and see if the
  button still fits.
- **`fn()`** creates a spy. Its calls show in the **Actions** panel and can be asserted in tests.
- **Decorators** wrap stories, typically with providers: theme, router, query client, or the locale.
- **Globals** and the **toolbar** switch something for *all* stories: theme, viewport, or locale:

```tsx
// .storybook/preview.tsx (excerpt)
const preview: Preview = {
  globalTypes: {
    locale: {
      description: 'Locale',
      toolbar: {
        icon: 'globe',
        items: [
          { value: 'en-US', title: 'English' },
          { value: 'de-DE', title: 'Deutsch' },
          { value: 'ar-EG', title: 'العربية' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { locale: 'en-US' },
  decorators: [
    (Story, { globals }) => (
      <LocaleContext value={globals.locale}>
        <div lang={globals.locale} dir={globals.locale.startsWith('ar') ? 'rtl' : 'ltr'}>
          <Story />
        </div>
      </LocaleContext>
    ),
  ],
}
```

Now one click in the toolbar shows every component of your kit in Arabic, right to left. That's how RTL
bugs get found before customers find them.

### Interaction tests, a11y checks and visual regression

A story can have a **`play` function** that runs after it renders: click, type, then assert, using
Testing-Library-style queries (as in **Testing React with Vitest & Testing Library**):

```tsx
export const Disabled: Story = {
  args: { disabled: true },
  play: async ({ args, canvas, userEvent }) => {
    const button = canvas.getByRole('button', { name: 'Save changes' })
    await expect(button).toBeDisabled()
    await userEvent.click(button)
    await expect(args.onClick).not.toHaveBeenCalled()
  },
}
```

With the **Vitest addon** (`@storybook/addon-vitest`), `npx vitest --project=storybook` turns **every story
into a test** that runs in a real browser (Vitest browser mode + Playwright). A story without `play` is
still a smoke test: it fails if the component throws while rendering. You write the scenario once and get
documentation, a manual playground and an automated test.

The **a11y addon** (`@storybook/addon-a11y`) runs **axe-core** on each story. The Accessibility panel lists
violations (missing button names, low contrast, invalid ARIA) with links to the rule. The
`parameters.a11y.test` setting decides what happens in tests: `'todo'` reports violations as warnings,
`'error'` fails the test (what you want in CI), `'off'` skips a story (use sparingly, with a comment).
Automated checks find a good share of issues, not all: keyboard flow and screen-reader wording still need
a human (see **Accessible Modals & Dialogs**).

**Visual regression testing** catches what assertions don't: a padding change that breaks 40 components.
The idea: screenshot every story, compare pixel-by-pixel with an approved baseline, and show a human the
diffs on each pull request. **Chromatic** (a hosted service from the Storybook maintainers) does this for
Storybook directly; teams who self-host point Playwright's `toHaveScreenshot()` at the built Storybook's
iframe URLs (`iframe.html?id=ui-button--primary&viewMode=story`, see **End-to-End Testing with
Playwright**). Screenshots are only stable when fonts, OS and browser are fixed, so run them in the same
Docker image or CI runner every time, and disable animations.

### Documenting a design system

`tags: ['autodocs']` generates a Docs page per component: description, a live example, a props table
from your TypeScript types, and every story. JSDoc comments on props become the descriptions, so
`/** Amount in minor units (cents). Always an integer. */` above `minor` documents your money rule where
people look. For guidelines (when to use `danger`, do/don't, token tables) write **MDX** pages next to the
stories. Deploy the static build (`npm run build-storybook` → `storybook-static/`) to an internal URL or
Chromatic so designers, QA and other teams use the same source of truth.

:::quiz id=fe-30-q6 xp=10
In CSF, what is a story?
- [ ] A Markdown page describing a component
- [x] A named export that describes one rendered state of a component, usually as an object of `args`
- [ ] A Vitest file that imports the component and calls `render()`
- [ ] A screenshot that Storybook compares against a baseline
> The default export (meta) describes the component; each named export is one story, typically just the
> args that differ from the meta's defaults, optionally with a `play` function. MDX pages are docs, not
> stories. The Vitest addon *turns* stories into tests and visual-regression tools *screenshot* stories,
> but the story itself is just the description of a state, which is why one story can serve all three jobs.
:::

:::quiz id=fe-30-q7 xp=15
Your team adds `@storybook/addon-a11y` and keeps the default `a11y: { test: 'todo' }`. A new `IconButton`
story has no accessible name. What happens when CI runs `vitest --project=storybook`?
- [ ] The test fails, because the a11y addon always fails on violations
- [x] The test passes; the violation is only reported (Accessibility panel and the Storybook testing widget), not enforced
- [ ] The story isn't tested at all because it has no `play` function
- [ ] Storybook automatically adds `aria-label` from the story name
> `'todo'` is a migration mode: violations are reported, not enforced, so existing kits can adopt the
> addon without a red build on day one. In the terminal the run is simply green (`Tests 8 passed`), which
> is exactly why `'todo'` must not stay forever: CI never sees the problem. Set `test: 'error'` in
> `.storybook/preview.tsx` once the backlog is fixed so new violations fail CI. Stories without `play` are
> still rendered and checked: every story is a test. Nothing invents accessible names for you.
:::

:::quiz id=fe-30-q8 xp=10
Where should "Deutsch" in a language picker come from, and how should the button be marked up?
- [ ] From the German translation file, because the UI is currently in German
- [ ] Translated into the current UI language: "German" in English, "Allemand" in French
- [x] Written in its own language ("Deutsch", "العربية") with `lang="de-DE"` / `lang="ar-EG"` on that element
- [ ] Replaced by a flag icon, which everyone recognises
> A user who can't read the current UI language must still find their own language, so each option is
> written in that language; `lang` makes screen readers pronounce it correctly. Translating the names into
> the current language hides the escape hatch from exactly the person who needs it. Flags are countries, not
> languages: which flag is Spanish, Spain's or Mexico's? Which is English? Arabic is spoken in 20+ countries.
:::

:::warn title="Storybook is not the app"
A story that renders perfectly can still break in the app: real data is longer, real providers behave
differently, routes and auth exist. Keep stories close to reality (realistic args, long strings, the same
providers via decorators, MSW handlers for data, as in **Testing React with Vitest & Testing Library**) and
keep end-to-end tests for whole flows. Stories test components; they don't replace testing the product.
:::

## Lab: Storybook for the UI kit

:::lab id=fe-30-lab1 xp=100
title: Stories, interaction tests and a11y checks for Button and Price
You'll add Storybook 10 to a Vite + React + TypeScript project holding the `Button` from **Component
Forge I** plus a new `Price` component, write stories, make an accessibility violation fail the tests,
and fix it. You need Node 22+.

**1. Create the project** (skip if you already have the UI kit from Component Forge; then just add the files
from step 2 that you're missing):

```bash
npm create vite@latest ui-kit -- --template react-ts
cd ui-kit
npm install
```

**2. Add the components.** Create these four files.

```ts
// src/shared/ui/cn.ts
export function cn(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(' ')
}
```

```css
/* src/shared/ui/button.css */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  border: 1px solid transparent;
  border-radius: 0.5rem;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.btn:focus-visible { outline: 3px solid #1d4ed8; outline-offset: 2px; }
.btn:disabled { opacity: 0.6; cursor: not-allowed; }
.btn-primary { background: #1d4ed8; color: #ffffff; }
.btn-secondary { background: #ffffff; color: #1f2937; border-color: #9ca3af; }
.btn-danger { background: #b91c1c; color: #ffffff; }
.btn-sm { padding: 0.25rem 0.625rem; font-size: 0.875rem; }
.btn-md { font-size: 1rem; }
.btn-lg { padding: 0.75rem 1.25rem; font-size: 1.125rem; }
```

```tsx
// src/shared/ui/Button.tsx
import { cn } from './cn'
import './button.css'

export type ButtonProps = React.ComponentProps<'button'> & {
  variant?: 'primary' | 'secondary' | 'danger'
  size?: 'sm' | 'md' | 'lg'
}

export function Button({ variant = 'primary', size = 'md', type = 'button', className, ...rest }: ButtonProps) {
  return <button type={type} className={cn('btn', `btn-${variant}`, `btn-${size}`, className)} {...rest} />
}
```

```tsx
// src/shared/ui/Price.tsx
export type PriceProps = {
  /** Amount in minor units (cents for USD/EUR, yen for JPY). Always an integer. */
  minor: number
  /** ISO 4217 code, e.g. 'EUR' */
  currency: string
  /** BCP 47 tag, e.g. 'de-DE' */
  locale: string
}

export function Price({ minor, currency, locale }: PriceProps) {
  const nf = new Intl.NumberFormat(locale, { style: 'currency', currency })
  const digits = nf.resolvedOptions().maximumFractionDigits ?? 2
  const major = minor / 10 ** digits
  return (
    <data className="price" value={major.toFixed(digits)} lang={locale}>
      {nf.format(major)}
    </data>
  )
}
```

**3. Install Storybook** with docs, tests and accessibility:

```bash
npm create storybook@latest -- --features docs test a11y --no-dev
```

Answer the prompts (or add `--yes`). `--features` picks what to set up (`docs`, `test`, `a11y`;
`onboarding` would add a guided tour), and `--no-dev` stops it from launching the dev server at the end. It
installs `storybook`, `@storybook/react-vite`, the docs, a11y and Vitest addons (plus
`@chromatic-com/storybook` for optional hosted visual tests), Vitest browser mode with Playwright and a
headless Chromium, and creates `.storybook/main.ts`, `.storybook/preview.tsx`, a `storybook` project under
`test.projects` in `vite.config.ts`, a few `npm` scripts (`storybook`, `build-storybook`), and example
stories in `src/stories/`.
*Expected:* it ends with a summary telling you to run `npm run storybook`. On Linux, if tests later
complain about missing libraries, run `npx playwright install chromium --with-deps`.

:::warn title="If the install step fails"
Storybook publishes many packages per release. If `npm install` fails with `ETARGET No matching version
found for @storybook/…`, you caught a release mid-publish: set `storybook` and every `@storybook/*` entry
in `package.json` to the same previous patch version (`npm view storybook versions`), then `npm install`.
All Storybook packages must share one version. Flags and generated files change between releases; if
something here doesn't match, the [Storybook install docs](https://storybook.js.org/docs/get-started/install)
are the reference.
:::

Delete the generated examples so only your stories remain:

```bash
rm -rf src/stories
```

**4. Fail on accessibility violations.** In `.storybook/preview.tsx`, change `test: 'todo'` to
`test: 'error'` inside `parameters.a11y`. The file should look like this:

```tsx
// .storybook/preview.tsx
import type { Preview } from '@storybook/react-vite'

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    a11y: {
      // 'todo' - show a11y violations in the test UI only
      // 'error' - fail CI on a11y violations
      // 'off' - skip a11y checks entirely
      test: 'error',
    },
  },
}

export default preview
```

**5. Write the Button stories**, including a deliberately broken one:

```tsx
// src/shared/ui/Button.stories.tsx
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn } from 'storybook/test'
import { Button } from './Button'

const meta = {
  title: 'UI/Button',
  component: Button,
  tags: ['autodocs'],
  args: { children: 'Save changes', onClick: fn() },
  argTypes: {
    variant: { control: 'inline-radio', options: ['primary', 'secondary', 'danger'] },
    size: { control: 'inline-radio', options: ['sm', 'md', 'lg'] },
  },
} satisfies Meta<typeof Button>

export default meta
type Story = StoryObj<typeof meta>

export const Primary: Story = {}

export const Danger: Story = {
  args: { variant: 'danger', children: 'Delete project' },
}

export const Disabled: Story = {
  args: { disabled: true },
  play: async ({ args, canvas, userEvent }) => {
    const button = canvas.getByRole('button', { name: 'Save changes' })
    await expect(button).toBeDisabled()
    await userEvent.click(button)
    await expect(args.onClick).not.toHaveBeenCalled()
  },
}

export const ClickCallsOnClick: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Save changes' }))
    await expect(args.onClick).toHaveBeenCalledTimes(1)
  },
}

// Deliberately broken: an icon-only button with no accessible name.
export const IconOnly: Story = {
  args: {
    variant: 'secondary',
    children: (
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16">
        <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="2" />
      </svg>
    ),
  },
}
```

**6. Write the Price stories** (localized output checked in `play`):

```tsx
// src/shared/ui/Price.stories.tsx
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect } from 'storybook/test'
import { Price } from './Price'

const meta = {
  title: 'UI/Price',
  component: Price,
  args: { minor: 123450, currency: 'EUR', locale: 'de-DE' },
  argTypes: {
    locale: { control: 'select', options: ['en-US', 'de-DE', 'fr-FR', 'ja-JP', 'ar-EG'] },
    currency: { control: 'select', options: ['USD', 'EUR', 'JPY', 'KWD'] },
  },
} satisfies Meta<typeof Price>

export default meta
type Story = StoryObj<typeof meta>

// Intl uses no-break spaces (U+00A0 / U+202F) in some locales; normalize before comparing.
const clean = (s: string | null) => (s ?? '').replace(/[\u00a0\u202f]/g, ' ')

export const German: Story = {
  play: async ({ canvasElement }) => {
    await expect(clean(canvasElement.textContent)).toBe('1.234,50 €')
  },
}

export const American: Story = {
  args: { locale: 'en-US', currency: 'USD' },
  play: async ({ canvasElement }) => {
    await expect(clean(canvasElement.textContent)).toBe('$1,234.50')
  },
}

export const Yen: Story = {
  args: { locale: 'ja-JP', currency: 'JPY', minor: 1234 },
}
```

**7. Look at it.** Run `npm run storybook`. *Expected:* a `Storybook ready!` box with a
`Local:` URL on port 6006 (`http://localhost:6006/` or `http://127.0.0.1:6006/`, depending on the version)
and a browser tab opens. Under **UI → Button** you see a **Docs** page and
five stories. Open **Icon Only** and the **Accessibility** panel: it lists the `button-name` violation
("Buttons must have discernible text"). In **UI → Price → German**, use the Controls to switch `locale` to
`ar-EG` and `currency` to `KWD`; the text re-renders in Arabic digits with three decimals.

**8. Run the stories as tests.** In a second terminal:

```bash
npx vitest --project=storybook --run
```

*Expected:* one failure and seven passes (abridged; timings and warnings omitted):

```text
 ❯ |storybook (chromium)| src/shared/ui/Button.stories.tsx (5 tests | 1 failed)
   × Icon Only
 FAIL  |storybook (chromium)| src/shared/ui/Button.stories.tsx > Icon Only
expect(received).toHaveNoViolations(expected)
Expected the HTML found at $('.btn') to have no violations:
<button type="button" class="btn btn-secondary btn-md"><svg aria-hidden="true" …></svg></button>
Received:
"Buttons must have discernible text (button-name)"
 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 7 passed (8)
```

Each story is one test (Button 5 + Price 3 = 8); the Docs page is not a test. The failure also prints a
link to open the story in Storybook and a list of ways to fix it (`aria-label`, `aria-labelledby`,
visible text, `title`).

**9. Fix it.** Give the icon-only button a name by adding `'aria-label': 'Close'` to the `IconOnly` args
(above `children`), then rerun step 8. *Expected:* `Test Files  2 passed (2)` and `Tests  8 passed (8)`.

**10. Build the static catalogue:** `npm run build-storybook`. *Expected:* `Storybook build completed
successfully` and a `storybook-static/` folder you could deploy anywhere (add it to `.gitignore`).

:::tip
The Storybook UI has a **Run tests** button in the sidebar's testing widget that runs the same Vitest
project, with a11y results and coverage, without leaving the browser.
:::

- [ ] `npm run storybook` shows UI/Button (Docs + 5 stories) and UI/Price (3 stories)
- [ ] The Accessibility panel showed the `button-name` violation on Icon Only
- [ ] With `a11y.test: 'error'`, `npx vitest --project=storybook --run` failed on Icon Only
- [ ] After adding `aria-label`, all 8 story tests pass
- [ ] The Price stories show `1.234,50 €`, `$1,234.50` and a yen price without decimals
- [ ] `npm run build-storybook` produced `storybook-static/`
:::

:::cards id=fe-30-cards1 xp=15 title="i18n, dates & Storybook"
Q: i18n vs l10n?
A: i18n = engineering the app so it *can* support many locales (no hard-coded strings or formats). l10n = providing the actual translations and regional formats.
Q: Why store money as integer minor units?
A: Binary floats can't represent most decimal fractions (0.1 + 0.2 ≠ 0.3). Integers are exact; divide by 10^digits only for display. Remember JPY has 0 digits, KWD 3.
Q: Locale vs currency?
A: Locale is how the user wants things displayed; currency is a fact about the money. A German user sees a USD price as "1.234,50 $".
Q: Why does `count === 1 ? 'item' : 'items'` break?
A: Plural rules differ: Russian/Polish have one/few/many, Arabic six forms, French treats 0 as singular. Use Intl.PluralRules / ICU plural messages.
Q: What does `#` mean in an ICU plural message, and what is `=0`?
A: `#` is the count formatted for the locale; `=0` is an exact-value branch tried before the plural category.
Q: Three kinds of time values and how to store them?
A: Instant → UTC (timestamptz). Future local event → wall time + IANA zone. Calendar date → date only (DateOnly / "YYYY-MM-DD").
Q: Why is `new Date('2026-05-01')` dangerous?
A: Date-only ISO strings parse as UTC midnight, which is the previous day in zones west of UTC.
Q: Is adding 24 hours the same as adding one day?
A: No. Across a DST change a calendar day is 23 or 25 hours. Use zone-aware calendar arithmetic (Temporal.ZonedDateTime, date-fns/tz, Luxon).
Q: Offset vs time zone?
A: "+02:00" is an offset at one moment; "Europe/Berlin" is a zone with rules (DST, history). Store zone ids for local times.
Q: How do you make CSS work in RTL?
A: Set dir="rtl" and use logical properties (margin-inline-start, inset-inline-end, text-align: start); flip only directional icons.
Q: Storybook: story, args, play?
A: A story is a named export describing one state; args are its props (editable via Controls); play runs interactions and assertions after render.
Q: What does `a11y: { test: 'error' }` do?
A: Makes axe violations fail the story's test when stories run via the Vitest addon ('todo' only reports them).
Q: What is visual regression testing?
A: Screenshot each story and diff against an approved baseline on every PR (Chromatic, or Playwright toHaveScreenshot on the built Storybook).
:::

## Recap

- Data is locale-free; only rendering is localized. Send numbers, currency codes and ISO instants, never formatted strings.
- `Intl.NumberFormat`, `DateTimeFormat`, `RelativeTimeFormat`, `PluralRules`, `ListFormat` and `Collator` cover formatting, plurals, lists and sorting for every locale; create formatters once and reuse them.
- Money is integer minor units plus a currency; the currency's digits vary (JPY 0, KWD 3) and the currency never comes from the locale.
- Sentences are ICU messages with placeholders and plural/select branches (react-intl, i18next, Lingui), never concatenations or `count === 1` checks.
- Pick the locale from the user's explicit choice, then the URL, then `navigator.languages`/`Accept-Language`, with fallback; set `lang` and `dir`, and use logical CSS properties for RTL.
- Instants in UTC, displayed in the viewer's zone; future local events as wall time + IANA zone; calendar dates as dates. Test the DST days; prefer Temporal (with a polyfill where needed) or date-fns/Luxon over hand-rolled `Date` math.
- Intl output contains no-break spaces; normalize them in tests.
- Storybook renders each component state as a story (args, controls, decorators, globals), documents the kit with autodocs and MDX, and turns stories into tests: `play` interactions, axe checks with `a11y.test: 'error'`, and visual regression snapshots.
