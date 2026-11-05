---
id: bc-03
title: Terminal Survival Kit
level: beginner
minutes: 45
xp: 100
summary: Navigate, search, pipe, manage env vars and PATH, find who owns a port, call APIs with curl — in bash and PowerShell.
---

Every tool in this stack has a CLI: `npm`, `dotnet`, `git`, `docker`, `kubectl`, `psql`. CI
pipelines are shell scripts. Production debugging often means an SSH session or `kubectl exec` into a
container that has **no GUI at all**. You don't need to be a shell wizard — you need a reliable
survival kit, and that is what this lesson gives you.

Examples are in **bash** (macOS, Linux, WSL, Git Bash, and every Linux container) with
**PowerShell** equivalents where they differ. zsh (macOS default) behaves like bash for everything here.

## Where am I, what's here?

```bash
pwd                 # print working directory
ls                  # list
ls -la              # long format + hidden files (dotfiles like .env, .git)
cd ~/code/shop      # absolute-ish path (~ = your home)
cd ..               # up one level
cd -                # back to the previous directory
cd                  # home
```

**Relative** paths start from where you are (`src/app.ts`, `../api`), **absolute** paths start at the
root (`/home/ada/code`, `C:\code`). `.` is "this folder", `..` is "the parent".

| Task | bash | PowerShell |
|---|---|---|
| List incl. hidden | `ls -la` | `Get-ChildItem -Force` (alias `ls -Force`) |
| Current dir | `pwd` | `Get-Location` (alias `pwd`) |
| Make dir (with parents) | `mkdir -p a/b/c` | `New-Item -ItemType Directory -Force a/b/c` |
| Create empty file | `touch notes.md` | `New-Item notes.md` |
| Show a file | `cat file` / `less file` | `Get-Content file` (alias `cat`) |
| Last lines, follow | `tail -f app.log` | `Get-Content app.log -Wait -Tail 20` |
| Copy / move | `cp -r a b` / `mv a b` | `Copy-Item -Recurse a b` / `Move-Item a b` |
| Delete folder | `rm -rf dist` | `Remove-Item -Recurse -Force dist` |

:::warn title="rm -rf has no undo"
There's no recycle bin in the terminal. Before running `rm -rf something`, run `ls something`
first and read the path twice — especially if it contains a variable. The classic disaster is
`rm -rf "$BUILD_DIR"/*` in a script where `BUILD_DIR` is empty or misspelled: it expands to
`rm -rf /*` and starts deleting everything you have permission to delete. (Modern `rm` refuses a bare
`/`, but not `/*`.) Guard variables with `${BUILD_DIR:?}` — bash then aborts with an error if it's
empty or unset — and quote them so spaces in paths don't split one path into two.
:::

:::tip title="Keyboard moves that save hours"
`Tab` completes paths and commands (press twice for options). `↑` recalls history; `Ctrl+R` searches
history as you type. `Ctrl+C` stops the running program, `Ctrl+L` clears the screen, `Ctrl+A` /
`Ctrl+E` jump to start/end of line. `!!` repeats the last command (`sudo !!`).
:::

## Pipes and redirection: small tools, combined

The Unix idea: each program does one thing well, and every program gets three standard **streams**,
numbered so the shell can refer to them:

| Number | Name | Default | Used for |
|---|---|---|---|
| `0` | **stdin** | keyboard | input the program reads |
| `1` | **stdout** | terminal | normal output (the result) |
| `2` | **stderr** | terminal | errors, warnings, progress messages |

Both output streams show up in your terminal, so they look the same — but they are separate, which is
why you can save the result and still see errors. The pipe `|` connects one program's **stdout** to
the next one's **stdin** (stderr is *not* piped; it still goes to the terminal).

```bash
cat access.log | grep " 500 " | wc -l          # how many 500 errors?
docker ps | grep postgres                       # is my db container running?
npm ls --all | grep -i react                    # which react versions are installed?
history | grep "dotnet ef"                      # how did I run that migration command?
```

Redirection sends streams to files:

```bash
npm run build > build.log          # stdout to file (overwrite)
npm run build >> build.log         # append
npm run build 2> errors.log        # only stderr
npm run build > all.log 2>&1       # both into one file (order matters!)
some-command > /dev/null 2>&1      # throw everything away (PowerShell: *> $null)
```

`2>&1` reads as "send stream 2 to wherever stream 1 is going **right now**". `/dev/null` is a special
file that discards whatever is written to it.

Chaining commands:

```bash
npm ci && npm test                 # run test only if install succeeded (exit code 0)
npm test || echo "tests failed"    # run the second only if the first failed
cd api; dotnet build               # run both regardless
```

Every program returns an **exit code** when it finishes: `0` = success, anything else = failure (the
number can hint at what went wrong, e.g. `127` = command not found). `echo $?` shows the last one
(PowerShell: `$LASTEXITCODE` for native programs). CI systems fail a step when a command exits
non-zero — that's the whole mechanism behind a red build.

```bash
ls /does-not-exist
echo $?        # 2 on Linux, 1 on macOS — any non-zero means failure
ls ~
echo $?        # 0
```

One trap: a **pipeline's** exit code is the exit code of its *last* command. `tee file` copies its
input to a file *and* passes it on to the terminal — handy for keeping a log while you watch. But
`npm test | tee test.log` reports success even when the tests fail, because `tee` succeeded. In scripts,
`set -o pipefail` makes the pipeline fail if any part fails.

:::quiz id=bc-03-q1 xp=10
You want the build output **and** errors in `build.log`. Which command does that?
- [ ] `npm run build 2>&1 > build.log`
- [x] `npm run build > build.log 2>&1`
- [ ] `npm run build | build.log`
- [ ] `npm run build 2> build.log`
> Redirections are applied left to right. `> build.log` first points stdout at the file, then
> `2>&1` points stderr at "wherever stdout points now" — the file. In the first option stderr is
> pointed at the terminal *before* stdout moves. A pipe needs a program on the right, not a file
> (bash would try to *run* a program called `build.log`). `2> build.log` captures only the errors.
:::

:::quiz id=bc-03-q5 xp=10
**Spot the bug.** This CI step should go red when a test fails, but it stays green:

```bash
npm test 2>&1 | tee test-output.log
```

Why?
- [ ] `2>&1` hides the failure from CI
- [x] The pipeline's exit code is `tee`'s, and `tee` succeeds even though `npm test` failed
- [ ] `tee` deletes the exit code when it writes a file
- [ ] CI only checks stderr, and stderr was redirected
> Without `pipefail`, a pipeline reports the exit code of its **last** command. `tee` wrote the log
> fine, so it returned 0. `2>&1` only merges stderr into the pipe (so the log contains errors too) —
> it doesn't touch exit codes. Fix: `set -o pipefail` before the command. (GitHub Actions turns
> pipefail on only when a step explicitly says `shell: bash`; the implicit default shell doesn't.)
:::

## Finding things: grep and find

**grep** searches *inside* files, **find** searches for *files*.

```bash
grep -rn "ConnectionStrings" .            # recursive, with line numbers
grep -rni "todo" src/                     # -i case-insensitive
grep -rl "useEffect" src/                 # -l: only file names
grep -rn --include="*.cs" "DbContext" .   # only C# files
grep -v "DEBUG" app.log                   # -v: lines NOT matching
grep -E "error|warn" app.log              # extended regex: either word

find . -name "*.csproj"                   # all project files
find . -name node_modules -prune -o -name "*.test.ts" -print   # skip node_modules
find . -type f -size +10M                 # big files (who committed a video?)
find . -name "*.log" -mtime -1            # logs changed in the last day
```

:::pro title="Use ripgrep (rg) and fd"
`rg` (ripgrep) is grep that is recursive by default, respects `.gitignore` (so it skips
`node_modules`, `bin/`, `obj/`) and is extremely fast: `rg "DbContext" -t cs`. `fd` is the same idea
for `find`. VS Code's search uses ripgrep under the hood. And inside a repo, `git grep "text"`
searches only tracked files.
:::

PowerShell equivalents:

```text
Select-String -Path src\*.ts -Pattern "useEffect"                  # grep (alias: sls)
Get-ChildItem -Recurse -Filter *.csproj                             # find
Get-ChildItem -Recurse -Include *.cs | Select-String "DbContext"    # grep -r
```

A few more text tools you'll see in scripts: `head -n 20`, `tail -n 20`, `sort`, `uniq -c`,
`cut -d, -f2`, `wc -l`, `sed 's/old/new/g'`, `awk '{print $1}'`, and **`jq`** for JSON:

```bash
# top 5 IPs hitting the server
awk '{print $1}' access.log | sort | uniq -c | sort -rn | head -5

# pretty-print and filter JSON from an API
curl -s http://localhost:5080/api/projects | jq '.[] | {id, name}'
```

:::quiz id=bc-03-q2 xp=10
Which command lists every `.ts` file under `src/` that contains the text `fetch(`?
- [ ] `find src -name "fetch(" -type f`
- [x] `grep -rl "fetch(" src --include="*.ts"`
- [ ] `ls src | grep "fetch("`
- [ ] `cat src/*.ts | grep -l "fetch("`
> `grep -r` searches file contents recursively, `-l` prints only file names, `--include` limits to
> `.ts`. `find -name` matches file *names*, `ls | grep` searches names too, and after `cat` grep
> only sees one anonymous stream, so it can't tell you file names.
:::

## Environment variables and PATH

Environment variables are key/value settings every process inherits from its parent. Your API
reads its connection string from one, Vite reads `VITE_*` variables, CI injects secrets as them.

The key word is **inherits**: when you start a program from a shell, it gets a *copy* of the
shell's exported variables. Changes go downwards only — a child process (or a script you run) can't
change the variables of the shell that started it. That's why `./set-env.sh` doesn't affect your
terminal, while `source set-env.sh` (run it *in* the current shell) does.

```bash
echo $HOME                       # read
API_URL=http://localhost:5080    # shell variable only — programs you start do NOT see it
export API_URL=http://localhost:5080   # exported: this shell and every program it starts see it
API_URL=http://x node script.js  # set only for that one command
env | grep -i dotnet             # list (filtered)
unset API_URL                    # remove
```

```text
# PowerShell
$env:API_URL = "http://localhost:5080"
$env:API_URL
Get-ChildItem Env: | Where-Object Name -like "*DOTNET*"
Remove-Item Env:API_URL
```

ASP.NET Core maps env vars onto configuration: `ConnectionStrings__Default` (double underscore =
nesting) overrides `ConnectionStrings:Default` from `appsettings.json`, and
`ASPNETCORE_ENVIRONMENT=Development` picks `appsettings.Development.json`. You'll use this a lot in
Docker and Kubernetes.

**PATH** is the special variable listing the folders where the shell looks for programs, separated
by `:` (Windows: `;`). "Command not found" almost always means "not in PATH".

```bash
echo $PATH | tr ':' '\n'     # one folder per line
which node                   # which binary actually runs? (PowerShell: Get-Command node)
type -a node                 # all matches, in PATH order
export PATH="$HOME/.dotnet/tools:$PATH"   # prepend a folder (put it in ~/.bashrc to persist)
```

`export` only lasts for the current terminal. To persist, add the line to your shell profile:
`~/.bashrc` (bash), `~/.zshrc` (zsh), or `$PROFILE` (PowerShell) — then open a new terminal or
`source ~/.zshrc`.

:::quiz id=bc-03-q3 xp=10
Two problems on a fresh machine: `dotnet tool install --global dotnet-ef` succeeded, yet
`dotnet ef` fails with "Could not execute because the specified command or file was not found". And
`which node` shows `/usr/bin/node` (an old system Node) even though fnm is installed and set up a
newer default. What's the common cause of both?
- [ ] The programs are corrupted and must be reinstalled
- [x] PATH: a tool's folder is missing from PATH, or comes after another folder with the same command
- [ ] Environment variables only work after a reboot
- [ ] You need to run them with `sudo`
> The shell runs the **first** matching program in PATH order. Global .NET tools live in
> `~/.dotnet/tools`, which must be on PATH; fnm's Node folder must come *before* `/usr/bin`, or the
> system Node wins. Reinstalling changes nothing because the files are fine — the shell just isn't
> looking in the right place. A reboot isn't needed either: fix the profile and open a new terminal
> (or `source` it). `which` / `type -a` show what really runs.
:::

:::quiz id=bc-03-q6 xp=10
In a fresh terminal you run these two lines. What does the second one print?

```bash
API_URL=http://localhost:5080
node -e 'console.log(process.env.API_URL)'
```

- [ ] `http://localhost:5080`
- [x] `undefined`
- [ ] An error: `API_URL` is not defined
- [ ] An empty line
> Without `export`, `API_URL` is a **shell variable**: `echo $API_URL` works in that shell, but
> child processes like `node` don't inherit it, so `process.env.API_URL` is `undefined` (Node
> doesn't throw for missing env vars, and an *empty* string would need the variable to exist). Fix
> it with `export API_URL=…`, or set it just for one command: `API_URL=… node -e '…'`.
:::

## Processes and ports — who's using port 5173?

A **port** is a number (0–65535) that identifies one listening program on a machine:
`localhost:5173` means "the program on my machine listening on port 5173". Only one process can
listen on a given port at a time. Dev servers bind **ports**: Vite 5173, PostgreSQL 5432, Redis 6379. ASP.NET Core
takes its port from `Properties/launchSettings.json` (`dotnet new` picks a random one per project; with
no launch profile at all Kestrel falls back to 5000). The example API in this course is pinned to
**5080** there, which is why the examples here use `http://localhost:5080`. When something crashes without
cleaning up, the next start fails with `EADDRINUSE` / "address already in use".

```bash
# macOS / Linux: who listens on 5173?
lsof -i :5173                     # shows COMMAND and PID
ss -ltnp | grep 5173              # Linux alternative (l=listening t=tcp n=numeric p=process)

kill 48213                        # polite stop (SIGTERM) by PID
kill -9 48213                     # force (SIGKILL) — only if polite didn't work

ps aux | grep -i vite             # list processes matching a name
pkill -f "vite"                   # kill by name pattern (careful!)
```

A **PID** (process ID) is the number the OS gives every running program. `kill` sends it a
**signal**: `SIGTERM` (the default) asks it to shut down, so it can close files, finish requests and
release the port; `Ctrl+C` sends the similar `SIGINT`. `SIGKILL` (`-9`) can't be caught — the OS
just ends the process, with no cleanup (half-written files, orphaned child processes). That's why
`-9` is the last resort, not the first.

```text
# Windows PowerShell
Get-NetTCPConnection -LocalPort 5173 | Select-Object LocalPort, OwningProcess
Get-Process -Id 48213
Stop-Process -Id 48213
# classic cmd tools also work:
netstat -ano | findstr :5173
taskkill /PID 48213 /F
```

:::info title="It might be a container"
If `lsof` shows `com.docker.backend` or `docker-proxy`, the port belongs to a container's `-p`
mapping. `docker ps` shows which container publishes the port; stop that one instead of killing Docker.
:::

Foreground and background jobs (bash/zsh): `Ctrl+Z` suspends, `bg` continues in the background,
`fg` brings it back, `jobs` lists them, and `command &` starts in the background. For long-running
dev servers, separate terminal tabs (or a terminal multiplexer like `tmux`) are usually clearer.

:::quiz id=bc-03-q4 xp=10
`npm run dev` fails with `Error: Port 5173 is already in use` (the project sets `server.strictPort: true`,
so Vite won't pick another port). What is the best **first** step?
- [ ] Reboot the machine
- [ ] `kill -9` every node process
- [x] Find the PID listening on 5173 (`lsof -i :5173` / `Get-NetTCPConnection`) and see what it is
- [ ] Change the port in `vite.config.ts` permanently
> Find out first. It's usually a forgotten dev server in another tab — close it gracefully. Killing
> every node process also kills unrelated things (your editor's language servers, other projects),
> and a reboot just hides the cause. Changing the port permanently is tempting, but it changes the
> setup for the whole team (proxies, CORS settings, docs) to work around something that's running on
> *your* machine.
:::

## curl: talk to APIs from the terminal

`curl` sends HTTP requests from the terminal. It's on macOS, most Linux distros and Windows 10+
(as `curl.exe`), which makes it the universal tool for "is the API up and what does it return?" —
without a browser, Postman or the frontend in the way. (Slim and distroless container images,
including Microsoft's `aspnet` runtime images, often *don't* include it; there you curl from your
machine or a debug container instead.) This section is about the *flags*; what curl actually
sends and gets back — methods, status codes, headers — is the subject of the next lesson.

```bash
curl http://localhost:5080/health                       # GET
curl -i http://localhost:5080/api/projects              # -i: include status line + headers
curl -s http://localhost:5080/api/projects | jq .       # -s silent, pretty JSON
curl -v https://api.example.com                         # verbose: TLS, request headers, redirects

# POST JSON
curl -X POST http://localhost:5080/api/projects \
  -H "Content-Type: application/json" \
  -d '{"name":"Website relaunch"}'

# Auth header (token from an env var, not pasted into history)
curl -H "Authorization: Bearer $TOKEN" http://localhost:5080/api/me

# Other useful flags
curl -L http://example.com            # follow redirects
curl -o out.zip https://…/file.zip    # save to file
curl -w "%{http_code} %{time_total}s\n" -o /dev/null -s http://localhost:5080/health
```

:::warn title="PowerShell's curl is not always curl"
In Windows PowerShell 5.1, `curl` is an alias for `Invoke-WebRequest`, which has different flags.
Type `curl.exe` explicitly, or use the native cmdlet:
`Invoke-RestMethod http://localhost:5080/api/projects` (parses JSON into objects automatically).
Quoting JSON for `curl.exe` is also different: Windows PowerShell 5.1 (and PowerShell 7 before 7.3)
strips the inner double quotes, so escape them (`-d '{\"name\":\"x\"}'`) or skip curl and use
`Invoke-RestMethod -Method Post -ContentType "application/json" -Body (@{ name = "x" } | ConvertTo-Json)`.
PowerShell 7.3+ passes `'{"name":"x"}'` through correctly.
:::

:::job title="Copy as cURL"
In browser devtools (Network tab) you can right-click any request → **Copy as cURL**. That gives you
the exact request — headers, cookies, body — to replay in a terminal, paste into a bug ticket, or
share with a backend colleague. It's one of the fastest ways to answer "is it the frontend or the API?".
:::

## Scripts: when you type it twice, save it

```bash
#!/usr/bin/env bash
set -euo pipefail     # stop on errors, on unset variables, and on failures inside pipes

echo "Resetting local database…"
docker compose down -v
docker compose up -d db          # "db" = the Postgres service in compose.yaml (bc-02)
dotnet ef database update --project src/Api
echo "Done."
```

Save as `scripts/reset-db.sh`, `chmod +x scripts/reset-db.sh`, run `./scripts/reset-db.sh`. Many
teams put such commands in `package.json` scripts, a `Makefile`, or a `justfile` so everybody runs
the same thing (`npm run db:reset`, `make test`).

:::lab id=bc-03-lab1 xp=80
title: Terminal drills on a real project
Use the `hello-web` (Vite) and `HelloApi` (.NET) projects from bc-02 — or any repo you have.

1. In `hello-web`, find every file that imports from `react` and count them:
   `grep -rl "from 'react'" src | wc -l`. Searching only `src` skips `node_modules`. In a fresh
   Vite React template this prints `2` (`main.tsx` and `App.tsx`).
2. Start `npm run dev` in one terminal. In a second terminal find the PID that owns port 5173 and
   identify the process. Stop the dev server gracefully with `Ctrl+C`, then confirm the port is free.
3. Start `HelloApi` with `dotnet run`. Call `/weatherforecast` on the URL it printed with `curl -i`
   and note the status code and `Content-Type` header — expect `HTTP/1.1 200 OK` and
   `Content-Type: application/json; charset=utf-8`. Then pipe the body (`curl -s …`) through `jq`
   (install it with `brew`/`apt`/`winget install jqlang.jq` if needed).
4. Run the API with a different environment:
   `ASPNETCORE_ENVIRONMENT=Production ASPNETCORE_URLS=http://localhost:5080 dotnet run --no-launch-profile`
   (PowerShell: set `$env:ASPNETCORE_ENVIRONMENT` and `$env:ASPNETCORE_URLS` first).
   `--no-launch-profile` matters: otherwise `Properties/launchSettings.json` sets `Development` and
   wins over your shell variable. Without a launch profile there is also no port setting, so Kestrel
   would fall back to `http://localhost:5000` — `ASPNETCORE_URLS` keeps it on the course's 5080.
   Notice that `/openapi/v1.json` now returns 404 — the template maps OpenAPI only in Development.
5. Print your PATH one folder per line and find where `node` and `dotnet` really live.
6. In `HelloApi`, run `mkdir -p scripts`, then write `scripts/smoke.sh` that curls the API and exits non-zero if the status isn't 200:

```bash
#!/usr/bin/env bash
set -euo pipefail
code=$(curl -s -o /dev/null -w "%{http_code}" "${API_URL:-http://localhost:5080}/weatherforecast")
echo "status: $code"
[ "$code" = "200" ]
```

`-o /dev/null` throws the body away and `-w "%{http_code}"` prints only the status code. The last
line is a test: `[ … ]` exits 0 if the condition is true, 1 if not — and the script's exit code is
that of its last command. `${API_URL:-…}` means "use `$API_URL`, or this default if it's unset".
Make it executable and try it with the API from step 4 running, then stopped:

```bash
chmod +x scripts/smoke.sh
./scripts/smoke.sh && echo OK     # API running:  "status: 200" then "OK"
./scripts/smoke.sh || echo FAILED # API stopped:  curl can't connect, set -e aborts → "FAILED"
```

- [ ] I counted the files importing React with a single pipeline
- [ ] I found the PID on port 5173 and freed the port without `kill -9`
- [ ] `curl -i` showed me the status line and headers of my API
- [ ] I changed `ASPNETCORE_ENVIRONMENT` for one run and saw different behaviour
- [ ] I know which binary `node` resolves to via `which`/`Get-Command`
- [ ] `./scripts/smoke.sh && echo OK` prints OK while the API runs, and fails when it's stopped
:::

## bash ↔ PowerShell quick map

| Concept | bash | PowerShell |
|---|---|---|
| Variable | `name=ada; echo $name` | `$name = "ada"; $name` |
| Env var | `export X=1`, `$X` | `$env:X = 1`, `$env:X` |
| Last exit code | `$?` | `$LASTEXITCODE` (native), `$?` (bool) |
| Line continuation | `\` | `` ` `` (backtick) |
| Null device | `/dev/null` | `$null` |
| Which program | `which node` | `Get-Command node` |
| Find text | `grep -rn x .` | `Get-ChildItem -Recurse \| Select-String x` |
| Profile | `~/.bashrc`, `~/.zshrc` | `$PROFILE` |

The big conceptual difference: bash pipes **text**, PowerShell pipes **objects**
(`Get-Process | Where-Object CPU -gt 100 | Sort-Object CPU`). That's why PowerShell needs fewer
`awk`/`cut` tricks — and why you can't always paste a bash one-liner into it.

:::cards id=bc-03-cards1 xp=15 title="Terminal survival"
Q: stdout vs stderr?
A: Two output streams: normal output (1) and errors (2). `>` redirects stdout, `2>` stderr, `2>&1` merges stderr into stdout.
Q: `&&` vs `||`?
A: `a && b` runs b only if a succeeded (exit 0); `a || b` runs b only if a failed.
Q: What does exit code 0 mean?
A: Success. Any non-zero code is failure — CI marks the step red.
Q: grep vs find?
A: grep searches inside files (contents); find searches for files by name, type, size, age.
Q: What is PATH?
A: The list of folders the shell searches for programs, in order. "Command not found" usually means the folder isn't on PATH.
Q: How do you see which binary a command runs?
A: `which node` / `type -a node` (bash), `Get-Command node` (PowerShell).
Q: Who is listening on port 5173?
A: `lsof -i :5173` (macOS/Linux) or `ss -ltnp` (Linux); `Get-NetTCPConnection -LocalPort 5173` or `netstat -ano` (Windows).
Q: kill vs kill -9?
A: `kill` sends SIGTERM (polite, the program can clean up); `kill -9` sends SIGKILL (immediate, no cleanup). Try polite first.
Q: How does ASP.NET Core read nested config from env vars?
A: Double underscore = nesting: `ConnectionStrings__Default` maps to `ConnectionStrings:Default`.
Q: curl flags for headers, silent, follow redirects, verbose?
A: `-i` include response headers, `-s` silent, `-L` follow redirects, `-v` verbose.
Q: Why can `npm test | tee log.txt` stay green when tests fail?
A: A pipeline's exit code is the last command's (`tee`, which succeeded). `set -o pipefail` fixes it.
Q: `X=1` vs `export X=1`?
A: Without `export` it's a shell-only variable; child processes (node, dotnet) only see exported variables.
Q: What does `set -euo pipefail` do in a bash script?
A: Exit on any error (-e), on unset variables (-u), and fail a pipeline if any part fails (pipefail).
:::

## Recap

- Navigate with `pwd`, `ls -la`, `cd`, Tab completion and `Ctrl+R` history search.
- Combine small tools with **pipes** and **redirection**; exit codes drive `&&`, `||` and CI — and a pipeline reports its *last* command's code unless you `set -o pipefail`.
- **grep/rg** search contents, **find/fd** search files; `jq` handles JSON.
- Env vars configure apps (`ASPNETCORE_ENVIRONMENT`, `ConnectionStrings__Default`) and only reach child processes when **exported**; **PATH** decides which program runs.
- Find the process behind a busy port (`lsof`, `ss`, `Get-NetTCPConnection`) and stop it gracefully.
- `curl -i` / `-v` (or `Invoke-RestMethod`) is your universal API probe; save repeated commands as scripts.
