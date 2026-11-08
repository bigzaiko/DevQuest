---
id: med-01
title: "Video in the browser: frames, codecs and keyframes"
level: beginner
minutes: 60
xp: 130
summary: The <video> element and its events, containers vs codecs, frames vs seconds, why currentTime is not frame-exact, and why decoding can only start at a keyframe.
---

A video looks like a moving picture, but to your code it's three separate things stacked on top of
each other: a **file format** that packs data into boxes, a **compressed stream** of pictures that
mostly describe *changes* from other pictures, and a **clock** that decides which picture is on screen
right now. Most video bugs in web apps (a scrubber one frame off, a "jump to 7 s" that takes two seconds,
an `.mp4` that plays sound over a black screen) happen because someone mixed up two of those layers.

This lesson gives you the model the rest of this region builds on. You'll learn the `<video>` element
API, how containers and codecs differ, how to turn seconds into frames *correctly*, and why a decoder
can only start at a keyframe. Later lessons (*Streaming: HLS playlists and Media Source Extensions*,
*Jumping along a path: seeking without stutter*, *Seamless loops: from the loop attribute to appending laps*
and *Clean sound at a seam: AAC frames, priming and cross-fades*) all assume this vocabulary.

:::info title="How the challenges in this lesson work"
The sandbox has no real video decoder, so the code challenges model the logic as **pure functions**:
numbers in, numbers out. That's also how you should write this logic in production: frame maths that
doesn't touch the DOM can be unit-tested in milliseconds.
:::

## The `<video>` element in 60 seconds

```html
<video id="player" src="/media/intro.mp4" controls playsinline preload="metadata"
       poster="/media/intro-poster.jpg" width="640" height="360"></video>
```

- `controls`: show the browser's built-in UI. Remove it and you build your own.
- `playsinline`: on iPhone, play inside the page instead of jumping to fullscreen.
- `preload="metadata"`: fetch just enough to know the duration and size, not the whole file.
  (`none` and `auto` are the other values; it's only a hint.)
- `poster`: image shown before the first frame is available.
- `muted` + `autoplay`: the only autoplay combination browsers reliably allow without a user gesture.

In JavaScript the element is an `HTMLVideoElement`, which inherits almost everything from
**`HTMLMediaElement`** (the same interface `<audio>` uses):

```ts
const video = document.querySelector<HTMLVideoElement>('#player')!

video.currentTime   // number, seconds: the current playback position (settable: that's a seek)
video.duration      // number, seconds: NaN until metadata is loaded, Infinity for a live stream
video.paused        // boolean: true initially; false as soon as play() is accepted, true again after pause() or at the end
video.ended         // boolean: true when playback reached the end (and loop is off)
video.seeking       // boolean: true while a seek is in progress
video.readyState    // 0 HAVE_NOTHING … 1 HAVE_METADATA … 2 HAVE_CURRENT_DATA … 3 HAVE_FUTURE_DATA … 4 HAVE_ENOUGH_DATA
video.playbackRate  // 1 = normal speed
video.videoWidth    // intrinsic pixel size, 0 until metadata
video.videoHeight

await video.play()  // returns a Promise: it can REJECT (autoplay policy, unsupported source…)
video.pause()
video.currentTime = 12.5   // ask for a seek; it completes asynchronously
```

### The events you'll actually use

Media loads and plays asynchronously, so almost all your logic hangs off events. In the order you'll
usually see them for a normal page load and a click on play:

```text
loadstart ─► durationchange ─► loadedmetadata ─► loadeddata ─► canplay ─► canplaythrough
                                    │                              │
                     duration, videoWidth/Height known      enough data to start playing

user clicks play:  play ─► playing ─► timeupdate … timeupdate … (every 15–250 ms)
user drags the bar: seeking ─► (waiting) ─► timeupdate ─► seeked
end of file:        timeupdate ─► pause ─► ended
problems:           waiting (buffer ran dry) · stalled (network not delivering) · error
```

| Event | Fires when | Typical use |
| --- | --- | --- |
| `loadedmetadata` | duration, dimensions and tracks are known | size the player, draw the scrubber |
| `canplay` | enough data to render and start playing | hide the loading spinner |
| `timeupdate` | the position changed (during playback 4–66 times a second) | move the progress bar |
| `seeking` / `seeked` | a seek started / finished and the new frame is ready | show / hide a seek spinner |
| `ended` | playback reached the end | show "Watch again", go to the next item |
| `waiting` | playback paused because data ran out | buffering spinner |
| `error` | loading or decoding failed (`video.error.code`) | user-facing error message |

```ts
video.addEventListener('loadedmetadata', () => {
  console.log(`${video.videoWidth}×${video.videoHeight}, ${video.duration.toFixed(2)} s`)
})
video.addEventListener('timeupdate', () => {
  progress.value = video.currentTime / video.duration
})
video.addEventListener('ended', () => showReplayButton())

try {
  await video.play()
} catch (err) {
  // NotAllowedError: autoplay blocked → show a big play button instead
  // NotSupportedError: no playable source
  showPlayButton()
}
```

:::warn title="Common mistake: reading duration too early"
Right after you set `video.src`, `duration` is `NaN` and `videoWidth` is `0`. Code that runs
"on mount" and computes `video.duration * 0.5` gets `NaN` and silently breaks the UI. Wait for
`loadedmetadata`, or check `video.readyState >= HTMLMediaElement.HAVE_METADATA` first: if the
metadata already loaded before you attached the listener, the event won't fire again.
:::

:::quiz id=med-01-q1 xp=10
Predict what this logs, on a fast connection, with a valid 10-second MP4:

```ts
const v = document.createElement('video')
v.src = '/media/ten-seconds.mp4'
console.log(v.duration, v.paused)
```

- [ ] `10 false`
- [ ] `10 true`
- [x] `NaN true`
- [ ] `0 true`
> Setting `src` only *starts* loading. Nothing has been parsed yet, so `duration` is `NaN` ("unknown",
> not zero). `paused` is `true` because nobody called `play()`. Even on localhost the metadata arrives
> asynchronously, in a later task, so you need `loadedmetadata`. `0` is the tempting wrong answer:
> `videoWidth` starts at `0`, but `duration` deliberately uses `NaN` so you can tell "unknown" from "empty".
:::

:::quiz id=med-01-q2 xp=10
A marketing page calls `video.play()` on load for an unmuted video and doesn't catch anything. What
happens in current Chrome, Safari and Firefox for a first-time visitor who hasn't interacted with the page?

- [ ] The video plays with sound
- [x] The returned promise rejects with `NotAllowedError` and the video stays paused, with an "Uncaught (in promise)" in the console
- [ ] The browser shows a permission prompt
- [ ] `play()` throws synchronously
> Autoplay policies block audible playback without a user gesture (or site engagement). `play()` never
> throws; it returns a promise that rejects. Add `muted` (plus `playsinline` for iOS) for background
> videos, and `catch` the promise so you can fall back to a play button.
:::

## Containers vs codecs

The file extension tells you the **container**, not what's inside it.

- A **codec** (coder/decoder) is the compression scheme for one stream: **H.264/AVC**, HEVC/H.265,
  VP9 and AV1 for video; **AAC**, Opus and MP3 for audio. Decoding needs codec support, often in hardware.
- A **container** is the file format that holds one or more encoded streams plus timing and
  metadata: **MP4** (the ISO Base Media File Format, also `.m4v`/`.m4a`), **WebM** (a subset of
  Matroska), MPEG-TS (`.ts`, classic HLS segments).

```text
 intro.mp4  (container: MP4 / ISO BMFF, a tree of "boxes")
 ┌──────────────────────────────────────────────────────────────────┐
 │ ftyp  "I'm MP4, brand isom/mp42"                                 │
 │ moov  track list, codecs (avc1, mp4a), timescales, sample tables │  ← the "index"
 │ mdat  ▓▓▓ video samples (H.264) ▒▒ audio samples (AAC) ▓▓▓ ▒▒ … │  ← the actual data
 └──────────────────────────────────────────────────────────────────┘

 fragmented MP4 (fMP4 / CMAF), used by Media Source Extensions and modern HLS/DASH
 ┌──────────────┬───────────┬───────────┬───────────┬──
 │ ftyp + moov  │ moof mdat │ moof mdat │ moof mdat │ …   each fragment says which
 │ (init seg.)  │ 0–2 s     │ 2–4 s     │ 4–6 s     │     samples it carries and when
 └──────────────┴───────────┴───────────┴───────────┴──
```

A regular MP4 keeps one big index (`moov`) for the whole file. A **fragmented MP4** puts a small
index (`moof`) in front of each chunk of data, so a player can receive and play the file piece by
piece. That's what streaming uses, and it's the topic of *Streaming: HLS playlists and Media Source Extensions*.

The safe default on the web today: **MP4 container, H.264 video, AAC-LC audio**. Every current
browser plays it. WebM with VP9/AV1 + Opus is a great second source for smaller files.

### Asking the browser what it can play

A MIME type alone isn't enough; you need the **codecs parameter**, which describes exactly which
profile and level of the codec is used:

```ts
const v = document.createElement('video')

v.canPlayType('video/mp4')                                    // "maybe": the container alone tells nothing
v.canPlayType('video/mp4; codecs="avc1.640028, mp4a.40.2"')    // "probably": H.264 High@4.0 + AAC-LC
v.canPlayType('video/webm; codecs="vp9, opus"')                 // "probably" in most browsers
v.canPlayType('video/x-flv')                                    // "": definitely not

// For Media Source Extensions (streaming), the answer is a boolean:
MediaSource.isTypeSupported('video/mp4; codecs="avc1.640028, mp4a.40.2"')   // true
// (on iPhone, MediaSource doesn't exist: Safari there only exposes ManagedMediaSource, iOS 17.1+)

// WebCodecs (decoding frames yourself) asks asynchronously:
const { supported } = await VideoDecoder.isConfigSupported({ codec: 'avc1.640028' })
```

`canPlayType` returns a string, `""`, `"maybe"` or `"probably"`, because a browser can't be certain
before it tries. Treat `""` as no and anything else as "try it". The codec string isn't magic: in
`avc1.640028`, `64` is the profile (High), `00` the constraint flags and `28` the level in hex (40 →
level 4.0). `mp4a.40.2` means MPEG-4 audio, object type 2 = AAC-LC.

```html
<!-- Let the browser pick the first source it can play -->
<video controls playsinline>
  <source src="/media/intro.av1.mp4" type='video/mp4; codecs="av01.0.08M.08, mp4a.40.2"'>
  <source src="/media/intro.h264.mp4" type='video/mp4; codecs="avc1.640028, mp4a.40.2"'>
</video>
```

:::quiz id=med-01-q3 xp=10
A user uploads `holiday.mp4` recorded on a phone. It plays fine in Safari, but in another browser on
an older Windows laptop you hear the audio over a black (or frozen) picture. What's the most likely cause?

- [ ] The file extension should have been `.webm`
- [x] The MP4 container is fine, but the video stream uses a codec (for example HEVC/H.265) that browser can't decode, while the AAC audio decodes fine
- [ ] The `moov` box is at the end of the file
- [ ] `preload="metadata"` stops the video track from loading
> Container and codec are separate. The browser could open the MP4 and decode the AAC track, but not
> the video codec inside it. Many phones record HEVC by default and HEVC support depends on browser,
> OS and hardware. Check with `canPlayType('video/mp4; codecs="hvc1…"')` and transcode uploads to
> H.264 (or offer AV1/VP9 + an H.264 fallback). A `moov` at the end delays the start; it doesn't drop a track.
:::

:::job title="What you'll meet at work"
Teams almost never serve user uploads as-is. A server-side job (usually **FFmpeg**) transcodes every
upload to a known-good ladder: H.264 + AAC in MP4 for compatibility, sometimes AV1 or VP9 for
bandwidth, a fixed keyframe interval, `-movflags +faststart` (index at the front). The first thing a
senior asks about a "video doesn't play" bug is: *what does `ffprobe` say about the codecs?*

```bash
ffprobe -v error -show_entries stream=codec_type,codec_name,profile,r_frame_rate,avg_frame_rate \
        -of compact holiday.mp4
```
:::

## Frames vs seconds

A video stream is a sequence of still pictures, **frames**, each shown for a fixed time at a
constant frame rate. At 30 frames per second (fps), each frame lasts `1/30 s ≈ 33.33 ms`:

```text
time (s)  0        1/30      2/30      3/30      4/30      5/30
          │         │         │         │         │         │
          ├─frame 0─┼─frame 1─┼─frame 2─┼─frame 3─┼─frame 4─┤
          ▲                   ▲    ▲
          frame 0 starts      │    currentTime = 0.08 → still frame 2 (0.0667 ≤ t < 0.1)
                              frame 2 starts at 2/30 = 0.0667 s
```

The convention used in the rest of this region: **frame `k` is on screen during the half-open interval
`[k / fps, (k + 1) / fps)`**. So:

- *time → frame*: `k = floor(t × fps)`
- *frame → time* (its start): `t = k / fps`
- *snap a time to the grid*: take the start of the frame that contains it
- a video of `N` frames lasts `N / fps` seconds; its last frame `N − 1` starts at `duration − 1/fps`

Common frame rates and their real values:

| Name | Exact rate | Frame duration |
| --- | --- | --- |
| 24 (cinema) | 24 | 41.667 ms |
| "23.976" | 24000 / 1001 | 41.708 ms |
| 25 (PAL / Europe) | 25 | 40 ms |
| "29.97" (NTSC) | 30000 / 1001 | 33.367 ms |
| 30 | 30 | 33.333 ms |
| 60 / "59.94" | 60 / 60000 / 1001 | 16.667 / 16.683 ms |

:::warn title="29.97 is not 30"
If you round an NTSC-rate video to 30 fps, your frame numbers drift by 0.1 %: 3.6 seconds (~108 frames)
per hour. Keep the rate as a fraction (`30000/1001`) or as a number computed from one, never a hand-typed `29.97`.
:::

### Why `currentTime` is not frame-exact

`currentTime` is a floating-point number of seconds. Three things stop it from being a reliable frame clock:

1. **Floating point.** `1/30` has no exact binary representation. `4.1 * 30` in JavaScript is
   `122.99999999999999`, so a naive `Math.floor(t * fps)` says frame 122 for a time that is
   *exactly* the start of frame 123. Stepping with `t += 1/30` accumulates the error further.
2. **The clock isn't the picture.** During playback, `currentTime` is the media clock sampled when
   the browser fires `timeupdate`. The frame you see was composited slightly before or after that.
   `timeupdate` fires every 15–250 ms (browsers typically choose ~250 ms), not once per frame.
3. **Container timestamps are integers in a timescale**, e.g. ticks of 1/90000 s or 1/15360 s. The
   browser converts them to seconds for you; the conversion can round, and some files have a small
   start offset (the first frame isn't at exactly 0).

For per-frame work, use **`requestVideoFrameCallback`** (Chrome/Edge, Safari, Firefox 132+). It calls
you once per *presented* frame with that frame's media timestamp:

```ts
function onFrame(now: DOMHighResTimeStamp, meta: VideoFrameCallbackMetadata) {
  const frame = Math.round(meta.mediaTime * fps) // mediaTime ≈ frame start, so round here
  frameLabel.textContent = `frame ${frame} (${meta.presentedFrames} presented)`
  video.requestVideoFrameCallback(onFrame)       // re-register every time, like requestAnimationFrame
}
video.requestVideoFrameCallback(onFrame)
```

And when you seek to a specific frame, aim for the **middle** of it, not its edge, so a tiny rounding
error can't put you on the previous frame:

```ts
function seekToFrame(video: HTMLVideoElement, k: number, fps: number) {
  video.currentTime = (k + 0.5) / fps
}
```

:::quiz id=med-01-q4 xp=10
A 30 fps clip. Your "next frame" button runs `video.currentTime += 1 / 30` and your label shows
`Math.floor(video.currentTime * 30)`. After many clicks, what will users report?

- [ ] Nothing: the maths is exact
- [x] Occasionally the label (or the shown picture) repeats a frame or skips one, because the float sum ends up a hair below a frame boundary
- [ ] The video always drifts one second per minute
- [ ] `currentTime` refuses values that aren't multiples of 1/30
> Repeated float addition and `floor` on a product like `122.99999999999999` give off-by-one frames
> right at the boundaries. Fix it by tracking the integer frame index as your source of truth, seeking
> to `(k + 0.5) / fps`, and converting time to frames with a small tolerance (the challenge below).
> Browsers accept any `currentTime`; they don't snap it to frames for you.
:::

:::quiz id=med-01-q5 xp=10
You need an overlay that changes exactly on frame 120 of a 24 fps video while it plays. Which approach is reliable?

- [ ] A `timeupdate` listener checking `currentTime >= 5`
- [ ] `setInterval(check, 1000 / 24)`
- [x] `requestVideoFrameCallback`, comparing the frame computed from `metadata.mediaTime`
- [ ] `requestAnimationFrame`, reading `currentTime`
> `timeupdate` can come 250 ms late (6 frames at 24 fps). Timers and `requestAnimationFrame` run on the
> display/JS clock, not per decoded video frame, so they can fire twice for one frame or miss one.
> `requestVideoFrameCallback` runs once per presented video frame and tells you that frame's media time.
:::

### Challenge: frame ↔ time helpers

:::challenge id=med-01-c1 lang=ts xp=40
title: Frame maths that survives floating point
Write four helpers for a constant-frame-rate video. Frame `k` covers `[k / fps, (k + 1) / fps)`.

- `frameToTime(frame, fps)`: start time of frame `frame`, in seconds.
- `timeToFrame(t, fps)`: index of the frame on screen at time `t`. Negative times clamp to frame `0`.
  It must survive floating point: `timeToFrame(4.1, 30)` is `123` even though `4.1 * 30` is `122.99999999999999`.
- `snapToFrame(t, fps)`: the start time of the frame that contains `t`.
- `lastFrameBefore(end, fps)`: index of the last frame that **starts strictly before** `end`
  (e.g. for a clip that should stop at `end`). If no frame starts before `end`, return `-1`.

The starter is the naive version most people write first. Run the tests and see where it breaks.

hint: Add a tiny tolerance in *frame* units before rounding: `Math.floor(t * fps + 1e-6)`.
hint: For `lastFrameBefore`, the frame starting exactly at `end` doesn't count: `Math.ceil(end * fps - 1e-6) - 1`.
hint: `snapToFrame` is just `frameToTime(timeToFrame(t, fps), fps)`.

```ts starter
export function frameToTime(frame: number, fps: number): number {
  return frame / fps
}

export function timeToFrame(t: number, fps: number): number {
  return Math.floor(t * fps)
}

export function snapToFrame(t: number, fps: number): number {
  return Math.floor(t * fps) / fps
}

export function lastFrameBefore(end: number, fps: number): number {
  return Math.floor(end * fps)
}
```

```ts solution
// Tolerance in frame units: far below one frame, far above float error.
const EPS = 1e-6

export function frameToTime(frame: number, fps: number): number {
  return frame / fps
}

export function timeToFrame(t: number, fps: number): number {
  return Math.max(0, Math.floor(t * fps + EPS))
}

export function snapToFrame(t: number, fps: number): number {
  return frameToTime(timeToFrame(t, fps), fps)
}

export function lastFrameBefore(end: number, fps: number): number {
  return Math.ceil(end * fps - EPS) - 1
}
```

```ts tests
const NTSC = 30000 / 1001

test('frameToTime gives the frame start', () => {
  expect(frameToTime(30, 30)).toBe(1)
  expect(frameToTime(3, 25)).toBeCloseTo(0.12, 9)
  expect(frameToTime(0, 24)).toBe(0)
})
test('timeToFrame: inside a frame', () => {
  expect(timeToFrame(0, 30)).toBe(0)
  expect(timeToFrame(0.05, 30)).toBe(1)
  expect(timeToFrame(1, NTSC)).toBe(29)
})
test('timeToFrame survives floating point at frame boundaries', () => {
  expect(timeToFrame(4.1, 30)).toBe(123)
  expect(timeToFrame(7 * (1 / 24), 24)).toBe(7)
  expect(timeToFrame(31 * (1 / 30), 30)).toBe(31)
})
test('timeToFrame clamps negative times to 0', () => {
  expect(timeToFrame(-0.2, 30)).toBe(0)
})
test('snapToFrame moves a time to the start of its frame', () => {
  expect(snapToFrame(4.11, 30)).toBeCloseTo(4.1, 9)
  expect(snapToFrame(4.1, 30)).toBeCloseTo(4.1, 9)
  expect(snapToFrame(0.049, 30)).toBeCloseTo(1 / 30, 9)
})
test('lastFrameBefore excludes a frame that starts exactly at end', () => {
  expect(lastFrameBefore(1, 30)).toBe(29)
  expect(lastFrameBefore(10, 24)).toBe(239)
  expect(lastFrameBefore(31 / 30, 30)).toBe(30)
})
test('lastFrameBefore includes a frame that starts just before end', () => {
  expect(lastFrameBefore(1.01, 30)).toBe(30)
})
test('lastFrameBefore returns -1 when nothing starts before end', () => {
  expect(lastFrameBefore(0, 30)).toBe(-1)
})
```
:::

:::pro title="Integers all the way down"
Media pipelines avoid floating-point seconds wherever they can. MP4 and MPEG-TS store timestamps as
**integers in a timescale** (MPEG-TS always uses 90 kHz), WebCodecs uses integer **microseconds**,
and frame rates are kept as fractions (`30000/1001`). Do your bookkeeping in frame indices or ticks,
and convert to seconds only at the edge, when you set `currentTime` or show a label. When you must
convert, round with an explicit tolerance and seek to frame *middles*.
:::

## Keyframes and GOPs: why you can't start anywhere

Uncompressed 1080p video (24-bit RGB) is about 6 MB per frame, so 186 MB per second at 30 fps. Codecs get that down to
a few megabits per second mostly by **not storing whole pictures**. Instead, most frames describe how
to change other frames. There are three kinds of frame:

- **I-frame** (intra, a **keyframe**): a complete picture, decodable on its own. Big.
- **P-frame** (predicted): "take the previous reference frame and move/patch these blocks". Small.
- **B-frame** (bi-directional): predicted from a frame *before* and a frame *after* it. Smallest.

A keyframe plus all the frames that depend on it is a **GOP** (group of pictures). In H.264 a keyframe
the decoder can safely start from is an **IDR** frame (instantaneous decoder refresh): nothing after it
refers to anything before it. That's a *closed* GOP, and it's what streaming wants.

```text
presentation order (what you see)
  I0  B1  B2  P3  B4  B5  P6  B7  B8  P9 │ I10 B11 …
  └──────────────── GOP 1 ───────────────┘ └── GOP 2 …

dependencies:   P3 ← I0      P6 ← P3      B1, B2 ← I0 and P3      B4, B5 ← P3 and P6

decode order (what the decoder receives)
  I0  P3  B1  B2  P6  B4  B5  P9  B7  B8 │ I10 …
```

Because B-frames need a *future* frame, the decoder has to receive P3 before B1. So frames carry two
timestamps: the **DTS** (decode timestamp) and the **PTS** (presentation timestamp). In a stream with
B-frames they're in different orders, which is why you'll see "PTS/DTS" in every FFmpeg error message.

### What that means for seeking

To show frame 70 you need the frames it depends on, which need *their* references, all the way back
to the previous keyframe. A seek is therefore:

```text
keyframe every 2 s at 30 fps (GOP = 60 frames)

frame  0 ─────────── 60 ─────────── 120 ──────────── 180
       I              I               I                I
                         seek to 2.33 s (frame 70)
                      ▲───decode──▶▲
                      60          70        → decode 11 frames, show the last one

keyframe every 10 s (GOP = 300 frames): seek to 9.9 s (frame 297) → decode 298 frames first
```

That's why the same seek is instant in one file and laggy in another: the cost depends on the
**distance to the previous keyframe**, not on the file size. It also explains:

- Firefox and Safari have `video.fastSeek(t)`, which jumps to a *nearby keyframe* instead of the exact time
  (fast, imprecise: good for scrubbing previews).
- Media Source Extensions drop appended frames until they see a keyframe after the first append or a
  discontinuity, so each segment should start with one (HLS segments too).
- WebCodecs' `VideoDecoder.decode()` throws a `DataError` if the first chunk after `configure()` or `flush()`
  is a `'delta'` chunk: you must feed it an `EncodedVideoChunk` with `type: 'key'` first.

```ts
const decoder = new VideoDecoder({
  output: (frame) => { ctx.drawImage(frame, 0, 0); frame.close() },
  error: (e) => console.error(e),
})
// No `description` (avcC box) given, so the chunks must be in Annex B format (start codes)
decoder.configure({ codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 })
decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: 0, data: firstKeyframeBytes }))
// …then 'delta' chunks, with timestamps in microseconds
```

Encoders choose a trade-off. Short GOPs (1–2 s) seek fast and cut cleanly into streaming segments,
but cost more bits. Long GOPs (5–10 s; x264's default maximum is 250 frames, 10 s at 25 fps) compress better
and seek worse. You control it when transcoding:

```bash
# H.264 + AAC, a keyframe exactly every 48 frames (2 s at 24 fps), no extra scene-cut keyframes
ffmpeg -i input.mov -c:v libx264 -profile:v high -crf 20 \
       -g 48 -keyint_min 48 -sc_threshold 0 \
       -c:a aac -b:a 128k -movflags +faststart output.mp4

# List the keyframe timestamps of a file (FFmpeg 5+; older versions call the field pkt_pts_time)
ffprobe -v error -select_streams v:0 -skip_frame nokey \
        -show_entries frame=pts_time -of csv=p=0 output.mp4
# 0.000000
# 2.000000
# 4.000000 …
```

:::quiz id=med-01-q6 xp=10
Two files with the same content and the same bitrate. File A has a keyframe every 2 s, file B every 10 s.
A user clicks the timeline at 9.5 s in each. What do you predict?

- [ ] Both seek equally fast: the browser reads only the bytes at 9.5 s
- [x] File B is noticeably slower: the decoder must start at the keyframe at 0 s and decode ~9.5 s of frames before it can show 9.5 s; file A starts from the keyframe at 8 s
- [ ] File A is slower because it has more keyframes to read
- [ ] File B can't seek at all
> Decoding can only start at a keyframe, so seek cost grows with the distance back to the previous
> keyframe. B needs ~285 frames at 30 fps, A needs ~45. Both *can* seek; B just stutters. That's why
> streaming encodes use short, fixed GOPs.
:::

:::quiz id=med-01-q7 xp=10
Select all that are true for a stream that uses B-frames.

- [x] Frames reach the decoder in a different order than they appear on screen
- [x] Each frame has a decode timestamp (DTS) and a presentation timestamp (PTS) that can differ
- [ ] A B-frame can be decoded on its own
- [x] A decoder can't start from a B-frame or a P-frame
- [ ] B-frames make seeking more precise
> B-frames reference a later frame, so that frame is sent first: decode order ≠ presentation order,
> hence DTS vs PTS. Only keyframes (I/IDR) are self-contained starting points. B-frames save bits;
> they don't help seeking (if anything, they make decoding around a seek point a little more involved).
:::

### Challenge: where does the decoder start?

:::challenge id=med-01-c2 lang=ts xp=40
title: Keyframe before a seek target
A player keeps a sorted list of **keyframe frame indices** (from the container's sync-sample table or an
`ffprobe` run). Write:

- `decodeStart(target, keyframes, fps)`: the keyframe index the decoder must start from to show the frame at
  time `target` (the last keyframe at or before that frame). Throw an `Error` if there is none (empty
  list, or the target frame is before the first keyframe).
- `decodeCost(target, keyframes, fps)`: how many frames must be decoded to show that frame, counting the
  keyframe and the target frame (ignore B-frame reordering).

`timeToFrame` from the previous challenge is provided in the setup.

hint: Find the target frame first with `timeToFrame(target, fps)`, then walk the list while `keyframes[i] <= frame`.
hint: Cost is `frame - start + 1`: seeking exactly onto a keyframe costs 1.

```ts setup
const EPS = 1e-6
function timeToFrame(t: number, fps: number): number {
  return Math.max(0, Math.floor(t * fps + EPS))
}
```

```ts starter
export function decodeStart(target: number, keyframes: number[], fps: number): number {
  return keyframes[0]
}

export function decodeCost(target: number, keyframes: number[], fps: number): number {
  return timeToFrame(target, fps)
}
```

```ts solution
export function decodeStart(target: number, keyframes: number[], fps: number): number {
  const frame = timeToFrame(target, fps)
  let start = -1
  for (const k of keyframes) {
    if (k <= frame) start = k
    else break
  }
  if (start < 0) throw new Error(`no keyframe at or before frame ${frame}`)
  return start
}

export function decodeCost(target: number, keyframes: number[], fps: number): number {
  return timeToFrame(target, fps) - decodeStart(target, keyframes, fps) + 1
}
```

```ts tests
const gop2s = [0, 48, 96, 144]   // 24 fps, keyframe every 2 s

test('picks the last keyframe before the target', () => {
  expect(decodeStart(3, gop2s, 24)).toBe(48)
  expect(decodeStart(5.9, gop2s, 24)).toBe(96)
})
test('a target exactly on a keyframe starts there', () => {
  expect(decodeStart(2, gop2s, 24)).toBe(48)
  expect(decodeCost(2, gop2s, 24)).toBe(1)
})
test('cost counts keyframe and target frame', () => {
  expect(decodeCost(3, gop2s, 24)).toBe(25)
  expect(decodeCost(0, gop2s, 24)).toBe(1)
})
test('past the last keyframe uses the last one', () => {
  expect(decodeStart(100, gop2s, 24)).toBe(144)
})
test('irregular keyframes (scene cuts) work too', () => {
  expect(decodeStart(4.1, [0, 37, 121, 300], 30)).toBe(121)
  expect(decodeCost(4.1, [0, 37, 121, 300], 30)).toBe(3)
})
test('long GOP is expensive', () => {
  expect(decodeCost(9.9, [0, 300], 30)).toBe(298)
})
test('throws when there is no keyframe to start from', () => {
  expect(() => decodeStart(1, [], 30)).toThrow()
  expect(() => decodeStart(0.5, [30, 60], 30)).toThrow()
})
```
:::

## How it breaks in practice

These are the video bugs that reach production most often, how to spot them, and the fix.

| Symptom | Cause | How to detect | Fix |
| --- | --- | --- | --- |
| Progress bar shows `NaN:NaN`, or width is `NaN%` | `duration` read before `loadedmetadata` | log `readyState` where you read it | wait for `loadedmetadata`, check `Number.isFinite(duration)` |
| Live stream UI breaks | `duration` is `Infinity` | `!Number.isFinite(video.duration)` | use `video.seekable` ranges for live |
| Sound, black picture | unsupported video codec (often HEVC from phones) | `ffprobe`; `canPlayType` with the codec string | transcode to H.264, add `<source>` fallbacks |
| Long wait before the first frame of a large MP4 | `moov` index at the end of the file | `ffprobe -v trace` / box viewer shows `mdat` before `moov` | `ffmpeg … -movflags +faststart` |
| Frame counter off by one at some positions | `Math.floor(t * fps)` on float boundaries | unit tests at exact boundaries (`4.1 × 30`) | tolerance in frame units, seek to `(k + 0.5) / fps` |
| Frame numbers drift over long videos | 29.97 treated as 30, or `t += 1/fps` accumulation | compare against `requestVideoFrameCallback` `mediaTime` after an hour | keep rates as fractions, track integer frame indices |
| Overlay appears up to ¼ s late | driven by `timeupdate` | log `performance.now()` deltas between events (~250 ms) | `requestVideoFrameCallback` |
| Seeking lags only on some files | long GOP (keyframe every 5–10 s) | `ffprobe -skip_frame nokey` keyframe list | re-encode with `-g` = 1–2 s worth of frames |
| "Uncaught (in promise) NotAllowedError" | unmuted autoplay without a gesture | console, error monitoring | `muted playsinline`, `catch` `play()` and show a play button |
| Frame maths is wrong for phone videos | variable frame rate (VFR) | `ffprobe`: `avg_frame_rate` ≠ `r_frame_rate` is a strong hint; uneven `mediaTime` steps | transcode to constant frame rate, or work from real frame timestamps |

:::tip title="A tiny debug overlay pays for itself"
During development, print `readyState`, `currentTime.toFixed(3)`, the computed frame index, `buffered`
ranges and the last event name in a corner of the player. Half the bugs above become obvious in seconds.
:::

:::cards id=med-01-cards1 xp=15 title="Video basics"
Q: Container vs codec?
A: The container (MP4, WebM, MPEG-TS) packs streams plus timing and metadata. The codec (H.264, VP9, AV1, AAC, Opus) is how each stream is compressed. The extension only tells you the container.
Q: What is `duration` before `loadedmetadata`? For a live stream?
A: `NaN` before metadata; `Infinity` for an unbounded live stream.
Q: What do `canPlayType` and `MediaSource.isTypeSupported` return?
A: `canPlayType`: `""`, `"maybe"` or `"probably"`. `isTypeSupported`: a boolean. Always pass a codecs parameter for a useful answer.
Q: What does `avc1.640028, mp4a.40.2` mean?
A: H.264 High profile (0x64), level 4.0 (0x28 = 40), plus AAC-LC audio (MPEG-4 audio object type 2).
Q: Which interval does frame `k` cover?
A: `[k / fps, (k + 1) / fps)`, so time → frame is `floor(t × fps)` with a small tolerance.
Q: Why not use `timeupdate` for frame-accurate work?
A: It fires every 15–250 ms (often ~250 ms), not per frame. Use `requestVideoFrameCallback`.
Q: Where should you seek to show frame `k`?
A: The middle of it, `(k + 0.5) / fps`, so rounding can't snap you to frame `k − 1`.
Q: I-, P- and B-frames?
A: I = complete picture (keyframe). P = predicted from an earlier frame. B = predicted from earlier and later frames.
Q: What is a GOP, and why does its length matter?
A: A keyframe plus the frames that depend on it. Seek cost grows with the distance back to the previous keyframe; short GOPs seek faster but cost bits.
Q: PTS vs DTS?
A: Presentation timestamp (when it's shown) vs decode timestamp (when it's decoded). They differ when B-frames reorder frames.
Q: Why does WebCodecs reject my first chunk?
A: After `configure()` or `flush()`, the first chunk must be a keyframe (`type: 'key'`); otherwise `decode()` throws a `DataError`.
:::

## Recap

- `<video>` is an `HTMLMediaElement`: `currentTime`, `duration`, `paused`, `ended`, `seeking`, `readyState`,
  and a promise-returning `play()` that can reject under autoplay rules.
- Everything is asynchronous: wait for `loadedmetadata` before reading `duration`, use `canplay` to start,
  `seeking`/`seeked` around jumps, `ended` at the end, `timeupdate` only for coarse UI.
- The container (MP4/fMP4, WebM) is not the codec (H.264, AAC, VP9, AV1, Opus). Ask with codec strings via
  `canPlayType`, `MediaSource.isTypeSupported` or `VideoDecoder.isConfigSupported`.
- Frame `k` covers `[k/fps, (k+1)/fps)`. Keep frame rates as fractions, track integer frame indices, convert
  with a tolerance, and seek to frame middles. `currentTime` is a float clock, not a frame counter;
  `requestVideoFrameCallback` gives you real per-frame timestamps.
- Most frames are P/B-frames that depend on others. Decoding can only start at a keyframe, so seek cost
  depends on GOP length, and segments, MSE appends and WebCodecs all begin with a keyframe.
- Next: *Streaming: HLS playlists and Media Source Extensions* shows how fragmented MP4 segments get from
  a playlist into a `<video>` element.
