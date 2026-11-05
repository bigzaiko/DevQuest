---
id: cl-05
title: Object Storage & Direct Uploads (S3)
level: intermediate
minutes: 200
xp: 100
summary: Store files the cloud-native way — buckets, keys and consistency, SeaweedFS locally, presigned URLs so browsers upload straight to S3 with progress, multipart for big files, CORS, private reads, lifecycle rules and upload security.
---

Every SaaS eventually stores files: avatars, invoices, CSV imports, video. The first version is
almost always the same: a `POST /api/files` endpoint that accepts `multipart/form-data`, reads the
stream and writes it to `/var/app/uploads`. It works on the laptop. Then production happens:

* The app runs as **3 replicas** in Kubernetes. A file uploaded to pod A doesn't exist on pod B.
  Half the image requests return 404.
* Someone uploads a 2 GB screen recording on hotel Wi-Fi. The request holds an API thread, a
  connection through the ingress and a chunk of memory for **20 minutes**, then times out at 99 %.
  Kestrel's default `MaxRequestBodySize` (about 28.6 MiB) rejects it anyway, so somebody raises the
  limit to "unlimited", and the API pods start getting OOM-killed during a customer's bulk import.
* The disk fills up, backups of the VM take 6 hours, and nobody can say which files are orphaned.

The fix teams converge on is the same everywhere: **object storage** (S3 or an S3-compatible
service) holds the bytes, your **database holds the metadata**, and the **browser uploads directly
to the bucket** using a short-lived **presigned URL** that your API issues. Your API never touches
the bytes. This lesson teaches that pattern end to end, with **SeaweedFS** as the local S3.

## Where should files live?

| | Local filesystem / volume | Database blob (`bytea`, `varbinary`) | Object storage (S3 API) |
|---|---|---|---|
| Works with N replicas | No (needs a shared RWX volume, NFS pain) | Yes | Yes |
| Scales to TB / billions of files | Only with heroic effort | No: bloats backups, WAL, replication, buffer cache | Yes, designed for it |
| Cost per GB | Disk you provision up front | The most expensive storage you own | Cheapest; pay for what you store |
| Serve to browsers | Through your app | Through your app | Directly, via presigned URL or CDN |
| Transactions with your rows | No | Yes (the one real upside) | No: you need a pattern (below) |
| Typical use | Temp files, caches | Tiny blobs (< ~100 KB) that must be transactional | Everything else |

The rule of thumb: **bytes in object storage, facts about the bytes in PostgreSQL** (`files` table
with `id`, `tenant_id`, `object_key`, `content_type`, `size`, `status`, `created_by`). The database
row is what your app queries; the object key is just a pointer.

:::info title="Why not just Postgres?"
A 10 MB PDF in a `bytea` column is 10 MB in every backup, every replica, every `pg_dump` and every
`VACUUM` pass, and every download goes through a DB connection, your API and its memory. Postgres
can do it; it's just the most expensive and least scalable place to keep bytes nobody queries.
:::

## The object storage mental model

S3 is not a filesystem. It's a giant, durable **key → bytes** map with HTTP verbs.

```text
 bucket "acme-prod-uploads"            (globally unique name on AWS; per-account on most others)
 ├── key "tenants/42/avatars/0199a3e1-…/me.png"   → bytes + metadata
 ├── key "tenants/42/invoices/2026/11/inv-1001.pdf"
 └── key "tenants/43/imports/0199a3f0-…/customers.csv"

 "tenants/42/" is NOT a folder. It's the first 11 characters of some keys.
```

| Concept | What it really is |
|---|---|
| **Bucket** | A namespace with its own policy, CORS, lifecycle, versioning, region. |
| **Key** | Any UTF-8 string up to 1024 bytes. `/` has no special meaning to S3. |
| **Prefix** | The start of a key. `ListObjectsV2?prefix=tenants/42/&delimiter=/` *simulates* a folder listing by grouping keys at the next `/` (returned as `CommonPrefixes`). Listing returns at most 1000 keys per page. |
| **Object** | Bytes (up to multi-TB via multipart) + metadata. **Immutable**: you replace it, you never edit a byte range in place. |
| **System metadata** | `Content-Type`, `Content-Length`, `ETag`, `Last-Modified`, storage class. The **ETag** is an identifier of the object's content (for a single-part upload that isn't encrypted with SSE-KMS or SSE-C, the MD5 of the bytes; S3's default SSE-S3 encryption keeps it an MD5): it changes whenever the object is replaced. |
| **User metadata** | `x-amz-meta-*` headers (about 2 KB total). Set at write time; changing it means copying the object onto itself. |
| **Tags** | Up to 10 key/value pairs per object, mutable, usable in lifecycle rules and IAM policies. |

Consequences you will hit in real projects:

* **Renaming a "folder" is not a rename.** It's one `CopyObject` + `DeleteObject` per key. Two
  million objects means four million requests. Design keys so you never need to rename: put stable
  ids in keys, put human names in the database.
* **Appending is impossible.** Logs or chunked files become many objects (or multipart uploads).
* **Throughput scales per prefix.** AWS documents at least 3,500 writes and 5,500 reads per second
  *per partitioned prefix*. Keys that spread out (tenant ids, UUIDs) scale; a single hot prefix is
  where `503 SlowDown` comes from.

### Consistency and concurrency

Since December 2020, AWS S3 is **strongly consistent**: after a successful `PUT` or `DELETE`, every
subsequent `GET`, `HEAD` and `LIST` sees it. (Older blog posts describing "eventual consistency"
are out of date.) Other S3-compatible stores make similar promises; check yours.

What S3 does **not** give you is locking. Two clients writing the same key: **last writer wins**,
silently. Since 2024 S3 supports **conditional writes** (`If-None-Match: *` = "create only if the
key doesn't exist", `If-Match: <etag>` = "replace only if unchanged"), the object-storage equivalent
of optimistic concurrency. Support varies across S3-compatible services. The simpler habit: **never
let two writers share a key**. Generate a fresh UUID key per upload.

:::quiz id=cl-05-q1 xp=10
Your bucket has 2 million objects under `tenants/42/projects/apollo/`. The customer renames the
project to "Artemis" and product asks you to "rename the folder". What does that actually cost?
- [ ] One cheap metadata operation, like `mv` on Linux
- [x] A copy and a delete for **every** object: about 4 million requests, minutes to hours, and not atomic
- [ ] Nothing: S3 folders are renamed automatically when the first key changes
- [ ] It's impossible; S3 objects cannot be copied
> Prefixes aren't directories; there is no folder object to rename. Each key must be copied to
> the new key and the old one deleted, and readers see a half-renamed state in the meantime. The
> tempting answer "like `mv`" assumes a filesystem. The real fix is design: keep the human name
> ("Apollo") in Postgres and use a stable id (`projects/7f3c…/`) in the key.
:::

:::quiz id=cl-05-q8 xp=10
Two users in the same tenant upload a file called `report.pdf` at the same moment. Your API builds
the key as `tenants/42/reports/report.pdf` and issues a plain presigned PUT to each of them. Both
uploads return `200`. What is in the bucket afterwards?
- [ ] Both files: S3 detects the conflict and renames the second one to `report (1).pdf`
- [ ] Neither: the second `PUT` fails with `409 Conflict`, but the client ignores the status
- [x] One file, whichever `PUT` finished last. The other user's upload is silently overwritten
- [ ] A merged object, because S3 appends concurrent writes to the same key
> S3 has no locks and no automatic renaming: a plain `PUT` to an existing key replaces the object, and the last writer wins. Both clients see `200`, which is why nobody notices until a user opens "their" report and finds someone else's. A rejection of the second write (`412 Precondition Failed`) only happens if you ask for it with a conditional write (`If-None-Match: *`), and objects are immutable, so nothing is ever appended. The robust fix is a fresh UUID in every key, with the human file name kept in Postgres (and, if you like, as the last key segment after the UUID).
:::

## S3-compatible options

The S3 API became the de facto standard, so your code (AWSSDK.S3, the AWS CLI, `rclone`) works
against many backends. Only the endpoint and credentials change.

| Option | Where | Notes |
|---|---|---|
| **AWS S3** | AWS | The reference implementation. Storage classes, lifecycle, CloudFront, IAM. Egress is billed. |
| **Cloudflare R2** | Cloudflare | S3 API, **no egress fees**, custom domains through Cloudflare's CDN. Fewer storage classes. |
| **SeaweedFS** | Self-hosted / local dev | Apache-2.0, fast small-file storage, S3 gateway. **Our local S3 in this course.** |
| Backblaze B2, Hetzner Object Storage, Wasabi… | Hosted | Cheap S3-compatible storage; check which API features they implement. |
| Ceph RGW, Garage | Self-hosted | Ceph for large on-prem clusters; Garage for small geo-distributed setups. |

:::warn title="No MinIO in this course"
Many older tutorials use MinIO for local S3. Its community edition is no longer maintained (no
new community releases or images), so we use **SeaweedFS** everywhere. If you inherit a project
with a `minio` service in `docker-compose.yml`, replacing it with SeaweedFS is usually a
compose-file change: the app only speaks the S3 API.
:::

How SeaweedFS is put together (useful when reading its logs):

```text
            S3 clients (AWS SDK, aws cli, browser with presigned URL)
                              │  :8333
                     ┌────────▼────────┐
                     │   S3 gateway    │  SigV4 auth, buckets → collections
                     └────────┬────────┘
                     ┌────────▼────────┐
                     │      Filer      │  :8888  directory tree + metadata (leveldb/Postgres/…)
                     └───┬─────────┬───┘         buckets live under /buckets/<name>
                ┌────────▼──┐   ┌──▼───────────┐
                │  Master   │   │ Volume server│  :8080  file contents packed into big volume files
                │  :9333    │   │  (1..N)      │         (Facebook-Haystack-style, cheap small files)
                └───────────┘   └──────────────┘
 `weed server -s3` runs all four in one process: perfect for dev and CI.
```

:::info title="`weed mini`"
Recent SeaweedFS releases also ship `weed mini`, an all-in-one mode with dev-friendly defaults
(master, volume, filer and S3 in one command). Its flags and how it picks up credentials have
changed between releases, so check `weed mini -h` and the SeaweedFS wiki for your version. The lab
uses the long-established `weed server -s3` with an explicit S3 config file.
:::

## Never stream big uploads through your API

```text
 ✗ PROXY UPLOAD                                   ✓ DIRECT UPLOAD (presigned URL)

 Browser ──2 GB──► Ingress ──2 GB──► API ──2 GB──► S3     Browser ─(1) "I want to upload cat.png, 2 MB, image/png"─► API
           holds a connection and an API                     API checks auth, type, size, quota; makes a key
           request for the whole upload                       API ◄── signs locally, no network call ──►
           the bytes cross your network twice    Browser ◄─(2) { key, url (valid 5 min) } ── API
                                                 Browser ─(3) PUT url, body = file ─────────────────► S3 / SeaweedFS
                                                 Browser ─(4) "done: key" ─► API ─ HEAD object, verify ─► S3
                                                                            API marks the files row 'ready'
```

What you gain:

* **No bytes through your pods.** Upload throughput becomes S3's problem; your API handles two
  tiny JSON requests per file.
* **No body-size, timeout or memory tuning** in Kestrel, the ingress (`proxy-body-size`), or the
  load balancer.
* **Resumable, parallel multipart** becomes possible, because the browser talks to S3 directly.

What you must now handle yourself: the client can lie in step (1) and can skip step (4). That's
why step (4) re-checks the object's real size and type, and why a lifecycle rule or a sweeper job
deletes uploads that were never confirmed (rows stuck in `pending`).

:::quiz id=cl-05-q2 xp=15
Which are real costs of proxying uploads through your ASP.NET API instead of using presigned
URLs? (Select all that apply.)
- [x] Each upload ties up a request, a connection through the ingress and buffers for its whole duration
- [x] The bytes cross your infrastructure twice (client → API → bucket), doubling bandwidth
- [x] You have to raise body-size limits and timeouts in Kestrel, the ingress and the load balancer
- [ ] Browsers cannot send files to S3 directly, so proxying is the only option anyway
> The first three are exactly the production pain from the intro. The tempting fourth is false:
> with a presigned URL (plus bucket CORS) the browser `PUT`s straight to S3 or SeaweedFS. Proxying
> is still fine for tiny files you must transform synchronously, but it's the exception.
:::

## Upload security: never trust the client

The browser tells you a file name, a content type and a size. All three are attacker-controlled.

| Threat | Example | Defence |
|---|---|---|
| **Path / key injection** | file name `../../tenants/43/avatar.png` | The **server** builds the key; the client's name is sanitized and only used as the last segment. |
| **Cross-tenant access** | `POST /complete { key: "tenants/43/…" }` | Every key the API accepts must start with the **caller's** tenant prefix (from the token, not the body). |
| **Overwrite** | Two uploads with the same name | A fresh UUID (v7 sorts by time) in every key. Never reuse keys. |
| **Stored XSS** | `invoice.html` uploaded as `text/html`, served from `app.example.com` | Allow-list content types; serve user content from a **separate domain**; `Content-Disposition: attachment` for anything that isn't a safe image. |
| **Wrong content** | `virus.exe` renamed to `cat.png` with `Content-Type: image/png` | Treat the type as a claim; verify magic bytes / scan in a background worker before marking the file `ready` (the boss, *The Media Processing Pipeline*, has the background worker and state machine to add this as an `uploaded → scanned` stage). |
| **Huge files** | Ticket for 1 KB, uploads 5 GB | Check the declared size, enforce it where possible (presigned POST), and re-check with `HEAD` after upload. |

A good key shape:

```text
tenants/{tenantId}/uploads/{yyyy}/{mm}/{uuid}/{sanitized-name}
        └ IAM/ownership ┘ └ lifecycle/ops ┘ └unique┘ └ human-friendly, for downloads ┘
```

:::job title="What you'll meet on day one"
A `files` (or `attachments`) table with `status in ('pending','ready','rejected')`, a
`POST /uploads` endpoint that returns a presigned URL, a `POST /uploads/{id}/complete` endpoint,
and a nightly job that deletes `pending` rows older than a day plus their objects. If the
codebase streams uploads through a controller with `IFormFile`, migrating to this flow is a very
common first "real" ticket.
:::

:::challenge id=cl-05-c1 lang=ts xp=40
title: Safe object keys
Implement `sanitizeFileName(name)` and `buildObjectKey({ tenantId, fileName, id, now })`.

`sanitizeFileName`:
1. Keep only the **base name**: the part after the last `/` or `\`.
2. Normalize with `normalize('NFKD')`, remove combining marks (`/[\u0300-\u036f]/g`), lowercase.
3. Replace every run of characters **not** in `[a-z0-9._-]` with a single `-`.
4. Collapse runs of `.` into one `.` and runs of `-` into one `-`.
5. Trim `-`, `.` and `_` from both ends; cut to at most **80** characters (trim the end again).
6. If nothing is left, return `"file"`.

`buildObjectKey` returns `tenants/{tenantId}/uploads/{yyyy}/{mm}/{id}/{safeName}`:
- `tenantId` must match `/^[a-z0-9][a-z0-9-]{0,62}$/`, otherwise **throw**.
- `id` must be a lowercase UUID (`8-4-4-4-12` hex digits), otherwise **throw**.
- Year and month come from `now` in **UTC** (month zero-padded), so keys don't depend on the
  server's time zone. `now` is injected so tests don't depend on the real clock.

hint: `name.split(/[\\/]/).pop()` gives the base name.
hint: `.replace(/[^a-z0-9._-]+/g, '-')` handles step 3 in one go.
hint: `getUTCFullYear()` and `String(now.getUTCMonth() + 1).padStart(2, '0')`.

```ts starter
export function sanitizeFileName(name: string): string {
  return name
}

export function buildObjectKey(input: { tenantId: string; fileName: string; id: string; now: Date }): string {
  return `${input.tenantId}/${input.fileName}`
}
```

```ts solution
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  let s = base.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  s = s.replace(/[^a-z0-9._-]+/g, '-').replace(/\.{2,}/g, '.').replace(/-{2,}/g, '-')
  s = s.replace(/^[-._]+|[-._]+$/g, '')
  s = s.slice(0, 80).replace(/[-._]+$/g, '')
  return s || 'file'
}

const TENANT_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function buildObjectKey(input: { tenantId: string; fileName: string; id: string; now: Date }): string {
  const { tenantId, fileName, id, now } = input
  if (!TENANT_RE.test(tenantId)) throw new Error(`invalid tenant id: ${tenantId}`)
  if (!UUID_RE.test(id)) throw new Error(`invalid upload id: ${id}`)
  const yyyy = now.getUTCFullYear()
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
  return `tenants/${tenantId}/uploads/${yyyy}/${mm}/${id}/${sanitizeFileName(fileName)}`
}
```

```ts tests
const ID = '0199a3e1-7c2b-7d4e-9f00-1a2b3c4d5e6f'
const NOV = new Date(Date.UTC(2026, 10, 5, 12, 0))

test('simple name: lowercase, spaces become dashes', () => {
  expect(sanitizeFileName('Cat Photo.PNG')).toBe('cat-photo.png')
})
test('diacritics are removed', () => {
  expect(sanitizeFileName('Résumé Final.pdf')).toBe('resume-final.pdf')
})
test('path traversal is reduced to the base name', () => {
  expect(sanitizeFileName('../../etc/passwd')).toBe('passwd')
  expect(sanitizeFileName('C:\\Users\\bob\\evil.exe')).toBe('evil.exe')
})
test('runs of dots and dashes collapse, ends are trimmed', () => {
  expect(sanitizeFileName('report..pdf')).toBe('report.pdf')
  expect(sanitizeFileName('a   b')).toBe('a-b')
  expect(sanitizeFileName('...hidden')).toBe('hidden')
  expect(sanitizeFileName('-_draft_-')).toBe('draft')
})
test('nothing usable left -> "file"', () => {
  expect(sanitizeFileName('???')).toBe('file')
  expect(sanitizeFileName('')).toBe('file')
})
test('long names are capped at 80 characters', () => {
  expect(sanitizeFileName('x'.repeat(200) + '.txt')).toBe('x'.repeat(80))
})
test('the end is trimmed again after cutting to 80', () => {
  // character 80 is the '-', which must not survive the cut
  expect(sanitizeFileName('a'.repeat(79) + '-bcd.txt')).toBe('a'.repeat(79))
})
test('builds the full key', () => {
  expect(buildObjectKey({ tenantId: 'acme', fileName: 'Cat Photo.PNG', id: ID, now: NOV }))
    .toBe(`tenants/acme/uploads/2026/11/${ID}/cat-photo.png`)
})
test('uses UTC for year and month', () => {
  const lateJan = new Date(Date.UTC(2026, 0, 31, 23, 30))
  const earlyFeb = new Date(Date.UTC(2026, 1, 1, 0, 30))
  expect(buildObjectKey({ tenantId: 'acme', fileName: 'a.txt', id: ID, now: lateJan })).toContain('/2026/01/')
  expect(buildObjectKey({ tenantId: 'acme', fileName: 'a.txt', id: ID, now: earlyFeb })).toContain('/2026/02/')
})
test('client-supplied traversal never escapes the tenant prefix', () => {
  const key = buildObjectKey({ tenantId: 'acme', fileName: '../../tenants/evil/x.png', id: ID, now: NOV })
  expect(key).toBe(`tenants/acme/uploads/2026/11/${ID}/x.png`)
})
test('rejects bad tenant ids', () => {
  expect(() => buildObjectKey({ tenantId: 'Acme', fileName: 'a', id: ID, now: NOV })).toThrow()
  expect(() => buildObjectKey({ tenantId: '../x', fileName: 'a', id: ID, now: NOV })).toThrow()
  expect(() => buildObjectKey({ tenantId: '', fileName: 'a', id: ID, now: NOV })).toThrow()
  expect(() => buildObjectKey({ tenantId: '-acme', fileName: 'a', id: ID, now: NOV })).toThrow()
  expect(() => buildObjectKey({ tenantId: 'a'.repeat(64), fileName: 'a', id: ID, now: NOV })).toThrow()
  expect(buildObjectKey({ tenantId: 'a'.repeat(63), fileName: 'a', id: ID, now: NOV }))
    .toBe(`tenants/${'a'.repeat(63)}/uploads/2026/11/${ID}/a`)
})
test('rejects bad ids', () => {
  expect(() => buildObjectKey({ tenantId: 'acme', fileName: 'a', id: 'not-a-uuid', now: NOV })).toThrow()
  expect(() => buildObjectKey({ tenantId: 'acme', fileName: 'a', id: ID.toUpperCase(), now: NOV })).toThrow()
})
```
:::

## Presigned URLs

Normally every S3 request is signed with **SigV4** (AWS Signature Version 4): the client computes
an HMAC-SHA256 over the method, path, selected headers and a timestamp, using its **secret key**,
and sends the result in the `Authorization` header. S3 knows the same secret, recomputes the
signature and rejects the request if it differs. The secret itself never travels over the wire.

A presigned URL is that same signed request **with the signature in the query string** instead of
the header. Your API computes it **locally** with its secret key (no call to S3), and anyone holding
the URL may perform exactly that one request until it expires. That's why it works for browsers: the
browser gets a capability ("you may PUT this one key for 5 minutes") without ever seeing a credential.

```text
http://localhost:8333/uploads/tenants/demo/uploads/2026/11/0199…/cat.png
  ?X-Amz-Algorithm=AWS4-HMAC-SHA256
  &X-Amz-Credential=devquest/20261105/us-east-1/s3/aws4_request   ← access key id + scope (never the secret)
  &X-Amz-Date=20261105T101500Z
  &X-Amz-Expires=300                                                ← seconds
  &X-Amz-SignedHeaders=content-type;host                            ← headers the client MUST send unchanged
  &X-Amz-Signature=3f9c…                                            ← HMAC over method, path, query, signed headers
```

What is locked by the signature: the **HTTP method**, the **bucket and key**, the expiry, and any
**signed headers** (here `Content-Type`). Change any of them and S3 answers
`403 SignatureDoesNotMatch`. What is *not* locked by a plain presigned PUT: the **size** of the body.

| | Presigned **PUT** | Presigned **POST** (policy) |
|---|---|---|
| Browser sends | `PUT url` with the file as body | `multipart/form-data` form with policy fields + file |
| Enforce content type | Yes, if `Content-Type` is a signed header | Yes (`Content-Type` condition, can be a prefix like `image/`) |
| Enforce size | No | **Yes**: `content-length-range` condition |
| Progress in browser | XHR `upload.onprogress` | Same |
| Multipart / resume | Yes (presign each `UploadPart`) | No, single request only |
| SDK support | Every SDK (`GetPreSignedURL`) | Check your SDK (see warning) |

:::warn title="Presigned POST in .NET and on S3-compatible stores"
AWSSDK.S3 has long had `GetPreSignedURL` for any verb; first-class presigned **POST** support in
the .NET SDK is much newer than in the JS and Python SDKs, and S3-compatible servers differ in how
completely they implement POST policies. Verify against the SDK docs and your storage before you
rely on `content-length-range`. The pattern in this lesson (presigned PUT + verify with `HEAD`
on complete) works everywhere.
:::

Issuing a presigned PUT in ASP.NET Core 10 with **AWSSDK.S3**:

```csharp
using Amazon.Runtime;
using Amazon.S3;
using Amazon.S3.Model;

builder.Services.AddSingleton<IAmazonS3>(_ => new AmazonS3Client(
    new BasicAWSCredentials(cfg["S3:AccessKey"], cfg["S3:SecretKey"]), // on AWS: omit → IAM role / IRSA
    new AmazonS3Config
    {
        ServiceURL = cfg["S3:ServiceUrl"],   // "http://localhost:8333" (SeaweedFS); omit on AWS, set RegionEndpoint
        ForcePathStyle = true,               // http://host/bucket/key, not http://bucket.host/key
        AuthenticationRegion = "us-east-1",  // SeaweedFS accepts any region; it must match the signature scope
    }));

app.MapPost("/uploads", (UploadRequest req, IAmazonS3 s3) =>
{
    // validate req.ContentType against an allow-list and req.Size against a max first (see the lab)
    var key = ObjectKeys.Build(tenantId: "demo", req.FileName, DateTimeOffset.UtcNow);
    var url = s3.GetPreSignedURL(new GetPreSignedUrlRequest
    {
        BucketName = "uploads",
        Key = key,
        Verb = HttpVerb.PUT,
        Expires = DateTime.UtcNow.AddMinutes(5),  // short: it's a one-shot capability
        ContentType = req.ContentType,            // becomes a signed header
        Protocol = Protocol.HTTP,                 // local SeaweedFS has no TLS; the SDK defaults to https
    });
    return Results.Ok(new { key, url });
});
```

:::pro title="How long should a presigned URL live?"
Minutes, not days. An upload URL only needs to live until the upload *starts* (S3 checks the
expiry when the request arrives, not when it finishes), so 5–15 minutes is plenty. SigV4 allows
up to 7 days, **but** a URL can never outlive the credentials that signed it. In production your
API usually doesn't have a long-lived access key. It gets **temporary credentials** from AWS STS
(the Security Token Service) through an IAM role, for example via IRSA or EKS Pod Identity on
Kubernetes, and those expire, often after an hour or a few. A URL signed with them dies at the same
moment. "Our 7-day share links break after a few hours in production but work locally"
is a classic incident with exactly this cause.
:::

:::quiz id=cl-05-q3 xp=15
Your API issues a presigned PUT for `image/png` (the content type is a signed header) after the
client declared `size: 200 KB`. A malicious client uploads a 4 GB file with
`Content-Type: image/png` using that URL. What happens?
- [ ] S3 rejects it: the declared size is part of the signature
- [x] The upload succeeds; a plain presigned PUT doesn't limit body size, so you need a POST policy with `content-length-range` and/or a `HEAD` check on complete that deletes oversized objects
- [ ] S3 rejects it because presigned URLs are limited to 5 MB
- [ ] It fails with `SignatureDoesNotMatch` because the body changed
> The signature covers method, key, expiry and signed headers. The body uses
> `UNSIGNED-PAYLOAD`, which is what makes presigned PUTs usable from browsers at all. The tempting
> answer "the size is signed" would only hold if you signed `Content-Length` too, which not every
> SDK or store supports. Defence in depth: POST policy where available, then verify the real
> `ContentLength` with `HEAD` before you accept the file, and keep the URL short-lived.
:::

## Uploading from the browser with progress

`fetch()` has **no upload progress events** in browsers (streaming request bodies exist in some
browsers but don't give reliable progress and need HTTP/2). For a progress bar, use
`XMLHttpRequest`, whose `xhr.upload.onprogress` fires as bytes leave the browser:

```ts
export function putWithProgress(
  url: string,
  body: Blob,
  contentType: string,
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('Content-Type', contentType) // must equal the signed value exactly
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total) }
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve(xhr.getResponseHeader('ETag') ?? '')   // readable only if CORS exposes ETag
        : reject(new Error(`Storage answered ${xhr.status}`))
    xhr.onerror = () => reject(new Error('Network error (often: bucket CORS)'))
    xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'))
    signal?.addEventListener('abort', () => xhr.abort())
    xhr.send(body)
  })
}
```

Note what's **not** there: no `Authorization` header, no cookies. The URL *is* the credential.

The UI around it is a small **state machine**. Modelling it explicitly (instead of four
booleans like `isUploading`, `isDone`, `hasError`, `progress`) makes impossible states impossible:

```text
                   click Upload (a file is chosen)
   ┌──────┐ ─────────────────────────────────────► ┌───────────┐ ◄── progress(n%) ──┐
   │ idle │                                        │ uploading │ ───────────────────┘
   └──────┘                                        └─────┬─────┘   (stays uploading, updates n)
      ▲                                    resolve ┌─────┴─────┐ reject
      │                                            ▼           ▼
      │  choose a new file                    ┌────────┐   ┌────────┐
      └───────────────────────────────────────│  done  │   │ error  │── Retry ──► uploading
         (from done or error)                 └────────┘   └────────┘

   Events that don't fit the current state are ignored, e.g. a late progress(n%) after done.
```

Each box is one value of a single `status` field, and each arrow is one event. With four separate
booleans you could accidentally be "uploading" and "done" at once, or show an old error next to a
fresh progress bar. With one `status`, those combinations simply can't be represented.

:::challenge id=cl-05-c2 lang=tsx xp=60 preview=Demo
title: Upload component state machine
Build `Uploader({ upload })`. The uploader is **injected**: `upload(file, onProgress)` returns a
promise of `{ key }` and calls `onProgress(loaded, total)` along the way. In the app it's
XHR + presigned URL; in tests it's a fake you control.

- A file input labelled `Choose file` and a button `Upload`.
- **idle**: `Upload` is disabled until a file is chosen.
- **uploading**: clicking `Upload` calls `upload(file, onProgress)`. Show an element with
  `role="progressbar"`, `aria-valuenow={percent}` and text `Uploading {percent}%`
  (`Math.round(loaded / total * 100)`, starting at `0`). `Upload` is disabled.
- **done**: show `role="status"` with `Uploaded {key}`; the progress bar disappears.
- **error**: show `role="alert"` with `Upload failed: {error.message}` and a `Retry` button that
  starts the same file again.
- Choosing a new file returns to **idle** (status/alert disappear).
- A progress event that arrives **after** the upload finished must be ignored.

hint: Model the state as a union: `{ status: 'idle' } | { status: 'uploading'; percent: number } | { status: 'done'; key: string } | { status: 'error'; message: string }`.
hint: A `useReducer` whose `progress` case only applies while `status === 'uploading'` gives you the "ignore late events" rule for free.
hint: Keep the chosen `File` in its own `useState`; read it with `e.target.files?.[0]`.

```tsx starter
import { useState } from 'react'

export type UploadFn = (file: File, onProgress: (loaded: number, total: number) => void) => Promise<{ key: string }>

export function Uploader({ upload }: { upload: UploadFn }) {
  const [file, setFile] = useState<File | null>(null)
  return (
    <div>
      <label htmlFor="file">Choose file</label>
      <input id="file" type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <button type="button">Upload</button>
    </div>
  )
}

export function Demo() {
  const upload: UploadFn = (file, onProgress) =>
    new Promise((resolve, reject) => {
      let loaded = 0
      const total = Math.max(file.size, 1)
      const tick = () => {
        loaded = Math.min(total, loaded + total / 10)
        onProgress(loaded, total)
        if (loaded < total) setTimeout(tick, 150)
        else if (file.name.includes('fail')) reject(new Error('Storage answered 403'))
        else resolve({ key: `tenants/demo/uploads/${file.name}` })
      }
      setTimeout(tick, 150)
    })
  return <Uploader upload={upload} />
}
```

```tsx solution
import { useReducer, useState } from 'react'

export type UploadFn = (file: File, onProgress: (loaded: number, total: number) => void) => Promise<{ key: string }>

type UploadState =
  | { status: 'idle' }
  | { status: 'uploading'; percent: number }
  | { status: 'done'; key: string }
  | { status: 'error'; message: string }

type UploadAction =
  | { type: 'reset' }
  | { type: 'start' }
  | { type: 'progress'; percent: number }
  | { type: 'success'; key: string }
  | { type: 'failure'; message: string }

function uploadReducer(state: UploadState, action: UploadAction): UploadState {
  const uploading = state.status === 'uploading'
  switch (action.type) {
    case 'reset': return uploading ? state : { status: 'idle' }
    case 'start': return uploading ? state : { status: 'uploading', percent: 0 }
    case 'progress': return uploading ? { status: 'uploading', percent: action.percent } : state
    case 'success': return uploading ? { status: 'done', key: action.key } : state
    case 'failure': return uploading ? { status: 'error', message: action.message } : state
  }
}

export function Uploader({ upload }: { upload: UploadFn }) {
  const [file, setFile] = useState<File | null>(null)
  const [state, dispatch] = useReducer(uploadReducer, { status: 'idle' })
  const busy = state.status === 'uploading'

  async function start() {
    if (!file) return
    dispatch({ type: 'start' })
    try {
      const { key } = await upload(file, (loaded, total) =>
        dispatch({ type: 'progress', percent: total > 0 ? Math.round((loaded / total) * 100) : 0 }))
      dispatch({ type: 'success', key })
    } catch (e) {
      dispatch({ type: 'failure', message: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <div>
      <label htmlFor="file">Choose file</label>
      <input
        id="file"
        type="file"
        disabled={busy}
        onChange={(e) => { setFile(e.target.files?.[0] ?? null); dispatch({ type: 'reset' }) }}
      />
      <button type="button" disabled={!file || busy} onClick={start}>Upload</button>
      {state.status === 'uploading' && (
        <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={state.percent}>
          Uploading {state.percent}%
        </div>
      )}
      {state.status === 'done' && <p role="status">Uploaded {state.key}</p>}
      {state.status === 'error' && (
        <div role="alert">
          <p>Upload failed: {state.message}</p>
          <button type="button" onClick={start}>Retry</button>
        </div>
      )}
    </div>
  )
}

export function Demo() {
  const upload: UploadFn = (file, onProgress) =>
    new Promise((resolve, reject) => {
      let loaded = 0
      const total = Math.max(file.size, 1)
      const tick = () => {
        loaded = Math.min(total, loaded + total / 10)
        onProgress(loaded, total)
        if (loaded < total) setTimeout(tick, 150)
        else if (file.name.includes('fail')) reject(new Error('Storage answered 403'))
        else resolve({ key: `tenants/demo/uploads/${file.name}` })
      }
      setTimeout(tick, 150)
    })
  return <Uploader upload={upload} />
}
```

```tsx tests
type FakeCall = { file: File; onProgress: (loaded: number, total: number) => void; resolve: (v: { key: string }) => void; reject: (e: Error) => void }
function fakeUploader() {
  const calls: FakeCall[] = []
  const upload = (file: File, onProgress: (loaded: number, total: number) => void) =>
    new Promise<{ key: string }>((resolve, reject) => { calls.push({ file, onProgress, resolve, reject }) })
  return { upload, calls }
}
async function pickFile(file: File) {
  const input = screen.getByLabelText('Choose file')
  await act(async () => {
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
const png = () => new File(['x'.repeat(200)], 'a.png', { type: 'image/png' })

test('idle: Upload is disabled until a file is chosen', async () => {
  const { upload } = fakeUploader()
  render(<Uploader upload={upload} />)
  expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled()
  await pickFile(png())
  expect(screen.getByRole('button', { name: 'Upload' })).toBeEnabled()
  expect(screen.queryByRole('progressbar')).toBeNull()
})

test('uploading: calls the injected uploader and shows 0%', async () => {
  const { upload, calls } = fakeUploader()
  render(<Uploader upload={upload} />)
  const file = png()
  await pickFile(file)
  await user.click(screen.getByRole('button', { name: 'Upload' }))
  expect(calls).toHaveLength(1)
  expect(calls[0].file).toBe(file)
  expect(screen.getByRole('progressbar')).toHaveTextContent('Uploading 0%')
  expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled()
})

test('progress events update the bar', async () => {
  const { upload, calls } = fakeUploader()
  render(<Uploader upload={upload} />)
  await pickFile(png())
  await user.click(screen.getByRole('button', { name: 'Upload' }))
  await act(async () => { calls[0].onProgress(50, 200) })
  const bar = screen.getByRole('progressbar')
  expect(bar).toHaveTextContent('Uploading 25%')
  expect(bar).toHaveAttribute('aria-valuenow', '25')
})

test('done: shows the key and hides the bar', async () => {
  const { upload, calls } = fakeUploader()
  render(<Uploader upload={upload} />)
  await pickFile(png())
  await user.click(screen.getByRole('button', { name: 'Upload' }))
  await act(async () => { calls[0].resolve({ key: 'tenants/demo/a.png' }) })
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Uploaded tenants/demo/a.png'))
  expect(screen.queryByRole('progressbar')).toBeNull()
})

test('late progress after done is ignored', async () => {
  const { upload, calls } = fakeUploader()
  render(<Uploader upload={upload} />)
  await pickFile(png())
  await user.click(screen.getByRole('button', { name: 'Upload' }))
  await act(async () => { calls[0].resolve({ key: 'k1' }) })
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Uploaded k1'))
  await act(async () => { calls[0].onProgress(10, 100) })
  expect(screen.queryByRole('progressbar')).toBeNull()
  expect(screen.getByRole('status')).toHaveTextContent('Uploaded k1')
})

test('error: shows the message and Retry uploads the same file again', async () => {
  const { upload, calls } = fakeUploader()
  render(<Uploader upload={upload} />)
  const file = png()
  await pickFile(file)
  await user.click(screen.getByRole('button', { name: 'Upload' }))
  await act(async () => { calls[0].reject(new Error('Network down')) })
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Upload failed: Network down'))
  await user.click(screen.getByRole('button', { name: 'Retry' }))
  expect(calls).toHaveLength(2)
  expect(calls[1].file).toBe(file)
  expect(screen.getByRole('progressbar')).toHaveTextContent('Uploading 0%')
  expect(screen.queryByRole('alert')).toBeNull()
})

test('choosing a new file returns to idle', async () => {
  const { upload, calls } = fakeUploader()
  render(<Uploader upload={upload} />)
  await pickFile(png())
  await user.click(screen.getByRole('button', { name: 'Upload' }))
  await act(async () => { calls[0].resolve({ key: 'k1' }) })
  await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument())
  await pickFile(new File(['y'], 'b.png', { type: 'image/png' }))
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.getByRole('button', { name: 'Upload' })).toBeEnabled()
})
```
:::

## Multipart upload for large files

A single `PUT` is capped at **5 GiB** on AWS and, more importantly, is all-or-nothing: lose Wi-Fi
at 95 % and you start over. **Multipart upload** splits the object into parts that are uploaded
independently (in parallel, retried individually) and stitched together at the end:

```text
 API: CreateMultipartUpload(key)                       → uploadId
 API: presign UploadPart(key, uploadId, partNumber=1..N)  (one URL per part, or batches on demand)
 Browser: PUT part 1 ┐
          PUT part 2 ├─ 3–6 in parallel, each returns an ETag header (CORS must expose ETag!)
          PUT part 3 ┘
 API: CompleteMultipartUpload(key, uploadId, [{1, etag1}, {2, etag2}, …])   → the object appears
      or AbortMultipartUpload(key, uploadId)                                → parts are discarded
```

The rules (AWS S3; most compatible stores copy them, but check yours):

| Limit | Value |
|---|---|
| Part size | **5 MiB minimum** (except the last part), 5 GiB maximum |
| Parts per upload | **10,000 maximum**, numbered 1..10,000 |
| Order | Parts can upload in any order; `Complete` lists them in ascending part number |
| ETag of the result | Not the MD5 of the file: it looks like `"<hash>-<partCount>"` |

So the part size isn't a free choice. With 8 MiB parts, 10,000 parts cover about 78 GiB; a 200 GiB
file needs parts of at least `ceil(size / 10,000)` bytes. **Resume** works because the upload
lives on the server until completed or aborted: after a crash, the client asks the API
(`ListParts(uploadId)`) which parts S3 already has and sends only the missing ones. For that the
client must remember the `uploadId` and `key` across a page reload, typically in `localStorage`
keyed by file name + size + `lastModified`, and the file must be picked again (browsers don't
let a page reopen a file on its own).

:::warn title="Check the current limits for your provider"
The numbers above are AWS's long-standing multipart limits. AWS has raised object-size limits
before, and S3-compatible stores (R2, SeaweedFS, B2…) set their own maximum part size, part count
and object size. Before you hard-code constants, check the "Amazon S3 multipart upload limits"
page in the AWS docs, or the equivalent page for your store.
:::

:::warn title="Incomplete multipart uploads are invisible and billed"
Parts of an upload that is never completed or aborted **don't show up in `ListObjects`** and
don't appear as objects in the console, yet you pay for the storage. Teams discover terabytes of
them years later. Always add a lifecycle rule `AbortIncompleteMultipartUpload` (for example after
1–7 days) on every bucket that accepts multipart uploads.
:::

The .NET side is three calls on `IAmazonS3` plus a presign per part:

```csharp
var init = await s3.InitiateMultipartUploadAsync(new InitiateMultipartUploadRequest
{
    BucketName = bucket, Key = key, ContentType = contentType,
});

string PartUrl(int partNumber) => s3.GetPreSignedURL(new GetPreSignedUrlRequest
{
    BucketName = bucket, Key = key, Verb = HttpVerb.PUT,
    UploadId = init.UploadId, PartNumber = partNumber,
    Expires = DateTime.UtcNow.AddMinutes(30),
});

// later, when the browser reports all part ETags:
await s3.CompleteMultipartUploadAsync(new CompleteMultipartUploadRequest
{
    BucketName = bucket, Key = key, UploadId = init.UploadId,
    PartETags = parts.Select(p => new PartETag(p.PartNumber, p.ETag)).ToList(),
});
```

:::challenge id=cl-05-c3 lang=ts xp=50
title: Plan multipart part ranges
Implement `planParts(size, preferredPartSize = 8 * MiB)` returning
`{ partNumber, start, end }[]` where `start` is inclusive and `end` is exclusive (exactly what
`file.slice(start, end)` wants). The constants are in the setup block.

- `size` must be a positive integer, otherwise throw a `RangeError`.
- The smallest part size that fits in `MAX_PARTS` parts is `ceil(size / MAX_PARTS)`.
  If that is larger than `MAX_PART`, the file is too big: throw a `RangeError`.
- Part size = the largest of `preferredPartSize`, `MIN_PART` and that minimum, but never more
  than `MAX_PART`.
- Parts are numbered from `1`, contiguous, every part except the last has exactly the part size,
  the last part ends at `size`, and there are never empty parts.

hint: `const needed = Math.ceil(size / MAX_PARTS)`; then `Math.min(MAX_PART, Math.max(preferredPartSize, MIN_PART, needed))`.
hint: Loop `for (let start = 0, n = 1; start < size; start += partSize, n++)` and use `Math.min(start + partSize, size)` for `end`.

```ts setup
const MiB = 1024 * 1024
const GiB = 1024 * MiB
const MIN_PART = 5 * MiB
const MAX_PART = 5 * GiB
const MAX_PARTS = 10_000
type PartRange = { partNumber: number; start: number; end: number }
```

```ts starter
export function planParts(size: number, preferredPartSize: number = 8 * MiB): PartRange[] {
  // your code
  return []
}
```

```ts solution
export function planParts(size: number, preferredPartSize: number = 8 * MiB): PartRange[] {
  if (!Number.isInteger(size) || size <= 0) throw new RangeError('size must be a positive integer')
  const needed = Math.ceil(size / MAX_PARTS)
  if (needed > MAX_PART) throw new RangeError('file too large for a multipart upload')
  const partSize = Math.min(MAX_PART, Math.max(preferredPartSize, MIN_PART, needed))
  const parts: PartRange[] = []
  for (let start = 0, n = 1; start < size; start += partSize, n++) {
    parts.push({ partNumber: n, start, end: Math.min(start + partSize, size) })
  }
  return parts
}
```

```ts tests
test('12 MiB with 5 MiB parts -> 5 + 5 + 2', () => {
  expect(planParts(12 * MiB, 5 * MiB)).toEqual([
    { partNumber: 1, start: 0, end: 5 * MiB },
    { partNumber: 2, start: 5 * MiB, end: 10 * MiB },
    { partNumber: 3, start: 10 * MiB, end: 12 * MiB },
  ])
})
test('preferred size below 5 MiB is raised to the minimum', () => {
  const parts = planParts(12 * MiB, 1 * MiB)
  expect(parts).toHaveLength(3)
  expect(parts[0].end - parts[0].start).toBe(5 * MiB)
})
test('exact multiple: no empty trailing part', () => {
  expect(planParts(10 * MiB, 5 * MiB)).toHaveLength(2)
})
test('a tiny file is one part', () => {
  expect(planParts(3)).toEqual([{ partNumber: 1, start: 0, end: 3 }])
})
test('default preferred size is 8 MiB', () => {
  const parts = planParts(20 * MiB)
  expect(parts.map((p) => p.end - p.start)).toEqual([8 * MiB, 8 * MiB, 4 * MiB])
})
test('100 GiB with 8 MiB preferred grows parts to stay within 10,000', () => {
  const size = 100 * GiB
  const parts = planParts(size, 8 * MiB)
  expect(parts.length).toBeLessThanOrEqual(MAX_PARTS)
  const partSize = parts[0].end - parts[0].start
  // the smallest size that fits: ceil(size / 10,000) = 10,737,419 bytes (≈ 10.24 MiB)
  expect(partSize).toBe(Math.ceil(size / MAX_PARTS))
  parts.forEach((p, i) => {
    expect(p.partNumber).toBe(i + 1)
    if (i > 0) expect(p.start).toBe(parts[i - 1].end)
    if (i < parts.length - 1) expect(p.end - p.start).toBe(partSize)
    expect(p.end).toBeGreaterThan(p.start)
  })
  expect(parts[parts.length - 1].end).toBe(size)
})
test('preferred size above 5 GiB is capped', () => {
  const parts = planParts(12 * GiB, 6 * GiB)
  expect(parts).toHaveLength(3)
  expect(parts[0].end).toBe(5 * GiB)
})
function thrown(f: () => unknown): unknown {
  try { f() } catch (e) { return e }
  return undefined
}
test('exactly 10,000 x 5 GiB still fits', () => {
  const parts = planParts(MAX_PARTS * MAX_PART)
  expect(parts).toHaveLength(MAX_PARTS)
  expect(parts[parts.length - 1].end - parts[parts.length - 1].start).toBe(MAX_PART)
})
test('too large for 10,000 x 5 GiB throws a RangeError', () => {
  expect(thrown(() => planParts(MAX_PARTS * MAX_PART + 1))).toBeInstanceOf(RangeError)
})
test('invalid sizes throw a RangeError', () => {
  expect(thrown(() => planParts(0))).toBeInstanceOf(RangeError)
  expect(thrown(() => planParts(-5))).toBeInstanceOf(RangeError)
  expect(thrown(() => planParts(1.5))).toBeInstanceOf(RangeError)
})
```
:::

:::quiz id=cl-05-q4 xp=15
You want to upload an **80 GiB** video with multipart upload. What is the **smallest** part size
you can use on AWS S3?
- [ ] 5 MiB, the minimum part size
- [x] About 8.2 MiB: `ceil(80 GiB / 10,000)`, because 5 MiB parts would need 16,384 parts
- [ ] 5 GiB, the maximum part size
- [ ] Any size; there is no limit on the number of parts
> 80 GiB ÷ 5 MiB = 16,384 parts, over the 10,000-part limit. So the part size must be at least
> 80 GiB ÷ 10,000 = 8,589,935 bytes (rounded up), about 8.59 MB or 8.2 MiB. "5 MiB" is tempting because it's the documented
> minimum, but the minimum only applies when the part count still fits. Many libraries just pick
> 16–64 MiB parts for big files, which also means fewer requests.
:::

:::quiz id=cl-05-q5 xp=10
The storage bill for your uploads bucket keeps growing, but the sum of all object sizes in
`ListObjectsV2` stays flat. The app uses browser multipart uploads, and users often close the tab
mid-upload. Most likely cause and fix?
- [ ] Versioning is keeping old copies; disable versioning
- [x] Abandoned multipart uploads keep their parts (not listed as objects but billed); add an `AbortIncompleteMultipartUpload` lifecycle rule
- [ ] S3 bills listing requests as storage; cache your listings
- [ ] Presigned URLs reserve the full file size in advance
> Parts of uncompleted uploads are stored and billed but invisible in object listings. A lifecycle
> rule cleans them up automatically. Versioning (the tempting answer) also hides bytes, but only if
> it's enabled, and those noncurrent versions do show up in `ListObjectVersions`. Fix those with a
> `NoncurrentVersionExpiration` rule, not by turning versioning off.
:::

## CORS on the bucket

The browser runs your app on `https://app.example.com` and now sends a `PUT` to
`https://acme-uploads.s3.eu-central-1.amazonaws.com`, a **different origin**. Because the request
has a non-simple method (`PUT`) and header (`Content-Type: image/png`), the browser first sends a
**preflight** `OPTIONS` request **to the bucket**, and only continues if the bucket answers with
matching `Access-Control-Allow-*` headers. Your API's CORS settings are irrelevant here; this is
configured **on the bucket**.

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://app.example.com", "http://localhost:5173"],
      "AllowedMethods": ["PUT", "GET", "HEAD"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3000
    }
  ]
}
```

```bash
aws s3api put-bucket-cors --bucket acme-uploads --cors-configuration file://cors.json
```

* `ExposeHeaders: ["ETag"]` is easy to forget. Without it the upload works but JavaScript can't
  read the `ETag` response header, so **multipart `Complete` breaks** ("ETag is null").
* List exact origins. `"*"` works for public reads, but upload rules should name your app.
* `curl` and Postman ignore CORS entirely. "It works with curl but not in the browser" almost
  always means bucket CORS.

:::warn title="CORS on SeaweedFS"
SeaweedFS's CORS behaviour depends on the version: older releases answered every origin
permissively, while newer ones implement the bucket CORS API (`PutBucketCors`). Don't assume
either. The lab applies a CORS config and then **checks** with a preflight `curl`. If your version
behaves differently, the SeaweedFS wiki page on the S3 API lists what's supported.
:::

:::quiz id=cl-05-q6 xp=10
Uploading with `curl -X PUT --upload-file cat.png "$URL"` works. The same URL from your React app
fails, and the console shows *"blocked by CORS policy: Response to preflight request doesn't pass
access control check"*. Your ASP.NET API has `app.UseCors()` allowing `http://localhost:5173`.
What do you fix?
- [ ] Add `AllowAnyOrigin()` to the API's CORS policy
- [x] Add a CORS rule **on the bucket** that allows the app's origin, `PUT` and the `Content-Type` header
- [ ] Switch the upload from `XMLHttpRequest` to `fetch`, which doesn't need CORS
- [ ] Regenerate the presigned URL with a longer expiry
> The preflight goes to the **storage endpoint**, not your API, so only the bucket's CORS rules
> matter. curl isn't a browser and never sends preflights, which is why it "works". The API's CORS
> (the tempting answer) only governs calls to the API itself, like `POST /uploads`. `fetch` and
> XHR follow the same CORS rules.
:::

## Reading private files: presigned GET or CDN

Keep buckets **private**. Since April 2023, new AWS buckets block public access and disable ACLs
by default, and you should keep it that way. Years of "public bucket leaked millions of
customer records" headlines all have the same root cause: someone flipped a bucket or object to
public to "just make the images load".

| Way to serve | How | Good for |
|---|---|---|
| **Presigned GET** | API checks permission, returns a URL valid for minutes | Invoices, private attachments, low-volume downloads |
| **CDN with origin access** | CloudFront + Origin Access Control (bucket allows only the CDN), optionally CloudFront signed URLs/cookies; R2 behind a Cloudflare domain | Avatars, thumbnails, public product media, high volume |
| **Through the API** | Stream from S3 in a controller | Only when you must transform or audit every byte |

```csharp
var downloadUrl = s3.GetPreSignedURL(new GetPreSignedUrlRequest
{
    BucketName = bucket,
    Key = file.ObjectKey,
    Verb = HttpVerb.GET,
    Expires = DateTime.UtcNow.AddMinutes(5),
    ResponseHeaderOverrides = new ResponseHeaderOverrides
    {
        // force download, no inline HTML. DownloadName must be the sanitized name: a raw client
        // name containing quotes or newlines would break (or inject into) this header.
        ContentDisposition = $"attachment; filename=\"{file.DownloadName}\"",
    },
});
```

:::pro title="Presigned GETs and caching"
Every presigned URL is unique (new date, new signature), so browsers and CDNs can't cache it, and
an `<img>` grid re-downloads thumbnails on every page view. Two common fixes: put public-ish media
behind a CDN with long cache headers and **immutable, versioned keys**; or round the signing time
to a window (for example the start of the current 10 minutes) so the same URL is reused within
that window.
:::

:::quiz id=cl-05-q7 xp=15
A user uploads `invoice.html` with `Content-Type: text/html`. Your app shows attachments with a
presigned GET on `https://app.example.com/files/...` (a reverse proxy to the bucket) and the
browser renders the file inline. Why is this dangerous, and which mitigations apply? (Select all
that apply.)
- [x] It's stored XSS: the HTML runs as your app's origin, so it can call your API with the victim's cookies and read whatever your pages can
- [x] Allow-list upload content types and reject `text/html`, `image/svg+xml` and similar active types
- [x] Serve user content from a separate domain and/or force `Content-Disposition: attachment`
- [ ] It's safe because presigned URLs expire after a few minutes
> Content served from your own origin is trusted by the browser as your code. Defences are
> layered: allow-list types, a separate user-content domain (the reason GitHub serves raw files
> from a different domain), `attachment` disposition, and `X-Content-Type-Options: nosniff`. Short
> expiry (the tempting answer) only limits how long the link works; one victim click is enough.
:::

## Lifecycle rules and storage classes

Not every byte deserves the same storage. **Lifecycle rules** move or delete objects automatically,
by prefix or tag, based on age:

```json
{
  "Rules": [
    { "ID": "abort-incomplete-mpu", "Status": "Enabled", "Filter": { "Prefix": "" },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 2 } },
    { "ID": "expire-tmp", "Status": "Enabled", "Filter": { "Prefix": "tmp/" },
      "Expiration": { "Days": 1 } },
    { "ID": "archive-originals", "Status": "Enabled", "Filter": { "Prefix": "originals/" },
      "Transitions": [
        { "Days": 30, "StorageClass": "STANDARD_IA" },
        { "Days": 180, "StorageClass": "GLACIER_IR" }
      ] }
  ]
}
```

| AWS class | Use for | Watch out |
|---|---|---|
| `STANDARD` | Hot data: thumbnails, recent uploads | Highest storage price |
| `INTELLIGENT_TIERING` | Unknown or changing access patterns | Small monitoring fee per object |
| `STANDARD_IA` / `ONEZONE_IA` | Accessed rarely but needed instantly | Retrieval fee per GB, 30-day minimum, 128 KB minimum billable size |
| `GLACIER_IR` | Archives that still need millisecond reads | 90-day minimum, higher retrieval fee |
| `GLACIER` (Flexible Retrieval) / `DEEP_ARCHIVE` | Compliance archives | Restore takes minutes to hours (Deep Archive: hours); 90/180-day minimums |

The trap is **minimum storage duration and retrieval fees**: moving millions of tiny thumbnails
that are viewed daily to `STANDARD_IA` *raises* the bill. Archive the big, cold originals and keep
the small, hot derivatives in `STANDARD`. Cloudflare R2 offers Standard and Infrequent Access; with
no egress fees the math changes again.

:::warn title="Lifecycle on SeaweedFS"
SeaweedFS's lifecycle support is not a full copy of AWS's: object expiry maps onto its TTL
mechanism, and storage-class transitions and `AbortIncompleteMultipartUpload` may be unsupported
or partial depending on the version. Treat lifecycle rules as something you configure and test
**on your production provider**, and keep a cleanup job (delete `pending` uploads older than a day)
in your app either way.
:::

## Lab: direct uploads to SeaweedFS

:::lab id=cl-05-lab1 xp=120
title: Direct uploads to SeaweedFS with presigned URLs
You'll run SeaweedFS with its S3 gateway in Docker, write an ASP.NET Core 10 API that issues
presigned PUT URLs and verifies uploads, and a React page that uploads straight to the bucket
with a progress bar. Prerequisites: Docker, .NET 10 SDK, Node 22+, `curl`, `jq`.

```text
upload-lab/
├── compose.yaml
├── seaweedfs/
│   ├── s3.json        # access keys for the S3 gateway
│   └── cors.json      # bucket CORS rules
├── api/               # ASP.NET Core 10 minimal API
└── web/               # Vite + React 19 + TS
```

**1. SeaweedFS.** Create `upload-lab/seaweedfs/s3.json`. These are throwaway local dev keys:

```json
{
  "identities": [
    {
      "name": "devquest",
      "credentials": [
        { "accessKey": "devquest", "secretKey": "devquest-local-secret" }
      ],
      "actions": ["Admin", "Read", "List", "Tagging", "Write"]
    }
  ]
}
```

`upload-lab/seaweedfs/cors.json`:

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["http://localhost:5173"],
      "AllowedMethods": ["PUT", "GET", "HEAD"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3000
    }
  ]
}
```

`upload-lab/compose.yaml`:

```yaml
services:
  seaweedfs:
    image: chrislusf/seaweedfs:4.52     # newest release in Nov 2026: check the tags and pin the newest
    command: >
      server -dir=/data -ip.bind=0.0.0.0
      -master.volumeSizeLimitMB=1024 -volume.max=0
      -s3 -s3.port=8333 -s3.config=/etc/seaweedfs/s3.json
    ports:
      - "8333:8333"   # S3 API
      - "8888:8888"   # filer UI: browse /buckets/uploads
      - "9333:9333"   # master UI
    volumes:
      - ./seaweedfs/s3.json:/etc/seaweedfs/s3.json:ro
      - seaweed-data:/data

  create-bucket:
    image: amazon/aws-cli:2.39.4
    depends_on: [seaweedfs]
    environment:
      AWS_ACCESS_KEY_ID: devquest
      AWS_SECRET_ACCESS_KEY: devquest-local-secret
      AWS_DEFAULT_REGION: us-east-1
      AWS_REQUEST_CHECKSUM_CALCULATION: when_required
      AWS_RESPONSE_CHECKSUM_VALIDATION: when_required
    volumes:
      - ./seaweedfs/cors.json:/cors.json:ro
    entrypoint: ["/bin/sh", "-c"]
    command:
      - |
        until aws --endpoint-url http://seaweedfs:8333 s3 ls >/dev/null 2>&1; do echo "waiting for SeaweedFS S3..."; sleep 2; done
        aws --endpoint-url http://seaweedfs:8333 s3 mb s3://uploads || true
        aws --endpoint-url http://seaweedfs:8333 s3api put-bucket-cors --bucket uploads --cors-configuration file:///cors.json || echo "put-bucket-cors failed - see the CORS warning in the lesson"
        echo "bucket ready"

volumes:
  seaweed-data:
```

:::warn title="Check the flags against your SeaweedFS version"
`-volume.max=0` (size the volume count from free disk) and `-master.volumeSizeLimitMB` keep a
dev box from running out of volume slots when you create several buckets. Flag names have been
stable for years, but if the container exits with "flag provided but not defined", compare with
`docker compose run --rm seaweedfs server -h` and the SeaweedFS wiki.
:::

```bash
cd upload-lab
docker compose up -d
docker compose logs -f create-bucket     # Ctrl+C after "bucket ready"
```

Expected (the "waiting" line may repeat a few times):

```text
create-bucket-1  | waiting for SeaweedFS S3...
create-bucket-1  | make_bucket: uploads
create-bucket-1  | bucket ready
```

Check that the bucket answers a CORS preflight for the React origin:

```bash
curl -s -i -X OPTIONS "http://localhost:8333/uploads/probe.txt" \
  -H "Origin: http://localhost:5173" \
  -H "Access-Control-Request-Method: PUT" \
  -H "Access-Control-Request-Headers: content-type" | grep -i '^access-control'
```

You should see `Access-Control-Allow-Origin: http://localhost:5173` (some SeaweedFS versions answer
`*`) and `Access-Control-Allow-Methods` including `PUT`. No `Access-Control-*` lines means the
browser upload in step 4 will fail; fix CORS before continuing.

**2. The API.**

```bash
dotnet new web -n UploadApi -o api
cd api
dotnet add package AWSSDK.S3
```

`api/appsettings.Development.json` (local dev values only; real secrets come from the
environment or a secret store):

```json
{
  "Logging": { "LogLevel": { "Default": "Information" } },
  "S3": {
    "ServiceUrl": "http://localhost:8333",
    "Bucket": "uploads",
    "AccessKey": "devquest",
    "SecretKey": "devquest-local-secret"
  }
}
```

`api/Program.cs` (replace everything):

```csharp
using System.Globalization;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using Amazon.Runtime;
using Amazon.S3;
using Amazon.S3.Model;

var builder = WebApplication.CreateBuilder(args);
var s3cfg = builder.Configuration.GetSection("S3");
var bucket = s3cfg["Bucket"]!;

builder.Services.AddSingleton<IAmazonS3>(_ => new AmazonS3Client(
    new BasicAWSCredentials(s3cfg["AccessKey"], s3cfg["SecretKey"]),
    new AmazonS3Config
    {
        ServiceURL = s3cfg["ServiceUrl"],
        ForcePathStyle = true,
        AuthenticationRegion = "us-east-1",
        // Newer AWS SDKs add CRC checksums to uploads by default; some S3-compatible
        // servers reject them. Only send/validate checksums when an operation requires it.
        RequestChecksumCalculation = RequestChecksumCalculation.WHEN_REQUIRED,
        ResponseChecksumValidation = ResponseChecksumValidation.WHEN_REQUIRED,
    }));

builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.WithOrigins("http://localhost:5173").AllowAnyHeader().AllowAnyMethod()));

var app = builder.Build();
app.UseCors();

const string TenantId = "demo"; // in a real app: from the authenticated user's token (Identity with Keycloak)
const long MaxBytes = 20 * 1024 * 1024;
string[] allowedTypes = ["image/png", "image/jpeg", "image/webp", "application/pdf", "text/plain"];

app.MapPost("/uploads", (UploadRequest req, IAmazonS3 s3) =>
{
    if (!allowedTypes.Contains(req.ContentType))
        return Results.BadRequest(new { error = $"content type '{req.ContentType}' is not allowed" });
    if (req.Size <= 0 || req.Size > MaxBytes)
        return Results.BadRequest(new { error = $"size must be between 1 and {MaxBytes} bytes" });

    var key = ObjectKeys.Build(TenantId, req.FileName, DateTimeOffset.UtcNow);
    var expires = DateTime.UtcNow.AddMinutes(5);
    var url = s3.GetPreSignedURL(new GetPreSignedUrlRequest
    {
        BucketName = bucket,
        Key = key,
        Verb = HttpVerb.PUT,
        Expires = expires,
        ContentType = req.ContentType,
        Protocol = Protocol.HTTP, // local SeaweedFS speaks plain HTTP
    });
    return Results.Ok(new { key, url, expiresAt = expires });
});

app.MapPost("/uploads/complete", async (CompleteRequest req, IAmazonS3 s3) =>
{
    // Never trust a key from the client: it must belong to the caller's tenant.
    if (!req.Key.StartsWith($"tenants/{TenantId}/uploads/", StringComparison.Ordinal) || req.Key.Contains(".."))
        return Results.StatusCode(StatusCodes.Status403Forbidden); // Forbid() needs an auth scheme

    GetObjectMetadataResponse head;
    try
    {
        head = await s3.GetObjectMetadataAsync(bucket, req.Key);
    }
    catch (AmazonS3Exception e) when (e.StatusCode == HttpStatusCode.NotFound)
    {
        return Results.NotFound(new { error = "object not uploaded" });
    }

    var size = head.ContentLength;
    var type = head.Headers.ContentType;
    if (size > MaxBytes || !allowedTypes.Contains(type))
    {
        await s3.DeleteObjectAsync(bucket, req.Key);
        return Results.UnprocessableEntity(new { error = "uploaded object violates the size/type policy and was deleted", size, type });
    }

    // A real app also compares size/type with what the 'pending' files row declared at ticket
    // time, then marks the row 'ready' and enqueues processing (Redis as Queue, Bus and Lock; the boss).
    var viewUrl = s3.GetPreSignedURL(new GetPreSignedUrlRequest
    {
        BucketName = bucket,
        Key = req.Key,
        Verb = HttpVerb.GET,
        Expires = DateTime.UtcNow.AddMinutes(5),
        Protocol = Protocol.HTTP,
    });
    return Results.Ok(new { key = req.Key, size, type, viewUrl });
});

app.Run();

record UploadRequest(string FileName, string ContentType, long Size);
record CompleteRequest(string Key);

static class ObjectKeys
{
    static readonly Regex Disallowed = new("[^a-z0-9._-]+", RegexOptions.Compiled);
    static readonly Regex Dots = new(@"\.{2,}", RegexOptions.Compiled);
    static readonly Regex Dashes = new("-{2,}", RegexOptions.Compiled);

    public static string Build(string tenantId, string fileName, DateTimeOffset now) =>
        $"tenants/{tenantId}/uploads/{now.UtcDateTime:yyyy}/{now.UtcDateTime:MM}/{Guid.CreateVersion7()}/{Sanitize(fileName)}";

    public static string Sanitize(string name)
    {
        var baseName = name.Split('/', '\\').Last();
        var sb = new StringBuilder();
        foreach (var c in baseName.Normalize(NormalizationForm.FormD))
            if (CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark) sb.Append(c);
        var s = Disallowed.Replace(sb.ToString().ToLowerInvariant(), "-");
        s = Dashes.Replace(Dots.Replace(s, "."), "-").Trim('-', '.', '_');
        if (s.Length > 80) s = s[..80].TrimEnd('-', '.', '_');
        return s.Length == 0 ? "file" : s;
    }
}
```

```bash
dotnet run --urls http://localhost:5080
```

In a second terminal, request a ticket and upload with curl:

```bash
echo "hello seaweed" > hello.txt
TICKET=$(curl -s -X POST http://localhost:5080/uploads -H 'Content-Type: application/json' \
  -d '{"fileName":"Hello World.txt","contentType":"text/plain","size":14}')
echo "$TICKET" | jq .
URL=$(echo "$TICKET" | jq -r .url); KEY=$(echo "$TICKET" | jq -r .key)
curl -s -o /dev/null -w '%{http_code}\n' -X PUT --upload-file hello.txt -H 'Content-Type: text/plain' "$URL"
curl -s -X POST http://localhost:5080/uploads/complete -H 'Content-Type: application/json' \
  -d "{\"key\":\"$KEY\"}" | jq .
```

Expected (ids, dates and signatures differ):

```text
{
  "key": "tenants/demo/uploads/2026/11/0199a3e1-…/hello-world.txt",
  "url": "http://localhost:8333/uploads/tenants/demo/uploads/2026/11/0199a3e1-…/hello-world.txt?X-Amz-Expires=300&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=devquest%2F…&X-Amz-Date=…&X-Amz-SignedHeaders=content-type%3Bhost&X-Amz-Signature=…",
  "expiresAt": "2026-11-05T10:20:00Z"
}
200
{
  "key": "tenants/demo/uploads/2026/11/0199a3e1-…/hello-world.txt",
  "size": 14,
  "type": "text/plain",
  "viewUrl": "http://localhost:8333/uploads/tenants/demo/…?X-Amz-…"
}
```

Now break things on purpose, which is the real learning:

```bash
# a) Wrong Content-Type for a URL signed for text/plain → 403 (SignatureDoesNotMatch)
curl -s -o /dev/null -w '%{http_code}\n' -X PUT --upload-file hello.txt -H 'Content-Type: image/png' "$URL"

# b) Lie about the size: get a ticket for 14 bytes, upload 25 MB, then complete → 422 and the object is deleted
head -c 25000000 /dev/urandom > big.txt
T2=$(curl -s -X POST http://localhost:5080/uploads -H 'Content-Type: application/json' -d '{"fileName":"big.txt","contentType":"text/plain","size":14}')
curl -s -o /dev/null -w '%{http_code}\n' -X PUT --upload-file big.txt -H 'Content-Type: text/plain' "$(echo "$T2" | jq -r .url)"
curl -s -i -X POST http://localhost:5080/uploads/complete -H 'Content-Type: application/json' -d "{\"key\":\"$(echo "$T2" | jq -r .key)\"}" | head -1

# c) Disallowed type is refused before any URL is issued → 400
curl -s -X POST http://localhost:5080/uploads -H 'Content-Type: application/json' -d '{"fileName":"x.html","contentType":"text/html","size":10}'

# d) Another tenant's key → 403
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:5080/uploads/complete -H 'Content-Type: application/json' -d '{"key":"tenants/evil/uploads/x"}'
```

:::info title="If (a) returns 200"
Look at `X-Amz-SignedHeaders` in your URL. If it's only `host`, your SDK version didn't sign the
content type, so the store can't enforce it. That's exactly why `/uploads/complete` re-checks
the real type with `HEAD`. Note what you observed in the checklist.
:::

**3. The React page.**

```bash
cd ..                      # back in upload-lab/
npm create vite@latest web -- --template react-ts
cd web
npm install
```

If `create-vite` asks extra questions (newer versions offer to "install and start now"), answer
**No**: you'll install and start it yourself after adding the files below. Leave the API running
in its own terminal; the page needs it.

`web/src/api.ts`:

```ts
import type { UploadFn } from './Uploader'

const API = 'http://localhost:5080'

type Ticket = { key: string; url: string; expiresAt: string }
type Completed = { key: string; size: number; type: string; viewUrl: string }

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

export function putWithProgress(
  url: string,
  body: Blob,
  contentType: string,
  onProgress: (loaded: number, total: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('Content-Type', contentType)
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total) }
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve(xhr.getResponseHeader('ETag') ?? '')
        : reject(new Error(`Storage answered ${xhr.status}`))
    xhr.onerror = () => reject(new Error('Network error (check bucket CORS)'))
    xhr.send(body)
  })
}

export async function uploadFile(file: File, onProgress: (loaded: number, total: number) => void): Promise<Completed> {
  const contentType = file.type || 'application/octet-stream'
  const ticket = await postJson<Ticket>('/uploads', { fileName: file.name, contentType, size: file.size })
  await putWithProgress(ticket.url, file, contentType, onProgress)
  return postJson<Completed>('/uploads/complete', { key: ticket.key })
}

export const upload: UploadFn = (file, onProgress) => uploadFile(file, onProgress)
```

`web/src/Uploader.tsx`: your component from the challenge above. If you skipped it, use this
reference:

```tsx
import { useReducer, useState } from 'react'

export type UploadFn = (file: File, onProgress: (loaded: number, total: number) => void) => Promise<{ key: string }>

type UploadState =
  | { status: 'idle' }
  | { status: 'uploading'; percent: number }
  | { status: 'done'; key: string }
  | { status: 'error'; message: string }

type UploadAction =
  | { type: 'reset' }
  | { type: 'start' }
  | { type: 'progress'; percent: number }
  | { type: 'success'; key: string }
  | { type: 'failure'; message: string }

function uploadReducer(state: UploadState, action: UploadAction): UploadState {
  const uploading = state.status === 'uploading'
  switch (action.type) {
    case 'reset': return uploading ? state : { status: 'idle' }
    case 'start': return uploading ? state : { status: 'uploading', percent: 0 }
    case 'progress': return uploading ? { status: 'uploading', percent: action.percent } : state
    case 'success': return uploading ? { status: 'done', key: action.key } : state
    case 'failure': return uploading ? { status: 'error', message: action.message } : state
  }
}

export function Uploader({ upload }: { upload: UploadFn }) {
  const [file, setFile] = useState<File | null>(null)
  const [state, dispatch] = useReducer(uploadReducer, { status: 'idle' })
  const busy = state.status === 'uploading'

  async function start() {
    if (!file) return
    dispatch({ type: 'start' })
    try {
      const { key } = await upload(file, (loaded, total) =>
        dispatch({ type: 'progress', percent: total > 0 ? Math.round((loaded / total) * 100) : 0 }))
      dispatch({ type: 'success', key })
    } catch (e) {
      dispatch({ type: 'failure', message: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <div>
      <label htmlFor="file">Choose file</label>
      <input id="file" type="file" disabled={busy}
        onChange={(e) => { setFile(e.target.files?.[0] ?? null); dispatch({ type: 'reset' }) }} />
      <button type="button" disabled={!file || busy} onClick={start}>Upload</button>
      {state.status === 'uploading' && (
        <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={state.percent}>
          Uploading {state.percent}%
          <progress max={100} value={state.percent} style={{ display: 'block', width: 320 }} />
        </div>
      )}
      {state.status === 'done' && <p role="status">Uploaded {state.key}</p>}
      {state.status === 'error' && (
        <div role="alert">
          <p>Upload failed: {state.message}</p>
          <button type="button" onClick={start}>Retry</button>
        </div>
      )}
    </div>
  )
}
```

`web/src/App.tsx` (replace everything):

```tsx
import { useState } from 'react'
import { Uploader, type UploadFn } from './Uploader'
import { uploadFile } from './api'

export default function App() {
  const [viewUrl, setViewUrl] = useState<string | null>(null)

  const upload: UploadFn = async (file, onProgress) => {
    setViewUrl(null)
    const done = await uploadFile(file, onProgress)
    setViewUrl(done.viewUrl)
    return done
  }

  return (
    <main style={{ fontFamily: 'system-ui', padding: 32 }}>
      <h1>Direct upload to SeaweedFS</h1>
      <Uploader upload={upload} />
      {viewUrl && <p><a href={viewUrl} target="_blank" rel="noreferrer">Open the uploaded file (link valid 5 min)</a></p>}
    </main>
  )
}
```

```bash
npm run dev      # http://localhost:5173
```

Upload a PNG of a few MB. To *see* the progress bar move, open DevTools → Network → throttling
**Slow 4G**. In the Network tab you should see three real requests per upload: `POST /uploads`
(API), `PUT` to `localhost:8333` (the bytes), and `POST /uploads/complete` (API). Each of them is
cross-origin from `localhost:5173` and non-simple (JSON body, or a `PUT`), so Chrome also lists an
`OPTIONS` **preflight** before each one: the API's preflights are answered by `app.UseCors()`, the
`PUT`'s by the bucket's CORS rules. The file bytes never touched your API.

Finally, list the bucket:

```bash
cd ..
docker compose run --rm create-bucket "aws --endpoint-url http://seaweedfs:8333 s3 ls s3://uploads --recursive"
```

```text
2026-11-05 10:15:02         14 tenants/demo/uploads/2026/11/0199a3e1-…/hello-world.txt
2026-11-05 10:21:40    2483120 tenants/demo/uploads/2026/11/0199a3f7-…/cat-photo.png
```

You can also browse `http://localhost:8888/buckets/uploads/` in the filer UI. Clean up with
`docker compose down -v`.

- [ ] `docker compose up -d` starts SeaweedFS and the `create-bucket` log ends with `bucket ready`
- [ ] The preflight `curl` returns `Access-Control-Allow-Origin` for `http://localhost:5173`
- [ ] curl: ticket → `PUT` returns `200` → `/uploads/complete` returns size `14` and type `text/plain`
- [ ] Wrong `Content-Type` on the presigned URL returns `403` (or I noted that my URL only signs `host`)
- [ ] The lying-size upload is answered with `422` by `/uploads/complete` and the object is gone from the bucket listing
- [ ] `text/html` is refused with `400` and another tenant's key with `403`
- [ ] The React page shows the progress bar moving under throttling, then `Uploaded tenants/demo/…`, and the view link opens the file
- [ ] DevTools shows the `PUT` going to `localhost:8333`, not to the API
:::

## Flashcards

:::cards id=cl-05-cards1 xp=15 title="Object storage & direct uploads"
Q: Why not store uploads on the API's local disk in Kubernetes?
A: Replicas don't share disks, pods are ephemeral, and backups/scaling get painful. Use object storage for bytes and Postgres for metadata.
Q: Is `tenants/42/` a folder in S3?
A: No. It's a key prefix. Listing with `prefix` + `delimiter=/` simulates folders; renaming means copy + delete per object.
Q: What does a presigned URL lock down?
A: Method, bucket + key, expiry and any signed headers (e.g. Content-Type). Not the body size for a plain PUT.
Q: How long can a presigned URL live?
A: Up to 7 days with SigV4, but never longer than the credentials that signed it (IAM role / STS often hours). Use minutes for uploads.
Q: Multipart limits on AWS S3?
A: Parts 5 MiB to 5 GiB (the last part may be smaller), at most 10,000 parts. Part size ≥ ceil(size / 10,000).
Q: Why must bucket CORS expose `ETag`?
A: Multipart Complete needs each part's ETag, and JavaScript can only read response headers the CORS config exposes.
Q: The upload works with curl but fails in the browser. First suspect?
A: Bucket CORS (the preflight goes to the storage endpoint, not your API).
Q: Why use XMLHttpRequest instead of fetch for uploads?
A: `xhr.upload.onprogress` gives upload progress; fetch has no upload progress events in browsers.
Q: How do you stop abandoned multipart uploads from costing money?
A: A lifecycle rule with `AbortIncompleteMultipartUpload` (e.g. after 1–7 days).
Q: How do you serve a user's uploaded HTML/SVG safely?
A: Don't serve it inline from your origin: allow-list types, use a separate user-content domain, `Content-Disposition: attachment`, `nosniff`.
Q: Which local S3 does this course use, and why not MinIO?
A: SeaweedFS (`weed server -s3`); MinIO's community edition is no longer maintained.
:::

## Recap

- **Bytes in object storage, metadata in Postgres.** Object storage is a flat, strongly consistent
  key → bytes map: prefixes aren't folders, objects are immutable, and there's no locking (use
  unique keys or conditional writes).
- Any **S3-compatible** store works with the same SDK code: AWS S3, Cloudflare R2, and
  **SeaweedFS** locally (`weed server -s3` with an S3 config JSON). No MinIO: its community edition
  is unmaintained.
- **Don't proxy uploads.** The API validates intent and returns a short-lived **presigned PUT**
  (`GetPreSignedURL` in AWSSDK.S3); the browser uploads directly; a **complete** call verifies the
  real size/type with `HEAD`.
- Presigned URLs lock method, key, expiry and signed headers, **not size**. Use POST policies
  where supported and always re-verify.
- Browser progress = `XMLHttpRequest` `upload.onprogress`; model the UI as a **state machine**
  that ignores events that don't fit the current state.
- **Multipart** for big files: 5 MiB minimum parts, 10,000 parts maximum, parallel and resumable.
  Always add an **AbortIncompleteMultipartUpload** lifecycle rule.
- **Bucket CORS** (not API CORS) allows the browser's `PUT`; expose `ETag`.
- Keep buckets **private**: presigned GET for private files, a CDN with origin access for
  high-volume media. **Lifecycle rules** expire temp data and move cold originals to cheaper
  classes (watch minimum durations and retrieval fees).
- **Never trust the client**: the server builds keys (tenant prefix + UUID + sanitized name),
  allow-lists content types, and serves user content so it can't run as your app.
- The same code runs against **Amazon S3** by removing the endpoint override. On **Azure Blob
  Storage** the ideas map one to one (container = bucket, blob = object, a user-delegation **SAS**
  = presigned URL, block blobs = multipart) with a different SDK. Both prefer workload identity
  over access keys; see **The Managed Equivalents: Azure & AWS**.
