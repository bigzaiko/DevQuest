---
id: med-05
title: "Clean sound at a seam: AAC frames, priming and cross-fades"
level: advanced
minutes: 65
xp: 190
summary: Why a cut or loop that looks perfect can still click or gap — AAC frame sizes, encoder delay and edit lists, Web Audio scheduling, and equal-power cross-fades you can compute yourself.
---

You've done the hard video work from the earlier lessons in this region: keyframes are in the right
place (**Video in the browser: frames, codecs and keyframes**), segments arrive on time
(**Streaming: HLS playlists and Media Source Extensions**), seeks don't stutter (**Jumping along a
path: seeking without stutter**) and the loop restarts on the right frame (**Seamless loops: from the
loop attribute to appending laps**). You press play, and the picture is perfect. Then you hear it:
a **tick** at every loop point, or a tiny **hole** of silence, or the music getting quieter for a
moment at every transition.

That is not bad luck. Audio is genuinely harder than video at a seam, for three reasons:

1. **Your ears are less forgiving than your eyes.** A repeated or dropped video frame at 30 fps
   lasts 33 ms and often goes unnoticed. A sudden jump in an audio waveform from one sample to the
   next (1/48 000 s) is an audible click, and a 20 ms gap of silence in music is obvious.
2. **Audio frames don't line up with video frames.** Compressed audio comes in fixed-size blocks that
   have nothing to do with the video frame rate, so "cut at frame 300" is usually *not* a place
   where the audio can be cut cleanly.
3. **Compressed audio carries hidden extra samples** (encoder delay and padding) that must be trimmed
   away using metadata — and every tool in the chain has to agree on that metadata.

This lesson explains each of these, then shows the standard fix that audio engineers have used for
decades: decode to raw samples and **cross-fade**, with the right curve.

## Samples, frames and why 1024 is a magic number

Digital audio is a list of numbers — **samples** — taken at a fixed rate. Video for the web almost
always uses **48 000 samples per second** (48 kHz); music from CDs uses 44.1 kHz. Each sample says
where the speaker cone should be at that instant, typically a float between −1 and 1.

**AAC** (Advanced Audio Coding, the audio codec in nearly every MP4 and HLS stream) compresses
audio in fixed blocks called **access units** or **AAC frames**. For AAC-LC (the common profile)
each frame decodes to exactly **1024 samples** per channel. (HE-AAC, used for low bitrates, outputs
2048 samples per frame because of its bandwidth-extension trick; Opus uses 20 ms frames by
default.) You can only start or stop decoding a compressed stream on these boundaries.

At 48 kHz one AAC frame lasts 1024 / 48 000 s = **21.333… ms**. A video frame at 30 fps lasts
33.333… ms. Lay them next to each other:

```text
time (ms)   0        21.3      42.7      64.0      85.3     106.7     128.0
audio       |---A0----|---A1----|---A2----|---A3----|---A4----|---A5----|
video       |------V0------|------V1------|------V2------|------V3------|
time (ms)   0             33.3           66.7          100.0          133.3

                            ^ cut wanted at V1 start (33.3 ms) —
                              falls in the middle of A1
```

Only at certain instants do both grids meet. At 48 kHz and 30 fps a video frame is 1600 samples;
the smallest number divisible by both 1600 and 1024 is 25 600 samples = **533.3 ms** — every
16 video frames / 25 AAC frames. At 25 fps (1920 samples per frame) the grids meet every
15 360 samples = 320 ms. Most of the cut points an editor picks are somewhere in between.

:::info title="Why not just cut audio anywhere?"
Once audio is **decoded** into PCM (plain samples), you *can* cut at any sample — 1/48 000 s
precision. The 1024-sample constraint only applies while the audio is still **compressed**: when you
choose which segments or frames to append to a `SourceBuffer`, or concatenate files without
re-encoding. Most seam problems come from treating compressed audio as if it were PCM.
:::

:::quiz id=med-05-q1 xp=10
A 48 kHz AAC-LC track and a 30 fps video track. You cut the compressed streams (no re-encoding) so
that video starts exactly at frame 45 (t = 1.5 s), and audio starts at the **nearest** AAC frame
boundary. What is the largest audio/video offset this rounding can ever introduce?

- [ ] 0 ms — 1.5 s is always on an audio frame boundary
- [x] About 10.7 ms (half an AAC frame)
- [ ] About 16.7 ms (half a video frame)
- [ ] About 21.3 ms (one full AAC frame)
> Rounding to the *nearest* of a grid with 21.333 ms spacing can be off by at most half a step,
> ≈10.67 ms. (1.5 s = 72 000 samples = 70.3 AAC frames, so this particular cut is ~6.7 ms off.)
> Rounding always down or always up can be off by up to a full frame. Lip-sync errors under about
> 20 ms are generally imperceptible, so nearest-boundary rounding is usually fine for sync —
> but it does *not* solve clicks, as we'll see.
:::

## Hidden samples: encoder delay, padding and edit lists

An AAC encoder can't produce the first real frame of output without a bit of "run-up". AAC uses an
overlapping transform (the MDCT): each frame is decoded with a window that overlaps half of the
previous frame and the results are **overlap-added**. The very first decoded frame has no previous
frame to overlap with, so encoders put extra samples in front of the real audio — **priming
samples** or **encoder delay**. At the end, the last frame is filled up to 1024 samples with
**padding** (sometimes called remainder samples).

```text
encoded stream (AAC frames of 1024 samples):
|  F0  |  F1  |  F2  |  F3  | ... |  Fn-1 |  Fn  |
|<-- priming -->|<========= real audio =========>|<pad>|
   (e.g. 2112                                       (fills last frame)
    samples)
```

How many priming samples? It depends on the encoder. Apple's Technical Note TN2258 uses **2112 samples**
(two full AAC frames plus 64 samples) as the priming value for its AAC encoder; the note itself says
encoder delay is implementation-dependent, and other encoders use different values. At 48 kHz, 2112 samples is exactly
**44 ms**. If nothing trims them, every file starts with 44 ms of near-silence — and every
concatenation of two files gets a 44 ms hole plus the padding of the first file.

The trimming information has to travel with the file:

| Container | Where the "skip N samples at start, ignore M at end" information lives |
|---|---|
| MP4 / fMP4 | An **edit list** (`elst` box in the `edts` of the track): `media_time` says the presentation starts N samples into the media. Some files also carry an iTunes-style `iTunSMPB` tag. |
| Opus (in Ogg/WebM/MP4) | `pre_skip` in the Opus header; end trimming via the container (granule position, `DiscardPadding`) |
| MPEG-TS (HLS) | Nothing standard — the audio packets' PTS timestamps are all you get; the packager must handle the offset. |
| MP3 | Optional LAME/Xing header with encoder delay and padding |

If a player honours the edit list, the first audible sample is the first *real* sample. If it
ignores it, you hear a short gap at the start — harmless for a single video, fatal for a loop that
repeats every 4 seconds.

:::job title="What you'll meet at work"
Somebody reports "there's a gap when the playlist goes to the next track" or "the loop clicks in
Safari but not Chrome". The first thing a senior asks is: *what encoder, what container, and does
the player honour the edit list?* Tools you'll use: `ffprobe -show_packets -select_streams a` to see
audio packet timestamps and durations, `mp4dump` / `MP4Box -info` to inspect `elst` boxes, and a
waveform view in Audacity to *see* the gap or the click.
:::

:::quiz id=med-05-q2 xp=15
You concatenate two AAC files into one track by simply appending their frames (no re-encoding,
no edit list for the second file). Each file was encoded with 2112 priming samples at 48 kHz, and
the first file's real audio ended 700 samples into its last frame. Predict what you hear at the
join.

- [ ] Nothing — AAC frames are self-contained, so appending them is seamless
- [x] A short gap (about 51 ms of padding + priming), likely with a small glitch where the decoder's overlap-add mixes the end of one stream with the start of the other
- [ ] An echo, because the priming samples repeat the previous file's last 44 ms
- [ ] The second file plays at the wrong pitch
> Padding of file 1 = 1024 − 700 = 324 samples; priming of file 2 = 2112 samples; together
> 2436 samples ≈ 50.75 ms of non-content. And because AAC frames overlap-add with their neighbour,
> the first frame of file 2 is reconstructed against the last frame of file 1 — a stream it was
> never encoded with — which can produce a small artefact. Gapless joins need trimming metadata
> (edit lists) or decoding to PCM and joining there.
:::

### In the browser: MSE append windows

With Media Source Extensions you control timing per append with two `SourceBuffer` properties:

```ts
// sourceBuffer.mode = 'segments' (the default for fMP4)
// Only while sourceBuffer.updating is false — otherwise these setters throw.
sourceBuffer.timestampOffset = lapStartSeconds   // shift the timestamps of what you append next
sourceBuffer.appendWindowEnd = lapEndSeconds     // drop frames after this (set the end first:
sourceBuffer.appendWindowStart = lapStartSeconds // start must stay < end, or the setter throws)
sourceBuffer.appendBuffer(segmentBytes)
```

The MSE spec drops coded frames that fall outside the append window. For **audio**, a frame
straddling the window edge is a problem: dropping it creates a gap of up to 21 ms, keeping it
creates an overlap. Browsers handle that edge differently (Chromium, for example, trims partial
audio frames at `appendWindowStart` using sample-accurate discard). Don't build a product on one
browser's behaviour — measure the result in each one (see *How it breaks in practice*).

:::quiz id=med-05-q3 xp=10
A 4-second loop is built by appending the same fMP4 lap again and again with
`timestampOffset = n * 4`. The audio track's encoder delay is 2112 samples and is described by an
edit list in the init segment. You don't set an append window. What is the most likely symptom?

- [ ] A perfect loop, because the edit list is applied to every append automatically
- [x] A short gap or overlap at every loop point after the first, unless you compensate for the delay yourself (append window, adjusted offset, or trimming at encode time)
- [ ] The video stutters but the audio is fine
- [ ] The browser throws a `QuotaExceededError`
> An edit list only *shifts timestamps* ("presentation starts 2112 samples into the media"); it
> doesn't remove the priming frames from the bytes. Every lap you append carries its priming
> samples (and its end padding) again. If the engine applies the shift, those frames land just
> before the seam and overlap (and replace) the tail of the previous lap; if it ignores the edit
> list, they play just after the seam as near-silence. Either way the seam is wrong unless something
> trims them. Typical fixes: encode the loop so its audio is exactly
> a whole number of AAC frames with priming handled by the packager, set `appendWindowStart` /
> `appendWindowEnd` per lap, or play the loop's audio through Web Audio from decoded PCM.
:::

## Clicks: what a discontinuity sounds like

A speaker cone can't teleport. If the waveform jumps from +0.6 to −0.2 between two consecutive
samples, the cone is asked to do exactly that, and the sudden step contains energy at *all*
frequencies — you hear it as a click or pop. It doesn't matter whether the jump comes from a cut, a
loop restart, a dropped frame, or a gain change from 1 to 0 in one sample.

```text
end of lap               start of next lap
   .-'''-.                |
 .'       '.              |  .--.
'           '.            | /    \
              '.          |/      '.
                 '--------+         '---
                 ^ value 0.6 here    ^ value -0.2 here
                 ===> a vertical jump = CLICK
```

Two ways to avoid it:

- **Cut at zero crossings** — fine for a single synthetic tone, unreliable for real music (stereo
  channels cross zero at different times, and the slope still changes abruptly).
- **Fade.** Bring the level down to zero over a few milliseconds before the cut and back up after
  it. A fade of **5–10 ms** is inaudible as a fade but removes the click. This is called a
  **de-click** or **micro-fade**.

When the cut joins two pieces that should *both* be heard (a loop restarting, a jump to another
scene with music under it), you fade one out while fading the other in: a **cross-fade**.

## Web Audio in five minutes

The **Web Audio API** gives you sample-accurate control of decoded audio in the browser. Its pieces:

- `AudioContext` — the audio graph and its clock (`ctx.currentTime`, in seconds, advancing one
  render quantum at a time — 128 samples by default).
- `AudioBuffer` — decoded PCM in memory, from `ctx.decodeAudioData(arrayBuffer)`.
- `AudioBufferSourceNode` — plays an `AudioBuffer` **once**; create a new one for each start.
- `GainNode` — multiplies the signal by its `gain` `AudioParam`, which you can **automate** in time.

```ts
const ctx = new AudioContext({ latencyHint: 'interactive' })

async function load(url: string): Promise<AudioBuffer> {
  const res = await fetch(url)
  return ctx.decodeAudioData(await res.arrayBuffer())
}

// Browsers start an AudioContext suspended until a user gesture (autoplay policy).
playButton.addEventListener('click', async () => {
  await ctx.resume()
  const music = await load('/audio/loop.m4a')

  const src = new AudioBufferSourceNode(ctx, { buffer: music })
  const gain = new GainNode(ctx, { gain: 0 })
  src.connect(gain).connect(ctx.destination)

  const t0 = ctx.currentTime + 0.1           // schedule slightly in the future
  src.start(t0, /* offset */ 0.5)            // start(when, offset?, duration?)

  gain.gain.setValueAtTime(0, t0)            // anchor the automation
  gain.gain.linearRampToValueAtTime(1, t0 + 0.01)  // 10 ms de-click fade-in
})
```

The key method is **`start(when, offset, duration)`**: `when` is a time on the `ctx.currentTime`
clock (not "now + something" from `performance.now()`), `offset` is where in the buffer to begin,
`duration` how much to play. Because you schedule on the audio clock, two sources started at
`t` and `t + 4` join with sample accuracy — no `setTimeout` jitter.

Gain automation methods on an `AudioParam`:

| Method | What it does |
|---|---|
| `setValueAtTime(v, t)` | jump to `v` at time `t` |
| `linearRampToValueAtTime(v, t)` | ramp linearly **from the previous event** to `v`, arriving at `t` |
| `exponentialRampToValueAtTime(v, t)` | exponential ramp; `v` must be non-zero (so not for fades to silence) |
| `setTargetAtTime(v, t, timeConstant)` | approach `v` exponentially starting at `t` |
| `setValueCurveAtTime(values, t, duration)` | follow an array of values, linearly interpolated, from `t` for `duration` |
| `cancelScheduledValues(t)` | remove events at or after `t` |

:::warn title="Common mistake: a ramp without an anchor"
`linearRampToValueAtTime` ramps from the *previous scheduled event*. Without a
`setValueAtTime(currentValue, now)` before it, the ramp may start from an event long in the past
— so the gain jumps instead of ramping, and you get the very click you were trying to avoid. Always
anchor first. Similarly, `setValueCurveAtTime` throws a `NotSupportedError` if its time range
overlaps other scheduled events: cancel or schedule around them.
:::

To put a `<video>` element's sound through this graph (for fades on a normal player), use
`ctx.createMediaElementSource(videoEl)`; the element's audio then plays only through the graph.

:::quiz id=med-05-q4 xp=10
What does this code do at time `t`?

```ts
const g = gain.gain
g.setValueAtTime(1, t - 2)          // scheduled earlier
// ... 2 seconds later, at time t:
g.linearRampToValueAtTime(0, t + 0.01)
```

- [ ] Fades from 1 to 0 over the 10 ms between `t` and `t + 0.01`
- [x] Ramps from the previous event (value 1 at `t − 2`) to 0 at `t + 0.01` — but that ramp is mostly in the past, so at `t` the gain jumps from 1 to about 0.005 at once: effectively an instant cut and a likely click
- [ ] Throws, because the ramp starts in the past
- [ ] Does nothing, because a value was already set
> A linear ramp is defined between the previous event and the new one. The previous event is at
> `t − 2`, so the ramp spans 2.01 s and at time `t` the gain should already be ~0.005 — it drops
> from 1 to that value in one render block. The fix is to
> anchor at the current moment: `g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);` then ramp.
> (`cancelAndHoldAtTime` does the same in one call, but check browser support on MDN first.)
:::

## Cross-fades: linear vs equal-power

During a cross-fade of length `T`, let `x = (time − start) / T` go from 0 to 1. The outgoing
signal gets gain `gOut(x)`, the incoming gets `gIn(x)`.

**Linear** cross-fade: `gIn = x`, `gOut = 1 − x`. Amplitudes always sum to 1.

**Equal-power** cross-fade: `gIn = sin(x · π/2)`, `gOut = cos(x · π/2)`. The *squares* always sum
to 1, because sin² + cos² = 1.

Which one is right depends on whether the two signals are **correlated**:

- **Uncorrelated** (two different pieces of music, a scene change, two different takes): their
  *powers* add. Loudness follows `gIn² + gOut²`. Linear gives 0.5² + 0.5² = 0.5 at the midpoint —
  a **−3 dB dip** that you hear as the sound sagging in the middle of every transition.
  Equal-power stays at exactly 1.
- **Correlated** (identical or nearly identical audio, e.g. the same recording a few samples
  apart): their *amplitudes* add. Loudness follows `(gIn + gOut)²`. Linear stays at 1;
  equal-power gives (0.707 + 0.707)² = 2 at the midpoint, a **+3 dB bump**.

```text
gain                         linear                    equal-power
1.0 |\                 /|     out \     / in          out ‾‾-.   .-‾‾ in
    | \               / |          \   /                      `X´
0.7 |  \             /  |           \ /            0.707 ...  / \  ...
0.5 |   \   (dip)   /   |            X   <- 0.5             /   \
    |    \         /    |           / \                   .-     -.
0.0 |_____\_______/_____|          /   \               _-´         `-_
     x=0         x=1           power at middle:        power at middle:
                                0.5 (-3 dB)            1.0 (0 dB)
```

For a loop of *music* where the end of the lap and its start are different material, use
equal-power. For a micro-fade that joins a signal to (almost) itself, linear is fine and even
better. Most audio editors and DAWs let you choose the cross-fade curve for exactly this reason.

```ts
function equalPowerCurve(steps: number, fadeIn: boolean): Float32Array {
  const c = new Float32Array(steps)
  for (let i = 0; i < steps; i++) {
    const x = i / (steps - 1)
    c[i] = fadeIn ? Math.sin(x * Math.PI / 2) : Math.cos(x * Math.PI / 2)
  }
  return c
}

// Cross-fade from the current lap (gainA) into the next lap (gainB) at time t over 50 ms
const T = 0.05
nextLap.start(t)                                     // AudioBufferSourceNode → gainB
gainA.gain.setValueCurveAtTime(equalPowerCurve(64, false), t, T)
gainB.gain.setValueCurveAtTime(equalPowerCurve(64, true), t, T)
currentLap.stop(t + T)
```

:::quiz id=med-05-q5 xp=15
You loop a 4-bar drum groove by cross-fading the end of the lap into its own start over 30 ms, using
an **equal-power** curve. The end and start of the lap are almost identical (the same drum hit
rings across the loop point). What do you hear?

- [ ] Perfectly constant loudness — equal-power is always the safe choice
- [x] A brief bump in level (up to about +3 dB) at every loop point
- [ ] A −3 dB dip at every loop point
- [ ] A click, because cross-fades can't be shorter than one AAC frame
> For **correlated** signals amplitudes add: at the midpoint 0.707 + 0.707 = 1.414 in amplitude,
> i.e. +3 dB. Equal-power keeps loudness constant only for *uncorrelated* material. Here a linear
> cross-fade (amplitudes summing to 1) would be the better choice. And a cross-fade on decoded PCM
> can be any length — the 1024-sample grid only matters for compressed streams.
:::

:::pro title="What seniors do"
They separate the two problems. **Sync** (audio vs video timing) is fixed by aligning to AAC frame
boundaries and accepting an offset under ~11 ms, or by re-encoding the seam. **Smoothness** (no
click, no gap, no level change) is fixed in the PCM domain: a short cross-fade with the right curve,
scheduled on the `AudioContext` clock. They also keep a little audio *past* each seam (a "tail" of
a few frames) so there is material to fade over, and they measure: record the output, look at the
waveform, and check the loudness at each join.
:::

## The challenge part

The next two challenges are the core calculations of a seam: the gain curves for a cross-fade, and
snapping a video cut to the AAC grid with the resulting audio/video offset. They are pure
functions, so you can unit-test them without any audio hardware.

:::challenge id=med-05-c1 lang=ts xp=50
title: Equal-power and linear cross-fade curves
Write `crossfadeGains(x, shape)` and `crossfadeCurves(steps, shape)`.

- `crossfadeGains(x, shape)` returns `{ fadeOut, fadeIn }` for a position `x` in the fade.
  Clamp `x` to `[0, 1]` first.
  - `shape = 'linear'`: `fadeIn = x`, `fadeOut = 1 - x`
  - `shape = 'equal-power'`: `fadeIn = sin(x·π/2)`, `fadeOut = cos(x·π/2)`
- `crossfadeCurves(steps, shape)` returns `{ fadeOut, fadeIn }` as two `Float32Array`s of length
  `steps`, ready for `setValueCurveAtTime`. Sample `i` uses `x = i / (steps - 1)`, so the first value
  is exactly the start and the last exactly the end of the fade. Throw an `Error` if `steps < 2`
  (the Web Audio API needs at least two points).

hint: `Math.min(1, Math.max(0, x))` clamps.
hint: `Float32Array` stores 32-bit floats, so compare with `toBeCloseTo`, not `toBe`, except for exact values like 0 and 1.
hint: At `x = 1`, `Math.cos(Math.PI / 2)` is about `6e-17`, not exactly 0 — that's fine.

```ts starter
type Shape = 'linear' | 'equal-power'

export function crossfadeGains(x: number, shape: Shape): { fadeOut: number; fadeIn: number } {
  return { fadeOut: 1 - x, fadeIn: x }
}

export function crossfadeCurves(steps: number, shape: Shape): { fadeOut: Float32Array; fadeIn: Float32Array } {
  return { fadeOut: new Float32Array(steps), fadeIn: new Float32Array(steps) }
}
```

```ts solution
type Shape = 'linear' | 'equal-power'

export function crossfadeGains(x: number, shape: Shape): { fadeOut: number; fadeIn: number } {
  const t = Math.min(1, Math.max(0, x))
  if (shape === 'equal-power') {
    return { fadeOut: Math.cos((t * Math.PI) / 2), fadeIn: Math.sin((t * Math.PI) / 2) }
  }
  return { fadeOut: 1 - t, fadeIn: t }
}

export function crossfadeCurves(steps: number, shape: Shape): { fadeOut: Float32Array; fadeIn: Float32Array } {
  if (steps < 2) throw new Error('a value curve needs at least 2 points')
  const fadeOut = new Float32Array(steps)
  const fadeIn = new Float32Array(steps)
  for (let i = 0; i < steps; i++) {
    const g = crossfadeGains(i / (steps - 1), shape)
    fadeOut[i] = g.fadeOut
    fadeIn[i] = g.fadeIn
  }
  return { fadeOut, fadeIn }
}
```

```ts tests
test('linear gains at the midpoint are 0.5 / 0.5', () => {
  expect(crossfadeGains(0.5, 'linear')).toEqual({ fadeOut: 0.5, fadeIn: 0.5 })
})
test('equal-power gains at the midpoint are ~0.7071 each', () => {
  const g = crossfadeGains(0.5, 'equal-power')
  expect(g.fadeOut).toBeCloseTo(Math.SQRT1_2, 6)
  expect(g.fadeIn).toBeCloseTo(Math.SQRT1_2, 6)
})
test('equal-power keeps fadeOut² + fadeIn² = 1 everywhere', () => {
  for (const x of [0, 0.1, 0.25, 0.33, 0.5, 0.8, 1]) {
    const g = crossfadeGains(x, 'equal-power')
    expect(g.fadeOut * g.fadeOut + g.fadeIn * g.fadeIn).toBeCloseTo(1, 9)
  }
})
test('linear has a -3 dB power dip in the middle', () => {
  const g = crossfadeGains(0.5, 'linear')
  expect(g.fadeOut ** 2 + g.fadeIn ** 2).toBeCloseTo(0.5, 9)
})
test('x is clamped to [0, 1]', () => {
  expect(crossfadeGains(-0.5, 'linear')).toEqual({ fadeOut: 1, fadeIn: 0 })
  expect(crossfadeGains(2, 'linear')).toEqual({ fadeOut: 0, fadeIn: 1 })
  expect(crossfadeGains(1.5, 'equal-power').fadeIn).toBeCloseTo(1, 9)
})
test('curves have the requested length and exact endpoints', () => {
  const c = crossfadeCurves(5, 'equal-power')
  expect(c.fadeOut).toBeInstanceOf(Float32Array)
  expect(c.fadeIn).toHaveLength(5)
  expect(c.fadeOut[0]).toBe(1)
  expect(c.fadeIn[0]).toBe(0)
  expect(c.fadeIn[4]).toBe(1)
  expect(c.fadeOut[4]).toBeCloseTo(0, 6)
  expect(c.fadeIn[2]).toBeCloseTo(Math.SQRT1_2, 6)
})
test('linear curve with 3 steps is [0, 0.5, 1]', () => {
  const c = crossfadeCurves(3, 'linear')
  expect(Array.from(c.fadeIn)).toEqual([0, 0.5, 1])
  expect(Array.from(c.fadeOut)).toEqual([1, 0.5, 0])
})
test('fade-in rises monotonically', () => {
  const c = crossfadeCurves(32, 'equal-power')
  for (let i = 1; i < 32; i++) expect(c.fadeIn[i]).toBeGreaterThan(c.fadeIn[i - 1])
})
test('fewer than 2 steps throws', () => {
  expect(() => crossfadeCurves(1, 'linear')).toThrow()
})
```
:::

:::challenge id=med-05-c2 lang=ts xp=60
title: Snap a video cut to the AAC frame grid
An editor wants a seam at video frame `videoFrame` of a clip with frame rate `fps`. The compressed
audio can only be cut at AAC frame boundaries (`samplesPerFrame`, default 1024) at `sampleRate`.

Write `alignSeam(videoFrame, fps, sampleRate, rounding, samplesPerFrame = 1024)` that returns:

- `videoTime` — the seam time in seconds, `videoFrame / fps`
- `audioFrame` — the index of the AAC frame boundary to cut at. The seam in samples is
  `videoTime * sampleRate`; divide by `samplesPerFrame` and round according to `rounding`:
  `'nearest'` (`Math.round`), `'before'` (floor — audio ends early, never overlaps), or
  `'after'` (ceil — audio never ends early)
- `audioTime` — that boundary in seconds, `audioFrame * samplesPerFrame / sampleRate`
- `offsetMs` — `(audioTime - videoTime) * 1000` (positive = audio cut is later than video cut)

Floating point bites here: at 23.976 fps (`24000 / 1001`), frame 512 is *exactly* 1001 AAC
frames, yet `512 * 48000 / (24000 / 1001) / 1024` evaluates to `1000.9999999999999` — and
`Math.floor` would then pick the wrong boundary. Compute the sample position as `videoFrame * sampleRate / fps` and **round it to 6
decimals** before dividing by `samplesPerFrame` (the tests include a cut that lands exactly on a
boundary).

hint: `const samples = Math.round((videoFrame * sampleRate / fps) * 1e6) / 1e6`
hint: Pick the rounding function with `rounding === 'before' ? Math.floor : rounding === 'after' ? Math.ceil : Math.round`.
hint: 16 frames at 30 fps = 25 600 samples = exactly 25 AAC frames at 48 kHz — offset 0.

```ts starter
type Rounding = 'nearest' | 'before' | 'after'

export function alignSeam(videoFrame: number, fps: number, sampleRate: number, rounding: Rounding, samplesPerFrame = 1024) {
  const videoTime = videoFrame / fps
  return { videoTime, audioFrame: 0, audioTime: videoTime, offsetMs: 0 }
}
```

```ts solution
type Rounding = 'nearest' | 'before' | 'after'

export function alignSeam(videoFrame: number, fps: number, sampleRate: number, rounding: Rounding, samplesPerFrame = 1024) {
  const videoTime = videoFrame / fps
  const samples = Math.round(((videoFrame * sampleRate) / fps) * 1e6) / 1e6
  const round = rounding === 'before' ? Math.floor : rounding === 'after' ? Math.ceil : Math.round
  const audioFrame = round(samples / samplesPerFrame)
  const audioTime = (audioFrame * samplesPerFrame) / sampleRate
  return { videoTime, audioFrame, audioTime, offsetMs: (audioTime - videoTime) * 1000 }
}
```

```ts tests
test('1 s at 30 fps / 48 kHz, nearest: frame 47, +2.667 ms', () => {
  const s = alignSeam(30, 30, 48000, 'nearest')
  expect(s.videoTime).toBe(1)
  expect(s.audioFrame).toBe(47)          // 48000 / 1024 = 46.875 → 47
  expect(s.audioTime).toBeCloseTo(1.0026667, 6)
  expect(s.offsetMs).toBeCloseTo(2.6667, 3)
})
test('before rounds down and gives a negative offset', () => {
  const s = alignSeam(30, 30, 48000, 'before')
  expect(s.audioFrame).toBe(46)
  expect(s.offsetMs).toBeCloseTo(-18.6667, 3)
})
test('after rounds up', () => {
  const s = alignSeam(45, 30, 48000, 'after')   // 72000 samples = 70.3125 frames
  expect(s.audioFrame).toBe(71)
  expect(s.offsetMs).toBeCloseTo(14.6667, 3)
})
test('grids meet every 16 frames at 30 fps / 48 kHz: offset 0 in every mode', () => {
  for (const r of ['nearest', 'before', 'after'] as const) {
    const s = alignSeam(16, 30, 48000, r)
    expect(s.audioFrame).toBe(25)
    expect(s.offsetMs).toBeCloseTo(0, 9)
  }
})
test('exact boundary survives floating point: 8 frames at 25 fps', () => {
  const s = alignSeam(8, 25, 48000, 'after')    // 15360 samples = 15 frames exactly
  expect(s.audioFrame).toBe(15)
  expect(s.offsetMs).toBeCloseTo(0, 9)
})
test('23.976 fps exact boundary survives floating point', () => {
  // 512 frames at 24000/1001 fps = 1 025 024 samples = exactly 1001 AAC frames,
  // but naive float maths gives 1000.9999999999999
  const s = alignSeam(512, 24000 / 1001, 48000, 'before')
  expect(s.audioFrame).toBe(1001)
  expect(s.offsetMs).toBeCloseTo(0, 6)
})
test('44.1 kHz and a custom frame size (HE-AAC 2048)', () => {
  const s = alignSeam(24, 24, 44100, 'nearest', 2048)       // 44100 / 2048 = 21.53 → 22
  expect(s.audioFrame).toBe(22)
  expect(s.audioTime).toBeCloseTo(22 * 2048 / 44100, 9)
})
test('nearest is never more than half an AAC frame off', () => {
  const half = (1024 / 48000) * 1000 / 2
  for (let f = 0; f < 200; f++) {
    expect(Math.abs(alignSeam(f, 30, 48000, 'nearest').offsetMs)).toBeLessThanOrEqual(half + 1e-9)
  }
})
```
:::

## How it breaks in practice

Real bugs you will meet, and how to catch each one:

- **A gap at every loop or track change.** Cause: encoder delay / padding not trimmed (edit list
  ignored, lost by a packager, or not re-applied per lap). Detect: record the output (or decode
  the file with `ffmpeg -i in.m4a out.wav`) and look for a flat line at the join in a waveform
  editor; compare `ffprobe` packet timestamps against the expected `n * lapDuration`.
- **A click at every loop point**, even though timing is perfect. Cause: the waveform values at the
  end and start of the lap don't match, and there's no fade. Detect: zoom into the waveform at the
  seam; a vertical step is a click. Fix: a 5–10 ms micro-fade or a cross-fade.
- **Volume dips at each transition between scenes.** Cause: a linear cross-fade between
  uncorrelated material (−3 dB at the midpoint). Fix: equal-power.
- **Volume swells at each loop point.** Cause: an equal-power cross-fade between correlated
  material (+3 dB). Fix: linear for self-similar joins.
- **Click when the fade starts.** Cause: a `linearRampToValueAtTime` without an anchoring
  `setValueAtTime`, or a fade scheduled in the past because it used `performance.now()` instead of
  `ctx.currentTime`. Detect: log `ctx.currentTime` next to your scheduled times; anything with
  `when < currentTime` happens immediately.
- **Works in one browser, gaps in another.** Cause: different handling of edit lists, partial
  frames at append window edges, or `decodeAudioData` trimming priming in one engine and not the
  other. Detect: compare `audioBuffer.length` with the expected number of real samples in each
  browser; test seams in every target browser, not just your dev one.
- **Lip-sync slowly drifting after many laps.** Cause: the lap duration is not a whole number of
  AAC frames, so each lap rounds its audio length and the error accumulates (e.g. +2.67 ms per lap
  → over 0.25 s after 100 laps). Detect: log `audioEnd − videoEnd` from
  `sourceBuffer.buffered` per track after each append. Fix: choose lap lengths where the grids meet
  (e.g. multiples of 533.3 ms at 30 fps / 48 kHz), or carry the rounding error into the next lap's
  offset instead of resetting it.
- **`NotSupportedError` from `setValueCurveAtTime`.** Cause: the curve overlaps another scheduled
  event (often the previous lap's curve). Fix: `cancelScheduledValues(t)` first, or alternate
  between two gain nodes.

:::quiz id=med-05-q6 xp=15
A 2-second loop at 30 fps / 48 kHz is built from compressed audio, and each lap's audio is cut at
the **nearest** AAC boundary independently, assuming each lap starts at 0. After many laps, what
happens to lip-sync?

- [ ] Nothing — each lap is at most 10.7 ms off, so the error stays bounded
- [x] It drifts: 2 s = 96 000 samples = 93.75 AAC frames, so every lap's audio is 94 frames (~5.3 ms too long) and the error accumulates lap after lap
- [ ] It drifts the other way, because rounding to nearest always rounds down
- [ ] The browser automatically corrects it with the edit list
> 93.75 rounds to 94 frames = 96 256 samples, 256 samples (5.33 ms) longer than the video lap. If
> each lap's audio is appended right after the previous one, the extra 5.33 ms adds up: after 60
> laps (2 minutes) the audio is 320 ms late. Fix it by picking a lap length on the common grid, or
> by tracking the accumulated error and rounding each lap's cut against the *absolute* timeline
> (then the error stays within ±half a frame).
:::

:::cards id=med-05-cards1 xp=15 title="Audio seams"
Q: How many samples does one AAC-LC frame decode to, and how long is that at 48 kHz?
A: 1024 samples per channel ≈ 21.33 ms (at 44.1 kHz ≈ 23.2 ms). HE-AAC outputs 2048.
Q: What are priming samples (encoder delay)?
A: Extra samples an encoder puts before the real audio because AAC's overlapping transform needs a
   previous frame. Apple's AAC encoder uses 2112 (= 44 ms at 48 kHz). They must be trimmed.
Q: Where does an MP4 say "skip the priming samples"?
A: In the track's edit list (`elst` box, `media_time`). Opus uses `pre_skip`; MPEG-TS has no standard field.
Q: Why does a waveform discontinuity click?
A: A sudden step contains energy at all frequencies; the speaker reproduces it as a broadband pop.
Q: How long is a typical de-click fade?
A: About 5–10 ms — too short to hear as a fade, long enough to remove the step.
Q: Equal-power cross-fade gains?
A: fadeOut = cos(x·π/2), fadeIn = sin(x·π/2): squares sum to 1, so power is constant for uncorrelated signals.
Q: When is a linear cross-fade better?
A: For correlated (near-identical) material, where amplitudes add: linear sums to 1, equal-power bumps by +3 dB.
Q: What do `start(when, offset, duration)`'s arguments mean?
A: `when` = time on the AudioContext clock, `offset` = position in the buffer, `duration` = how much to play.
Q: Why anchor with `setValueAtTime` before `linearRampToValueAtTime`?
A: A linear ramp starts at the previous event; without an anchor at "now" it may start in the past and jump.
Q: When do 30 fps video and 48 kHz AAC frame grids line up?
A: Every 25 600 samples = 533.3 ms = 16 video frames = 25 AAC frames.
:::

## Recap

- Audio seams are harder than video seams: ears hear a single-sample jump in the waveform, and compressed audio
  frames (1024 samples ≈ 21.33 ms at 48 kHz for AAC-LC) don't line up with video frames.
- Cutting compressed audio means snapping to the AAC grid; nearest-boundary rounding is off by at
  most ~10.7 ms. Round against the absolute timeline so errors don't accumulate over many laps.
- Encoders add **priming samples** (e.g. 2112) and **padding**; edit lists (`elst`), Opus
  `pre_skip` and similar metadata say what to trim. Ignoring them causes gaps at joins.
- Clicks come from discontinuities in the waveform. A 5–10 ms fade removes them; joining two
  sounds needs a cross-fade.
- Web Audio gives you sample-accurate control: `AudioBufferSourceNode.start(when, offset)` on the
  `AudioContext` clock, and `GainNode` automation (`setValueAtTime`, `linearRampToValueAtTime`,
  `setValueCurveAtTime`). Anchor every ramp.
- **Equal-power** (cos/sin) keeps loudness constant for uncorrelated material; **linear** is right
  for correlated material. Picking the wrong one gives a −3 dB dip or a +3 dB bump.
- Test seams by measuring: waveforms, packet timestamps, `buffered` ranges, and every target browser.
