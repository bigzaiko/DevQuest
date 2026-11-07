---
id: ops-20
title: Shell, YAML & Dockerfile Syntax Primer
level: beginner
minutes: 75
xp: 100
summary: Learn to read the three syntaxes every ops lesson uses — shell commands, YAML files and Dockerfiles — with tiny examples, the classic mistakes and a hands-on terminal lab.
---

Every lesson in this region throws three kinds of text at you: **shell commands** (`docker run -d
-p 8080:80 nginx`), **YAML files** (`compose.yaml`, Kubernetes manifests) and **Dockerfiles**. None
of them is hard, but each has a few rules that nobody explains because "everybody knows them". When
you don't know them, a single space or a missing quote costs you an afternoon.

This primer teaches you to *read* all three before you start writing them in
**Containers, Explained** and the lessons after it. Each concept gets a tiny example. Skim what you
know, slow down where it's new, and use the quizzes to check yourself.

## Why syntax first?

Ops tools are unforgiving in a different way from TypeScript. A TypeScript compiler underlines your
mistake in red. A shell just runs whatever you typed, and a YAML parser often *accepts* a wrong file
and gives you a different meaning than you intended: a port number becomes a weird integer, `NO`
becomes `false`, or a key silently moves to the wrong parent. Knowing the rules is the only
protection.

## Part 1 — Reading shell commands

### Words: command, flags, arguments

A **shell** is the program that reads what you type in a terminal and runs it. On Linux and macOS
that's usually **Bash** or **Zsh**; on Windows it's **PowerShell**. The shell splits your line into
**words** at spaces. The first word is the **command** (the program to run); the rest are handed to
that program as its **arguments**.

```bash
docker run -d --name web -p 8080:80 nginx:1.29
```

| Word | What it is |
|---|---|
| `docker` | the **command** (a program found on your `PATH` — the list of folders the shell searches for programs) |
| `run` | a **subcommand** — the first argument, which tells `docker` what to do |
| `-d` | a **short flag** (one dash, one letter): "detached", run in the background |
| `--name web` | a **long flag** (two dashes) with a **value**, `web` |
| `-p 8080:80` | a short flag with a value: publish host port 8080 to container port 80 |
| `nginx:1.29` | a **positional argument** — its meaning comes from its position (the **image** to run: a packaged app, here the nginx web server, version tag `1.29`) |

A **flag** (also called an **option** or **switch**) changes how a command behaves. Some flags are
booleans (present or not, like `-d`); others take a value. Values can be written two ways:

```bash
docker run --name web nginx      # value as the next word
docker run --name=web nginx      # value glued on with =
```

Short boolean flags can usually be **combined**: `ls -l -a` and `ls -la` are the same, and
`docker run -it` means `-i -t` (interactive + allocate a terminal).

:::tip title="Where do I find the flags?"
Every tool documents itself: `docker run --help`, `kubectl get --help`, `man ls`. Reading `--help`
is not a beginner move — seniors do it all day.
:::

:::quiz id=ops-20-q1 xp=10
In `kubectl logs -f --tail=50 api-7d9f`, what is `api-7d9f`?
- [ ] A flag
- [ ] The value of `--tail`
- [x] A positional argument (the pod whose logs you want)
- [ ] The subcommand
> The subcommand is `logs`. `-f` is a boolean short flag ("follow"), `--tail=50` is a long flag
> whose value is glued on with `=`, so `50` already belongs to it. `api-7d9f` is left over and gets
> its meaning from its position: the name of the pod (a **pod** is Kubernetes' unit for one or
> more running containers — you'll meet it later in the region).
:::

### Quoting: single vs double quotes

Because the shell splits on spaces, a value *containing* a space needs quotes:

```bash
echo Hello   world      # two words: Hello  world  → prints "Hello world" (spaces collapsed)
echo "Hello   world"    # one word, spaces kept   → prints "Hello   world"
```

There are two kinds of quotes, and the difference matters:

- **Single quotes `'…'`** are fully literal. Nothing inside is special — not `$`, not `\`.
- **Double quotes `"…"`** keep spaces together but still **expand variables** (`$NAME`) and a few
  other things like `$(command)` (**command substitution**: run `command` and paste its output in,
  e.g. `echo "today is $(date +%A)"`).

```bash
NAME=Ada
echo 'Hi $NAME'     # → Hi $NAME
echo "Hi $NAME"     # → Hi Ada
```

To put a literal `$` inside double quotes, escape it with a backslash: `"costs \$5"`.

### Variables: `$VAR`

A **variable** is a named value the shell remembers. You set it with `NAME=value` — **no spaces
around `=`** (with spaces, the shell thinks `NAME` is a command). You read it with `$NAME` or
`${NAME}` (braces help when text follows: `${NAME}_backup`).

```bash
TAG=1.4.2
echo "building api:$TAG"        # → building api:1.4.2
echo "${TAG}-rc"                # → 1.4.2-rc
```

A plain variable lives only in your current shell. **Environment variables** are variables that
are also passed to programs you start. `export` turns one into an environment variable:

```bash
export ASPNETCORE_ENVIRONMENT=Development
dotnet run                     # the app can now read ASPNETCORE_ENVIRONMENT
```

A variable that was never set expands to an empty string — silently. `docker run -p $PORT:80 nginx`
with no `PORT` becomes `-p :80`, and Docker picks a random host port.

:::warn title="Quote your variables"
Unquoted `$VAR` is split at spaces after expansion: if `FILE="my notes.txt"`, then `rm $FILE`
tries to delete `my` and `notes.txt`. Write `rm "$FILE"`. Always double-quote variables unless you
have a reason not to.
:::

:::quiz id=ops-20-q2 xp=10
`TOKEN=abc123` is set. Which command prints exactly `Authorization: Bearer abc123`?
- [ ] `echo 'Authorization: Bearer $TOKEN'`
- [x] `echo "Authorization: Bearer $TOKEN"`
- [ ] `echo "Authorization: Bearer \$TOKEN"`
- [ ] `echo Authorization: Bearer TOKEN`
> Double quotes expand `$TOKEN` to `abc123`. Single quotes are literal, so the first option prints
> `$TOKEN` itself. `\$` inside double quotes escapes the dollar sign, so the third also prints
> `$TOKEN`. Without a `$`, `TOKEN` is just the word "TOKEN".
:::

### Pipes, `&&` and `\`

Three more symbols appear in almost every command you'll copy from a doc:

**The pipe `|`** sends the **output** of the left command as the **input** of the right one. Small
tools combine into big ones:

```bash
docker ps | grep postgres            # list containers, keep only lines containing "postgres"
kubectl get pods | wc -l             # count lines of output
```

**`&&`** means "run the next command **only if** the previous one succeeded". Every command ends
with an **exit code**: `0` means success, anything else means failure (`echo $?` shows the last
one). `||` is the opposite: run the next one only on failure. A plain `;` runs the next one no
matter what.

```bash
npm ci && npm run build        # don't build if install failed
cd /app && rm -rf cache        # don't delete anything if cd failed — this one matters!
grep -q ready log.txt || echo "not ready yet"
```

**A backslash `\` at the very end of a line** means "the command continues on the next line". It
exists purely for readability:

```bash
docker run -d \
  --name db \
  -e POSTGRES_PASSWORD=devpass \
  -p 5432:5432 \
  postgres:18
```

:::warn title="Nothing after the backslash"
The `\` must be the **last character** on the line. A trailing space after it ("`\ `") escapes the
space instead, the command ends there, and the next line runs as a separate (broken) command. If a
multi-line command from a doc fails strangely, look for trailing spaces.
:::

You will also see **redirection**: `>` writes output to a file (overwriting), `>>` appends, and
`<` reads a file as input. `docker logs api > api.log` saves logs to a file.

:::quiz id=ops-20-q3 xp=10
What does `docker build -t api . && docker run --rm api` do if the build **fails**?
- [ ] Runs the container anyway, with the previous image
- [x] Stops: `docker run` is skipped because `docker build` exited with a non-zero code
- [ ] Pipes the build output into the container
- [ ] Retries the build once
> `&&` only runs the right side when the left side exits with code `0`. A failed build exits
> non-zero, so `docker run` never starts — which is exactly what you want in scripts. A `;` instead
> of `&&` would run it regardless. Pipes are `|`, not `&&`.
:::

### Bash vs PowerShell

Docs usually show Bash. On Windows you can use **WSL** (a real Linux shell, recommended for
container work) or translate to **PowerShell**. The ideas are the same; the spelling differs:

| Task | Bash / Zsh | PowerShell |
|---|---|---|
| Line continuation | `\` at line end | `` ` `` (backtick) at line end |
| Set env var for this session | `export PORT=8080` | `$env:PORT = "8080"` |
| Read env var | `$PORT` | `$env:PORT` |
| Literal string | `'Hi $x'` | `'Hi $x'` (same!) |
| Expanding string | `"Hi $x"` | `"Hi $x"` (same!) |
| Run next only on success | `a && b` | `a && b` (PowerShell 7+) |
| Comment | `# …` | `# …` |

```powershell
docker run -d `
  --name db `
  -e POSTGRES_PASSWORD=devpass `
  postgres:18
```

:::job title="Day one at a new job"
The README says "run `./scripts/dev-up.sh`" and the CI file is full of Bash. Even on Windows teams,
build scripts, Dockerfiles and CI pipelines run Bash on Linux. Being able to read a 20-line shell
script and say what it does is expected of every full-stack developer, not just "the DevOps person".
:::

### Code it: parse a flag list

A program receives its arguments as a plain list of strings — the shell has already split and
unquoted them. Turning that list into named flags is called **argument parsing**, and every CLI
(`docker`, `kubectl`, `dotnet`) does it. Write a tiny version.

:::challenge id=ops-20-c1 lang=ts xp=40
title: A tiny argument parser
Write `parseArgs(args)` that turns an argument list into `{ flags, positional }`:

- `--name=value` → `flags.name = 'value'` (split at the **first** `=` only)
- `--name` with no `=` → `flags.name = true` (a boolean flag)
- `-abc` (one dash, letters) → `flags.a = true`, `flags.b = true`, `flags.c = true`
- `--` on its own → stop parsing; every later item is positional, even if it starts with `-`
- anything else → push onto `positional`, in order

Example: `parseArgs(['run', '-it', '--name=web', 'nginx'])` returns
`{ flags: { i: true, t: true, name: 'web' }, positional: ['run', 'nginx'] }`.

hint: Loop with a `for` over the array and a `boolean` that becomes `true` after you see `--`.
hint: `arg.startsWith('--')`, then `arg.slice(2)` and `indexOf('=')`. For short flags, loop over `arg.slice(1)`.
hint: `'a=b=c'.indexOf('=')` gives the first `=`; take `slice(0, i)` and `slice(i + 1)`.

```ts starter
type Parsed = { flags: Record<string, string | boolean>; positional: string[] }

export function parseArgs(args: string[]): Parsed {
  return { flags: {}, positional: args }
}
```

```ts solution
type Parsed = { flags: Record<string, string | boolean>; positional: string[] }

export function parseArgs(args: string[]): Parsed {
  const flags: Record<string, string | boolean> = {}
  const positional: string[] = []
  let done = false
  for (const arg of args) {
    if (done) {
      positional.push(arg)
    } else if (arg === '--') {
      done = true
    } else if (arg.startsWith('--')) {
      const body = arg.slice(2)
      const i = body.indexOf('=')
      if (i === -1) flags[body] = true
      else flags[body.slice(0, i)] = body.slice(i + 1)
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (const ch of arg.slice(1)) flags[ch] = true
    } else {
      positional.push(arg)
    }
  }
  return { flags, positional }
}
```

```ts tests
test('positional only', () => {
  expect(parseArgs(['ps'])).toEqual({ flags: {}, positional: ['ps'] })
})
test('long flag with value', () => {
  expect(parseArgs(['--name=web']).flags).toEqual({ name: 'web' })
})
test('value split at the first = only', () => {
  expect(parseArgs(['--env=A=B']).flags).toEqual({ env: 'A=B' })
})
test('long boolean flag', () => {
  expect(parseArgs(['--rm']).flags).toEqual({ rm: true })
})
test('combined short flags', () => {
  expect(parseArgs(['-it']).flags).toEqual({ i: true, t: true })
})
test('the docker run example', () => {
  expect(parseArgs(['run', '-it', '--name=web', 'nginx'])).toEqual({
    flags: { i: true, t: true, name: 'web' },
    positional: ['run', 'nginx'],
  })
})
test('-- ends flag parsing', () => {
  expect(parseArgs(['exec', '--', 'ls', '-la'])).toEqual({ flags: {}, positional: ['exec', 'ls', '-la'] })
})
```
:::

### Code it: how the shell splits words

Before a program ever sees its arguments, the shell does the splitting and quote removal you
learned above. Implementing a simplified version is the fastest way to *really* get quoting.

:::challenge id=ops-20-c2 lang=ts xp=50
title: Split a command line like a shell
Write `splitWords(line, vars)` that returns the list of words a (simplified) shell would produce:

- Spaces outside quotes separate words; several spaces in a row count as one separator.
- `'…'` single quotes: everything inside is literal, including `$`.
- `"…"` double quotes: spaces are kept, and `$NAME` is replaced by `vars[NAME]` (or `''` if missing).
- Unquoted `$NAME` is replaced too (in this simplified version the value is **not** split again).
- A variable name is letters, digits and `_` (`/[A-Za-z0-9_]/`). A `$` not followed by one is kept as `$`.
- Quotes can touch other text: `a"b c"d` is the single word `ab cd`. An empty `''` still makes a word.

Example: `splitWords(`echo "Hi $USER" 'and $USER'`, { USER: 'ada' })` → `['echo', 'Hi ada', 'and $USER']`.

hint: Walk the string one character at a time with a `mode` variable: `'none' | 'single' | 'double'`.
hint: Keep a `current` string and a boolean `inWord`. On an unquoted space, push `current` if `inWord`, then reset.
hint: Opening a quote sets `inWord = true` — that's how `''` becomes an empty word.

```ts starter
export function splitWords(line: string, vars: Record<string, string>): string[] {
  return line.split(' ')
}
```

```ts solution
export function splitWords(line: string, vars: Record<string, string>): string[] {
  const words: string[] = []
  let current = ''
  let inWord = false
  let mode: 'none' | 'single' | 'double' = 'none'
  let i = 0
  const readVar = (): string => {
    let j = i + 1
    while (j < line.length && /[A-Za-z0-9_]/.test(line[j])) j++
    if (j === i + 1) {
      i++
      return '$'
    }
    const name = line.slice(i + 1, j)
    i = j
    return vars[name] ?? ''
  }
  while (i < line.length) {
    const ch = line[i]
    if (mode === 'single') {
      if (ch === "'") mode = 'none'
      else current += ch
      i++
    } else if (mode === 'double') {
      if (ch === '"') {
        mode = 'none'
        i++
      } else if (ch === '$') current += readVar()
      else {
        current += ch
        i++
      }
    } else if (ch === ' ') {
      if (inWord) words.push(current)
      current = ''
      inWord = false
      i++
    } else if (ch === "'" || ch === '"') {
      mode = ch === "'" ? 'single' : 'double'
      inWord = true
      i++
    } else if (ch === '$') {
      current += readVar()
      inWord = true
    } else {
      current += ch
      inWord = true
      i++
    }
  }
  if (inWord) words.push(current)
  return words
}
```

```ts tests
test('plain words, extra spaces collapse', () => {
  expect(splitWords('docker   ps  -a', {})).toEqual(['docker', 'ps', '-a'])
})
test('double quotes keep spaces', () => {
  expect(splitWords('echo "Hello   world"', {})).toEqual(['echo', 'Hello   world'])
})
test('single quotes are literal', () => {
  expect(splitWords("echo 'Hi $USER'", { USER: 'ada' })).toEqual(['echo', 'Hi $USER'])
})
test('double quotes expand variables', () => {
  expect(splitWords('echo "Hi $USER"', { USER: 'ada' })).toEqual(['echo', 'Hi ada'])
})
test('the lesson example', () => {
  expect(splitWords(`echo "Hi $USER" 'and $USER'`, { USER: 'ada' })).toEqual(['echo', 'Hi ada', 'and $USER'])
})
test('unquoted variable and missing variable', () => {
  expect(splitWords('run -p $PORT:80 x$NOPE', { PORT: '8080' })).toEqual(['run', '-p', '8080:80', 'x'])
})
test('quotes glued to text form one word', () => {
  expect(splitWords('a"b c"d', {})).toEqual(['ab cd'])
})
test('empty quotes still make a word', () => {
  expect(splitWords("set ''", {})).toEqual(['set', ''])
})
test('a lone $ stays', () => {
  expect(splitWords('echo "costs $ 5"', {})).toEqual(['echo', 'costs $ 5'])
})
```
:::

## Part 2 — YAML

### Why YAML exists

**YAML** ("YAML Ain't Markup Language") is a format for writing **structured data** — the same
kind of data as JSON: objects, lists, strings, numbers, booleans — but designed to be easy for
humans to read and write, and to allow comments. That's why configuration files use it: Docker
Compose, Kubernetes, GitHub Actions, Helm, Ansible, OpenAPI specs.

The price of "easy to read" is that **whitespace carries meaning**. In JSON, braces and brackets
show the structure; in YAML, **indentation** does.

### Key: value

The basic unit is a **mapping** (a.k.a. map, dictionary, object): `key: value` pairs, one per line.
The space after the colon is **required**.

```yaml
name: api          # a string
replicas: 3        # a number
debug: false       # a boolean
owner: null        # nothing (also written ~ or left empty)
```

`replicas:3` (no space) is *not* a key — it's the string `"replicas:3"`.

### Indentation: spaces, never tabs

To **nest** a mapping inside another, indent it under its key. The children of one parent must all
be indented by **the same amount**. Two spaces is the universal convention.

```yaml
database:
  host: db
  port: 5432
  credentials:
    user: app
    password: devpass
```

As JSON this is `{"database": {"host": "db", "port": 5432, "credentials": {"user": "app", "password": "devpass"}}}`.

**Tabs are forbidden** for indentation in YAML. Most parsers fail with an error such as "found
character that cannot start any token". Configure your editor to insert spaces in `.yaml` files
(VS Code does by default) and to show whitespace when debugging.

:::quiz id=ops-20-q4 xp=10
Is this YAML valid, and if so, what is `port` a child of?

```yaml
server:
  host: localhost
   port: 8080
```
- [ ] Valid — `port` is a child of `server`
- [ ] Valid — `port` is a child of `host`
- [x] Invalid — `port` is indented 3 spaces while its sibling `host` uses 2
- [ ] Valid — YAML ignores indentation
> Siblings must line up exactly. `host` sits at 2 spaces; `port` at 3 is neither a sibling of
> `host` nor a valid child (a value `localhost` was already given to `host`, so it can't also hold
> a mapping). Parsers report something like "mapping values are not allowed here". Fix: indent
> `port` with exactly 2 spaces.
:::

### Lists with `-`

A **sequence** (list, array) is written with a dash and a space per item, all at the same
indentation:

```yaml
ports:
  - "8080:80"
  - "8443:443"
```

List items can be mappings. The dash starts a new item; the keys of that item line up after the
dash:

```yaml
containers:
  - name: api
    image: ghcr.io/acme/api:1.4.2
  - name: worker
    image: ghcr.io/acme/worker:1.4.2
```

As JSON: `{"containers": [{"name": "api", "image": "…"}, {"name": "worker", "image": "…"}]}`.
Notice that `image` is indented to line up with `name`, **not** with the dash. That one detail
causes a huge share of Kubernetes YAML errors.

There is also a compact **flow style** borrowed from JSON: `ports: ["8080:80", "8443:443"]` and
`labels: {app: api, tier: backend}`. It's legal anywhere, and you'll see it for short lists such as
`command: ["dotnet", "Api.dll"]`.

:::quiz id=ops-20-q5 xp=10
What does this YAML produce?

```yaml
env:
  - name: LOG_LEVEL
  value: debug
```
- [ ] `env` is a list with one item `{name: LOG_LEVEL, value: debug}`
- [x] An error: `value` is at the same level as the `-`, so it doesn't belong to the list item
- [ ] `env` is a list of two items
- [ ] `value: debug` is treated as a comment
> Keys of a list item must line up with the first key *after* the dash (`name`, at 4 spaces). Here
> `value` sits at 2 spaces — the column of the dash — so the parser sees a mapping key where it
> expected another `- ` list item and fails (Compose and kubectl say "did not find expected '-'
> indicator"; Python's PyYAML says "expected <block end>, but found '?'"). Correct:
> indent `value` by 4 spaces so it lines up with `name`.
:::

### Strings and quoting

Most strings need no quotes: `image: nginx:1.29` is fine. But YAML tries to **guess types** for
unquoted values, and sometimes guesses wrong. Quote a value when it:

- looks like a number but must be text: `version: "1.10"` (unquoted becomes the number `1.1`!),
  `zip: "01234"`
- looks like a boolean: `yes`, `no`, `on`, `off`, `true`, `false` — the famous **Norway problem**
  is a country list where `NO` became `false` in older YAML 1.1 parsers
- contains `: ` or ` #`, or starts with a special character: `*`, `&`, `!`, `{`, `[`, `@`, `%`, `` ` ``
- is a port mapping: `"8080:80"` (YAML 1.1 parsers can read some `xx:yy` values as base-60 numbers)

Single and double quotes both work. Inside **double** quotes, backslash escapes work
(`"line1\nline2"`); inside **single** quotes everything is literal and `''` is a single quote
(`'it''s'`). That mirrors the shell more than you'd expect.

:::warn title="Kubernetes env values must be strings"
`value: 8080` or `value: true` in a container's `env` list is rejected by Kubernetes with an error
like "cannot unmarshal number into … of type string". Write `value: "8080"` and `value: "true"`.
:::

:::quiz id=ops-20-q6 xp=10
Which values does a typical YAML parser **not** load as a plain string? Select all that apply.
- [x] `version: 1.10`
- [x] `enabled: true`
- [ ] `image: postgres:18`
- [x] `retries: 3`
- [ ] `greeting: "3"`
> `1.10` becomes the float `1.1`, `true` a boolean and `3` an integer. `postgres:18` stays a string
> because there's no space after the colon, and `"3"` is quoted, so it's the string `"3"`. When in
> doubt, quote it — quotes never hurt a string.
:::

### Multi-line strings: `|` and `>`

Config files often contain scripts, certificates or SQL. YAML has two **block scalar** styles for
multi-line text. The text is indented under the key:

```yaml
script: |
  echo "migrating"
  dotnet ef database update
description: >
  This text is folded
  into one line.
```

- **`|` (literal)** keeps every newline: `script` is `echo "migrating"\ndotnet ef database update\n`.
- **`>` (folded)** joins lines with spaces (a blank line becomes a newline):
  `description` is `This text is folded into one line.\n`.
- Add `-` to drop the final newline: `|-` or `>-`.

Use `|` for scripts and certificates (newlines matter), `>` for long prose.

### Comments and multiple documents

`#` starts a **comment** that runs to the end of the line — but only at the start of a line or
after a space. `color: #ff0000` is a comment, so `color` is empty! Write `color: "#ff0000"`.

A single file can contain several **documents** separated by a line with exactly `---`. Kubernetes
uses this constantly: one file with a Deployment *and* a Service.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: api
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
```

### Anchors (you'll meet them in Compose)

`&name` marks a value as an **anchor** and `*name` reuses it (an **alias**). `<<: *name` merges a
mapping in. Compose files use this to share settings; Compose ignores top-level keys that start
with `x-` (**extension fields**), so they are a safe place to park the shared block:

```yaml
x-common-env: &common-env
  TZ: UTC
  LOG_LEVEL: info

services:
  api:
    environment:
      <<: *common-env
      PORT: "8080"
```

After loading, `services.api.environment` is `{TZ: UTC, LOG_LEVEL: info, PORT: "8080"}`.

### Common YAML errors at a glance

| You wrote | What happens | Fix |
|---|---|---|
| a tab in the indentation | parse error ("found character '\t' that cannot start any token") | spaces only |
| a sibling key 1 space off | parse error ("mapping values are not allowed here") | line siblings up exactly |
| a list item's 2nd key under the dash | parse error ("did not find expected '-' indicator") | line it up with the 1st key after `- ` |
| `key:value` (no space) | no error — it's the *string* `"key:value"` | `key: value` |
| `color: #ff0000` | no error — `color` is empty (`null`) | `color: "#ff0000"` |
| `version: 1.10` | no error — the number `1.1` | `version: "1.10"` |
| a child indented too little | no error — the key silently belongs to the parent level | indent under its parent |

The last four are the dangerous ones: the file is *valid*, it just means something else.

:::warn title="Error messages differ between tools"
The exact wording above comes from go-yaml (used by Docker Compose and kubectl) and PyYAML; other
parsers phrase it differently and report slightly different line/column numbers. The rules are in
the [YAML 1.2 spec](https://yaml.org/spec/1.2.2/); when in doubt, check what a tool parsed with
`docker compose config` or `python3 -c 'import sys,yaml; print(yaml.safe_load(sys.stdin))' < file.yaml`.
:::

### JSON vs YAML

YAML 1.2 is (almost exactly) a **superset of JSON**: any JSON document is also valid YAML. So
tools that read YAML also accept JSON — `kubectl apply -f deployment.json` works.

| | JSON | YAML |
|---|---|---|
| Structure shown by | `{}` and `[]` | indentation |
| Comments | not allowed | `# …` |
| Strings | always `"double quoted"` | quotes usually optional |
| Trailing commas | error | n/a |
| Multi-line text | `\n` escapes | block scalars (literal and folded) |
| Typical use | APIs, `package.json`, `appsettings.json` | config: Compose, Kubernetes, CI |

The same data both ways:

```json
{ "name": "api", "replicas": 2, "ports": [8080, 8443], "labels": { "tier": "backend" } }
```

```yaml
name: api
replicas: 2
ports:
  - 8080
  - 8443
labels:
  tier: backend
```

:::quiz id=ops-20-q7 xp=10
Which statements about YAML are true? Select all that apply.
- [x] Any valid JSON document is also valid YAML 1.2
- [x] `---` on its own line separates documents in one file
- [ ] Tabs and spaces may be mixed as long as they look aligned
- [ ] `#` always starts a comment, even directly after a letter like `a#b`
- [x] With `|`, the newlines inside the block are kept
> JSON is (practically) a subset of YAML 1.2, and `---` starts a new document. Tabs are never
> allowed for indentation. `#` only starts a comment at the start of a line or after whitespace, so
> `a#b` is just the string `a#b` — but `a #b` is `a` plus a comment. `|` keeps newlines; `>` folds
> them into spaces.
:::

### Code it: a tiny YAML indentation checker

Linters such as **yamllint** catch these mistakes before a deploy does. Write the core of one.
Strictly speaking, YAML allows any *consistent* number of spaces, so odd indentation is not always
an error — but with the two-space convention every level is even, so an odd count is almost always
a typo. That makes it a good lint rule.

:::challenge id=ops-20-c3 lang=ts xp=40
title: Find bad YAML indentation
Write `checkIndent(yaml)` that returns a list of problems, one object `{ line, problem }` per bad
line, in line order. Lines are numbered from **1**. Look only at each line's **leading whitespace**
(the characters before the first non-space, non-tab character):

- leading whitespace contains a tab → `problem: 'tab'`
- otherwise, the number of leading spaces is odd (1, 3, 5 …) → `problem: 'odd'`
- skip lines that are empty or contain only whitespace

A valid file returns `[]`.

hint: `yaml.split('\n')` and loop with the index; the line number is `index + 1`.
hint: `line.match(/^[ \t]*/)![0]` gives the leading whitespace. Check `.includes('\t')` first.
hint: `line.trim() === ''` detects blank lines.

```ts starter
type Problem = { line: number; problem: 'tab' | 'odd' }

export function checkIndent(yaml: string): Problem[] {
  return []
}
```

```ts solution
type Problem = { line: number; problem: 'tab' | 'odd' }

export function checkIndent(yaml: string): Problem[] {
  const problems: Problem[] = []
  yaml.split('\n').forEach((text, index) => {
    if (text.trim() === '') return
    const lead = text.match(/^[ \t]*/)![0]
    if (lead.includes('\t')) problems.push({ line: index + 1, problem: 'tab' })
    else if (lead.length % 2 === 1) problems.push({ line: index + 1, problem: 'odd' })
  })
  return problems
}
```

```ts tests
test('valid file has no problems', () => {
  expect(checkIndent('server:\n  host: db\n  port: 5432\n')).toEqual([])
})
test('finds a tab', () => {
  expect(checkIndent('server:\n\thost: db')).toEqual([{ line: 2, problem: 'tab' }])
})
test('finds odd indentation', () => {
  expect(checkIndent('server:\n  host: db\n   port: 5432')).toEqual([{ line: 3, problem: 'odd' }])
})
test('tab wins over odd count', () => {
  expect(checkIndent('a:\n \tb: 1')).toEqual([{ line: 2, problem: 'tab' }])
})
test('blank and whitespace-only lines are skipped', () => {
  expect(checkIndent('a: 1\n\n   \n\t\nb: 2')).toEqual([])
})
test('reports several problems in order', () => {
  expect(checkIndent('x:\n \ty: 1\n z: 2\n  ok: 3')).toEqual([
    { line: 2, problem: 'tab' },
    { line: 3, problem: 'odd' },
  ])
})
test('tabs after the content are fine', () => {
  expect(checkIndent('a:\n  b: 1\t# comment')).toEqual([])
})
```
:::

## Part 3 — Dockerfiles at a glance

A **Dockerfile** is a recipe for building an image, read top to bottom. Every line is an
**instruction** followed by its **arguments**:

```text
INSTRUCTION arguments
```

Instructions are written in UPPERCASE by convention (they're case-insensitive, but everyone
uppercases them so they stand out from the arguments). `#` at the start of a line is a comment.

```dockerfile
# syntax=docker/dockerfile:1
ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci \
 && npm cache clean --force
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
```

Reading it line by line:

| Instruction | Meaning |
|---|---|
| `# syntax=…` | a special first-line comment (a **parser directive**) choosing the Dockerfile syntax version |
| `ARG NODE_VERSION=24` | a **build-time variable** with a default; override with `docker build --build-arg NODE_VERSION=22 .` |
| `FROM node:${NODE_VERSION}-alpine` | start from this base image — `${…}` substitution works like the shell |
| `WORKDIR /app` | `cd` into `/app` for all following instructions (created if missing) |
| `COPY src dest` | copy files from your folder into the image; last argument is the destination |
| `RUN …` | run a shell command at **build** time; `\` and `&&` work exactly as in Bash |
| `ENV PORT=3000` | an environment variable that is also present when the container **runs** |
| `EXPOSE 3000` | documentation: "this app listens on 3000" (it publishes nothing) |
| `CMD [...]` | the default command when a container starts |

Two argument styles appear:

- **Shell form** — `RUN npm ci`: the text is run by `/bin/sh -c`, so pipes, `&&` and `$VAR` work.
- **Exec form** — `CMD ["node", "server.js"]`: a **JSON array** of words, run directly with no
  shell. It must use **double quotes** (it's JSON); `CMD ['node', 'server.js']` is not valid JSON,
  so Docker treats it as shell form and the container fails to start.

**Writing Dockerfiles** explains why exec form is preferred for `CMD`/`ENTRYPOINT` and how `ARG`
differs from `ENV`. For now, being able to read the file is enough.

:::quiz id=ops-20-q8 xp=10
In this Dockerfile, which line is a problem?

```dockerfile
FROM node:24-alpine
WORKDIR /app
COPY . .
CMD ['node', 'server.js']
```
- [ ] `FROM node:24-alpine` — tags can't contain a dash
- [ ] `WORKDIR /app` — the folder must already exist
- [ ] `COPY . .` — source and destination can't both be `.`
- [x] `CMD ['node', 'server.js']` — exec form is JSON and needs double quotes
> Exec form is parsed as a JSON array, and JSON strings require double quotes. With single quotes it
> isn't valid JSON, so Docker silently falls back to shell form and runs
> `/bin/sh -c "['node', 'server.js']"`, which fails. `COPY . .` (everything into the current
> `WORKDIR`) is completely normal, and `WORKDIR` creates missing folders.
:::

## Part 4 — Reading a `compose.yaml` and a Kubernetes manifest

Now combine everything. A **`compose.yaml`** describes several containers that run together
(covered in depth in **Docker Compose for the Full Stack**):

```yaml
services:                          # map: service name → settings
  db:
    image: postgres:18             # string, no quotes needed
    environment:                   # map of env vars
      POSTGRES_PASSWORD: devpass
    ports:
      - "5432:5432"                # list of strings — quoted on purpose
  api:
    build: ./api                   # build an image from ./api/Dockerfile
    depends_on:
      - db                         # list item: start db first
    environment:
      ConnectionStrings__Db: "Host=db;Username=postgres;Password=devpass"
```

Read it as nested data: `services` → `db` → `ports` → a list with one string. The keys
(`services`, `image`, `ports` …) are defined by the Compose specification; the names `db` and `api`
are yours.

A **Kubernetes manifest** always has the same four top-level keys (you'll meet them properly in
**Kubernetes — The Mental Model**):

```yaml
apiVersion: apps/v1          # which API group/version defines this kind
kind: Deployment             # what type of object
metadata:                    # identity: name, namespace, labels
  name: api
  labels:
    app: api
spec:                        # desired state — different for every kind
  replicas: 2
  selector:
    matchLabels:
      app: api
  template:
    metadata:
      labels:
        app: api
    spec:
      containers:
        - name: api
          image: ghcr.io/acme/api:1.4.2
          ports:
            - containerPort: 8080
          env:
            - name: ASPNETCORE_ENVIRONMENT
              value: "Production"
```

Follow the indentation like a file tree: `spec.template.spec.containers[0].image` is the image.
That dotted "path" notation is how docs and error messages refer to fields, for example
`kubectl explain deployment.spec.template.spec.containers`.

:::pro title="How seniors handle YAML"
They never eyeball big YAML. They let tools check it: the editor's YAML extension with the
Kubernetes/Compose schema (red squiggles for unknown keys), `docker compose config` to print the
fully resolved Compose file, `kubectl apply --dry-run=server -f …` to have the API server validate a
manifest without changing anything, and `yamllint` in CI. When something behaves oddly, they print
what the tool *actually* parsed instead of what they think they wrote.
:::

:::tip title="Editor setup in two minutes"
In VS Code, install the **YAML** extension (Red Hat). It validates Compose files, Kubernetes
manifests and GitHub Actions workflows against their schemas and autocompletes keys. Turn on
**Render Whitespace** when hunting indentation bugs.
:::

## Lab: shell and YAML in your own terminal

:::lab id=ops-20-lab1 xp=40
title: Quote, pipe, and catch a broken YAML file
You need a Bash or Zsh terminal (Linux, macOS, or WSL on Windows). Docker is **optional** — only
the last step uses it.

**1. Make a scratch folder.**

```bash
mkdir -p ~/syntax-lab && cd ~/syntax-lab
```

**2. Variables and quotes.** Run each line and compare with the expected output:

```bash
NAME="Dev Quest"
echo 'single: $NAME'
echo "double: $NAME"
echo "braces: ${NAME}!"
```

Expected:

```text
single: $NAME
double: Dev Quest
braces: Dev Quest!
```

**3. Exit codes and `&&`.**

```bash
true && echo "ran after success"
false && echo "you will not see this"
false || echo "ran after failure"
ls /does-not-exist; echo "exit code: $?"
```

Expected (the `ls` error text differs slightly between systems; the exit code is non-zero, usually `2` on Linux or `1` on macOS):

```text
ran after success
ran after failure
ls: cannot access '/does-not-exist': No such file or directory
exit code: 2
```

**4. Pipes and line continuation.** Create a file and filter it:

```bash
printf 'api running\ndb running\nworker stopped\n' > status.txt
cat status.txt \
  | grep running \
  | wc -l
```

Expected (macOS may pad with spaces):

```text
2
```

**5. A broken YAML file.** Create `compose.yaml` with this exact content (the `ports` line under
`web` has **3** spaces):

```yaml
services:
  web:
    image: nginx:1.29
     ports:
      - "8080:80"
```

Check the indentation by printing every line with its leading-space count:

```bash
awk '{ match($0, /^ */); print RLENGTH, $0 }' compose.yaml
```

Expected:

```text
0 services:
2   web:
4     image: nginx:1.29
5      ports:
6       - "8080:80"
```

The `5` is the odd one out — `ports` must line up with `image` at 4. Fix the file so the `ports`
line has exactly 4 spaces and run the `awk` command again: the counts must now be `0 2 4 4 6`.

**6. (Optional, needs Docker)** Let Compose parse the file for you:

```bash
docker compose config
```

With the broken file you get a YAML parse error; with the fixed one Compose prints the resolved
configuration, including `published: "8080"` and `target: 80` under `ports`.

**7. Clean up.**

```bash
cd ~ && rm -r ~/syntax-lab
```

- [ ] Step 2 printed `$NAME` literally only in the single-quoted line
- [ ] Step 3 skipped the `&&` line after `false` and showed a non-zero exit code
- [ ] Step 4 printed `2`
- [ ] I found the odd indentation in step 5 and the fixed file shows `0 2 4 4 6`
- [ ] I removed `~/syntax-lab`
:::

:::cards id=ops-20-cards1 xp=15 title="Shell, YAML & Dockerfile syntax"
Q: Single vs double quotes in Bash?
A: Single quotes are fully literal. Double quotes keep spaces together but expand `$VAR` and `$(…)`.
Q: What does `a && b` do?
A: Runs `b` only if `a` succeeded (exit code 0). `||` runs it only on failure; `;` always.
Q: What does a `\` at the end of a line mean in Bash? In PowerShell?
A: The command continues on the next line. PowerShell uses a backtick `` ` `` instead.
Q: What does the pipe `|` do?
A: Sends the output of the left command as the input of the right command.
Q: How do you set a variable in Bash, and the classic mistake?
A: `NAME=value` with no spaces around `=`. Use `export` to pass it to programs you start.
Q: Can YAML be indented with tabs?
A: No. Spaces only, consistently (two by convention); siblings must line up exactly.
Q: In a list of mappings, where do the second and later keys of an item go?
A: Lined up with the first key after the dash, not with the dash.
Q: Why quote `"8080:80"`, `"1.10"` or `"yes"` in YAML?
A: Unquoted, YAML may read them as a number or boolean instead of a string.
Q: YAML `|` vs `>`?
A: `|` keeps newlines (scripts, certificates); `>` folds lines into spaces (prose). `-` drops the last newline.
Q: What separates documents in one YAML file?
A: A line with exactly `---`.
Q: The four top-level keys of a Kubernetes manifest?
A: `apiVersion`, `kind`, `metadata`, `spec`.
Q: Dockerfile exec form vs shell form?
A: Exec form is a JSON array (double quotes!) run without a shell; shell form is a string run by `/bin/sh -c`.
:::

## Recap

- A shell splits a line into words: the **command**, then **flags** (`-d`, `--name=web`) and
  **positional arguments**. `--help` documents them.
- **Single quotes** are literal, **double quotes** expand `$VAR`; set variables with `NAME=value`
  (no spaces) and always quote `"$VAR"` when you use it.
- `|` pipes output into the next command, `&&` continues only on success, a trailing `\` continues
  the line (backtick in PowerShell).
- YAML is JSON-shaped data written with **indentation**: `key: value` (space after the colon),
  spaces never tabs, `- ` for list items, `#` comments, `---` between documents.
- Quote YAML values that look like numbers, booleans or `xx:yy`; Kubernetes `env` values must be
  strings. `|` keeps newlines, `>` folds them.
- Dockerfiles are `INSTRUCTION arguments` lines; exec form is a JSON array with double quotes.
- Compose files start at `services:`; Kubernetes manifests have `apiVersion`, `kind`, `metadata`,
  `spec`. Let tools (`docker compose config`, `kubectl apply --dry-run=server`, `yamllint`) check them.
