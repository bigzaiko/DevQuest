---
id: ops-01
title: Containers, Explained
level: beginner
minutes: 40
xp: 100
summary: What problem containers solve, how they differ from VMs, and what an image really is — layers, namespaces, cgroups, registries and OCI.
---

"It works on my machine" is the oldest joke in software. Your API runs on .NET 10.0.1 with a
specific ICU library, your colleague has 10.0.0, the CI server has a different OpenSSL, and
production runs on an Ubuntu version nobody remembers choosing. Each difference is a chance for
a bug that only shows up *somewhere else*.

Containers fix this by shipping **the application together with its whole userland** — the
runtime, the libraries, the config files, even the `/etc/os-release` — as one immutable,
versioned artifact. If it starts on your laptop, the same bytes start on CI and in production.

Two words to pin down first, because the whole lesson builds on them:

- The **kernel** is the core of the operating system: it schedules processes, manages memory, talks
  to the hardware and owns the network stack. Programs ask it for things through **system calls**
  ("syscalls"), such as "open this file" or "listen on port 8080".
- The **userland** is everything *else* on the disk: `/bin/sh`, `libc`, OpenSSL, ICU, the .NET
  runtime, your app, config files. Ubuntu, Debian and Alpine are mostly *different userlands* on top
  of the same kind of Linux kernel.

A container image packages a userland. The kernel always comes from the machine it runs on.

## The problem, concretely

Before containers, teams had roughly three options:

| Approach | What you ship | Pain |
|---|---|---|
| "Install it on the server" | Source or a zip + a wiki page of setup steps | Snowflake servers, drift, "who installed that?" |
| Configuration management (Ansible, Chef) | Scripts that *converge* a server to a state | Slow, still depends on what the OS already has |
| Virtual machines (VM images) | A whole OS disk image | Gigabytes, minutes to boot, one kernel per app |

Containers take the good part of VM images (ship everything, immutable) and drop the expensive
part (a whole operating system kernel per app).

## Containers vs virtual machines

```text
        Virtual machines                         Containers
┌────────┐ ┌────────┐ ┌────────┐      ┌────────┐ ┌────────┐ ┌────────┐
│  App A │ │  App B │ │  App C │      │  App A │ │  App B │ │  App C │
│  libs  │ │  libs  │ │  libs  │      │  libs  │ │  libs  │ │  libs  │
│ Guest  │ │ Guest  │ │ Guest  │      └────────┘ └────────┘ └────────┘
│ kernel │ │ kernel │ │ kernel │      ┌──────────────────────────────┐
└────────┘ └────────┘ └────────┘      │ Container runtime (runc)     │
┌──────────────────────────────┐      ├──────────────────────────────┤
│ Hypervisor (KVM, Hyper-V)    │      │ ONE shared host Linux kernel │
├──────────────────────────────┤      ├──────────────────────────────┤
│ Hardware                     │      │ Hardware (or a VM!)          │
└──────────────────────────────┘      └──────────────────────────────┘
```

The single most important sentence in this lesson:

> **A container is just a normal Linux process** that the kernel has been told to *lie to*: it
> gets its own view of the filesystem, process list, network and hostname, and a budget of CPU and
> memory.

There is no "container" object inside the Linux kernel. There are processes, and there are kernel
features that isolate and limit them. Docker is a friendly tool that sets those features up for you.

| | VM | Container |
|---|---|---|
| Isolation boundary | Hardware virtualization (strong) | Kernel features (good, but shared kernel) |
| Start time | Seconds to minutes (boot an OS) | Milliseconds (it's just starting a process) |
| Size | GBs (full OS) | MBs (just userland files you need) |
| Kernel | Its own | The host's |
| Run Windows app on Linux host? | Yes | No — a Linux container needs a Linux kernel |

:::info title="So how does Docker run on my Mac / Windows laptop?"
It cheats — honestly. **Docker Desktop** starts a small Linux **VM** (Apple Virtualization
framework on macOS, WSL 2 on Windows) and runs the containers inside it. That's why file sharing
between your Mac and a container is slower than on Linux, and why `localhost` networking has a few
special tricks. With **Docker Engine** on a Linux laptop or server, containers run directly on your
kernel. (Docker Desktop for Linux also uses a VM, for a consistent experience across platforms.)
:::

## Images vs containers

These two words get mixed up constantly. Get this right and everything else is easier.

- An **image** is a *read-only template*: a stack of filesystem layers plus metadata
  ("run `dotnet Api.dll`, expose 8080, use these env vars"). Think **class**, or a `.iso`.
- A **container** is a *running (or stopped) instance* of an image, with its own thin writable
  layer on top. Think **object**, or a booted machine.

One image → many containers. Delete a container and the image is untouched. Changes a container
makes to its filesystem live only in that container's writable layer and vanish when it's removed —
which is why databases need **volumes** (lesson 6).

## Layers and the union filesystem

An image is not one big tarball; it's an ordered list of **layers**. Each layer is a tar archive of
*file changes* — files added, modified or deleted compared to the layer below.

```text
  Container "api-1"   ┌─────────────────────────────────┐  writable, per container
                      │  upper layer (copy-on-write)     │  (gone when container is removed)
                      ╞═════════════════════════════════╡
  Image "api:1.4"     │  L4  COPY publish/ /app          │  read-only, shared
                      │  L3  aspnet runtime files        │  read-only, shared
                      │  L2  apt packages (libicu …)     │  read-only, shared
                      │  L1  Ubuntu base filesystem      │  read-only, shared
                      └─────────────────────────────────┘
```

A **union filesystem** (on Linux almost always **overlayfs**) stacks these directories and shows the
process one merged view. Three rules explain almost all "weird" image behaviour:

1. **Reading** a file: the topmost layer that has it wins.
2. **Writing** to a file that lives in a lower layer: it's first *copied up* into the writable layer,
   then modified (**copy-on-write**). The image layer is never changed.
3. **Deleting** a file from a lower layer: a *whiteout* marker is written in the upper layer that hides
   it. The bytes are still in the lower layer — **deleting never shrinks an image**.

Why bother? **Sharing and caching.** Ten containers from the same image share the same read-only
layers on disk and in memory (the kernel's file cache). Twenty different .NET images that all start
`FROM mcr.microsoft.com/dotnet/aspnet:10.0` store the runtime layers once. And when you push a new
version of your app, only the layers that changed are uploaded.

A concrete example: your API image is 230 MB, of which 220 MB is the shared aspnet base and 10 MB is
your `publish/` output. Ship a bug fix and the registry, CI and every server only move the 10 MB
layer.

:::tip title="Rule 3 in real life"
`RUN apt-get install -y build-essential` in one layer and `RUN apt-get purge build-essential` in the
next gives you an image that is *bigger*, not smaller. The fix is to do install + use + cleanup in a
**single** `RUN`, or — better — use multi-stage builds (lesson 4).
:::

### Content addressing

Every layer is identified by the **SHA-256 digest** of its contents, e.g.
`sha256:6e771e15690e…`. Same bytes → same digest, on every machine in the world. That's what lets
Docker skip downloading layers you already have, and what makes "pin by digest" (lesson 7) a hard
guarantee instead of a promise.

An image on a registry is described by a small JSON **manifest**: a list of layer digests plus the
digest of a **config** blob (env vars, entrypoint, user, working dir…). Multi-platform images add one
more level — an **index** that says "for linux/amd64 use manifest X, for linux/arm64 use manifest Y".
That's how `docker pull postgres:18` gets the right binary on an Intel server and on an M-series Mac.

## Namespaces and cgroups, in plain words

The kernel features that turn a process into a "container" come in two families:

**Namespaces — what a process can *see*.** Each namespace type gives the process its own private copy
of one global resource:

| Namespace | The process gets its own… | Effect you notice |
|---|---|---|
| `pid` | process ID tree | Your app is **PID 1**; `ps` shows only the container's processes |
| `net` | network stack (interfaces, ports, routes) | Two containers can both listen on port 8080 |
| `mnt` | mount table | It sees the image's filesystem as `/`, not your host's |
| `uts` | hostname | `hostname` prints the container ID |
| `ipc` | shared memory / semaphores | No accidental IPC with host processes |
| `user` | UID/GID mapping | (rootless mode) "root" inside = unprivileged user outside |
| `cgroup` | view of the cgroup tree | It can't see other containers' limits |

**cgroups (control groups) — how much a process can *use*.** cgroups put a budget on CPU, memory,
PIDs and I/O. `docker run --memory=512m` writes `536870912` into a file named `memory.max` in the
container's cgroup; when the process exceeds it, the kernel's **OOM killer** ("out of memory")
sends it `SIGKILL`. The exit code is **137** = 128 + signal 9.
`docker inspect --format '{{.State.OOMKilled}}' <container>` prints `true` when that's what happened.

Common mistake: assuming a memory limit makes your app *use less* memory. It doesn't — it only
decides when the kernel kills it. Runtimes such as .NET read the cgroup limit and size their heap
accordingly, which is why setting a realistic limit matters.

On top of that, Docker adds a few more safety belts:

- **Linux capabilities** split "root" into ~40 separate powers (load kernel modules, change the
  clock, bypass file permissions…). Docker drops most of them, so even root inside a container can't
  load kernel modules.
- A **seccomp** profile filters syscalls: dangerous or rarely needed ones (such as `reboot` or
  `kexec_load`) simply fail.
- **AppArmor / SELinux** profiles add mandatory access control on top (which files and resources
  the process may touch).

:::warn title="Shared kernel = weaker boundary than a VM"
A kernel bug can let a process escape its namespaces. Containers are great isolation for *your own*
services; for running *untrusted* code (customer plugins, CI jobs from strangers) teams add a
stronger sandbox: a user-space kernel like gVisor, or a lightweight VM like Kata Containers or Firecracker.
:::

## What actually runs when you type `docker run`

```text
docker CLI ──REST over /var/run/docker.sock──▶ dockerd (Docker Engine)
                                                   │ gRPC
                                                   ▼
                                               containerd  ── pulls images, manages snapshots
                                                   │
                                                   ▼
                                       containerd-shim-runc-v2 ── stays as the container's parent
                                                   │ exec
                                                   ▼
                                                 runc  ── creates namespaces + cgroups, execs
                                                   │      your process, then exits
                                                   ▼
                                           your process (PID 1 in the container)
```

- **`docker` CLI** — just an HTTP client. `docker ps` is `GET /containers/json`.
- **`dockerd`** — the Docker daemon: builds (via BuildKit), networks, volumes, the API.
- **`containerd`** — the industry-standard container *manager* (also what Kubernetes uses).
- **`runc`** — the low-level *runtime* that talks to the kernel. It starts the process and leaves.

:::warn title="The Docker socket is root"
Anyone who can talk to `/var/run/docker.sock` can start a container that mounts your host's `/` and
does anything as root. Adding your user to the `docker` group is effectively giving it root; mounting
the socket into a container gives *that container* root on the host.
:::

## Docker vs Podman vs containerd — and OCI

Docker's formats were so successful that everyone wanted to build tools around them without being
tied to one company. So in 2015 the industry founded the **Open Container Initiative (OCI)**, whose
image and runtime specs reached 1.0 in 2017 and the distribution spec in 2021:

- **Image spec** — what an image (manifest, config, layers) looks like.
- **Runtime spec** — how to run a container from an unpacked image (what `runc` implements).
- **Distribution spec** — the HTTP API for pushing/pulling to registries.

Because of OCI, the tools are interchangeable at the edges:

| Tool | What it is | When you'll meet it |
|---|---|---|
| **Docker** (Engine + CLI + Desktop) | The full developer experience: build, run, compose | Your laptop, most CI pipelines |
| **Podman** | Daemonless, rootless-by-default Docker-compatible CLI (`alias docker=podman` mostly works) | Red Hat / Fedora shops, security-conscious teams |
| **containerd** | The runtime/manager under Docker, used directly by Kubernetes | Every Kubernetes node; `nerdctl` / `ctr` CLIs |
| **BuildKit** | The build engine behind `docker build` / `docker buildx` | Every modern Docker build |
| **CRI-O** | A Kubernetes-only runtime | OpenShift clusters |

An image built with Docker runs unchanged on Podman, on containerd in Kubernetes, on AWS ECS — they
all speak OCI.

:::job title="What 'we use Kubernetes, not Docker' means on day one"
Kubernetes removed its built-in Docker integration ("dockershim") in v1.24, which confused a lot of
people. It means the *cluster nodes* run containerd instead of dockerd. You still build images with
`docker build` on your laptop and CI, push them to a registry, and the cluster pulls and runs them.
Nothing about your Dockerfile changes.
:::

## Registries and image names

A **registry** is a server that stores images (OCI distribution spec). Common ones: **Docker Hub**
(`docker.io`, the default), **GitHub Container Registry** (`ghcr.io`), **Microsoft Artifact Registry**
(`mcr.microsoft.com`), and cloud ones (AWS ECR, Azure ACR, Google Artifact Registry).

A full image reference has up to five parts:

```text
 ghcr.io:443 / acme / billing-api : 1.4.2 @ sha256:9f86d081884c…
 └─registry─┘   └namespace/repo┘   └tag┘   └────── digest ──────┘
```

Docker fills in defaults, which is why short names work:

| You type | Docker reads it as |
|---|---|
| `postgres` | `docker.io/library/postgres:latest` |
| `postgres:18` | `docker.io/library/postgres:18` |
| `grafana/grafana:12.0` | `docker.io/grafana/grafana:12.0` |
| `ghcr.io/kedacore/keda:2.17.0` | registry `ghcr.io`, repo `kedacore/keda`, tag `2.17.0` |
| `mcr.microsoft.com/dotnet/aspnet:10.0` | registry `mcr.microsoft.com`, repo `dotnet/aspnet`, tag `10.0` |
| `localhost:5000/api` | registry `localhost:5000`, repo `api`, tag `latest` |

How does Docker know whether the first part is a registry or a Docker Hub user? **If the first
component contains a `.` or a `:`, or is exactly `localhost`, it's a registry.** Otherwise it's
Docker Hub. Official images (postgres, nginx, node…) live under the hidden `library/` namespace.

A **tag** is a *movable* label (someone can re-push `postgres:18` tomorrow with a security patch). A
**digest** is the immutable hash of the manifest — `postgres@sha256:…` always means exactly the same
bytes.

:::job title="Images can disappear from under you"
Tags move, and whole repositories can go away. In 2025 Bitnami stopped publishing most of its free
`bitnami/*` images on Docker Hub, and many Helm charts and Compose files that referenced them broke
overnight. Teams that mirrored images into their own registry (ECR, ACR, Harbor, GHCR) and pinned
digests barely noticed. On day one, find out which registry your company pulls from — it's often
*not* Docker Hub directly.
:::

:::quiz id=ops-01-q1 xp=10
Which statement about containers is **true**?
- [ ] Each container runs its own Linux kernel
- [x] A container is a host process isolated with namespaces and limited with cgroups
- [ ] Containers are a lightweight kind of hypervisor
- [ ] A Linux container can run on a Windows kernel without any VM
> There is no container object in the kernel. Namespaces control what the process sees, cgroups control how much it can use, and the kernel is shared with the host. That's also why "own kernel" and "lightweight hypervisor" are wrong — those describe VMs (a hypervisor runs whole guest kernels). On macOS/Windows, Docker Desktop runs a hidden Linux VM precisely because a Linux container needs a Linux kernel.
:::

:::quiz id=ops-01-q2 xp=10
You run three containers from the image `api:1.4`. One of them writes a 50 MB log file to `/app/logs`.
What happens?
- [ ] The image `api:1.4` grows by 50 MB
- [ ] All three containers see the new file
- [x] Only that container's writable layer grows; the image and the other containers are unaffected
- [ ] The write fails because images are read-only
> Writes go to the per-container copy-on-write layer. The image layers are read-only and shared, but "read-only" doesn't make the write *fail*: the container sees a writable filesystem because of its own upper layer. The other two containers have their own upper layers and never see the file. Remove that container and the 50 MB is gone with it — use a volume if you want to keep data.
:::

:::quiz id=ops-01-q3 xp=15
This Dockerfile adds two layers on top of the base image. How big is the final image compared to the base?

```dockerfile
FROM ubuntu:24.04
# downloads a 400 MB file
ADD https://example.com/big.tar /tmp/big.tar
RUN rm /tmp/big.tar
```

- [ ] Same size as the base — the file was deleted
- [x] About 400 MB bigger — the delete only adds a whiteout in a new layer
- [ ] About 800 MB bigger — the file is stored twice
- [ ] The build fails because you cannot delete files from earlier layers
> Layers are immutable. `ADD` writes a layer containing the 400 MB file; the `RUN rm` adds a *second* layer that only contains a tiny whiteout marker *hiding* the file. The 400 MB are still in the first new layer and get pushed and pulled. It isn't 800 MB because the delete layer stores no file data, and the build doesn't fail — hiding a lower file is exactly what whiteouts are for. Download + use + delete must happen in the same `RUN` (or in a separate build stage).
:::

:::quiz id=ops-01-q4 xp=10
Which namespace makes it possible for two containers to both listen on port 8080?
- [ ] `pid`
- [ ] `mnt`
- [x] `net`
- [ ] `uts`
> Each container gets its own network namespace: its own interfaces, IP address and port table, so "port 8080" in one container is a different port 8080 from the other's. `pid` isolates the process list, `mnt` the filesystem view, `uts` the hostname — none of them touch ports. Port *conflicts* only happen when you *publish* both to the same host port (`-p 8080:8080` twice), because publishing binds a port in the **host's** network namespace. You'll see this in step 8 of the lab.
:::

:::quiz id=ops-01-q5 xp=10
Which of these references point at **Docker Hub**? (select all that apply)
- [x] `nginx:alpine`
- [x] `pgvector/pgvector:pg18`
- [ ] `ghcr.io/acme/api:1.0`
- [ ] `localhost:5000/api`
- [ ] `mcr.microsoft.com/dotnet/sdk:10.0`
> A first component with a `.` or `:` (or exactly `localhost`) is a registry host. `nginx` becomes `docker.io/library/nginx`, `pgvector/pgvector` becomes `docker.io/pgvector/pgvector` — `pgvector` is a Docker Hub *namespace*, not a registry, because it has no dot. `ghcr.io` and `mcr.microsoft.com` contain dots, and `localhost:5000` is `localhost` with a port, so those three are other registries.
:::

:::quiz id=ops-01-q6 xp=10
A container started with `docker run --memory=256m my-api` keeps dying. `docker ps -a` shows
`Exited (137)`. What is the most likely cause, and how do you confirm it?
- [ ] The app threw an unhandled exception; `docker logs` will show the stack trace
- [x] The kernel's OOM killer sent `SIGKILL` because the cgroup memory limit was exceeded; `docker inspect --format '{{.State.OOMKilled}}'` prints `true`
- [ ] The image is built for the wrong CPU architecture
- [ ] Docker stopped it because port 137 was already in use
> 137 = 128 + 9: the process was killed by signal 9 (`SIGKILL`). Combined with a memory limit, that's the classic OOM kill, and Docker records it in `State.OOMKilled`. An unhandled exception exits on its own with a different code (often 1, or 134 when the runtime aborts) and leaves a stack trace in the logs; a wrong-architecture image fails immediately with `exec format error`; exit codes have nothing to do with ports. (`docker kill` also produces 137 — that's why you check `OOMKilled` rather than guessing.)
:::

:::quiz id=ops-01-q7 xp=10
Your `compose.yaml` uses `image: postgres:18`. A teammate who pulls a week after you gets a container
with a slightly different patch version. Why, and what makes the reference truly fixed?
- [ ] Docker downloaded a corrupted layer; `docker system prune` fixes it
- [x] Tags are movable labels that were re-pushed to a newer build; referencing `postgres:18@sha256:…` pins the exact bytes
- [ ] Docker Hub picks a random build per pull; only a private registry is consistent
- [ ] Their machine has a different CPU, so it got a different major version
> `postgres:18` is re-pushed whenever a new 18.x patch or base-image fix ships, so the same tag points at a new manifest. A digest is the SHA-256 of the manifest itself and can never point anywhere else. Corrupted layers would fail their digest check rather than run; a different CPU gets a different *platform* manifest from the same index, but the same PostgreSQL version.
:::

## Simulate it: parse an image reference

Docker's reference parsing is a nice little algorithm — and knowing it means you'll never be
confused by "pull access denied for api, repository does not exist" again (it went to Docker Hub!).

:::challenge id=ops-01-c1 lang=ts xp=50
title: Parse `registry/repo:tag@digest`
Write `parseImageRef(ref)` returning `{ registry, repository, tag, digest }` using Docker's rules:

1. If there's an `@`, everything after it is the `digest` (otherwise `digest` is `null`).
2. Split the rest on `/`. If there are **at least two** components and the first one contains `.`
   or `:` or equals `localhost`, it's the **registry** — remove it. Otherwise the registry is
   `docker.io`. (A single component can never be a registry: in `postgres:18` the `:` is a tag.)
3. A `:` in the **last** path component separates the `tag` (a `:` in the registry part is a port, not a tag!).
4. If the registry is `docker.io` and the repository has no `/`, prefix it with `library/`.
5. If there's no tag: the tag is `latest` — **unless** a digest was given, then the tag is `null`.

hint: Split off the digest first, then the registry, and only then look for `:` — in the remaining part only.
hint: `localhost:5000/api` → registry `localhost:5000`, repository `api`, tag `latest`.
hint: `nginx:alpine` has only one component, so the `:` is a tag separator, not a port.

```ts starter
export interface ImageRef {
  registry: string
  repository: string
  tag: string | null
  digest: string | null
}

export function parseImageRef(ref: string): ImageRef {
  // naive: everything after ':' is the tag
  const [name, tag] = ref.split(':')
  return { registry: 'docker.io', repository: name, tag: tag ?? 'latest', digest: null }
}
```

```ts solution
export interface ImageRef {
  registry: string
  repository: string
  tag: string | null
  digest: string | null
}

export function parseImageRef(ref: string): ImageRef {
  let rest = ref
  let digest: string | null = null
  const at = rest.indexOf('@')
  if (at !== -1) {
    digest = rest.slice(at + 1)
    rest = rest.slice(0, at)
  }

  let registry = 'docker.io'
  const parts = rest.split('/')
  const first = parts[0]
  if (parts.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    registry = first
    parts.shift()
  }

  let tag: string | null = null
  const last = parts[parts.length - 1]
  const colon = last.indexOf(':')
  if (colon !== -1) {
    tag = last.slice(colon + 1)
    parts[parts.length - 1] = last.slice(0, colon)
  }

  let repository = parts.join('/')
  if (registry === 'docker.io' && !repository.includes('/')) repository = 'library/' + repository
  if (tag === null && digest === null) tag = 'latest'

  return { registry, repository, tag, digest }
}
```

```ts tests
test('official image with defaults', () => {
  expect(parseImageRef('postgres')).toEqual({ registry: 'docker.io', repository: 'library/postgres', tag: 'latest', digest: null })
})
test('official image with tag', () => {
  expect(parseImageRef('postgres:18')).toEqual({ registry: 'docker.io', repository: 'library/postgres', tag: '18', digest: null })
})
test('Docker Hub user namespace', () => {
  expect(parseImageRef('grafana/grafana:12.0')).toEqual({ registry: 'docker.io', repository: 'grafana/grafana', tag: '12.0', digest: null })
})
test('other registry with nested repo', () => {
  expect(parseImageRef('mcr.microsoft.com/dotnet/aspnet:10.0')).toEqual({ registry: 'mcr.microsoft.com', repository: 'dotnet/aspnet', tag: '10.0', digest: null })
})
test('registry with port, no tag', () => {
  expect(parseImageRef('localhost:5000/api')).toEqual({ registry: 'localhost:5000', repository: 'api', tag: 'latest', digest: null })
})
test('registry with port and tag', () => {
  expect(parseImageRef('registry.local:5000/team/api:2.1')).toEqual({ registry: 'registry.local:5000', repository: 'team/api', tag: '2.1', digest: null })
})
test('digest only → tag is null', () => {
  expect(parseImageRef('ghcr.io/acme/api@sha256:abc123')).toEqual({ registry: 'ghcr.io', repository: 'acme/api', tag: null, digest: 'sha256:abc123' })
})
test('tag and digest', () => {
  expect(parseImageRef('nginx:alpine@sha256:def456')).toEqual({ registry: 'docker.io', repository: 'library/nginx', tag: 'alpine', digest: 'sha256:def456' })
})
```
:::

## Lab: look under the hood

:::lab id=ops-01-lab1 xp=80
title: See layers, namespaces and cgroups with your own eyes
You need Docker installed (Docker Desktop on macOS/Windows, Docker Engine on Linux). Run each
command and compare with the expected output.

**1. Check the installation.**

```bash
docker version --format 'client {{.Client.Version}} / server {{.Server.Version}}'
docker info --format '{{.OperatingSystem}} · cgroup v{{.CgroupVersion}} · {{.Architecture}}'
```

You should see a client *and* a server version (if the server part errors, the daemon isn't
running — start Docker Desktop or `sudo systemctl start docker`). Most modern systems report
`cgroup v2`.

**2. Pull an image and look at its layers.**

```bash
docker pull alpine:3
docker image inspect alpine:3 --format '{{json .RootFS.Layers}}'
docker pull nginx:1.30-alpine
docker history nginx:1.30-alpine
```

Alpine has a single layer (one `sha256:` digest). `nginx:1.30-alpine` shows one line per Dockerfile
instruction — the ones with a size > 0 are real filesystem layers, `0B` lines are metadata only
(`ENV`, `CMD`, `EXPOSE`…).

**3. Multi-platform index.** One tag, many architectures:

```bash
docker buildx imagetools inspect postgres:18 | head -n 20
```

You'll see something like this (digests shortened):

```text
Name:      docker.io/library/postgres:18
MediaType: application/vnd.oci.image.index.v1+json
Digest:    sha256:…

Manifests:
  Name:        docker.io/library/postgres:18@sha256:…
  MediaType:   application/vnd.oci.image.manifest.v1+json
  Platform:    linux/amd64

  Name:        docker.io/library/postgres:18@sha256:…
  MediaType:   application/vnd.oci.image.manifest.v1+json
  Platform:    linux/arm64/v8
```

The top-level digest is the *index*; each platform has its own manifest digest. Entries with
`Platform: unknown/unknown` are attestations (build provenance / SBOM), not runnable images.

**4. The PID namespace.** Your command is PID 1 and sees no host processes:

```bash
docker run --rm alpine:3 ps
```

```text
PID   USER     TIME  COMMAND
    1 root      0:00 ps
```

**5. The UTS and net namespaces.**

```bash
docker run --rm alpine:3 hostname
docker run --rm alpine:3 ip addr
```

```text
3f2c9a1b7d4e
1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN qlen 1000
    inet 127.0.0.1/8 scope host lo
…: eth0@…: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP
    inet 172.17.0.2/16 brd 172.17.255.255 scope global eth0
```

The hostname is the container's short ID (different every run); the container has its own `lo`
and `eth0` with a private IP like `172.17.0.2` — none of your host's Wi-Fi or Ethernet interfaces.

**6. cgroups.** Ask for limits and read them back from inside:

```bash
docker run --rm --memory=64m --cpus=0.5 alpine:3 \
  sh -c 'cat /sys/fs/cgroup/memory.max; cat /sys/fs/cgroup/cpu.max'
```

```text
67108864
50000 100000
```

64 MiB = 67108864 bytes, and "50 ms of CPU every 100 ms" = half a core.

**7. Copy-on-write.** Change files in a container, then ask Docker what differs from the image:

```bash
docker run --name cow alpine:3 sh -c 'echo hi > /hello.txt && echo "# changed" >> /etc/profile'
docker diff cow
docker rm cow
```

```text
C /etc
C /etc/profile
A /hello.txt
```

`A` = added, `C` = changed (copied up into the writable layer), `D` would be deleted (a whiteout).
After `docker rm`, those changes are gone; the `alpine:3` image never changed.

**8. Two servers, one port — the net namespace in action.** Start two Redis servers. Both listen on
Redis's default port 6379, each inside its own network namespace:

```bash
docker run -d --name r1 redis:8-alpine
docker run -d --name r2 redis:8-alpine
docker exec r1 redis-cli ping
docker exec r2 redis-cli ping
```

```text
PONG
PONG
```

No conflict. Now *publish* port 6379 on the host for both:

```bash
docker run -d --name r3 -p 6379:6379 redis:8-alpine
docker run -d --name r4 -p 6379:6379 redis:8-alpine
```

The second command fails with an error ending in
`Bind for 0.0.0.0:6379 failed: port is already allocated` (if something on your host already uses
6379, even the first one fails — same reason). Publishing binds a port in the **host's** namespace,
and there is only one of those. Clean up:

```bash
docker rm -f r1 r2 r3 r4
```

:::tip
If step 6 prints errors about missing files, you're on an old cgroup v1 host. The idea is identical;
the files are just named differently (`memory/memory.limit_in_bytes`).
:::

- [ ] `docker version` shows both client and server
- [ ] I saw the layer digests of `alpine:3` and the history of `nginx:1.30-alpine`
- [ ] `ps` inside a container showed my command as PID 1
- [ ] I read the memory and CPU limits from the cgroup files
- [ ] `docker diff` showed `A` and `C` entries for my container
- [ ] Two Redis containers ran on port 6379 side by side, and publishing the same host port twice failed
:::

:::pro title="Mental model seniors use"
When something odd happens in a container, ask three questions: *What does this process see?*
(namespaces: files, network, PIDs), *what is it allowed to use?* (cgroups, capabilities), and *which
layer does this file come from?* (image vs writable layer vs volume). Almost every container mystery
is one of those three.
:::

:::cards id=ops-01-cards1 xp=15 title="Container fundamentals"
Q: Image vs container?
A: An image is a read-only template (layers + config). A container is a running or stopped instance of it with its own writable layer.
Q: What do namespaces do?
A: Control what a process can *see*: its own PID tree, network stack, mounts, hostname, IPC, users.
Q: What do cgroups do?
A: Limit what a process can *use*: CPU, memory, PIDs, I/O. Exceeding the memory limit → OOM kill, exit code 137.
Q: Why doesn't deleting a file in a later layer shrink the image?
A: Layers are immutable; the delete just adds a whiteout in a new layer. The bytes stay in the earlier layer.
Q: What is copy-on-write?
A: Modifying a file from a read-only image layer first copies it up into the container's writable layer.
Q: What does OCI standardise?
A: The image format, the runtime (how to run an unpacked image) and the registry distribution API.
Q: What is a digest?
A: The SHA-256 hash of an image manifest (or layer). Unlike a tag it can never point to different bytes.
Q: How does Docker decide if `foo/bar` is on Docker Hub?
A: The first component is a registry only if it contains `.` or `:` or is `localhost`. `foo` is none → Docker Hub.
Q: Docker CLI → ? → ? → ? → your process
A: dockerd → containerd → containerd-shim + runc → your process (PID 1).
Q: Why can two containers both listen on port 8080, but not both publish `-p 8080:8080`?
A: Each has its own network namespace (own port table). Publishing binds the port in the host's single namespace.
Q: Kernel vs userland?
A: The kernel (processes, memory, network, syscalls) is always the host's. The userland (shell, libc, runtimes, your app) is what the image ships.
Q: Why is access to /var/run/docker.sock dangerous?
A: It lets you start privileged containers that mount the host filesystem — it's equivalent to root.
:::

## Recap

- A container is an ordinary Linux process with **namespaces** (what it sees) and **cgroups** (what it
  may use). It shares the host kernel; Docker Desktop provides one via a small Linux VM.
- An **image** is a stack of read-only, content-addressed **layers** plus a config; a **container** adds
  a thin writable copy-on-write layer.
- Deleting in a later layer never shrinks an image — clean up in the same `RUN` or use multi-stage builds.
- `docker` CLI → `dockerd` → `containerd` → `runc`. Kubernetes uses containerd directly; your images
  are the same everywhere thanks to **OCI**.
- References are `registry/namespace/repo:tag@digest`; tags move, digests don't.
- Exit code **137** = killed by `SIGKILL`, most often the OOM killer enforcing a memory limit — check `State.OOMKilled`.
- Access to the Docker socket is root on the host; containers share the kernel, so untrusted code needs a stronger sandbox (gVisor or a micro-VM).
