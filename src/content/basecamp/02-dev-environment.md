---
id: bc-02
title: Your Dev Environment
level: beginner
minutes: 55
xp: 100
summary: Install and verify the full-stack toolbox — Node LTS, .NET 10, Docker and your first compose.yaml, Git, an editor and a Postgres GUI — on Windows, macOS or Linux.
---

Before you write a line of code at a new job, you need a machine that can **build, run and debug**
the product. On day one that is usually the biggest time sink: "it works on my machine" starts here.
This lesson installs the toolbox used through the whole academy and shows you how to *verify* each
piece, so later errors are about your code — not your setup.

| Tool | Why you need it | Verify with |
|---|---|---|
| **Node.js LTS** (via a version manager) | Runs Vite, React tooling, npm scripts, ESLint, Vitest | `node -v`, `npm -v` |
| **.NET 10 SDK** | Builds and runs ASP.NET Core APIs, EF Core migrations, xUnit tests | `dotnet --info` |
| **Docker Desktop / Podman** | Runs PostgreSQL, Redis and the app itself in containers | `docker run hello-world` |
| **Git** | Version control — everything at work lives in a repo | `git --version` |
| **VS Code or JetBrains Rider** | Editing, debugging, refactoring | open a folder, set a breakpoint |
| **DBeaver / pgAdmin** | Looking inside the database while you develop | connect to `localhost:5432` |

:::job title="What day one really looks like"
Most teams hand you a laptop and a README that says "run `./setup.sh`" or "`docker compose up`".
Half the time it fails on something small: wrong Node version, a port already taken, a missing
certificate. Knowing how each tool works lets you fix it in minutes instead of waiting a day for help.
Write down every fix you needed — then open a PR to the README. Your first contribution can be docs.
:::

## Pick your platform first

The commands differ slightly per OS. The ideas don't.

- **Windows 11** — use **winget** (built in) for installs. Seriously consider **WSL 2** (Windows
  Subsystem for Linux): you get a real Ubuntu shell, and Docker Desktop uses WSL 2 as its engine
  anyway. Keep your repos *inside* the WSL filesystem (`~/code`, not `/mnt/c/...`) — file access
  across the boundary is many times slower and breaks file watchers like Vite's.
- **macOS** — install **Homebrew** (`brew`). Apple Silicon (M-series) is ARM64: most images and SDKs
  support it natively now; if a Docker image doesn't, you'll see `no matching manifest for linux/arm64`.
- **Linux** — use your distro's package manager (`apt`, `dnf`, `pacman`) for Git and Docker, but a
  **version manager** for Node and, if needed, Microsoft's install script for .NET.

:::tip
Whatever OS you use, prefer **one terminal** you are comfortable in. On Windows that's Windows
Terminal with either PowerShell 7 or a WSL tab. The next lesson (bc-03) is a terminal survival kit.
:::

## Node.js — always through a version manager

**Node.js** is the JavaScript runtime that executes your frontend *tooling* (Vite's dev server, the
TypeScript compiler, ESLint, Vitest) — the React app itself later runs in the browser. Node comes with
**npm**, the package manager that installs dependencies into `node_modules`.

Node releases a new major version every six months; even-numbered majors become **LTS** (Long-Term
Support) and get fixes for about three years, which is why companies use them. Different projects pin
different Node versions: project A needs Node 22, project B already moved to Node 24. Installing Node
from the website gives you exactly one global version and pain when you switch. A **version
manager** installs many versions side by side and switches per project.

| Manager | Platforms | Notes |
|---|---|---|
| **fnm** (Fast Node Manager) | Windows, macOS, Linux | Written in Rust, fast, reads `.nvmrc` / `.node-version`, auto-switch on `cd` |
| **nvm** | macOS, Linux (WSL) | The classic; a shell script. `nvm-windows` is a separate, different project |
| **mise** (or the older **Volta**) | all | mise pins Node, .NET, Python… in `mise.toml`/`.tool-versions`; Volta pins in `package.json` but is no longer actively maintained — prefer mise for new setups |

Install fnm and the current LTS:

```bash
# macOS
brew install fnm
# Windows (PowerShell)
winget install Schniz.fnm
# Linux / WSL
curl -fsSL https://fnm.vercel.app/install | bash

# then add the shell hook to your shell's startup file, so every new terminal has it
echo 'eval "$(fnm env --use-on-cd)"' >> ~/.zshrc    # zsh (macOS default); bash: ~/.bashrc
# open a NEW terminal so the hook is loaded

fnm install --lts      # installs the newest LTS line
fnm default lts-latest # make it the default for new shells
node -v                # e.g. v26.x (Node 26 became LTS in Oct 2026) — whatever the newest LTS is
npm -v
```

The **shell hook** is the important part: `fnm env` puts the currently selected Node version's folder
at the front of your `PATH` (lesson bc-03 explains PATH), and `--use-on-cd` switches versions
automatically when you `cd` into a folder containing `.nvmrc` or `.node-version`. Forgetting the hook
is the #1 reason for `node: command not found` right after installing fnm.

On Windows PowerShell, put the hook in your profile instead (`notepad $PROFILE`, create the file if
it doesn't exist):

```text
fnm env --use-on-cd --shell powershell | Out-String | Invoke-Expression
```

:::info title="About curl … | bash installers"
The Linux line downloads fnm's official install script and runs it immediately. That's normal for
developer tools, but it means you trust that URL completely. Only do it for official URLs from the
project's README — and if you're unsure, download the script first and read it.
:::

**Pin the version in the repo** so everyone (and CI) uses the same one:

```bash
node -v > .nvmrc          # writes e.g. "v24.11.0"; fnm and nvm both read it
# many teams pin just the major instead:  echo 24 > .nvmrc
```

Many teams also add an `engines` field to `package.json` (e.g. `"engines": { "node": ">=24" }`) and
pin the package manager with a `"packageManager"` field (e.g. `"pnpm@10.x.y"`). **Corepack** reads
that field and provides exactly that `pnpm`/`yarn` version without a global install:
`corepack enable`. Corepack ships with Node 24 and older; from Node 25 on it is no longer bundled, so
on newer Node install it first with `npm install -g corepack`.

:::warn title="Never sudo npm install -g"
If `npm install -g` asks for admin rights, your Node is installed system-wide — that's the sign to
switch to a version manager. Running npm as root changes file ownership in your home folder and
leads to weird `EACCES` errors later.
:::

:::quiz id=bc-02-q1 xp=10
Your new team's repo contains a `.nvmrc` with `v22.12.0`, but you have Node 24 as default. What's
the cleanest fix?
- [ ] Uninstall Node 24 and install Node 22 from nodejs.org
- [x] `fnm install && fnm use` (or `nvm install`) inside the repo, so the manager reads `.nvmrc`, installs 22 and switches to it
- [ ] Edit `.nvmrc` to say `v24` since newer is always better
- [ ] Ignore it; Node versions are backwards compatible
> Version managers read `.nvmrc` and install/switch per project, so Node 22 and 24 live side by side.
> Uninstalling Node 24 "works" for this repo but breaks the next project that needs 24 — exactly the
> pain a version manager avoids. Editing the pin changes it for the whole team and CI — that's a team
> decision (and a PR), not a local workaround. And ignoring it is risky: native modules and some tools
> really do break across Node majors. Tip: with fnm's `--use-on-cd` shell hook, fnm switches
> automatically the next time you `cd` into the folder.
:::

## .NET 10 SDK

.NET comes in two flavours, and the difference matters:

- The **runtime** can only *run* an app that was already built (that's what goes into a production
  container image).
- The **SDK** (Software Development Kit) contains the compiler, the `dotnet` CLI, project templates,
  NuGet restore — *and* the runtimes. You need the SDK to `dotnet build`, `dotnet test` or `dotnet run`.

A common day-one mistake is installing only the "ASP.NET Core Runtime" from the download page and
then getting `No .NET SDKs were found` when you try to build. .NET 10 (released November 2025) is an
**LTS** release, supported for three years — which is why most companies standardise on LTS
versions instead of the two-year STS (Standard-Term Support) releases in between.

```bash
# Windows
winget install Microsoft.DotNet.SDK.10
# macOS (the cask installs the newest SDK)
brew install --cask dotnet-sdk
# Linux (Ubuntu example; or use Microsoft's dotnet-install.sh script)
sudo apt-get update && sudo apt-get install -y dotnet-sdk-10.0
# if apt can't find the package on Ubuntu 24.04, add the backports PPA first:
#   sudo add-apt-repository ppa:dotnet/backports

dotnet --info              # SDK version, runtimes, OS, RID
dotnet --list-sdks         # all installed SDKs side by side
dotnet new list            # available templates (webapi, xunit, classlib…)
```

Several SDKs can live side by side. A repo can pin one with a **`global.json`** at the root:

```json
{
  "sdk": {
    "version": "10.0.100",
    "rollForward": "latestFeature"
  }
}
```

How to read an SDK version like `10.0.104`: `10.0` is the .NET version, the hundreds digit (`1xx`)
is the **feature band** (new SDK features ship in `200`, `300`…), and the last two digits are the
patch. `rollForward` says what to do when that exact version isn't installed:

- `latestPatch` (the default if you omit it) — only newer patches in the same band: `10.0.1xx`.
- `latestFeature` — the newest installed `10.0.x` SDK that is ≥ `10.0.100`, any feature band. Strict
  enough to stay on .NET 10, loose enough that nobody needs the exact patch.
- `latestMajor` — anything newer, even .NET 11. Convenient, but defeats the point of pinning.

If no installed SDK matches, every `dotnet` command in that folder fails with a message naming the
required version — read it, install that SDK, done.

Two more things you'll hit quickly:

```bash
dotnet dev-certs https --trust   # trust the local HTTPS dev certificate (Windows/macOS)
dotnet tool install --global dotnet-ef   # EF Core CLI for migrations
dotnet ef --version
```

Why the certificate? ASP.NET Core templates serve the API over HTTPS on `localhost`, and browsers
reject certificates they don't trust. `--trust` adds the locally generated dev certificate to your
OS/browser trust store. On Linux, `--trust` support depends on the distro and browser; many devs
just run the API on plain HTTP locally behind the Vite proxy.

:::info title="Global tools vs local tools"
`dotnet tool install --global` puts a tool on your PATH (in `~/.dotnet/tools`) for every project.
Teams often prefer a **local tool manifest**: `dotnet new tool-manifest` creates a
`dotnet-tools.json` file, `dotnet tool install dotnet-ef` (without `--global`) records the tool and
its version in it, and after cloning, `dotnet tool restore` gives everyone the same version — like
`devDependencies` in npm. Local tools run with `dotnet ef …` inside the repo.
:::

:::quiz id=bc-02-q4 xp=10
A colleague installed the **ASP.NET Core Runtime 10** on their laptop. `dotnet --list-runtimes`
shows it, but `dotnet build` in the API repo fails. Why?
- [ ] The runtime is broken; reinstalling it will fix the build
- [x] A runtime can only run built apps — building needs the .NET SDK, which includes the compiler and CLI commands like `build`
- [ ] `dotnet build` only works inside Docker
- [ ] They need .NET 11, because building always requires a newer version than running
> Runtime = run already-compiled apps; SDK = build, test, run from source (and it contains the
> runtimes too). Reinstalling the same runtime changes nothing — the compiler simply isn't in it.
> `dotnet --list-sdks` would show an empty list, which is the giveaway.
:::

## Docker Desktop or Podman

A **container** is a process that runs with its own isolated filesystem, built from an **image** (a
packaged snapshot of an app plus everything it needs, e.g. `postgres:18`). That lets you run
PostgreSQL, Redis, RabbitMQ or the whole app without installing them on your machine — and throw them
away just as easily. Every developer on the team gets the exact same database version from one
command. The local database for this academy runs in a container. (The Containers region covers how
it all works in depth.)

- **Docker Desktop** — Windows/macOS (uses a small Linux VM; on Windows that's WSL 2). Free for
  personal use, education, open source and small businesses (fewer than 250 employees *and* under
  $10 million annual revenue); **larger companies need a paid subscription** — check with IT.
- **Podman Desktop** — a daemonless, rootless alternative. `podman` accepts the same commands
  (`alias docker=podman` works for most things); `podman compose` handles compose files.
- **Linux** — install Docker Engine from Docker's repo (or Podman from your distro). Add yourself to
  the `docker` group (`sudo usermod -aG docker $USER`, then log out and in) so you don't need `sudo`.

```bash
docker --version
docker compose version       # Compose v2 is a plugin: "docker compose", not "docker-compose"
docker run --rm hello-world  # pulls a tiny image and prints a greeting
```

Now start a PostgreSQL 18 you can use for the rest of the course:

```bash
docker run -d --name devquest-pg \
  -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=devquest \
  -p 5432:5432 -v devquest-pgdata:/var/lib/postgresql \
  postgres:18

docker ps                    # is it running?
docker logs devquest-pg      # "database system is ready to accept connections"
docker exec -it devquest-pg psql -U postgres -d devquest -c "select version();"
```

What each part means:

| Part | Meaning |
|---|---|
| `-d` | detached — run in the background and give the terminal back |
| `--name devquest-pg` | a fixed name, so later commands can say `devquest-pg` instead of a random ID |
| `-e KEY=value` | environment variables the image reads on first start: superuser password, a database to create |
| `-p 5432:5432` | **host port : container port** — `localhost:5432` on your machine forwards into the container |
| `-v devquest-pgdata:/var/lib/postgresql` | a **named volume** mounted where Postgres keeps its data |
| `postgres:18` | image name and tag (the major version) |

Expected output of the last command (details vary by platform):

```text
                                 version
--------------------------------------------------------------------------
 PostgreSQL 18.x on x86_64-pc-linux-gnu, compiled by gcc ...
(1 row)
```

The **named volume** is why your data survives `docker rm`: the container's own filesystem is
disposable, the volume is managed separately by Docker. The password here is a throwaway local
value — never reuse a real password for local containers.

:::warn title="PostgreSQL 18 moved its data directory"
Older tutorials (and most Stack Overflow answers) mount `-v …:/var/lib/postgresql/data`. Since the
`postgres:18` image, data lives in a version-specific subfolder (`/var/lib/postgresql/18/docker`) and
the volume belongs at `/var/lib/postgresql`. If you mount the old path on an 18 image, the container
refuses to start and its log explains the new layout. Mount the parent folder as shown above.
:::

:::warn title="Port 5432 already in use?"
If you already have a native PostgreSQL installed, the container can't bind `5432`. Either stop the
native service or map another host port: `-p 5433:5432`, then connect to `localhost:5433`.
Lesson bc-03 shows how to find out which process owns a port.
:::

:::quiz id=bc-02-q2 xp=10
You ran `docker rm -f devquest-pg` and then started the same `docker run` command again. Is your
data still there?
- [x] Yes — the data lives in the named volume `devquest-pgdata`, which `docker rm` does not delete
- [ ] No — removing a container always deletes its data
- [ ] Only if you used `--restart always`
> Containers are disposable; volumes are not. "Removing a container deletes its data" is only true
> for data written *inside* the container's own filesystem — here Postgres writes into the named
> volume, which outlives the container and is re-attached by the same `-v` flag. `--restart` only
> controls whether Docker restarts a stopped container; it has nothing to do with data. `docker
> volume ls` shows the volume, and only `docker volume rm devquest-pgdata` (or `docker compose down
> -v` for compose projects) actually deletes the data.
:::

:::quiz id=bc-02-q5 xp=10
A native PostgreSQL already uses port 5432 on your laptop, so you start the container with
`-p 5433:5432`. What do you enter as the port in DBeaver?
- [ ] `5432` — that's the port Postgres listens on inside the container
- [x] `5433` — the left side is the port on your machine, which forwards to 5432 in the container
- [ ] Either; Docker picks whichever is free
- [ ] `5432:5433`
> `-p HOST:CONTAINER`. Your GUI runs on the host, so it connects to the host side: `localhost:5433`.
> Inside the container Postgres still listens on 5432 — that's the tempting answer, but if you
> connect to `localhost:5432` you'll reach the *native* Postgres instead, and wonder why your
> `devquest` database is missing.
:::

## Your first compose.yaml

One `docker run` is fine. But a real product needs several containers — PostgreSQL, **Redis** (an
in-memory key-value store used for caching, sessions, rate limits and simple queues), maybe a message
broker — each with its own ports, volumes and environment variables. Typing those commands from a
README is slow and error-prone, and everybody ends up with slightly different flags.

**Docker Compose** fixes that: you describe all the containers once, in a `compose.yaml` that is
committed to the repo, and one command starts them all with exactly the same settings for every
developer. This is the "`docker compose up`" from the day-one README above, and it's how bc-07's
"bring it up" sequence starts the infrastructure.

Create a folder `~/code/compose-demo` with this `compose.yaml`:

```yaml
services:
  db:                         # the service name — you type it in commands
    image: postgres:18
    environment:
      POSTGRES_PASSWORD: devpass
      POSTGRES_DB: devquest
    ports:
      - "5432:5432"           # HOST:CONTAINER, same as -p
    volumes:
      - pgdata:/var/lib/postgresql
    healthcheck:              # how Compose knows Postgres is really ready
      test: ["CMD-SHELL", "pg_isready -U postgres -d devquest"]
      interval: 5s
      timeout: 3s
      retries: 10

  redis:
    image: redis:8
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  pgdata:                     # a named volume, managed by Compose
```

Every key maps onto a `docker run` flag you already know: `image` → the image, `environment` → `-e`,
`ports` → `-p`, `volumes` → `-v`. Two things are new:

- **Service names** (`db`, `redis`) are what you type in commands (`docker compose logs db`), and
  they're also the **hostnames** containers use to reach each other on Compose's private network —
  an API *container* would connect to `Host=db`, not `localhost`. This course names the Postgres
  service `db`, like the Containers lessons do; every team picks its own, so read the file.
- A **healthcheck** is a command Docker runs inside the container every few seconds. "Running" only
  means the process started; Postgres needs a few more seconds before it accepts connections.
  `healthy` means the check passed — the moment it's safe to start the API.

The commands you'll use every day:

```bash
cd ~/code/compose-demo
docker stop devquest-pg       # free port 5432 first (the container from above uses it)

docker compose up -d          # create and start every service in the background
docker compose ps             # STATUS should become "Up … (healthy)" for both
docker compose logs db        # one service's logs (add -f to follow, Ctrl+C to stop)
docker compose exec db psql -U postgres -d devquest -c "select 1;"
docker compose exec redis redis-cli ping      # PONG
docker compose up -d db       # start only one service (by its service name)

docker compose down           # stop and remove the containers + network — the volume survives
docker compose down -v        # ALSO delete the named volumes: a fresh, empty database next time

docker start devquest-pg      # back to the container the rest of the course uses
```

Compose names everything after the folder (the **project name**): the volume above becomes
`compose-demo_pgdata`, the containers `compose-demo-db-1` and `compose-demo-redis-1`. No `version:`
line is needed at the top — Compose v2 ignores it, and old tutorials that start with `version: "3.8"`
are simply outdated. Older repos call the file `docker-compose.yml`; Compose reads both names.

:::tip title="Where to go deeper"
This is just enough Compose to run a team's local stack. The Containers & Kubernetes lesson
**Docker Compose for the Full Stack** adds the API and frontend, `depends_on` with
`condition: service_healthy`, env files, profiles and watch mode. What Redis is actually good for is
covered in the Cloud-Native Toolkit, starting with **Redis Fundamentals**.
:::

:::quiz id=bc-02-q7 xp=10
You want a completely fresh local database, because a migration you were testing left it in a
strange state. Which command gives you that?
- [ ] `docker compose down`
- [ ] `docker compose restart db`
- [x] `docker compose down -v`, then `docker compose up -d`
- [ ] `docker compose stop db && docker compose start db`
> The data lives in the named volume `pgdata`, and only `-v` deletes named volumes. Plain `down`
> removes the containers and network but keeps the volume, so the next `up` re-attaches the same
> data — the tempting answer, and exactly why your data normally survives. `restart` and
> `stop`/`start` don't even recreate the container. Use `-v` deliberately: it's the "delete my
> local database" button.
:::

:::quiz id=bc-02-q8 xp=10
A teammate's README says `docker compose up -d postgres`, but it fails with
`no such service: postgres`. The repo's `compose.yaml` starts with `services:` → `db:` → `image: postgres:18`.
What's going on?
- [ ] The `postgres:18` image isn't downloaded yet
- [x] Commands use the **service name** from `compose.yaml` (`db`), not the image name — run `docker compose up -d db` and fix the README
- [ ] Compose needs the full container name, `compose-demo-db-1`
- [ ] Postgres must always be started with `docker run`, not Compose
> The key under `services:` is the name Compose knows the service by; the image (`postgres:18`) is
> just what that service runs. A missing image would be pulled automatically, not reported as "no
> such service". The generated container name works for plain `docker` commands, but `docker
> compose` subcommands take service names. And yes — fixing the README is a perfect first PR.
:::

## Git

```bash
# Windows
winget install Git.Git
# macOS (or use the Xcode command line tools' git)
brew install git
# Linux
sudo apt-get install -y git

git --version
```

Configure it once — your commits carry this identity:

```bash
git config --global user.name  "Ada Lovelace"
git config --global user.email "ada@company.com"     # the email your GitHub/GitLab account knows
git config --global init.defaultBranch main
git config --global pull.rebase true                 # see bc-04 for why
git config --global core.autocrlf input              # macOS/Linux; on Windows use "true"
```

`core.autocrlf` controls line-ending conversion (see the warning below): `input` converts CRLF to LF
when you commit and never back; `true` (Windows) checks files out with CRLF and commits LF.

Then set up **SSH keys** (or a credential manager) so pushes don't ask for passwords. GitHub stopped
accepting account passwords for Git operations years ago — you need either an SSH key or a token.
An SSH key is a pair: the **private key** (`id_ed25519`) never leaves your machine; the **public
key** (`id_ed25519.pub`) is what you give to GitHub. When you connect, your machine proves it holds
the private key without ever sending it.

```bash
ssh-keygen -t ed25519 -C "ada@company.com"   # accept the default path, set a passphrase
cat ~/.ssh/id_ed25519.pub                    # paste the PUBLIC key into GitHub → Settings → SSH and GPG keys
ssh -T git@github.com                        # first time: answer "yes" to the host fingerprint prompt
```

Expected answer from the last command:

```text
Hi ada! You've successfully authenticated, but GitHub does not provide shell access.
```

:::warn title="Never share the private key"
Only the `.pub` file goes anywhere. If you ever paste `id_ed25519` (no `.pub`) into a website, chat
or repo, treat it as leaked: delete the key on GitHub and generate a new one.
:::

:::warn title="Line endings bite cross-platform teams"
Windows uses CRLF, Linux/macOS use LF. A shell script with CRLF fails in a Linux container with
`/bin/sh^M: bad interpreter`. The robust fix is a committed `.gitattributes` (`* text=auto eol=lf`)
so the repo decides, not each developer's settings.
:::

:::job
Many companies require **signed commits** (GPG or SSH signing) and **SSO-authorised** keys for the
company GitHub organisation. If `git push` fails with "SAML SSO" or "permission denied" on a repo you
can see in the browser, authorise your key/token for the org in GitHub's settings.
:::

## Your editor: VS Code or Rider

Both are fine; teams usually allow either. What matters is that **debugging works** for both the
React frontend and the .NET backend.

**VS Code** (free) — install these extensions:

| Extension | What it gives you |
|---|---|
| **C# Dev Kit** (Microsoft) | C# language server, solution explorer, test explorer, debugger |
| **ESLint** | Lint errors inline, fix-on-save |
| **Prettier** | Code formatting on save (set it as the default formatter) |
| **Docker** / **Container Tools** | See containers, images, logs; compose up/down from the editor |
| **PostgreSQL** (Microsoft) or **SQLTools** + PG driver | Run queries without leaving the editor |
| Optional: **GitLens**, **EditorConfig**, **Error Lens**, **REST Client** | Blame, shared formatting rules, inline errors, `.http` files |

Useful settings (`.vscode/settings.json`, often committed by the team):

```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.codeActionsOnSave": { "source.fixAll.eslint": "explicit" },
  "[csharp]": { "editor.defaultFormatter": "ms-dotnettools.csharp" }
}
```

Teams also commit `.vscode/extensions.json` with `"recommendations"` so VS Code prompts new people
to install the right extensions — check for it on day one.

**JetBrains Rider** (paid, free for non-commercial use) — one IDE for C#, TypeScript, React,
databases (built-in DataGrip-like client) and Docker. Excellent refactorings and a very good .NET
debugger. Many .NET shops buy licences; ask.

:::pro
Whichever editor you choose, learn three things on day one: **go to definition / find usages**,
**rename symbol** (a real refactor, not search-and-replace), and **run one test under the
debugger**. Those three make an unfamiliar codebase dramatically less scary. The lab below gets
your first breakpoint working; the Pro Skills lesson **Debugging Like a Pro** then teaches the full
toolkit — browser DevTools, breakpoints in React and ASP.NET Core, reading stack traces.
:::

## A PostgreSQL GUI

`psql` is great, but when exploring an unfamiliar schema a GUI saves time:

- **DBeaver** (free, all OSes) — ER diagrams, data editor, works with any database.
- **pgAdmin 4** (free, Postgres-specific) — the official admin tool; also available as a container.
- Also popular: **DataGrip** / Rider's database tool, **Beekeeper Studio**, **TablePlus**.

Connect to the container you started: host `localhost`, port `5432`, database `devquest`, user
`postgres`, password `devpass`.

:::warn title="Never point a GUI at production casually"
GUIs make it easy to edit rows by double-clicking. At work you'll often get read-only production
credentials for debugging. Mark production connections in red (DBeaver: connection type
"Production"), and default to read-only. One accidental `UPDATE` without `WHERE` is a career story
you don't want.
:::

:::quiz id=bc-02-q3 xp=10
Which statements about pinning tool versions in a repo are true? (select all that apply)
- [x] `.nvmrc` / `.node-version` pins the Node version for version managers
- [x] `global.json` pins the .NET SDK version used by `dotnet` in that folder
- [x] A local tool manifest (`dotnet-tools.json`, created by `dotnet new tool-manifest`) pins .NET CLI tools like `dotnet-ef`
- [ ] Pinning is pointless because CI installs its own versions anyway
> The first three are all real pinning mechanisms. The last one sounds plausible but is backwards:
> CI workflows usually read the *same* files (`actions/setup-node` with `node-version-file: .nvmrc`,
> `actions/setup-dotnet` with `global-json-file: global.json`, `dotnet tool restore`) — so pins are
> exactly what makes your machine and CI agree, and stop "passes locally, fails in CI".
:::

:::quiz id=bc-02-q6 xp=10
You're on Windows with WSL 2. You cloned the repo to `C:\code\shop` and run `npm run dev` from the
WSL shell in `/mnt/c/code/shop`. Saving a file doesn't reload the browser and installs are very
slow. What's the fix?
- [ ] Reinstall Node inside Windows instead of WSL
- [ ] Turn off the antivirus completely
- [x] Clone the repo inside the Linux filesystem (e.g. `~/code/shop`) and work from there
- [ ] Switch from Vite to webpack
> `/mnt/c` is the Windows drive seen through a translation layer: every file access crosses the
> Windows↔Linux boundary, which is slow, and Linux file-change notifications (what Vite's watcher
> relies on) don't arrive for files changed there. Keeping the repo in `~/code` fixes both. Mixing
> Windows-Node with WSL tooling just moves the problem; disabling antivirus is a security risk and
> doesn't fix the missing file events.
:::

## Verify everything in one go

Save this as `check-env.sh` (macOS/Linux/WSL) and run `bash check-env.sh`:

```bash
#!/usr/bin/env bash
for cmd in "node -v" "npm -v" "dotnet --version" "git --version" "docker --version" "docker compose version"; do
  printf '%-24s' "$cmd"
  out=$($cmd 2>/dev/null | head -n1)   # $cmd is unquoted on purpose: "node -v" must split into two words
  echo "${out:-MISSING}"               # print the output, or MISSING if it was empty
done
docker exec devquest-pg pg_isready -U postgres || echo "postgres container not ready"
```

Expected output (your versions will differ):

```text
node -v                 v24.11.0
npm -v                  11.6.2
dotnet --version        10.0.100
git --version           git version 2.51.0
docker --version        Docker version 28.5.1, build e180ab8
docker compose version  Docker Compose version v2.40.0
/var/run/postgresql:5432 - accepting connections
```

:::info title="Why not just pipe into head and add || echo MISSING?"
That looks right but never prints MISSING: a pipeline's exit code is the exit code of its **last**
command, and `head` succeeds even when the command before it failed. Capturing the output and
checking whether it's empty avoids the trap (bc-03 covers exit codes and `set -o pipefail`).
:::

PowerShell equivalent:

```text
"node -v","npm -v","dotnet --version","git --version","docker --version","docker compose version" | ForEach-Object {
  $exe = ($_ -split ' ')[0]
  $out = if (Get-Command $exe -ErrorAction SilentlyContinue) { Invoke-Expression $_ 2>$null | Select-Object -First 1 }
  "{0,-24}{1}" -f $_, $(if ($out) { $out } else { "MISSING" })
}
```

:::lab id=bc-02-lab1 xp=80
title: Build your full-stack workstation
Install and verify each tool. Do the work in the terminal you plan to use daily (WSL on Windows is
recommended). Then prove the pieces work together by creating a tiny React app and a tiny API.

1. Install **fnm** (or nvm), then `fnm install --lts` and set it as default.
2. Install the **.NET 10 SDK**, run `dotnet --info`, and trust the dev certificate if your OS supports it.
3. Install **Docker Desktop** or **Podman**, run `docker run --rm hello-world`.
4. Start the `devquest-pg` container from this lesson and connect with DBeaver or pgAdmin.
5. Install and configure **Git** (name, email, default branch) and an **SSH key** for GitHub.
6. Install **VS Code** with C# Dev Kit, ESLint, Prettier, Docker and a PostgreSQL extension — or Rider.
7. Smoke test both stacks:

```bash
mkdir -p ~/code && cd ~/code
npm create vite@latest hello-web -- --template react-ts
cd hello-web && npm install && npm run dev      # open http://localhost:5173, then Ctrl+C
cd ~/code && dotnet new webapi -n HelloApi
cd HelloApi && dotnet run                        # note the URL it prints, open /weatherforecast
```

The `--` after `npm create vite@latest hello-web` tells npm "everything after this goes to the
create-vite tool, not to npm". If create-vite asks whether to install and start now, either answer
works — answer *No* to follow the commands above. Expected: Vite prints `Local: http://localhost:5173/`
and the page shows the Vite + React logos. `dotnet run` prints something like:

```text
info: Microsoft.Hosting.Lifetime[14]
      Now listening on: http://localhost:5127
info: Microsoft.Hosting.Lifetime[0]
      Application started. Press Ctrl+C to shut down.
```

The port is random per project (it comes from `Properties/launchSettings.json`). Opening
`http://localhost:5127/weatherforecast` (with *your* port) returns a JSON array of five forecasts.

8. Debug the API: open the `HelloApi` folder in your editor, set a breakpoint on the line inside the
   `app.MapGet("/weatherforecast", …)` lambda in `Program.cs`, start debugging (VS Code: **F5** →
   choose C#; Rider: the bug icon), then reload `/weatherforecast` in the browser. The editor should
   stop on your breakpoint and let you inspect variables. (Stuck? **Debugging Like a Pro** in the
   Pro Skills region walks through debugger setup for VS Code and Rider step by step.)
9. Bring up the two-service stack from **Your first compose.yaml**: stop `devquest-pg`, run
   `docker compose up -d` in `~/code/compose-demo`, wait for `docker compose ps` to show both
   services `healthy`, check that `docker compose exec redis redis-cli ping` answers `PONG`, then
   `docker compose down` and `docker start devquest-pg`.

:::tip
If anything fails, copy the **exact** error message into a notes file together with the fix. That
file becomes your first README PR at a new job.
:::

- [ ] `node -v` prints an LTS version and `fnm list` (or `nvm ls`) shows it as default
- [ ] `dotnet --list-sdks` shows a 10.0.x SDK
- [ ] `docker run --rm hello-world` prints the greeting
- [ ] My GUI is connected to `devquest-pg` and `select version();` shows PostgreSQL 18
- [ ] `ssh -T git@github.com` greets me by username
- [ ] The Vite React app runs on port 5173 and the .NET API answers `/weatherforecast`
- [ ] I set a breakpoint in the API in my editor and hit it
- [ ] `docker compose ps` showed `db` and `redis` as healthy, and `docker compose exec redis redis-cli ping` answered `PONG`
:::

## Troubleshooting cheat sheet

| Symptom | Likely cause | Fix |
|---|---|---|
| `node: command not found` after installing fnm | Shell hook not loaded | Add the `fnm env` line to `~/.bashrc` / `~/.zshrc` / `$PROFILE`, open a new terminal |
| `dotnet` uses the wrong SDK | A `global.json` up the folder tree | `dotnet --version` in that folder; install the pinned SDK or check `rollForward` |
| `Cannot connect to the Docker daemon` | Docker Desktop not running / not in `docker` group | Start Docker Desktop; on Linux `sudo usermod -aG docker $USER` and re-login |
| Vite doesn't reload on save (Windows) | Repo lives on `/mnt/c` while running in WSL | Move the repo into the WSL filesystem |
| Vite says `Port 5173 is in use, trying another one...` | Another dev server still running | Find and stop it (bc-03), or use the port Vite picked |
| `No .NET SDKs were found` | Only a runtime is installed | Install the .NET 10 **SDK** |
| Postgres 18 container exits right after start | Volume mounted at the old `/var/lib/postgresql/data` path | Mount the volume at `/var/lib/postgresql` |
| HTTPS errors calling the local API | Dev cert not trusted | `dotnet dev-certs https --clean` then `--trust` |

:::cards id=bc-02-cards1 xp=15 title="Dev environment"
Q: Why install Node through a version manager?
A: Projects pin different Node versions; fnm/nvm install several side by side and switch per project (reading `.nvmrc`).
Q: What file pins the .NET SDK version for a repo?
A: `global.json` (`sdk.version` plus a `rollForward` policy).
Q: SDK vs runtime?
A: The SDK builds (compiler, CLI, templates) and includes runtimes; a runtime only runs already-built apps.
Q: What does a named Docker volume give you?
A: Data that survives removing the container. Only `docker volume rm` / `compose down -v` deletes it.
Q: Docker Compose v2 command?
A: `docker compose` (a plugin, with a space) — not the old `docker-compose` binary.
Q: `docker compose down` vs `docker compose down -v`?
A: `down` removes containers and the network but keeps named volumes (your data); `down -v` also deletes the volumes.
Q: What is a Compose service name used for?
A: It's the name in commands (`docker compose logs db`) and the hostname other containers on the Compose network use (`Host=db`).
Q: Why add a healthcheck to the Postgres service?
A: "Running" only means the process started; the healthcheck (`pg_isready`) tells Compose when it actually accepts connections ("healthy").
Q: Where should repos live when using WSL 2?
A: Inside the Linux filesystem (e.g. `~/code`), not `/mnt/c` — much faster and file watchers work.
Q: Three editor skills to learn on day one?
A: Go to definition / find usages, rename symbol, run a single test under the debugger.
Q: How do you avoid CRLF problems across Windows and Linux?
A: Commit a `.gitattributes` (e.g. `* text=auto eol=lf`) so the repo controls line endings.
Q: How do teams share recommended VS Code extensions?
A: A committed `.vscode/extensions.json` with a `recommendations` list.
Q: In `-p 5433:5432`, which number is the port on your machine?
A: The left one (5433). The format is `HOST:CONTAINER`.
Q: Where does the volume go for the `postgres:18` image?
A: `/var/lib/postgresql` (data lives in `18/docker` below it) — not the old `/var/lib/postgresql/data`.
Q: What does `rollForward` in `global.json` default to?
A: `latestPatch` — only newer patches within the same feature band (e.g. 10.0.1xx).
:::

## Recap

- Install Node via **fnm/nvm** and respect the repo's `.nvmrc`; pin .NET with `global.json`.
- **Docker/Podman** runs your database; named volumes keep the data, and `-p` maps `HOST:CONTAINER` ports.
- A committed **`compose.yaml`** starts the whole local stack (`db`, `redis`) with one `docker compose up -d`;
  healthchecks say when it's ready, `logs` shows what happened, `down -v` resets the data.
- Configure **Git** identity, default branch, SSH keys — and mind line endings.
- **VS Code** (C# Dev Kit, ESLint, Prettier, Docker, PostgreSQL) or **Rider** — make debugging work for both stacks.
- Use a **Postgres GUI** for exploring, but treat production connections as read-only.
- Verify every tool, and turn every setup fix into a README improvement.
