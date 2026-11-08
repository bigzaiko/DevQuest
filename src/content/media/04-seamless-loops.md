---
id: med-04
title: "Seamless loops: from the loop attribute to appending laps"
level: advanced
minutes: 65
xp: 190
summary: Why `loop` and "seek back to 0" hitch, and how MSE players build a rolling loop by appending the same segments again further down the timeline, trimming old laps and exiting cleanly.
---

A product page has a 6-second hero video of coffee being poured, set to repeat forever. A meditation app plays
a 20-second ambient clip under a timer. A game menu loops a background scene. In all three, the designer's
requirement is the same and sounds trivial: **nobody should be able to tell where the loop restarts**.

Then you ship `<video loop>` and someone notices: every six seconds there is a tiny freeze, sometimes a flash
of black, and the soundtrack has a click or a short silence. This lesson explains *why* that happens, and the
technique Media Source Extensions (MSE) players use to avoid it: instead of jumping back to the start, they
**append the same media again further along the timeline**, so playback never jumps at all. We'll call each
repetition a **lap**, and the whole arrangement an **appended-laps loop** or **rolling loop**.

You should know frames, keyframes and GOPs from *Video in the browser: frames, codecs and keyframes*, and
`MediaSource` / `SourceBuffer` / `appendBuffer()` from *Streaming: HLS playlists and Media Source Extensions*.

## Why `loop` can hitch

The HTML standard defines the `loop` attribute very simply: when playback reaches the end of the media and
`loop` is set, the element **seeks to the earliest possible position** and carries on (no `ended` event is
fired). Writing it yourself looks the same:

```ts
video.addEventListener('ended', () => {
  video.currentTime = 0
  void video.play()
})
```

Either way, a loop is a **seek**. And a seek is not free:

1. **The decoder is flushed.** The frames it was holding (including reordered B-frames) are thrown away.
2. **Decoding restarts at a keyframe.** The new position must be decoded from the nearest keyframe at or before
   it. At `t = 0` that's usually right there, but the decoder still needs a few frames of "warm-up" before the
   first picture is ready.
3. **Audio is restarted too.** The audio renderer drains, resets, and starts again from the first audio frame,
   which for AAC can include encoder *priming* samples if the player doesn't trim them (the topic of *Clean sound at a seam: AAC frames, priming
   and cross-fades*).
4. **Events fire and the pipeline re-syncs.** `seeking` → (maybe `waiting`) → `seeked`; the clock pauses until
   both audio and video have data at the new position.

```text
      lap ends                       seek back to 0
media time:  ... 5.80  5.84  5.88  5.92  5.96 |  0.00  0.04  0.08 ...
frames:       ▮     ▮     ▮     ▮     ▮       |  .  .  ▮     ▮     ▮
                                              |  ^^^^^
                                     flush + decode from keyframe:
                                     frozen (or black) frame, audio gap
wall clock:   ──────────────────────────────── ▲ ─── stall (device-dependent) ─── ▶
```

How bad it is depends on the browser, the codec, the hardware decoder and whether the media is a plain file or
an MSE stream. Some engines special-case short loops well; many do not, and hardware decoders on phones and TVs
are often the worst. Add network delivery (the start of the file may have been evicted from the cache) and the
stall can stretch to a visible pause with a spinner.

:::info title="Audio has it easier"
For audio-only loops, Web Audio gives you sample-accurate looping:
`const src = ctx.createBufferSource(); src.buffer = decoded; src.loop = true; src.loopStart = 1.5; src.loopEnd = 9.5; src.start()`.
The whole clip is decoded into memory as PCM, so "looping" is just reading the array from the start again —
no decoder restart. Video has no equivalent: you can't keep minutes of decoded frames in memory.
:::

:::quiz id=med-04-q1 xp=10
A 4-second muted background video uses `<video autoplay muted loop playsinline>`. On a mid-range Android phone
there's a short freeze at every restart; on a desktop it's barely visible. What is the most likely cause?

- [ ] The video file is corrupt at the last frame
- [x] Each loop is a seek: the (hardware) decoder is flushed and restarted from the keyframe at 0, and slower decoders take longer to produce the first frame
- [ ] `muted` videos are throttled to 15 fps
- [ ] `loop` re-downloads the entire file on every lap
> The `loop` attribute is specified as a seek to the start. A seek flushes the decode pipeline; how long
> it takes to show the first new frame depends on the decoder, which is why the same file looks fine on one
> device and hitches on another. The file isn't corrupt (it would glitch on desktop too), muted video isn't
> frame-rate throttled for that reason, and a cached file isn't re-downloaded.
:::

## The idea: never go back, keep going forward

The decoder is happy as long as it receives a continuous stream of frames with **increasing timestamps**.
It doesn't care that the pictures in seconds 6–12 are the same pictures as in seconds 0–6. So instead of seeking
back, we give it the loop content again, *stamped with later times*:

```text
source media (one 6 s clip, two 3 s segments, each starting with a keyframe K):

  seg0: K . . . . . . . | seg1: K . . . . . . .
  0s                  3s                      6s

timeline the <video> sees (MSE buffer):

  | lap 0          | lap 1          | lap 2          | lap 3 ...
  | seg0 | seg1    | seg0 | seg1    | seg0 | seg1    |
  0      3         6      9        12     15        18 s
  offset = 0       offset = 6      offset = 12
                     ▲ playback just continues: no seek, no flush
```

`video.currentTime` goes 5.9 → 6.0 → 6.1 without any jump. The decoder sees a keyframe at 6.0 (the first frame
of `seg0`, now stamped 6.0) and decodes on. Audio continues at the same sample clock. The only seam left is
inside the content itself — whether the last frame of the clip matches the first visually, and whether the audio
lines up (med-05).

### The tool: `timestampOffset`

Every MSE `SourceBuffer` has a `timestampOffset` property (seconds). It is **added to the timestamps of every
coded frame in the media segments appended after it was set**. So "append seg0 again at 6 s" is:

```ts
sourceBuffer.timestampOffset = 6   // media time 0 in seg0 lands at timeline 6
sourceBuffer.appendBuffer(seg0)    // the same bytes as the first time
```

You don't append the initialization segment again (it hasn't changed), and you don't need to rewrite the
bytes: the browser shifts the timestamps while parsing.

The general rule for a loop region from media time `A` (loop start) to `B` (loop end), length `L = B − A`, with
lap 0 placed at timeline time `T0`:

```text
lap k starts on the timeline at   S_k = T0 + k·L
media time A must land at S_k  →  timestampOffset_k = S_k − A = T0 + k·L − A
lap k occupies                    [S_k, S_k + L)
```

:::warn title="Compute offsets, don't accumulate them"
Write `T0 + k * L - A`, not `offset += L` in a loop. Repeated floating-point addition drifts
(`0.1` added 1000 times is `99.9999999999986`, while `1000 * 0.1` is exactly `100`), and after a few hundred laps the drift is enough to leave a
microscopic gap or overlap at the seam. Some teams go further and keep times as integers in the media's
timescale (e.g. 90 000 ticks per second) and convert to seconds only when setting the property.
:::

### The `sequence` mode shortcut

`SourceBuffer.mode` can be `"segments"` (the default for most formats: frames are placed by their own timestamps
plus `timestampOffset`) or `"sequence"` (each new media segment is placed right after the previous one, and the
browser updates `timestampOffset` for you). For a whole-file loop, `sequence` mode lets you just append the same
segments over and over:

```ts
sourceBuffer.mode = 'sequence'
for (const seg of [seg0, seg1, seg0, seg1]) {
  sourceBuffer.appendBuffer(seg)
  await whenUpdated(sourceBuffer)   // waits for 'updateend' (defined below)
}
```

It's convenient, but you lose control: you can't easily loop a sub-range, place a lap at an exact time, or keep
separate audio and video `SourceBuffer`s aligned to each other (each one sequences independently, and audio
segments rarely have exactly the same duration as video segments). Players that need precision use `"segments"`
mode with explicit offsets — which is what the rest of this lesson does.

:::quiz id=med-04-q2 xp=10
The loop is media `[0, 6)`, lap 0 was appended with `timestampOffset = 0`. You are about to append lap 3.
Predict: what `timestampOffset` must you set, and where does media time 1.5 s end up on the timeline?

- [ ] Offset `3`, media 1.5 s at timeline 4.5 s
- [x] Offset `18`, media 1.5 s at timeline 19.5 s
- [ ] Offset `18`, media 1.5 s at timeline 18 s
- [ ] Offset `-18`, because you are going back to the start of the media
> `timestampOffset_k = T0 + k·L − A = 0 + 3·6 − 0 = 18`. The offset is *added* to every frame timestamp, so
> media 1.5 s becomes 1.5 + 18 = 19.5 s. A negative offset would move frames into the past — exactly the
> "jump back" we are avoiding.
:::

## A minimal rolling loop

Here is the core of an appended-laps loop with real APIs. It keeps a couple of laps ahead of the playhead and is
deliberately small (error handling and audio are omitted).

```ts
// Promise wrapper: SourceBuffer operations are async and signal completion with 'updateend'.
function whenUpdated(sb: SourceBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sb.addEventListener('updateend', () => resolve(), { once: true })
    sb.addEventListener('error', () => reject(new Error('SourceBuffer error')), { once: true })
  })
}

async function appendLap(sb: SourceBuffer, segments: ArrayBuffer[], lapStart: number, A: number, L: number) {
  sb.timestampOffset = lapStart - A            // only allowed while !sb.updating
  // Trim anything outside this lap (useful for sub-range loops, below).
  sb.appendWindowEnd = lapStart + L            // set End first when moving forward:
  sb.appendWindowStart = lapStart              // Start must always stay < End
  for (const seg of segments) {
    sb.appendBuffer(seg)
    await whenUpdated(sb)
  }
}

const video = document.querySelector('video')!
const ms = new MediaSource()
video.src = URL.createObjectURL(ms)
await new Promise((r) => ms.addEventListener('sourceopen', r, { once: true }))

const sb = ms.addSourceBuffer('video/mp4; codecs="avc1.64001f"')
sb.appendBuffer(initSegment); await whenUpdated(sb)

const A = 0, L = 6, T0 = 0
let nextLap = 0
const LAPS_AHEAD = 2

let busy = false                               // one topUp at a time
async function topUp() {
  if (busy) return
  busy = true
  try {
    while (T0 + nextLap * L < video.currentTime + LAPS_AHEAD * L) {
      await appendLap(sb, [seg0, seg1], T0 + nextLap * L, A, L)
      nextLap++
    }
  } finally {
    busy = false
  }
}
video.addEventListener('timeupdate', () => void topUp())
await topUp()
void video.play()
```

Two things to notice:

- `MediaSource.duration` grows by itself as you append past it. For an endless loop you can set
  `ms.duration = Infinity` so the element never thinks it's near the end (then `video.duration` reports
  `Infinity` and your UI must not draw a normal seek bar from it).
- `video.currentTime` keeps increasing: 6, 60, 600… The *meaning* of a timeline time is now "lap N, X seconds into
  the loop". Your UI and analytics need that mapping — the second challenge below.

## Keeping memory bounded: removing old laps

Every appended lap stays in the `SourceBuffer` until it's removed or the browser evicts it. Browsers cap MSE
memory per `SourceBuffer`; the limit is implementation-defined and much lower on TVs and phones than on desktops.
When an append would exceed it, the browser first runs its own *coded frame eviction*, but which data it drops is
up to the engine. If that can't free enough, `appendBuffer()` throws a `QuotaExceededError` and the loop stops.
Don't rely on eviction: some engines evict little, and some may drop data you still wanted.

The fix is `sourceBuffer.remove(start, end)`: drop laps that are safely **behind** the playhead.

```text
back buffer = 6 s (keep this much behind the playhead for small rewinds)

  | lap 0   | lap 1   | lap 2   | lap 3   | lap 4   |
  0         6        12        18        24        30
                                 ▲ playhead 20.5
                    ◀── 6 s ────┤ keep from 14.5
  [ remove 0 → 12 ] lap 2 straddles 14.5 → keep it whole
```

Why remove **whole laps** rather than exactly `[0, playhead − backBuffer)`? Because of how `remove()` is specified:
after deleting the coded frames in the range, the browser also deletes frames *after* `end` that depend on them,
**up to the next random access point (keyframe)**. Cut at 14.5 s in the middle of a GOP and you silently lose
frames up to the next keyframe — which may be right where the user rewinds to. Lap boundaries are keyframes (each
lap starts with the loop's first segment), so cutting at a lap start never removes anything you didn't ask for.

```ts
const BACK_BUFFER = 6
async function trim() {
  const keepFrom = video.currentTime - BACK_BUFFER
  const oldLaps = Math.floor((keepFrom - T0) / L)        // laps fully before keepFrom
  if (oldLaps <= 0 || sb.updating) return
  sb.remove(0, T0 + oldLaps * L)                           // also: only while !sb.updating
  await whenUpdated(sb)
}
```

:::quiz id=med-04-q3 xp=10
Your code calls `sb.remove(0, video.currentTime - 2)` every second. Playback is at 20.5 s, GOPs are 2 s long
(keyframes at 18, 20, 22…). Predict what happens to the buffer just around 18.5 → 20 s.

- [ ] Nothing: `remove()` only deletes inside `[0, 18.5)`
- [x] Frames from 18.5 up to the keyframe at 20 are removed too, because they depend on the removed keyframe at 18
- [ ] The browser throws, because `end` must be a keyframe
- [ ] Playback jumps back to 0
> The spec's removal algorithm deletes the requested frames *and* every frame after `end` that depends on them,
> until the next random access point. That's 18.5 → 20 here. It doesn't affect playback at 20.5 right now, but a
> 1-second rewind lands in a hole (and stalls). Remove at keyframe/lap boundaries, and keep a real back buffer.
:::

## Looping a sub-range of a longer stream

Often the loop isn't the whole file. A 2-minute product video has a 10-second "idle" section `[42, 52)` that
should loop until the user clicks "Continue". Same technique, two extra rules:

1. **The loop start `A` must be a keyframe** (in practice: a segment start). Frames before `appendWindowStart` are
   dropped while appending, and after dropping one the browser waits for the next keyframe before accepting
   frames again. Start mid-GOP and the first part of every lap is missing. Ask whoever encodes the video to
   force keyframes at the loop points (for example `ffmpeg -force_key_frames 42,52 …`) and ideally cut segments
   there too.
2. **The loop end `B` is enforced with `appendWindowEnd`.** Append the segments that cover `[A, B)` and set the
   append window to `[S_k, S_k + L)`: frames that would end past the window are dropped, so the next lap can start
   exactly at `S_k + L` with no overlap.

```text
source:  ... seg13 | seg14 (K@42) | seg15 | seg16 | seg17 (K@50 … K@52) ...
                   A=42                          B=52

lap k (offset = S_k − 42), append window [S_k, S_k+10):
         | seg14 | seg15 | seg16 | seg17 |
         S_k                        ✂ frames ≥ S_k+10 dropped
```

Playback of a sub-range loop usually begins *linearly*: the user watches 0 → 42 as normal, and lap 0 is simply
the original `[42, 52)` already in the buffer, so `T0 = 42` and `timestampOffset_0 = 0`. From lap 1 on,
`timestampOffset_k = 42 + k·10 − 42 = k·10`. One catch: the linear append of the segment that contains `B`
also buffers frames from 52 on. Append that segment with `appendWindowEnd = 52` (or `remove(52, Infinity)` before
lap 1), so the media after `B` doesn't sit under lap 1.

:::cards id=med-04-cards1 xp=15 title="Seamless loops"
Q: Why does the `loop` attribute often hitch?
A: Looping is specified as a seek to the start. A seek flushes the decoder, restarts decoding at a keyframe and
   resets audio. On many devices that is a visible stall.
Q: What is an appended-laps (rolling) loop?
A: Appending the same media segments again at later timeline positions (via `timestampOffset`) so playback keeps
   moving forward through repeated content instead of seeking back.
Q: Formula for lap k's `timestampOffset`?
A: `T0 + k·L − A`, where `A` is the loop start in media time, `L = B − A` the loop length, `T0` where lap 0 starts
   on the timeline.
Q: Why remove old laps at lap boundaries?
A: `remove()` also deletes frames after `end` that depend on removed frames, up to the next keyframe. Lap starts
   are keyframes, so nothing extra is lost.
Q: What error appears if old laps are never removed?
A: `QuotaExceededError` from `appendBuffer()` once the SourceBuffer's memory cap is reached and the browser's own eviction can't free enough.
Q: Which append-window property do you set first when moving the window forward?
A: `appendWindowEnd`, because `appendWindowStart` must always stay below `appendWindowEnd` (otherwise a `TypeError`).
Q: Where must loop points sit in the encoded video?
A: On keyframes (ideally segment boundaries), at least the loop start, and the loop end if you want to exit cleanly into what follows.
:::

## Exiting the loop

The user clicks "Continue". The content after `B` (media `52 → 120`) must now follow — but the buffer ahead of the
playhead is full of *future laps* you appended earlier. Two cases:

```text
playhead at 63.2, laps ahead already appended:

  | lap 2: 62–72       | lap 3: 72–82       | lap 4: 82–92 |
         ▲ 63.2
exit at end of current lap:
  | lap 2: 62–72       | after-loop: media 52→… placed at 72 (offset = 72 − 52 = 20)
                       ▲ remove(72, Infinity), then append
```

1. **Exit at the next lap boundary (clean, most common).** `remove(nextLapStart, Infinity)` to drop the future laps
   (cutting at a lap start is safe for the frames before it). Then **reset the append window**: it still holds the
   last lap's `[S_k, S_k + L)`, which would drop all the new frames. Set `appendWindowStart = nextLapStart` first
   (when moving it backward), then `appendWindowEnd = Infinity`. Finally, append the post-loop segments with
   `timestampOffset = nextLapStart − B`. The viewer finishes the current lap and continues seamlessly into what
   follows, because `B` is a keyframe in the source too. Only do this if `nextLapStart` is far enough ahead to
   fetch and append the next segment in time — otherwise choose the lap boundary after that.
2. **Exit now.** If waiting up to `L` seconds is unacceptable, you need a jump: either a real seek to a keyframe in
   the post-loop content or a crossfade/cut you author — the trade-offs are the topic of *Jumping along a path:
   seeking without stutter*.

After the exit, timeline time and media time differ by a permanent offset (`20` in the example). Captions, chapter
markers and analytics that are keyed to media time must subtract it.

:::quiz id=med-04-q4 xp=10
Laps 2–4 are buffered (62–92). The user exits at 63.2 and your code appends the post-loop content at 72 with the
right offset — but forgets to call `remove(72, Infinity)` first. Only the first 4-second post-loop segment has
been appended so far. Predict what the buffer holds from 72 to 92 s.

- [ ] Only post-loop content: an append clears everything buffered after its start
- [x] Post-loop frames where the new segment landed, and leftover lap frames beyond it that can play if the next fetch is late
- [ ] An exception: you can't append over buffered data
- [ ] Black, because two appends at the same time cancel each other
> Appending over buffered data is allowed. The new frames replace the old ones only over the span they cover,
> plus old frames that depended on them up to the next keyframe. Everything past that (the rest of laps 3 and 4)
> stays in the buffer. If the next post-loop fetch is late, the viewer sees old loop content instead of a stall.
> Engines also differ at the edges, especially for audio. Removing the stale future first makes the buffer match
> your intent.
:::

## Challenge: plan the laps and the clean-up

:::challenge id=med-04-c1 lang=ts xp=60
title: Lap offsets and old-lap removal
Write two pure functions for a rolling loop over media `[loopStart, loopEnd)`.

1. `planLaps(loopStart, loopEnd, firstLapAt, count)` returns `count` laps, each
   `{ lap, timestampOffset, start, end }`, where lap `k` starts on the timeline at `firstLapAt + k·L`
   (`L = loopEnd − loopStart`), ends at `start + L`, and `timestampOffset` maps `loopStart` onto `start`.
   Compute each lap from `k` directly — don't accumulate.
2. `rangeToRemove(laps, playhead, backBuffer)` returns one `{ start, end }` covering every lap that ends at or
   before `playhead − backBuffer` (they are contiguous, so one range is enough: first such lap's start → last such
   lap's end), or `null` if there is none. Never cut through a lap.

hint: `timestampOffset = start − loopStart`.
hint: For removal, `filter` the laps with `lap.end <= playhead - backBuffer`, then take the first `start` and the last `end`.
hint: A lap that only *partly* lies before `playhead − backBuffer` must be kept whole.

```ts starter
type Lap = { lap: number; timestampOffset: number; start: number; end: number }

export function planLaps(loopStart: number, loopEnd: number, firstLapAt: number, count: number): Lap[] {
  const L = loopEnd - loopStart
  const laps: Lap[] = []
  let start = firstLapAt
  for (let k = 0; k < count; k++) {
    laps.push({ lap: k, timestampOffset: start, start, end: start + L })
    start += L
  }
  return laps
}

export function rangeToRemove(laps: Lap[], playhead: number, backBuffer: number): { start: number; end: number } | null {
  return { start: 0, end: playhead - backBuffer }
}
```

```ts solution
type Lap = { lap: number; timestampOffset: number; start: number; end: number }

export function planLaps(loopStart: number, loopEnd: number, firstLapAt: number, count: number): Lap[] {
  const L = loopEnd - loopStart
  const laps: Lap[] = []
  for (let k = 0; k < count; k++) {
    const start = firstLapAt + k * L
    laps.push({ lap: k, timestampOffset: start - loopStart, start, end: start + L })
  }
  return laps
}

export function rangeToRemove(laps: Lap[], playhead: number, backBuffer: number): { start: number; end: number } | null {
  const keepFrom = playhead - backBuffer
  const old = laps.filter((l) => l.end <= keepFrom)
  if (old.length === 0) return null
  return { start: old[0].start, end: old[old.length - 1].end }
}
```

```ts tests
test('whole-file loop from 0: offsets are k * L', () => {
  const laps = planLaps(0, 6, 0, 4)
  expect(laps.map((l) => l.timestampOffset)).toEqual([0, 6, 12, 18])
  expect(laps[3]).toEqual({ lap: 3, timestampOffset: 18, start: 18, end: 24 })
})

test('sub-range loop [42, 52) starting in place', () => {
  const laps = planLaps(42, 52, 42, 3)
  expect(laps.map((l) => l.start)).toEqual([42, 52, 62])
  expect(laps.map((l) => l.timestampOffset)).toEqual([0, 10, 20])
  expect(laps[2].end).toBe(72)
})

test('sub-range loop placed elsewhere on the timeline', () => {
  const laps = planLaps(10, 14, 100, 2)
  expect(laps[0].timestampOffset).toBe(90)
  expect(laps[1]).toEqual({ lap: 1, timestampOffset: 94, start: 104, end: 108 })
})

test('no drift after many short laps', () => {
  const laps = planLaps(0, 0.1, 0, 1001)
  expect(laps[1000].start).toBe(1000 * 0.1)
})

test('removes only whole laps behind the back buffer', () => {
  const laps = planLaps(0, 6, 0, 5)
  // keepFrom = 14.5: laps 0 and 1 (0-12) are old, lap 2 (12-18) straddles it
  expect(rangeToRemove(laps, 20.5, 6)).toEqual({ start: 0, end: 12 })
})

test('a lap ending exactly at keepFrom is removed', () => {
  const laps = planLaps(0, 6, 0, 5)
  expect(rangeToRemove(laps, 18, 6)).toEqual({ start: 0, end: 12 })
})

test('nothing to remove yet', () => {
  const laps = planLaps(0, 6, 0, 3)
  expect(rangeToRemove(laps, 7, 6)).toBeNull()
})

test('works with already-trimmed lap lists', () => {
  const laps = planLaps(42, 52, 42, 6).slice(2) // laps 2..5: 62-102
  expect(rangeToRemove(laps, 95, 5)).toEqual({ start: 62, end: 82 })
})
```
:::

## Challenge: where are we in the loop?

The seek bar shouldn't show "07:43" for a 10-second idle loop that has been running for a while; it should show the
loop-local position, and analytics want "lap 46". That's a mapping from timeline time back to `(lap, mediaTime)`.

:::challenge id=med-04-c2 lang=ts xp=50
title: Timeline time to loop position
Write `loopPosition(t, firstLapAt, loopStart, loopEnd)` returning `{ lap, mediaTime }` for timeline time `t`:

- `lap` = which lap `t` falls in (lap 0 starts at `firstLapAt`, each lap is `L = loopEnd − loopStart` long),
- `mediaTime` = the position inside the source media, between `loopStart` (inclusive) and `loopEnd` (exclusive).
- If `t < firstLapAt`, the loop hasn't started: return `null`.
- Floating-point times arrive slightly off. A time within `1e-6` **below** a lap boundary counts as the start of
  the next lap (so you never report `mediaTime ≈ loopEnd`).

hint: `const elapsed = t - firstLapAt; let lap = Math.floor(elapsed / L)`.
hint: `mediaTime = loopStart + (elapsed - lap * L)`. If that is within `1e-6` of `loopEnd`, move to `lap + 1` and `mediaTime = loopStart`.
hint: Avoid `%` on negative numbers — handle `t < firstLapAt` first.

```ts starter
export function loopPosition(t: number, firstLapAt: number, loopStart: number, loopEnd: number): { lap: number; mediaTime: number } | null {
  return { lap: 0, mediaTime: t % (loopEnd - loopStart) }
}
```

```ts solution
export function loopPosition(t: number, firstLapAt: number, loopStart: number, loopEnd: number): { lap: number; mediaTime: number } | null {
  if (t < firstLapAt) return null
  const L = loopEnd - loopStart
  const elapsed = t - firstLapAt
  let lap = Math.floor(elapsed / L)
  let mediaTime = loopStart + (elapsed - lap * L)
  if (loopEnd - mediaTime <= 1e-6) {
    lap += 1
    mediaTime = loopStart
  }
  return { lap, mediaTime }
}
```

```ts tests
test('inside lap 0', () => {
  expect(loopPosition(1.5, 0, 0, 6)).toEqual({ lap: 0, mediaTime: 1.5 })
})

test('later lap of a whole-file loop', () => {
  const p = loopPosition(19.5, 0, 0, 6)!
  expect(p.lap).toBe(3)
  expect(p.mediaTime).toBeCloseTo(1.5, 9)
})

test('sub-range loop [42, 52) started in place', () => {
  const p = loopPosition(63.2, 42, 42, 52)!
  expect(p.lap).toBe(2)
  expect(p.mediaTime).toBeCloseTo(43.2, 9)
})

test('loop placed elsewhere on the timeline', () => {
  const p = loopPosition(105, 100, 10, 14)!
  expect(p.lap).toBe(1)
  expect(p.mediaTime).toBeCloseTo(11, 9)
})

test('exactly on a boundary is the start of the next lap', () => {
  expect(loopPosition(12, 0, 0, 6)).toEqual({ lap: 2, mediaTime: 0 })
})

test('a hair below a boundary snaps to the next lap', () => {
  expect(loopPosition(12 - 1e-9, 0, 0, 6)).toEqual({ lap: 2, mediaTime: 0 })
  expect(loopPosition(52 - 1e-9, 42, 42, 52)).toEqual({ lap: 1, mediaTime: 42 })
})

test('mediaTime stays inside the loop', () => {
  for (let t = 42; t < 200; t += 0.37) {
    const p = loopPosition(t, 42, 42, 52)!
    expect(p.mediaTime).toBeGreaterThanOrEqual(42)
    expect(p.mediaTime).toBeLessThan(52)
  }
})

test('before the loop starts', () => {
  expect(loopPosition(30, 42, 42, 52)).toBeNull()
})
```
:::

## How it breaks in practice

| Symptom | Likely cause | How to detect / fix |
| --- | --- | --- |
| Tiny stall at every seam after hours of looping | Offsets accumulated with `+=` drift; or `L` taken from the playlist's rounded `#EXTINF` instead of the real media duration | Log `sb.buffered` — more than one range near the seam means a gap. Compute `T0 + k·L − A`, and take `L` from the actual frame timestamps (or `buffered` after appending lap 0) |
| First half-second of each lap missing (frozen frame, then motion) | Loop start isn't a keyframe; frames until the next keyframe are dropped by the append window | Check keyframe positions (`ffprobe -select_streams v:0 -skip_frame nokey -show_entries frame=pts_time -of csv input.mp4`); re-encode with forced keyframes at loop points |
| Loop works for a while, then stops (sooner on TVs) | Old laps never removed, and eviction can't keep up → `QuotaExceededError` | Wrap `appendBuffer` in `try/catch`, log the error name; trim behind the playhead at lap boundaries |
| Rewinding a few seconds stalls | `remove()` cut mid-GOP and took extra frames with it, or the back buffer is 0 | Inspect `buffered` after each `remove()`; remove whole laps only |
| `InvalidStateError` in the console | `timestampOffset`, `appendWindow*`, `appendBuffer` or `remove` called while `sb.updating` is true (two timers racing) | Serialize all SourceBuffer operations through one queue; wait for `updateend` |
| `TypeError` when moving the append window | Set `appendWindowStart` past the old `appendWindowEnd` | Set `appendWindowEnd` first when moving forward |
| Audio click at each seam, video perfect | Audio segment boundaries ≠ video boundaries; AAC priming samples at the start of every lap | Trim audio with the append window (engines differ in whether they cut partial audio frames there), see *Clean sound at a seam* |
| Seek bar shows huge or `Infinity` duration | UI reads `video.duration` / `currentTime` directly | Map timeline → loop position (challenge 2) for display |
| After exiting, captions are 20 s late | Captions keyed to media time, playhead now on shifted timeline | Keep the final `timestampOffset` and subtract it |

Useful runtime signals: `waiting` events on the element (a stall), `video.getVideoPlaybackQuality().droppedVideoFrames`
(jank), and a periodic dump of `sb.buffered` as `[start, end]` pairs. A healthy rolling loop has exactly **one**
buffered range that starts a back-buffer behind the playhead and ends one or two laps ahead.

:::job title="What you'll be asked to do"
Typical tickets: "the hero video blinks every loop on Safari/TV", "the ambient loop dies after 20 minutes on the
kiosk", "make the idle section loop until the user clicks Next". Expect to read `buffered` ranges in DevTools
(Chrome's `chrome://media-internals` and the Media panel show buffered ranges, seeks and decoder errors), and to
talk to whoever encodes the video about keyframe placement.
:::

:::pro title="What senior media engineers do"
They treat the loop as a **timeline plan**, not as a side effect of events: a small pure module computes lap
starts, offsets, append windows and removal ranges (exactly what you wrote above), and a single serialized queue
executes the SourceBuffer operations. They test the pure module with property tests (thousands of random laps, no
gaps, no overlaps), and they fix loop points at encode time — keyframes and segment boundaries on `A` and `B` —
instead of fighting bad cuts in JavaScript. Libraries like hls.js expose related knobs (for example a
`backBufferLength` setting that controls how much is kept behind the playhead) — read their docs before
re-inventing buffer management.
:::

## Recap

- `loop` and "seek to 0 on `ended`" are **seeks**: the decoder flushes and restarts at a keyframe, audio resets — a
  visible hitch, black frame or audio gap on many devices.
- An **appended-laps / rolling loop** appends the same segments again further down the timeline with
  `timestampOffset_k = T0 + k·L − A`, so playback just keeps going forward.
- Compute offsets from `k`, don't accumulate; take `L` from real media timestamps.
- Keep memory bounded with `remove()` **behind** the playhead, at **lap (keyframe) boundaries**, leaving a back
  buffer; otherwise expect `QuotaExceededError`.
- Sub-range loops need keyframes at the loop points and an **append window** `[S_k, S_k + L)` per lap; set
  `appendWindowEnd` before `appendWindowStart` when moving forward.
- To **exit**, drop future laps with `remove(nextLapStart, Infinity)` and append the post-loop content at
  `nextLapStart` with offset `nextLapStart − B`; remember the permanent timeline offset afterwards.
- Serialize every SourceBuffer operation (`updating` / `updateend`) and show users loop-local time, not raw
  `currentTime`.
