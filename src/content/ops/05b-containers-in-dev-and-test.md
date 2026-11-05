---
id: ops-18
title: "Containers in Dev & Test: Testcontainers, CI, Dev Containers & Aspire"
level: intermediate
minutes: 65
xp: 150
summary: How teams use containers every day before production — Testcontainers for real Postgres 18 and Redis 8 in xUnit, Compose and service containers in CI, Dev Containers and Codespaces, Aspire versus Compose, and debugging containers through their logs.
---

Most developers touch containers far more often on their laptop and in CI than in production. A
typical day looks like this: `dotnet test` quietly starts a Postgres container and removes it again,
the pull request pipeline does the same on a GitHub runner, a new colleague opens the repo in a
**Dev Container** and has a working setup in ten minutes, and `aspire run` (or `docker compose up`)
starts the whole local stack with a dashboard.

In each case, containers solve the same problem as in production: **"works on my machine"**. This
time the machines are your laptop, a colleague's laptop and the CI runner, and the thing that
differs between them is the *dependencies*: which Postgres version, which Redis, which extensions,
which ports are free.

This lesson builds on **Docker Compose for the Full Stack** (ops-05) and **Networks and Volumes**
(ops-06). The ASP.NET side of integration testing (`WebApplicationFactory`, fake auth, Respawn) is
covered in **Integration Tests with WebApplicationFactory & Testcontainers** (be-15). Here we focus
on the container mechanics underneath, which are what break when a test suite "only fails in CI".

## Four places containers show up before production

| Where | Tool | Who starts the containers | Lifetime |
|---|---|---|---|
| Integration tests | **Testcontainers** | Your test code, through the Docker API | One test run (seconds to minutes) |
| CI pipeline | **`services:`** in GitHub Actions, or **Compose** | The CI runner | One job |
| Development environment | **Dev Containers** / Codespaces | Your editor | Days to weeks |
| Local orchestration | **Aspire** AppHost, or **Compose** | `aspire run` / `docker compose up` | One working session |

They are not competitors. Many repos use three of the four: Compose or Aspire to *run* the app,
Testcontainers to *test* it, and a Dev Container so nobody has to install .NET 10 and Node 24 by
hand.

## Testcontainers: the mental model

**Testcontainers** is a library, not a CLI wrapper. Your test process talks directly to the Docker
Engine API (the same socket `docker` uses: `/var/run/docker.sock`, a Podman socket, or a remote
`DOCKER_HOST`). It creates a container, waits until the service inside is *really* ready, tells you
where to connect, and removes it afterwards.

```text
 test process                          Docker Engine
 ─────────────                         ─────────────
 new PostgreSqlBuilder("postgres:18")
   .Build()            ── nothing happens yet (just configuration)
 await StartAsync()    ── pull image (first time) ─► create ─► start
                       ── wait strategy: poll pg_isready until it succeeds
 GetConnectionString() ── "Host=127.0.0.1;Port=49153;..."   (49153 = random host port)
   … your tests …
 await DisposeAsync()  ── stop + remove container
```

The modules (`Testcontainers.PostgreSql`, `Testcontainers.Redis`, `Testcontainers.RabbitMq`,
`Testcontainers.Keycloak`, …) know three things about each product: which port to expose, how to
tell when it's ready, and how to build a connection string.

```csharp
using Testcontainers.PostgreSql;
using Testcontainers.Redis;

var pg = new PostgreSqlBuilder("postgres:18")      // pin the major version you run in production
    .WithDatabase("shop")
    .WithUsername("shop")
    .WithPassword("shop")
    .Build();

var redis = new RedisBuilder("redis:8").Build();

await Task.WhenAll(pg.StartAsync(), redis.StartAsync());   // start in parallel

pg.GetConnectionString();        // Host=127.0.0.1;Port=49153;Database=shop;Username=shop;Password=shop
redis.GetConnectionString();     // 127.0.0.1:49154
pg.Hostname;                     // usually 127.0.0.1, see "Where is the container?" below
pg.GetMappedPublicPort(5432);    // 49153
```

### Why random host ports

Each container's port 5432 is published on a **random free host port**. That sounds like a nuisance
until you list what it prevents:

- your own Postgres on `localhost:5432` (from `docker compose up`) doesn't collide with the tests;
- two test projects, or two CI jobs on the same machine, can run at the same time;
- a container left over from a crashed run doesn't block the next run.

The price is that **you must never hardcode `localhost:5432`** in test configuration. Always ask the
container (`GetConnectionString()`, `GetMappedPublicPort()`) and push that value into your app's
configuration (be-15 does this with `UseSetting("ConnectionStrings:Db", …)`).

### Wait strategies: "started" is not "ready"

A container is *running* as soon as its process starts. Postgres is *ready* only after it has
initialised the data directory, run init scripts, **restarted**, and opened the socket. The official
image logs `database system is ready to accept connections` **twice**: once for the temporary
server that runs the init scripts, and once for the real one.

That's why the modules use real readiness checks (Postgres: `pg_isready` inside the container;
Redis: `redis-cli ping`) instead of "port is open". When you build a container for something
without a module, you choose the wait strategy yourself:

```csharp
var mailpit = new ContainerBuilder("axllent/mailpit:latest")
    .WithPortBinding(8025, assignRandomHostPort: true)
    .WithWaitStrategy(Wait.ForUnixContainer()
        .UntilHttpRequestIsSucceeded(r => r.ForPort(8025).ForPath("/livez")))
    .Build();
```

:::warn title="The two classic flaky-test causes"
1. **Waiting on the wrong signal**, for example "port 5432 is open", or the *first* "ready to accept
   connections" log line. The test connects while Postgres is restarting after init and fails about
   one run in twenty.
2. **`Task.Delay(2000)` "to be safe"**. That's too slow on your laptop and too short on a busy CI
   runner. Wait on a condition, never on a clock.
:::

:::quiz id=ops-18-q1 xp=10
Your `appsettings.Testing.json` contains `Host=localhost;Port=5432;…`, and the tests use a
Testcontainers Postgres. On your laptop they pass. In CI, every test fails with "connection refused".
What's the most likely cause?
- [ ] GitHub runners don't support Docker, so the container never started
- [x] The container's 5432 is published on a random host port; on your laptop the tests were actually talking to your own Compose Postgres on 5432
- [ ] Postgres 18 listens on a different port than 5432 by default
- [ ] `localhost` is blocked on CI runners for security reasons
> Testcontainers always maps to a **random** host port, so `localhost:5432` was never the test
> container. Locally it "worked" only because your dev database happened to be listening there, which
> also means the tests were polluting your dev data. Use `GetConnectionString()`. Docker is
> available on GitHub's Ubuntu runners, and Postgres 18 still uses 5432 inside the container.
:::

## Fixtures: how many containers, and how to isolate tests

Starting Postgres costs **1–3 seconds** (plus the image pull the first time). A typical test costs
**milliseconds**. So the question isn't "how do I start a container" but "how **few** containers can
I start while keeping tests independent?" In xUnit v3 the fixture type decides:

| Fixture | Declared with | Containers started | Typical use |
|---|---|---|---|
| None (in the test class constructor) | — | One **per test** | Almost never: slow |
| Class fixture | `IClassFixture<PgFixture>` | One per test class | Classes that need very different setups |
| Collection fixture | `[Collection("db")]` + `ICollectionFixture<PgFixture>` | One per collection | xUnit v2 suites; groups that must run sequentially |
| Assembly fixture (xUnit v3) | `[assembly: AssemblyFixture(typeof(PgFixture))]` | **One per test run** | The default for integration tests |

The fixture implements `IAsyncLifetime`: `InitializeAsync` starts the containers and applies the
schema, `DisposeAsync` removes them. xUnit v3's `IAsyncLifetime` returns `ValueTask`.

Once tests share a container, they share **data**, and you need an isolation strategy:

| Strategy | How | Trade-off |
|---|---|---|
| **Unique data per test** | Each test creates its own user / SKU / tenant (`Guid.NewGuid()`) | Fastest and parallel-safe; queries like "count all rows" need care |
| **Reset between tests** | Respawn deletes all rows (be-15) | Simple mental model; forces sequential tests |
| **Transaction per test** | Begin in setup, roll back in teardown | Fast, but breaks if the code under test commits or uses several connections |
| **Database per test class** | `CREATE DATABASE t1 TEMPLATE app_template` | Full isolation in ~100 ms; more setup code |
| **Redis** | Key prefix per test, or `FLUSHDB` in a reset step | Prefixes allow parallel tests; `FLUSHDB` doesn't |

:::quiz id=ops-18-q2 xp=10
A test assembly has 5 test classes. Each implements `IClassFixture<InfraFixture>`, and
`InfraFixture` starts a Postgres and a Redis container. xUnit runs test classes from different
collections in parallel (each class is its own collection by default). What happens during
`dotnet test`?
- [ ] 2 containers start, shared by all classes
- [x] 10 containers start, up to all at once, and each class has its own private database
- [ ] 5 containers start, because xUnit merges the Postgres and Redis containers of one fixture
- [ ] The run fails because two Postgres containers can't both use port 5432
> A class fixture is created **once per test class**, so 5 classes × 2 containers = 10, and since
> classes run in parallel they start roughly at the same time. That works, because random host ports
> mean there's no port clash, but it costs memory and start-up time. Switch to an **assembly fixture**
> (or a collection fixture) to share one pair of containers, and isolate tests by data instead.
:::

## Ryuk, cleanup and reuse

What happens if you stop the debugger in the middle of a test, or CI kills the job on a timeout?
`DisposeAsync` never runs. Without help, you'd collect dozens of orphaned Postgres containers.

**Ryuk** is that help. On the first container start, Testcontainers launches a tiny sidecar
container (`testcontainers/ryuk`) and keeps a TCP connection open to it. Every container, network and
volume the session creates gets a label with the session id. When the connection drops, whether the
run ended cleanly or the process was killed, Ryuk waits about 10 seconds and then removes everything
with that label. Then it exits.

```bash
docker ps --filter label=org.testcontainers=true
# CONTAINER ID  IMAGE                          ...  NAMES
# 84fbc05b6825  testcontainers/ryuk:0.x        ...  testcontainers-ryuk-7ef2...
# 1c2d3e4f5a6b  postgres:18                    ...  vibrant_lamarr
# 9a8b7c6d5e4f  redis:8                        ...  eager_hopper
```

Configuration you'll meet. Each setting is an environment variable, or a key in
`~/.testcontainers.properties`. The two use different spellings: `TESTCONTAINERS_RYUK_DISABLED`
in the environment is `ryuk.disabled` in the file.

| Environment variable | Properties key | When |
|---|---|---|
| `DOCKER_HOST=unix:///run/user/1000/podman/podman.sock` | `docker.host` | Podman (run `systemctl --user enable --now podman.socket` once) |
| `TESTCONTAINERS_RYUK_DISABLED=true` | `ryuk.disabled` | Environments where Ryuk can't run (some rootless or locked-down setups). Then *you* must dispose reliably |
| `TESTCONTAINERS_HOST_OVERRIDE=host.docker.internal` | `host.override` | The test process runs *inside* a container on Docker Desktop and must reach ports published on the host (see the Dev Containers section) |
| `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` | `docker.socket.override` | The socket path Ryuk should mount, if it differs from the default |

:::warn title="Check the exact names in the docs"
These names come from the Testcontainers for .NET *Custom configuration* page
(dotnet.testcontainers.org/custom_configuration). Other languages (Java, Go, Node) share most of
them, but not all. If a setting seems to have no effect, check that page for your library version.
:::

**Reuse** is the opposite trade. `.WithReuse(true)` on the builder (marked experimental) keeps a
container alive between test runs and finds it again by a hash of its configuration, so the second
`dotnet test` skips the 2-second start. Reused containers are deliberately **not** cleaned up by
Ryuk, and their data survives between runs, so your schema setup must be idempotent
(`CREATE TABLE IF NOT EXISTS`, migrations). Teams use reuse for a fast local inner loop and **never
in CI**, where a fresh container per run is the whole point.

:::quiz id=ops-18-q3 xp=10
You stop the debugger halfway through an integration test run. The fixture's `DisposeAsync` never
runs. What happens to the Postgres container?
- [ ] It runs forever until you remove it with `docker rm -f`
- [ ] Docker removes it automatically because Testcontainers started it with `--rm`
- [x] Ryuk notices its connection from the test process dropped and removes every container labelled with that session a few seconds later
- [ ] The next `dotnet test` reuses it, because Testcontainers reuses containers by default
> Ryuk exists for exactly this case: its lifetime is tied to a TCP connection from your test process,
> not to your cleanup code. `--rm` only removes a container after it **stops**, and a Postgres that
> nobody stops keeps running, so that doesn't help. Reuse is opt-in (`WithReuse(true)`) and
> experimental, not the default.
:::

## Containers in CI

GitHub's Ubuntu runners have Docker installed, so there are three common shapes for a pipeline that
needs Postgres and Redis.

### Option A — Testcontainers on the runner

Nothing special in the workflow: `dotnet test` starts its own containers exactly as on your laptop.
This is the simplest option and keeps CI and local runs identical (the lab ends with this workflow).
Pre-pull the images in a separate step so a slow pull isn't counted against a test timeout.

The catch is the runner OS. Docker with Linux containers is available on the **Ubuntu** runners
only. GitHub's macOS runners have no Docker, and the Windows runners run Windows containers, so
`postgres:18` won't start there. Run container-based tests on `ubuntu-latest`, and keep
macOS/Windows jobs (if you have them) to unit tests.

### Option B — `services:` in GitHub Actions

The runner starts **service containers** before the first step and removes them after the job:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:18
        env:
          POSTGRES_PASSWORD: postgres
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s --health-timeout 5s --health-retries 10
      redis:
        image: redis:8
        ports: ["6379:6379"]
        options: --health-cmd "redis-cli ping" --health-interval 5s --health-retries 10
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-dotnet@v5
        with:
          dotnet-version: 10.0.x
      - run: dotnet test
        env:
          ConnectionStrings__Db: Host=localhost;Port=5432;Username=postgres;Password=postgres
          ConnectionStrings__Redis: localhost:6379
```

How it works and where it bites:

- With `--health-cmd` in `options`, the runner **waits until the service is healthy** before
  running steps. Without a health check, your first step races the database.
- **Which hostname?** The job above runs directly on the runner VM, so it reaches services at
  `localhost` and the *published* port. If the job runs in a container (`container: mcr.microsoft.com/dotnet/sdk:10.0`),
  everything is on one Docker network, and you use the **service name** (`postgres`) and the
  *container* port.
- Services are configured with image, env, ports, volumes and `options` (extra `docker create`
  flags). They start **before** `actions/checkout`, so you can't mount an init script from the repo.
- The configuration lives only in the workflow, so it drifts from your `compose.yaml` over time.

### Option C — the same Compose file as development

```yaml
# compose.yaml (excerpt): db and cache as in ops-05, plus a one-shot test runner
services:
  db:
    image: postgres:18
    environment: { POSTGRES_USER: app, POSTGRES_PASSWORD: app, POSTGRES_DB: app }
    volumes: [pgdata:/var/lib/postgresql]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d app"]
      interval: 2s
      retries: 30
  cache:
    image: redis:8
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      retries: 30
  tests:
    image: mcr.microsoft.com/dotnet/sdk:10.0
    profiles: [test]                       # not started by a plain `docker compose up`
    working_dir: /src
    volumes: [".:/src"]
    environment:
      ConnectionStrings__Db: Host=db;Database=app;Username=app;Password=app
      ConnectionStrings__Redis: cache:6379
    command: ["dotnet", "test", "tests/Shop.E2E", "--logger", "trx", "--results-directory", "/src/TestResults"]
    depends_on:
      db: { condition: service_healthy }
      cache: { condition: service_healthy }
volumes:
  pgdata:
```

```yaml
      - run: docker compose up -d --wait db cache     # returns once both healthchecks pass
      - run: docker compose run --rm tests            # exit code = the tests' exit code
      - if: failure()
        run: docker compose logs --no-color > compose-logs.txt
      - if: always()
        run: docker compose down -v                   # -v: remove the pgdata volume too
```

- **`up --wait`** blocks until every started service is *running and healthy* (or fails with a
  non-zero exit code after `--wait-timeout`). It replaces the `sleep 10` you'll find in old pipelines.
- **`run --rm tests`** starts the dependencies if needed, runs the one-shot container in the
  foreground, removes it afterwards and **passes its exit code through**, so a failing test fails
  the step.
- Collect logs **before** `down`: once the containers are removed, their logs are gone.

| Pick… | When |
|---|---|
| **Testcontainers** | Integration tests for one service. Same behaviour locally and in CI, and every test run gets a fresh database |
| **`services:`** | Tests that read a fixed connection string, quick setups, teams not using Testcontainers |
| **Compose in CI** | End-to-end tests of the whole system (API + worker + web + Playwright), or when CI must run *exactly* the dev stack |

:::quiz id=ops-18-q4 xp=10
A GitHub Actions job has `runs-on: ubuntu-latest`, **no** `container:` key, and a service
`postgres` with `ports: ["5432:5432"]`. Which connection string do the test steps use?
- [ ] `Host=postgres;Port=5432;…`, because services are reachable by their name
- [x] `Host=localhost;Port=5432;…`
- [ ] `Host=postgres;Port=49153;…`, a random port chosen by the runner
- [ ] `Host=host.docker.internal;Port=5432;…`
> The steps run **on the runner VM**, not in a container, so they reach the service through the
> port published on the host: `localhost:5432`. Service names only resolve when the job itself
> runs in a container on the same Docker network (`container:` key), and then you use the
> container port. `host.docker.internal` is a Docker Desktop convention and doesn't apply here.
:::

:::quiz id=ops-18-q5 xp=10
In a CI step you run `docker compose up -d && docker compose exec api dotnet test`. Some runs fail
with "connection refused" to the database, others pass. What is the most reliable fix?
- [ ] Add `sleep 15` after `docker compose up -d`
- [ ] Add `depends_on: [db]` to the `api` service
- [x] Give `db` a healthcheck and start with `docker compose up -d --wait` (and use `condition: service_healthy` for dependants)
- [ ] Use `docker compose up` without `-d` so it waits
> `up -d` returns as soon as containers are **started**, not when Postgres is **ready**. `--wait`
> blocks until healthchecks pass. A plain `depends_on: [db]` only orders the start-up, it doesn't
> wait for readiness, and `sleep 15` is a guess that is either wasteful or too short on a slow runner.
> Without `-d`, `up` attaches to the logs and never returns, so the next command never runs.
:::

:::job title="What you'll find in a real repo"
A typical SaaS repo has a `compose.yaml` for local development, a `tests/*.IntegrationTests`
project using Testcontainers with an assembly fixture, and a CI workflow that runs
`dotnet test` on `ubuntu-latest` with a pre-pull step and uploads the `.trx` results. In week one,
expect a ticket like "the integration tests are flaky in CI". It is nearly always a missing wait
strategy, a hardcoded port, or tests that depend on each other's data.
:::

## Dev Containers: the development environment as code

Why bother? The README that says "install .NET 10, Node 24, the right `psql`, these five VS Code
extensions, then…" goes out of date, and every new laptop ends up slightly different. A Dev Container
turns that README into a file that the editor runs.

A **Dev Container** is a container your *editor* runs in. VS Code (Dev Containers extension),
JetBrains IDEs such as Rider, the `devcontainer` CLI, and **GitHub Codespaces** read
`.devcontainer/devcontainer.json`,
build or pull the image, mount the repo, install extensions, and then the terminal, debugger and
language server all run *inside* the container. Your laptop only needs Docker and the editor.

```json
// .devcontainer/devcontainer.json  (JSON with comments is allowed here)
{
  "name": "shop",
  "dockerComposeFile": "compose.yaml",
  "service": "workspace",
  "workspaceFolder": "/workspaces/shop",
  "features": {
    "ghcr.io/devcontainers/features/dotnet:2": { "version": "10.0" },
    "ghcr.io/devcontainers/features/node:1": { "version": "24" },
    "ghcr.io/devcontainers/features/docker-outside-of-docker:1": {}
  },
  "forwardPorts": [5173, 8080],
  "postCreateCommand": "dotnet restore && npm ci --prefix web",
  "customizations": {
    "vscode": {
      "extensions": ["ms-dotnettools.csdevkit", "dbaeumer.vscode-eslint"]
    }
  },
  "remoteUser": "vscode"
}
```

```yaml
# .devcontainer/compose.yaml
services:
  workspace:
    image: mcr.microsoft.com/devcontainers/base:ubuntu
    volumes:
      - ..:/workspaces/shop:cached       # the repo, mounted into the container
    command: sleep infinity              # keep it alive; the editor execs into it
  db:
    image: postgres:18
    environment: { POSTGRES_PASSWORD: devpass }
    volumes: [pgdata:/var/lib/postgresql]
  cache:
    image: redis:8
volumes:
  pgdata:
```

The key terms:

- **Features** are reusable install scripts (`dotnet`, `node`, `azure-cli`, `docker-outside-of-docker`,
  …) layered onto the base image. They save you from writing a Dockerfile that installs the SDK.
- **`postCreateCommand`** runs once after the container is created: restore packages, install git
  hooks, seed the database.
- **`forwardPorts`** makes `localhost:5173` on your laptop reach the Vite server inside the container.
- With a compose-based Dev Container, the workspace shares a network with `db` and `cache`, so the
  API's connection string uses `Host=db`, exactly as in ops-06.
- **Codespaces** runs the same file on a cloud VM, which is useful for onboarding, for reviewing a PR
  without touching your local setup, and for workshops.

:::warn title="Testcontainers inside a Dev Container"
With `docker-outside-of-docker`, the dev container uses the **host's** Docker daemon. Containers that
Testcontainers starts are *siblings* of your dev container, and their random ports are published on
the **host**, not inside your dev container. Inside the dev container, `127.0.0.1` is the dev
container itself, so `127.0.0.1:49153` points at nothing.

- On **Docker Desktop** (macOS, Windows), set `TESTCONTAINERS_HOST_OVERRIDE=host.docker.internal`
  (for example in `containerEnv` in `devcontainer.json`). That name is how a container reaches the
  host on Docker Desktop.
- On **Docker Engine on Linux**, the Testcontainers docs say the override isn't needed. If tests
  still can't connect, look up your setup there before guessing.
- Or use the **`docker-in-docker`** feature. The daemon then runs *inside* the dev container, the
  test containers are its children, and `127.0.0.1` is correct again. It costs a privileged
  container and a separate image cache.

The details depend on the Docker product and the Testcontainers version, so check the docs'
"Running inside a container" page (dotnet.testcontainers.org/dind) for your setup.
:::

Dev Containers aren't free. File access through a bind mount is slower on macOS and Windows (use a
named volume or clone inside the container), the first build takes minutes, and some developers
prefer their native setup. Most teams treat the Dev Container as the **supported default** and still
let people run natively.

## Aspire: local orchestration in C#

**Aspire** (called **.NET Aspire** before version 13) solves the same problem as Compose, "start my
whole app locally", but you describe the app in a C# **AppHost** project instead of YAML:

```csharp
// Shop.AppHost/AppHost.cs
var builder = DistributedApplication.CreateBuilder(args);

var postgres = builder.AddPostgres("pg")
    .WithImageTag("18")
    .WithVolume("shop-pgdata", "/var/lib/postgresql")   // postgres:18 layout, see ops-05
    .WithLifetime(ContainerLifetime.Persistent);          // keep it running between AppHost restarts
var db = postgres.AddDatabase("appdb");

var cache = builder.AddRedis("cache").WithImageTag("8");

var api = builder.AddProject<Projects.Shop_Api>("api")
    .WithReference(db).WaitFor(db)                         // injects ConnectionStrings__appdb
    .WithReference(cache).WaitFor(cache);                  // injects ConnectionStrings__cache

builder.AddViteApp("web", "../web")                        // Aspire.Hosting.JavaScript
    .WithReference(api).WaitFor(api);                      // injects the api's URL for the dev proxy

builder.Build().Run();
```

```csharp
// Shop.Api/Program.cs: the API only knows resource *names*, not hosts or ports
builder.AddServiceDefaults();                 // OpenTelemetry, health checks, service discovery, resilience
builder.AddNpgsqlDataSource("appdb");         // Aspire.Npgsql: reads ConnectionStrings:appdb
builder.AddRedisClient("cache");              // Aspire.StackExchange.Redis
```

:::warn title="Aspire moves fast"
Aspire ships often, and its API names have changed between releases. For example, JavaScript
hosting moved from `Aspire.Hosting.NodeJs` (`AddNpmApp`) to `Aspire.Hosting.JavaScript`
(`AddViteApp`, `AddJavaScriptApp`). The code above follows Aspire 13. If a method doesn't compile,
look up the current name at aspire.dev rather than pinning an old package. Each hosting integration
also has its own default image tag, which is why the code sets `WithImageTag` explicitly. The data
volume targets `/var/lib/postgresql` because `postgres:18` keeps its data under
`/var/lib/postgresql/18/docker`, not `/var/lib/postgresql/data` as earlier versions did.
:::

The mental model has three parts:

- **Resources** are everything in the graph: containers (`AddPostgres`, `AddRedis`), your .NET
  projects (`AddProject`), JavaScript apps and executables. Containers run in Docker or Podman.
  **Projects run as normal processes on your machine**, so F5 in Visual Studio or Rider debugs them
  with no container debugging setup at all.
- **References are service discovery.** `WithReference(db)` puts the connection string into the
  API's environment (`ConnectionStrings__appdb`). A reference to another project injects its URLs
  (`services__api__https__0=https://localhost:7123`), so an `HttpClient` with base address
  `https+http://api` finds it. `WaitFor` delays start-up until the dependency is healthy.
- **The dashboard** opens when you run the AppHost (`aspire run` or `dotnet run --project Shop.AppHost`;
  the console prints a login URL with a token). It shows every resource's state, console logs,
  **distributed traces** and metrics through OpenTelemetry. This is the same standalone dashboard you
  may have started with `docker run` in the backend observability lesson.

Aspire also has a testing package (`Aspire.Hosting.Testing`) that starts the whole AppHost from
an xUnit test, and it can publish deployment artifacts (Compose files, Kubernetes manifests).

### Aspire or Compose?

| | **Compose** | **Aspire** |
|---|---|---|
| Language | YAML, any stack | C# AppHost (it can still orchestrate Node, Python and containers) |
| Your own services | Usually containers (rebuild or `watch` to see changes) | Host processes: native debugging, hot reload |
| Service discovery | Docker DNS (`Host=db`), you wire env vars | Generated from `WithReference` |
| Observability | Bring your own | Dashboard with logs, traces and metrics out of the box |
| Who can run it | Anyone with Docker | Needs the .NET SDK (and the Aspire CLI or templates) |
| CI and production | The same file works in CI; small single-host deployments | Local dev and tests; deployment goes through publishers |

How teams usually choose:

- **Mostly .NET services, developers who debug a lot** → Aspire. The F5 experience and the
  free traces are hard to beat.
- **Polyglot teams, ops-owned infrastructure, or "CI must run exactly what devs run"** → Compose. It
  is the lowest common denominator everyone understands.
- **Both is common**: Aspire for the inner dev loop, Compose for end-to-end tests in CI, and
  Kubernetes manifests (ops-09 onward) for production.

:::quiz id=ops-18-q6 xp=15
Which statements about Aspire are true? (Select all that apply.)
- [x] `AddProject<…>()` runs your .NET project as a process on your machine, so the normal debugger attaches without container debugging tools
- [x] `WithReference(db)` injects the connection string into the referencing project's configuration
- [ ] Aspire replaces Docker: Postgres and Redis run without a container runtime
- [ ] An Aspire AppHost can only orchestrate .NET projects
- [x] `WaitFor(db)` delays starting the API until the database resource reports healthy
> Aspire orchestrates; it doesn't replace the container runtime. `AddPostgres` and `AddRedis` still
> start containers in Docker or Podman. Projects, however, run as host processes, which is why F5
> debugging just works. References become environment variables (connection strings, service URLs),
> and `WaitFor` uses health checks to order start-up. JavaScript apps, executables and arbitrary
> containers can be resources too, so it isn't .NET-only.
:::

:::pro title="The hybrid loop most teams settle on"
Whatever the tool, the fastest inner loop is: **dependencies in containers, your code on the host.**
Postgres, Redis, RabbitMQ and Keycloak run in containers (Compose, Aspire or a Dev Container). The
API and the Vite dev server run natively with hot reload and a normal debugger. You only run *your*
services in containers when you're testing the image itself: the Dockerfile, the non-root user,
health checks, the nginx config.
:::

## Logs and debugging containers

When a container misbehaves, its **stdout/stderr** is the first place to look. Containers are
expected to log to the console (not to files inside the container), and Docker stores those
streams for each container until it's removed.

```bash
docker logs -f --tail 100 api              # follow, starting with the last 100 lines
docker logs --since 10m -t db              # last 10 minutes, with timestamps
docker compose logs -f api worker          # several services, interleaved and colour-coded
docker inspect -f '{{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}}' api
docker exec -it shop-db-1 psql -U postgres # run a program (here psql) inside a running container
docker compose exec db psql -U postgres    # the same thing, addressed by Compose service name
```

`docker logs` and `docker exec` take a **container** name or id. Compose names containers
`<project>-<service>-<n>` (for example `shop-db-1`), so the `api` in the first lines assumes a
container started with `--name api`. The `docker compose …` variants take the **service** name.

Reading exit codes: **0** = clean exit, **1** = generic error (`Environment.Exit(1)`, a crashed
Node process), **134** = SIGABRT (an unhandled .NET exception on Linux aborts the runtime), **137** =
killed by SIGKILL (often the OOM killer, check `OOMKilled`), **139** = segfault, **143** = SIGTERM
(normal on `docker stop`). Codes above 128 are 128 + the signal number.
Why PID 1 decides whether SIGTERM is handled is covered in **Image Security and Runtime Hardening** (ops-07).

`docker logs` works on **stopped** containers as long as they still exist. Containers started with
`--rm`, Compose services after `down`, and Testcontainers containers after `DisposeAsync` take their
logs with them. To see what a test container said:

```csharp
var pg = new PostgreSqlBuilder("postgres:18")
    .WithOutputConsumer(Consume.RedirectStdoutAndStderrToConsole())   // stream to the process console
    .Build();

var (stdout, stderr) = await pg.GetLogsAsync();                      // or fetch on demand
```

`RedirectStdoutAndStderrToConsole` writes to `Console`. xUnit v3 doesn't show console output in
test results by default. Add `[assembly: CaptureConsole]` to route it into each test's output, or
call `GetLogsAsync()` in the fixture's `DisposeAsync` *before* disposing the container and write the
result to a file that CI uploads as an artifact.

To **debug** your code:

- **Running on the host** (the hybrid loop, Aspire projects): set a breakpoint and press F5.
  Nothing container-specific.
- **Inside a Dev Container**: the debugger runs inside the container too, so F5 still just works.
- **Inside a plain container** (testing the real image): Visual Studio's container tools and Rider
  can attach to a .NET process in a running container. In VS Code, use the C# extension's attach with
  a `docker exec` pipe transport. Use a `Debug` build and expect to install the debugger into the
  container (the tools do this for you).
- **Pausing a Testcontainers test**: set a breakpoint after `StartAsync`, then
  `docker ps --filter label=org.testcontainers=true` and `docker exec -it <id> psql -U postgres` to look
  at the database while the test waits.

:::quiz id=ops-18-q7 xp=10
An integration test failed in CI with `Npgsql.NpgsqlException: Exception while reading from stream`.
You want the Postgres server log from that run. In a later step you run `docker logs <container>`, and
it says "No such container". Why, and what's the fix?
- [ ] `docker logs` only works while a container is running; use `docker exec … cat /var/log/postgresql.log`
- [x] The fixture's `DisposeAsync` (or Ryuk) removed the container, taking its logs with it; capture logs during the run with `WithOutputConsumer` or `GetLogsAsync()` in the fixture
- [ ] Postgres writes no logs to stdout, so there's nothing to collect
- [ ] CI runners disable container logging; enable it with `--log-driver json-file`
> Docker keeps a container's logs until the **container is removed**, and Testcontainers removes it at
> the end of the run (or Ryuk does a few seconds later). `docker logs` works fine on stopped containers,
> so the first option is wrong for the right reason too: the container doesn't exist any more. The
> official Postgres image logs to stderr, which is exactly what `WithOutputConsumer` or `GetLogsAsync()`
> captures while the container still exists.
:::

## Simulate it: where is my test container?

Every Testcontainers library answers two questions before it can hand you a connection string:
**which host** do I connect to, and **which host port** maps to the container port? You'll
implement both, the way the library does it.

- The `docker port <container>` command prints mappings like `5432/tcp -> 0.0.0.0:49153` and
  `5432/tcp -> [::]:49153` (one line per IPv4/IPv6 binding).
- The host is `TESTCONTAINERS_HOST_OVERRIDE` if set; otherwise the host of a `tcp://`, `http://` or
  `https://` `DOCKER_HOST` (a remote daemon); otherwise `127.0.0.1` (local socket: `unix://`,
  `npipe://`, or unset).

:::challenge id=ops-18-c1 lang=ts xp=50
title: Build test-container connection strings
Implement four functions:

1. `parseDockerPort(output)` parses `docker port` output into
   `{ containerPort, protocol, hostIp, hostPort }` objects, one per line, in the order they appear.
   Ignore blank lines. IPv6 host IPs are
   printed in brackets (`[::]`); return them **without** the brackets (`::`).
   Each line looks like `<containerPort>/<protocol> -> <hostIp>:<hostPort>`, for example
   `5432/tcp -> 0.0.0.0:49153` or `53/udp -> 127.0.0.1:40001`. Numbers are returned as numbers.
2. `mappedPort(mappings, containerPort, protocol = 'tcp')` returns the host port for that container
   port **and** protocol (a `53/udp` binding doesn't count for `53/tcp`). If there are several
   bindings, prefer an **IPv4** one (its `hostIp` contains a `.`); if there are only IPv6 bindings,
   return the first one. If nothing matches, throw an `Error` with the message
   `"<port>/<protocol> is not published"`, for example `"5432/tcp is not published"`.
3. `resolveHost(env)` returns the host to connect to. `env` is an object like `process.env`. Apply
   these rules in order:
   - `env.TESTCONTAINERS_HOST_OVERRIDE`, if set, wins over everything else;
   - otherwise, if `env.DOCKER_HOST` starts with `tcp://`, `http://` or `https://`, return its
     **hostname** only, without scheme or port (`tcp://10.0.0.5:2375` → `10.0.0.5`);
   - otherwise (unset, `unix://…`, `npipe://…`) return `127.0.0.1`.
4. `connectionStrings(env, ports, creds)` takes the `docker port` outputs of the Postgres and Redis
   containers (`ports.postgres`, `ports.redis`) and returns exactly
   `{ postgres: "Host=<h>;Port=<p>;Database=<db>;Username=<u>;Password=<pw>", redis: "<h>:<port>" }`,
   where `<h>` comes from `resolveHost(env)` and the ports are the **host** ports mapped to container
   ports 5432/tcp and 6379/tcp.

This is a simplified version of the real rules: the library also inspects Docker contexts and
whether it is itself running inside a container.

hint: A regex per line does most of the work: `/^(\d+)\/(\w+)\s*->\s*(.+):(\d+)$/`. The greedy `(.+)` keeps `[::]` together because the last `:` is followed by the port.
hint: `new URL('tcp://10.0.0.5:2375').hostname` is `'10.0.0.5'`. Check the scheme with `startsWith` before parsing.
hint: In `mappedPort`, filter by port and protocol first, then `find` an IPv4 entry and fall back to the first match.

```ts starter
export type PortMapping = { containerPort: number; protocol: string; hostIp: string; hostPort: number }
export type Env = Record<string, string | undefined>

export function parseDockerPort(output: string): PortMapping[] {
  return []
}

export function mappedPort(mappings: PortMapping[], containerPort: number, protocol = 'tcp'): number {
  return containerPort // "it's always 5432", the classic mistake
}

export function resolveHost(env: Env): string {
  return 'localhost'
}

export function connectionStrings(
  env: Env,
  ports: { postgres: string; redis: string },
  creds: { database: string; username: string; password: string },
): { postgres: string; redis: string } {
  return { postgres: '', redis: '' }
}
```

```ts solution
export type PortMapping = { containerPort: number; protocol: string; hostIp: string; hostPort: number }
export type Env = Record<string, string | undefined>

export function parseDockerPort(output: string): PortMapping[] {
  return output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((line) => {
      const m = line.match(/^(\d+)\/(\w+)\s*->\s*(.+):(\d+)$/)
      if (!m) throw new Error(`cannot parse: ${line}`)
      return {
        containerPort: Number(m[1]),
        protocol: m[2],
        hostIp: m[3].replace(/^\[/, '').replace(/\]$/, ''),
        hostPort: Number(m[4]),
      }
    })
}

export function mappedPort(mappings: PortMapping[], containerPort: number, protocol = 'tcp'): number {
  const matches = mappings.filter((m) => m.containerPort === containerPort && m.protocol === protocol)
  if (matches.length === 0) throw new Error(`${containerPort}/${protocol} is not published`)
  const ipv4 = matches.find((m) => m.hostIp.includes('.'))
  return (ipv4 ?? matches[0]).hostPort
}

export function resolveHost(env: Env): string {
  const override = env.TESTCONTAINERS_HOST_OVERRIDE
  if (override) return override
  const dockerHost = env.DOCKER_HOST ?? ''
  if (/^(tcp|https?):\/\//.test(dockerHost)) return new URL(dockerHost).hostname
  return '127.0.0.1'
}

export function connectionStrings(
  env: Env,
  ports: { postgres: string; redis: string },
  creds: { database: string; username: string; password: string },
): { postgres: string; redis: string } {
  const host = resolveHost(env)
  const pgPort = mappedPort(parseDockerPort(ports.postgres), 5432)
  const redisPort = mappedPort(parseDockerPort(ports.redis), 6379)
  return {
    postgres: `Host=${host};Port=${pgPort};Database=${creds.database};Username=${creds.username};Password=${creds.password}`,
    redis: `${host}:${redisPort}`,
  }
}
```

```ts tests
const PG = '5432/tcp -> 0.0.0.0:49153\n5432/tcp -> [::]:49153\n'
const REDIS = '6379/tcp -> 0.0.0.0:49154\n'
const CREDS = { database: 'shop', username: 'shop', password: 's3cret' }

test('parses IPv4 and IPv6 bindings', () => {
  expect(parseDockerPort(PG)).toEqual([
    { containerPort: 5432, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 49153 },
    { containerPort: 5432, protocol: 'tcp', hostIp: '::', hostPort: 49153 },
  ])
})
test('ignores blank lines and parses udp', () => {
  expect(parseDockerPort('\n53/udp -> 127.0.0.1:40001\n\n')).toEqual([
    { containerPort: 53, protocol: 'udp', hostIp: '127.0.0.1', hostPort: 40001 },
  ])
})
test('mappedPort returns the HOST port, not the container port', () => {
  expect(mappedPort(parseDockerPort(PG), 5432)).toBe(49153)
})
test('mappedPort prefers IPv4 when bindings differ', () => {
  const m = parseDockerPort('8080/tcp -> [::]:50001\n8080/tcp -> 0.0.0.0:50002')
  expect(mappedPort(m, 8080)).toBe(50002)
})
test('mappedPort falls back to IPv6-only bindings', () => {
  expect(mappedPort(parseDockerPort('8080/tcp -> [::]:50001'), 8080)).toBe(50001)
})
test('mappedPort matches port AND protocol', () => {
  const m = parseDockerPort('53/udp -> 0.0.0.0:40001\n53/tcp -> 0.0.0.0:40002\n80/tcp -> 0.0.0.0:40003')
  expect(mappedPort(m, 53, 'udp')).toBe(40001)
  expect(mappedPort(m, 53)).toBe(40002)
})
test('mappedPort throws for an unpublished port', () => {
  expect(() => mappedPort(parseDockerPort(REDIS), 5432)).toThrow('5432/tcp is not published')
  expect(() => mappedPort([], 6379, 'udp')).toThrow('6379/udp is not published')
})
test('resolveHost defaults to 127.0.0.1 for local sockets', () => {
  expect(resolveHost({})).toBe('127.0.0.1')
  expect(resolveHost({ DOCKER_HOST: 'unix:///run/user/1000/podman/podman.sock' })).toBe('127.0.0.1')
  expect(resolveHost({ DOCKER_HOST: 'npipe:////./pipe/docker_engine' })).toBe('127.0.0.1')
})
test('resolveHost uses a remote tcp DOCKER_HOST', () => {
  expect(resolveHost({ DOCKER_HOST: 'tcp://10.0.0.5:2375' })).toBe('10.0.0.5')
  expect(resolveHost({ DOCKER_HOST: 'https://docker.ci.internal:2376' })).toBe('docker.ci.internal')
})
test('TESTCONTAINERS_HOST_OVERRIDE wins over everything', () => {
  expect(resolveHost({ TESTCONTAINERS_HOST_OVERRIDE: 'host.docker.internal', DOCKER_HOST: 'tcp://10.0.0.5:2375' })).toBe('host.docker.internal')
})
test('connectionStrings builds Npgsql and Redis strings', () => {
  expect(connectionStrings({}, { postgres: PG, redis: REDIS }, CREDS)).toEqual({
    postgres: 'Host=127.0.0.1;Port=49153;Database=shop;Username=shop;Password=s3cret',
    redis: '127.0.0.1:49154',
  })
})
test('connectionStrings inside a Dev Container with the host override', () => {
  const env = { TESTCONTAINERS_HOST_OVERRIDE: 'host.docker.internal' }
  expect(connectionStrings(env, { postgres: PG, redis: REDIS }, CREDS).redis).toBe('host.docker.internal:49154')
})
```
:::

## Lab: Postgres 18 + Redis 8 integration tests, locally and in CI

:::lab id=ops-18-lab1 xp=120
title: A read-through cache tested against real Postgres and Redis

You'll build a tiny `Catalog` library with a **read-through cache** (Redis in front of a Postgres
table), test it with xUnit v3 and Testcontainers against `postgres:18` and `redis:8`, break it on
purpose, and add a GitHub Actions job.

**Prerequisites:** .NET 10 SDK and a running Docker (or Podman: run
`systemctl --user enable --now podman.socket` and
`export DOCKER_HOST=unix:///run/user/$(id -u)/podman/podman.sock`). Check with `docker info`.

**1. Layout.** No templates needed; you'll write every file.

```bash
mkdir -p cachelab/src/Catalog cachelab/tests/Catalog.Tests cachelab/.github/workflows
cd cachelab
git init
docker pull postgres:18 && docker pull redis:8     # so the first test run isn't a 400 MB download
```

**2. The library.** `src/Catalog/Catalog.csproj`

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Npgsql" Version="10.*" />
    <PackageReference Include="StackExchange.Redis" Version="2.*" />
  </ItemGroup>

</Project>
```

`src/Catalog/ProductStore.cs`

```csharp
using System.Globalization;
using Npgsql;
using StackExchange.Redis;

namespace Catalog;

/// <summary>Read-through cache: Redis in front of the products table in Postgres.</summary>
public sealed class ProductStore(NpgsqlDataSource db, IConnectionMultiplexer redis)
{
    public static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(5);

    public static string CacheKey(string sku) => $"price:{sku}";

    public static async Task EnsureSchemaAsync(NpgsqlDataSource db)
    {
        await using var cmd = db.CreateCommand("""
            CREATE TABLE IF NOT EXISTS products (
                sku   text PRIMARY KEY,
                price numeric(10,2) NOT NULL CHECK (price >= 0)
            )
            """);
        await cmd.ExecuteNonQueryAsync();
    }

    public async Task<decimal?> GetPriceAsync(string sku)
    {
        var cache = redis.GetDatabase();
        var cached = await cache.StringGetAsync(CacheKey(sku));
        if (cached.HasValue)
            return decimal.Parse(cached.ToString(), CultureInfo.InvariantCulture);

        await using var cmd = db.CreateCommand("SELECT price FROM products WHERE sku = $1");
        cmd.Parameters.AddWithValue(sku);
        if (await cmd.ExecuteScalarAsync() is not decimal price)
            return null;                                   // unknown SKU: nothing to cache

        await cache.StringSetAsync(CacheKey(sku), price.ToString(CultureInfo.InvariantCulture), CacheTtl);
        return price;
    }

    public async Task SetPriceAsync(string sku, decimal price)
    {
        await using var cmd = db.CreateCommand("""
            INSERT INTO products (sku, price) VALUES ($1, $2)
            ON CONFLICT (sku) DO UPDATE SET price = EXCLUDED.price
            """);
        cmd.Parameters.AddWithValue(sku);
        cmd.Parameters.AddWithValue(price);
        await cmd.ExecuteNonQueryAsync();

        // Invalidate AFTER the database write succeeded, so the next read reloads the new price.
        await redis.GetDatabase().KeyDeleteAsync(CacheKey(sku));
    }
}
```

**3. The test project.** `tests/Catalog.Tests/Catalog.Tests.csproj` (xUnit v3 test projects are
executables, hence `OutputType Exe`):

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <OutputType>Exe</OutputType>
    <IsPackable>false</IsPackable>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="18.*" />
    <PackageReference Include="xunit.v3" Version="3.*" />
    <PackageReference Include="xunit.runner.visualstudio" Version="3.*" />
    <PackageReference Include="Testcontainers.PostgreSql" Version="4.*" />
    <PackageReference Include="Testcontainers.Redis" Version="4.*" />
  </ItemGroup>

  <ItemGroup>
    <Using Include="Xunit" />
  </ItemGroup>

  <ItemGroup>
    <ProjectReference Include="..\..\src\Catalog\Catalog.csproj" />
  </ItemGroup>

</Project>
```

**4. The fixture.** `tests/Catalog.Tests/InfraFixture.cs`: one Postgres and one Redis for the
whole run, started in parallel.

```csharp
using Catalog;
using Npgsql;
using StackExchange.Redis;
using Testcontainers.PostgreSql;
using Testcontainers.Redis;

// One InfraFixture for the whole test assembly: both containers start once per `dotnet test`.
[assembly: AssemblyFixture(typeof(Catalog.Tests.InfraFixture))]

namespace Catalog.Tests;

public sealed class InfraFixture : IAsyncLifetime
{
    public PostgreSqlContainer Postgres { get; } = new PostgreSqlBuilder("postgres:18").Build();
    public RedisContainer Redis { get; } = new RedisBuilder("redis:8").Build();

    public NpgsqlDataSource Db { get; private set; } = null!;
    public IConnectionMultiplexer RedisConnection { get; private set; } = null!;

    public async ValueTask InitializeAsync()
    {
        // Start both in parallel: total start-up time = the slower one, not the sum.
        await Task.WhenAll(Postgres.StartAsync(), Redis.StartAsync());

        Db = NpgsqlDataSource.Create(Postgres.GetConnectionString());
        RedisConnection = await ConnectionMultiplexer.ConnectAsync(Redis.GetConnectionString());
        await ProductStore.EnsureSchemaAsync(Db);
    }

    public async ValueTask DisposeAsync()
    {
        RedisConnection.Dispose();
        await Db.DisposeAsync();
        await Postgres.DisposeAsync();
        await Redis.DisposeAsync();
    }
}
```

**5. The tests.** `tests/Catalog.Tests/ProductStoreTests.cs`. Every test uses its own SKU, so the
tests are isolated by data and can share the containers.

```csharp
using Npgsql;
using StackExchange.Redis;

namespace Catalog.Tests;

public sealed class ProductStoreTests(InfraFixture infra)
{
    private readonly ProductStore _store = new(infra.Db, infra.RedisConnection);
    private IDatabase Cache => infra.RedisConnection.GetDatabase();

    // Isolation by data: every test works on its own SKU, so tests never see each other's rows or keys.
    private static string NewSku() => $"sku-{Guid.NewGuid():N}";

    private async Task SetPriceInDbOnlyAsync(string sku, decimal price)
    {
        await using var cmd = infra.Db.CreateCommand("UPDATE products SET price = $1 WHERE sku = $2");
        cmd.Parameters.AddWithValue(price);
        cmd.Parameters.AddWithValue(sku);
        await cmd.ExecuteNonQueryAsync();
    }

    [Fact]
    public async Task Runs_against_the_pinned_major_versions()
    {
        await using var cmd = infra.Db.CreateCommand("SHOW server_version");
        var pgVersion = (string)(await cmd.ExecuteScalarAsync(TestContext.Current.CancellationToken))!;
        var redisVersion = infra.RedisConnection.GetServer(infra.RedisConnection.GetEndPoints()[0]).Version;

        Assert.StartsWith("18", pgVersion);
        Assert.Equal(8, redisVersion.Major);
    }

    [Fact]
    public void Containers_get_random_host_ports()
    {
        int pgPort = infra.Postgres.GetMappedPublicPort(5432);
        int redisPort = infra.Redis.GetMappedPublicPort(6379);

        Assert.NotEqual(5432, pgPort);      // never collides with a Postgres on your laptop
        Assert.NotEqual(6379, redisPort);
    }

    [Fact]
    public async Task First_read_loads_from_postgres_and_fills_the_cache()
    {
        var sku = NewSku();
        await _store.SetPriceAsync(sku, 19.99m);

        var price = await _store.GetPriceAsync(sku);

        Assert.Equal(19.99m, price);
        Assert.Equal("19.99", (string?)await Cache.StringGetAsync(ProductStore.CacheKey(sku)));
        var ttl = await Cache.KeyTimeToLiveAsync(ProductStore.CacheKey(sku));
        Assert.NotNull(ttl);
        Assert.True(ttl <= ProductStore.CacheTtl);
    }

    [Fact]
    public async Task Second_read_is_served_from_redis()
    {
        var sku = NewSku();
        await _store.SetPriceAsync(sku, 5.00m);
        await _store.GetPriceAsync(sku);                 // warm the cache
        await SetPriceInDbOnlyAsync(sku, 7.00m);         // change the row behind the cache's back

        Assert.Equal(5.00m, await _store.GetPriceAsync(sku));   // still the cached value
    }

    [Fact]
    public async Task Updating_a_price_invalidates_the_cache()
    {
        var sku = NewSku();
        await _store.SetPriceAsync(sku, 10.00m);
        await _store.GetPriceAsync(sku);                 // cached: 10.00

        await _store.SetPriceAsync(sku, 12.50m);

        Assert.False(await Cache.KeyExistsAsync(ProductStore.CacheKey(sku)));
        Assert.Equal(12.50m, await _store.GetPriceAsync(sku));
    }

    [Fact]
    public async Task Unknown_sku_returns_null_and_is_not_cached()
    {
        var sku = NewSku();

        Assert.Null(await _store.GetPriceAsync(sku));
        Assert.False(await Cache.KeyExistsAsync(ProductStore.CacheKey(sku)));
    }

    [Fact]
    public async Task Postgres_enforces_the_check_constraint()
    {
        var ex = await Assert.ThrowsAsync<PostgresException>(() => _store.SetPriceAsync(NewSku(), -1m));
        Assert.Equal(PostgresErrorCodes.CheckViolation, ex.SqlState);
    }
}
```

**6. Run it.** In a second terminal, run `watch docker ps` while the tests run.

```bash
dotnet test tests/Catalog.Tests
```

Expected: **7 passed, 0 failed**. The first run also restores packages. The exact summary line depends
on your SDK and terminal. In a CI log or with the classic VSTest output it looks like this:

```text
Passed!  - Failed:     0, Passed:     7, Skipped:     0, Total:     7, Duration: 3 s - Catalog.Tests.dll (net10.0)
```

The tests themselves take milliseconds. Almost all of the few seconds is container start-up in the
assembly fixture. In the `docker ps` window you'll see three containers appear: `postgres:18`,
`redis:8` and `testcontainers/ryuk`. The first two disappear at the end of the run, and Ryuk
exits about 10 seconds later.

**7. Break it on purpose.** In `ProductStore.SetPriceAsync`, comment out the `KeyDeleteAsync` line
and run the tests again:

```text
  Failed Catalog.Tests.ProductStoreTests.Updating_a_price_invalidates_the_cache [2 ms]
   Assert.False() Failure
Expected: False
Actual:   True
Failed!  - Failed:     1, Passed:     6, Skipped:     0, Total:     7, Duration: 75 ms
```

That's the bug real users would see as "I changed the price and the shop still shows the old one
for five minutes". A mock of `IDatabase` would only have checked that you *called* a method; this
test checks what Redis actually contains. Restore the line.

:::tip title="See the crash cleanup"
The run is too fast to interrupt, so slow it down first. Temporarily add
`await Task.Delay(TimeSpan.FromSeconds(30));` at the end of `InitializeAsync`. Start `dotnet test`,
and once the containers show up in `docker ps`, kill the test processes hard from another terminal:
`pkill -9 -f Catalog.Tests`. `Ctrl+C` isn't enough here, because it may let the runner shut down
gracefully and call `DisposeAsync`. Run `docker ps --filter label=org.testcontainers=true` a few
times. Postgres and Redis disappear within about 10 seconds, and no cleanup code ran: Ryuk lost its
connection and removed them. Remove the delay afterwards.
:::

**8. CI.** `.github/workflows/tests.yml`

```yaml
name: tests
on:
  push:
    branches: [main]
  pull_request:

jobs:
  integration:
    runs-on: ubuntu-latest            # Docker is preinstalled; Testcontainers just works
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-dotnet@v5
        with:
          dotnet-version: 10.0.x
      - name: Pre-pull test images     # keeps the pull out of the test timeout and the logs
        run: |
          docker pull -q postgres:18
          docker pull -q redis:8
      - run: dotnet build tests/Catalog.Tests -c Release
      - run: >-
          dotnet test tests/Catalog.Tests -c Release --no-build
          --logger "trx;LogFileName=results.trx" --results-directory TestResults
      - uses: actions/upload-artifact@v4
        if: always()                  # upload results from failed runs too
        with:
          name: test-results
          path: TestResults/*.trx
```

Push to a GitHub repository (optional). The `integration` job goes green in about a minute, and
the `test-results` artifact contains the `.trx` file.

- [ ] `dotnet test` passes all 7 tests against `postgres:18` and `redis:8`
- [ ] I watched the Postgres, Redis and Ryuk containers appear and disappear during a run
- [ ] With the cache invalidation commented out, exactly `Updating_a_price_invalidates_the_cache` fails, and it passes again after restoring it
- [ ] I can explain why `Containers_get_random_host_ports` matters for CI
- [ ] `.github/workflows/tests.yml` exists, and (optionally) the job is green on GitHub
:::

:::quiz id=ops-18-q8 xp=10
In the lab, why does every test call `NewSku()` instead of using a fixed SKU like `"sku-1"`?
- [ ] Redis rejects keys that were used before
- [x] All tests share one Postgres and one Redis through the assembly fixture, so unique data keeps them independent of each other's rows and cache keys, including when xUnit runs tests in parallel
- [ ] Testcontainers resets the database before every test, and the GUID speeds that up
- [ ] `ON CONFLICT` fails on a fixed key
> The containers live for the whole run, and nothing resets them between tests. With a fixed SKU, a
> value cached by one test would leak into another, and the result would depend on execution order:
> the classic "passes alone, fails in the suite" bug. Testcontainers doesn't reset anything between
> tests; isolation is your job. `ON CONFLICT … DO UPDATE` handles repeated keys fine.
:::

:::cards id=ops-18-cards1 xp=20 title="Containers in dev & test"
Q: What does Testcontainers talk to, and what does it give you back?
A: The Docker Engine API (socket or DOCKER_HOST). It creates the container, waits until it's ready, and gives you the host and random mapped port, usually as a connection string.
Q: Why random host ports in tests?
A: No clashes with your dev database, with parallel test projects or CI jobs, or with leftovers from crashed runs. Never hardcode localhost:5432.
Q: What is Ryuk?
A: A sidecar container that holds a connection from the test process and removes every labelled container, network and volume about 10 seconds after that connection drops, including after crashes.
Q: Class, collection or assembly fixture: how many containers?
A: One per test class, one per collection, one per test run. Assembly fixtures (xUnit v3) are the default for integration tests; isolate tests by data.
Q: Why not wait for "port open" or the first "ready to accept connections" log line?
A: Postgres restarts after running init scripts and logs that line twice. Use a real readiness check (pg_isready) or the module's built-in wait strategy.
Q: GitHub Actions service from a job running on the runner: which host?
A: localhost and the published port. The service name only resolves when the job itself runs in a container.
Q: What do `docker compose up --wait` and `docker compose run --rm tests` do?
A: up --wait blocks until services are healthy. run --rm runs a one-shot container, removes it afterwards and returns its exit code, so failing tests fail the step.
Q: What is a Dev Container feature?
A: A reusable install script (dotnet, node, docker-outside-of-docker…) layered onto the base image from devcontainer.json.
Q: Aspire vs Compose in one line each?
A: Aspire: C# AppHost, projects run on the host (native debugging), references become config, dashboard with traces. Compose: YAML for any stack, the same file runs in CI.
Q: Why can't you read a Testcontainers container's logs after the run?
A: It was removed, and logs live only as long as the container. Use WithOutputConsumer or GetLogsAsync during the run.
:::

## Recap

- Before production, containers show up in four places: **Testcontainers** in tests, **CI**
  services or Compose, **Dev Containers**, and **local orchestration** with Aspire or Compose.
- Testcontainers talks to the Docker API, maps to **random host ports**, waits on **real readiness
  checks**, and relies on **Ryuk** to clean up after crashes. Reuse is a local-only speedup.
- Start as **few containers as possible** (an assembly fixture) and isolate tests **by data**
  (unique keys), with resets, or with template databases.
- In CI, choose Testcontainers on the runner, `services:` (use `localhost` from runner jobs), or the
  dev Compose file with `up --wait` and `run --rm tests`. Grab logs before `down`.
- Dev Containers make the environment reproducible. Inside one, Testcontainers may need
  `TESTCONTAINERS_HOST_OVERRIDE=host.docker.internal` (Docker Desktop) or the docker-in-docker feature.
- Run container-based tests on **Ubuntu** runners. macOS runners have no Docker, and Windows runners
  run Windows containers.
- Aspire runs your projects on the host with containers for dependencies, generates service
  discovery and gives you a dashboard. Compose is the stack-agnostic, CI-friendly option. Many teams use both.
- Debug with `docker logs -f`, `docker compose logs`, exit codes and `docker exec`. Capture
  test-container logs while the container still exists.
