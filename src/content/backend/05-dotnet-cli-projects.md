---
id: be-05
title: The .NET CLI, Solutions & Projects
level: beginner
minutes: 50
xp: 120
summary: The SDK and the dotnet CLI, .slnx solutions, .csproj anatomy, NuGet packages, project references, Directory.Build.props, global.json and user-secrets — then build an Api + Domain + Tests solution.
---

On day one at a .NET job you'll clone a repository with a `.slnx` file, a `src/` and `tests/` folder,
a dozen `.csproj` files and a `Directory.Build.props` nobody explained. This lesson makes that
structure obvious. Everything here works the same on Windows, macOS and Linux, from the terminal, VS
Code, Rider or Visual Studio — the IDEs all call the same `dotnet` CLI underneath.

:::info title="Already typed these commands? That's intended"
The labs in be-01 to be-04 already use `dotnet new`, `dotnet sln add` and `dotnet test`, with just
enough explanation to get going (the box at the start of the be-01 lab). This lesson explains what
those commands actually do. If you're brand new to .NET, it's perfectly fine to read it **before** be-01:
it doesn't depend on any C# from the earlier lessons.
:::

## SDK vs runtime

Why two things? Building an app needs a compiler and a lot of tooling; *running* it only needs the
libraries and the engine that executes the compiled code. Shipping only the second keeps servers and
container images small and reduces what an attacker could use.

- The **.NET SDK** is what developers install: compiler, `dotnet` CLI, templates, MSBuild, NuGet
  client. It also contains a matching runtime, so you can run what you build.
  Version numbers look like `10.0.100` or `10.0.302`: `10.0` is the .NET version, the hundreds digit
  is the **feature band** (`1xx`, `2xx`, `3xx` — new SDK tooling features, roughly quarterly) and the
  last two digits are the **patch** within that band.
- The **.NET runtime** is what's needed to *run* an app: `Microsoft.NETCore.App` (base) and
  `Microsoft.AspNetCore.App` (web). Its versions are plain `10.0.x`. Production containers usually ship
  only the runtime (`mcr.microsoft.com/dotnet/aspnet:10.0`), while the build stage of a Dockerfile uses
  the SDK image (`mcr.microsoft.com/dotnet/sdk:10.0`).

```bash
dotnet --version          # SDK used in this folder (respects global.json)
dotnet --list-sdks        # every installed SDK
dotnet --list-runtimes    # every installed runtime
dotnet --info             # everything, incl. OS and architecture
```

.NET 10 is an **LTS** (long-term support) release: three years of patches, until November 2028. Even
versions are LTS, odd versions (like .NET 11) are STS with two years — which is why most companies
upgrade from LTS to LTS.

## The CLI you'll use every day

| Command | What it does |
|---|---|
| `dotnet new <template> -o <dir>` | Create a project/file from a template (`console`, `classlib`, `web`, `webapi`, `xunit`, `sln`, `gitignore`, `globaljson`, `editorconfig`…) |
| `dotnet new list` | Show installed templates |
| `dotnet restore` | Download NuGet packages (runs automatically before build) |
| `dotnet build` | Compile; output goes to `bin/Debug/net10.0/` |
| `dotnet run` | Build + run the project in the current folder (or `--project path`) |
| `dotnet watch` | Run and rebuild/hot-reload on file changes — the `vite dev` of .NET |
| `dotnet test` | Build and run tests (`--filter FullyQualifiedName~Cart` to run a subset) |
| `dotnet add package <id>` | Add a NuGet package (also: `dotnet package add <id>`) |
| `dotnet add reference <proj>` | Add a project reference (also: `dotnet reference add <proj>`) |
| `dotnet sln add <proj>` | Add a project to the solution |
| `dotnet publish -c Release` | Produce deployable output |
| `dotnet format` | Apply `.editorconfig` style and analyzer fixes |
| `dotnet tool install -g <id>` | Install a .NET tool globally (e.g. `dotnet-ef`); without `-g` it's a repo-local tool recorded in a `dotnet-tools.json` manifest that you commit |

:::tip title="Two spellings, same command"
.NET 10 added "noun-first" forms: `dotnet package add`, `dotnet reference add`, `dotnet package list`.
The classic `dotnet add package` still works and is what most docs and colleagues use. Pick one per
team.
:::

:::warn title="Common mistake: running the command in the wrong folder"
`dotnet build`, `run` and `test` act on the project or solution **in the current folder**. If the
folder has none, you get `MSB1003: Specify a project or solution file` or `Couldn't find a project
to run`; if it has several, `MSB1011: Specify which project or solution file to use`. Either `cd` into the right folder or pass the path:
`dotnet run --project src/Shop.Api`, `dotnet test tests/Shop.Tests`.
:::

### `dotnet run app.cs`: file-based apps (.NET 10)

.NET 10 can run a single `.cs` file without any project — great for scripts and experiments:

```csharp
// hello.cs
#:package Humanizer@2.14.1
using Humanizer;

Console.WriteLine(TimeSpan.FromMinutes(90).Humanize());
```

```bash
dotnet run hello.cs
```

The `#:package` directive pulls a NuGet package (`#:sdk Microsoft.NET.Sdk.Web` even turns the file
into a tiny web app). Behind the scenes the SDK generates a hidden project for you — that's why the
rest of this lesson still matters. When the script grows up, `dotnet project convert hello.cs` turns
it into a normal project.

## Solutions: `.slnx`

A **project** (`.csproj`) produces one compiled output — an assembly: a `.dll` library, or an
executable app. A **solution** groups projects so you can build/test them together and open them in an IDE. For 20+
years that was the `.sln` format — GUIDs and cryptic sections that caused merge conflicts. .NET 10's
`dotnet new sln` creates the new XML-based **`.slnx`** format by default:

```xml
<Solution>
  <Folder Name="/src/">
    <Project Path="src/Shop.Api/Shop.Api.csproj" />
    <Project Path="src/Shop.Domain/Shop.Domain.csproj" />
  </Folder>
  <Folder Name="/tests/">
    <Project Path="tests/Shop.Tests/Shop.Tests.csproj" />
  </Folder>
</Solution>
```

That's the whole file — readable and merge-friendly. Current versions of Visual Studio, Rider and
VS Code's C# Dev Kit all open it. Convert an existing solution with `dotnet sln migrate`.

A solution file is optional for building a single project — `dotnet build` in a project folder just
works. It becomes necessary as soon as you have several projects: `dotnet build` / `dotnet test` at the
repo root then build and test *everything* listed in the solution, and the IDE shows them together.

Note that `dotnet sln add src/Shop.Api` automatically creates a **solution folder** (`/src/`) matching
the project's directory — that's where the `<Folder>` elements above come from.

## Anatomy of a `.csproj`

A project file is **MSBuild** XML. Modern "SDK-style" project files are short because the SDK supplies
defaults (every `.cs` file under the folder is compiled automatically — no file lists):

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">          <!-- which SDK: .Web adds ASP.NET Core -->

  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>  <!-- which .NET to compile for -->
    <Nullable>enable</Nullable>                 <!-- nullable reference types on -->
    <ImplicitUsings>enable</ImplicitUsings>     <!-- global usings for System, Linq, … -->
    <RootNamespace>Shop.Api</RootNamespace>     <!-- optional: defaults to the project name -->
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="10.0.0" />   <!-- NuGet -->
  </ItemGroup>

  <ItemGroup>
    <ProjectReference Include="..\Shop.Domain\Shop.Domain.csproj" />               <!-- local project -->
  </ItemGroup>

</Project>
```

| SDK | Used for |
|---|---|
| `Microsoft.NET.Sdk` | Class libraries, console apps, test projects |
| `Microsoft.NET.Sdk.Web` | ASP.NET Core apps (adds the `Microsoft.AspNetCore.App` framework reference, ASP.NET Core implicit usings, and copies `appsettings*.json` / `wwwroot` to the output) |
| `Microsoft.NET.Sdk.Worker` | Background worker services |

Build output lands in `bin/` (your compiled app) and `obj/` (intermediate files, restore results).
**Never commit them** — `dotnet new gitignore` creates a proper `.gitignore`.

## NuGet packages

**NuGet** is .NET's npm. `dotnet add package Serilog.AspNetCore` adds a `<PackageReference>` and
restores it into a global cache (`~/.nuget/packages`) — there's no `node_modules` per project.

Differences from npm worth knowing:

- Versions in `.csproj` are **minimums** by default; restore picks the **lowest** version that
  satisfies all constraints (npm picks the highest). That makes builds more reproducible without a
  lock file (though `packages.lock.json` exists via `<RestorePackagesWithLockFile>`).
- Dependencies are **transitive**: if `Shop.Api` references `Shop.Domain`, and `Shop.Domain` references
  a package, `Shop.Api` gets it too.
- Microsoft's packages (`Microsoft.AspNetCore.*`, `Microsoft.EntityFrameworkCore.*`,
  `Microsoft.Extensions.*`) version together with .NET — keep them on the **same major** (10.x) as your
  target framework.

### Central Package Management

With 15 projects, keeping versions in sync by hand is painful. Put a `Directory.Packages.props` at the
repo root:

```xml
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Npgsql.EntityFrameworkCore.PostgreSQL" Version="10.0.0" />
    <PackageVersion Include="xunit" Version="2.9.3" />
  </ItemGroup>
</Project>
```

…and project files reference packages **without** a version: `<PackageReference Include="xunit" />`.
One place to upgrade, one place to review.

## Project references and architecture

A **project reference** lets one project use another's public types. References are **one-way** and
cycles are forbidden — which makes them a tool for enforcing architecture:

```text
 Shop.Api  ───►  Shop.Domain  ◄───  Shop.Tests
 (HTTP, DI,      (business rules,    (xUnit)
  config)         no ASP.NET)
```

`Shop.Domain` can't reference `Shop.Api`, so business rules physically **can't** depend on HTTP
details. If someone tries, the build fails with a circular-reference error. (Bigger systems add
`Infrastructure` for EF Core, email, etc. — that's "Clean Architecture", covered later in the track.)

```bash
dotnet add src/Shop.Api reference src/Shop.Domain
dotnet add tests/Shop.Tests reference src/Shop.Domain
```

`public` types are visible to referencing projects; `internal` types are not. Use
`<InternalsVisibleTo Include="Shop.Tests" />` in an `ItemGroup` if tests need internals.

## `Directory.Build.props`: settings for every project

Why? With ten projects, setting `<Nullable>enable</Nullable>` or `<TreatWarningsAsErrors>` in ten
places means one will be forgotten. MSBuild automatically imports a file named `Directory.Build.props`
from the project's folder **or any parent folder**. Put one at the repo root and every project inherits
its settings:

```xml
<Project>
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <AnalysisLevel>latest-recommended</AnalysisLevel>
  </PropertyGroup>
</Project>
```

It's imported **before** the body of the `.csproj`, so individual `.csproj` files can still override
any property. Common uses: target framework, nullable, warnings-as-errors, analyzers, company/version
metadata.

Gotcha: MSBuild stops at the **closest** `Directory.Build.props` it finds walking upwards. If you add a
second one in `tests/`, projects under `tests/` no longer see the root one — unless the inner file
imports it explicitly:
`<Import Project="$([MSBuild]::GetPathOfFileAbove('Directory.Build.props', '$(MSBuildThisFileDirectory)../'))" />`.

:::job title="What a real repo root looks like"
```text
.editorconfig              # code style, enforced by dotnet format / IDE
.gitignore
Directory.Build.props      # shared MSBuild settings
Directory.Packages.props   # central package versions
global.json                # pinned SDK
Shop.slnx
src/
  Shop.Api/
  Shop.Domain/
  Shop.Infrastructure/
tests/
  Shop.UnitTests/
  Shop.IntegrationTests/
```
Expect to find this layout — and to be asked not to add package versions to individual `.csproj`
files if central package management is on.
:::

## `global.json`: pin the SDK

Without `global.json`, the **newest installed SDK** builds your code. A teammate with a preview SDK
could get different warnings or behaviour. Pin it:

```bash
dotnet new globaljson --sdk-version 10.0.100 --roll-forward latestFeature
```

```json
{
  "sdk": {
    "rollForward": "latestFeature",
    "version": "10.0.100"
  }
}
```

`latestFeature` means "10.0.100 or any newer 10.0.x patch/feature band, but not 11". If no matching
SDK is installed, every `dotnet` command in that folder fails with a clear "requested SDK version not
found" error — loud on purpose. CI uses the same file (`actions/setup-dotnet` picks up a `global.json`
in the repo root, or one you point it at with `global-json-file:`), so local and CI builds match.

Don't confuse it with `<TargetFramework>`: `global.json` chooses **which SDK builds** the code;
`TargetFramework` chooses **which runtime the output targets**. A 10.0.3xx SDK can still build a
`net8.0` project.

## User secrets: keep credentials out of git

You need a Stripe test key or a database password locally. It must **not** go in `appsettings.json`,
which is committed. The **Secret Manager** stores it in your user profile instead:

```bash
dotnet user-secrets init --project src/Shop.Api          # adds <UserSecretsId> to the .csproj
dotnet user-secrets set "Payments:ApiKey" "sk_test_123" --project src/Shop.Api
dotnet user-secrets list --project src/Shop.Api
```

The values live in `~/.microsoft/usersecrets/<UserSecretsId>/secrets.json` (Linux/macOS) or
`%APPDATA%\Microsoft\UserSecrets\<UserSecretsId>\secrets.json` (Windows) — outside the repo.
ASP.NET Core loads them automatically **only when the environment is `Development`**, and they're read
with the normal configuration API: `builder.Configuration["Payments:ApiKey"]` (be-08).

:::warn title="User secrets are not encrypted"
They're plain JSON in your home folder — a convenience for development, not a vault. Production
secrets come from environment variables, Kubernetes secrets, or a vault (Azure Key Vault, AWS Secrets
Manager, HashiCorp Vault).
:::

:::pro title="What seniors set up on day one of a repo"
- `Directory.Build.props` with `Nullable`, `TreatWarningsAsErrors` and an `AnalysisLevel`, so code
  quality doesn't depend on each developer's IDE settings.
- Central Package Management (`Directory.Packages.props`), so "which version of Npgsql do we use?"
  has exactly one answer — and Dependabot/Renovate update one file.
- `global.json` pinned to a feature band, updated deliberately in its own PR.
- A CI step `dotnet format --verify-no-changes` that fails the build on style drift, so code review
  never argues about braces.
:::

## Debugging: breakpoints beat `Console.WriteLine`

Every IDE drives the same debugger, and it's worth learning on day one instead of sprinkling
`Console.WriteLine` around:

- **Start under the debugger.** VS Code with the C# Dev Kit: `F5` and pick the project. Rider: the bug
  icon (`Shift+F9`). Visual Studio: `F5`. The IDE builds the project, starts it with the profile from
  `launchSettings.json` (be-06) and attaches.
- **Breakpoints** (click the gutter) pause on a line. While paused, hover a variable, open the
  **Locals/Watch** panes, or evaluate an expression such as `cart.Items.Sum(i => i.Price)`. Then step
  (Visual Studio / VS Code keys): **over** (`F10`), **into** (`F11`), **out** (`Shift+F11`), or **continue** (`F5`).
- **Conditional breakpoints** (`order.Id == 42`) and **logpoints** (log a value without stopping)
  save you from stopping 500 times in a loop.
- **Debug a single test.** "Debug Test" above an xUnit `[Fact]` is the fastest way to reproduce a bug.
  The tests in every lab are a ready-made playground.
- **Break on thrown exceptions** (exception settings) when a framework catches the exception and turns
  it into a 500. Otherwise you only ever see the aftermath.

A command-line build is a **Debug** build by default (`bin/Debug/…`): no optimizations, full symbols,
so the debugger shows every local. `-c Release` optimizes. Variables can then show as "optimized away",
which is one reason you never debug a Release build if you can avoid it. Production processes are
diagnosed with logs, traces and dumps (`dotnet-dump`, `dotnet-trace`, `dotnet-counters`; be-20 uses the
last two), never with an attached debugger.

The **Debugging Like a Pro** lesson in Pro Skills goes deeper: the systematic method, attaching to a
running process or container, reading stack traces and `git bisect`.

## From `dotnet publish` to a running server

`dotnet build` output is for your machine. **`dotnet publish`** produces the folder you actually
deploy: your DLLs, their dependencies and the config files, with nothing build-related:

```bash
dotnet publish src/Shop.Api -c Release -o out    # framework-dependent: needs the ASP.NET Core runtime installed
dotnet out/Shop.Api.dll                          # how a server (or a container) starts it
```

| Option | What you get | When |
|---|---|---|
| default (framework-dependent) | Small output, needs the matching runtime on the machine | Containers built on `mcr.microsoft.com/dotnet/aspnet:10.0`, the common case |
| `--self-contained -r linux-x64` | Output includes the runtime, so it runs on a machine without .NET | Machines you don't control, `runtime-deps` base images |
| `-p:PublishAot=true` | Native executable, fast startup, but not every library supports it | Small services and CLIs; check your packages first |
| `dotnet publish -t:PublishContainer` | An OCI container image built by the SDK itself, with no Dockerfile | Quick, conventional images; most teams still keep a Dockerfile |

What changes between your laptop and production is **configuration**, not code. The same published
output gets a different `ASPNETCORE_ENVIRONMENT`, connection strings and secrets from environment
variables, Kubernetes secrets or a vault (be-08 explains the configuration sources). User secrets don't
exist there. Database migrations run as a separate deployment step, for example a migration bundle
(be-10).

This track stops at `publish`. The rest of the path is covered elsewhere:

- **Multi-Stage Builds for .NET and React** (Containers & Kubernetes): the production Dockerfile,
  `sdk` vs `aspnet` vs chiseled images, non-root users.
- **Configuration, Secrets & Feature Flags** (Pro Skills): where production secrets live and how they
  reach the app.
- **Shipping Safely: Continuous Delivery & Releases** (Pro Skills): promoting one image through
  environments, expand/contract migrations, deploy gates and rollbacks.

## Check yourself

:::quiz id=be-05-q1
A teammate's build produces different warnings than yours because they installed a preview SDK. What prevents this?

- [ ] Adding `<TargetFramework>net10.0</TargetFramework>` to every project
- [x] A `global.json` that pins the SDK version
- [ ] Running `dotnet restore` before building
- [ ] Deleting `bin/` and `obj/`
> `TargetFramework` chooses which **runtime** you compile for, not which **SDK** compiles — both machines already target `net10.0`, so that changes nothing. `restore` and deleting `bin/`/`obj/` only refresh packages and build output; the preview SDK would still be used. `global.json` selects the SDK used in that folder tree — locally and in CI.
:::

:::quiz id=be-05-q2
Where do `dotnet user-secrets` values live, and when are they loaded?

- [ ] In `appsettings.Development.json`, always loaded
- [ ] Encrypted in the `.csproj`, loaded in every environment
- [x] In a `secrets.json` in your user profile, loaded automatically only in the `Development` environment
- [ ] In environment variables, loaded only in Production
> Secret Manager keeps values out of the repository, in a per-user folder keyed by `<UserSecretsId>`. `WebApplication.CreateBuilder` adds them as a configuration source when `ASPNETCORE_ENVIRONMENT` is `Development`. `appsettings.Development.json` is committed to git, so it's exactly where secrets must *not* go, and nothing is ever encrypted into the `.csproj` — only the `UserSecretsId` (a harmless GUID) is stored there.
:::

:::quiz id=be-05-q3
`Shop.Api` references `Shop.Domain`. Someone adds a reference from `Shop.Domain` to `Shop.Api` so a domain class can read `HttpContext`. What happens?

- [ ] It works; .NET supports circular references
- [x] The build fails: project references can't be circular — and the design is wrong anyway
- [ ] It works, but only in Debug builds
- [ ] NuGet resolves it automatically
> Project references form a directed acyclic graph: to build `Shop.Api` MSBuild must first build `Shop.Domain`, which would first need `Shop.Api`… so the build stops with `MSB4006: There is a circular dependency`. That happens in every configuration, and NuGet has nothing to do with project references. The failure is useful: domain logic shouldn't know about HTTP. Pass the data the domain needs (a user id, a culture) as parameters instead.
:::

:::quiz id=be-05-q4
You create `Directory.Build.props` at the repo root with `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>`. Which projects are affected?

- [ ] Only projects listed in the `.slnx`
- [ ] Only projects that explicitly `<Import>` it
- [x] Every project in that folder and all subfolders (unless a closer `Directory.Build.props` or the project itself overrides it)
- [ ] None until you register it with `dotnet new buildprops`
> MSBuild walks up from each project's directory and auto-imports the first `Directory.Build.props` it finds — no `<Import>` needed, and it doesn't care whether the project is in a solution. That's why one file at the root configures the whole repo. `dotnet new buildprops` is merely a template that creates an empty file for you; a hand-written file works exactly the same, and takes effect on the very next build. The exception is a closer `Directory.Build.props` further down, which hides this one (see q9).
:::

:::quiz id=be-05-q5
Which statements about this project file are true? (select all)

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Npgsql" Version="10.0.0" />
  </ItemGroup>
</Project>
```

- [x] It compiles every `.cs` file under the project folder without listing them
- [ ] It's an ASP.NET Core web app
- [x] Projects referencing this one also get `Npgsql` transitively
- [x] Assigning `null` to a variable declared as `string` (not `string?`) produces a compiler warning in this project
> SDK-style projects glob `**/*.cs` by default. `Microsoft.NET.Sdk` (not `.Web`) means library/console/test — a web app would use `Microsoft.NET.Sdk.Web`. Package references flow transitively to referencing projects. `<Nullable>enable</Nullable>` turns on nullable reference type analysis, so `string` means "never null" and `string?` means "may be null".
:::

:::quiz id=be-05-q6
What should be in `.gitignore` for a .NET repo? (select all)

- [x] `bin/`
- [x] `obj/`
- [ ] `*.csproj`
- [ ] `global.json`
> `bin/` and `obj/` are build output and restore intermediates — regenerated on every build, machine-specific, and noisy in diffs. Project files and `global.json` are source: ignore the `.csproj` and nobody else can build the project; ignore `global.json` and the SDK pin is gone. `dotnet new gitignore` gives you the standard file.
:::

:::quiz id=be-05-q7
During development you want the API to restart automatically when you save a `.cs` file. Which command?

- [ ] `dotnet run --reload`
- [x] `dotnet watch`
- [ ] `dotnet build --watch`
- [ ] `dotnet dev`
> `dotnet watch` (implicitly `dotnet watch run`) watches files, applies Hot Reload when possible and restarts the app otherwise — the equivalent of `vite dev` / `nodemon`. The other options look plausible but don't exist: `dotnet run` and `dotnet build` have no watch/reload flag, and there's no `dotnet dev` command.
:::

:::quiz id=be-05-q8
Central Package Management is on (`Directory.Packages.props` with `ManagePackageVersionsCentrally`). A colleague adds this line to a `.csproj` and the build breaks. Why?

```xml
<PackageReference Include="Humanizer" Version="2.14.1" />
```

- [ ] Humanizer isn't compatible with `net10.0`
- [x] With CPM on, a `PackageReference` must not specify a `Version` — the version belongs in a `<PackageVersion>` entry in `Directory.Packages.props` (error `NU1008`)
- [ ] `PackageReference` items must be in `Directory.Build.props`
- [ ] The package must be added with `dotnet package add`, not by editing XML
> CPM's whole point is "one place for versions", so NuGet refuses a version on the project's `PackageReference` with `NU1008`. Fix: move it to `<PackageVersion Include="Humanizer" Version="2.14.1" />` in `Directory.Packages.props` and leave `<PackageReference Include="Humanizer" />` in the project. Editing XML by hand is perfectly fine — the CLI commands just write the same XML (and respect CPM).
:::

:::quiz id=be-05-q9
The repo root has a `Directory.Build.props` with `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>`. Someone adds a second `tests/Directory.Build.props` containing only `<IsPackable>false</IsPackable>`. What happens to the test projects under `tests/`?

- [ ] They get both files' settings merged automatically
- [x] They only see `tests/Directory.Build.props` — the root settings (warnings-as-errors, nullable…) silently stop applying to them
- [ ] The build fails because two `Directory.Build.props` files conflict
- [ ] Nothing changes; the root file always wins
> MSBuild imports only the **closest** `Directory.Build.props` walking upwards, and then stops. There's no merge and no error, which is why this bug is sneaky: tests quietly lose nullable and warnings-as-errors. The fix is to have the inner file import the outer one with `<Import Project="$([MSBuild]::GetPathOfFileAbove('Directory.Build.props', '$(MSBuildThisFileDirectory)../'))" />`.
:::

:::quiz id=be-05-q10
Your API works on your laptop. What is the right way to produce what gets deployed, and where do production settings come from?

- [ ] Copy `bin/Debug/net10.0/` to the server and edit `appsettings.json` there with the production password
- [x] `dotnet publish -c Release`, then supply environment-specific settings and secrets from environment variables, Kubernetes secrets or a vault
- [ ] `dotnet run -c Release` on the server, with user secrets configured on the server
- [ ] Commit an `appsettings.Production.json` containing the production connection string
> `publish` produces optimized output without build leftovers, and the **same** output should run in every environment. Only configuration differs, and secrets never go into a file in the repo. A Debug build is unoptimized, `dotnet run` needs the whole SDK and source on the server, and user secrets are a development-only convenience that ASP.NET Core only loads in `Development`.
:::

## Lab: Api + Domain + Tests solution

:::lab id=be-05-lab1 xp=100
title: Build a real solution layout from scratch

You'll create the repo layout you'll meet at work: a solution with an API, a domain library and a test
project, shared build settings, a pinned SDK and a user secret.

**1. Folder, solution, gitignore, SDK pin**

```bash
mkdir Shop && cd Shop
git init
dotnet new gitignore
dotnet new globaljson --sdk-version 10.0.100 --roll-forward latestFeature
dotnet new sln -n Shop
```

You should now have `.gitignore`, `global.json` and `Shop.slnx`.

**2. Three projects**

```bash
dotnet new classlib -o src/Shop.Domain
dotnet new web -o src/Shop.Api
dotnet new xunit -o tests/Shop.Tests
```

**3. Wire them up**

```bash
dotnet sln add src/Shop.Domain src/Shop.Api tests/Shop.Tests
dotnet add src/Shop.Api reference src/Shop.Domain
dotnet add tests/Shop.Tests reference src/Shop.Domain
rm src/Shop.Domain/Class1.cs tests/Shop.Tests/UnitTest1.cs
cat Shop.slnx
```

`Shop.slnx` should list the projects under `/src/` and `/tests/` solution folders:

```xml
<Solution>
  <Folder Name="/src/">
    <Project Path="src/Shop.Api/Shop.Api.csproj" />
    <Project Path="src/Shop.Domain/Shop.Domain.csproj" />
  </Folder>
  <Folder Name="/tests/">
    <Project Path="tests/Shop.Tests/Shop.Tests.csproj" />
  </Folder>
</Solution>
```

**4. Shared settings — create `Directory.Build.props` in the repo root**

```xml
<Project>
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
  </PropertyGroup>
</Project>
```

(No `<LangVersion>` needed: the C# version follows the target framework, so `net10.0` already means
C# 14.)

Optional clean-up: delete the now-duplicated `TargetFramework`, `Nullable` and `ImplicitUsings` lines
from the three `.csproj` files and confirm the build still works.

**5. Domain code — `src/Shop.Domain/Cart.cs`**

```csharp
namespace Shop.Domain;

public sealed record CartLine(string Sku, decimal UnitPrice, int Quantity)
{
    public decimal Subtotal => UnitPrice * Quantity;
}

public sealed class Cart
{
    private readonly List<CartLine> _lines = [];

    public IReadOnlyList<CartLine> Lines => _lines;

    public void Add(string sku, decimal unitPrice, int quantity = 1)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sku);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(quantity);
        ArgumentOutOfRangeException.ThrowIfNegative(unitPrice);

        var existing = _lines.FindIndex(l => l.Sku == sku);
        if (existing >= 0)
        {
            var line = _lines[existing];
            _lines[existing] = line with { Quantity = line.Quantity + quantity };
        }
        else
        {
            _lines.Add(new CartLine(sku, unitPrice, quantity));
        }
    }

    public decimal Total => _lines.Sum(l => l.Subtotal);
}
```

**6. Tests — `tests/Shop.Tests/CartTests.cs`**

```csharp
using Shop.Domain;

namespace Shop.Tests;

public class CartTests
{
    [Fact]
    public void New_cart_is_empty_and_totals_zero()
    {
        var cart = new Cart();

        Assert.Empty(cart.Lines);
        Assert.Equal(0m, cart.Total);
    }

    [Fact]
    public void Adding_the_same_sku_twice_merges_the_lines()
    {
        var cart = new Cart();
        cart.Add("BOOK-1", 12.50m);
        cart.Add("BOOK-1", 12.50m, 2);

        var line = Assert.Single(cart.Lines);
        Assert.Equal(3, line.Quantity);
        Assert.Equal(37.50m, cart.Total);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public void Quantity_must_be_positive(int quantity)
    {
        var cart = new Cart();

        Assert.Throws<ArgumentOutOfRangeException>(() => cart.Add("X", 1m, quantity));
    }
}
```

**7. API that uses the domain — replace `src/Shop.Api/Program.cs`**

```csharp
using Shop.Domain;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/", () => "Shop API is running");

app.MapGet("/demo-cart", () =>
{
    var cart = new Cart();
    cart.Add("BOOK-1", 12.50m, 2);
    cart.Add("PEN-7", 1.99m);
    return new { cart.Lines, cart.Total };
});

// Shows WHETHER the secret is configured - never print secret values.
app.MapGet("/secret-check", (IConfiguration config) =>
    new { paymentsKeyConfigured = !string.IsNullOrEmpty(config["Payments:ApiKey"]) });

app.Run();
```

**8. A user secret**

```bash
dotnet user-secrets init --project src/Shop.Api
dotnet user-secrets set "Payments:ApiKey" "sk_test_local_only" --project src/Shop.Api
```

**9. Build, test, run**

```bash
dotnet build          # expect: Build succeeded.  0 Warning(s)  0 Error(s)
dotnet test           # expect: Passed!  - Failed:     0, Passed:     4, Skipped:     0, Total:     4
dotnet run --project src/Shop.Api
```

Four tests, because the `[Theory]` with two `[InlineData]` rows counts as two. If the build fails with
`NU1901`–`NU1904` (a package with a known vulnerability), that's warnings-as-errors doing its job:
update the package it names with `dotnet add <project> package <id>`.

`dotnet run` prints `Using launch settings from src/Shop.Api/Properties/launchSettings.json...` and
then `Now listening on: http://localhost:5xxx` (the port is random per project and comes from that
file). In another terminal, using your port:

```bash
curl http://localhost:5xxx/demo-cart
# {"lines":[{"sku":"BOOK-1","unitPrice":12.50,"quantity":2,"subtotal":25.00},{"sku":"PEN-7","unitPrice":1.99,"quantity":1,"subtotal":1.99}],"total":26.99}
curl http://localhost:5xxx/secret-check
# {"paymentsKeyConfigured":true}
```

**10. Prove the architecture rule:** try `dotnet add src/Shop.Domain reference src/Shop.Api`, then
`dotnet build`. You'll get `error MSB4006: There is a circular dependency in the target dependency
graph…`. Undo it with `dotnet remove src/Shop.Domain reference src/Shop.Api/Shop.Api.csproj` (give the
full `.csproj` path when removing).

**11. Prove warnings-as-errors:** add `int unused = 0;` inside `Cart.Add` and build. The warning
(CS0219) is now an error. Remove it.

- [ ] `Shop.slnx`, `global.json`, `.gitignore` and `Directory.Build.props` exist at the repo root
- [ ] `dotnet test` passes 4 tests
- [ ] `/demo-cart` returns the cart JSON and `/secret-check` returns `true`
- [ ] `git status` shows no `bin/` or `obj/` folders and no secret value anywhere in the repo
- [ ] I saw the circular reference fail and the warning-as-error break the build
:::

## Flashcards

:::cards id=be-05-cards1 title=".NET CLI & projects"
Q: SDK vs runtime?
A: SDK = tools to build (compiler, CLI, templates). Runtime = what's needed to run an app. Production images ship only the runtime.
Q: What's a `.slnx`?
A: The XML solution format, default since .NET 10. It lists projects (and folders); much more readable and merge-friendly than `.sln`.
Q: `Microsoft.NET.Sdk` vs `Microsoft.NET.Sdk.Web`?
A: `.Web` adds ASP.NET Core (framework reference, web defaults). Plain SDK is for libraries, consoles and tests.
Q: `PackageReference` vs `ProjectReference`?
A: PackageReference = NuGet package by id + version. ProjectReference = another project in your repo by path.
Q: What does `Directory.Build.props` do?
A: Auto-imported by every project in its folder and below — shared MSBuild properties.
Q: Two `Directory.Build.props` files on the path — which applies?
A: Only the closest one walking up from the project. The inner file must `<Import>` the outer one explicitly to get both.
Q: What does `Directory.Packages.props` do?
A: Central Package Management: package versions declared once; projects reference packages without versions.
Q: What does `global.json` pin?
A: The SDK version (with a roll-forward policy) used to build in that folder tree.
Q: Where do user secrets live and when are they loaded?
A: `secrets.json` in your user profile (outside the repo); loaded automatically only in the Development environment.
Q: Command to auto-restart on file changes?
A: `dotnet watch`.
Q: How do you run a single C# file in .NET 10?
A: `dotnet run app.cs` — file-based apps, with `#:package` directives for NuGet packages.
:::

## Recap

- The **SDK** builds, the **runtime** runs. Pin the SDK with `global.json`; `TargetFramework` picks the
  runtime you compile for — two different knobs.
- `dotnet new / build / run / watch / test / add package / add reference / sln add` cover daily work.
- `.slnx` is the new, readable solution format; SDK-style `.csproj` files are short because of defaults.
- NuGet packages are referenced per project, cached globally and flow transitively. Use
  `Directory.Packages.props` to manage versions centrally.
- Project references are one-way and acyclic — use them to keep the domain free of HTTP concerns.
- `Directory.Build.props` shares settings (nullable, warnings-as-errors, analyzers) across projects —
  the closest one wins, there's no automatic merge.
- `dotnet user-secrets` keeps dev credentials out of git; production uses env vars or a vault.
- Debug with breakpoints and "Debug Test", not `Console.WriteLine`; diagnose production with logs,
  traces and dumps.
- `dotnet publish -c Release` produces the deployable output; production differs only in
  configuration. Containers and releases continue in the Containers & Kubernetes and Pro Skills tracks.
