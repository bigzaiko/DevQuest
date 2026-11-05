---
id: ops-08
title: Registries, Tags and CI Pipelines
level: advanced
minutes: 45
xp: 180
summary: Docker Hub vs GHCR, a tagging strategy that survives production, multi-arch builds with buildx, CI build caches, a complete GitHub Actions workflow to GHCR — and promoting one digest through environments.
---

Your image is only useful once it's somewhere a server can pull it from. This lesson covers the path
from `git push` to "an immutable, scanned, multi-architecture image in a registry that every environment
deploys from" — the standard shape of a container delivery pipeline.

```text
 git push ──▶ CI: build (buildx, cache) ──▶ test/scan ──▶ push ghcr.io/acme/api:sha-1a2b3c4
                                                                │ (digest sha256:9f86…)
                                                                ▼
                       dev ◀── auto-deploy        staging ◀── promote same digest        prod ◀── approve + promote
```

## Names, tags and digests

Before choosing a registry, get the vocabulary straight — every command in this lesson uses it. A
**registry** is an HTTP server that stores images (Docker Hub, GHCR, ECR…). Inside it, a **repository**
holds all versions of one image. A full image **reference** looks like this:

```text
ghcr.io / acme / api : 1.4.2 @ sha256:9f86d081884c…
└──┬──┘   └┬─┘   └┬┘   └─┬─┘   └────────┬────────┘
registry  namespace repo  tag          digest
```

- The **digest** is the SHA-256 hash of the image's *manifest* (the JSON that lists its layers and
  config). Change one byte and the digest changes, so a digest identifies exactly one image, forever.
- A **tag** is a human-friendly *name* that points at a digest. Anyone with push rights can move a tag
  to a different digest later — like a Git branch, not like a Git commit.
- If you leave out the registry, Docker assumes `docker.io`; if you leave out the tag, it assumes
  `:latest`. So `postgres` really means `docker.io/library/postgres:latest`.

Keep that analogy in mind — **tag ≈ branch, digest ≈ commit SHA** — and most of this lesson follows.

## Registries

Which registry you push to mostly depends on where your code lives and where your clusters run:

| Registry | Address | Auth | Good for |
|---|---|---|---|
| **Docker Hub** | `docker.io` (default) | Docker ID / access token | Public images, official base images |
| **GitHub Container Registry** | `ghcr.io/<owner>/<name>` | `GITHUB_TOKEN` in Actions, PAT locally | Repos on GitHub: permissions follow the repo |
| **Microsoft Artifact Registry** | `mcr.microsoft.com` | (pull only) | .NET base images |
| Cloud registries | ECR, ACR, Artifact Registry | Cloud IAM | Images close to the cluster that runs them |
| Self-hosted | Harbor, GitLab, Nexus, Artifactory | LDAP/OIDC | Air-gapped / on-prem, pull-through caches |

Practical differences you'll feel:

- **Docker Hub rate-limits pulls**, especially anonymous ones (per IP). CI runners that pull `node` and
  `postgres` dozens of times an hour hit those limits and fail with `toomanyrequests` — authenticate
  pulls, or use a mirror / pull-through cache. (The exact limits change; check Docker's pricing page.)
- **GHCR** ties packages to a GitHub user or org. In GitHub Actions the built-in `GITHUB_TOKEN` can push
  with `permissions: packages: write` — no extra secrets. New packages are usually **private** until you
  change their visibility in *Package settings*; the `org.opencontainers.image.source` label links the
  package to its repository (so repo permissions apply to it).
- Image references must be **lowercase** (Docker rejects `ghcr.io/Acme/Api` with
  `invalid reference format: repository name must be lowercase`), which bites when you build the name
  from `${{ github.repository }}` and the org is called `Acme`.

```bash
# Local login to GHCR with a personal access token (classic, scope write:packages)
echo "$CR_PAT" | docker login ghcr.io -u <your-github-username> --password-stdin

docker tag api:1.0 ghcr.io/<you>/api:1.0
docker push ghcr.io/<you>/api:1.0
```

`--password-stdin` keeps the token out of your shell history and `ps`. Docker stores credentials in a
**credential helper** (macOS Keychain, Windows Credential Manager, `pass`) when configured — otherwise
base64-encoded in `~/.docker/config.json`, which is *not* encryption.

## A tag strategy that survives production

Tags are mutable pointers to a manifest digest. That's convenient (you can say "give me `1.4`" and get
the latest patch) and dangerous (what `1.4` means today may not be what it meant yesterday). A good
strategy answers two questions at any moment: *exactly which code is running in prod?* and *what do I
roll back to?*

:::warn title="`latest` is just a name"
`latest` is the tag Docker uses when you don't specify one. It doesn't mean "newest" — it means
"whatever was last pushed *with the tag latest*". Deploying `:latest` means you can't tell which code is
running, can't roll back to "the previous latest", and Kubernetes with `imagePullPolicy: IfNotPresent`
may keep running an old cached `latest` on some nodes and a new one on others.
:::

What teams use instead:

| Tag | Example | Mutable? | Purpose |
|---|---|---|---|
| Git SHA | `sha-1a2b3c4` | no (by convention) | Every build, traceable to a commit — deploy these |
| Full semver | `1.4.2` | no | Releases |
| Floating semver | `1.4`, `1` | yes | "latest patch of 1.4" for consumers who opt in |
| Branch | `main` | yes | Latest build of a branch, for dev environments |
| PR | `pr-123` | yes | Preview environments |

And the strongest form: **deploy by digest** — `ghcr.io/acme/api@sha256:9f86…`. Tags are for humans;
digests are what you put in the production manifest. Some registries (ECR, ACR, Harbor) can also enforce
**immutable tags** so `1.4.2` can never be overwritten.

:::quiz id=ops-08-q1 xp=10
Production runs `ghcr.io/acme/api:latest`. A bad build is pushed; you want to roll back. What's the core problem?
- [ ] `latest` images can't be pulled twice
- [x] `latest` now points to the bad build, and nothing records which digest was running before
- [ ] Rolling back requires deleting the registry
- [ ] Kubernetes doesn't support the `latest` tag
> Pushing moved the `latest` pointer to the bad build, and the registry keeps no "previous value of this tag" — so you can't say what to roll back *to* (unless someone wrote the old digest down). The registry, pulls and Kubernetes all handle `latest` fine technically; the problem is lost history. Deploy immutable tags (`sha-…`, `1.4.2`) or digests, and roll back by deploying the previous one.
:::

## Multi-architecture images with buildx

Developers on Apple Silicon run **arm64**; most CI runners and many servers run **amd64**; ARM cloud
instances (AWS Graviton, Azure Cobalt, Ampere) are popular because they're cheaper. An amd64-only image
on an arm64 node fails with:

```text
exec /usr/bin/dotnet: exec format error
```

The binary inside the image (here the `dotnet` host) was compiled for a different CPU instruction set,
so the kernel refuses to run it.

A **multi-platform image** fixes that: it's an *index* (a "manifest list") pointing to one manifest per
platform (lesson 1). You push **one** tag; each node's container runtime reads the index and pulls only
the variant matching its own CPU. `docker buildx` (the BuildKit-based build CLI) builds them:

```bash
docker buildx create --name multi --driver docker-container --use   # a BuildKit builder that can do multi-platform
docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/acme/api:1.4.2 --push .
docker buildx imagetools inspect ghcr.io/acme/api:1.4.2              # lists one manifest per platform
```

Why `--push`? The classic local image store can hold only one platform per tag, so a multi-platform
result is normally pushed straight to a registry. (Docker Desktop with the *containerd image store*
enabled can `--load` multi-platform images locally too.)

Three ways to produce the foreign-architecture binaries:

| Strategy | How | Speed |
|---|---|---|
| **QEMU emulation** | `RUN` steps of the arm64 stage execute through an emulator (`docker/setup-qemu-action`, `tonistiigi/binfmt`) | Slow — often 5–20× for `dotnet publish` / `npm ci` |
| **Cross-compilation** | Build stage runs natively on the build machine (`--platform=$BUILDPLATFORM`) and targets `$TARGETARCH` | Fast — the best default |
| **Native runners** | Build each platform on matching hardware (e.g. `ubuntu-24.04-arm` runners), then merge into one index | Fast, more pipeline plumbing |

.NET and frontend builds are perfect for cross-compilation:

```dockerfile
# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0 AS build
ARG TARGETARCH
WORKDIR /src
COPY Api.csproj ./
RUN dotnet restore -a $TARGETARCH
COPY . .
RUN dotnet publish -c Release -a $TARGETARCH -o /app/publish --no-restore /p:UseAppHost=false

# No --platform here: this base image is resolved per *target* platform
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS final
WORKDIR /app
COPY --from=build /app/publish .
USER $APP_UID
EXPOSE 8080
ENTRYPOINT ["dotnet", "Api.dll"]
```

- `--platform=$BUILDPLATFORM` makes the SDK stage use the **build machine's** architecture — no emulation.
- `ARG TARGETARCH` (`amd64`/`arm64`, predefined by BuildKit) tells the SDK which architecture to produce
  (`-a amd64` works since the .NET SDK maps it to `x64`).
- The final stage has **no `RUN`**, so nothing executes on the target architecture during the build —
  QEMU isn't needed at all.
- `USER $APP_UID` — the official .NET 8+ images define a non-root user and the `APP_UID` variable for it.

:::warn title="Dockerfile comments must start the line"
A `#` is only a comment at the **start** of a line. `FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS final  # runtime`
is *not* a commented instruction — the `#` and the words after it become extra arguments, and the build fails
with an error like `FROM requires either one or three arguments`. Put comments on their own line.
:::

For a Vite app it's even simpler: the build output is plain JS/CSS — architecture-independent. Run the
node stage on `$BUILDPLATFORM`; only the `nginxinc/nginx-unprivileged:1.30-alpine` final stage is per-platform.

:::quiz id=ops-08-q2 xp=15
A multi-arch build of the .NET Dockerfile above, but **without** `--platform=$BUILDPLATFORM` on the SDK
stage, takes 14 minutes on an amd64 CI runner instead of 3. Why?
- [ ] buildx always builds platforms sequentially
- [x] The arm64 variant of the SDK stage runs `dotnet restore`/`publish` under QEMU emulation
- [ ] The arm64 SDK image is 10× bigger
- [ ] Multi-arch images need to be compressed twice
> Without the flag, the build stage uses the *target* platform's SDK image, so on an amd64 machine all its `RUN`s for the arm64 variant are emulated by QEMU — that's the 5–20× slowdown. Image size isn't the issue (the arm64 SDK image is about as big as the amd64 one), and BuildKit builds the platforms in parallel. Pinning the stage to `$BUILDPLATFORM` and passing `-a $TARGETARCH` cross-compiles natively.
:::

:::quiz id=ops-08-q5 xp=10
After moving the cluster to cheaper AWS Graviton (arm64) nodes, the API pods crash immediately with
`exec /usr/bin/dotnet: exec format error`. The image was built with plain `docker build` on an amd64 CI
runner. What's the fix?
- [ ] Set `imagePullPolicy: Always` so the nodes pull a fresh copy
- [ ] Switch the base image from `aspnet:10.0` to `aspnet:10.0-alpine`
- [x] Build a multi-platform image (`--platform linux/amd64,linux/arm64`) so arm64 nodes pull an arm64 variant
- [ ] Add `USER root` — the error is a permissions problem
> "exec format error" means the binary was compiled for another CPU architecture. A single-platform amd64 image contains only amd64 binaries, so pulling it again (or switching to Alpine, also amd64 when built this way) changes nothing, and it isn't a permission error (that would say "permission denied"). Publish an index with an arm64 variant — ideally cross-compiled — and each node picks its own.
:::

## Build cache in CI

On your laptop, the second `docker build` is fast because unchanged layers come from the local layer
cache (`CACHED` in the output). A GitHub-hosted CI runner is a **fresh VM** every time, so that cache is
empty and every build reinstalls all NuGet and npm packages. BuildKit can **export** its cache somewhere
that survives the VM and **import** it on the next run:

| Backend | Flags | Notes |
|---|---|---|
| GitHub Actions cache | `cache-from: type=gha` / `cache-to: type=gha,mode=max` | Zero setup on GitHub; repo-wide cache size limit, old entries evicted |
| Registry | `type=registry,ref=ghcr.io/acme/api:buildcache,mode=max` | Works on any CI; cache lives next to the image |
| Inline | `type=inline` | Cache metadata embedded in the image itself; only `mode=min` |
| Local dir | `type=local,src=…,dest=…` | Self-hosted runners with persistent disks |

`mode=min` (default) exports only the layers of the final image; **`mode=max`** also exports
intermediate stages — and in multi-stage builds that's where the expensive `restore`/`npm ci` layers
are. With several images in one repo, give each a `scope=` so they don't overwrite each other's cache.

:::quiz id=ops-08-q3 xp=10
CI uses `cache-to: type=gha` (default `mode=min`) for the multi-stage .NET Dockerfile. Builds still
re-run `dotnet restore` every time. Why?
- [ ] The GitHub cache can't store Docker layers
- [x] `mode=min` only exports the final stage's layers; the restore layer lives in the build stage
- [ ] `dotnet restore` can never be cached
- [ ] The cache is only read on tag builds
> In a multi-stage build the final image contains only the `aspnet` runtime layers and the copied publish output; the expensive `dotnet restore` layer lives in the *build* stage, which `mode=min` never exports. The GitHub cache stores BuildKit layers just fine, and restore is perfectly cacheable (it only re-runs when the `.csproj` layer changes). Use `mode=max` to export intermediate-stage layers too.
:::

## The complete GitHub Actions workflow

`.github/workflows/image.yml` — builds on every push and PR, pushes on `main` and on version tags,
multi-arch, cached, with SBOM and provenance:

```yaml
name: image

on:
  push:
    branches: [main]
    tags: ["v*.*.*"]
  pull_request:

permissions:
  contents: read
  packages: write        # push to GHCR with GITHUB_TOKEN

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}     # owner/repo — lowercased by metadata-action

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      # Only needed if a target-platform stage has RUN steps (our Dockerfile cross-compiles)
      - uses: docker/setup-qemu-action@v3

      - uses: docker/setup-buildx-action@v3

      - name: Log in to GHCR
        if: github.event_name != 'pull_request'
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Compute tags and labels
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=ref,event=branch
            type=ref,event=pr
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=semver,pattern={{major}}
            type=sha

      - name: Build (and push)
        id: build
        uses: docker/build-push-action@v6
        with:
          context: ./api
          platforms: linux/amd64,linux/arm64
          push: ${{ github.event_name != 'pull_request' }}
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha,scope=api
          cache-to: type=gha,scope=api,mode=max
          sbom: true
          provenance: mode=max

      - name: Summary
        if: github.event_name != 'pull_request'
        env:                                   # pass values as env vars, not inline ${{ }} (no injection)
          DIGEST: ${{ steps.build.outputs.digest }}
          TAGS: ${{ steps.meta.outputs.tags }}
        run: |
          echo "### Pushed" >> "$GITHUB_STEP_SUMMARY"
          echo "Digest: \`$DIGEST\`" >> "$GITHUB_STEP_SUMMARY"
          echo "$TAGS" >> "$GITHUB_STEP_SUMMARY"
```

Walking through it:

- **Triggers** — pushes to `main`, version tags like `v1.4.2`, and pull requests (build only, to catch
  broken Dockerfiles before merge — PRs from forks don't get a token that can push anyway).
- **`permissions`** — least privilege for the automatic `GITHUB_TOKEN`: read the code, write packages.
- **`setup-buildx-action`** — creates a `docker-container` BuildKit builder, required for multi-platform
  builds and the `gha` cache.
- **`metadata-action`** — turns the Git context into tags (`main`, `pr-12`, `1.4.2`/`1.4`/`1`,
  `sha-1a2b3c4`) and OCI labels (`org.opencontainers.image.source`, `.revision`, `.created`…). It also
  adds `latest` on stable semver tags by default (`flavor: latest=auto`).
- **`build-push-action`** — one BuildKit build for both platforms, pushes the index and all tags at once,
  imports/exports the cache, attaches SBOM and provenance attestations.
- **`steps.build.outputs.digest`** — the immutable digest, the thing you deploy and promote.
- **`setup-qemu-action`** — registers emulators. Our Dockerfile cross-compiles, so it's insurance for
  later Dockerfiles with `RUN` in a target-platform stage; delete it if you want the build to *fail*
  loudly instead of silently becoming slow.

Common mistakes with this workflow: forgetting `packages: write` (push fails with `denied: permission_denied`
/ `403`), building the image name by hand from `github.repository` without lowercasing it, and expecting
`push: false` PR builds to show up in the registry (they don't — that's the point).

:::pro title="Hardening the workflow itself"
Pin third-party actions to a **commit SHA** (`uses: docker/build-push-action@<40-char-sha> # v6`) so a
compromised tag can't inject code into your pipeline; Renovate/Dependabot keep the SHAs updated. Add a
scanner step (Trivy with `exit-code: 1` on fixable criticals) before the push, and sign the digest with
cosign keyless signing or `actions/attest-build-provenance` (needs `id-token: write` and
`attestations: write` permissions). Check each action's README for its current major version.
:::

## Image promotion: build once, deploy many

The rule: **the bytes you tested are the bytes you ship.** Never rebuild "for production" — a rebuild
pulls a newer base image, resolves `npm` ranges differently, and produces a different digest than the one
QA approved.

```text
 build  ─▶  ghcr.io/acme/api@sha256:9f86…   (tags: sha-1a2b3c4, main)
             │
             ├─▶ dev      deploys sha256:9f86…   automatically on main
             ├─▶ staging  deploys sha256:9f86…   after dev smoke tests pass
             └─▶ prod     deploys sha256:9f86…   after manual approval (GitHub Environment reviewers)
```

Ways to promote:

- **Point the environment's config at the digest** (GitOps): a PR to the deployment repo changes
  `image: ghcr.io/acme/api@sha256:9f86…` in the staging Helm values / Kustomize overlay; Argo CD or Flux
  applies it. The Git history *is* your deployment history.
- **Add an environment tag to the existing manifest** — no rebuild, no pull/push of layers:

  ```bash
  docker buildx imagetools create \
    --tag ghcr.io/acme/api:prod \
    ghcr.io/acme/api@sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
  ```

- **Copy between registries** (e.g. from a CI registry to a production registry in another cloud
  account): `crane copy`, `skopeo copy`, or `imagetools create` with a different target — again by digest.

A promotion job in Actions typically uses `workflow_dispatch` with the digest as input and an
`environment: production` that requires approval:

```yaml
name: promote
on:
  workflow_dispatch:
    inputs:
      digest:
        description: "Image digest to promote (sha256:…)"
        required: true
permissions:
  contents: read
  packages: write
jobs:
  promote:
    runs-on: ubuntu-latest
    environment: production          # required reviewers configured in repo settings
    steps:
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Tag digest as prod
        env:
          DIGEST: ${{ inputs.digest }}        # user input → env var, never inline in the script
        run: |
          [[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "Not a digest: $DIGEST"; exit 1; }
          IMAGE="ghcr.io/${GITHUB_REPOSITORY,,}"
          docker buildx imagetools create --tag "$IMAGE:prod" "$IMAGE@$DIGEST"
```

(`${GITHUB_REPOSITORY,,}` is bash for "lowercase it". The digest is user input, so it goes through an
environment variable and is validated before use — writing `${{ inputs.digest }}` straight into `run:`
would let whoever triggers the workflow inject shell commands.)

:::quiz id=ops-08-q4 xp=10
QA approved `ghcr.io/acme/api:sha-1a2b3c4` on staging. What's the right way to get it to production?
- [ ] Re-run the build on the `release` branch with `-c Release` and push as `:prod`
- [x] Deploy the same digest (or add a `prod` tag to that exact manifest with `imagetools create`)
- [ ] `docker pull` on a laptop, `docker tag`, `docker push` to `:latest`
- [ ] Rebuild with `--no-cache` to be sure it's fresh
> Promotion moves a pointer to identical bytes. Any rebuild — on a release branch, with `--no-cache`, or "to be fresh" — produces a *different* artifact (new base-image digest, newly resolved dependencies) than the one QA tested. Pulling and re-pushing from a laptop keeps the bytes but loses the audit trail, may drop the other platforms of a multi-arch index, and lands on `latest` — the tag you shouldn't deploy.
:::

:::quiz id=ops-08-q6 xp=10
Which of these references will **always** resolve to exactly the same image bytes, no matter what
anyone pushes later? (select all that apply)
- [x] `ghcr.io/acme/api@sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08`
- [x] `ghcr.io/acme/api:1.4.2@sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08`
- [ ] `ghcr.io/acme/api:sha-1a2b3c4`
- [ ] `ghcr.io/acme/api:1.4.2`
> A digest is a content hash, so any reference that contains one is pinned — when both a tag and a digest are given, the tag is ignored for pulling and only documents intent (a common style in Kubernetes manifests). `sha-…` and `1.4.2` are immutable only *by convention*: someone (or a misconfigured pipeline) can push over them unless the registry enforces immutable tags.
:::

## Simulate it: compute image tags from Git

:::challenge id=ops-08-c1 lang=ts xp=60
title: A mini metadata-action
Write `imageTags(image, ev)` that returns the full image references to push, following this policy
(close to what `docker/metadata-action` does with the config above, minus `latest` — and unlike the real
action we skip the `sha-` tag for PRs):

- The image name is **lowercased** (GHCR requires it).
- Every event except PRs also gets `sha-<first 7 chars of ev.sha>`, always **last**.
- `branch`: the branch name, lowercased, with every character outside `a-z0-9._-` replaced by `-`
  (`feature/Login` → `feature-login`).
- `tag`: if the name is semver `vX.Y.Z` (the `v` is optional) → `X.Y.Z`, `X.Y`, `X`. If it has a
  prerelease (`v2.0.0-rc.1`) → only `2.0.0-rc.1`. Any other tag name → the name itself (sanitized like a branch).
- `pr`: only `pr-<number>`.

The result is an array of strings like `ghcr.io/acme/api:main`, in exactly this order: the event's tags
(for a stable release: full, then `X.Y`, then `X`), then the `sha-` tag.

hint: A regex like `/^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/` splits semver — group 4 is the prerelease part (or `undefined`).
hint: Write a `sanitize(s)` helper: `s.toLowerCase().replace(/[^a-z0-9._-]/g, '-')`.
hint: Build the list of tags first, then map each to `` `${image}:${tag}` `` (with the image already lowercased).

```ts starter
export type GitEvent =
  | { kind: 'branch'; name: string; sha: string }
  | { kind: 'tag'; name: string; sha: string }
  | { kind: 'pr'; number: number; sha: string }

export function imageTags(image: string, ev: GitEvent): string[] {
  return [`${image}:latest`]
}
```

```ts solution
export type GitEvent =
  | { kind: 'branch'; name: string; sha: string }
  | { kind: 'tag'; name: string; sha: string }
  | { kind: 'pr'; number: number; sha: string }

const sanitize = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]/g, '-')

export function imageTags(image: string, ev: GitEvent): string[] {
  const name = image.toLowerCase()
  let tags: string[]
  if (ev.kind === 'pr') {
    tags = [`pr-${ev.number}`]
  } else {
    if (ev.kind === 'branch') {
      tags = [sanitize(ev.name)]
    } else {
      const m = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(ev.name)
      if (!m) tags = [sanitize(ev.name)]
      else if (m[4]) tags = [`${m[1]}.${m[2]}.${m[3]}${m[4]}`]
      else tags = [`${m[1]}.${m[2]}.${m[3]}`, `${m[1]}.${m[2]}`, m[1]]
    }
    tags.push(`sha-${ev.sha.slice(0, 7)}`)
  }
  return tags.map((t) => `${name}:${t}`)
}
```

```ts tests
const sha = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b'
test('main branch', () => {
  expect(imageTags('ghcr.io/acme/api', { kind: 'branch', name: 'main', sha })).toEqual([
    'ghcr.io/acme/api:main',
    'ghcr.io/acme/api:sha-1a2b3c4',
  ])
})
test('branch names are sanitized and image lowercased', () => {
  expect(imageTags('ghcr.io/Acme/Billing-API', { kind: 'branch', name: 'feature/Login', sha })).toEqual([
    'ghcr.io/acme/billing-api:feature-login',
    'ghcr.io/acme/billing-api:sha-1a2b3c4',
  ])
})
test('stable release tag', () => {
  expect(imageTags('ghcr.io/acme/api', { kind: 'tag', name: 'v1.4.2', sha })).toEqual([
    'ghcr.io/acme/api:1.4.2',
    'ghcr.io/acme/api:1.4',
    'ghcr.io/acme/api:1',
    'ghcr.io/acme/api:sha-1a2b3c4',
  ])
})
test('prerelease gets no floating tags', () => {
  expect(imageTags('ghcr.io/acme/api', { kind: 'tag', name: 'v2.0.0-rc.1', sha })).toEqual([
    'ghcr.io/acme/api:2.0.0-rc.1',
    'ghcr.io/acme/api:sha-1a2b3c4',
  ])
})
test('non-semver tag', () => {
  expect(imageTags('ghcr.io/acme/api', { kind: 'tag', name: 'Nightly', sha })).toEqual([
    'ghcr.io/acme/api:nightly',
    'ghcr.io/acme/api:sha-1a2b3c4',
  ])
})
test('pull request', () => {
  expect(imageTags('ghcr.io/acme/api', { kind: 'pr', number: 42, sha })).toEqual(['ghcr.io/acme/api:pr-42'])
})
```
:::

## Lab

:::lab id=ops-08-lab1 xp=200
title: Multi-arch images to GHCR from GitHub Actions — then promote a digest
You need a GitHub account and the `api/` project from lesson 4. Everything here is free for public
repositories.

**1. Make the Dockerfile cross-compile.** Replace `api/Dockerfile` with the multi-arch version from this
lesson (`FROM --platform=$BUILDPLATFORM …`, `ARG TARGETARCH`, `-a $TARGETARCH` on restore and publish).
Keep the `.dockerignore`.

**2. Try a multi-platform build locally.**

```bash
docker buildx create --name multi --driver docker-container --use
docker buildx inspect --bootstrap | grep -i platforms
cd api
docker buildx build --platform linux/amd64,linux/arm64 -t api:multi .
```

Both platforms build quickly, because only the SDK stage does work — natively. BuildKit warns that the
result stays in the build cache (no `--push`/`--load`), which is fine for this check. Switch back to the
default builder afterwards with `docker buildx use default`.

**3. Create the repository.**

```bash
cd ..        # the folder that contains api/
git init -b main
printf 'bin/\nobj/\n' > .gitignore
git add . && git commit -m "API with multi-arch Dockerfile"
# create an empty repo named e.g. "devquest-api" on github.com, then:
git remote add origin git@github.com:<you>/devquest-api.git
git push -u origin main
```

**4. Add the workflow.** Create `.github/workflows/image.yml` with the full workflow from this lesson
(context `./api`), commit and push:

```bash
mkdir -p .github/workflows
# paste the YAML into .github/workflows/image.yml
git add .github && git commit -m "CI: build and push image to GHCR" && git push
```

Open the **Actions** tab and watch the run. The second run of an unchanged build should be much faster —
look for `CACHED` lines in the "Build (and push)" log thanks to the `gha` cache.

**5. Inspect what was pushed.** On your GitHub profile → **Packages** you'll find `devquest-api`. If it's
private (the usual default), either make it public in *Package settings*, or log in locally with a
classic PAT (`read:packages`, or `write:packages` which you'll need in step 7) as shown above. Then:

```bash
docker buildx imagetools inspect ghcr.io/<you>/devquest-api:main
docker pull ghcr.io/<you>/devquest-api:main
docker run --rm -p 127.0.0.1:8080:8080 ghcr.io/<you>/devquest-api:main   # Ctrl+C to stop
```

The inspect output lists `linux/amd64` and `linux/arm64` manifests plus `unknown/unknown` entries — those
are the SBOM/provenance **attestation manifests**. Shortened:

```text
Name:      ghcr.io/<you>/devquest-api:main
MediaType: application/vnd.oci.image.index.v1+json
Digest:    sha256:4c1e…

Manifests:
  Name:        ghcr.io/<you>/devquest-api:main@sha256:…
  Platform:    linux/amd64
  …
  Platform:    linux/arm64
  …
  Platform:    unknown/unknown
  Annotations:
    vnd.docker.reference.type: attestation-manifest
```

The top-level `Digest` is the **index** digest — the one you deploy and promote.

**6. Cut a release.**

```bash
git tag v0.1.0 && git push origin v0.1.0
```

After the run, the package shows tags `0.1.0`, `0.1`, `0`, `latest` and `sha-…`. Verify they all share
one digest:

```bash
for t in 0.1.0 0.1 0 latest; do
  echo -n "$t  "; docker buildx imagetools inspect ghcr.io/<you>/devquest-api:$t | grep -m1 '^Digest:'
done
```

Expected: four lines with the **same** `sha256:…` value.

**7. Promote by digest.** Copy the digest from the run summary (or step 6) and, logged in with a PAT that
has `write:packages`:

```bash
DIGEST=sha256:...        # paste
docker buildx imagetools create --tag ghcr.io/<you>/devquest-api:prod ghcr.io/<you>/devquest-api@$DIGEST
docker buildx imagetools inspect ghcr.io/<you>/devquest-api:prod | grep -m1 '^Digest:'
```

The printed digest equals `$DIGEST` — nothing was rebuilt or re-uploaded; the command only wrote a new
tag pointing at the existing index.

**Optional:** add the `promote` workflow, create a `production` environment with yourself as required
reviewer (*Settings → Environments*), and run it from the Actions tab with the digest as input.

- [ ] A local `buildx` build produced both `linux/amd64` and `linux/arm64` without emulation
- [ ] The workflow pushed to GHCR on `main`, and a re-run showed cached layers
- [ ] `imagetools inspect` listed both platforms and the attestation manifests
- [ ] Tag `v0.1.0` produced `0.1.0`, `0.1`, `0`, `latest` and `sha-…` tags, and the version tags share one digest
- [ ] I promoted a digest to `:prod` and verified the digest didn't change
:::

:::job title="What the pipeline looks like at a typical company"
PR: build + unit tests + Dockerfile lint + image scan, no push. Merge to `main`: build once, push
`sha-…` (+ `main`), deploy automatically to dev. Release tag or approval: promote that digest to staging,
then prod — usually by a bot PR to a GitOps repo. Base-image digests and action SHAs are bumped by
Renovate, and every bump goes through the same pipeline.
:::

:::cards id=ops-08-cards1 xp=20 title="Registries & CI"
Q: Tag vs digest?
A: A tag is a movable name (like a Git branch); a digest is the SHA-256 of the manifest (like a commit SHA) and never changes.
Q: What does the `latest` tag mean?
A: Only "the tag used when none is given / last pushed as latest". Not newest, not stable — don't deploy it.
Q: Which tags should every CI build produce?
A: An immutable one tied to the commit (`sha-1a2b3c4`), plus semver tags on releases.
Q: What's the most precise way to reference an image in production?
A: By digest: `repo@sha256:…`.
Q: How does GitHub Actions push to GHCR without a stored secret?
A: `GITHUB_TOKEN` with `permissions: packages: write`, via docker/login-action.
Q: Why does the arm64 build take forever on an amd64 runner?
A: Its RUN steps are emulated with QEMU. Cross-compile with `--platform=$BUILDPLATFORM` + `TARGETARCH`.
Q: What does `cache-to: type=gha,mode=max` do?
A: Exports all layers, including intermediate build stages, to the GitHub Actions cache for the next run.
Q: What does `docker buildx imagetools create --tag X:prod X@sha256:…` do?
A: Adds a tag to an existing (multi-arch) manifest in the registry — no rebuild, no layer upload.
Q: Why never rebuild for production?
A: A rebuild produces different bytes (new base digest, dependency resolution) than what was tested.
Q: What are the `unknown/unknown` entries in an image index?
A: Attestation manifests — SBOM and provenance attached by BuildKit.
Q: Why is `${{ github.repository }}` risky as an image name?
A: It can contain uppercase letters; registry names must be lowercase (metadata-action lowercases it).
:::

## Recap

- Pick registries by where the code and clusters live: GHCR for GitHub repos (push with `GITHUB_TOKEN`),
  cloud registries near clusters, authenticated pulls/mirrors to dodge Docker Hub limits.
- An image reference is `registry/namespace/repo:tag@digest`; tags move like branches, digests are content hashes.
- Push `sha-…` and semver tags, never deploy `latest`, deploy **digests**.
- `docker buildx` builds multi-platform indexes; cross-compile with `$BUILDPLATFORM`/`$TARGETARCH`
  instead of emulating.
- CI runners start cold: `cache-from/to` (`gha` or registry, `mode=max`) brings rebuilds back to seconds.
- `metadata-action` + `build-push-action` give you tags, labels, multi-arch, cache, SBOM and provenance in
  one job.
- **Build once, promote the digest** through dev → staging → prod; rebuilding breaks the chain of trust.
