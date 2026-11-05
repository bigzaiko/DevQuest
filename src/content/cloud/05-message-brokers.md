---
id: cl-04
title: Message Brokers & the Outbox Pattern
level: advanced
minutes: 210
xp: 100
summary: Queues vs logs, RabbitMQ vs Kafka vs Redis Streams vs a Postgres queue, delivery semantics, the dual-write problem solved with a transactional outbox, idempotent consumers, retries with backoff and dead-letter queues, and versioned message contracts.
---

A customer places an order. The API saves it, and then four other things should happen: billing
charges the card, the warehouse reserves stock, an email goes out and analytics counts the sale.
You *could* call four services over HTTP inside the request. Then the email server has a slow
minute, every checkout takes 30 seconds, and a timeout halfway through leaves the order charged but
never shipped.

A **message broker** decouples "something happened" from "everyone who cares reacts to it". The API
records the fact (`OrderPlaced`), hands it to the broker and answers the customer. Consumers handle
it at their own pace, retry on their own schedule and can be offline for an hour without the API
noticing.

That decoupling has a price, and this lesson is mostly about paying it correctly:

- Messages get **duplicated**, **delayed**, **reordered** and occasionally **poisoned**.
- "Save to the database **and** publish a message" is two writes to two systems. Without a
  pattern, one of them eventually fails on its own.
- Producers and consumers deploy on different days, so the message format is a **contract** that
  has to evolve without breaking anyone.

You already built a Postgres job queue in *Job Queues in PostgreSQL* (db-15) and a worker in
*Background Jobs & Durable Queues* (be-16). Redis Streams are covered in *Redis as Queue, Bus and
Lock*, the previous lesson, and scaling workers on queue depth comes later in *KEDA: Autoscale
Workers on Queue Depth*. Here we look at the full picture: which broker to pick, and how to make the whole thing
correct.

## Queues vs logs: two mental models

Almost every broker is one of two shapes underneath. Two terms first, because the log side uses
them constantly: an **offset** is a message's position in a log (0, 1, 2, …), and a **consumer
group** is a named reader, such as `billing`, that remembers the offset it has processed up to.
Several processes can share one group to split the work, and each group keeps its own offset.

```text
 QUEUE (RabbitMQ, SQS, Postgres SKIP LOCKED)          LOG (Kafka, Redis Streams, RabbitMQ Streams)

 producer ─► [ m5 m4 m3 m2 m1 ] ─► worker A           producer ─► | m1 | m2 | m3 | m4 | m5 | ...   (append-only)
                              └─► worker B                         ▲               ▲
                                                                   │               │
 • a message goes to ONE consumer of the queue            group "billing" at offset 2
 • acked messages are DELETED                              group "analytics" at offset 5
 • work-distribution: "do this job once"                   • messages STAY until retention expires
 • broker tracks per-message state                         • each consumer group tracks its own offset
                                                           • replay = move the offset back
```

| Question | Queue | Log |
|---|---|---|
| What happens after a consumer acks? | Message is gone | Message stays; only the group's offset moves |
| Can a new service read last week's events? | No, it only sees new messages | Yes, from any retained offset |
| How do two services both get every message? | One queue each (fan-out via an exchange) | Two consumer groups on one topic |
| How is load spread? | Any free worker takes the next message | Each partition belongs to one consumer in the group |
| Ordering | Roughly FIFO, broken by retries and parallel workers | Strict **per partition** |
| Natural fit | Commands and jobs: "send this email", "resize this image" | Event streams: "this happened", audit, analytics, rebuilding state |

:::info title="Commands vs events"
A **command** (`SendInvoiceEmail`) has exactly one intended handler and expects something to be done.
An **event** (`OrderPlaced`) is a fact about the past that any number of subscribers may react to.
Queues are a natural fit for commands, logs and pub/sub exchanges for events. Mixing them up leads to
"why did three services all send the invoice?"
:::

## RabbitMQ: smart broker, simple consumers

RabbitMQ (4.x today) speaks AMQP 0-9-1 and, since 4.0, AMQP 1.0 as a core protocol. Producers never
write to a queue directly. They publish to an **exchange** with a **routing key**, and **bindings**
decide which queues get a copy.

```text
                                   binding "order.placed.*"
 API ──publish(key="order.placed.eu")──► [exchange: orders (topic)] ──────────────► [queue: billing.orders] ──► billing workers
                                                    │  binding "order.#"
                                                    └─────────────────────────────► [queue: analytics.orders] ──► analytics
                                                    │  binding "order.placed.us"
                                                    └──(no match for .eu)          [queue: us-tax]
```

| Exchange type | Routes to queues whose binding… | Typical use |
|---|---|---|
| `direct` | equals the routing key | Commands to one named queue |
| `topic` | matches a pattern: `*` = exactly one word, `#` = zero or more words | Events by category/region |
| `fanout` | (ignores the key) every bound queue | Broadcast, dead-letter collection |
| `headers` | matches message headers | Rare; routing on several attributes |

### Acks, prefetch and redelivery

RabbitMQ pushes messages to consumers. Two settings decide whether you lose data and how well you
scale. (Below, **at-most-once** means "a message is never handled twice, but can be lost" and
**at-least-once** means "never lost, but can be handled twice". The delivery-semantics section
later in this lesson compares them in detail.)

- **Acknowledgements.** With `autoAck: true` the broker forgets the message the moment it *sends*
  it. If your process crashes mid-handling, that message is gone (at-most-once). With manual acks
  you call `BasicAck` **after** the work is done. If the channel or connection closes first,
  RabbitMQ puts every unacked message back in the queue and delivers it again (to another consumer,
  or to the same one once it reconnects) with `Redelivered = true` (at-least-once).
- **Prefetch** (`BasicQos(prefetchCount: N)`) caps how many *unacked* messages one consumer may hold.
  With no limit, the first consumer to connect grabs 50 000 messages into memory while its siblings
  sit idle. `N = 1` is the fairest and slowest, because every message pays a network round trip. Values like
  10–50 are common for fast handlers. Use lower values for slow or memory-heavy handlers. Prefetch
  only applies to **manual-ack** consumers: an auto-ack consumer has nothing "unacked", so the
  broker pushes to it as fast as the network allows.

```text
 consumer ──BasicAck(tag)──────────► message deleted
          ──BasicNack(tag, requeue: true)──► back in the queue (retry soon, maybe by someone else)
          ──BasicNack(tag, requeue: false)─► dead-lettered to the queue's DLX (or dropped if none)
          ──(connection dies, no ack)──────► requeued automatically, Redelivered = true
```

### Quorum queues and dead-letter exchanges

Use **quorum queues** (`x-queue-type: quorum`) for anything you care about. They are replicated
with Raft and are the recommended durable queue type. Classic mirrored queues were **removed in
RabbitMQ 4.0**.

A **dead-letter exchange (DLX)** is an ordinary exchange that a queue republishes "dead" messages to:
rejected with `requeue: false`, expired by TTL, or over the queue's **delivery limit**. Bind a
`*.dlq` queue to it and you have a parking lot that a human or a repair script can inspect. Quorum
queues also support `x-delivery-limit`. Once a message has been returned too many times, it is
dead-lettered instead of looping forever.

:::warn title="Delivery limit defaults changed in 4.0"
Since RabbitMQ 4.0, quorum queues have a **default delivery limit (20)**, so a message that keeps
getting requeued is eventually dropped, or dead-lettered if a DLX is configured. Without a DLX that
looks like silent data loss. Always configure a DLX on quorum queues. How the delivery count is
incremented (and the `x-delivery-count` header) changed across 3.x → 4.x, so check the
[quorum queue docs](https://www.rabbitmq.com/docs/quorum-queues) for your exact version instead of
depending on the precise number.
:::

### Publisher confirms

`BasicPublish` returning does **not** mean the broker has the message. Turn on **publisher
confirms**: the broker acks each message once it is safely enqueued (for quorum queues, replicated to
a majority). In RabbitMQ.Client 7.x, create the channel with confirms and tracking enabled and
`BasicPublishAsync` will await the confirm and throw if the broker nacks it. Set `Persistent = true`
on messages you need to survive a broker restart. Add `mandatory: true` if you want unroutable
messages (no matching binding) returned instead of silently dropped.

## Kafka: a dumb pipe with a very good memory

Kafka (4.x today, **KRaft only**, since ZooKeeper support was removed in 4.0) stores each **topic** as N
**partitions**. Each partition is an append-only log on disk, replicated across brokers.

```text
 topic "orders" (3 partitions)                         consumer group "billing"
 P0: | o1 | o4 | o7 | o9 |      ◄── consumer b1 (owns P0, offset 3)
 P1: | o2 | o5 |               ◄── consumer b2 (owns P1, P2)
 P2: | o3 | o6 | o8 |
                                                       consumer group "analytics" reads the SAME
 partition = hash(key) % 3  → all events for            data with its own offsets
 order 42 land in the same partition, in order
```

The rules that matter in practice:

- **Ordering is per partition only.** If you need all events for order 42 in order, use the order id
  as the **key**. There is no global order across partitions.
- **Parallelism is capped by the partition count.** A group with 12 consumers on a 6-partition topic
  has 6 idle consumers. Choose partitions for your peak, since adding them later remaps keys.
- **Offsets are the ack.** A consumer commits "I've processed up to offset X". Commit **after**
  processing → at-least-once. Commit before → at-most-once.
- **Retention**, not consumption, deletes data: by time (`retention.ms`), size, or **log compaction**
  (keep only the latest value per key, which is good for "current state" topics).
- **No per-message retries or DLQ built in.** A poison message blocks its whole partition until you
  skip it. Teams add **retry topics** and a **DLQ topic** in application code (or a framework).
- **Rebalances.** When consumers join or leave, partitions move. Kafka 4.0 made the new consumer
  group protocol (KIP-848) generally available, which makes rebalances incremental and much less
  disruptive.

```csharp
// Confluent.Kafka: key by order id → per-order ordering
var producer = new ProducerBuilder<string, string>(new ProducerConfig
{
    BootstrapServers = "localhost:9092",
    Acks = Acks.All,            // wait for all in-sync replicas
    EnableIdempotence = true,   // no duplicates from producer retries
}).Build();

await producer.ProduceAsync("orders", new Message<string, string> { Key = order.Id.ToString(), Value = json });

// Consumer: commit only after the work succeeded
var consumer = new ConsumerBuilder<string, string>(new ConsumerConfig
{
    BootstrapServers = "localhost:9092",
    GroupId = "billing",
    EnableAutoCommit = false,
    AutoOffsetReset = AutoOffsetReset.Earliest,
}).Build();
consumer.Subscribe("orders");
try
{
    while (!ct.IsCancellationRequested)
    {
        var cr = consumer.Consume(ct);            // blocks until a message arrives (throws when ct is cancelled)
        await billing.HandleAsync(cr.Message.Key, cr.Message.Value, ct);
        consumer.Commit(cr);                       // "processed up to here"; a crash before this = redelivery
    }
}
catch (OperationCanceledException) { }            // normal shutdown
finally
{
    consumer.Close();                              // leave the group cleanly so partitions move over at once
}
```

Committing after every message is the simplest correct version and fine at moderate volume.
High-throughput consumers commit every N messages or every few seconds instead. That's still
at-least-once, just with a larger batch to redo after a crash.

:::quiz id=cl-04-q8 xp=10
The `orders` topic has **6 partitions** and is keyed by order id. Billing is slow, so you scale the
`billing` consumer group from 6 to **12** pods. What happens?
- [ ] Throughput doubles: Kafka spreads each partition's messages over two consumers
- [x] Nothing gets faster: each partition is assigned to at most one consumer in a group, so 6 pods sit idle
- [ ] Per-order ordering breaks, because two pods now read the same partition
- [ ] Kafka creates 6 more partitions automatically to match the consumers
> Within a group, a partition is the unit of parallelism: one partition, one consumer. That rule is what gives you per-key ordering, and it also caps the useful group size at the partition count. The tempting first answer describes a queue (competing consumers), not a log. Ordering doesn't break, because the extra pods get no partitions at all. Kafka never adds partitions by itself. To scale further you add partitions (which remaps keys, so plan it), make the handler faster, or process several keys in parallel inside one consumer while keeping each key in order.
:::

:::pro title="The .NET/Java partitioner trap"
librdkafka (and so Confluent.Kafka) has historically defaulted to a different key-hashing partitioner
than the Java client (`consistent_random` vs Java's murmur2). If a Java service and a .NET service
both produce to the same topic with the same keys, the same key can land in **different partitions**,
which silently breaks per-key ordering. Set the partitioner explicitly (`Partitioner =
Partitioner.Murmur2Random` in .NET) when you mix clients, and check the current default in the
[librdkafka configuration docs](https://github.com/confluentinc/librdkafka/blob/master/CONFIGURATION.md).
:::

:::info title="Queues are coming to Kafka"
Kafka's **share groups** (KIP-932, "Queues for Kafka") add queue-like consumption, with per-message
acks and more consumers than partitions. It arrived as early access in Kafka 4.0 and has been
maturing through the 4.x releases. Check the release notes of your exact version for its status
before you rely on it in production.
:::

## Redis Streams and Postgres as brokers

You don't always need a dedicated broker.

**Redis Streams** (`XADD`, `XREADGROUP`, `XACK`, `XAUTOCLAIM`) are a log with consumer groups and a
per-group pending list. They are fast and simple, and great when Redis is already in your stack.
Durability depends on your persistence settings (AOF fsync policy), and memory caps how much history
you keep. Details are in *Redis as Queue, Bus and Lock*.

**Postgres with `FOR UPDATE SKIP LOCKED`** (db-15) is a queue whose killer feature is that
**enqueueing is part of your business transaction**, so it has no dual-write problem at all. It works
well up to roughly thousands of jobs per second, as long as you keep the table small (delete or
partition done rows) and watch vacuum.

### Decision table

| | RabbitMQ | Kafka | Redis Streams | Postgres SKIP LOCKED |
|---|---|---|---|---|
| Model | Queue + routing | Partitioned log | Log + consumer groups | Queue (rows) |
| Replay history | No (except RabbitMQ Streams) | Yes, core feature | Yes, within `MAXLEN` | Only if you keep rows |
| Ordering | FIFO per queue, broken by retries/parallelism | Strict per partition (key) | Per stream | Whatever your `ORDER BY` gives, broken by parallel workers |
| Routing/fan-out | Excellent (exchanges, bindings) | Topics + consumer groups | Manual | Manual |
| Retries/DLQ | Built in (nack, DLX, delivery limit) | DIY (retry/DLQ topics) | DIY (`XPENDING`/`XAUTOCLAIM`) | DIY (attempts column) |
| Throughput | Tens of thousands msg/s per node | Millions msg/s per cluster | Very high, memory-bound | Thousands jobs/s |
| Transactional with your DB | No (needs an outbox) | No (needs an outbox) | No (needs an outbox) | **Yes** |
| Ops cost | Medium | High (though KRaft is simpler than ZooKeeper) | Low if Redis exists | Zero extra infra |
| Pick it for | Commands, work queues, flexible routing | Event streaming, analytics, many readers, replay | Lightweight streams, already on Redis | Background jobs in a Postgres app |

:::job title="What you'll see at work"
Most .NET product teams run **RabbitMQ** (or a cloud equivalent such as Azure Service Bus or Amazon
SQS/SNS) for commands and integration events. **Kafka** shows up once there is a data platform,
CDC or high-volume event streams. Many also keep a **Postgres-backed** job queue (Hangfire, or a
SKIP LOCKED table) for background work. On day one, find out three things: what the broker is,
where the dead-letter queues are, and who gets paged when they fill up.
:::

:::quiz id=cl-04-q1 xp=10
A new **fraud-scoring** service is launched and needs to train on every `OrderPlaced` event from the
last 30 days, then keep up with new ones. Today events go to a RabbitMQ quorum queue consumed by
billing. What is the most natural fit?
- [ ] Bind a new quorum queue for fraud to the existing exchange, since it will receive the last 30 days
- [x] Publish the events to a log (Kafka topic or RabbitMQ Stream) with 30-day retention; fraud reads it as a new consumer group from the beginning
- [ ] Have fraud consume from billing's queue too
- [ ] Set `prefetchCount` to 30 days' worth of messages
> A queue only holds messages that haven't been consumed yet, and a newly bound queue receives only messages published **after** the binding exists, so the history is gone. A log keeps messages for the retention period, and each consumer group has its own offset, so a new group can start at the beginning. Sharing billing's queue would split messages between the two services (competing consumers), so each would see only part of the stream.
:::

## Delivery semantics: what "exactly once" really means

| Semantics | How you get it | What can go wrong |
|---|---|---|
| **At-most-once** | Ack/commit *before* processing (auto-ack) | Crash after ack → message lost |
| **At-least-once** | Ack/commit *after* processing; producer retries | Crash after work, before ack → message processed **twice** |
| **Exactly-once delivery** | Not possible across a network in general | (the two generals problem) |
| **Effectively-once processing** | At-least-once delivery + **idempotent** consumer | Works, if dedup and side effect share a transaction |

```text
 at-least-once timeline
 broker ──deliver m7──► consumer: charge card ✔ ──ack──✖ (pod OOM-killed before ack)
 broker ──redeliver m7─► consumer: charge card AGAIN ✖✖  ← unless the consumer is idempotent
```

Kafka advertises "exactly-once semantics". That is real, but it is scoped to **Kafka-to-Kafka**:
idempotent producers plus transactions make "read from topic A, write to topic B, commit offset"
atomic. As soon as the consumer touches the outside world (a database, an email, a payment API),
you are back to at-least-once plus idempotency.

:::quiz id=cl-04-q2 xp=10
A consumer uses `autoAck: true`. Its client library has already received 100 messages into its
in-memory buffer, and the pod is OOM-killed while handling message 37. What happens to messages 37–100?
- [ ] RabbitMQ redelivers them to another consumer, since they were never acked
- [x] They are lost: with auto-ack the broker considered them delivered (and deleted them) when it sent them
- [ ] They stay in the queue as "unacked" until the pod restarts
- [ ] Only message 37 is lost; the rest are requeued
> Auto-ack means "acked on send". The broker deleted all 100 messages as soon as they went over the wire, so everything not yet finished is gone (at-most-once). Redelivery after a crash only happens with **manual** acks, which is why the tempting first answer is the behaviour you get only after switching `autoAck` off. "Only message 37 is lost" is wrong for the same reason: 38–100 were never processed, but the broker had already deleted them too, so 64 messages are gone. In real life it is often worse than 64: `BasicQos` prefetch is ignored for auto-ack consumers, so nothing stops the broker from pushing far more than 100 into a buffer that dies with the pod.
:::

## The dual-write problem

Here is the code almost every team writes first:

```csharp
app.MapPost("/orders", async (PlaceOrder cmd, AppDb db, IBus bus) =>
{
    var order = Order.Place(cmd);
    db.Orders.Add(order);
    await db.SaveChangesAsync();                       // write #1: Postgres
    await bus.Publish(new OrderPlaced(order.Id, ...)); // write #2: broker
    return Results.Created($"/orders/{order.Id}", order.Id);
});
```

Two systems, no shared transaction. Every interleaving of failures eventually happens in
production:

```text
 1. SaveChanges ✔  → Publish ✖ (broker down, timeout, pod killed)   ⇒ order exists, nobody bills or ships it
 2. Publish first ✔ → SaveChanges ✖ (constraint, deadlock)          ⇒ warehouse ships an order that doesn't exist
 3. Publish inside the DB transaction, then commit ✖                 ⇒ same as 2: the message is already out
 4. Publish times out, but the broker DID get it, so you retry        ⇒ duplicate message
```

The usual incident report reads like this: "~0.3% of orders since Tuesday were never invoiced". It
traces back to a broker failover during a deploy, when `Publish` threw *after* the order was
committed. Nothing logged an error the customer could see, because the HTTP call had already
succeeded.

Distributed transactions (2PC/XA) across a database and a broker are technically possible, but they
are slow and fragile, and most modern brokers don't support them. The standard answer is to make
it **one** write.

## The transactional outbox

Write the message into an **outbox table in the same database transaction** as the business
change. A separate **relay** reads the outbox and publishes to the broker. Either both the order and
the message commit, or neither does.

```text
 ┌──────────── one DB transaction ────────────┐
 │ INSERT INTO orders ...                      │
 │ INSERT INTO outbox (type, payload) ...      │──commit──►  Postgres
 └─────────────────────────────────────────────┘                │
                                                                ▼
                                    relay (BackgroundService or CDC/Debezium)
                                      1. SELECT pending rows ORDER BY id
                                      2. publish → wait for broker confirm
                                      3. mark row sent (sent_at = now())
                                                                │
                                                                ▼
                                                           RabbitMQ / Kafka
```

```sql
CREATE TABLE outbox (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id   uuid        NOT NULL UNIQUE,      -- what consumers dedupe on
  type         text        NOT NULL,             -- 'orders.placed.v1'
  aggregate_id text        NOT NULL,             -- order id → partition/ordering key
  payload      jsonb       NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz
);
CREATE INDEX outbox_pending ON outbox (id) WHERE sent_at IS NULL;  -- tiny partial index
```

```csharp
// One SaveChanges = one transaction: the order and its message commit together
var order = Order.Place(cmd);
db.Orders.Add(order);
db.Outbox.Add(new OutboxMessage
{
    MessageId   = Guid.CreateVersion7(),
    Type        = "orders.placed.v1",
    AggregateId = order.Id.ToString(),
    Payload     = JsonSerializer.Serialize(new OrderPlacedV1(order.Id, order.Total, order.Currency), JsonSerializerOptions.Web),
});
await db.SaveChangesAsync(ct);
```

A minimal relay with Npgsql:

```csharp
public sealed class OutboxRelay(NpgsqlDataSource ds, IMessagePublisher bus, ILogger<OutboxRelay> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        while (await timer.WaitForNextTickAsync(ct))
        {
            try { while (await RelayBatchAsync(ct) > 0) { } }       // drain, then sleep
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                log.LogWarning(ex, "Outbox relay failed; retrying next tick");
            }
        }
    }

    private async Task<int> RelayBatchAsync(CancellationToken ct)
    {
        await using var conn = await ds.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);

        var rows = new List<(long Id, Guid MessageId, string Type, string Key, string Payload)>();
        await using (var cmd = new NpgsqlCommand("""
            SELECT id, message_id, type, aggregate_id, payload::text
            FROM outbox WHERE sent_at IS NULL
            ORDER BY id LIMIT 100
            FOR UPDATE SKIP LOCKED
            """, conn, tx))
        await using (var r = await cmd.ExecuteReaderAsync(ct))
            while (await r.ReadAsync(ct))
                rows.Add((r.GetInt64(0), r.GetGuid(1), r.GetString(2), r.GetString(3), r.GetString(4)));

        var sent = 0;
        foreach (var row in rows)
        {
            try
            {
                await bus.PublishAsync(row.Type, row.MessageId, row.Key, row.Payload, ct); // awaits broker confirm; throws on failure
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // Stop here: publishing row N+1 before row N would reorder. Keep the marks we already have.
                log.LogWarning(ex, "Publishing outbox row {Id} failed; stopping this batch", row.Id);
                break;
            }
            await using var mark = new NpgsqlCommand("UPDATE outbox SET sent_at = now() WHERE id = $1", conn, tx);
            mark.Parameters.Add(new() { Value = row.Id });
            await mark.ExecuteNonQueryAsync(ct);
            sent++;
        }
        await tx.CommitAsync(ct);          // marks for confirmed rows survive even if a later row failed
        return sent == rows.Count ? sent : 0;  // 0 = stop draining, wait for the next tick before retrying
    }
}
```

Two details in that relay are deliberate. The publish failure is caught **per row**, so the rows that
were already confirmed keep their `sent_at` when the transaction commits. If the exception escaped
instead, the rollback would erase those marks and every row of the batch would be published again.
And the row locks (`FOR UPDATE`) are held while the relay talks to the broker, which keeps a second
relay instance off the same rows. Keep batches small so that transaction stays short.

Notice what the outbox guarantees and what it doesn't:

- **No lost messages.** A committed order always has a committed outbox row, and the relay keeps
  retrying until the broker confirms it.
- **Duplicates are possible.** If the relay publishes row 7 and crashes (or loses its database
  connection) before committing `sent_at`, row 7 is published again. The outbox gives you **at-least-once**, so consumers must be
  idempotent (next section). That is why every row carries a stable `message_id`.
- **Stop on failure, in order.** If publishing row 7 fails, don't skip ahead to row 8. For
  per-aggregate ordering, "order cancelled" must never overtake "order placed".

:::pro title="Two ordering traps in outbox relays"
1. **Commit order ≠ id order.** Transaction A takes identity 10 and transaction B takes 11. B commits
   first. A relay that tracks a high-water mark (`WHERE id > @lastSeen`) sees 11, moves the mark, and
   **never** publishes 10. Poll on `sent_at IS NULL` instead (late rows get picked up next tick), or
   use CDC.
2. **Several relays with SKIP LOCKED publish batches in parallel**, so the global order is gone. Run
   a single active relay (a leader lock such as `pg_try_advisory_lock`), or shard relays by
   `aggregate_id` so each aggregate's messages stay in order. Consumers should still tolerate
   reordering, for example by carrying an aggregate **version** and ignoring stale ones.

**CDC (Debezium)** is the alternative to polling: it tails the Postgres WAL through logical
replication and turns outbox inserts into broker messages in commit order, with no polling and
seconds less latency. The trade-off is another system to run and a replication slot to monitor (an
abandoned slot makes Postgres keep WAL forever and fill the disk).
:::

:::quiz id=cl-04-q3 xp=10
To "fix" lost messages, a teammate moves `bus.Publish(...)` **inside** an explicit database
transaction, just before `CommitAsync()`. What does this achieve?
- [ ] It makes the publish and the insert atomic, which is the outbox pattern without a table
- [ ] Nothing changes; it is exactly as safe as before
- [x] It swaps one failure mode for another: if the commit fails after a successful publish, consumers act on an order that was rolled back
- [ ] The broker joins the Postgres transaction and rolls the message back on failure
> The broker isn't part of the Postgres transaction, so nothing can "un-send" the message. Publishing before commit turns "order without message" into "message without order", which is often worse: a shipment for a rolled-back order. The outbox fixes it by turning the message into a row, making it one write to one system.
:::

## Idempotent consumers and the inbox

Since delivery is at-least-once, the consumer has to make **handling the same message twice
equivalent to handling it once**. There are three common strategies:

1. **Naturally idempotent operations.** `UPDATE orders SET status = 'paid' WHERE id = 42` can run
   twice safely. `UPDATE accounts SET balance = balance - 10` cannot.
2. **Idempotency keys downstream.** Pass the `message_id` as the payment provider's idempotency key
   so that the provider deduplicates.
3. **An inbox / processed-messages table**, written **in the same transaction** as the side effect:

```sql
CREATE TABLE inbox (
  consumer     text NOT NULL,          -- 'billing' — several consumers may share a DB
  message_id   uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, message_id)
);
```

```csharp
await using var tx = await db.Database.BeginTransactionAsync(ct);
var inserted = await db.Database.ExecuteSqlAsync(
    $"INSERT INTO inbox (consumer, message_id) VALUES ('billing', {msg.MessageId}) ON CONFLICT DO NOTHING", ct);
if (inserted == 0) { await tx.RollbackAsync(ct); await ack(); return; }   // duplicate → ack and move on

db.Invoices.Add(Invoice.For(msg));       // the actual side effect
await db.SaveChangesAsync(ct);
await tx.CommitAsync(ct);                // dedup marker and invoice commit together
await ack();                             // ack only after commit
```

The essential detail is **same transaction**. If you record "processed" *before* doing the work and
then crash, the retry skips work that never happened. If you record it *after* in a separate
transaction, a crash in between causes a double charge. The primary key also protects you from two
consumers processing the same redelivered message concurrently: the second `INSERT` blocks on the
first transaction's uncommitted row. If the first commits, the second gets `0 rows` and skips. If
the first rolls back, the second's insert goes through and it does the work.

Clean the inbox up eventually, keeping it longer than your longest possible redelivery window
(days, not minutes).

:::challenge id=cl-04-c1 lang=ts xp=40
title: An outbox relay that keeps order
Write `relayOutbox(rows, publish, now)`. It must:

- publish only **pending** rows (`sentAt === null`), in ascending **`id`** order (the array is not sorted),
- set `row.sentAt = now()` **only after** that row's `publish` resolved,
- on the first publish failure, **stop**: don't publish later rows (that would reorder), leave the failed row pending, and return `{ published, failedAt: <id of the failed row> }`,
- otherwise return `{ published, failedAt: null }`.

`published` is the number of rows this call published successfully. Mutate the row objects in place
(that is your "UPDATE outbox SET sent_at"), call `now()` exactly once per successfully published row,
and leave rows that were already sent untouched.

Running it again later must resume from the failed row without republishing rows already marked sent.

hint: `rows.filter(r => r.sentAt === null).sort((a, b) => a.id - b.id)`. Sort a filtered copy, not the input array.
hint: Wrap only the `await publish(row)` in `try/catch`; mark the row after the `try` succeeded.

```ts setup
type OutboxRow = { id: number; type: string; payload: string; sentAt: number | null }
type Publish = (row: OutboxRow) => Promise<void>
```

```ts starter
export async function relayOutbox(
  rows: OutboxRow[],
  publish: Publish,
  now: () => number,
): Promise<{ published: number; failedAt: number | null }> {
  // naive version: publishes everything in array order
  for (const row of rows) {
    await publish(row)
    row.sentAt = now()
  }
  return { published: rows.length, failedAt: null }
}
```

```ts solution
export async function relayOutbox(
  rows: OutboxRow[],
  publish: Publish,
  now: () => number,
): Promise<{ published: number; failedAt: number | null }> {
  const pending = rows.filter((r) => r.sentAt === null).sort((a, b) => a.id - b.id)
  let published = 0
  for (const row of pending) {
    try {
      await publish(row)
    } catch {
      return { published, failedAt: row.id }
    }
    row.sentAt = now()
    published++
  }
  return { published, failedAt: null }
}
```

```ts tests
function makeRows(): OutboxRow[] {
  return [
    { id: 3, type: 'order.placed', payload: '{"order":3}', sentAt: null },
    { id: 1, type: 'order.placed', payload: '{"order":1}', sentAt: 100 },
    { id: 4, type: 'order.cancelled', payload: '{"order":3}', sentAt: null },
    { id: 2, type: 'order.placed', payload: '{"order":2}', sentAt: null },
  ]
}
function fakeClock(start = 1000) {
  let t = start
  return () => t++
}
const byId = (rows: OutboxRow[], id: number) => rows.find((r) => r.id === id)!

test('publishes only pending rows, in id order', async () => {
  const rows = makeRows()
  const seen: number[] = []
  const r = await relayOutbox(rows, async (row) => { seen.push(row.id) }, fakeClock())
  expect(seen).toEqual([2, 3, 4])
  expect(r).toEqual({ published: 3, failedAt: null })
})

test('marks each row with the injected clock and leaves sent rows alone', async () => {
  const rows = makeRows()
  await relayOutbox(rows, async () => {}, fakeClock(1000))
  expect(byId(rows, 1).sentAt).toBe(100)
  expect(byId(rows, 2).sentAt).toBe(1000)
  expect(byId(rows, 3).sentAt).toBe(1001)
  expect(byId(rows, 4).sentAt).toBe(1002)
})

test('a row is still pending while it is being published', async () => {
  const rows = makeRows()
  const sentAtDuringPublish: (number | null)[] = []
  await relayOutbox(rows, async (row) => { sentAtDuringPublish.push(row.sentAt) }, fakeClock())
  expect(sentAtDuringPublish).toEqual([null, null, null])
})

test('stops at the first failure and does not skip ahead', async () => {
  const rows = makeRows()
  const seen: number[] = []
  const r = await relayOutbox(rows, async (row) => {
    seen.push(row.id)
    if (row.id === 3) throw new Error('broker unavailable')
  }, fakeClock())
  expect(seen).toEqual([2, 3])
  expect(r).toEqual({ published: 1, failedAt: 3 })
  expect(byId(rows, 3).sentAt).toBeNull()
  expect(byId(rows, 4).sentAt).toBeNull()
})

test('a second run resumes at the failed row without republishing', async () => {
  const rows = makeRows()
  const clock = fakeClock()
  await relayOutbox(rows, async (row) => { if (row.id === 3) throw new Error('down') }, clock)
  const seen: number[] = []
  const r = await relayOutbox(rows, async (row) => { seen.push(row.id) }, clock)
  expect(seen).toEqual([3, 4])
  expect(r).toEqual({ published: 2, failedAt: null })
})

test('nothing pending means no publish calls', async () => {
  const publish = fn(async () => {})
  const r = await relayOutbox([{ id: 1, type: 't', payload: '{}', sentAt: 5 }], publish, fakeClock())
  expect(publish).not.toHaveBeenCalled()
  expect(r).toEqual({ published: 0, failedAt: null })
})
```
:::

:::challenge id=cl-04-c2 lang=ts xp=40
title: An idempotent consumer
Write `idempotent(store, handle)`. It returns a function `(msg) => Promise<'processed' | 'duplicate'>`:

- If `store` already has `msg.id`, return `'duplicate'` without calling `handle`.
- Otherwise call `handle(msg)`. Only **after** it resolves, `await store.add(msg.id)` and return `'processed'`.
- If `handle` throws, **don't** record the id (so a redelivery can retry) and rethrow the error.
- Two **concurrent** deliveries of the same id (the second arrives while the first is still running)
  must call `handle` only **once**. The second waits for the first and returns `'duplicate'`.
  (If that first run fails, letting the waiting call reject with the same error is fine: the broker
  will redeliver.)
- Once a call has finished, the id must no longer count as "in flight": a later delivery is decided
  by the store alone.

In a real system the store is the `inbox` table, written in the same DB transaction as the side
effect. Here it is an async in-memory store.

hint: Keep a `Map<string, Promise<...>>` of in-flight ids. Set it **before** your first `await`, or the second call slips through while the first is awaiting `store.has`.
hint: Wrap the "check, handle, record" steps in an inner async function, store its promise, and `delete` it in a `finally`.

```ts setup
type Message = { id: string; body: string }
interface ProcessedStore {
  has(id: string): Promise<boolean>
  add(id: string): Promise<void>
}
function memoryStore(): ProcessedStore & { ids: Set<string> } {
  const ids = new Set<string>()
  return { ids, has: async (id) => ids.has(id), add: async (id) => { ids.add(id) } }
}
```

```ts starter
export function idempotent(store: ProcessedStore, handle: (m: Message) => Promise<void>) {
  return async (msg: Message): Promise<'processed' | 'duplicate'> => {
    await handle(msg)
    return 'processed'
  }
}
```

```ts solution
export function idempotent(store: ProcessedStore, handle: (m: Message) => Promise<void>) {
  const inFlight = new Map<string, Promise<'processed' | 'duplicate'>>()
  return async (msg: Message): Promise<'processed' | 'duplicate'> => {
    const running = inFlight.get(msg.id)
    if (running) {
      await running
      return 'duplicate'
    }
    const work = (async (): Promise<'processed' | 'duplicate'> => {
      if (await store.has(msg.id)) return 'duplicate'
      await handle(msg)
      await store.add(msg.id)
      return 'processed'
    })()
    inFlight.set(msg.id, work)
    try {
      return await work
    } finally {
      inFlight.delete(msg.id)
    }
  }
}
```

```ts tests
const m1: Message = { id: 'msg-1', body: 'charge order 42' }

test('first delivery is processed and recorded', async () => {
  const store = memoryStore()
  const handle = fn(async () => {})
  const consume = idempotent(store, handle)
  expect(await consume(m1)).toBe('processed')
  expect(handle).toHaveBeenCalledTimes(1)
  expect(store.ids.has('msg-1')).toBe(true)
})

test('a redelivery is a duplicate and does not run the handler again', async () => {
  const store = memoryStore()
  const handle = fn(async () => {})
  const consume = idempotent(store, handle)
  await consume(m1)
  expect(await consume(m1)).toBe('duplicate')
  expect(handle).toHaveBeenCalledTimes(1)
})

test('an id already in the store (e.g. from another pod) is skipped', async () => {
  const store = memoryStore()
  store.ids.add('msg-1')
  const handle = fn(async () => {})
  expect(await idempotent(store, handle)(m1)).toBe('duplicate')
  expect(handle).not.toHaveBeenCalled()
})

test('the id is recorded only after the handler finished', async () => {
  const store = memoryStore()
  let seenDuring: boolean | null = null
  const consume = idempotent(store, async (m) => { seenDuring = store.ids.has(m.id) })
  await consume(m1)
  expect(seenDuring).toBe(false)
})

test('a failing handler is not recorded, so the retry runs it again', async () => {
  const store = memoryStore()
  let calls = 0
  const consume = idempotent(store, async () => {
    calls++
    if (calls === 1) throw new Error('payment API timeout')
  })
  await expect(consume(m1)).rejects.toThrow('payment API timeout')
  expect(store.ids.has('msg-1')).toBe(false)
  expect(await consume(m1)).toBe('processed')
  expect(calls).toBe(2)
})

test('concurrent duplicates run the handler once', async () => {
  const store = memoryStore()
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const handle = fn(async () => { await gate })
  const consume = idempotent(store, handle)
  const a = consume(m1)
  const b = consume(m1)
  release()
  expect(await Promise.all([a, b])).toEqual(['processed', 'duplicate'])
  expect(handle).toHaveBeenCalledTimes(1)
})

test('different ids are processed independently', async () => {
  const store = memoryStore()
  const handle = fn(async () => {})
  const consume = idempotent(store, handle)
  expect(await consume(m1)).toBe('processed')
  expect(await consume({ id: 'msg-2', body: 'charge order 43' })).toBe('processed')
  expect(handle).toHaveBeenCalledTimes(2)
})
```
:::

:::quiz id=cl-04-q4 xp=10
Billing consumes `OrderPlaced` from an outbox-fed RabbitMQ queue with manual acks and publisher
confirms everywhere. Which statement is true?
- [ ] The outbox plus publisher confirms give exactly-once delivery, so the consumer needn't deduplicate
- [x] Messages can still arrive twice (relay crash before marking sent, consumer crash before ack), so billing must deduplicate on `message_id`
- [ ] Duplicates only happen if RabbitMQ crashes, which quorum queues prevent
- [ ] Setting `prefetchCount: 1` guarantees each message is processed once
> Every piece here guarantees "not lost", and each does it by retrying, which creates duplicates. The relay can publish and then die before setting `sent_at`, and a consumer can finish the work and die before `BasicAck`. Quorum queues protect against broker failures, not consumer crashes. Prefetch only limits how many unacked messages a consumer holds and has nothing to do with deduplication.
:::

## Retries, backoff and dead letters

Failures fall into two buckets, and treating them the same is the classic mistake:

| Transient | Permanent (poison) |
|---|---|
| Timeout, 503, deadlock, rate limit, DB failover | Invalid JSON, unknown schema version, validation error, a bug |
| **Retry later**, it will probably work | Retrying will **never** work, so **dead-letter it** |

A naive `BasicNack(requeue: true)` puts the message straight back into the queue with **no delay**,
and a consumer gets it again within milliseconds. A poison message then becomes a **hot
loop** that burns CPU, floods logs and, on a queue with ordering expectations, blocks everything
behind it. Retry with a delay instead:

- **Exponential backoff with full jitter:** `delay = random(0, min(cap, base · 2^(attempt−1)))`.
  The exponent backs off from a struggling dependency. The **jitter** spreads out the thousand
  consumers that all failed at the same second, so they don't retry in lockstep and knock it over
  again (the *thundering herd*). You built `fullJitter` in be-16. Here it drives a message consumer.
- **A maximum number of attempts**, after which the message goes to a **dead-letter queue** together
  with the error, attempt count and original routing info. Alert on DLQ depth > 0, and build a
  replay tool (move from the DLQ back to the main queue once the bug is fixed).

In RabbitMQ, a delayed retry is usually built from a **retry queue** with `x-message-ttl` whose DLX
points back to the main exchange: nack → wait in the retry queue for its TTL → expire → back in the
main queue. Use one retry queue per delay tier (5 s, 30 s, 5 min). Frameworks like MassTransit do
this for you. In-process retries (Polly, or a loop like the challenge below) are fine for short
delays. Longer delays belong in the broker, so that a held message doesn't block a prefetch slot.

:::warn title="Delayed-message plugin"
The community `rabbitmq_delayed_message_exchange` plugin is another way to delay redelivery, but it
has known limitations (delayed messages are stored on a single node and are not replicated) and its
support for RabbitMQ 4.x should be checked against the plugin's README before you depend on it. The
TTL + DLX retry-queue pattern works with no plugins.
:::

:::challenge id=cl-04-c3 lang=ts xp=50
title: Backoff with jitter, then the DLQ
Write two functions:

**`backoffDelay(attempt, opts, random)`**: full jitter. `attempt` is the number of failed attempts
so far (1, 2, 3…). Return `Math.floor(random() * Math.min(opts.capMs, opts.baseMs * 2 ** (attempt - 1)))`.

**`processWithRetry(msg, handler, opts, deps)`**:

- Call `handler(msg)`. On success return `{ status: 'ok', attempts }`.
- On failure, if the error is a `PermanentError` **or** this was attempt `opts.maxAttempts`, call
  `deps.deadLetter(msg, error, attempts)` once and return `{ status: 'dead-lettered', attempts }`.
- Otherwise `await deps.sleep(backoffDelay(attempt, opts, deps.random))` and try again.
- `attempts` (in the result and passed to `deadLetter`) is how many times `handler` was called;
  `error` is the error from the **last** call.
- Never sleep after the final attempt. Use only the injected `sleep` and `random` (no real timers).

hint: A `for (let attempt = 1; ; attempt++)` loop with `try/catch` inside reads well.
hint: `err instanceof PermanentError` (defined in the setup) marks poison messages.

```ts setup
class PermanentError extends Error {}
type RetryOptions = { maxAttempts: number; baseMs: number; capMs: number }
type RetryDeps = {
  sleep: (ms: number) => Promise<void>
  random: () => number
  deadLetter: (msg: unknown, error: Error, attempts: number) => Promise<void>
}
type Outcome = { status: 'ok' | 'dead-lettered'; attempts: number }
```

```ts starter
export function backoffDelay(attempt: number, opts: RetryOptions, random: () => number): number {
  return opts.baseMs * attempt
}

export async function processWithRetry(
  msg: unknown,
  handler: (msg: unknown) => Promise<void>,
  opts: RetryOptions,
  deps: RetryDeps,
): Promise<Outcome> {
  await handler(msg)
  return { status: 'ok', attempts: 1 }
}
```

```ts solution
export function backoffDelay(attempt: number, opts: RetryOptions, random: () => number): number {
  return Math.floor(random() * Math.min(opts.capMs, opts.baseMs * 2 ** (attempt - 1)))
}

export async function processWithRetry(
  msg: unknown,
  handler: (msg: unknown) => Promise<void>,
  opts: RetryOptions,
  deps: RetryDeps,
): Promise<Outcome> {
  for (let attempt = 1; ; attempt++) {
    try {
      await handler(msg)
      return { status: 'ok', attempts: attempt }
    } catch (e) {
      const error = e as Error
      if (error instanceof PermanentError || attempt >= opts.maxAttempts) {
        await deps.deadLetter(msg, error, attempt)
        return { status: 'dead-lettered', attempts: attempt }
      }
      await deps.sleep(backoffDelay(attempt, opts, deps.random))
    }
  }
}
```

```ts tests
const opts: RetryOptions = { maxAttempts: 4, baseMs: 100, capMs: 10_000 }
function makeDeps(r = 0.5) {
  return {
    sleep: fn(async (_ms: number) => {}),
    random: () => r,
    deadLetter: fn(async (_m: unknown, _e: Error, _n: number) => {}),
  }
}
function failTimes(n: number, err = () => new Error('503 from billing')) {
  let calls = 0
  return fn(async () => {
    calls++
    if (calls <= n) throw err()
  })
}

test('backoff doubles per attempt, scaled by jitter', () => {
  const half = () => 0.5
  expect([1, 2, 3, 4].map((a) => backoffDelay(a, opts, half))).toEqual([50, 100, 200, 400])
})

test('backoff is capped and floored to whole ms', () => {
  expect(backoffDelay(20, { maxAttempts: 30, baseMs: 100, capMs: 1000 }, () => 0.9999)).toBe(999)
  expect(backoffDelay(1, opts, () => 0.3333)).toBe(33)
  expect(backoffDelay(5, opts, () => 0)).toBe(0)
})

test('success on the first try: no sleep, no dead letter', async () => {
  const deps = makeDeps()
  const out = await processWithRetry({ id: 1 }, failTimes(0), opts, deps)
  expect(out).toEqual({ status: 'ok', attempts: 1 })
  expect(deps.sleep).not.toHaveBeenCalled()
  expect(deps.deadLetter).not.toHaveBeenCalled()
})

test('transient failures are retried with growing delays', async () => {
  const deps = makeDeps(0.5)
  const handler = failTimes(2)
  const out = await processWithRetry({ id: 1 }, handler, opts, deps)
  expect(out).toEqual({ status: 'ok', attempts: 3 })
  expect(handler).toHaveBeenCalledTimes(3)
  expect(deps.sleep.mock.calls).toEqual([[50], [100]])
})

test('after maxAttempts the message is dead-lettered with the last error', async () => {
  const deps = makeDeps(0.5)
  let n = 0
  const handler = fn(async () => { n++; throw new Error(`fail ${n}`) })
  const msg = { id: 7 }
  const out = await processWithRetry(msg, handler, opts, deps)
  expect(out).toEqual({ status: 'dead-lettered', attempts: 4 })
  expect(handler).toHaveBeenCalledTimes(4)
  expect(deps.sleep).toHaveBeenCalledTimes(3)
  expect(deps.deadLetter).toHaveBeenCalledTimes(1)
  const [m, e, attempts] = deps.deadLetter.mock.calls[0]
  expect(m).toBe(msg)
  expect((e as Error).message).toBe('fail 4')
  expect(attempts).toBe(4)
})

test('a PermanentError goes straight to the DLQ without sleeping', async () => {
  const deps = makeDeps()
  const handler = failTimes(99, () => new PermanentError('invalid amount'))
  const out = await processWithRetry({ id: 9 }, handler, opts, deps)
  expect(out).toEqual({ status: 'dead-lettered', attempts: 1 })
  expect(handler).toHaveBeenCalledTimes(1)
  expect(deps.sleep).not.toHaveBeenCalled()
  expect(deps.deadLetter).toHaveBeenCalledTimes(1)
})
```
:::

:::quiz id=cl-04-q5 xp=10
One message in `billing.orders` has a `currency` value of `"€"` that the consumer's validator rejects.
The consumer catches every exception and calls `BasicNack(requeue: true)`. What happens?
- [ ] RabbitMQ waits a few seconds before redelivering, so it's a reasonable retry
- [x] The message is redelivered almost immediately, over and over: a hot loop that burns CPU and floods logs until a delivery limit (if any) kicks in
- [ ] RabbitMQ automatically moves it to a DLQ after the first nack
- [ ] The message is dropped
> `requeue: true` has no delay. The message goes straight back and is redelivered at once. A validation failure is **permanent**, so it should be `requeue: false` (dead-lettered via the DLX) immediately. Since 4.0, quorum queues stop the loop after the default delivery limit, but only after many pointless attempts, and without a DLX the message is then dropped. A DLX is never automatic: you have to configure one.
:::

## Message contracts and versioning

A message is a public API whose callers you can't see. The producer deploys on Tuesday and three
consumers deploy whenever their teams get to it. Messages sitting in a DLQ from last month will be
replayed against today's code. Design for that:

```json
{
  "messageId": "0193a6f2-5c1e-7b3a-9d44-1f8e2a7c0b11",
  "type": "orders.placed.v1",
  "occurredAt": "2026-11-05T09:14:03.120Z",
  "correlationId": "req-7f3a",
  "causationId": "cmd-place-order-889",
  "data": { "orderId": 42, "total": 59.90, "currency": "EUR" }
}
```

An **envelope** carries what every consumer needs regardless of payload: a stable id (dedup), a
type with a version, a timestamp, and correlation/causation ids for tracing (*Observability: OpenTelemetry, Prometheus, Grafana, Loki* shows how
OpenTelemetry propagates trace context through message headers). The CNCF **CloudEvents** spec
(`id`, `source`, `type`, `time`, `data`…) standardises such an envelope and is worth adopting if you
don't have one.

Evolution rules that keep consumers working:

| Change | Safe? | Why |
|---|---|---|
| Add an **optional** field | Yes | Old consumers ignore it (if they're *tolerant readers*) |
| Add a field old consumers **need** | No | Old producers won't send it, and DLQ replays won't have it |
| Rename / remove a field | No | Breaking: it's a remove plus an add |
| Change a field's type or meaning (`total` cents → euros) | No | The worst kind: it parses fine and is silently wrong |
| New major version (`orders.placed.v2`) published **alongside** v1 | Yes | Consumers migrate on their schedule; drop v1 when nobody reads it |

- Consumers should be **tolerant readers**: ignore unknown fields, don't fail on extra enum values
  if you can help it. System.Text.Json ignores unknown properties by default, so don't turn on
  `JsonUnmappedMemberHandling.Disallow` for messages.
- With Kafka, teams often use a **schema registry** (Avro/Protobuf/JSON Schema) that rejects
  incompatible schema changes at publish time.
- Never put your EF entity in a message. Use a dedicated contract type (a `record` in a shared
  contracts package, or generated from a schema), so that a database refactor can't break other
  teams.

:::quiz id=cl-04-q6 xp=10
Which changes to `orders.placed.v1` can you ship **without** coordinating with consumers? (Select
all that apply.)
- [x] Add an optional `couponCode` field
- [ ] Rename `total` to `grandTotal`
- [ ] Change `total` from euros (`59.90`) to cents (`5990`), still a number
- [x] Start publishing `orders.placed.v2` with a new shape **in addition to** v1
> Adding an optional field is safe for tolerant readers, and publishing a new version side by side lets consumers move when ready. Renaming is a breaking remove-plus-add. Changing units is the most dangerous change of all: every consumer still parses the message, and every invoice is now 100× wrong.
:::

## Doing it with a framework in .NET

You should understand the outbox, inbox and retry mechanics (you just built them), but in a .NET
product you'll usually use a messaging framework that implements them:

- **MassTransit**: transports for RabbitMQ, Azure Service Bus, Amazon SQS, Kafka (rider) and more.
  It includes an EF Core transactional outbox *and* inbox, retry and delayed-redelivery policies,
  sagas, and consumer test harnesses.
- **Wolverine** (JasperFx): a messaging and command framework with a durable outbox/inbox on
  Postgres (EF Core or Marten). It uses handler conventions instead of interfaces, and supports
  RabbitMQ, Azure Service Bus, Kafka and others.

```csharp
// MassTransit 8.x: EF Core outbox + RabbitMQ, retries, then the error queue
builder.Services.AddMassTransit(x =>
{
    x.AddEntityFrameworkOutbox<AppDb>(o =>
    {
        o.UsePostgres();
        o.UseBusOutbox();          // IPublishEndpoint.Publish writes to the outbox table in your SaveChanges
    });
    x.AddConsumer<ChargeOrderConsumer>();
    x.UsingRabbitMq((ctx, cfg) =>
    {
        cfg.Host("localhost", "/", h => { h.Username("devquest"); h.Password("devquest"); });
        cfg.UseMessageRetry(r => r.Exponential(5, TimeSpan.FromSeconds(1), TimeSpan.FromMinutes(1), TimeSpan.FromSeconds(2)));
        cfg.ConfigureEndpoints(ctx);  // failed messages end up in <queue>_error
    });
});
```

:::warn title="Check licensing and versions before you choose"
MassTransit announced that **v9 is a commercial product**, while v8 stays open source (Apache 2.0)
with support for a limited period. Wolverine is MIT-licensed. The exact support dates and API
details change, so check each project's site for the current status before you standardise on one.
The configuration above is MassTransit 8.x style.
:::

:::pro title="What senior teams add on top"
- **DLQ depth and oldest-message age** as alerts, not dashboards. A DLQ nobody watches is a bin.
- **A replay tool** with audit: move N messages from a DLQ back, optionally filtered by error.
- **Consumer lag / queue depth** drives autoscaling (*KEDA: Autoscale Workers on Queue Depth*) and is the first graph during an incident.
- **Contract tests** in CI: the producer's sample messages are deserialized by each consumer's contract package.
- **Message size limits:** keep messages small and put large payloads in object storage, sending
  only the key (the *claim-check* pattern; see *Object Storage & Direct Uploads (S3)*).
:::

:::quiz id=cl-04-q7 xp=10
Your app already uses PostgreSQL. You need to run ~200 background jobs per second (send emails,
generate PDFs). No other service consumes them and you don't need replay. What's the most pragmatic
choice?
- [ ] Kafka with 12 partitions, so you're ready for scale
- [x] A Postgres `SKIP LOCKED` job table (or a library built on it): jobs enqueue in the same transaction as the business change, so there's no outbox to build
- [ ] Redis Streams, since databases can't be queues
- [ ] RabbitMQ with an outbox, because a dedicated broker is always more correct
> At this volume Postgres is comfortably fast, and you get transactional enqueue for free, removing the dual-write problem entirely. Kafka adds significant operational cost for replay and fan-out you don't need. RabbitMQ is a fine tool, but here it adds infrastructure *and* forces you to build an outbox to reach the same correctness Postgres gives you natively.
:::

## Beyond one message: sagas and long-running workflows

The outbox makes **one** step reliable: "the order is saved *and* `OrderPlaced` will be published".
Real business processes have several steps owned by different services: reserve stock, charge the
card, book the courier. There is no transaction across three databases and a payment provider, so
you can't roll the whole thing back. A **saga** is the standard answer: a sequence of local
transactions, each publishing the event that triggers the next, plus a **compensating action** for
each step that undoes its business effect if a later step fails.

```text
 happy path:   ReserveStock ──► ChargeCard ──► BookCourier ──► OrderConfirmed
 card fails:   ReserveStock ──► ChargeCard ✗ ──► ReleaseStock (compensation) ──► OrderCancelled
```

Compensation is not a database rollback. The stock *was* reserved for a few seconds and other
orders may have seen it as unavailable. A refund is a new transaction, not an undo. You design
the compensations together with the business: "cancel the courier booking within 1 h for free,
after that a fee applies" is a product decision, not a code detail.

There are two ways to coordinate the steps:

| | **Choreography** | **Orchestration** |
|---|---|---|
| How | Each service reacts to the previous service's event and publishes its own | A **process manager** (orchestrator) keeps the saga's state and sends commands to each service |
| State lives | Spread across services and events | In one place: a saga table keyed by a correlation id (the order id) |
| Good for | 2–3 steps, few teams, simple rules | Many steps, timeouts, branching, "where is order 42 stuck?" |
| Risk | Nobody can see the whole flow; cycles between services | The orchestrator becomes a god service if it starts holding business logic |

Whichever you choose, the rules you already learned carry over and get stricter:

- **Every step and every compensation is idempotent** and keyed by the saga's correlation id.
  Messages arrive at least once, so "charge the card" will be delivered twice one day.
- **Compensations must be able to fail and retry** without human help, so they go through the
  same outbox, retry and DLQ machinery as the forward steps.
- **Timeouts are first-class events.** "No `PaymentSucceeded` within 15 min → cancel" is a
  scheduled message (MassTransit's scheduler, Wolverine's scheduled messages, or a `due_at`
  column polled by a job), not a `Task.Delay` in memory.
- **Ordering per entity, not globally.** Kafka keeps order only within a partition, so the
  partition key is the entity whose events must stay ordered (`orderId`). A key with a few huge
  values (one `tenantId` for your biggest customer) makes a hot partition, and adding partitions
  later moves keys between partitions and breaks ordering during the change. RabbitMQ and
  Service Bus offer the same idea as single-active-consumer queues or *sessions*.

In .NET, MassTransit **state machine sagas** and Wolverine **sagas** persist the state and
correlate messages for you. For long workflows with many timers (days, human approvals), teams
reach for a **workflow engine** instead: Temporal, or Durable Task / Durable Functions on Azure.
These record each step durably and replay the workflow code after a crash.

:::quiz id=cl-04-q9 xp=15
An order saga reserves stock, then charges the card. The `ChargeCard` handler times out calling
the payment provider, and the saga runs its compensation, `ReleaseStock`. Ten seconds later the
provider's webhook reports the charge **succeeded**. What design would have prevented a customer
being charged for an order you cancelled?
- [ ] Wrap reserve, charge and release in one distributed transaction (2PC) across the services
- [x] Treat "timed out" as *unknown*, not *failed*: query the provider using the idempotency key (or wait for its final status) before compensating, and if a late success arrives for a cancelled saga, compensate it too with a refund
- [ ] Increase the HTTP timeout to 5 minutes so the call never times out
- [ ] Use choreography instead of orchestration, so no central timeout exists
> A timeout tells you *you* stopped waiting, not that the other side did nothing. That is the same
> "did my command run?" problem as a command that timed out during a Redis failover. The safe pattern is to send the charge with an
> idempotency key, resolve unknown outcomes by asking the provider (or waiting for its webhook), and
> make the saga handle late events in every state: a `PaymentSucceeded` for a cancelled order
> triggers a refund. 2PC across a payment provider doesn't exist, a longer timeout only moves the
> problem, and choreography has the same race without a single place to see it.
:::

:::pro title="Outbound webhooks are an outbox with strangers on the other end"
When *your* product notifies customers' systems (`order.paid` to their URL), reuse everything above.
Write the event to the outbox in the business transaction. A delivery worker POSTs it with an
**event id** the receiver can deduplicate on, a **timestamp**, and an **HMAC-SHA256 signature** of
`timestamp + body` with a per-customer secret, so receivers can verify it and reject replays.
Retry with exponential backoff and jitter for hours, not seconds, and disable an endpoint after
days of failures. Keep a delivery log per attempt (status, latency, response snippet) and give
customers a **replay** button. Their DLQ is your support ticket otherwise.
:::

## Lab: RabbitMQ with manual acks and a dead-letter exchange

:::lab id=cl-04-lab1 xp=120
title: Orders over RabbitMQ: publisher confirms, manual acks, retry, DLX
You'll run RabbitMQ 4 in Docker Compose and write a .NET 10 console app that **publishes** orders with
publisher confirms and **consumes** them with manual acks and prefetch. A transient failure is
retried via requeue, and an invalid order goes to a dead-letter queue through a DLX.

**Prerequisites:** Docker with Compose v2 and the .NET 10 SDK.

**1. Start RabbitMQ.** Create a folder and `compose.yaml`:

```bash
mkdir -p ~/devquest/cl-04-lab1 && cd ~/devquest/cl-04-lab1
```

```yaml
# compose.yaml
services:
  rabbitmq:
    image: rabbitmq:4-management
    hostname: rabbit1              # the node name (and its data dir) depends on the hostname, so pin it
    ports:
      - "5672:5672"                # AMQP
      - "15672:15672"              # management UI
    environment:
      RABBITMQ_DEFAULT_USER: devquest
      RABBITMQ_DEFAULT_PASS: devquest
    volumes:
      - rabbitmq-data:/var/lib/rabbitmq
    healthcheck:
      test: ["CMD", "rabbitmq-diagnostics", "-q", "ping"]
      interval: 5s
      timeout: 5s
      retries: 20

volumes:
  rabbitmq-data:
```

```bash
docker compose up -d --wait
docker compose exec rabbitmq rabbitmqctl version
```

Expected: `--wait` returns once the container is healthy, and the second command prints a `4.x.y`
version. Open http://localhost:15672 and log in with `devquest` / `devquest`.

**2. Create the app.**

```bash
dotnet new console -n OrdersDemo -f net10.0
cd OrdersDemo
dotnet add package RabbitMQ.Client
```

This lab uses the **RabbitMQ.Client 7.x** API, which is fully async (`CreateConnectionAsync`,
`CreateChannelAsync`, `AsyncEventingBasicConsumer.ReceivedAsync`).

:::warn
RabbitMQ.Client 6.x tutorials use synchronous methods (`CreateModel`, `BasicPublish`, `Received`)
that don't exist in 7.x. If `dotnet add package` gave you a version other than 7.x, adapt the code
with the [.NET client guide](https://www.rabbitmq.com/client-libraries/dotnet-api-guide), or pin
`--version 7.*`. The `CreateChannelOptions` used for publisher confirms changed shape during the 7.x
release candidates; if that line doesn't compile, copy the current form from the guide's
"Publisher Confirms" section.
:::

Replace `Program.cs` with:

```csharp
using System.Text.Json;
using RabbitMQ.Client;
using RabbitMQ.Client.Events;

var mode = args.FirstOrDefault() ?? "help";
var json = JsonSerializerOptions.Web;

var factory = new ConnectionFactory { HostName = "localhost", UserName = "devquest", Password = "devquest" };
await using var connection = await factory.CreateConnectionAsync();
// Publisher confirms + tracking: BasicPublishAsync awaits the broker's ack and throws on nack.
await using var channel = await connection.CreateChannelAsync(
    new CreateChannelOptions(publisherConfirmationsEnabled: true, publisherConfirmationTrackingEnabled: true));

await DeclareTopologyAsync(channel);

switch (mode)
{
    case "publish": await PublishAsync(); break;
    case "consume": await ConsumeAsync(); break;
    default: Console.WriteLine("usage: dotnet run -- publish | consume"); break;
}

async Task PublishAsync()
{
    OrderPlaced[] orders =
    [
        new(1, 19.99m, "eu", null),
        new(2, 5.00m, "us", null),
        new(3, 42.00m, "eu", "flaky"),     // fails once with a "timeout", succeeds on redelivery
        new(4, -45.00m, "eu", null),       // invalid → dead-lettered
        new(5, 12.50m, "us", null),
    ];
    foreach (var o in orders)
    {
        var props = new BasicProperties
        {
            Persistent = true,
            MessageId = Guid.CreateVersion7().ToString(),
            ContentType = "application/json",
            Type = "orders.placed.v1",
        };
        var body = JsonSerializer.SerializeToUtf8Bytes(o, json);
        await channel.BasicPublishAsync("orders", $"order.placed.{o.Region}", mandatory: false, basicProperties: props, body: body);
        Console.WriteLine($"published order {o.OrderId} -> order.placed.{o.Region} (confirmed)");
    }
}

async Task ConsumeAsync()
{
    await channel.BasicQosAsync(prefetchSize: 0, prefetchCount: 5, global: false);
    var consumer = new AsyncEventingBasicConsumer(channel);
    consumer.ReceivedAsync += async (_, ea) =>
    {
        var order = JsonSerializer.Deserialize<OrderPlaced>(ea.Body.Span, json)!;
        try
        {
            if (order.Amount < 0)
            {
                Console.WriteLine($"DLQ    order {order.OrderId}: invalid amount {order.Amount} -> nack(requeue: false)");
                await channel.BasicNackAsync(ea.DeliveryTag, multiple: false, requeue: false);
                return;
            }
            if (order.Note == "flaky" && !ea.Redelivered)
                throw new TimeoutException("billing API timed out");

            Console.WriteLine($"ok     order {order.OrderId} ({ea.RoutingKey}) amount={order.Amount} redelivered={ea.Redelivered}");
            await channel.BasicAckAsync(ea.DeliveryTag, multiple: false);
        }
        catch (TimeoutException ex)
        {
            Console.WriteLine($"retry  order {order.OrderId}: {ex.Message} -> nack(requeue: true)");
            await channel.BasicNackAsync(ea.DeliveryTag, multiple: false, requeue: true);
        }
    };
    await channel.BasicConsumeAsync("billing.orders", autoAck: false, consumer: consumer);
    Console.WriteLine("consuming billing.orders (prefetch 5). Ctrl+C to stop.");

    var stop = new TaskCompletionSource();
    Console.CancelKeyPress += (_, e) => { e.Cancel = true; stop.TrySetResult(); };
    await stop.Task;
}

static async Task DeclareTopologyAsync(IChannel ch)
{
    // Main topic exchange and the dead-letter exchange
    await ch.ExchangeDeclareAsync("orders", ExchangeType.Topic, durable: true);
    await ch.ExchangeDeclareAsync("orders.dlx", ExchangeType.Fanout, durable: true);

    // Parking lot for dead messages
    await ch.QueueDeclareAsync("billing.orders.dlq", durable: true, exclusive: false, autoDelete: false,
        arguments: new Dictionary<string, object?> { ["x-queue-type"] = "quorum" });
    await ch.QueueBindAsync("billing.orders.dlq", "orders.dlx", routingKey: "");

    // Work queue: quorum, dead-letters to orders.dlx, delivery limit as a safety net against hot loops
    await ch.QueueDeclareAsync("billing.orders", durable: true, exclusive: false, autoDelete: false,
        arguments: new Dictionary<string, object?>
        {
            ["x-queue-type"] = "quorum",
            ["x-dead-letter-exchange"] = "orders.dlx",
            ["x-delivery-limit"] = 5,
        });
    await ch.QueueBindAsync("billing.orders", "orders", routingKey: "order.placed.*");
}

record OrderPlaced(int OrderId, decimal Amount, string Region, string? Note);
```

**3. Publish while nobody is consuming.** The messages wait in the queue:

```bash
dotnet run -- publish
docker compose -f ../compose.yaml exec rabbitmq rabbitmqctl list_queues name type messages_ready messages_unacknowledged
```

Expected output (header lines may differ slightly):

```text
published order 1 -> order.placed.eu (confirmed)
published order 2 -> order.placed.us (confirmed)
published order 3 -> order.placed.eu (confirmed)
published order 4 -> order.placed.eu (confirmed)
published order 5 -> order.placed.us (confirmed)

name                type    messages_ready  messages_unacknowledged
billing.orders      quorum  5               0
billing.orders.dlq  quorum  0               0
```

**4. Consume.**

```bash
dotnet run -- consume
```

Expected output (the position of the `retry`/redelivered lines may vary):

```text
consuming billing.orders (prefetch 5). Ctrl+C to stop.
ok     order 1 (order.placed.eu) amount=19.99 redelivered=False
ok     order 2 (order.placed.us) amount=5.00 redelivered=False
retry  order 3: billing API timed out -> nack(requeue: true)
DLQ    order 4: invalid amount -45.00 -> nack(requeue: false)
ok     order 5 (order.placed.us) amount=12.50 redelivered=False
ok     order 3 (order.placed.eu) amount=42.00 redelivered=True
```

Press Ctrl+C, then check the queues again:

```bash
docker compose -f ../compose.yaml exec rabbitmq rabbitmqctl list_queues name messages_ready messages_unacknowledged
```

`billing.orders` should be at `0 0` and `billing.orders.dlq` at `1 0`. In the management UI, open
**Queues → billing.orders.dlq → Get messages**: the dead-lettered order 4 is there with an
`x-death` header describing why and where it died.

**5. See at-least-once redelivery.** This step simulates "the work was done, but the process died
before it acked".

1. In `Program.cs`, comment out the line `await channel.BasicAckAsync(ea.DeliveryTag, multiple: false);`.
2. Publish again with `dotnet run -- publish`, then start `dotnet run -- consume`. It prints the same
   `ok` / `retry` / `DLQ` lines as in step 4, but now it never acks.
3. **While the consumer is still running**, open a second terminal in `OrdersDemo` and run:

   ```bash
   docker compose -f ../compose.yaml exec rabbitmq rabbitmqctl list_queues name messages_ready messages_unacknowledged
   ```

   ```text
   billing.orders      0  4
   billing.orders.dlq  2  0
   ```

   Orders 1, 2, 3 and 5 were "handled" but are still unacked, so the broker keeps them reserved for
   this consumer. Order 4 was dead-lettered a second time.
4. Press Ctrl+C in the consumer terminal and run `list_queues` again: `billing.orders` is now at
   `4 0`. The connection closed with nothing acked, so RabbitMQ put all four back.
5. Restore the ack line and run `dotnet run -- consume` once more. All four are processed again with
   `redelivered=True`. In a real system, that second run is exactly the duplicate your idempotent
   consumer (the inbox) must absorb.

**6. Clean up:** `docker compose -f ../compose.yaml down -v`.

:::tip title="Stretch goals"
- Add a `billing.orders.retry` queue with `x-message-ttl: 10000` and `x-dead-letter-exchange: orders`.
  Have transient failures publish there instead of requeueing, for a real 10-second delayed retry.
- Add the inbox: dedupe on `ea.BasicProperties.MessageId` with a `HashSet<string>` first, then a
  Postgres `inbox` table.
- Write a `replay` mode that moves messages from `billing.orders.dlq` back to the `orders` exchange.
:::

- [ ] `docker compose up -d --wait` starts RabbitMQ 4 and the management UI works on port 15672
- [ ] `dotnet run -- publish` prints five confirmed publishes and `list_queues` shows 5 ready messages
- [ ] The consumer acks 4 orders, order 3 succeeds on redelivery, and order 4 is in `billing.orders.dlq`
- [ ] I inspected the dead-lettered message and its `x-death` header in the management UI
- [ ] With the ack removed, `list_queues` showed 4 unacked messages while the consumer ran, 4 ready after it stopped, and the next run printed `redelivered=True`
:::

## Flashcards

:::cards id=cl-04-cards1 xp=15 title="Brokers, outbox and delivery semantics"
Q: Queue vs log in one sentence?
A: A queue deletes a message once one consumer acks it (work distribution). A log keeps messages
   for its retention period and each consumer group tracks its own offset (replay, many readers).
Q: RabbitMQ: exchange, binding, routing key?
A: Producers publish to an exchange with a routing key, and bindings (exact, `*`/`#` patterns, or
   fanout) decide which queues get a copy.
Q: What does prefetch (`BasicQos`) control?
A: The maximum number of unacked messages a consumer may hold at once. It controls fairness and
   memory, and has nothing to do with deduplication.
Q: How do you get ordering in Kafka?
A: Only per partition: use the entity id as the message key, so all its events land in the same
   partition.
Q: At-least-once + idempotent consumer = ?
A: Effectively-once processing. True exactly-once delivery across a network isn't achievable.
Q: What is the dual-write problem?
A: Writing to the DB and publishing to a broker are two separate writes, so one can succeed while
   the other fails, leaving orders without events or events without orders.
Q: What is the transactional outbox?
A: Insert the message into an outbox table in the same DB transaction as the business change. A
   relay publishes pending rows in order and marks them sent. It gives at-least-once delivery.
Q: Why must the inbox insert be in the same transaction as the side effect?
A: Recording before the work and crashing skips real work. Recording after, in a separate
   transaction, allows double processing. The same transaction makes both atomic.
Q: Transient vs permanent failure handling?
A: Transient: retry with exponential backoff plus jitter, up to N attempts. Permanent/poison: send
   to the DLQ immediately, never requeue in a hot loop.
Q: Why jitter?
A: So that many consumers that failed at the same moment don't retry in lockstep and overload the
   recovering dependency again (thundering herd).
Q: Which contract changes are safe?
A: Adding optional fields, and publishing a new versioned type alongside the old one. Renames,
   removals and unit/meaning changes are breaking.
Q: Outbox relay high-water-mark trap?
A: Identity order isn't commit order. `WHERE id > lastSeen` can permanently skip a row that commits
   late, so poll `sent_at IS NULL` or use CDC.
:::

## Recap

- **Queues** distribute work and delete acked messages. **Logs** retain messages, so many consumer
  groups can read and replay them. Choose by whether you need history and fan-out.
- **RabbitMQ:** exchanges + bindings + routing keys, manual acks, sensible prefetch, quorum queues,
  publisher confirms, and a **DLX** on every queue. **Kafka:** partitions, ordering per key,
  consumer groups, offsets committed after processing, and retention instead of deletion.
- **Redis Streams** are a lightweight log. A **Postgres SKIP LOCKED** queue is often the most
  pragmatic choice for background jobs because enqueueing is transactional.
- Delivery is realistically **at-least-once**. Make consumers **idempotent** (inbox table in the
  same transaction, idempotency keys, naturally idempotent updates) to get effectively-once results.
- The **dual-write problem** has one standard fix: the **transactional outbox**, with a relay that
  publishes in order, stops on failure, marks rows sent after confirmation, and doesn't trust `id`
  as commit order.
- Retry **transient** failures with exponential backoff and full jitter. Dead-letter **permanent**
  ones immediately. Alert on DLQ depth and have a replay path.
- Treat messages as **versioned public contracts**: envelope with id/type/version/correlation,
  tolerant readers, additive changes, and side-by-side versions for breaking changes.
- In .NET, **MassTransit** or **Wolverine** implement the outbox, inbox and retries for you. Check
  current licensing before you standardise.
- Multi-step processes are **sagas**: local transactions plus idempotent compensations, with
  timeouts as scheduled messages and ordering kept per entity (the partition key).
- On Azure and AWS the broker is usually managed (Service Bus queues and topics, SQS + SNS, Event
  Hubs or MSK for Kafka). The patterns are identical; **The Managed Equivalents: Azure & AWS**
  shows what each service gives you built in (DLQs, sessions, duplicate detection).
