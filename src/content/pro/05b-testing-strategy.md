---
id: pro-10
title: Testing Strategy for a Full-Stack Team
level: intermediate
minutes: 80
xp: 150
summary: Decide what to test and where in a React + ASP.NET Core + Postgres app — pyramid vs trophy vs honeycomb, contract tests, what (never) to mock, test data builders, flaky tests, coverage vs mutation testing, tests in PR review and a feature test plan.
---

Knowing *how* to write a test is the easy part. The other DevQuest lessons cover the tools:
**Testing React with Vitest & Testing Library**, **End-to-End Testing with Playwright**,
**Testing .NET Code with xUnit** and **Integration Tests with WebApplicationFactory & Testcontainers**.
This lesson covers the question that comes up in every planning meeting and every PR review:

> *What should we test, at which level, and how do we know the tests are any good?*

A team without a strategy gets one of two outcomes. Either there are few tests and every release is
scary, or there are thousands of slow, brittle tests that break on every refactor, fail at random,
and *still* miss the bug that reaches production. A strategy is how you spend a limited testing
budget where the bugs actually are.

## A test is a bet: the four costs

Every automated test buys **confidence** and costs you something. Thinking in these four dimensions
makes most "should I write this test?" debates short:

| Dimension | Question | Cheap end | Expensive end |
|---|---|---|---|
| **Confidence** | If it passes, how sure am I that users are fine? | Pure function test | Real browser against real API and DB |
| **Speed** | How long until I get feedback? | 1 ms | Minutes |
| **Maintenance** | How often does it break when behaviour did *not* change? | Tests the public behaviour | Tests internal calls, CSS classes, private methods |
| **Precision** | When it fails, how fast do I find the cause? | Points at one function | "Checkout e2e failed" — somewhere in 4 services |

No level wins on all four. A unit test is fast and precise but proves nothing about whether the
React app and the API agree on JSON. An end-to-end test gives huge confidence but is slow and vague
when it fails. **Strategy = combining levels so their weaknesses cancel out.**

The most useful single question you can ask about a test: *"Which realistic bug would make this
test fail?"* If you can't name one, the test is cost without benefit.

## Pyramid, trophy, honeycomb

You'll hear three shapes in interviews and design docs. They are not rival religions — they are
the same idea (put most tests where the risk is, at the cheapest level that catches it) applied to
different kinds of code.

```text
   Pyramid               Trophy                  Honeycomb
     /\                   ___                     ____
    /e2e\                (e2e)                   /    \    integrated (few)
   /------\           /integration\             / inte- \
  /integra-\          \  (most)   /            | gration |  most tests here:
 /  tion    \           \ unit  /               \ (most) /   one service + its
/   unit     \          [static]                 \______/    real DB/queue
/  (most)     \                                 implementation-detail (few)
```

| Shape | Who coined / uses it | Big idea | Fits |
|---|---|---|---|
| **Pyramid** | Mike Cohn, classic | Many unit tests, fewer integration, very few UI tests — because UI tests used to be slow and flaky | Logic-heavy code: pricing engines, parsers, domain rules |
| **Trophy** | Kent C. Dodds, React world | Static checks (TS, ESLint) at the base; **integration** (component + hooks + mocked network) is the fat middle | React frontends — see **Testing React with Vitest & Testing Library** |
| **Honeycomb** | Spotify, microservices | Few "implementation detail" unit tests; most tests exercise **one service through its API with real dependencies**; few cross-service tests | APIs whose risk is in wiring, SQL, serialization, auth — see **Integration Tests with WebApplicationFactory & Testcontainers** |

For a typical **React + ASP.NET Core + Postgres** product the honest answer is *all three at once*:

- **Frontend:** trophy. TypeScript catches a whole class of bugs for free. Pure helpers (formatting,
  reducers, validation) get unit tests. Most value is in component tests that render a screen, click
  like a user, and mock only `fetch`.
- **Backend:** honeycomb with a pyramid inside the domain. Business rules (prices, permissions,
  state machines) get fast xUnit tests. Endpoints get integration tests through
  `WebApplicationFactory` against a real Postgres in Testcontainers — because that's where the
  bugs are: a missing `[Authorize]`, a unique index, a `null` that serializes differently.
- **Between them:** **contract tests**, so the two halves can't drift apart silently.
- **On top:** a *small* number of Playwright journeys for the flows that make money or lose data.

:::pro title="Shape follows where the bugs are"
Seniors don't argue about shapes; they look at the last 20 production bugs and ask "which test
level would have caught this cheapest?" If most were SQL/permission/serialization bugs, the team
needs more API integration tests, not more unit tests. Re-do this exercise every few months — it's
a 30-minute retro that pays for itself.
:::

:::quiz id=pro-10-q1 xp=10
Business rule: *"A coupon can never take more than 50 % off an order."* The rule lives in
`PriceCalculator.Apply(order, coupon)` in the ASP.NET Core API. The checkout page shows the total
returned by `POST /api/orders/quote`. Where should **most** of the tests for this rule live?

- [ ] In a Playwright test that types coupons into the checkout page and reads the total
- [x] In xUnit unit tests of `PriceCalculator` (boundaries: 49, 50, 51, 100 %), plus **one** API integration test proving the endpoint uses the calculator
- [ ] In a React component test that mocks the quote endpoint and checks the displayed total
- [ ] Nowhere — the product manager will notice in staging
> The rule is pure logic, so the cheapest, fastest, most precise place to pin all its edge cases is
> a unit test of the calculator. One integration test then proves the wiring (the endpoint really
> calls it). The Playwright option is tempting because it "tests what the user sees", but running
> four browser flows to check arithmetic is slow and, when it fails, doesn't tell you whether the bug is
> in the calculator, the endpoint or the UI. The component test with a mocked endpoint tests nothing
> about the rule at all — the mock decides the number.
:::

:::quiz id=pro-10-q2 xp=10
Your team's ASP.NET Core service is mostly CRUD: endpoints validate input, call EF Core, and return
DTOs. Nearly every production bug last quarter was a wrong query filter, a missing authorization
policy or a JSON field that came back `null`. Which test portfolio fits best?

- [ ] Pyramid: mock `DbContext` and unit-test every endpoint handler in isolation
- [x] Honeycomb: most tests hit the real HTTP pipeline with a real Postgres (Testcontainers); unit tests only for the few real rules
- [ ] Mostly Playwright tests, because they cover frontend and backend together
- [ ] No tests; CRUD code is too simple to break
> All three bug types live in the *wiring* — EF translation to SQL, middleware and auth policies,
> JSON serialization. A unit test with a mocked `DbContext` skips exactly those layers, so it would
> stay green while every one of those bugs shipped. That's the trap: the pyramid looks
> "proper" but the mocks remove the risk you need to test. Integration tests through
> `WebApplicationFactory` hit all of it in a few hundred milliseconds each. Playwright would also catch them,
> but slowly and imprecisely.
:::

## The test types for our stack

| Type | What's real | What's faked | Tooling | Typical count | Runs |
|---|---|---|---|---|---|
| **Static** | Your code, read only | Nothing runs | `tsc`, ESLint, .NET analyzers, `dotnet format` | — | Editor + every push |
| **Unit** | One function/class | Its collaborators, if any | Vitest, xUnit | Hundreds+ | Every push, < 1 min |
| **Component** | React tree, DOM (jsdom), hooks, router | Network (`fetch`/MSW) | Vitest + Testing Library | Many | Every push |
| **API integration** | ASP.NET pipeline, EF Core, **real Postgres** | External services (payments, email), auth handler | `WebApplicationFactory` + Testcontainers + Respawn | Many | Every push, a few min |
| **Contract** | The agreement between web and API | The other side | Pact, or an OpenAPI schema check | One per interaction | Every push on *both* sides |
| **End-to-end** | Browser, built frontend, API, DB | Third parties | Playwright | 5–30 journeys | PR smoke subset + nightly |
| **Smoke / synthetic** | Production | Nothing | Playwright or HTTP checks on a schedule | A handful | After deploy, every few min |

Two words cause a lot of confusion: **integration** means different things to different people.
On your team, define it once in the README ("an integration test = one service + its real database,
through HTTP") so "write an integration test for this" means the same thing in every PR.

## Contract tests: keeping web and API honest

Here's a bug that both test suites will happily let through:

1. The API team renames `dueDate` to `dueAt` in `TaskDto`. Their integration tests are updated and green.
2. The frontend's component tests mock `fetch` with a hand-written `{ dueDate: '…' }`. Still green.
3. Production: every task shows "No due date".

Each side tested itself against **its own idea** of the other side. A **contract test** makes that
idea a shared, checked artifact:

- **Consumer-driven contracts (Pact style).** The *consumer* (the React app) writes down the
  requests it sends and the response *shapes* it relies on — as a contract file. Consumer tests
  prove the frontend client works against those examples. The *provider* (the API) runs a
  **verification** step in its own CI: replay every request from the contract against the real API
  and check that the responses match. Rename `dueDate` and the API's pipeline goes red before
  merge. A Pact Broker stores contracts and answers "can I deploy version X of the API?".
- **Schema-first (OpenAPI).** ASP.NET Core 10 generates an OpenAPI document
  (`Microsoft.AspNetCore.OpenApi`). Commit it, generate TypeScript types from it
  (`openapi-typescript`), and fail CI when a PR changes the document in a breaking way
  (e.g. `oasdiff breaking`). Cheaper than Pact and often enough for one web app + one API owned by the same team.

What a contract checks — and doesn't:

| Contract checks | Contract does *not* check |
|---|---|
| Paths, methods, status codes | Business rules (that's what unit/integration tests are for) |
| Required fields exist with the right **type** | Exact values like ids and timestamps |
| Error shape (`ProblemDetails`) the UI branches on | Fields the consumer doesn't use |
| The few **values** the UI branches on (enum values, error `type`), pinned with a regex/exact matcher | Every other value |

:::tip title="Contracts match shapes, not values"
A contract says "the response has an `id` that is a string", not "the id is `inv_1`". Otherwise every
run would fail on generated ids and timestamps. And because consumers only list the fields they
actually *read*, the provider can add new fields freely — only removing or retyping a used field
breaks the contract. That's precisely the line between a breaking and a non-breaking API change.

**The exception:** values the consumer *branches on*. If the UI does `if (role === 'Editor')` or
checks that an error `type` ends in `/plan-limit`, a type-only match ("role is a string") lets
`"editor"` through. Pin those few fields with a regex or exact-value matcher — Pact's `regex`/`term`
matchers exist for exactly this. The lab below shows both kinds of check.
:::

:::quiz id=pro-10-q3 xp=10
The React app and the ASP.NET API live in the same monorepo but are deployed separately. Last month
a backend PR changed an enum's JSON from `"Editor"` to `"editor"` (a new `JsonStringEnumConverter`
naming policy) and the role badge disappeared in production. Both test suites were green. What
catches this **earliest and cheapest** next time?

- [ ] More React component tests with mocked responses for the role badge
- [ ] A Playwright test for every screen that shows a role
- [x] A contract test (or a committed OpenAPI document with a breaking-change check) verified in the **API's** CI, so the backend PR itself goes red
- [ ] Adding `.ToLower()` to every comparison in the frontend
> The bug was in the gap *between* the two suites: each was tested against its own assumption.
> More component tests are tempting but don't help — their mocks contain the *old* assumption, so
> they stay green. Playwright would catch it, but only for screens you remember to cover, minutes
> later, and possibly after merge. A provider-side contract check fails on the PR that introduced the
> change, where the fix is a one-line revert — *provided it checks the enum's values*: an OpenAPI diff
> does (the allowed values are part of the schema), and a Pact contract does if the field uses a regex or
> exact matcher rather than a type-only "any string" matcher. `.ToLower()` everywhere only hides the drift.
:::

## What to mock — and what never to mock

A mock (or stub, fake, test double — **Testing .NET Code with xUnit** covers the vocabulary)
replaces something real. Every mock is a small lie: you are asserting *"the real thing behaves like
this"* without checking. So mock only when the real thing is **slow, nondeterministic, expensive or
outside your control**.

| Mock it | Why | How |
|---|---|---|
| Payment provider, email/SMS, third-party APIs | Costs money, sends real messages, rate-limited, not yours | Interface + fake in tests (`IPaymentGateway`), WireMock.Net for HTTP |
| **Time** | `DateTime.UtcNow` makes tests depend on when they run | Inject `TimeProvider`; `FakeTimeProvider` in tests; `vi.useFakeTimers()` in Vitest |
| Randomness, `Guid.NewGuid()` | Nondeterministic output | Inject a generator or assert on shape, not value |
| The network in **frontend** component tests | The real API isn't running in jsdom | Mock `fetch`/MSW at the boundary — never mock your own hooks |
| Authentication in API tests | You're not testing the identity provider | A test auth handler (see **Integration Tests with WebApplicationFactory & Testcontainers**) |

| Do **not** mock | Why |
|---|---|
| **Postgres** in API integration tests (no EF InMemory, no SQLite stand-in) | Constraints, transactions, `citext`, JSON operators, case sensitivity and SQL translation differ — the mock is green while production fails |
| `DbContext` / `DbSet` with a mocking library | Re-implementing LINQ-to-SQL in a mock gives you false confidence and painful setup |
| Your own small, deterministic classes (`PriceCalculator` inside `OrderService`) | Use the real one — mocking it couples the test to *how* `OrderService` is built |
| **The thing under test** (partial mocks, spying on its private methods) | Then you're testing the mock |
| Value objects, DTOs, mappers | Just construct them |

The symptom of over-mocking is a test that reads like the implementation backwards:

```csharp
// ❌ NSubstitute mocks for the repository and calculator. Mirrors the code:
// any refactor breaks it; a wrong SQL filter never would.
repo.GetOpenOrdersAsync(customerId).Returns(orders);
calculator.Total(orders).Returns(120m);
var result = await sut.GetDashboard(customerId);
await repo.Received(1).GetOpenOrdersAsync(customerId);
calculator.Received(1).Total(orders);
```

```csharp
// ✅ Arrange real data in a real database, assert the outcome a client sees.
// (AnOrder() is a test data builder — next section. ShouldBe is Shouldly.)
await db.SeedAsync(AnOrder().For(customer).Open().Totalling(100m),
                   AnOrder().For(customer).Open().Totalling(20m),
                   AnOrder().For(customer).Cancelled().Totalling(999m));
var dashboard = await client.GetFromJsonAsync<DashboardDto>($"/api/customers/{customer.Id}/dashboard");
dashboard!.OpenTotal.ShouldBe(120m);
```

The second test survives any refactor of the service and fails if the "open" filter is wrong —
which is the bug you'd actually ship.

:::quiz id=pro-10-q4 xp=15
You're testing `InvitationService.InviteAsync` in the ASP.NET API (an integration test through
`WebApplicationFactory`). Which dependencies should you replace with test doubles? **Select all that apply.**

- [x] `IEmailSender` (sends the invitation email via a third-party service)
- [x] `TimeProvider` (the invitation expires 7 days after creation)
- [ ] `AppDbContext` — swap it for the EF Core InMemory provider to make tests faster
- [ ] `PlanLimits` — your own small class that says how many members each plan allows
> Mock what is external or nondeterministic: the email sender would send real email (and is
> not your code), and the clock makes "expires in 7 days" untestable unless you control it. The
> InMemory provider is the tempting one — it *is* faster — but it ignores unique indexes, foreign
> keys and transactions, so a "duplicate invitation" bug passes in tests and fails in production.
> Use real Postgres in a container. `PlanLimits` is your own cheap, deterministic code — use the
> real one, or the test stops checking the actual limit.
:::

## Test data: builders and fixtures

Most of the lines in a typical test are setup. Bad setup causes two classic problems:

- **The mystery guest** — the test depends on a row in a shared seed file (`user 7 is an admin`)
  that you can't see in the test. Someone edits the seed; twelve unrelated tests break.
- **The wall of setup** — 30 lines constructing a `Project` with every required field, copy-pasted
  into 40 tests. Adding a required field means editing 40 tests, and the one field that matters
  for *this* test is invisible.

A **test data builder** fixes both: it creates a *valid* object with sensible defaults, and the
test overrides **only what matters to it**. The test then reads like the scenario.

```ts
// test/builders.ts — the frontend version is just a function with defaults
type Member = { userId: string; role: 'Editor' | 'Viewer' }
type Project = { id: string; name: string; plan: 'Free' | 'Pro'; ownerId: string; members: Member[] }

let seq = 0
export const aMember = (over: Partial<Member> = {}): Member => ({ userId: `u_${++seq}`, role: 'Editor', ...over })
export const aProject = (over: Partial<Project> = {}): Project => ({
  id: `p_${++seq}`,
  name: `Project ${seq}`,
  plan: 'Free',
  ownerId: 'u_owner',
  members: [],
  ...over,
})

// In a test, only the relevant fact is visible:
const full = aProject({ members: Array.from({ length: 10 }, () => aMember()) })   // "the Free plan is full"
const asViewer = aProject({ members: [aMember({ userId: 'u_me', role: 'Viewer' })] })
```

```csharp
// The C# version: a small fluent builder
public sealed class ProjectBuilder
{
    private string _name = $"Project {Guid.NewGuid():N}";   // unique by default
    private Plan _plan = Plan.Free;
    private readonly List<User> _members = [];
    private User _owner = new UserBuilder().Build();

    public ProjectBuilder OnPlan(Plan plan) { _plan = plan; return this; }
    public ProjectBuilder OwnedBy(User owner) { _owner = owner; return this; }
    public ProjectBuilder WithMembers(int count)
    {
        for (var i = 0; i < count; i++) _members.Add(new UserBuilder().Build());
        return this;
    }
    public Project Build() => new(_name, _owner, _plan, _members);
}

public static class A { public static ProjectBuilder Project => new(); }

// var project = A.Project.OnPlan(Plan.Free).WithMembers(10).Build();
```

Rules that keep test data healthy:

- **Defaults are valid and unique.** Unique names/emails per build, so parallel tests never
  collide on a unique index.
- **Each test arranges its own data.** Shared *reference* data (countries, plans) can be seeded once;
  anything a test changes must be created by that test.
- **Reset between tests** in integration suites (Respawn or a transaction per test) — never rely on
  test order.
- **Fixtures for expensive things** (a Postgres container, a `WebApplicationFactory`) are shared per
  class or collection; **data** is not.

## Flaky tests

A **flaky test** passes and fails on the same code. It is worse than no test: people learn to click
"re-run", and once a red build is normal, real failures are re-run too. The flakiness is almost
never random — it is a real nondeterminism you haven't controlled yet.

| Cause | Typical symptom | Fix |
|---|---|---|
| **Time** (`now`, time zones, DST, month ends) | Fails around midnight UTC or on the 31st | Inject `TimeProvider` / fake timers; set the time zone explicitly in tests that depend on it (`TZ` env var) instead of inheriting the machine's |
| **Shared state / order dependence** | Passes alone, fails in the full suite (or vice versa) | Each test creates its own data; reset DB; run in random order to surface it |
| **Async without waiting** | "Element not found" sometimes; `await` missing on `user.click` | `await` every async step; `findBy…`/`waitFor`; web-first assertions in Playwright |
| **Fixed sleeps** (`Thread.Sleep(500)`, `waitForTimeout`) | Fails on slow CI runners | Wait for a signal (a response, an element, a message consumed) |
| **Parallelism & resources** | Port in use, unique-violation on `test@example.com` | Random ports, unique data, a container per run |
| **Real network / third parties** | Fails when the sandbox API is slow | Fake them; keep real calls for a separate, non-blocking suite |
| **Unordered results** | `toEqual([a, b])` fails as `[b, a]` | `ORDER BY` in the query, or compare as sets |
| **Floating point / culture** | `"1,5"` vs `"1.5"` on a German build agent | Invariant culture in tests; compare money in cents/decimals |

**The process real teams use:**

1. **Detect.** CI records per-test pass/fail history; a test that both passed and failed on the same
   commit is flagged. Re-run the suspect test many times locally
   (`npx vitest run price.test.ts --repeats 50`, `npx playwright test --repeat-each=30`, a loop around
   `dotnet test --filter`).
2. **Quarantine the same day.** Move it out of the blocking suite (`test.skip` / `test.fixme`
   in Playwright, `[Trait("Category", "Quarantine")]` in xUnit, excluded in CI with
   `dotnet test --filter "Category!=Quarantine"`) **with a ticket and an owner**, and keep running the
   quarantined tests in a separate, non-blocking job so you can see when they're fixed.
3. **Fix the root cause** using the table above. "Add a retry" is not a fix.
4. **Prove it** with repeated runs, then un-quarantine. A quarantine older than two weeks is
   deleted or escalated — quarantine is a hospital, not a graveyard.

:::warn title="Check the filter syntax for your test runner"
`--filter "Category!=Quarantine"` is the VSTest syntax. Projects that run on
**Microsoft.Testing.Platform** (opt-in for xUnit v3 projects and for `dotnet test` in .NET 10) use
runner-specific options instead, e.g. xUnit v3's `--filter-not-trait "Category=Quarantine"`.
Check `dotnet test --help` in your repo and the xUnit / Microsoft Testing Platform docs before copying a filter into CI.
:::

:::warn title="Retries hide real bugs"
`retries: 2` in Playwright or a "re-run failed jobs" habit turns a flaky *test* into an invisible
flaky *product*. Sometimes the nondeterminism is in your code — a race condition between two
requests, a missing transaction — and the test was the only thing telling you. Keep retries low,
make CI report "passed on retry" as a warning, and investigate every one.
:::

:::quiz id=pro-10-q5 xp=10
`InvitationTests.Expired_invitation_is_rejected` passes every time on your laptop. In CI it fails
about one run in five, always with `409 Conflict: email already invited` — and only when the whole
suite runs in parallel. What's the most likely cause and fix?

- [ ] CI machines are slower; add `await Task.Delay(1000)` before the request
- [x] Tests share data: several tests create an invitation for the same hard-coded email. Give each test unique data (a builder default) and reset the database between tests
- [ ] The test is flaky by nature; set retries to 3 so the pipeline stays green
- [ ] Postgres in Testcontainers is unreliable; switch to the EF InMemory provider
> "Fails only in parallel" plus a *unique-constraint* error points to shared state: two tests
> insert `sam@example.com` at the same time and whichever comes second gets a 409. The delay is the
> tempting option because CI *is* slower, but waiting doesn't remove the collision; it just makes it less
> likely and the suite slower. Retries hide it. InMemory would "fix" it by ignoring the unique index —
> which also hides a real production behaviour.
:::

## Coverage is a signal, not a goal

Code coverage (`vitest run --coverage` with the `@vitest/coverage-v8` package; Coverlet for .NET via
`dotnet test --collect:"XPlat Code Coverage"`) tells you which lines and branches **ran** during the
tests. It does not know whether anything *checked* what they did. That makes it useful in one
direction only:

- **Low coverage on a file = definitely untested.** Good signal: "the refund logic has 12 %
  coverage" is worth a conversation.
- **High coverage ≠ tested.** A line that ran without any assertion checking its result counts as
  covered. This test covers 100 % of `quote()` and verifies nothing:

```ts
test('quote works', () => {
  quote([{ unitCents: 1999, qty: 3 }], 20)   // no expect → 100 % coverage, 0 % checking
})
```

Once coverage becomes a **target** ("PRs must keep 90 %"), people optimise the number: they write
assertion-free tests, test getters, and avoid deleting dead code. That's Goodhart's law: *when a
measure becomes a target, it ceases to be a good measure.*

What works better:

- **Diff coverage in PRs** — "the lines *this PR changed* are 85 % covered" (Codecov/Coveralls
  "patch coverage", or `diff-cover` on a Cobertura report) — highlights untested new code without
  forcing anyone to test 2019's legacy.
- **Risk-based thresholds** — high for domain logic (pricing, permissions), none for generated code,
  DTOs, `Program.cs`.
- **Read the uncovered lines**, not the percentage. An uncovered `catch` block in a payment handler
  matters; an uncovered `ToString()` doesn't.

## Mutation testing: testing your tests

**Mutation testing** answers the question coverage can't: *"Would my tests notice if this code
were wrong?"* A tool makes small deliberate bugs — **mutants** — in your code, one at a time, and
runs your tests against each:

| Original | Mutant |
|---|---|
| `qty >= 10` | `qty > 10` (boundary) |
| `a && b` | `a \|\| b` |
| `total - discount` | `total + discount` |
| `return isOwner` | `return true` (boolean literal) |
| `Math.min(pct, 50)` | `Math.max(pct, 50)` (method swapped) |
| `if (expired) { throw … }` | `if (expired) { }` (block emptied) |

If at least one test fails, the mutant is **killed** (good). If all tests still pass, it
**survived** — you've found behaviour no test checks. The **mutation score** is roughly killed ÷ total
(Stryker also counts mutants that make the tests time out as detected, and reports mutants on lines no
test runs as "no coverage" — those are the cheapest to fix).

- Tools: **Stryker.NET** (`dotnet tool install -g dotnet-stryker`, then `dotnet stryker` in the test
  project) and **StrykerJS** (`npx stryker init` sets it up, `npx stryker run` runs it; use the
  `@stryker-mutator/vitest-runner` plugin for Vitest). Both write an HTML report listing each survivor.
- It's slow (the suite runs once per mutant), so teams run it on **changed files in PRs** or
  **nightly** on core modules — not on everything, every push.
- Some survivors are "equivalent mutants" (the change doesn't alter behaviour). Don't chase 100 %;
  read the survivors in critical code and ask "is this a missing test or dead code?"

:::quiz id=pro-10-q6 xp=10
A PR adds a discount rule and its tests. CI shows **100 % line coverage** for the new file. Stryker
reports that the mutant changing `if (total >= 5000)` to `if (total > 5000)` **survived**. What does
that tell you?

- [ ] Nothing useful — 100 % coverage means the code is fully tested
- [ ] Stryker is broken, because a covered line can't have a surviving mutant
- [x] The line runs during tests, but no test uses a total of exactly 5000, so the boundary behaviour is unchecked
- [ ] The PR should be rejected until coverage is above 100 %
> Coverage only says the `if` *executed*. The surviving mutant shows that no test distinguishes
> `>=` from `>` — that happens only at exactly 5000, so no test checks the boundary. Covered and
> surviving is the normal case, not a contradiction: that's the whole reason mutation testing exists.
> The fix is one test at the boundary (a total of exactly 5000 gets the discount, 4999 doesn't), not more
> coverage. The 100 % coverage figure is the tempting distractor: it was already 100 % while the boundary was unchecked.
:::

## Your turn: kill the mutants

Both challenges below are mutation testing by hand. **You write the tests.** They must pass on the
correct implementation (shown) and fail on each hidden mutant — exactly what Stryker would ask of
your suite. Think *boundaries* and *the rule that's easy to forget*.

:::challenge id=pro-10-c1 lang=ts mode=tests xp=60
title: Catch the pricing bugs
`quote(lines, couponPercent)` prices a cart, in **cents**. The rules:

1. `subtotal` = sum of `unitCents × qty`.
2. **Bulk:** a line with **10 or more** units gets 10 % off that line (rounded to whole cents).
3. **Coupon:** `couponPercent` (default 0) off the amount after the bulk discount, rounded to whole
   cents, **capped at 50 %**; a negative percent counts as 0.
4. **Shipping:** free when the amount *after all discounts* is **5000 or more**, otherwise 499.
   An **empty cart** costs nothing at all — no shipping either.

It returns `{ subtotal, discount, shipping, total }`, where `discount` = bulk + coupon discount and
`total` = subtotal − discount + shipping. The correct implementation is shown below. Five hidden
mutants each break exactly one of rules 2–4 (one for each "or more" boundary, the cap, what shipping
is based on, and the empty cart). Your tests must all **pass** on the correct code and at least one
must **fail** on every mutant.

hint: For every "or more" in the rules, test the exact boundary value: 10 units, 5000 cents.
hint: A 100 % coupon should behave like a 50 % coupon.
hint: Shipping depends on the price *after* discounts — find a cart that is over 5000 before the coupon and under 5000 after.
hint: What does `quote([])` return? Compare the whole object with `toEqual`.

```ts impl
export type Line = { unitCents: number; qty: number }

export function quote(lines: Line[], couponPercent = 0) {
  let subtotal = 0
  let bulkDiscount = 0
  for (const l of lines) {
    const lineTotal = l.unitCents * l.qty
    subtotal += lineTotal
    if (l.qty >= 10) bulkDiscount += Math.round(lineTotal * 0.1)
  }
  const pct = Math.min(Math.max(couponPercent, 0), 50)
  const afterBulk = subtotal - bulkDiscount
  const couponDiscount = Math.round((afterBulk * pct) / 100)
  const discounted = afterBulk - couponDiscount
  const shipping = lines.length === 0 || discounted >= 5000 ? 0 : 499
  return { subtotal, discount: bulkDiscount + couponDiscount, shipping, total: discounted + shipping }
}
```

```ts mutant
export type Line = { unitCents: number; qty: number }

export function quote(lines: Line[], couponPercent = 0) {
  let subtotal = 0
  let bulkDiscount = 0
  for (const l of lines) {
    const lineTotal = l.unitCents * l.qty
    subtotal += lineTotal
    if (l.qty > 10) bulkDiscount += Math.round(lineTotal * 0.1)
  }
  const pct = Math.min(Math.max(couponPercent, 0), 50)
  const afterBulk = subtotal - bulkDiscount
  const couponDiscount = Math.round((afterBulk * pct) / 100)
  const discounted = afterBulk - couponDiscount
  const shipping = lines.length === 0 || discounted >= 5000 ? 0 : 499
  return { subtotal, discount: bulkDiscount + couponDiscount, shipping, total: discounted + shipping }
}
```

```ts mutant
export type Line = { unitCents: number; qty: number }

export function quote(lines: Line[], couponPercent = 0) {
  let subtotal = 0
  let bulkDiscount = 0
  for (const l of lines) {
    const lineTotal = l.unitCents * l.qty
    subtotal += lineTotal
    if (l.qty >= 10) bulkDiscount += Math.round(lineTotal * 0.1)
  }
  const pct = Math.max(couponPercent, 0)
  const afterBulk = subtotal - bulkDiscount
  const couponDiscount = Math.round((afterBulk * pct) / 100)
  const discounted = afterBulk - couponDiscount
  const shipping = lines.length === 0 || discounted >= 5000 ? 0 : 499
  return { subtotal, discount: bulkDiscount + couponDiscount, shipping, total: discounted + shipping }
}
```

```ts mutant
export type Line = { unitCents: number; qty: number }

export function quote(lines: Line[], couponPercent = 0) {
  let subtotal = 0
  let bulkDiscount = 0
  for (const l of lines) {
    const lineTotal = l.unitCents * l.qty
    subtotal += lineTotal
    if (l.qty >= 10) bulkDiscount += Math.round(lineTotal * 0.1)
  }
  const pct = Math.min(Math.max(couponPercent, 0), 50)
  const afterBulk = subtotal - bulkDiscount
  const couponDiscount = Math.round((afterBulk * pct) / 100)
  const discounted = afterBulk - couponDiscount
  const shipping = lines.length === 0 || discounted > 5000 ? 0 : 499
  return { subtotal, discount: bulkDiscount + couponDiscount, shipping, total: discounted + shipping }
}
```

```ts mutant
export type Line = { unitCents: number; qty: number }

export function quote(lines: Line[], couponPercent = 0) {
  let subtotal = 0
  let bulkDiscount = 0
  for (const l of lines) {
    const lineTotal = l.unitCents * l.qty
    subtotal += lineTotal
    if (l.qty >= 10) bulkDiscount += Math.round(lineTotal * 0.1)
  }
  const pct = Math.min(Math.max(couponPercent, 0), 50)
  const afterBulk = subtotal - bulkDiscount
  const couponDiscount = Math.round((afterBulk * pct) / 100)
  const discounted = afterBulk - couponDiscount
  const shipping = lines.length === 0 || subtotal >= 5000 ? 0 : 499
  return { subtotal, discount: bulkDiscount + couponDiscount, shipping, total: discounted + shipping }
}
```

```ts mutant
export type Line = { unitCents: number; qty: number }

export function quote(lines: Line[], couponPercent = 0) {
  let subtotal = 0
  let bulkDiscount = 0
  for (const l of lines) {
    const lineTotal = l.unitCents * l.qty
    subtotal += lineTotal
    if (l.qty >= 10) bulkDiscount += Math.round(lineTotal * 0.1)
  }
  const pct = Math.min(Math.max(couponPercent, 0), 50)
  const afterBulk = subtotal - bulkDiscount
  const couponDiscount = Math.round((afterBulk * pct) / 100)
  const discounted = afterBulk - couponDiscount
  const shipping = discounted >= 5000 ? 0 : 499
  return { subtotal, discount: bulkDiscount + couponDiscount, shipping, total: discounted + shipping }
}
```

```ts starter
test('a small cart pays shipping', () => {
  const q = quote([{ unitCents: 1500, qty: 2 }])
  expect(q.total).toBe(3499)
})
```

```ts solution
test('an empty cart costs nothing', () => {
  expect(quote([])).toEqual({ subtotal: 0, discount: 0, shipping: 0, total: 0 })
})
test('exactly 10 units get the bulk discount', () => {
  expect(quote([{ unitCents: 100, qty: 10 }])).toEqual({ subtotal: 1000, discount: 100, shipping: 499, total: 1399 })
})
test('coupons are capped at 50 %', () => {
  expect(quote([{ unitCents: 2000, qty: 1 }], 80)).toMatchObject({ discount: 1000, total: 1499 })
})
test('exactly 5000 after discounts ships free', () => {
  expect(quote([{ unitCents: 5000, qty: 1 }])).toMatchObject({ shipping: 0, total: 5000 })
})
test('free shipping looks at the price after the coupon', () => {
  expect(quote([{ unitCents: 6000, qty: 1 }], 20)).toMatchObject({ discount: 1200, shipping: 499, total: 5299 })
})
```
:::

Notice what the starter test did: it's a perfectly reasonable "happy path" test, it would give the
function high coverage, and it kills **zero** mutants. Every real bug lived at a boundary or in a
rule interaction.

Permission checks deserve the same treatment — and an extra rule: **the most important tests are the
ones that expect `false`.** A permission bug that grants too little gets reported by an annoyed
user within an hour. A bug that grants too much is silent until it's a security incident (see
**Web Security for Full-Stack Devs**, broken access control).

:::challenge id=pro-10-c2 lang=ts mode=tests xp=70
title: Catch the permission bugs
`canEdit(user, doc)` decides whether a user may edit a document. The rules, in priority order:

1. A **suspended** user can never edit — not even an admin.
2. An **admin** can edit any document, locked or not.
3. The document's **owner** can edit it, even when it's locked.
4. A **locked** document can't be edited by anyone else.
5. Otherwise, only a member with role **`editor`** can edit. Viewers and non-members can't.

The correct implementation is shown below. Six hidden mutants each get exactly one rule wrong (three
of them break rule 5 in different ways: one lets non-members through, one lets viewers through, one
checks the wrong member). Your
tests must all **pass** on the correct code and at least one must **fail** on every mutant.

Use small **builders** with valid defaults (e.g. `aUser({ isAdmin: true })`) so each test shows only
the fact it's about. Avoid naming anything `user` — that name is taken in the sandbox. The types
`Role`, `User` and `Doc` from the implementation are available to your tests.

hint: Write one test per rule, and for each rule test the case that must be **denied**.
hint: What happens to a suspended admin? To an owner of a locked document?
hint: A user who is not in `members` at all is a different case from a `viewer`.
hint: Put a *different* user in the document as `editor`, then ask whether a viewer can edit. Does the code check the right member?

```ts impl
export type Role = 'owner' | 'editor' | 'viewer'
export type User = { id: string; isAdmin: boolean; suspended: boolean }
export type Doc = { ownerId: string; locked: boolean; members: { userId: string; role: Role }[] }

export function canEdit(u: User, doc: Doc): boolean {
  if (u.suspended) return false
  if (u.isAdmin) return true
  if (doc.ownerId === u.id) return true
  if (doc.locked) return false
  const m = doc.members.find((m) => m.userId === u.id)
  return m?.role === 'editor'
}
```

```ts mutant
export type Role = 'owner' | 'editor' | 'viewer'
export type User = { id: string; isAdmin: boolean; suspended: boolean }
export type Doc = { ownerId: string; locked: boolean; members: { userId: string; role: Role }[] }

export function canEdit(u: User, doc: Doc): boolean {
  if (u.isAdmin) return true
  if (u.suspended) return false
  if (doc.ownerId === u.id) return true
  if (doc.locked) return false
  const m = doc.members.find((m) => m.userId === u.id)
  return m?.role === 'editor'
}
```

```ts mutant
export type Role = 'owner' | 'editor' | 'viewer'
export type User = { id: string; isAdmin: boolean; suspended: boolean }
export type Doc = { ownerId: string; locked: boolean; members: { userId: string; role: Role }[] }

export function canEdit(u: User, doc: Doc): boolean {
  if (u.suspended) return false
  if (u.isAdmin) return true
  if (doc.locked) return false
  if (doc.ownerId === u.id) return true
  const m = doc.members.find((m) => m.userId === u.id)
  return m?.role === 'editor'
}
```

```ts mutant
export type Role = 'owner' | 'editor' | 'viewer'
export type User = { id: string; isAdmin: boolean; suspended: boolean }
export type Doc = { ownerId: string; locked: boolean; members: { userId: string; role: Role }[] }

export function canEdit(u: User, doc: Doc): boolean {
  if (u.suspended) return false
  if (u.isAdmin) return true
  if (doc.ownerId === u.id) return true
  if (doc.locked) return false
  const m = doc.members.find((m) => m.userId === u.id)
  return m?.role !== 'viewer'
}
```

```ts mutant
export type Role = 'owner' | 'editor' | 'viewer'
export type User = { id: string; isAdmin: boolean; suspended: boolean }
export type Doc = { ownerId: string; locked: boolean; members: { userId: string; role: Role }[] }

export function canEdit(u: User, doc: Doc): boolean {
  if (u.suspended) return false
  if (u.isAdmin) return true
  if (doc.ownerId === u.id) return true
  if (doc.locked) return false
  const m = doc.members.find((m) => m.userId === u.id)
  return m !== undefined
}
```

```ts mutant
export type Role = 'owner' | 'editor' | 'viewer'
export type User = { id: string; isAdmin: boolean; suspended: boolean }
export type Doc = { ownerId: string; locked: boolean; members: { userId: string; role: Role }[] }

export function canEdit(u: User, doc: Doc): boolean {
  if (u.suspended) return false
  if (u.isAdmin) return true
  if (doc.ownerId === u.id) return true
  const m = doc.members.find((m) => m.userId === u.id)
  return m?.role === 'editor'
}
```

```ts mutant
export type Role = 'owner' | 'editor' | 'viewer'
export type User = { id: string; isAdmin: boolean; suspended: boolean }
export type Doc = { ownerId: string; locked: boolean; members: { userId: string; role: Role }[] }

export function canEdit(u: User, doc: Doc): boolean {
  if (u.suspended) return false
  if (u.isAdmin) return true
  if (doc.ownerId === u.id) return true
  if (doc.locked) return false
  return doc.members.some((m) => m.role === 'editor')
}
```

```ts starter
test('an editor can edit an unlocked document', () => {
  const doc = { ownerId: 'owner', locked: false, members: [{ userId: 'u1', role: 'editor' as Role }] }
  expect(canEdit({ id: 'u1', isAdmin: false, suspended: false }, doc)).toBe(true)
})
```

```ts solution
const aUser = (over: Partial<User> = {}): User => ({ id: 'u1', isAdmin: false, suspended: false, ...over })
const aDoc = (over: Partial<Doc> = {}): Doc => ({ ownerId: 'owner', locked: false, members: [], ...over })
const asMember = (userId: string, role: Role) => ({ userId, role })

test('an editor can edit an unlocked document', () => {
  expect(canEdit(aUser(), aDoc({ members: [asMember('u1', 'editor')] }))).toBe(true)
})
test('a suspended admin cannot edit', () => {
  expect(canEdit(aUser({ isAdmin: true, suspended: true }), aDoc())).toBe(false)
})
test('the owner can edit a locked document', () => {
  expect(canEdit(aUser({ id: 'owner' }), aDoc({ locked: true }))).toBe(true)
})
test('an editor cannot edit a locked document', () => {
  expect(canEdit(aUser(), aDoc({ locked: true, members: [asMember('u1', 'editor')] }))).toBe(false)
})
test('a non-member cannot edit', () => {
  expect(canEdit(aUser(), aDoc())).toBe(false)
})
test('a viewer cannot edit, even if someone else is an editor', () => {
  const doc = aDoc({ members: [asMember('u2', 'editor'), asMember('u1', 'viewer')] })
  expect(canEdit(aUser(), doc)).toBe(false)
})
```
:::

:::info title="The last mutant is a real-world bug"
`doc.members.some(m => m.role === 'editor')` asks "does this document have *any* editor?" instead
of "is *this user* an editor?". It passes every test where the only member is the caller — which is
what most hand-written tests look like. It's a classic broken-access-control bug, and only a test
with **two different members** catches it.
:::

## Testing in PR review

Reviewing tests is part of reviewing code (**Teamwork, Agile & Code Review** covers the etiquette).
The tests are the PR's *specification*: they tell the reviewer what the author thinks the code should
do. Questions worth asking:

- **"Would a test fail if I reverted the production change?"** For a bug fix, the PR should contain a
  test that was red before the fix. If not, the bug can come back unnoticed.
- **Do test names read like requirements?** `Expired_invitation_is_rejected_with_410` beats `Test3`.
  A failing name in CI should tell you what broke without opening the file.
- **Is the level right?** Arithmetic in Playwright, or a SQL filter tested with a mocked repository,
  are both smells.
- **Is anything mocked that shouldn't be?** Especially the database or the class under test.
- **Do assertions check behaviour or implementation?** `Received(1).SaveChangesAsync()` and CSS
  class names break on refactors; status codes, response bodies and visible text don't.
- **Is the data visible?** Builders with overrides, not magic ids from a seed file.
- **Any timing smells?** `sleep`, `Task.Delay`, `waitForTimeout`, `DateTime.Now` → future flakes.
- **What's missing?** The `false` cases of a permission check, the empty list, the boundary,
  the error path the UI depends on.

:::quiz id=pro-10-q7 xp=10
A PR titled *"Fix: members on the Free plan could exceed the 10-member limit"* changes one line
(`>` to `>=`) in `PlanLimits.CanAddMember` and adds no tests. CI is green with 94 % coverage. What's
the most valuable review comment?

- [ ] "LGTM — coverage is above our 90 % threshold."
- [ ] "Please add a Playwright test that invites 11 members through the UI."
- [x] "Can you add a test that fails without this change — e.g. a Free project with exactly 10 members can't add an 11th?"
- [ ] "Please rename `CanAddMember` to `IsMemberAdditionAllowed`."
> A bug fix without a test that reproduces the bug can silently regress — nothing would turn red
> if someone flipped the operator back. The coverage number is the tempting answer, but it was
> green *with the bug present*, which proves it doesn't measure this. A unit test at the boundary (10
> members) is cheap and precise; a Playwright test inviting 11 people is slow and way out of proportion
> to a one-line rule. The rename is a matter of taste, not the important point.
:::

:::job title="What you'll meet on day one"
- A CI pipeline that runs `npm test`, `dotnet test` and maybe a Playwright smoke job — and branch
  protection that blocks merge when they're red (**CI with GitHub Actions**).
- A team rule like "every bug fix comes with a test that reproduces it" and "new endpoints need an
  integration test". Ask about it in week one; it's often unwritten.
- A few known-flaky tests and a quarantine label. Fixing one is a great first PR: it's small, well-
  defined, and everyone is grateful.
- Reviewers who ask "where's the test?" before they read your code. Write the test first and
  link it in the PR description.
:::

## A test plan for a feature, end to end

A **test plan** is a short document (half a page in the ticket or PR) that answers: *what could go
wrong, and which test catches each risk at the cheapest level?* Writing it **before** coding is a
strong senior habit — it often exposes unclear requirements ("what happens if the invited email
already has an account?") while they're cheap to fix.

**Feature:** *Invite a collaborator.* On the project settings page, the owner enters an email and
clicks **Invite**. The API creates a pending invitation with role `Editor` and sends an email.
Only the owner may invite. Free projects have at most 10 members. Duplicate invites are rejected.
Invitations expire after 7 days.

**Step 1 — list the risks**, not the tests. Ask: what would hurt users, money, data or security?

**Step 2 — assign each risk to the cheapest level that really catches it:**

| # | Risk | Level | Test |
|---|---|---|---|
| 1 | Free plan allows an 11th member (off-by-one) | Unit (xUnit) | `PlanLimits`: 9 → allowed, 10 → rejected; Pro → no limit |
| 2 | Expiry computed wrong (time zones, `Now`) | Unit (xUnit + `FakeTimeProvider`) | Created + 7 days − 1 s valid; + 7 days expired |
| 3 | A non-owner can invite (IDOR) | API integration | `POST /api/projects/{id}/invitations` as an editor → 403; as a stranger → 404 or 403 |
| 4 | Duplicate invite creates two rows | API integration (real Postgres) | Second invite for the same email → 409; exactly one row (unique index) |
| 5 | Email sent even when the save failed | API integration (fake `IEmailSender`) | On 409, the fake recorded **zero** emails |
| 6 | API and web disagree on the response / error shape | Contract | 201 body shape; 409 `ProblemDetails` with `type` ending `/plan-limit`; 403 |
| 7 | UI shows a generic error for "plan full" | Component (Vitest + RTL) | Mock `fetch` → 409 plan-limit; the alert says "Upgrade to add more members" |
| 8 | Invalid email submitted / double-click sends twice | Component | Invalid email → inline error, no request; button disabled while pending |
| 9 | The whole flow doesn't work in a real browser | E2E (Playwright) | **One** journey: owner invites → invitation appears in the list |

**Step 3 — write down what you deliberately *won't* test**, and why: the email template's styling
(manual check once), the identity provider (not ours), every validation message via Playwright
(component tests cover them).

Notice the shape: most tests at unit and integration level, one contract per interaction, one e2e
journey. That's the honeycomb and trophy combined — and every row exists because of a named risk.

:::pro title="Tests as a design tool"
If a risk is hard to test, the design is usually telling you something. "Expiry is hard to test"
→ inject `TimeProvider`. "The permission check is hard to test" → it's tangled into the controller;
extract a pure `canInvite(user, project)` and unit-test it, then keep one integration test proving
the endpoint calls it. Testable code and well-designed code are mostly the same thing.
:::

:::lab id=pro-10-lab1 xp=90
title: A test plan and a consumer-driven contract
You'll do the two things a senior does for a new feature: write the **test plan**, then build a
small **contract test** in the Pact style — a contract file written by the consumer, a consumer test
and a provider verification. To keep it runnable anywhere, the "provider" is a tiny Node HTTP server
standing in for the ASP.NET API; at the end you'll see what the same verification looks like in C#.

You need Node.js 22 or newer.

**1. Create the project**

```bash
mkdir invite-contract && cd invite-contract
mkdir -p src tests contracts
```

`package.json`:

```json
{
  "name": "invite-contract",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run"
  }
}
```

```bash
npm install -D vitest @types/node
```

**2. The consumer's code** — the frontend API client. It's what the React page would call.

`src/inviteClient.ts`:

```ts
export type Invitation = { id: string; email: string; role: 'Editor' | 'Viewer'; status: 'Pending' | 'Accepted' }
export type InviteResult =
  | { ok: true; invitation: Invitation }
  | { ok: false; reason: 'plan-limit' | 'forbidden' | 'unknown' }

export async function inviteMember(
  baseUrl: string,
  projectId: number,
  email: string,
  fetchFn: typeof fetch = fetch,
): Promise<InviteResult> {
  const res = await fetchFn(`${baseUrl}/api/projects/${projectId}/invitations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  if (res.status === 201) return { ok: true, invitation: (await res.json()) as Invitation }
  if (res.status === 403) return { ok: false, reason: 'forbidden' }
  if (res.status === 409) {
    const problem = (await res.json()) as { type?: string }
    if (problem.type?.endsWith('/plan-limit')) return { ok: false, reason: 'plan-limit' }
  }
  return { ok: false, reason: 'unknown' }
}
```

**3. The contract** — written by the consumer. Each interaction has a **provider state** (the data
the provider must set up), the request, and the response the consumer relies on. Body values are
*examples*; only their **shape** is checked. The optional `match` object pins the few **values** the
consumer depends on with a regex — the enum values it displays and the error `type` it branches on.

`contracts/web-projects-api.json`:

```json
{
  "consumer": "web",
  "provider": "projects-api",
  "interactions": [
    {
      "description": "owner invites a collaborator",
      "state": "project 42 is on the Free plan with 3 members and the caller owns it",
      "request": { "method": "POST", "path": "/api/projects/42/invitations", "body": { "email": "sam@example.com" } },
      "response": {
        "status": 201,
        "body": { "id": "inv_1", "email": "sam@example.com", "role": "Editor", "status": "Pending" },
        "match": { "$.role": "^(Editor|Viewer)$", "$.status": "^(Pending|Accepted)$" }
      }
    },
    {
      "description": "the free plan is full",
      "state": "project 42 is on the Free plan with 10 members and the caller owns it",
      "request": { "method": "POST", "path": "/api/projects/42/invitations", "body": { "email": "sam@example.com" } },
      "response": {
        "status": 409,
        "body": { "type": "https://errors.example.com/plan-limit", "title": "Member limit reached", "status": 409 },
        "match": { "$.type": "/plan-limit$" }
      }
    },
    {
      "description": "the caller is not the owner",
      "state": "project 42 exists and the caller does not own it",
      "request": { "method": "POST", "path": "/api/projects/42/invitations", "body": { "email": "sam@example.com" } },
      "response": {
        "status": 403,
        "body": { "type": "https://errors.example.com/forbidden", "title": "Only the owner can invite", "status": 403 }
      }
    }
  ]
}
```

**4. A contract loader, a shape matcher and a value matcher** (Pact ships these; here they're 40
lines so you can see there's no magic).

`tests/contract.ts`:

```ts
import { readFileSync } from 'node:fs'

export type Interaction = {
  description: string
  state: string
  request: { method: string; path: string; body: { email: string } }
  // match: JSON path -> regex for values the consumer BRANCHES on (enum values, error types)
  response: { status: number; body: unknown; match?: Record<string, string> }
}

export const contract = JSON.parse(
  readFileSync(new URL('../contracts/web-projects-api.json', import.meta.url), 'utf8'),
) as { consumer: string; provider: string; interactions: Interaction[] }

const kind = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

// Compares the SHAPE of actual vs expected: every expected key exists with the same JSON type.
// Values are not compared (ids differ per run). Extra keys in actual are allowed: adding a field is not breaking.
export function shapeErrors(actual: unknown, expected: unknown, path = '$'): string[] {
  if (kind(actual) !== kind(expected)) return [`${path}: expected ${kind(expected)}, got ${kind(actual)}`]
  if (kind(expected) === 'object') {
    const a = actual as Record<string, unknown>
    return Object.entries(expected as Record<string, unknown>).flatMap(([key, value]) =>
      key in a ? shapeErrors(a[key], value, `${path}.${key}`) : [`${path}.${key}: missing`],
    )
  }
  if (kind(expected) === 'array' && (expected as unknown[]).length > 0) {
    return (actual as unknown[]).flatMap((item, i) => shapeErrors(item, (expected as unknown[])[0], `${path}[${i}]`))
  }
  return []
}

// Checks the few VALUES the consumer relies on, like Pact's regex matcher. Paths are simple: "$.a.b".
export function matchErrors(actual: unknown, match: Record<string, string> = {}): string[] {
  return Object.entries(match).flatMap(([path, pattern]) => {
    const value = path
      .split('.')
      .slice(1)
      .reduce<unknown>((v, key) => (v as Record<string, unknown> | undefined)?.[key], actual)
    if (value === undefined) return [] // a missing key is already reported by shapeErrors
    return new RegExp(pattern).test(String(value)) ? [] : [`${path}: ${JSON.stringify(value)} does not match /${pattern}/`]
  })
}
```

**5. The consumer test** — proves the client sends exactly the contract's request and handles
every contract response. It runs in the **frontend's** CI. Note that the fake `fetch` returns the
contract's example body: the consumer is tested against the *contract*, never against a hand-written
mock that could drift.

`tests/consumer.contract.test.ts`:

```ts
import { expect, test, vi } from 'vitest'
import { inviteMember } from '../src/inviteClient'
import { contract, matchErrors } from './contract'

// What the UI needs from each interaction. A new interaction without an entry here fails the first test.
const expected: Record<string, object> = {
  'owner invites a collaborator': { ok: true, invitation: { role: 'Editor' } },
  'the free plan is full': { ok: false, reason: 'plan-limit' },
  'the caller is not the owner': { ok: false, reason: 'forbidden' },
}

test('every interaction in the contract is handled by the consumer', () => {
  expect(contract.interactions.map((i) => i.description).sort()).toEqual(Object.keys(expected).sort())
  // The examples must satisfy their own matchers, or the contract contradicts itself.
  for (const i of contract.interactions) expect(matchErrors(i.response.body, i.response.match)).toEqual([])
})

for (const i of contract.interactions) {
  test(`consumer: ${i.description}`, async () => {
    const fetchFn = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify(i.response.body), {
        status: i.response.status,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const projectId = Number(i.request.path.split('/')[3])

    const result = await inviteMember('http://api.test', projectId, i.request.body.email, fetchFn as unknown as typeof fetch)

    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe(`http://api.test${i.request.path}`)
    expect(init.method).toBe(i.request.method)
    expect(JSON.parse(init.body as string)).toEqual(i.request.body)
    expect(result).toMatchObject(expected[i.description])
  })
}
```

**6. The provider** — a stand-in for the ASP.NET Core endpoint. Authentication is simplified to an
`X-User-Id` header, like the fake auth handler in an integration test.

`src/provider.ts`:

```ts
import { createServer, type Server } from 'node:http'

export type Project = { ownerId: string; plan: 'Free' | 'Pro'; members: string[] }
export type Db = { projects: Map<number, Project>; nextInvite: number }

export function createApp(db: Db): Server {
  return createServer(async (req, res) => {
    const send = (status: number, body: unknown) =>
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
    const match = req.url?.match(/^\/api\/projects\/(\d+)\/invitations$/)
    if (req.method !== 'POST' || !match) return send(404, { title: 'Not found', status: 404 })

    let raw = ''
    for await (const chunk of req) raw += chunk
    const { email } = JSON.parse(raw || '{}') as { email?: string }

    const project = db.projects.get(Number(match[1]))
    if (!project) return send(404, { title: 'Not found', status: 404 })
    if (project.ownerId !== req.headers['x-user-id'])
      return send(403, { type: 'https://errors.example.com/forbidden', title: 'Only the owner can invite', status: 403 })
    if (project.plan === 'Free' && project.members.length >= 10)
      return send(409, { type: 'https://errors.example.com/plan-limit', title: 'Member limit reached', status: 409 })

    send(201, { id: `inv_${db.nextInvite++}`, email, role: 'Editor', status: 'Pending' })
  })
}
```

**7. The provider verification** — replays every interaction against the real provider and checks
the status, the shape and the pinned values. It runs in the **API's** CI. Provider states are the
provider's job: turning a sentence into seeded data. A fresh `Db` per test plays the role of
"reset the database between tests".

`tests/provider.contract.test.ts`:

```ts
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { expect, test } from 'vitest'
import { createApp, type Db } from '../src/provider'
import { contract, matchErrors, shapeErrors } from './contract'

const members = (n: number) => Array.from({ length: n }, (_, i) => `member-${i}`)

// Each state seeds the database and returns the id of the calling user.
const states: Record<string, (db: Db) => string> = {
  'project 42 is on the Free plan with 3 members and the caller owns it': (db) => {
    db.projects.set(42, { ownerId: 'owner-1', plan: 'Free', members: members(3) })
    return 'owner-1'
  },
  'project 42 is on the Free plan with 10 members and the caller owns it': (db) => {
    db.projects.set(42, { ownerId: 'owner-1', plan: 'Free', members: members(10) })
    return 'owner-1'
  },
  'project 42 exists and the caller does not own it': (db) => {
    db.projects.set(42, { ownerId: 'owner-1', plan: 'Free', members: members(3) })
    return 'someone-else'
  },
}

for (const i of contract.interactions) {
  test(`provider: ${i.description}`, async () => {
    const setUp = states[i.state]
    expect(setUp, `no provider state named "${i.state}"`).toBeDefined()
    const db: Db = { projects: new Map(), nextInvite: 1 }
    const callerId = setUp(db)

    const server = createApp(db).listen(0)
    await once(server, 'listening')
    const { port } = server.address() as AddressInfo
    try {
      const res = await fetch(`http://127.0.0.1:${port}${i.request.path}`, {
        method: i.request.method,
        headers: { 'Content-Type': 'application/json', 'X-User-Id': callerId },
        body: JSON.stringify(i.request.body),
      })
      expect(res.status).toBe(i.response.status)
      const body = await res.json()
      expect([...shapeErrors(body, i.response.body), ...matchErrors(body, i.response.match)]).toEqual([])
    } finally {
      server.close()
    }
  })
}
```

**8. Run it**

```bash
npm test
```

Expected output at the end (timings will differ; in an interactive terminal Vitest also lists each file with a ✓):

```text
 Test Files  2 passed (2)
      Tests  7 passed (7)
```

**9. Break the contract on purpose.** In `src/provider.ts`, rename the response field `role` to
`roleName` (the "harmless backend refactor"), and run `npm test` again:

```text
 ❯ tests/provider.contract.test.ts (3 tests | 1 failed)
   × provider: owner invites a collaborator

 FAIL  tests/provider.contract.test.ts > provider: owner invites a collaborator
AssertionError: expected [ '$.role: missing' ] to deeply equal []

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 6 passed (7)
```

The consumer suite is still green — it trusts the contract — and the **provider** suite pinpoints
the exact field. That's the PR that would have broken production, now red before merge. Undo the
rename.

Now try the two *value* changes that a pure shape check would miss — the shape is unchanged, only
the value differs:

- Return `role: 'editor'` instead of `'Editor'` (the enum-casing bug from the contract-test quiz).
- Change the 409 `type` to `https://errors.example.com/member-limit`.

Each makes exactly one provider test fail, with a message like
`$.role: "editor" does not match /^(Editor|Viewer)$/`. To see why the `match` entries matter,
temporarily delete the `"match"` line from the 409 interaction and repeat the `member-limit` change:
all 7 tests pass, yet the real UI would now show a generic error instead of "Upgrade to add more
members". Restore the line and undo the change.

:::tip title="The same verification in ASP.NET Core"
In a real repo the provider verification is an xUnit test using your integration-test factory
(**Integration Tests with WebApplicationFactory & Testcontainers**). A sketch — `ProviderStates`,
`CreateClientAs` and `Shape` are your own small helpers, the same ideas as above:

```csharp
public class WebContractTests(ApiFactory factory) : IClassFixture<ApiFactory>
{
    public static TheoryData<string> Interactions =>
        new(Contract.Load("web-projects-api.json").Interactions.Select(i => i.Description));

    [Theory, MemberData(nameof(Interactions))]
    public async Task Api_honours_the_web_contract(string description)
    {
        var i = Contract.Load("web-projects-api.json").Interactions.Single(x => x.Description == description);
        var callerId = await ProviderStates.ApplyAsync(i.State, factory.Services); // seeds real Postgres
        using var client = factory.CreateClientAs(callerId);                       // test auth handler

        var response = await client.PostAsJsonAsync(i.Request.Path, i.Request.Body);

        Assert.Equal(i.Response.Status, (int)response.StatusCode);
        Assert.Empty(Shape.Errors(await response.Content.ReadFromJsonAsync<JsonElement>(), i.Response.Body));
    }
}
```

For several teams and services, use **PactNet** and **Pact JS** instead of hand-rolled helpers: they
add matchers (regex, "array of at least one"), a broker that stores contracts per version, and
`can-i-deploy` checks before a release.
:::

**10. Write the test plan.** Create `TEST-PLAN.md` for this feature *extension*: **"The owner can
change a member's role between Editor and Viewer; on Pro plans a project must always keep at least one
Editor besides the owner; an editor who is downgraded to Viewer loses access to their unsaved drafts."**
Use this template:

```text
# Test plan: change a member's role

## Risks (what could hurt users, data, money or security?)
1. ...

## Tests per risk
| # | Risk | Level (unit / API integration / contract / component / e2e) | Test (input -> expected) |
|---|------|------|------|

## Mocked vs real
- Mocked: ...  (why)
- Real: ...    (why)

## Deliberately not tested
- ...  (why)

## Open questions for the product owner
- ...
```

Aim for 6–10 risks, at least one permission risk with a *denied* case, and **at most two** e2e tests.

**11. Add a contract interaction** so both halves of the contract are yours. The smallest one that
fits the existing harness: *"sam is already invited"* → `409` with a `type` ending in
`/already-invited`. You need to touch all four places — that's the point:

- the contract JSON: the interaction, a new provider state sentence, and a `match` for the `type`;
- `inviteClient.ts`: a new reason `'already-invited'`, and `expected` in the consumer test;
- `provider.ts`: remember invited emails per project (e.g. an `invited: string[]` field) and return the 409;
- `states` in the provider test: seed a project where `sam@example.com` is already invited.

Then `npm test` should show 9 passing tests. *Stretch:* add the role-change interaction from your plan
(`PATCH /api/projects/42/members/{userId}` with `{ "role": "Viewer" }`). It needs a second client
function, a wider `request.body` type, and a consumer test that picks the client function by
`i.request.method`.

- [ ] `npm test` shows 2 test files and 7 tests passing (before you add your own interaction)
- [ ] Renaming `role` in the provider makes only the provider suite fail, naming `$.role`
- [ ] Returning `'editor'` or a `.../member-limit` error type makes exactly one provider test fail, via the `match` regexes
- [ ] I added a new interaction (e.g. "already invited" → 409) with a consumer expectation, a provider state and provider logic, and all tests pass (9 with the suggested one)
- [ ] `TEST-PLAN.md` lists 6–10 risks, each mapped to the cheapest level that catches it
- [ ] The plan says what is mocked, what is real, and what is deliberately not tested
- [ ] The plan contains at least one open question for the product owner
:::

## Flashcards

:::cards id=pro-10-cards1 xp=20 title="Testing strategy"
Q: Pyramid vs trophy vs honeycomb — one line each?
A: Pyramid: mostly unit tests, few UI tests (logic-heavy code). Trophy: static checks + mostly
   integration/component tests (React). Honeycomb: mostly tests of one service with its real
   dependencies, few unit and few cross-service tests (APIs, microservices).
Q: The single most useful question to ask about a test?
A: "Which realistic bug would make this test fail?" If you can't name one, it's cost without benefit.
Q: What do you mock, and what do you never mock?
A: Mock what's external or nondeterministic: payment/email/third-party APIs, time, randomness, the
   network in component tests. Don't mock the database in integration tests, your own small
   deterministic classes, DTOs, or the class under test.
Q: Why not the EF Core InMemory provider for API tests?
A: It ignores constraints, transactions and SQL translation, so unique-index, FK and query bugs pass
   in tests and fail in production. Use real Postgres in Testcontainers.
Q: What does a consumer-driven contract test check?
A: That the provider still accepts the requests the consumer sends and returns the response shapes
   (status, required fields and types) the consumer reads. It checks shapes, not values or business rules.
Q: When must a contract check a value, not just a shape?
A: When the consumer branches on it: enum values it displays or compares, an error `type` it maps to a
   message. Pin those few fields with a regex/exact matcher; type-only matching lets `"editor"` through.
Q: What is a provider state?
A: The precondition an interaction needs ("project 42 is full"); the provider's verification turns it into seeded data.
Q: What is a test data builder?
A: A helper that creates a valid object with unique, sensible defaults so each test overrides only
   the fields that matter to it — avoiding mystery guests and walls of setup.
Q: Top causes of flaky tests?
A: Time, shared state/order dependence, missing awaits, fixed sleeps, parallel resource collisions,
   real network calls, unordered results, culture/floating point.
Q: What's the flaky-test process?
A: Detect (history, repeat runs) → quarantine the same day with a ticket and owner → fix the root
   cause (not retries) → prove with repeated runs → un-quarantine.
Q: Why is coverage a bad target?
A: It measures lines executed, not behaviour checked; an assertion-free test gets 100 %. As a target
   it gets gamed (Goodhart). Use it to find untested code, ideally as diff coverage in PRs.
Q: What is mutation testing, and what is a surviving mutant?
A: A tool (Stryker.NET, StrykerJS) injects small bugs and runs your tests. A mutant that no test
   catches "survives" — behaviour your suite doesn't check (often a boundary).
Q: The key review question for a bug-fix PR?
A: "Is there a test that fails without this fix?" Otherwise the bug can silently come back.
:::

## Recap

- A test strategy spends a limited budget on **confidence vs speed, maintenance and precision**;
  ask of every test which realistic bug it catches.
- **Pyramid, trophy and honeycomb** are the same idea for different code: trophy for React, honeycomb
  with a pure-logic pyramid inside for an ASP.NET + Postgres API, plus a few Playwright journeys.
- **Contract tests** (Pact-style or OpenAPI diffs) close the gap between frontend and API suites —
  verified in the provider's CI, checking shapes, plus the few values (enums, error types) the UI branches on.
- **Mock** what's external or nondeterministic (payments, email, time, the network in component
  tests); **never mock** Postgres in integration tests, your own cheap classes, or the code under test.
- **Builders** with valid, unique defaults keep tests readable and parallel-safe; each test owns its data.
- **Flaky tests** have real causes (time, shared state, missing waits, sleeps); quarantine the same
  day, fix the root cause, don't hide it with retries.
- **Coverage** finds untested code but doesn't prove testing; **mutation testing** shows whether
  tests would notice a bug — boundaries and `false` cases of permission checks are where mutants survive.
- In **PR review**, ask for a test that fails without the change, check the level and the mocks,
  and look for missing denied/empty/boundary cases.
- A **feature test plan** lists risks first, maps each to the cheapest level that catches it, and
  states what's deliberately not tested.
