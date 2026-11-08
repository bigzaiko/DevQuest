---
id: med-03
title: "Jumping along a path: seeking without stutter"
level: intermediate
minutes: 60
xp: 170
summary: What a seek costs, why jumps stutter or flash a wrong frame, fastSeek vs currentTime, preloading the target, clips as time ranges in one stream, frame-accurate timing with requestVideoFrameCallback, and when to reach for WebCodecs.
---

Plenty of products play video that is not one straight line. A training course lets you skip the
intro. A product tour plays clip A, then jumps straight to clip C because you already saw B. A
sports app plays the replay of a goal and then jumps back to live. An interactive story plays a
scene, then continues with whichever scene the viewer picked.

All of these are a **path**: an ordered list of clips, where moving from one clip to the next may
mean *jumping* to a different point in the video. When it goes well, nobody notices. When it goes
badly you get a frozen picture, a spinner, a one-frame flash of the wrong scene, or a cut that comes
a fraction of a second late. Users can't name the problem, but they say the video "feels cheap".

This lesson is about making those jumps invisible. It builds on *Video in the browser: frames,
codecs and keyframes* (what a keyframe is) and *Streaming: HLS playlists and Media Source
Extensions* (how bytes get into the buffer). Looping the same clip is the topic of *Seamless loops*,
and audio at a cut is the topic of *Clean sound at a seam*. Here we focus on the picture and the timing.

## The model: clips, in/out points and a path

A **clip** is a time range in a video: an **in point** (first frame shown) and an **out point**
(where the clip ends; the frame *at* the out point is not part of the clip). A **path** is the order
we want to show the clips in.

```text
source video (one file, 0 s ... 8 s)

  0s        2s        4s        6s        8s
  |---A-----|---B-----|---C-----|---D-----|
  in=0      in=2      in=4      in=6
     out=2     out=4     out=6     out=8

path: A -> C -> D

  play A (0..2)  --jump-->  play C (4..6)  --(contiguous)-->  play D (6..8)
                 seek to 4                  no seek needed: C.out == D.in
```

Two things fall out of this picture:

1. Moving from C to D needs **no seek** at all. D starts exactly where C ends, so the video just
   keeps playing. Only *non-contiguous* steps (A to C) are jumps.
2. Every jump has two parts: **when** to jump (the moment A's last frame is on screen) and **where**
   to jump (C's in point). Get the "when" wrong and you show a frame too many or too few; get the
   "where" wrong (or slow) and you stutter.

## What a seek actually costs

Setting `video.currentTime = 4` looks like assigning a number. Under the hood the browser has to:

1. **Find the data.** Is the media at 4 s already in the buffer? If not, it must fetch it (an HTTP
   range request for a progressive MP4, or new segments for HLS/MSE). That can take hundreds of
   milliseconds on a mobile network.
2. **Find the keyframe at or before the target.** Most frames in H.264/H.265/AV1/VP9 are stored as
   *differences* from other frames. Only keyframes (IDR frames in H.264/H.265, key frames in VP9/AV1) are safe points to
   start decoding from.
3. **Decode forward** from that keyframe to the target frame, throwing away every frame in between.
4. **Present** the target frame, then fire the `seeked` event and resume playback if it was playing.

```text
keyframe every 2 s at 30 fps (GOP = 60 frames)

frame:  0          60         120        180
        K . . . . .K . . . . .K . . . . .K
                   ^          ^
                   |          target = frame 110 (3.667 s)
                   |
                   nearest keyframe at or before target = frame 60

decode work: frames 60, 61, ... 110  -> 51 decodes, 50 of them thrown away
```

The cost of step 3 grows with the distance from the previous keyframe. With a 2 s GOP (group of
pictures) the worst case is about 2 s of video decoded in a burst. Hardware decoders do this quickly,
but on a phone, at 4K, or with several videos on the page, it is easily long enough to see.

:::quiz id=med-03-q1 xp=10
A video is encoded at 25 fps with a keyframe every 4 seconds (every 100 frames). You seek to
frame 245. The data is already buffered. Roughly how many frames does the decoder have to decode
before it can show frame 245?

- [ ] 1, because the data is buffered
- [ ] 5
- [x] 46 (frames 200 to 245)
- [ ] 245 (every frame from the start)
> The nearest keyframe at or before frame 245 is frame 200. Decoding has to start there and run
> forward through 201...244, discarding them, to produce 245. Being buffered removes the network
> cost, not the decode cost. Starting from frame 0 is never needed, because a keyframe resets the
> decoder's state.
:::

## Why jumps stutter or show a wrong frame

Each step of a seek can show up as something the viewer sees:

| Symptom | Usual cause |
| --- | --- |
| Picture freezes, maybe a spinner | Target not buffered: the browser is fetching data (`waiting` event fires) |
| Short freeze on every jump, even when buffered | Long decode-forward from a distant keyframe |
| One frame of the *old* clip after the cut | Jump was triggered one frame too late (coarse timing) |
| Clip ends one frame early | Jump triggered too early, or the out point was rounded down |
| First frame of the new clip is the frame *before* the in point | Seek target exactly on a frame boundary, lost to floating-point rounding |
| Shows a frame a little before the target | `fastSeek()` went to a nearby keyframe instead of the exact time |

The frame-boundary case surprises everyone. At 30 fps, frame 120 starts at 4.0 s, but frame 1 starts
at 0.0333... s, which can't be represented exactly in binary floating point. Containers store
timestamps as integers in a *timescale* (for example 90 000 ticks per second), and the browser
converts your `currentTime` into that timescale. A value a hair below the frame start selects the
previous frame. A common, robust habit is to seek a little *into* the frame (for example a quarter
of a frame after the in point) rather than to its exact start.

```ts
const fps = 30
const frame = 1 / fps

function seekToFrameStart(video: HTMLVideoElement, inPoint: number) {
  // Aim inside the target frame so rounding can't select the previous one.
  video.currentTime = inPoint + frame / 4
}
```

## `fastSeek()` vs `currentTime`

The HTML standard gives you two ways to seek:

```ts
video.currentTime = 12.5   // precise: shows the frame that covers 12.5 s
video.fastSeek(12.5)       // approximate: may go to a nearby keyframe instead
```

`fastSeek(time)` lets the browser trade accuracy for speed. It can show the nearest keyframe right
away and skip the decode-forward step. That is perfect for **scrubbing**: while a user drags the
timeline you want fast feedback, not exact frames. It is wrong for **cuts on a path**, where you
need exactly the in point. Also check support before you rely on it: Firefox and Safari implement
`fastSeek`; Chromium-based browsers (Chrome, Edge) do not, so feature-detect it.

```ts
function scrubTo(video: HTMLVideoElement, t: number) {
  if (typeof video.fastSeek === 'function') video.fastSeek(t)
  else video.currentTime = t
}
```

Either way, a seek is **asynchronous**. Reading `currentTime` straight after assigning it returns the
new value, but the picture changes later. The `seeking` event fires when the seek starts and
`seeked` when the new frame is ready. If you start another seek before `seeked`, the first one is
abandoned.

:::quiz id=med-03-q2 xp=10
Your path player jumps from clip A to clip C with `video.fastSeek(C.in)` in Firefox. The file has a
keyframe every 4 s, and C's in point is 1.2 s after the previous keyframe. What does the viewer most likely see?

- [ ] Exactly the first frame of C, just faster than with `currentTime`
- [x] Playback from a keyframe up to 1.2 s *before* C's in point, i.e. the tail of whatever precedes C in the file
- [ ] An exception, because `fastSeek` only accepts keyframe times
- [ ] Nothing changes until the next keyframe arrives
> `fastSeek` is allowed to go to a keyframe near the target instead of the target itself. The nearest
> keyframe here is the one 1.2 s before the in point, so the viewer sees up to 1.2 s of material that belongs to the clip *before* C, which looks like a wrong
> cut. Use `currentTime` for path jumps; keep `fastSeek` for scrubbing.
:::

## Preload the target so the jump is instant

The biggest stutter is the network. The fix is simple to say: **have the target data in the buffer
before you need it.** A `TimeRanges` object tells you what is buffered:

```ts
function isBuffered(video: HTMLVideoElement, from: number, to: number): boolean {
  const ranges = video.buffered
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= from && ranges.end(i) >= to) return true
  }
  return false
}

// Before the jump, check that at least the first second of the next clip is ready.
const ready = isBuffered(video, nextClip.in, Math.min(nextClip.out, nextClip.in + 1))
```

How you get it buffered depends on how the video is delivered:

- **Progressive MP4** (`<video src="film.mp4">`). Use `preload="auto"` so the browser may buffer
  ahead. But browsers buffer *forward from the playhead*, not at some other point in the file, so a
  far-away target usually isn't buffered. A second, hidden `<video>` element that is already
  seeked to the target (and has fired `seeked`) can be swapped in at the jump. That costs memory
  and a second decoder, and you have to keep the hidden element muted and hand the audio over at the swap.
- **Media Source Extensions** (covered in *Streaming: HLS playlists and Media Source Extensions*).
  You control the buffer. Fetch and `appendBuffer()` the segments that contain the next clip's in
  point while the current clip is still playing. The jump is then a seek within data you already have.
- **HLS** with hls.js or native playback. The player buffers along the playlist. Jumping far away
  means the player loads new segments, so keep jump targets close, or use MSE when you need control.

```text
current clip playing          next clip (target of the jump)
|====A====|                   |====C====|
     ^ playhead                ^ in point

buffer, naive:     [=======]                       <- only ahead of the playhead
buffer, prefetch:  [=======]           [=====]     <- target appended while A plays
                                       ^ jump target is already buffered
```

## Several clips in ONE stream

Even with prefetching, every jump into *another file* means a new source: a new demuxer, often a new
decoder setup, and with `src` swaps a full reload (`emptied`, `loadstart`, black frame). The robust
pattern is to **put all clips into one stream** and treat each clip as a time range:

```text
one encoded file / one MSE buffer

0s         3.0s           7.5s         10.0s          14.0s
K..........K..............K............K..............|
|---intro--|----option-1--|---option-2-|----outro-----|
clip id:   intro    o1           o2          outro
path:      intro -> o2 -> outro
           jump: seek 3.0 -> 7.5        then o2.out == outro.in == 10.0: keep playing, no seek
```

Now a jump is a **seek within the same buffer**: same codec configuration, same decoder, no new
request if the range is buffered. Two encoding choices make it much cheaper:

1. **Put a keyframe exactly at every in point.** Then decode-forward costs zero frames. Most encoders
   can force keyframes at given times, for example with FFmpeg:

   ```bash
   ffmpeg -i joined.mp4 -c:v libx264 -force_key_frames "0,3.0,7.5,10.0" \
     -c:a aac -movflags +faststart clips.mp4
   ```

2. **Keep the GOP short** (for example 1 to 2 s) so that even seeks to points without a forced
   keyframe stay cheap. The price is a slightly larger file, because keyframes compress worse.

:::quiz id=med-03-q3 xp=10
You store a product tour as five separate MP4 files and jump by setting `video.src` to the next
file. Users report a short black flash at every jump. Which change fixes the cause rather than hiding it?

- [ ] Add a CSS transition on the `<video>` opacity
- [ ] Call `video.load()` before setting `src`
- [x] Encode the five clips into one file (keyframe at each in point) and jump with `currentTime`
- [ ] Set `preload="none"` so the browser does less work
> Changing `src` resets the media element: it empties the buffer, sets up a new decoder and shows
> nothing until the first frame of the new file is decoded. With all clips in one stream, a jump is
> a seek inside data the element already has, with the same decoder. A fade only hides the flash.
:::

:::job title="What you will meet at work"
Interactive and "choose your path" video features usually start as separate files from a content
team. The first real ticket is often "the jump between scenes flickers". Expect to talk to whoever
owns the encoding pipeline: asking for one joined rendition with keyframes at known cut points is
normal and usually fixes more than any amount of front-end code.
:::

## Deciding WHEN to jump

Knowing *where* to seek is half the job. The other half is seeking at the right moment: right after
the clip's last frame is presented, not a frame early and not a frame late.

### `timeupdate` is too coarse

The obvious approach is to listen for `timeupdate` and jump when `currentTime >= clip.out`. The HTML
standard asks for `timeupdate` about every 15 to 250 ms during playback (roughly 4 to 66 times a second),
and some browsers, Chromium among them, fire it only about four times a second. At 30 fps a frame lasts 33 ms, so you can overshoot by several frames:

```text
frames (30 fps):  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
                              out point ^
timeupdate:     *                    *                    *
                                     ^ ~250 ms later: currentTime >= out
                                       -> 7 frames of the NEXT segment in the file already shown
```

Polling `currentTime` in `requestAnimationFrame` is better but still guesses: the animation frame
loop runs at the display's refresh rate, not the video's frame rate, and `currentTime` is not tied
to the frame actually on screen.

### `requestVideoFrameCallback`: per-frame, with real timestamps

`video.requestVideoFrameCallback(callback)` calls you once **each time a new video frame is
presented** to the compositor. The callback gets two arguments: `now` (a `DOMHighResTimeStamp`) and
a `metadata` object. The fields you need for jumps:

- `mediaTime`: the presentation timestamp, in seconds, of the frame that was just presented.
  This is *the* time of what the viewer sees.
- `presentedFrames`: a running count of frames submitted for composition. If it goes up by more
  than 1 between two callbacks, your callback missed frames (the page was busy).
- `expectedDisplayTime`: when the browser expects the frame to be visible.

Like `requestAnimationFrame`, it is one-shot: re-register inside the callback. Cancel it with
`video.cancelVideoFrameCallback(handle)`. It has worked in Chromium, Safari and Firefox since late 2024 (Baseline 2024);
feature-detect it anyway for older browsers and fall back to a `requestAnimationFrame` loop that reads `currentTime`.

```ts
const fps = 30
const frame = 1 / fps

function watchOutPoint(video: HTMLVideoElement, outPoint: number, onLastFrame: () => void) {
  let lastCount = -1
  const step: VideoFrameRequestCallback = (_now, meta) => {
    if (lastCount >= 0 && meta.presentedFrames - lastCount > 1) {
      console.debug(`missed ${meta.presentedFrames - lastCount - 1} frame callback(s)`)
    }
    lastCount = meta.presentedFrames

    // Will the NEXT frame start at (or within half a frame of) the out point?
    if (meta.mediaTime + frame >= outPoint - frame / 2) {
      onLastFrame()          // e.g. video.currentTime = next.in + frame / 4
      return                 // stop watching this clip
    }
    video.requestVideoFrameCallback(step)
  }
  video.requestVideoFrameCallback(step)
}
```

### The half-frame threshold

Why "next frame within half a frame of the out point" instead of `mediaTime >= out`?

- `mediaTime >= out` is true only once the frame *at* the out point is already on screen. That frame
  belongs to whatever comes after the clip in the file. You are one frame late, every time.
- When the clip's **last** frame (the one starting at `out - frame`) is presented, it stays on screen
  for one frame duration. If you seek *now*, the seek runs while that frame is showing, and the next
  frame shown is the target. That is the earliest correct moment.
- Timestamps jitter. A 29.97 fps file, a container timescale, or rounding can make the last frame's
  `mediaTime` come out as 1.9663 instead of 1.9667. Comparing against `out - frame / 2` tolerates
  up to half a frame of error in either direction, without ever confusing two neighbouring frames.

```text
fps = 25, frame = 0.04 s, clip out = 2.00 s

presented frame mediaTime:   1.88   1.92   1.96 | 2.00 (not in clip)
next frame would start at:   1.92   1.96   2.00 |
threshold out - frame/2:     1.98   1.98   1.98 |
next >= threshold?           no     no     YES -> seek now, while 1.96 is on screen
```

:::quiz id=med-03-q4 xp=15
At 25 fps (frame = 0.04 s) a clip has `out = 6.00`. `requestVideoFrameCallback` reports these
`mediaTime` values, one per callback: 5.88, 5.92, 5.9601, 6.00. Using the rule "jump when
`mediaTime + frame >= out - frame / 2`", on which reported frame do you seek?

- [ ] 5.88
- [ ] 5.92
- [x] 5.9601
- [ ] 6.00
> 5.92 + 0.04 = 5.96, below the threshold 5.98. 5.9601 + 0.04 = 6.0001, above it: this is the clip's
> last frame (with a little timestamp jitter), so seek now while it is on screen. Waiting until 6.00
> shows one frame that isn't part of the clip.
:::

## Challenge 1: plan the jumps

Before playback starts, a path player turns the path into a list of seeks. Contiguous steps (the next
clip's in point equals the current clip's out point) need no seek.

:::challenge id=med-03-c1 lang=ts xp=40
title: Plan the seeks for a path
Write `planJumps(clips, path)`.

- `clips` is a list of `{ id, in, out }` (seconds, all in one stream). `path` is a list of clip ids in play order.
- Return one entry `{ from, next, at, to }` per **non-contiguous** step: `from`/`next` are the ids,
  `at` is the out point of `from` (when to jump), `to` is the in point of `next` (where to seek).
- If `next.in` equals `from.out` (within `1e-6`), the step is contiguous: no entry.
- The same clip may appear more than once in a path (replaying a clip is a jump back to its in point).
- An unknown id in the path throws an `Error` whose message contains the id.
- An empty or one-clip path gives `[]`.

hint: Build a `Map` from id to clip first, and validate every id in the path before planning.
hint: Walk pairs: `path[i]` and `path[i + 1]`.
hint: Compare with `Math.abs(next.in - from.out) < 1e-6`, not `===`.

```ts starter
type Clip = { id: string; in: number; out: number }
type Jump = { from: string; next: string; at: number; to: number }

export function planJumps(clips: Clip[], path: string[]): Jump[] {
  return []
}
```

```ts solution
type Clip = { id: string; in: number; out: number }
type Jump = { from: string; next: string; at: number; to: number }

export function planJumps(clips: Clip[], path: string[]): Jump[] {
  const byId = new Map(clips.map((c) => [c.id, c]))
  for (const id of path) {
    if (!byId.has(id)) throw new Error(`unknown clip: ${id}`)
  }
  const jumps: Jump[] = []
  for (let i = 0; i + 1 < path.length; i++) {
    const from = byId.get(path[i])!
    const next = byId.get(path[i + 1])!
    if (Math.abs(next.in - from.out) < 1e-6) continue
    jumps.push({ from: from.id, next: next.id, at: from.out, to: next.in })
  }
  return jumps
}
```

```ts tests
const tour = [
  { id: 'A', in: 0, out: 2 },
  { id: 'B', in: 2, out: 4 },
  { id: 'C', in: 4, out: 6 },
  { id: 'D', in: 6, out: 8 },
]
test('a jump from A to C', () => {
  expect(planJumps(tour, ['A', 'C'])).toEqual([{ from: 'A', next: 'C', at: 2, to: 4 }])
})
test('contiguous steps need no seek', () => {
  expect(planJumps(tour, ['A', 'B', 'C', 'D'])).toEqual([])
  expect(planJumps(tour, ['A', 'C', 'D'])).toEqual([{ from: 'A', next: 'C', at: 2, to: 4 }])
})
test('jumping backwards and replaying a clip', () => {
  expect(planJumps(tour, ['C', 'A', 'A'])).toEqual([
    { from: 'C', next: 'A', at: 6, to: 0 },
    { from: 'A', next: 'A', at: 2, to: 0 },
  ])
})
test('float noise still counts as contiguous', () => {
  const clips = [{ id: 'x', in: 0, out: 0.1 + 0.2 }, { id: 'y', in: 0.3, out: 1 }]
  expect(planJumps(clips, ['x', 'y'])).toEqual([])
})
test('unknown ids throw with the id in the message', () => {
  expect(() => planJumps(tour, ['A', 'Z'])).toThrow('Z')
  expect(() => planJumps(tour, ['Q'])).toThrow('Q')
})
test('empty and single-clip paths', () => {
  expect(planJumps(tour, [])).toEqual([])
  expect(planJumps(tour, ['B'])).toEqual([])
})
```
:::

## Challenge 2: a frame-driven path player

Now the runtime part. A real player wires this to `requestVideoFrameCallback`: every callback passes
`meta.mediaTime` to `onFrame`, and the returned action says what to do. Keeping the logic pure makes
it testable without a video element.

```ts
// Wiring (not part of the challenge):
const player = createPathPlayer(clips, path, 25)
const tick: VideoFrameRequestCallback = (_now, meta) => {
  const action = player.onFrame(meta.mediaTime)
  if (action.type === 'seek') video.currentTime = action.to + 0.01
  if (action.type === 'end') { video.pause(); return }
  video.requestVideoFrameCallback(tick)
}
video.requestVideoFrameCallback(tick)
```

:::challenge id=med-03-c2 lang=ts xp=60
title: Jump on the right frame
Write `createPathPlayer(clips, path, fps)` returning `{ onFrame(mediaTime), current() }`.

- `current()` returns the id of the clip being played (starts at `path[0]`).
- `onFrame(t)` is called once per presented frame and returns `{ type: 'none' }`,
  `{ type: 'seek', to }` or `{ type: 'end' }`.
- Let `frame = 1 / fps`. The presented frame is the **last frame of the current clip** when
  `t + frame >= clip.out - frame / 2`. Then:
  - on the last clip of the path, return `{ type: 'end' }` once; any later call returns `{ type: 'none' }`;
  - otherwise move to the next clip in the path. If it is contiguous (`|next.in - clip.out| < 1e-6`),
    return `{ type: 'none' }` and keep playing; if not, return `{ type: 'seek', to: next.in }`.
- After a seek, frames can still arrive from **before** the seek completed. While a seek is pending,
  ignore (`{ type: 'none' }`) every frame whose `t` is not within `frame / 2` of the seek target.
  The first frame within that window ends the pending state and is then checked normally.

hint: Keep three pieces of state: the index in `path`, the pending seek target (or `null`), and a `done` flag.
hint: Use a `Map` from id to clip. Clip ids in the tests are always valid.
hint: Check the pending seek first, then the last-frame rule.

```ts starter
type Clip = { id: string; in: number; out: number }
type Action = { type: 'none' } | { type: 'seek'; to: number } | { type: 'end' }

export function createPathPlayer(clips: Clip[], path: string[], fps: number) {
  return {
    onFrame(t: number): Action {
      return { type: 'none' }
    },
    current(): string {
      return path[0]
    },
  }
}
```

```ts solution
type Clip = { id: string; in: number; out: number }
type Action = { type: 'none' } | { type: 'seek'; to: number } | { type: 'end' }

export function createPathPlayer(clips: Clip[], path: string[], fps: number) {
  const byId = new Map(clips.map((c) => [c.id, c]))
  const frame = 1 / fps
  let index = 0
  let pending: number | null = null
  let done = false

  return {
    onFrame(t: number): Action {
      if (done) return { type: 'none' }
      if (pending !== null) {
        if (Math.abs(t - pending) > frame / 2) return { type: 'none' }
        pending = null
      }
      const clip = byId.get(path[index])!
      if (t + frame < clip.out - frame / 2) return { type: 'none' }
      if (index === path.length - 1) {
        done = true
        return { type: 'end' }
      }
      index++
      const next = byId.get(path[index])!
      if (Math.abs(next.in - clip.out) < 1e-6) return { type: 'none' }
      pending = next.in
      return { type: 'seek', to: next.in }
    },
    current(): string {
      return path[index]
    },
  }
}
```

```ts tests
const reel = [
  { id: 'A', in: 0, out: 2 },
  { id: 'B', in: 2, out: 4 },
  { id: 'C', in: 4, out: 6 },
]
test('plays through the middle of a clip', () => {
  const p = createPathPlayer(reel, ['A', 'C'], 25)
  expect(p.onFrame(0)).toEqual({ type: 'none' })
  expect(p.onFrame(1.0)).toEqual({ type: 'none' })
  expect(p.onFrame(1.92)).toEqual({ type: 'none' })
  expect(p.current()).toBe('A')
})
test('seeks on the last frame of the clip, not one frame late', () => {
  const p = createPathPlayer(reel, ['A', 'C'], 25)
  expect(p.onFrame(1.96)).toEqual({ type: 'seek', to: 4 })
  expect(p.current()).toBe('C')
})
test('tolerates timestamp jitter below half a frame', () => {
  const p = createPathPlayer(reel, ['A', 'C'], 25)
  expect(p.onFrame(1.935)).toEqual({ type: 'none' })
  expect(p.onFrame(1.955)).toEqual({ type: 'seek', to: 4 })
})
test('ignores stale frames until the seek completes', () => {
  const p = createPathPlayer(reel, ['A', 'C', 'A'], 25)
  expect(p.onFrame(1.96)).toEqual({ type: 'seek', to: 4 })
  expect(p.onFrame(2.0)).toEqual({ type: 'none' })
  expect(p.onFrame(2.04)).toEqual({ type: 'none' })
  expect(p.onFrame(4.0)).toEqual({ type: 'none' })
  expect(p.onFrame(5.96)).toEqual({ type: 'seek', to: 0 })
  expect(p.current()).toBe('A')
})
test('contiguous clips continue without a seek', () => {
  const p = createPathPlayer(reel, ['A', 'B', 'C'], 25)
  expect(p.onFrame(1.96)).toEqual({ type: 'none' })
  expect(p.current()).toBe('B')
  expect(p.onFrame(2.0)).toEqual({ type: 'none' })
  expect(p.onFrame(3.96)).toEqual({ type: 'none' })
  expect(p.current()).toBe('C')
})
test('ends exactly once on the last clip', () => {
  const p = createPathPlayer(reel, ['C'], 25)
  expect(p.onFrame(5.0)).toEqual({ type: 'none' })
  expect(p.onFrame(5.96)).toEqual({ type: 'end' })
  expect(p.onFrame(6.0)).toEqual({ type: 'none' })
})
test('a full frame-by-frame run produces exactly one seek and one end', () => {
  const p = createPathPlayer(reel, ['A', 'C'], 25)
  const actions: string[] = []
  for (let i = 0; i < 50; i++) { const a = p.onFrame(i * 0.04); if (a.type !== 'none') actions.push(a.type) }
  for (let i = 100; i < 160; i++) { const a = p.onFrame(i * 0.04); if (a.type !== 'none') actions.push(a.type) }
  expect(actions).toEqual(['seek', 'end'])
})
```
:::

:::pro title="Log the frames, not just the events"
Senior media engineers debug jumps by logging every `requestVideoFrameCallback` with `mediaTime`,
`presentedFrames` and `expectedDisplayTime` around a cut, then reading the log frame by frame.
"Seek issued at 1.96, first frame after seek 4.00, no gap in presentedFrames" is proof; "it looks fine
on my laptop" is not. Many teams ship the same logging behind a debug flag so QA can attach it to bug reports.
:::

## When you need full control: WebCodecs

The media element decides when frames appear, how it buffers and how it seeks. For most paths that
is fine. Some products need more: frame-exact editing, frames drawn into a `<canvas>` or WebGL with
effects, or several streams composed into one picture. That is what **WebCodecs** is for. It gives
you the browser's (often hardware) decoder directly:

```ts
// Illustrative: ctx (a canvas 2D context), avcCBytes and samplesFromKeyframeToTarget
// come from your canvas and your MP4 demuxer, which are left out here.
const decoder = new VideoDecoder({
  output: (frame: VideoFrame) => {
    ctx.drawImage(frame, 0, 0)      // or keep it in a queue and draw on schedule
    frame.close()                   // frames hold GPU/decoder memory: always close them
  },
  error: (e: DOMException) => console.error(e),
})

decoder.configure({
  codec: 'avc1.64001f',             // from the container (e.g. the MP4 'avcC' box)
  codedWidth: 1280,
  codedHeight: 720,
  description: avcCBytes,           // codec-specific setup data
})

// To "seek": start from a keyframe, feed chunks up to the target, drop frames before it.
for (const sample of samplesFromKeyframeToTarget) {
  decoder.decode(new EncodedVideoChunk({
    type: sample.isKeyframe ? 'key' : 'delta',
    timestamp: sample.timeUs,       // microseconds
    duration: sample.durationUs,
    data: sample.bytes,
  }))
}
await decoder.flush()
```

What you take on in exchange:

- **No demuxer.** WebCodecs decodes *encoded chunks*; you must parse MP4/WebM yourself or with a
  library to get the samples, keyframe flags and timestamps.
- **No clock, no audio sync.** You schedule frame display yourself and keep it aligned with audio
  (usually played through Web Audio). The media element did this for free.
- **The same keyframe rule.** A seek is still "decode from the previous keyframe forward", only now
  it is your loop that does it, and you decide which frames to show or drop.

Use it when the media element's control is genuinely not enough, not as the first step.

:::quiz id=med-03-q5 xp=10
You switch a path player from `<video>` to WebCodecs `VideoDecoder`. Which of these must your code
now handle that the media element handled for you? (Select all that apply.)

- [x] Parsing the container to get encoded chunks and keyframe flags
- [x] Timing when each decoded frame is displayed
- [x] Keeping picture and audio in sync
- [ ] Needing a keyframe before decoding delta frames
> WebCodecs is a decoder, not a player: demuxing, scheduling and A/V sync become your job. The need
> to start from a keyframe is not something the element "handled away": it applies to both, the
> element just hid the decode-forward work from you.
:::

## How it breaks in practice

**Jumps on `timeupdate`.** The classic first version. Symptom: a few frames of the following
segment flash before every cut, and the amount varies between browsers. Detect it by stepping
through a screen recording frame by frame (most video editors and `ffmpeg -i rec.mp4 frames/%04d.png`
work). Fix: `requestVideoFrameCallback` with the half-frame rule.

**Comparing with `>= out`.** Even with per-frame callbacks, `mediaTime >= clip.out` fires one frame
late. Detect it in your frame log: the first logged frame after the cut decision has `mediaTime === out`.

**Seeking to the exact in point.** Works on one machine, shows the previous frame on another.
Detect it with a test video that burns the frame number into the picture (FFmpeg's `drawtext`
filter can do it). Fix: seek a quarter frame into the target.

**Target not buffered.** Fine on office Wi-Fi, spinner on a train. Detect it by listening for
`waiting` right after your seek, and by testing with network throttling in DevTools. Fix: prefetch
the next clip's range (MSE), or put clips in one stream with the next target close by.

**Separate files, `src` swaps.** Black flash or a short audio gap at every cut. Detect it in
the network panel (a new request per clip) and with `emptied`/`loadstart` events. Fix: one stream,
clips as time ranges.

**Seeking again before `seeked`.** A user clicks "skip" twice; the second seek cancels the first and
your state machine thinks clip C is playing when the element went somewhere else. Fix: track the
pending target, ignore stale frames, and derive state from the `mediaTime` you actually see.

**Long GOPs.** Every jump has a 100 to 300 ms hitch even when buffered. Detect it by measuring time
from `seeking` to `seeked`, and by inspecting keyframe positions with
`ffprobe -select_streams v -show_entries packet=pts_time,flags -of csv clips.mp4 | grep K`.
Fix: keyframes at in points, shorter GOP.

**Background tabs and missed callbacks.** In a hidden tab, `requestVideoFrameCallback` may not fire
and browsers may pause or throttle video. On a busy page the callback can skip frames
(`presentedFrames` jumps by 2 or more). Fix: when frames were missed, check whether `mediaTime` is
already past the out point and jump immediately instead of waiting for an exact match.

:::quiz id=med-03-q6 xp=10
In the frame log you see `presentedFrames` go from 410 to 413 between two callbacks, and the
reported `mediaTime` is already 0.03 s past the current clip's out point. What should a robust
path player do?

- [ ] Nothing: wait for the exact last frame of the clip to be reported
- [x] Jump now: the last frame was missed, and every extra frame shows the wrong material
- [ ] Reload the video so the counter resets
- [ ] Switch to `fastSeek` for this jump to catch up
> A jump of 3 in `presentedFrames` means two frames were presented without a callback. The exact
> last frame will never be reported, so a rule that waits for it never fires. Because the check is
> "next frame is at or past the out point", a frame beyond the out point also satisfies it, so the
> player jumps at once. Use the precise seek: `fastSeek` would add a wrong-frame problem to a late one.
:::

:::cards id=med-03-cards1 xp=15 title="Seeking along a path"
Q: What are the four steps of a seek?
A: Find the data (fetch if not buffered), find the keyframe at or before the target, decode forward to the target, present the frame (then `seeked` fires).
Q: Why is a seek to a buffered point still not free?
A: The decoder must start at the previous keyframe and decode every frame up to the target. Cost grows with distance from that keyframe (the GOP length).
Q: `fastSeek(t)` vs `currentTime = t`?
A: `fastSeek` may go to a nearby keyframe for speed (good for scrubbing); `currentTime` goes to the exact frame (needed for cuts). `fastSeek` isn't in Chromium, so feature-detect it.
Q: Why put several clips into one stream?
A: A jump becomes a seek in the same buffer with the same decoder: no new request, no `src` reset, no black flash.
Q: What encoding change makes jumps to in points cheap?
A: Force a keyframe at every in point (and keep the GOP short), e.g. FFmpeg `-force_key_frames`.
Q: Why is `timeupdate` unsuitable for cut timing?
A: It fires only every 15 to 250 ms (about 4 times a second in Chromium), so you overshoot by several frames.
Q: What do `mediaTime` and `presentedFrames` tell you?
A: `mediaTime` is the timestamp of the frame just presented; `presentedFrames` counts presented frames, so a jump of more than 1 means missed callbacks.
Q: The half-frame rule for jumping?
A: Jump when `mediaTime + frame >= out - frame / 2`: the presented frame is the clip's last one, within half a frame of jitter. Seek while it is on screen.
Q: Why seek slightly into the target frame?
A: An exact frame-start time can round to just below it and select the previous frame. Seeking a quarter frame in is safe.
Q: What does WebCodecs add, and what do you give up?
A: Direct decoder control and per-frame access. You give up demuxing, the playback clock and A/V sync, which you now write yourself.
:::

## Recap

- A **path** is clips (in/out time ranges) in play order. Only non-contiguous steps are jumps.
- A seek = find data, find the previous **keyframe**, **decode forward**, present. Buffered is not the same as free.
- Stutter comes from missing data, long decode-forward, or late/early timing. Wrong frames come from
  coarse timing, exact-boundary rounding and `fastSeek`.
- Use `currentTime` for cuts and `fastSeek` (where it exists) for scrubbing. Seeks are async: track
  `seeking`/`seeked` and pending targets.
- **Preload** the target: check `video.buffered`, prefetch with MSE.
- Put clips in **one stream** with **keyframes at in points**, so a jump is a cheap seek in the same buffer.
- Decide when with **`requestVideoFrameCallback`**: `mediaTime` plus the **half-frame threshold**, and
  `presentedFrames` to detect missed callbacks.
- **WebCodecs** gives full frame control, but you write the demuxing, timing and A/V sync yourself.
