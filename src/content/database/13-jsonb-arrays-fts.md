---
id: db-13
title: jsonb, Arrays & Full-Text Search
level: advanced
minutes: 85
xp: 200
summary: Store and query documents with jsonb, index them with GIN, shape API responses in SQL, use arrays and unnest, add real search with tsvector, and know when pg_trgm and pgvector take over — plus when NOT to reach for jsonb.
---

Relational tables are the backbone of most apps, but real products always have a few things that
don't fit neat columns: an editor document, user preferences, a webhook payload from Stripe, a
list of tags. PostgreSQL handles these unusually well. Its **`jsonb`** type gives you a document
store *inside* your relational database — with indexes, operators and transactions — and its
**arrays** and **full-text search** cover tags and search boxes without bolting on another system.

This lesson uses the **studio** dataset: a branching-video SaaS where every project has a `doc`
column holding the editor's settings as `jsonb`:

| id | title | doc |
|---|---|---|
| 1 | The Heist | `{"aspect":"16:9","fps":30,"tags":["thriller","interactive"],"settings":{"autoplay":true}}` |
| 2 | Onboarding Tour | `{"aspect":"9:16","fps":30,"tags":["product"],"settings":{"autoplay":false}}` |
| 3 | Choose Your Coffee | `{"aspect":"1:1","fps":25,"tags":["ad","food"],"settings":{"autoplay":true}}` |
| 4 | My First Story | `{"aspect":"16:9","fps":24,"tags":[]}` |
| 5 | Escape Room Teaser | `{"aspect":"16:9","fps":60,"tags":["game","thriller"],"settings":{"autoplay":true}}` |
| 6 | Safety Training 2025 | `{"aspect":"16:9","fps":30,"tags":["training"],"settings":{"autoplay":false}}` |

Notice project 4: it has **no `settings` key at all**. Documents drift like that in real life —
old rows were written by an older version of the app. Handling "missing" correctly is half the
skill of working with jsonb.

## json vs jsonb

Postgres has two JSON types:

| | `json` | `jsonb` |
|---|---|---|
| Storage | the original text, verbatim | a parsed binary format |
| Whitespace / key order / duplicate keys | preserved | normalized (keys sorted, last duplicate wins) |
| Insert speed | slightly faster (no parsing) | slightly slower |
| Query speed | re-parses on every access | fast — already parsed |
| Indexable with GIN | no | **yes** |
| Containment `@>`, existence `?` | no | **yes** |

Use **`jsonb`** for practically everything. `json` only makes sense when you must keep the
exact original text (for example, to verify a webhook signature over the raw body).

## Reading values: `->`, `->>`, `#>`, `#>>`

The operators differ in **what type they return** — the single most common source of jsonb bugs.

| Expression | Returns | Result for project 1 |
|---|---|---|
| `doc -> 'fps'` | `jsonb` | `30` (a JSON number) |
| `doc ->> 'fps'` | `text` | `'30'` |
| `doc -> 'settings' -> 'autoplay'` | `jsonb` | `true` |
| `doc #> '{settings,autoplay}'` | `jsonb` (by path) | `true` |
| `doc #>> '{settings,autoplay}'` | `text` (by path) | `'true'` |
| `doc -> 'tags' -> 0` | `jsonb` (array index, 0-based) | `"thriller"` |
| `doc['settings']['autoplay']` | `jsonb` (subscript syntax, PG 14+) | `true` |

Rule of thumb: use **`->` to navigate**, and **`->>` at the very end** when you want a plain value
to compare, display or cast:

```sql
SELECT id,
       title,
       doc ->> 'aspect'              AS aspect,     -- text
       (doc ->> 'fps')::int          AS fps,        -- text → integer
       doc #>> '{settings,autoplay}' AS autoplay    -- text 'true' / 'false' / NULL
FROM projects
ORDER BY id;
```

A missing key never raises an error — it just returns `NULL`. Project 4 gets `NULL` for
`autoplay`. That's convenient, but it also means a typo (`doc->>'fsp'`) silently returns `NULL`
instead of failing. Columns would have caught that.

:::warn title="Comparing jsonb to a number"
Three ways to write "fps above 30", and only one is a good habit:

- `WHERE doc -> 'fps' > 30` — **error**: `operator does not exist: jsonb > integer`. There is no
  automatic cast from `integer` to `jsonb`.
- `WHERE doc ->> 'fps' > '30'` — runs, but compares **text**, character by character: `'100' > '30'`
  is *false* because `'1'` sorts before `'3'`. A silent wrong answer.
- `WHERE (doc ->> 'fps')::int > 30` — extract as text, cast, compare numbers. **Do this.**

(`doc -> 'fps' > '30'` also works — the quoted literal is parsed as jsonb and jsonb numbers compare
numerically — but it's easy to misread in a review, and it can't use an index on
`((doc ->> 'fps')::int)`.)
:::

:::quiz id=db-13-q1 xp=10
What does `SELECT pg_typeof(doc -> 'aspect') FROM projects WHERE id = 1` return?
- [x] `jsonb`
- [ ] `text`
- [ ] `json`
- [ ] It raises an error because `aspect` is a string
> `->` always returns `jsonb` (here the JSON string `"16:9"`, quotes included), whatever kind of
> JSON value sits at that key — a string inside a document is still a jsonb value. `->>` would
> return `text` (`16:9`, no quotes). It isn't `json` either: the operators return the type of the
> column they're applied to, and `doc` is `jsonb`.
:::

:::sql id=db-13-sql1 db=studio ordered=true xp=35
title: Read the editor settings
The video player team wants every project rendered at **30 fps or more**. Return `id`, `title`,
`aspect` (as text) and `fps` (as an integer) for those projects, highest fps first, then by `id`.

hint: `doc ->> 'fps'` is text — cast it with `::int` before comparing.
hint: `ORDER BY fps DESC, id`

```sql starter
SELECT id, title, doc -> 'aspect', doc -> 'fps'
FROM projects;
```

```sql solution
SELECT id, title, doc ->> 'aspect' AS aspect, (doc ->> 'fps')::int AS fps
FROM projects
WHERE (doc ->> 'fps')::int >= 30
ORDER BY fps DESC, id;
```
:::

## Asking questions: containment `@>` and existence `?`

Extracting values works, but jsonb's real superpower is asking *"does this document contain …?"*

| Operator | Meaning | Example (true for project 1) |
|---|---|---|
| `@>` | left contains the right document | `doc @> '{"tags":["thriller"]}'` |
| `<@` | left is contained in right | `'{"fps":30}' <@ doc` |
| `?` | top-level key (or array element string) exists | `doc ? 'settings'` |
| `?|` | any of these keys exist | `doc ?| array['settings','theme']` |
| `?&` | all of these keys exist | `doc ?& array['aspect','fps']` |

Containment is structural: `doc @> '{"settings":{"autoplay":true}}'` matches any document whose
`settings` object has `autoplay: true`, no matter what else is in there. For arrays, `@>` means
"contains these elements, in any order": `'["a","b","c"]' @> '["c","a"]'` is true.

```sql
-- all thriller projects (1 and 5)
SELECT id, title FROM projects WHERE doc @> '{"tags": ["thriller"]}';

-- projects whose doc has a settings object at all
SELECT id FROM projects WHERE doc ? 'settings';

-- the tags array contains the string "food"
SELECT id FROM projects WHERE doc -> 'tags' ? 'food';
```

Why prefer `@>` over `doc ->> 'x' = 'y'`? Because **one GIN index on `doc` can answer `@>`**
(and, with the default operator class, `?`, `?|` and `?&`) directly, for any key, without you
knowing the keys in advance. The `->>` version needs a dedicated expression index per key. The
GIN section below has the details.

:::tip title="`?` and driver placeholders"
Some client libraries (JDBC, PHP PDO, some ODBC drivers) treat `?` as a parameter placeholder, so
`doc ? 'settings'` breaks there. Npgsql and Node's `pg` use `@name` / `$1` and are fine. Where it
bites, use the driver's escape (`??` in JDBC) or the function behind the operator,
`jsonb_exists(doc, 'settings')`.
:::

For more complex predicates there is also **SQL/JSON path** (`@?`, `@@`,
`jsonb_path_query`): `doc @? '$.tags[*] ? (@ == "thriller")'`. It's powerful, but `@>` covers
most day-to-day needs and is easier to read in a code review.

:::sql id=db-13-sql2 db=studio xp=50
title: Autoplay is off — or missing
Support is getting tickets: "my video doesn't start by itself". Find every project where
autoplay is **not explicitly turned on**. A project with no `settings` (or no `autoplay` key)
counts as *off*. Return `id` and `title`.

hint: `doc #>> '{settings,autoplay}' = 'false'` misses project 4, whose doc has no settings at all.
hint: Flip it around: `NOT (doc @> '{"settings":{"autoplay":true}}')`.

```sql starter
SELECT id, title
FROM projects
WHERE doc #>> '{settings,autoplay}' = 'false';
```

```sql solution
SELECT id, title
FROM projects
WHERE NOT (doc @> '{"settings": {"autoplay": true}}');
```
:::

## Turning documents into rows

Arrays inside documents are often what you want to **group by** — "how many projects use each
tag?". Set-returning functions expand a JSON array into rows:

| Function | Produces |
|---|---|
| `jsonb_array_elements(arr)` | one `jsonb` row per element |
| `jsonb_array_elements_text(arr)` | one `text` row per element |
| `jsonb_each(obj)` / `jsonb_each_text(obj)` | one `(key, value)` row per key |
| `jsonb_object_keys(obj)` | one row per key |
| `jsonb_to_recordset(arr)` | rows with typed columns: `AS x(id int, name text)` |

Put them in the `FROM` clause next to the table. A function in `FROM` that references an earlier
table is implicitly **LATERAL** — it runs once per row of `projects`:

```sql
SELECT p.id, t.tag
FROM projects p
CROSS JOIN LATERAL jsonb_array_elements_text(p.doc -> 'tags') AS t(tag)
ORDER BY p.id, t.tag;
```

| id | tag |
|---|---|
| 1 | interactive |
| 1 | thriller |
| 2 | product |
| … | … |

Project 4 (empty `tags` array) produces no rows and disappears — exactly like an inner join. If
you need to keep it, use `LEFT JOIN LATERAL … ON true`.

`jsonb_to_recordset` is the go-to tool when an API sends you an array of objects and you want to
insert them in one statement:

```sql
INSERT INTO clips (id, project_id, parent_clip_id, title, choice_label, duration_ms)
SELECT * FROM jsonb_to_recordset($1::jsonb)
  AS x(id int, project_id int, parent_clip_id int, title text, choice_label text, duration_ms int);
```

:::sql id=db-13-sql3 db=studio ordered=true xp=40
title: Tag cloud
Marketing wants a tag cloud. Return `tag` and `projects` (how many projects use that tag), most
used first, ties broken alphabetically by tag.

hint: Expand `doc -> 'tags'` with `jsonb_array_elements_text` in the `FROM` clause.
hint: `GROUP BY tag ORDER BY projects DESC, tag`

```sql starter
SELECT doc -> 'tags' AS tag, count(*) AS projects
FROM projects
GROUP BY doc -> 'tags';
```

```sql solution
SELECT t.tag, count(*) AS projects
FROM projects p
CROSS JOIN LATERAL jsonb_array_elements_text(p.doc -> 'tags') AS t(tag)
GROUP BY t.tag
ORDER BY projects DESC, t.tag;
```
:::

## Changing documents: `jsonb_set`, `||`, `-`, `#-`

jsonb values are immutable — you never edit "inside" a document, you compute a **new** document and
write it back with `UPDATE`:

| Expression | Effect |
|---|---|
| `jsonb_set(doc, '{settings,autoplay}', 'false')` | replace the value at a path |
| `jsonb_set(doc, '{settings,loop}', 'true', true)` | create the key if missing (4th arg, default true) — **but only if the parent exists** |
| `doc \|\| '{"fps": 60}'` | shallow merge: top-level keys on the right win |
| `doc - 'tags'` | remove a top-level key |
| `doc #- '{settings,autoplay}'` | remove at a path |
| `jsonb_insert(doc, '{tags,0}', '"new"')` | insert into an array |

The `jsonb_set` trap: on project 4 (no `settings` object),
`jsonb_set(doc, '{settings,autoplay}', 'false')` returns the document **unchanged** — it won't
create intermediate objects. Either set the whole parent (`jsonb_set(doc, '{settings}', '{"autoplay":false}')`)
or merge (`doc || '{"settings": {...}}'`). And beware: `||` is **shallow** — merging
`{"settings":{"loop":true}}` *replaces* the whole `settings` object, dropping `autoplay`.

Also note the third argument is **jsonb**, not text: `'false'` is the JSON boolean, `'"false"'`
is the JSON string. For a value coming from your app, convert it with `to_jsonb($1::text)` (or
`::int`, `::boolean` — the parameter needs a type).

:::warn title="The NULL that wipes a document"
`jsonb_set` is *strict*: if **any** argument is SQL `NULL`, the result is `NULL` — not "the doc
unchanged". So `UPDATE projects SET doc = jsonb_set(doc, '{title}', to_jsonb($1::text))` with a
`null` coming from the client sets the whole `doc` to `NULL` (or fails on `NOT NULL`, which is the
lucky case). Guard with `coalesce(to_jsonb($1::text), 'null'::jsonb)` to store JSON `null`, or use
`jsonb_set_lax(doc, path, value, true, 'use_json_null')` (PG 13+), whose last argument chooses what
a SQL `NULL` means (`'raise_exception'`, `'use_json_null'`, `'delete_key'`, `'return_target'`).
:::

```sql
-- set a nested key safely even when the parent is missing
UPDATE projects
SET doc = jsonb_set(doc, '{settings}',
                    coalesce(doc -> 'settings', '{}') || '{"autoplay": false}')
WHERE id = 4;
```

Read it inside-out: take the existing `settings` object (or `{}` if there is none), merge the new
key into **that** object (so `||` is shallow at exactly the right level), then put the result back
at `{settings}` — a one-level path whose parent (the document itself) always exists.

:::quiz id=db-13-q4 xp=15
Project 1's doc has `"settings": {"autoplay": true}`. What is `settings` after this statement?

```sql
UPDATE projects SET doc = doc || '{"settings": {"loop": true}}' WHERE id = 1;
```

- [ ] `{"autoplay": true, "loop": true}`
- [x] `{"loop": true}`
- [ ] `{"autoplay": true}` — `||` never overwrites existing keys
- [ ] The statement fails because `settings` already exists
> `||` merges only the **top level**: the right side's `settings` key replaces the left side's
> `settings` value wholesale, so `autoplay` is gone. The deep merge you probably wanted is
> `jsonb_set(doc, '{settings}', (doc -> 'settings') || '{"loop": true}')` — merge inside the nested
> object, then put it back. On key collisions the **right** operand always wins.
:::

:::pro title="Whole-document saves and optimistic concurrency"
An editor like the studio's usually saves the **whole** `doc` at once. Two tabs saving at the
same time would overwrite each other ("last write wins"). That's what the `version` column is
for: `UPDATE projects SET doc = $1, version = version + 1 WHERE id = $2 AND version = $3 RETURNING version`.
Zero rows updated ⇒ someone else saved first ⇒ the API answers **409 Conflict** and the client
reloads. Partial updates with `jsonb_set` are smaller and conflict less, but you still need the
version check if the change depends on what the user saw.
:::

:::sql id=db-13-sql4 db=studio xp=60
title: Patch a document that has no settings
Project 4 ("My First Story", currently `version` 1) has no `settings` object. The client sends a
patch: *set `settings.autoplay` to `false`*. Write the `UPDATE` so that:

- `doc` keeps all its existing keys and gains `"settings": {"autoplay": false}`,
- it only applies if the row is still at `version = 1` (optimistic concurrency),
- `version` goes up by one.

We check `id`, `doc` and `version` of every project afterwards.

hint: `jsonb_set(doc, '{settings,autoplay}', 'false')` does nothing when `settings` is missing — try it!
hint: Build the parent: `jsonb_set(doc, '{settings}', coalesce(doc -> 'settings', '{}') || '{"autoplay": false}')`

```sql starter
UPDATE projects
SET doc = jsonb_set(doc, '{settings,autoplay}', 'false')
WHERE id = 4;
```

```sql solution
UPDATE projects
SET doc = jsonb_set(doc, '{settings}', coalesce(doc -> 'settings', '{}'::jsonb) || '{"autoplay": false}'),
    version = version + 1
WHERE id = 4 AND version = 1;
```

```sql check
SELECT id, doc, version FROM projects ORDER BY id;
```
:::

## Building API-shaped JSON in SQL

The reverse direction is just as useful. A typical `GET /projects/3` returns a nested object: the
project plus its clips. The ORM way is two queries (or N+1). Postgres can build the whole JSON
response in **one query**:

| Function | Builds |
|---|---|
| `jsonb_build_object('k1', v1, 'k2', v2, …)` | an object from key/value pairs |
| `jsonb_build_array(a, b, …)` | an array |
| `jsonb_agg(expr ORDER BY …)` | an aggregate: one array from many rows |
| `jsonb_object_agg(key, value)` | an aggregate: one object from many rows |
| `to_jsonb(row)` | a whole row as an object (`to_jsonb(c)` for table alias `c`) |
| `row_to_json`, `json_agg` | the `json` (text) equivalents |

```sql
SELECT jsonb_build_object(
         'id',    p.id,
         'title', p.title,
         'clips', coalesce(
            (SELECT jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title) ORDER BY c.id)
             FROM clips c WHERE c.project_id = p.id),
            '[]'::jsonb)
       ) AS body
FROM projects p
WHERE p.id = 3;
```

```json
{"id": 3, "title": "Choose Your Coffee",
 "clips": [{"id": 8, "title": "Welcome"}, {"id": 9, "title": "Espresso"},
           {"id": 10, "title": "Latte"}, {"id": 11, "title": "Oat milk"}]}
```

Two details matter:

1. **`ORDER BY` inside the aggregate.** Without it, array order is whatever the executor
   produced — which can change when the plan changes. Clients (and tests) will notice.
2. **`coalesce(…, '[]')`.** An aggregate over zero rows returns `NULL`, not `[]`. Your
   TypeScript client expects `clips: []`, not `clips: null`.

:::job title="Where this shows up at work"
You'll see `jsonb_agg` in reporting endpoints, in `.FromSql()` / Dapper queries where the ORM
would produce N+1 queries, and in Postgres-backed APIs like PostgREST or Supabase. With the Npgsql
provider, EF Core 10 can also map a `jsonb` column to a C# type (a complex or owned type configured
with `.ToJson()`) and translate LINQ queries on its properties into `->>` / `@>` operators — turn
on SQL logging and read the generated SQL at least once so you know what's running.
:::

:::sql id=db-13-sql5 db=studio ordered=true xp=70
title: The project-list endpoint
Build the payload for Mara's (`owner_id = 1`) project list in one query. Return one row per
project with two columns, ordered by `id`:

1. `id`
2. `body` — a jsonb object with keys `title` (text), `aspect` (the text from `doc`),
   `clipCount` (number of clips) and `clips` (an array of clip **titles** ordered by clip `id`;
   `[]` when the project has no clips).

hint: A correlated subquery per key works: `(SELECT count(*) FROM clips c WHERE c.project_id = p.id)`
hint: `coalesce((SELECT jsonb_agg(c.title ORDER BY c.id) FROM clips c WHERE …), '[]'::jsonb)`

```sql starter
SELECT p.id,
       jsonb_build_object('title', p.title, 'clips', jsonb_agg(c.title)) AS body
FROM projects p
JOIN clips c ON c.project_id = p.id
WHERE p.owner_id = 1
GROUP BY p.id;
```

```sql solution
SELECT p.id,
       jsonb_build_object(
         'title',     p.title,
         'aspect',    p.doc ->> 'aspect',
         'clipCount', (SELECT count(*) FROM clips c WHERE c.project_id = p.id),
         'clips',     coalesce((SELECT jsonb_agg(c.title ORDER BY c.id)
                                FROM clips c WHERE c.project_id = p.id), '[]'::jsonb)
       ) AS body
FROM projects p
WHERE p.owner_id = 1
ORDER BY p.id;
```
:::

## Postgres arrays

Before jsonb existed, Postgres already had real **array** types: `integer[]`, `text[]`,
`uuid[]`. They're typed (every element is the same type), compact, and great for small lists
of scalar values: tags, role names, a list of ids.

```sql
CREATE TABLE posts (id int PRIMARY KEY, title text, tags text[] NOT NULL DEFAULT '{}');
INSERT INTO posts VALUES (1, 'Hello', ARRAY['intro', 'news']), (2, 'Release', '{news,release}');

SELECT * FROM posts WHERE 'news' = ANY (tags);        -- element match
SELECT * FROM posts WHERE tags @> ARRAY['news'];      -- contains (GIN-indexable)
SELECT * FROM posts WHERE tags && ARRAY['intro','x']; -- overlaps: any in common
SELECT id, unnest(tags) AS tag FROM posts;            -- one row per element
SELECT tags[1] FROM posts;                            -- 1-based indexing!
```

| Function / operator | Purpose |
|---|---|
| `array_agg(x ORDER BY …)` | aggregate rows into an array |
| `unnest(arr)` | expand an array into rows (`WITH ORDINALITY` adds the position) |
| `= ANY(arr)` | "is in the array" — also how drivers pass lists: `WHERE id = ANY($1)` |
| `@>`, `<@`, `&&` | contains, contained by, overlaps |
| `array_length(arr, 1)`, `cardinality(arr)` | size — careful: `array_length('{}'::text[], 1)` is `NULL`, `cardinality('{}'::text[])` is `0` |
| `array_append`, `array_remove`, `\|\|` | build new arrays |

:::tip title="`WHERE id = ANY($1)` beats building `IN (…)` strings"
From C# (Npgsql) or Node (`pg`) you can pass an `int[]` / `number[]` as **one parameter**:
`WHERE id = ANY(@ids)`. One prepared statement for every list length, no string concatenation,
no SQL injection.
:::

:::quiz id=db-13-q5 xp=10
A developer coming from C# writes `SELECT tags[0] FROM posts` to get each post's first tag. What
comes back for post 1 (`ARRAY['intro', 'news']`)?

- [ ] `'intro'`
- [ ] `'news'`
- [x] `NULL`
- [ ] An "index out of range" error
> SQL arrays are **1-based**: the first element is `tags[1]`. Postgres doesn't raise an error for
> an index outside the array — it returns `NULL`, which makes this bug quiet. (Don't confuse it
> with jsonb, where `doc -> 'tags' -> 0` *is* 0-based, because it follows JSON/JavaScript
> conventions.)
:::

Arrays vs jsonb arrays: use `text[]` when the list is simple and typed (tags), jsonb when the
elements are objects or the shape varies. Use a **child table** when the elements have their
own attributes, need foreign keys, or are queried independently ("all clips with label X").

:::sql id=db-13-sql6 db=studio ordered=true xp=40
title: Choices per branch point
The editor's minimap needs, for every clip that **has children**, the titles of its children.
Return `parent_clip_id` and `children` — a `text[]` of child titles ordered by child `id` — one row
per parent, ordered by `parent_clip_id`.

hint: `array_agg(title ORDER BY id)` grouped by `parent_clip_id`.
hint: Root clips have `parent_clip_id IS NULL` — they are not children of anything.

```sql starter
SELECT parent_clip_id, array_agg(title) AS children
FROM clips
GROUP BY parent_clip_id;
```

```sql solution
SELECT parent_clip_id, array_agg(title ORDER BY id) AS children
FROM clips
WHERE parent_clip_id IS NOT NULL
GROUP BY parent_clip_id
ORDER BY parent_clip_id;
```
:::

## When jsonb, when columns?

jsonb is not a license to skip modeling. A useful decision table:

| Use **columns** when… | Use **jsonb** when… |
|---|---|
| you filter, join, sort or aggregate on it often | the app reads/writes it as one blob (editor doc, preferences) |
| it needs `NOT NULL`, `CHECK`, `UNIQUE`, `REFERENCES` | the shape varies per row or per customer (custom fields) |
| several services rely on its meaning | you store external payloads verbatim (webhooks, audit snapshots) |
| it's money, a status, a foreign key | the schema evolves faster than migrations would be pleasant |

The classic anti-pattern is the "everything" column: `data jsonb` holding the email, the
status and the `owner_id`. You lose type safety, constraints and good statistics (the planner
estimates jsonb predicates poorly), and every query becomes `->>` soup. A healthy middle ground —
and what the studio does — is **columns for what the database must enforce or query, jsonb for
the document the app owns**. You can always **promote** a hot key to a real column later
(next to its generated-column cousin in the Views, Functions & Triggers lesson).

:::quiz id=db-13-q2 xp=15
Which of these belong in **real columns** rather than inside `projects.doc`? (Select all that apply.)
- [x] `owner_id` — every permission check filters by it and it must reference `users`
- [ ] The editor's timeline zoom level, only ever read back by the editor
- [x] `published` — the public gallery lists published projects and counts them
- [ ] A customer's custom metadata fields, different for every customer
> Anything you join on, constrain, or filter in hot queries wants a column with a type and
> constraints — a jsonb key can't have a `REFERENCES` constraint, and the planner's estimates for
> `doc ->> 'published' = 'true'` are guesses. App-owned UI state and per-customer custom fields are
> a natural fit for jsonb: custom fields *look* like they need columns, but a column per customer
> field means a migration every time a customer adds one.
:::

## Indexing jsonb and arrays: GIN

A B-tree index sorts values, one per row. It can't answer "which documents *contain*
`{"tags":["thriller"]}`?", because one document holds many values. A **GIN** (Generalized
Inverted iNdex) is built for exactly that. Like the index at the back of a book, it is an
**inverted index**: it maps each element (a key/value pair, an array item, a word) to the list
of rows that contain it.

```sql
CREATE INDEX projects_doc_gin ON projects USING gin (doc jsonb_path_ops);

SELECT id, title FROM projects WHERE doc @> '{"tags": ["thriller"]}';
```

```text
Bitmap Heap Scan on projects
  Recheck Cond: (doc @> '{"tags": ["thriller"]}'::jsonb)
  ->  Bitmap Index Scan on projects_doc_gin
        Index Cond: (doc @> '{"tags": ["thriller"]}'::jsonb)
```

GIN always goes through a bitmap, and it always rechecks. The index can return false positives
(for example, `jsonb_path_ops` stores *hashes* of paths), so Postgres re-tests each candidate row
against the real document.

### Two operator classes: pick `jsonb_path_ops` unless you need `?`

| | `jsonb_ops` (the default) | `jsonb_path_ops` |
|---|---|---|
| Indexes | every key and every value separately | a hash of each full path-to-value |
| Supports | `@>`, `?`, `?\|`, `?&`, `@?`, `@@` | `@>`, `@?`, `@@` only |
| Size / speed | bigger, slower to update | typically 2–3× smaller, faster `@>` |
| Pick when | you need key existence (`doc ? 'settings'`) | your queries use containment, the common case |

The recommendation, used throughout DevQuest: **if every query on the column is containment
(`@>`) or jsonpath, use `jsonb_path_ops`.** Use the default `jsonb_ops` only when the app really
asks "does this key exist?" with `?`, `?|` or `?&`. A plain `USING gin (doc)` gives you
`jsonb_ops` because it's the default, not because it's the better choice. Teams often write it
without thinking and pay for a bigger index on every autosave.

```sql
-- containment-only workload (the project browser): the smaller, faster class
CREATE INDEX projects_doc_gin ON projects USING gin (doc jsonb_path_ops);

-- only if you also need ?, ?| or ?&: the default class
-- CREATE INDEX projects_doc_gin ON projects USING gin (doc);

-- array column
CREATE INDEX posts_tags_gin ON posts USING gin (tags);

-- one specific key you filter by equality or range a lot: a plain B-tree expression index
CREATE INDEX projects_fps_idx ON projects (((doc ->> 'fps')::int));
```

Things to know:

- GIN indexes answer **containment and existence**, not `doc ->> 'fps' > '30'`. Range queries on
  a key need a B-tree expression index on `((doc ->> 'fps')::int)`, or a real column.
- The query must use the **indexed operator**. `doc @> '{"aspect":"16:9"}'` can use the GIN index,
  `doc ->> 'aspect' = '16:9'` cannot (it would need an expression index on `(doc ->> 'aspect')`).
- GIN also indexes arrays (`tags text[]` with `@>`, `&&`) and full-text `tsvector` columns (below).

:::warn title="GIN is expensive to write"
One row can produce dozens of index entries, and any change to the document rewrites its
entries. GIN batches new entries in a *pending list* (`fastupdate`, on by default). That keeps
inserts fast but makes some reads slower until the list is merged. On write-heavy tables, measure
before you add GIN, and index only the documents you really query. An autosave that rewrites
`doc` several times a minute can't be a HOT update while `doc` has a GIN index (the Indexes &
EXPLAIN lesson explains HOT).
:::

:::quiz id=db-13-q3 xp=15
You created `CREATE INDEX ON projects USING gin (doc jsonb_path_ops)`. Which query can use it?
- [x] `SELECT id FROM projects WHERE doc @> '{"settings":{"autoplay":true}}'`
- [ ] `SELECT id FROM projects WHERE doc ? 'settings'`
- [ ] `SELECT id FROM projects WHERE doc ->> 'aspect' = '16:9'`
- [ ] `SELECT id FROM projects WHERE (doc ->> 'fps')::int > 30`
> `jsonb_path_ops` only indexes paths-to-values, so it supports `@>` (and `@?`/`@@`), but not the
> key-existence operator `?`. The default `jsonb_ops` class supports `?` too. `->>` comparisons
> need a B-tree expression index.
:::

:::sql id=db-13-sql9 db=studio xp=40
title: A GIN index for project documents
The project browser filters by containment (`doc @> '{"tags":["game"]}'`) and never by key
existence. Create the **smaller** kind of GIN index on `projects.doc` for exactly that workload.
Use any name.

The grader compares the definition of every non-primary-key index on `projects`.

hint: `CREATE INDEX … ON projects USING gin (doc <operator class>);`

```sql starter
CREATE INDEX projects_doc_gin ON projects USING gin (doc);
```

```sql solution
CREATE INDEX projects_doc_gin ON projects USING gin (doc jsonb_path_ops);
```

```sql check
SELECT regexp_replace(indexdef, 'INDEX \S+ ON', 'INDEX ON')
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'projects' AND indexname <> 'projects_pkey'
ORDER BY 1;
```
:::

:::sql id=db-13-sql10 db=studio xp=40
title: Ask in a way the index understands
Write the query the project browser should send. Return `id` and `title` of projects whose `doc`
has the tag `"thriller"` **and** `settings.autoplay` set to `true`. Use a single `@>`
containment test so a `jsonb_path_ops` GIN index could serve it.

hint: Containment matches nested objects and array elements: `'{"tags":["x"], "settings":{"k":true}}'`.

```sql starter
SELECT id, title FROM projects WHERE doc->>'tags' = 'thriller';
```

```sql solution
SELECT id, title
FROM projects
WHERE doc @> '{"tags": ["thriller"], "settings": {"autoplay": true}}';
```
:::

## Full-text search basics

`WHERE title ILIKE '%door%'` works for a prototype, but it scans every row, can't rank results,
and doesn't understand language: searching *"doors"* won't find *"door"*. Postgres has a complete
full-text search engine built in.

Two types do the work:

- **`tsvector`** — a document turned into a sorted list of normalized words (**lexemes**) with
  positions. `to_tsvector('english', 'Bribe the guard')` → `'bribe':1 'guard':3`. The stop word
  *the* is gone; words are stemmed (*jumped* → *jump*, *foxes* → *fox*).
- **`tsquery`** — a search expression of lexemes with `&` (and), `|` (or), `!` (not) and `<->`
  (followed by).

The match operator is **`@@`**:

```sql
SELECT to_tsvector('english', 'The quick foxes jumped') @@ to_tsquery('english', 'fox & jump');  -- true
```

Ways to build a query from user input:

| Function | Input | Notes |
|---|---|---|
| `to_tsquery('english', 'fox & !dog')` | tsquery syntax | errors on bad syntax — not for raw user input |
| `plainto_tsquery('english', 'quick fox')` | plain text | all words ANDed |
| `phraseto_tsquery('english', 'quick fox')` | plain text | words must be adjacent |
| `websearch_to_tsquery('english', '"open vault" or door -guard')` | Google-like syntax | **best for search boxes**: quotes, `or`, `-` |

:::quiz id=db-13-q6 xp=15
Spot the bug. The clip search endpoint runs:

```sql
SELECT id, title FROM clips
WHERE to_tsvector('english', title) @@ to_tsquery('english', $1);
```

It passes all unit tests (which search single words like `vault`). What happens when a user types
`open vault` into the search box?

- [ ] It finds clips containing *open* or *vault*
- [ ] It finds clips containing *open* and *vault*
- [x] The query fails with `syntax error in tsquery`, so the endpoint returns a 500
- [ ] SQL injection: the user's text is executed as SQL
> `to_tsquery` expects tsquery syntax (`open & vault`); two bare words with a space are a syntax
> error. It's *not* SQL injection — `$1` is a bound parameter, so the text never becomes SQL — but
> it's still a crash any user can trigger. For search boxes use `websearch_to_tsquery`, which
> accepts free text (`open vault`, `"front door"`, `vault or door`, `-guard`) and never throws.
:::

Ranking: `ts_rank(vector, query)` scores how well a row matches, so you can `ORDER BY` relevance.
`setweight(to_tsvector(title), 'A') || setweight(to_tsvector(body), 'B')` makes title hits count
more than body hits.

```sql
SELECT id, title,
       ts_rank(to_tsvector('english', title), websearch_to_tsquery('english', 'answer')) AS rank
FROM clips
WHERE to_tsvector('english', title) @@ websearch_to_tsquery('english', 'answer')
ORDER BY rank DESC, id;
```

:::sql id=db-13-sql7 db=studio xp=50
title: Search the clips
Build the clip search for the editor. A clip matches when its `title` **or** its `choice_label`
matches the search box input `vault or doors` (English stemming, so *doors* must find *door*).
`choice_label` can be `NULL`. Return `id` and `title` of matching clips.

hint: `to_tsvector('english', title || ' ' || coalesce(choice_label, ''))`
hint: `@@ websearch_to_tsquery('english', 'vault or doors')`

```sql starter
SELECT id, title
FROM clips
WHERE title ILIKE '%doors%' OR choice_label ILIKE '%vault%';
```

```sql solution
SELECT id, title
FROM clips
WHERE to_tsvector('english', title || ' ' || coalesce(choice_label, ''))
      @@ websearch_to_tsquery('english', 'vault or doors');
```
:::

### Making search fast

Computing `to_tsvector` for every row on every search is a full scan. The standard pattern is a
**stored generated column** plus a **GIN index**:

```sql
ALTER TABLE clips
  ADD COLUMN search tsvector
  GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || coalesce(choice_label, ''))) STORED;

CREATE INDEX clips_search_gin ON clips USING gin (search);

SELECT id, title FROM clips WHERE search @@ websearch_to_tsquery('english', 'vault or doors');
```

The generated column is kept in sync by Postgres on every insert/update — no trigger, no app code.
Note the explicit `'english'` config: the two-argument `to_tsvector(regconfig, text)` is
*immutable* and therefore allowed in generated columns and indexes; the one-argument form depends
on a server setting and is not.

:::pro title="Postgres search vs Elasticsearch / Meilisearch"
Built-in full-text search comfortably handles millions of rows, is transactional (no sync lag),
and is one less system to run. Typo tolerance and "similar meaning" search are covered by the
`pg_trgm` and `pgvector` extensions (next section). Teams move to a dedicated search engine when
they need facets at scale, per-language analyzers, or search across several databases. Start in
Postgres; measure before adding infrastructure.
:::

:::sql id=db-13-sql8 db=studio xp=70
title: Index the search
Make clip search production-ready:

1. Add a column `search` to `clips`: a **stored generated** `tsvector` of
   `title || ' ' || coalesce(choice_label, '')` using the `'english'` config.
2. Create a **GIN** index on it.

We check that `search` is a generated column, that a GIN index on `clips` exists, and which
clips match `door` via the new column.

hint: `ALTER TABLE clips ADD COLUMN search tsvector GENERATED ALWAYS AS (…) STORED;`
hint: `CREATE INDEX clips_search_gin ON clips USING gin (search);`

```sql starter
ALTER TABLE clips ADD COLUMN search tsvector;
UPDATE clips SET search = to_tsvector('english', title);
```

```sql solution
ALTER TABLE clips
  ADD COLUMN search tsvector
  GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || coalesce(choice_label, ''))) STORED;
CREATE INDEX clips_search_gin ON clips USING gin (search);
```

```sql check
SELECT
  (SELECT is_generated FROM information_schema.columns
    WHERE table_name = 'clips' AND column_name = 'search') AS generated,
  (SELECT count(*) FROM pg_indexes
    WHERE tablename = 'clips' AND indexdef LIKE '%USING gin (search)%') AS gin_indexes,
  (SELECT string_agg(id::text, ',' ORDER BY id) FROM clips
    WHERE search @@ to_tsquery('english', 'door | vault')) AS matches;
```
:::

## Fuzzy and semantic search: pg_trgm and pgvector

Full-text search matches **words**. Users also type things it can't handle. They search for
part of a word (`eist` for *Heist*), make typos (`Escpae room`), or ask for things that *mean*
the same without sharing a word ("spooky" should find *Escape Room Teaser*). Two extensions cover
these cases, and both are standard on managed Postgres in 2026.

:::info title="Runs on a real server, not in this browser"
The in-browser PostgreSQL (PGlite) that DevQuest uses ships neither `pg_trgm` nor `pgvector`, so
this section has no SQL challenges. Try the examples on a real server, for example the
`pgvector/pgvector:pg18` Docker image, or a managed service (Amazon RDS, Azure Database for
PostgreSQL Flexible Server, Neon, Supabase) where you just run `CREATE EXTENSION`.
:::

### pg_trgm: substrings and typos

`pg_trgm` splits text into **trigrams**, groups of three consecutive characters. `heist` becomes
`"  h"`, `" he"`, `"hei"`, `"eis"`, `"ist"`, `"st "`. Two strings are *similar* when they share many
trigrams, so a typo changes only a few of them. A GIN (or GiST) index on the trigrams makes two
query shapes indexable that a B-tree can't serve:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX projects_title_trgm ON projects USING gin (title gin_trgm_ops);

-- 1. substring search, even with a leading wildcard (the pattern needs at least 3 characters)
SELECT id, title FROM projects WHERE title ILIKE '%eist%';

-- 2. typo-tolerant search: % means "similarity above pg_trgm.similarity_threshold" (default 0.3)
SELECT id, title, similarity(title, 'Escpae room') AS score
FROM projects
WHERE title % 'Escpae room'
ORDER BY score DESC
LIMIT 5;
```

- `similarity(a, b)` returns 0 to 1. `word_similarity` and the `<%` operator compare the query
  with the best-matching *part* of a longer text, which suits search boxes.
- For **autocomplete** with "closest first" ordering, a **GiST** trigram index
  (`USING gist (title gist_trgm_ops)`) supports `ORDER BY title <-> 'hiest' LIMIT 10` (`<->` is
  trigram *distance*), walking the index in distance order.
- Trigram indexes are large (several entries per word) and, like all GIN indexes, slow down
  writes. Index the one or two columns users actually search.

### pgvector: semantic search with embeddings

An **embedding** is a list of numbers (for example 1 536 floats) that an ML model produces from a
text or an image. Texts with similar *meaning* get vectors that are close together. You compute
the embedding in the app when a row changes (a background job is the usual place, see the Job
Queues lesson), store it next to the row, and search by **distance**:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE projects ADD COLUMN embedding vector(1536);

-- the 10 projects closest in meaning to the user's query (its embedding is $1)
SELECT id, title
FROM projects
ORDER BY embedding <=> $1     -- <=> cosine distance, <-> Euclidean (L2), <#> negative inner product
LIMIT 10;

-- an approximate-nearest-neighbor index; the operator class must match the operator you sort by
CREATE INDEX projects_embedding_hnsw ON projects USING hnsw (embedding vector_cosine_ops);
```

What teams learn the hard way:

- **HNSW is approximate.** It returns *nearly* the closest rows, very fast. `SET hnsw.ef_search =
  100` (default 40) trades speed for recall. The index is used only for `ORDER BY <distance
  operator> LIMIT n`, and only if the operator matches the index's operator class
  (`vector_cosine_ops` ↔ `<=>`).
- **Filters and ANN don't mix by default.** `WHERE owner_id = 1 ORDER BY embedding <=> $1 LIMIT 10`
  first takes the ~40 nearest candidates from the index, *then* applies the filter, so you can get
  3 rows instead of 10. pgvector 0.8+ has iterative scans (`SET hnsw.iterative_scan =
  relaxed_order`) that keep searching until enough rows pass the filter. For very selective
  filters, a partial index or partitioning by tenant also helps.
- **Building HNSW is slow and memory-hungry** on millions of rows. Raise `maintenance_work_mem`
  for the build, and consider `halfvec` (16-bit floats) to halve the storage.
- Store **which model** produced each vector. When you switch embedding models, every row must be
  re-embedded, and vectors from different models can't be compared.
- **Hybrid search**, full-text rank plus vector distance merged (for example by reciprocal rank
  fusion), usually beats either one alone. That's easy when both live in the same table.

:::pro title="Postgres or a dedicated vector database?"
For most products (up to tens of millions of vectors, with filters on normal columns and the
need to stay transactional with the rest of the data) pgvector in the main database is the
pragmatic 2026 default: one backup, one permission model, joins and RLS for free. Teams move to a
dedicated engine at very large scale or when vector search becomes the core of the product. As
with full-text search: start in Postgres and measure.
:::

:::quiz id=db-13-q7 xp=15
The project search box must find *The Heist* when a user types `eist`, and the table will grow to
millions of rows. Which index lets `WHERE title ILIKE '%eist%'` use an index?

- [ ] A B-tree on `title`
- [ ] A B-tree on `lower(title)`
- [x] A GIN index on `title gin_trgm_ops` (extension `pg_trgm`)
- [ ] A GIN index on `to_tsvector('english', title)`
> A leading wildcard gives a B-tree no prefix to descend to, with or without `lower()`. Full-text
> search matches whole (stemmed) words, so `eist` doesn't match the lexeme `heist`. A trigram index
> stores every three-character piece of the title, so any pattern with at least three characters
> can be looked up, including `ILIKE` with wildcards on both sides.
:::

:::quiz id=db-13-q8 xp=15
`projects.embedding` has an HNSW index with `vector_cosine_ops`. This query returns only **4**
rows although user 7 owns 300 projects:

```sql
SELECT id, title FROM projects
WHERE owner_id = 7
ORDER BY embedding <=> $1
LIMIT 10;
```

What is going on?

- [ ] The index is corrupt; `REINDEX` it
- [x] The approximate index scan returns a limited set of nearest candidates first, and the `owner_id` filter is applied afterwards, so most candidates are thrown away
- [ ] `<=>` is the wrong operator; the cosine index needs `<->`
- [ ] `LIMIT` is ignored when an HNSW index is used
> HNSW hands back roughly `hnsw.ef_search` (default 40) nearest candidates, and the `WHERE`
> clause runs on those. If user 7's projects are rare among the global nearest neighbors, few
> survive. Fixes: pgvector 0.8+ iterative scans (`SET hnsw.iterative_scan = relaxed_order`), a
> higher `ef_search`, or a partial/partitioned index per large tenant. `<=>` is exactly right for
> `vector_cosine_ops` (`<->` is Euclidean distance), and nothing is corrupt.
:::

:::quiz id=db-13-q9 xp=10
Match the search feature to the tool. Which pairing is right for **all three**?

1. "Show clips whose title contains the words *open* and *vault*, ranked by relevance."
2. "Suggest project titles as the user types, tolerating one typo."
3. "Find tutorials similar in meaning to *how do I make a video loop*."

- [x] 1 full-text search (`tsvector`), 2 `pg_trgm`, 3 `pgvector`
- [ ] 1 `pg_trgm`, 2 full-text search, 3 `pgvector`
- [ ] 1 `pgvector`, 2 `pg_trgm`, 3 full-text search
- [ ] All three: `ILIKE` with a B-tree index
> Word-based matching with stemming and ranking is what `tsvector` / `websearch_to_tsquery` do.
> Typos and partial words are trigram territory. "Similar meaning" with no shared words needs
> embeddings and vector distance. `ILIKE` handles none of them well at scale.
:::

:::cards id=db-13-cards1 xp=20 title="jsonb, arrays & search"
Q: `->` vs `->>`?
A: `->` returns jsonb (keep navigating); `->>` returns text (compare, display, cast). Use `->>` last.
Q: What does a missing key return?
A: `NULL` — no error. Great for optional data, dangerous for typos.
Q: What does `doc @> '{"tags":["x"]}'` mean?
A: "doc contains this structure" — its tags array includes "x". GIN-indexable.
Q: Why might `jsonb_set(doc, '{settings,autoplay}', 'false')` do nothing?
A: It never creates missing intermediate objects. If `settings` doesn't exist, the doc is unchanged.
Q: Is `doc || '{"settings":{"loop":true}}'` a deep merge?
A: No — `||` is shallow. It replaces the whole `settings` object.
Q: Two must-dos with `jsonb_agg` in API queries?
A: `ORDER BY` inside the aggregate, and `coalesce(…, '[]'::jsonb)` for the zero-row case.
Q: How do you pass a list of ids from your app?
A: As one array parameter: `WHERE id = ANY($1)`.
Q: `jsonb_ops` vs `jsonb_path_ops` GIN?
A: Default `jsonb_ops` supports `@>`, `?`, `?|`, `?&`. `jsonb_path_ops` is smaller/faster but only `@>` (and jsonpath). Pick `jsonb_path_ops` unless you need the key-existence operators.
Q: tsvector vs tsquery?
A: tsvector = normalized lexemes of a document; tsquery = the search expression. Match with `@@`.
Q: Which function for a search box?
A: `websearch_to_tsquery` — accepts quotes, `or`, `-word` and never throws on user input.
Q: How to make full-text search fast?
A: A STORED generated `tsvector` column + a GIN index on it.
Q: jsonb or column for `status`?
A: Column. You filter on it, constrain it and other code depends on it.
Q: What does `pg_trgm` add?
A: Trigram similarity: indexable `ILIKE '%x%'`, typo-tolerant `%` / `similarity()`, and closest-first autocomplete with a GiST index and `<->`.
Q: What does pgvector add, and what's the classic pitfall?
A: A `vector` type, distance operators (`<=>` cosine, `<->` L2) and approximate HNSW indexes. Pitfall: a `WHERE` filter applied after the ANN scan can return fewer rows than `LIMIT`.
:::

## Recap

- Use `jsonb`, not `json`. `->` navigates and returns jsonb; `->>` returns text — cast before comparing.
- Missing keys return `NULL`; model "missing" explicitly (`NOT (doc @> …)`, `coalesce`).
- `@>` and `?` ask questions about documents and are what GIN indexes accelerate.
- Expand arrays into rows with `jsonb_array_elements_text` / `unnest`; build API JSON with
  `jsonb_build_object` + `jsonb_agg(… ORDER BY …)` + `coalesce(…, '[]')`.
- `jsonb_set` won't create parents; `||` is a shallow merge; pair document saves with a `version` check.
- Postgres arrays are typed lists; `= ANY($1)` is the clean way to pass id lists.
- Columns for what the database must enforce or query often; jsonb for app-owned documents.
- GIN indexes containment: `jsonb_path_ops` for `@>`-only workloads, the default `jsonb_ops`
  when you need `?`. It's expensive to write, so index only what you query.
- Full-text search: `tsvector @@ tsquery`, `websearch_to_tsquery` for user input, a stored
  generated column + GIN index for speed.
- `pg_trgm` for substrings and typos, `pgvector` (HNSW, `<=>`) for meaning. Both run on real
  servers and managed Postgres, not in the browser sandbox.
