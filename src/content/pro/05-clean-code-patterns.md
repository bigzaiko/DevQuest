---
id: pro-06
title: Clean Code & Design Patterns
level: intermediate
minutes: 80
xp: 200
summary: Naming, small functions, SOLID in C# and TypeScript, DRY vs WET, and the six patterns you'll actually meet — plus when they're over-engineering.
---

Code is read **far more often than it is written** — by reviewers, by the on-call engineer at
2 a.m., by you in six months. "Clean code" isn't about beauty; it's about making the next change
**cheap and safe**. Patterns are named, reusable answers to recurring design problems — useful
vocabulary in code review ("let's make this a strategy"), and dangerous when applied for their own
sake.

This lesson gives you the habits seniors apply without thinking, the SOLID principles with real
C# and TypeScript, and the patterns you'll find in almost every ASP.NET Core + React codebase.

## Naming: the cheapest refactoring there is

A good name removes the need for a comment. Rules of thumb:

| Do | Instead of |
|---|---|
| `elapsedMs`, `timeoutSeconds` (units in the name) | `elapsed`, `timeout` |
| `isActive`, `hasAccess`, `canEdit` for booleans | `active`, `flag`, `check` |
| `activeCustomers` | `list2`, `data`, `tmp` |
| Domain words the business uses: `invoice`, `dunningLevel` | Invented synonyms: `bill`, `reminderThing` |
| Verbs for functions: `sendInvoice`, `calculateTax` | Nouns: `invoiceSender()` |
| `GetUserOrNull` / `FindUser` vs `GetUser` (throws) | Same name for both behaviours |

Name length should grow with scope: `i` is fine in a three-line loop, a module-level constant
deserves `MAX_UPLOAD_SIZE_BYTES`.

:::job title="Follow the house style"
Every team has conventions — `IFooService` interfaces, `Async` suffixes on async C# methods,
`useXxx` for React hooks, folder-per-feature vs folder-per-layer. Your first PRs should look like
the code around them, even if you'd choose differently. Propose changes in a team discussion, not
inside a feature PR.
:::

## Small functions, one level of abstraction

A function should do **one thing** at **one level of abstraction**. If you need "and" to describe
it, or you can extract a chunk and give it a meaningful name, do it.

```ts
// ❌ Three levels mixed: HTTP, validation details, business rules, formatting
async function handleSignup(req: Request) {
  const body = await req.json()
  if (!body.email || !body.email.includes('@') || body.email.length > 254) return new Response('bad', { status: 400 })
  if (!body.password || body.password.length < 12) return new Response('bad', { status: 400 })
  const existing = await db.query('SELECT 1 FROM users WHERE email = $1', [body.email.toLowerCase()])
  if (existing.rowCount) return new Response('taken', { status: 409 })
  // … 40 more lines …
}

// ✅ Reads like a table of contents; each step is testable alone
async function handleSignup(req: Request) {
  const input = parseSignup(await req.json())
  if (!input.ok) return badRequest(input.errors)
  if (await emailTaken(input.value.email)) return conflict('Email already registered')
  const user = await createUser(input.value)
  await sendWelcomeEmail(user)
  return created(user.id)
}
```

Habits that keep functions readable:

- **Guard clauses / early returns** instead of nested `if/else` pyramids.
- **No boolean flag arguments** — `render(true)` means nothing at the call site. Split into two
  functions or pass an options object: `render({ compact: true })`.
- **Few parameters** — more than three or four is a hint you're missing a type (`DateRange`,
  `Money`, `Address`).
- **Command–query separation** — a function either *does* something or *answers* something.
  `getUser()` that also updates `lastSeen` surprises everyone.
- **Comments explain *why*, not *what*.** `// Stripe retries webhooks for 3 days, so this must be
  idempotent` is gold. `// increment i` is noise.

```csharp
// ❌ Arrow code
public decimal Discount(Customer? c, Order o)
{
    if (c != null)
    {
        if (c.IsActive)
        {
            if (o.Total > 100) { return o.Total * 0.1m; }
            else { return 0; }
        }
        else { return 0; }
    }
    else { throw new ArgumentNullException(nameof(c)); }
}

// ✅ Guard clauses
public decimal Discount(Customer? c, Order o)
{
    ArgumentNullException.ThrowIfNull(c);
    if (!c.IsActive) return 0;
    if (o.Total <= 100) return 0;
    return o.Total * 0.1m;
}
```

### Code smells you'll point out in review

| Smell | Typical refactoring |
|---|---|
| Long method | Extract function |
| Long parameter list / data clumps | Introduce parameter object / value type |
| Primitive obsession (`string email`, `decimal` + `string currency`) | Value objects: `Email`, `Money` |
| Feature envy (method mostly uses another class's data) | Move method to that class |
| Shotgun surgery (one change touches 12 files) | Gather the knowledge in one place |
| `switch` on a type code repeated in many places | Polymorphism / strategy |
| Magic numbers/strings | Named constants, enums |
| Dead code, commented-out code | Delete it — git remembers |

:::quiz id=pro-06-q1 xp=10
Which call site is the clearest?
- [ ] `exportReport(data, true, false)`
- [ ] `exportReport(data, 1)`
- [x] `exportReport(data, { format: 'csv', includeArchived: false })`
- [ ] `exportReport2(data)`
> The options object names every setting at the call site, so a reader knows what the call does
> without opening `exportReport`. `true, false` and `1` are positional "mode" arguments: you have
> to look up the signature to learn what they mean, and swapping two booleans compiles without an
> error. `exportReport2` is a name that tells you nothing about how it differs. Separate,
> well-named functions (`exportCsv`, `exportArchivedCsv`) would also be a good fix.
:::

:::quiz id=pro-06-q6 xp=15
Spot the problem. The header shows a cart badge by calling `getCart(userId)` on every render, and
the analytics team asks why "cart viewed" fires 40 times per page.

```ts
function getCart(userId: string): Cart {
  const cart = carts.get(userId) ?? createEmptyCart(userId)
  carts.set(userId, cart)
  analytics.track('cart_viewed', { userId })
  return cart
}
```

- [ ] Long parameter list: `getCart` should take an options object
- [x] Command–query separation: a function named like a query also writes state and fires an event
- [ ] Liskov substitution: `Cart` should be an interface
- [ ] Magic strings: `'cart_viewed'` should be a constant
> A caller reading `getCart` expects a harmless lookup it can call as often as it likes. Hidden
> writes (`carts.set`) and side effects (`analytics.track`) turn every innocent call into a
> tracked event. Split it: `getCart()` answers, and `trackCartViewed()` is called once from the
> cart page. A constant for `'cart_viewed'` is a nice touch, but it wouldn't stop the 40 events.
> There is only one parameter and no subtype, so the other two options don't apply.
:::

## SOLID, with real code

SOLID is five principles for code that is easy to change. Treat them as **lenses for spotting
trouble**, not laws.

### S — Single Responsibility

> A class should have one reason to change.

"Reason to change" = one **actor** or concern. If the finance team changes the tax rule and the
design team changes the PDF layout, and both edit the same class, it has two responsibilities.

```csharp
// ❌ Calculates, renders and sends — three reasons to change
public class InvoiceService
{
    public decimal CalculateTotal(Invoice i) { /* tax rules */ }
    public byte[] RenderPdf(Invoice i) { /* layout */ }
    public Task EmailAsync(Invoice i, string to) { /* SMTP */ }
}

// ✅ Each piece changes for one reason and is testable alone
public sealed class InvoiceCalculator { public decimal Total(Invoice i) { /* … */ } }
public sealed class InvoicePdfRenderer { public byte[] Render(Invoice i) { /* … */ } }
public sealed class InvoiceMailer(IEmailSender email, InvoicePdfRenderer pdf) { /* … */ }
```

In React, SRP shows up as **separating data fetching from presentation**: a `useInvoices()` hook
owns the fetching/caching, an `<InvoiceTable invoices={…} />` component only renders.

### O — Open/Closed

> Open for extension, closed for modification.

You should be able to add a new variant **without editing** a long `switch` in a core class.

```csharp
public interface IDiscountRule
{
    decimal DiscountFor(Order order);
}

public sealed class GoldTierDiscount : IDiscountRule
{
    public decimal DiscountFor(Order o) => o.CustomerTier == "gold" ? o.Subtotal * 0.10m : 0m;
}

public sealed class BulkDiscount : IDiscountRule
{
    public decimal DiscountFor(Order o) => o.ItemCount >= 10 ? 5m : 0m;
}

// Adding a new rule = a new class + one DI line. PriceCalculator never changes.
public sealed class PriceCalculator(IEnumerable<IDiscountRule> rules)
{
    public decimal Total(Order o) => Math.Max(0m, o.Subtotal - rules.Sum(r => r.DiscountFor(o)));
}

// Program.cs
builder.Services.AddSingleton<IDiscountRule, GoldTierDiscount>();
builder.Services.AddSingleton<IDiscountRule, BulkDiscount>();
builder.Services.AddSingleton<PriceCalculator>();
```

ASP.NET Core injects **all** registrations of `IDiscountRule` when you ask for
`IEnumerable<IDiscountRule>` — a built-in, idiomatic way to do OCP.

### L — Liskov Substitution

> Subtypes must be usable wherever the base type is expected, without surprises.

A subclass that throws `NotSupportedException` from an inherited method, requires extra
preconditions, or returns something the caller doesn't expect, breaks LSP.

```ts
interface Storage {
  save(key: string, data: Blob): Promise<void>
  load(key: string): Promise<Blob | null>
}

// ❌ Callers that accept a Storage will crash on save()
class ReadOnlyCdnStorage implements Storage {
  async save() { throw new Error('not supported') }
  async load(key: string) { return fetch(`/cdn/${key}`).then((r) => (r.ok ? r.blob() : null)) }
}

// ✅ Model the capability honestly: split the interface
interface ReadableStorage { load(key: string): Promise<Blob | null> }
interface WritableStorage extends ReadableStorage { save(key: string, data: Blob): Promise<void> }
```

Now `ReadOnlyCdnStorage implements ReadableStorage`, and a function that needs to save asks for a
`WritableStorage`. The compiler stops you from passing the read-only one there. Before the split,
you only found out at runtime.

:::quiz id=pro-06-q7 xp=15
A nightly job loops over `List<Account>` and calls `Withdraw(fee)` on each. It crashes on the
first fixed-deposit account:

```csharp
public class Account
{
    public decimal Balance { get; protected set; }
    public virtual void Withdraw(decimal amount) => Balance -= amount;
}

public class FixedDepositAccount : Account
{
    public override void Withdraw(decimal amount) =>
        throw new InvalidOperationException("Locked until maturity");
}
```

What is the real design problem, and what's the better fix?
- [ ] Open/Closed: add a `switch` on account type inside the nightly job
- [ ] Nothing: wrap every `Withdraw` call in `try/catch` and skip failures
- [x] Liskov: the subtype can't do what the base type promises, so withdrawal shouldn't be on the shared base. Model it as a separate capability (e.g. `IWithdrawable`) and only process accounts that have it
- [ ] Single Responsibility: move `Balance` into its own class
> `FixedDepositAccount` *is-a* `Account` on paper, but it breaks the base type's contract. Every
> caller now has to know about the exception. Catching it everywhere hides the design problem
> and swallows real errors too. A type switch in the job is the same knowledge leaking into
> callers. Make the capability explicit in the types instead, so the compiler tells you which
> accounts can be withdrawn from.
:::

### I — Interface Segregation

> Clients shouldn't depend on methods they don't use.

A 25-method `IUserService` forces every consumer (and every test fake) to know about all 25. Split
by use: `IUserReader`, `IUserAdmin`, `IPasswordResetter`. In React the same idea applies to
**props**: a `<Avatar user={user} />` that only needs `name` and `imageUrl` is easier to reuse as
`<Avatar name={…} imageUrl={…} />`.

### D — Dependency Inversion

> High-level policy shouldn't depend on low-level details; both depend on abstractions.

"High-level policy" is the business rule you care about ("a subscription expires at its end
date"). "Low-level details" are how you get things done: the system clock, Postgres, SMTP, HTTP.
If the rule calls the detail directly, you can't test or reuse the rule without the detail.
So the rule declares what it needs (an abstraction), and the outside world plugs in the real
thing. DI containers do the plugging. The classic, very practical example is **time**:

```csharp
// ❌ Untestable: depends on the real clock
public bool IsExpired(Subscription s) => s.EndsAt < DateTimeOffset.UtcNow;

// ✅ .NET 8+ ships TimeProvider — inject it, fake it in tests
public sealed class SubscriptionService(TimeProvider clock)
{
    public bool IsExpired(Subscription s) => s.EndsAt < clock.GetUtcNow();
}
// Program.cs:  builder.Services.AddSingleton(TimeProvider.System);
// Tests:       new FakeTimeProvider(start)  (Microsoft.Extensions.TimeProvider.Testing)
```

```ts
// TypeScript: pass dependencies in, default to the real thing
export function createApi(fetchFn: typeof fetch = fetch, baseUrl = '/api') {
  return { getProject: (id: string) => fetchFn(`${baseUrl}/projects/${id}`).then((r) => r.json()) }
}
```

:::quiz id=pro-06-q2 xp=15
Every time product adds a new payment provider, someone edits this method and its tests break:

```csharp
public Task ChargeAsync(Order o) => o.Provider switch
{
    "stripe" => ChargeStripe(o),
    "paypal" => ChargePayPal(o),
    "klarna" => ChargeKlarna(o),
    _ => throw new NotSupportedException()
};
```

Which principle is this mainly violating, and what's the usual fix?
- [ ] Liskov — make every provider inherit from `Stripe`
- [x] Open/Closed — an `IPaymentProvider` per provider, selected by key (e.g. keyed DI services)
- [ ] Interface Segregation — split `Order` into smaller interfaces
- [ ] None — a switch is always the cleanest option
> The symptom is "every new variant means editing the same method", which is the problem
> Open/Closed targets. A strategy per variant (in .NET 8+ often
> `AddKeyedScoped<IPaymentProvider, StripeProvider>("stripe")`, resolved at runtime by key, e.g.
> `sp.GetRequiredKeyedService<IPaymentProvider>(o.Provider)`, or inject
> `IEnumerable<IPaymentProvider>` and pick the one whose `Name` matches) lets you add a provider
> as a new class without touching the existing ones. (`[FromKeyedServices("stripe")]` is for when
> the key is fixed at the injection site, so it can't replace this switch.) Liskov is about subtypes behaving like their base
> type, and nothing here is subclassed. Inheriting PayPal from Stripe would make things worse. A
> switch is fine when it rarely changes, but not when it keeps growing.
:::

## DRY, WET and the wrong abstraction

**DRY** ("Don't Repeat Yourself") is about **knowledge**, not characters. If the VAT rate lives in
three places, changing it means finding all three — that's real duplication. But two functions
that happen to look the same today may represent different knowledge that will diverge tomorrow.

```ts
// These look identical...
const isValidUsername = (s: string) => s.length >= 3 && s.length <= 20
const isValidSku = (s: string) => s.length >= 3 && s.length <= 20
// ...but usernames and SKUs change for different reasons. Merging them into
// `isValidShortString` couples two unrelated business rules.
```

- **Rule of three**: tolerate duplication twice; abstract on the third occurrence, when you can
  see the real shape.
- **WET** ("Write Everything Twice") and **AHA** ("Avoid Hasty Abstractions") are the counterweight.
- *"Duplication is far cheaper than the wrong abstraction"* (Sandi Metz). A shared helper with
  five boolean parameters to handle every caller's special case is worse than five small copies.
  The fix is often to **inline it back** and start over.

:::quiz id=pro-06-q3 xp=15
A teammate wants to merge `formatInvoiceNumber()` and `formatOrderNumber()` because both currently
return `PREFIX-000123`. Which are good reasons to **wait**? (select all that apply)
- [x] Invoice numbering is governed by tax law; order numbers by the shop team — they'll change for different reasons
- [x] There are only two occurrences and the shared shape isn't clear yet
- [ ] Duplication is always better than abstraction
- [x] A merged helper would likely grow flags like `isInvoice` to handle the differences
> DRY targets duplicated *knowledge*. Same code with different owners and reasons to change is
> coincidental similarity, and merging it means the next tax-law change risks breaking order
> numbers. The tempting wrong answer is "duplication is always better": that's just as dogmatic
> as "always DRY". If the VAT rate were copied in three places, you *should* merge it. Abstract
> when the shared shape and the shared reason to change are both clear.
:::

## Patterns you'll actually meet

Six patterns cover most of what you'll see in a modern full-stack codebase. For each: what it is,
where it already exists in your tools, and when it's overkill.

### Strategy — interchangeable algorithms

A family of algorithms behind one interface, chosen at runtime. In TypeScript you often don't need
classes — **a map of functions is a strategy**:

```ts
type Exporter = (rows: Row[]) => string
const exporters: Record<'csv' | 'json' | 'markdown', Exporter> = {
  csv: (rows) => rows.map((r) => Object.values(r).join(',')).join('\n'),
  json: (rows) => JSON.stringify(rows),
  markdown: toMarkdownTable,
}
export const exportRows = (format: keyof typeof exporters, rows: Row[]) => exporters[format](rows)
```

**Helps when** variants keep being added or are chosen by configuration. **Overkill when** there
are two variants that never change — an `if` is fine.

:::challenge id=pro-06-c1 lang=ts xp=40
title: Refactor shipping into strategies
The shipping code below grew into nested `if`s, and product now wants a new method: **`pickup`**
(always free). Refactor to a strategy map and add pickup. The tests define the behaviour:

* Export `shippingStrategies`: one function per method (`standard`, `express`, `overnight`, `pickup`).
* `shippingCost(order)` looks up the strategy; unknown methods throw `Unknown shipping method: <name>`.
  That includes names that exist on every object, such as `toString`. A plain lookup like
  `shippingStrategies['toString']` finds the inherited `Object.prototype.toString` function.
* `standard`: free from a subtotal of 50, otherwise 4.99. `express`: 9.99 + 0.50 per kg.
  `overnight`: 24.99 flat. `pickup`: 0.

hint: `export const shippingStrategies: Record<ShippingMethod, (o: Order) => number> = { standard: (o) => …, … }`
hint: Use `Object.hasOwn(shippingStrategies, order.method)` before looking up, so `toString` isn't a "method".

```ts setup
type ShippingMethod = 'standard' | 'express' | 'overnight' | 'pickup'
interface Order { subtotal: number; weightKg: number; method: ShippingMethod }
```

```ts starter
export function shippingCost(order: Order): number {
  if (order.method === 'standard') {
    if (order.subtotal >= 50) {
      return 0
    } else {
      return 4.99
    }
  } else {
    if (order.method === 'express') {
      return 9.99 + order.weightKg * 0.5
    } else {
      if (order.method === 'overnight') {
        return 24.99
      } else {
        throw new Error('Unknown shipping method: ' + order.method)
      }
    }
  }
}
```

```ts solution
export const shippingStrategies: Record<ShippingMethod, (o: Order) => number> = {
  standard: (o) => (o.subtotal >= 50 ? 0 : 4.99),
  express: (o) => 9.99 + o.weightKg * 0.5,
  overnight: () => 24.99,
  pickup: () => 0,
}

export function shippingCost(order: Order): number {
  if (!Object.hasOwn(shippingStrategies, order.method)) {
    throw new Error(`Unknown shipping method: ${order.method}`)
  }
  return shippingStrategies[order.method](order)
}
```

```ts tests
const order = (method: string, subtotal = 20, weightKg = 2) => ({ method, subtotal, weightKg }) as Order

test('there is one strategy per method', () => {
  expect(Object.keys(shippingStrategies).sort()).toEqual(['express', 'overnight', 'pickup', 'standard'])
})
test('standard: free from 50', () => {
  expect(shippingCost(order('standard', 20))).toBeCloseTo(4.99)
  expect(shippingCost(order('standard', 50))).toBe(0)
})
test('express: base plus weight', () => {
  expect(shippingCost(order('express', 20, 3))).toBeCloseTo(11.49)
})
test('overnight is flat', () => {
  expect(shippingCost(order('overnight', 999, 40))).toBeCloseTo(24.99)
})
test('pickup is free', () => {
  expect(shippingCost(order('pickup', 5, 10))).toBe(0)
})
test('strategies can be called directly', () => {
  expect(shippingStrategies.standard(order('standard', 60))).toBe(0)
})
test('unknown methods throw', () => {
  expect(() => shippingCost(order('teleport'))).toThrow('Unknown shipping method: teleport')
  expect(() => shippingCost(order('toString'))).toThrow('Unknown shipping method: toString')
})
```
:::

### Factory — centralise tricky creation

A function or class whose job is to **create** objects, when construction depends on runtime data
or needs configuration the caller shouldn't know about. You already use factories daily:
`IHttpClientFactory` (pooled handlers, named clients), `IDbContextFactory<T>` (contexts for
background jobs/Blazor), `WebApplication.CreateBuilder()`, React's `createContext`, `createRoot`.

```csharp
builder.Services.AddHttpClient("github", c =>
{
    c.BaseAddress = new Uri("https://api.github.com/");
    c.DefaultRequestHeaders.UserAgent.ParseAdd("devquest");
});

public sealed class RepoService(IHttpClientFactory factory)
{
    public Task<string> GetAsync(string path) => factory.CreateClient("github").GetStringAsync(path);
}
```

**Overkill when** `new Thing(a, b)` would do. A `ThingFactory` that just calls `new` is noise.

### Adapter — wrap what you don't control

Convert one interface into the one your code wants. Put third-party SDKs (payments, email, storage)
**behind your own interface** at the boundary: your domain speaks your language, tests use a fake,
and swapping vendors touches one class.

```csharp
public interface IEmailSender { Task SendAsync(string to, string subject, string html); }

// The only class that knows SendGrid exists
public sealed class SendGridEmailSender(ISendGridClient client) : IEmailSender
{
    public async Task SendAsync(string to, string subject, string html)
    {
        var msg = MailHelper.CreateSingleEmail(new EmailAddress("noreply@app.example"),
            new EmailAddress(to), subject, plainTextContent: null, htmlContent: html);
        var res = await client.SendEmailAsync(msg);
        if (!res.IsSuccessStatusCode) throw new EmailFailedException(res.StatusCode);
    }
}
```

:::challenge id=pro-06-c2 lang=ts xp=50
title: Adapt a legacy payment SDK
The vendor's `LegacyPayClient` (given, you can't change it) takes **integer cents**, an upper-case
currency code, and returns `{ status: 'OK' | 'FAIL', ref?, errorMsg? }`. Our code wants the
`PaymentGateway` interface. Write `class LegacyPayAdapter implements PaymentGateway`:

* `constructor(client: LegacyPayClient)`
* `charge({ amount, currency, token })` returns a Promise of `{ ok: true, id }` or `{ ok: false, reason }`.
* `amount` is in currency units (`19.99`) → convert to cents with correct rounding.
* `currency` may be lower-case → upper-case it.
* `amount <= 0` → `{ ok: false, reason: 'Invalid amount' }` **without** calling the vendor.
* Vendor `OK` → `id` is the vendor `ref`; vendor `FAIL` → `reason` is the vendor `errorMsg`.

hint: `19.99 * 100` is `1998.9999999999998` in floating point — `Math.round` it.
hint: Store the client in a field: `private client: LegacyPayClient` and assign it in the constructor.

```ts setup
// ── Third-party SDK: do not change ──
class LegacyPayClient {
  calls: unknown[][] = []
  makePayment(amountInCents: number, currencyCode: string, cardToken: string): { status: 'OK' | 'FAIL'; ref?: string; errorMsg?: string } {
    this.calls.push([amountInCents, currencyCode, cardToken])
    if (cardToken === 'tok_declined') return { status: 'FAIL', errorMsg: 'Card declined' }
    return { status: 'OK', ref: 'ch_' + amountInCents }
  }
}

// ── Our interface ──
interface ChargeRequest { amount: number; currency: string; token: string }
type ChargeResult = { ok: true; id: string } | { ok: false; reason: string }
interface PaymentGateway { charge(req: ChargeRequest): Promise<ChargeResult> }
```

```ts starter
export class LegacyPayAdapter implements PaymentGateway {
  constructor(client: LegacyPayClient) {}

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    throw new Error('TODO')
  }
}
```

```ts solution
export class LegacyPayAdapter implements PaymentGateway {
  private client: LegacyPayClient

  constructor(client: LegacyPayClient) {
    this.client = client
  }

  async charge({ amount, currency, token }: ChargeRequest): Promise<ChargeResult> {
    if (!(amount > 0)) return { ok: false, reason: 'Invalid amount' }
    const cents = Math.round(amount * 100)
    const res = this.client.makePayment(cents, currency.toUpperCase(), token)
    return res.status === 'OK'
      ? { ok: true, id: res.ref ?? '' }
      : { ok: false, reason: res.errorMsg ?? 'Payment failed' }
  }
}
```

```ts tests
test('successful charge maps to ok + id', async () => {
  const client = new LegacyPayClient()
  const gw = new LegacyPayAdapter(client)
  expect(await gw.charge({ amount: 12, currency: 'EUR', token: 'tok_visa' })).toEqual({ ok: true, id: 'ch_1200' })
})
test('converts to cents with correct rounding and upper-cases currency', async () => {
  const client = new LegacyPayClient()
  const gw = new LegacyPayAdapter(client)
  await gw.charge({ amount: 19.99, currency: 'eur', token: 'tok_visa' })
  expect(client.calls[0]).toEqual([1999, 'EUR', 'tok_visa'])
})
test('declines map to ok:false with the vendor message', async () => {
  const gw = new LegacyPayAdapter(new LegacyPayClient())
  expect(await gw.charge({ amount: 5, currency: 'usd', token: 'tok_declined' })).toEqual({ ok: false, reason: 'Card declined' })
})
test('invalid amounts never reach the vendor', async () => {
  const client = new LegacyPayClient()
  const gw = new LegacyPayAdapter(client)
  expect(await gw.charge({ amount: 0, currency: 'eur', token: 'tok_visa' })).toEqual({ ok: false, reason: 'Invalid amount' })
  expect(await gw.charge({ amount: -3, currency: 'eur', token: 'tok_visa' })).toEqual({ ok: false, reason: 'Invalid amount' })
  expect(client.calls).toHaveLength(0)
})
```
:::

### Observer — tell interested parties something happened

Subjects publish events; observers subscribe without the subject knowing who they are. It's
everywhere: DOM `addEventListener`, C# `event`s, `IObservable<T>`, domain events / MediatR
notifications ("OrderPlaced" → send email, update stats), message queues across services, and
React's `useSyncExternalStore` subscribing to a store.

**Helps when** one action has several independent side effects that shouldn't know about each
other. **Hurts when** control flow becomes invisible — "who handles this event, in what order, and
what if one fails?" Keep handlers few and discoverable, and log them.

:::challenge id=pro-06-c3 lang=ts xp=40
title: A tiny event bus
Write `createEventBus()` returning `{ on, off, emit }`:

* `on(event, handler)` subscribes and **returns an unsubscribe function**.
* `off(event, handler)` removes that handler.
* `emit(event, payload)` calls every handler for that event **in subscription order** with the payload.
* Emitting an event nobody listens to does nothing.
* A handler that unsubscribes itself during `emit` must not cause other handlers to be skipped.

hint: `const handlers = new Map<string, Array<(p: unknown) => void>>()`
hint: In `emit`, iterate over a **copy** (`[...list]`) so removals during the loop are safe.

```ts starter
export function createEventBus() {
  return {
    on(event: string, handler: (payload: any) => void) { return () => {} },
    off(event: string, handler: (payload: any) => void) {},
    emit(event: string, payload?: unknown) {},
  }
}
```

```ts solution
export function createEventBus() {
  const handlers = new Map<string, Array<(payload: any) => void>>()

  function off(event: string, handler: (payload: any) => void) {
    const list = handlers.get(event)
    if (!list) return
    const i = list.indexOf(handler)
    if (i >= 0) list.splice(i, 1)
  }

  return {
    on(event: string, handler: (payload: any) => void) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => off(event, handler)
    },
    off,
    emit(event: string, payload?: unknown) {
      for (const h of [...(handlers.get(event) ?? [])]) h(payload)
    },
  }
}
```

```ts tests
test('handlers receive the payload', () => {
  const bus = createEventBus()
  const h = fn()
  bus.on('order:placed', h)
  bus.emit('order:placed', { id: 7 })
  expect(h).toHaveBeenCalledWith({ id: 7 })
})
test('handlers run in subscription order, only for their event', () => {
  const bus = createEventBus()
  const seen: string[] = []
  bus.on('a', () => seen.push('first'))
  bus.on('a', () => seen.push('second'))
  bus.on('b', () => seen.push('other'))
  bus.emit('a')
  expect(seen).toEqual(['first', 'second'])
})
test('on() returns an unsubscribe function', () => {
  const bus = createEventBus()
  const h = fn()
  const unsubscribe = bus.on('x', h)
  unsubscribe()
  bus.emit('x', 1)
  expect(h).not.toHaveBeenCalled()
})
test('off() removes a handler', () => {
  const bus = createEventBus()
  const h = fn()
  bus.on('x', h)
  bus.off('x', h)
  bus.emit('x')
  expect(h).toHaveBeenCalledTimes(0)
})
test('emitting with no listeners is fine', () => {
  const bus = createEventBus()
  expect(() => bus.emit('nobody-home', 1)).not.toThrow()
})
test('self-unsubscribing handler does not skip others', () => {
  const bus = createEventBus()
  const later = fn()
  const off1 = bus.on('tick', () => off1())
  bus.on('tick', later)
  bus.emit('tick')
  expect(later).toHaveBeenCalledTimes(1)
})
```
:::

### Repository — and the EF Core debate

A repository hides data access behind a collection-like interface: `orders.FindById(id)`,
`orders.Add(order)`. It's central in DDD and makes the domain independent of the database.

The debate you'll hear in every .NET team: **EF Core's `DbContext` already is a unit of work, and
each `DbSet<T>` already is a repository.** A generic wrapper on top often just hides useful
features:

```csharp
// ❌ Generic repository over EF Core: loses Include, projections, AsNoTracking, paging…
public interface IRepository<T> { T? GetById(int id); IEnumerable<T> GetAll(); void Add(T e); }
// and GetAll() quietly loads the whole table into memory.

// ✅ If you add a repository, make it specific and intention-revealing
public interface IOrderRepository
{
    Task<Order?> FindWithLinesAsync(Guid id, CancellationToken ct);
    Task<IReadOnlyList<OrderSummary>> RecentForCustomerAsync(Guid customerId, int take, CancellationToken ct);
    void Add(Order order);
}
```

**Helps when** you want a domain model free of EF details, or several queries need the same
complex loading rules. **Overkill when** it's a 1:1 pass-through over `DbSet`. For tests, a real
Postgres in **Testcontainers** beats mocking `DbContext` — mocked LINQ doesn't behave like SQL.

### Decorator — add behaviour by wrapping

Wrap an object in another with the **same interface** that adds something before/after:
caching, logging, retries, metrics, authorization. The caller can't tell the difference.

```csharp
public sealed class CachingProductCatalog(IProductCatalog inner, IMemoryCache cache) : IProductCatalog
{
    public Task<Product?> FindAsync(int id) =>
        cache.GetOrCreateAsync($"product:{id}", e =>
        {
            e.AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(5);
            return inner.FindAsync(id);
        });
}

builder.Services.AddMemoryCache(); // IMemoryCache isn't registered by default in minimal APIs / AddControllers()

// With the Scrutor package (an open-source DI extension):
builder.Services.AddScoped<IProductCatalog, EfProductCatalog>();
builder.Services.Decorate<IProductCatalog, CachingProductCatalog>();

// Without Scrutor, wire it by hand:
builder.Services.AddScoped<EfProductCatalog>();
builder.Services.AddScoped<IProductCatalog>(sp => new CachingProductCatalog(
    sp.GetRequiredService<EfProductCatalog>(), sp.GetRequiredService<IMemoryCache>()));
```

The decorator has the same interface as the thing it wraps, so `ProductsController` keeps asking
for `IProductCatalog` and never knows a cache exists. If you want to turn caching off, you change
one registration line.

:::warn title="Decorator gotchas"
- This version also caches **"not found"** (`null`) for five minutes. A product created a minute
  later stays invisible. Decide on purpose: skip caching `null`, or give it a shorter expiry.
- A caching decorator must cache **per key that affects the result**. If prices depend on the
  tenant or the user's currency, `product:{id}` serves one tenant's data to another.
:::

You already use decorators: ASP.NET Core **middleware** wraps the next handler, `HttpClient`
**`DelegatingHandler`s** wrap the HTTP pipeline (Polly resilience handlers are exactly this), and
in TypeScript a **higher-order function** — `withRetry(fetchUser)` — is a decorator.

:::challenge id=pro-06-c4 lang=ts xp=45
title: A `withRetry` decorator
Write `withRetry(fn, attempts)` that returns a new async function with the **same parameters**.
It calls `fn` up to `attempts` times in total:

* the first success resolves with its value (no further calls);
* if every attempt fails, it rejects with the **last** error;
* arguments are passed through unchanged on every attempt.

hint: A `for` loop with `try { return await fn(...args) } catch (e) { lastError = e }`.
hint: After the loop, `throw lastError`.

```ts starter
export function withRetry<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  attempts: number,
): (...args: A) => Promise<R> {
  return fn
}
```

```ts solution
export function withRetry<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  attempts: number,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    let lastError: unknown
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn(...args)
      } catch (e) {
        lastError = e
      }
    }
    throw lastError
  }
}
```

```ts tests
test('returns the first success without retrying', async () => {
  const f = fn(async (x: unknown) => `ok ${x}`)
  const g = withRetry(f as (x: number) => Promise<string>, 3)
  await expect(g(1)).resolves.toBe('ok 1')
  expect(f).toHaveBeenCalledTimes(1)
})
test('retries until it succeeds', async () => {
  let n = 0
  const f = fn(async () => { n++; if (n < 3) throw new Error(`fail ${n}`); return 'finally' })
  const g = withRetry(f as () => Promise<string>, 3)
  await expect(g()).resolves.toBe('finally')
  expect(f).toHaveBeenCalledTimes(3)
})
test('rejects with the last error after all attempts', async () => {
  let n = 0
  const f = fn(async () => { n++; throw new Error(`boom ${n}`) })
  const g = withRetry(f as () => Promise<never>, 2)
  await expect(g()).rejects.toThrow('boom 2')
  expect(f).toHaveBeenCalledTimes(2)
})
test('passes arguments through on every attempt', async () => {
  let n = 0
  const f = fn(async (a: unknown, b: unknown) => { n++; if (n === 1) throw new Error('flaky'); return [a, b] })
  const g = withRetry(f as (a: number, b: string) => Promise<unknown>, 2)
  await expect(g(42, 'x')).resolves.toEqual([42, 'x'])
  expect(f.mock.calls).toEqual([[42, 'x'], [42, 'x']])
})
```
:::

:::pro title="Real retries need more"
Production retry logic adds **exponential backoff with jitter**, retries only *transient* errors
(timeouts, 503, 429 — never 400 or 401), respects `Retry-After`, and has a total timeout. In .NET,
`builder.Services.AddHttpClient<X>().AddStandardResilienceHandler()` (Microsoft.Extensions.Http.Resilience,
built on Polly) gives you all of that, and only retry **idempotent** operations.
:::

### When patterns become over-engineering

:::warn title="Smells of pattern overdose"
- An interface for every class, each with exactly one implementation and no test that needs a fake.
- `AbstractFactory` → `FactoryProvider` → `Factory` chains to call `new`.
- Generic repositories and "service" layers that only forward calls.
- Speculative generality: "we might support MongoDB one day" (**YAGNI** — you aren't gonna need it).
- A junior can't find where a request is actually handled.

Start with the simplest thing; introduce a pattern when the **second or third** real need appears.
Refactoring towards a pattern is cheap when tests exist.
:::

:::quiz id=pro-06-q4 xp=15
Match the scenario: you wrap every `IOrderService` call with timing + logging, without changing
`OrderService` and without callers noticing. Which pattern is this?
- [ ] Adapter
- [ ] Factory
- [x] Decorator
- [ ] Repository
> Same interface, added behaviour around the inner call: that's a decorator. Adapter is the
> tempting answer because it also wraps an object, but an adapter **changes** the interface into
> a different one (vendor SDK → your `IEmailSender`). Here callers still see `IOrderService`.
> Factory creates objects and Repository hides data access; neither adds behaviour around calls.
:::

:::quiz id=pro-06-q5 xp=15
Your team uses EF Core. Someone proposes a generic `IRepository<T>` with `GetAll()`, `GetById()`,
`Add()`, `Remove()` for every entity. What are real downsides? (select all that apply)
- [x] It hides EF features like `Include`, projections and `AsNoTracking`
- [x] `GetAll()` tends to load whole tables into memory before filtering
- [x] It duplicates what `DbContext`/`DbSet` already provide
- [ ] It makes SQL injection more likely
> Generic repositories over EF Core usually add a layer without adding meaning. If you want
> repositories, make them specific (`RecentOrdersForCustomer`) so they express real queries.
> SQL injection is the distractor: EF Core parameterises LINQ queries whether or not a
> repository wraps them. Injection comes from string-concatenated raw SQL, not from layering.
:::

## Refactoring safely

Clean code is achieved by **small, continuous refactorings**, not big rewrites:

1. **Get tests around it first** (characterisation tests that pin today's behaviour, even weird behaviour).
2. Make **one small change** — rename, extract function, introduce parameter object.
3. Run tests. Commit. Repeat.
4. **Separate refactoring commits/PRs from behaviour changes.** "Refactor: extract PriceCalculator"
   then "feat: add bulk discount" is a joy to review; both in one 900-line diff is not.

Step 1 is the one people skip. Which tests are worth writing around a refactor, what to mock (the
clock and `fetch`, as in the SOLID section) and what not to (your own classes), and how many
end-to-end tests you actually need, is the subject of the next lesson, **Testing Strategy**.

Your IDE does most of this safely: Rider/VS/VS Code (C# Dev Kit) **Rename** (F2), **Extract
Method**, **Introduce Variable**, **Move to file**, and TypeScript's "Move to a new file" and
"Extract to function". Prefer them over hand editing — they update every reference.

:::tip title="The Boy Scout rule"
Leave the code a little better than you found it — rename one confusing variable, delete one dead
branch — **inside the scope of your ticket**. Unrelated big cleanups go in their own PR.
:::

## Lab: strategy + decorator in C#

:::lab id=pro-06-lab1 xp=90
title: Discount rules and a caching catalog
Build the OCP discount example and a caching decorator, test-first, in a fresh solution.

```bash
mkdir PatternsLab && cd PatternsLab
dotnet new sln
dotnet new classlib -n Shop
dotnet new xunit -n Shop.Tests
dotnet sln add Shop/Shop.csproj Shop.Tests/Shop.Tests.csproj
dotnet add Shop.Tests reference Shop
```

With the .NET 10 SDK, `dotnet new sln` creates the newer XML solution format, `PatternsLab.slnx`.
`dotnet sln add` handles it the same way. Older SDKs create `PatternsLab.sln`. You can delete the
template's `Shop/Class1.cs` and `Shop.Tests/UnitTest1.cs`.

**1.** In `Shop`, create these types (you implement the bodies):

```csharp
namespace Shop;

public record Order(decimal Subtotal, string CustomerTier, int ItemCount);
public record Product(int Id, string Name);

public interface IDiscountRule { decimal DiscountFor(Order order); }
public interface IProductCatalog { Task<Product?> FindAsync(int id); }

// GoldTierDiscount: 10% of subtotal for tier "gold"
// BulkDiscount: 5 off when ItemCount >= 10
// PriceCalculator(IEnumerable<IDiscountRule> rules): Total never below 0
// CachingProductCatalog(IProductCatalog inner): calls inner once per id
```

**2.** Paste these tests into `Shop.Tests/PatternTests.cs` and make them pass with `dotnet test`:

```csharp
using Shop;

public class PriceCalculatorTests
{
    [Fact]
    public void No_rules_means_full_price() =>
        Assert.Equal(100m, new PriceCalculator([]).Total(new Order(100m, "basic", 1)));

    [Fact]
    public void Rules_are_summed()
    {
        var calc = new PriceCalculator([new GoldTierDiscount(), new BulkDiscount()]);
        Assert.Equal(85m, calc.Total(new Order(100m, "gold", 10)));
    }

    [Fact]
    public void Total_never_goes_negative()
    {
        var calc = new PriceCalculator([new BulkDiscount()]);
        Assert.Equal(0m, calc.Total(new Order(3m, "basic", 12)));
    }
}

public class CachingCatalogTests
{
    private sealed class CountingCatalog : IProductCatalog
    {
        public int Calls;
        public Task<Product?> FindAsync(int id) { Calls++; return Task.FromResult<Product?>(new Product(id, $"P{id}")); }
    }

    [Fact]
    public async Task Same_id_hits_the_inner_catalog_once()
    {
        var inner = new CountingCatalog();
        var sut = new CachingProductCatalog(inner);
        var a = await sut.FindAsync(1);
        var b = await sut.FindAsync(1);
        Assert.Equal(1, inner.Calls);
        Assert.Equal(a, b);
    }

    [Fact]
    public async Task Different_ids_are_cached_separately()
    {
        var inner = new CountingCatalog();
        var sut = new CachingProductCatalog(inner);
        await sut.FindAsync(1);
        await sut.FindAsync(2);
        Assert.Equal(2, inner.Calls);
    }
}
```

Until the types exist, the build fails with errors like `CS0246: The type or namespace name
'PriceCalculator' could not be found`. That's your to-do list. When everything is implemented,
`dotnet test` ends with a summary. In an interactive terminal (the .NET 9/10 terminal logger)
it looks like:

```text
Test summary: total: 5, failed: 0, succeeded: 5, skipped: 0, duration: 1.2s
```

In CI or with redirected output you get the classic line instead:

```text
Passed!  - Failed:     0, Passed:     5, Skipped:     0, Total:     5, Duration: 42 ms - Shop.Tests.dll (net10.0)
```

**3.** Add a third rule (`FirstOrderDiscount`, or anything you like) **without editing
`PriceCalculator`** (that's Open/Closed in action), and a test for it. `Order` has no "first
order" field, so either add one (`bool IsFirstOrder = false` as an optional last record
parameter keeps the existing tests compiling) or pick a rule that uses the existing fields.
`dotnet test` should now report 6 tests (`succeeded: 6` in the terminal summary, or
`Passed:     6` in the classic CI line).

:::tip
A `ConcurrentDictionary<int, Product?>` is enough for the cache here. In a real app you'd use
`IMemoryCache` or `HybridCache` (.NET 9+) with an expiry.
:::

- [ ] `dotnet test` passes all five provided tests
- [ ] `PriceCalculator` only depends on `IEnumerable<IDiscountRule>`
- [ ] A new discount rule was added without modifying `PriceCalculator`, with its own test (6 passed)
- [ ] `CachingProductCatalog` implements `IProductCatalog` and wraps another `IProductCatalog`
:::

## Flashcards

:::cards id=pro-06-cards1 xp=20 title="Clean code & patterns"
Q: Single Responsibility Principle in one sentence?
A: A module should have one reason to change — one actor/concern it serves.
Q: Open/Closed Principle?
A: Add new behaviour by adding code (a new strategy/handler), not by editing a growing switch in existing code.
Q: Liskov Substitution — sign it's violated?
A: A subtype throws NotSupported for an inherited method, adds preconditions, or surprises callers that expect the base type.
Q: Interface Segregation?
A: Prefer several small, client-specific interfaces (or props) over one fat one.
Q: Dependency Inversion — classic .NET example?
A: Inject `TimeProvider` instead of calling `DateTime.UtcNow`, so tests can control time.
Q: What does DRY really target?
A: Duplicated knowledge (one business rule in several places) — not code that merely looks alike.
Q: Rule of three?
A: Tolerate duplication twice; abstract on the third occurrence when the real shape is visible.
Q: Strategy pattern in TypeScript, simplest form?
A: A `Record<key, function>` map chosen at runtime.
Q: Adapter vs Decorator?
A: Adapter converts one interface to a different one (wrap a vendor SDK). Decorator keeps the same interface and adds behaviour (caching, logging, retry).
Q: Where do you already use decorators in ASP.NET Core?
A: Middleware, HttpClient DelegatingHandlers (Polly/resilience), Scrutor's `Decorate<>`.
Q: Built-in factories you use in .NET?
A: `IHttpClientFactory`, `IDbContextFactory<T>`, `WebApplication.CreateBuilder()`.
Q: Why are generic repositories over EF Core often criticised?
A: DbContext/DbSet already are unit of work/repository; the wrapper hides Include, projections, tracking control and encourages loading whole tables.
Q: Observer pattern examples?
A: DOM events, C# events, domain events/MediatR notifications, message queues, store subscriptions in React.
Q: Command–query separation?
A: A function either changes state (command) or returns an answer (query), not both. A `getX()` that also writes or fires events surprises every caller.
Q: YAGNI?
A: "You aren't gonna need it" — don't build abstractions for speculative future requirements.
Q: Safe refactoring loop?
A: Tests first → one small change → run tests → commit. Keep refactors and behaviour changes in separate commits/PRs.
:::

## Recap

- Names are the cheapest documentation: units, intent, domain language, boolean prefixes.
- Small functions at one level of abstraction; guard clauses; no boolean flag arguments; comments
  explain **why**.
- **SOLID** = lenses: one reason to change, extend without editing, honest subtypes, small
  interfaces, depend on abstractions (`TimeProvider`, injected `fetch`).
- **DRY** targets duplicated knowledge; prefer duplication over the wrong abstraction; rule of three.
- **Strategy, Factory, Adapter, Observer, Repository, Decorator** — you already use most of them
  via the framework. Reach for them when the second or third real need shows up.
- Refactor in small, tested steps, and keep refactoring separate from feature changes.
