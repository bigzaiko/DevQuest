---
id: med-02
title: "Streaming: HLS playlists and Media Source Extensions"
level: intermediate
minutes: 70
xp: 170
summary: Why video is cut into segments, how HLS playlists describe them (multivariant vs media playlists, VOD vs live), and how players feed the bytes to a video element with Media Source Extensions.
---

In *Video in the browser: frames, codecs and keyframes* you gave a `<video>` element one URL and
let it handle everything. That's fine for a 20-second clip on a marketing page. Netflix, YouTube, Twitch, a
Zoom recording or your company's training portal don't work that way. They cut every video
into **small segments of a few seconds**, encode it at **several qualities**, and ship a
**playlist** that tells the player what exists. The player (usually a JavaScript library) then
downloads segments one by one and feeds the bytes to the video element through
**Media Source Extensions (MSE)**.

This lesson covers both halves. First the *format*: HLS playlists (RFC 8216), the most widely
deployed streaming format. Then the *browser API*: MSE, the low-level "here are some bytes, please
decode them" interface that hls.js, dash.js, Shaka Player and Video.js are built on. By the end
you can read a playlist by eye, work out which segment a timestamp falls in, and explain why a
player stalls even though "the buffer isn't empty".

## Why not just one big MP4?

A single MP4 served over HTTP actually works quite well. Browsers use **range requests**
(`Range: bytes=…`) to fetch the part they need, and with the `moov` index at the front of the file
("fast start") you can even seek before the download finishes. This is called
**progressive download**. Its limits show up quickly:

| Problem | One progressive MP4 | Segmented streaming |
|---|---|---|
| Viewer's bandwidth drops from 20 to 2 Mbit/s | Stalls; the file has one bitrate | Player switches to a lower quality at the next segment |
| Phone on 4G vs 4K TV on fibre | Same file for both (too big or too blurry) | Each picks a rendition from a ladder (e.g. 360p…2160p) |
| Live events | Impossible: the file isn't finished | New segments keep appearing in the playlist |
| CDN caching | Huge objects, range requests are harder to cache | Small, immutable files: ideal for CDNs |
| Alternate audio languages, subtitles | Must all be muxed into the file | Separate playlists, downloaded only if chosen |

Picking a quality per segment based on measured throughput and buffer level is called
**adaptive bitrate streaming (ABR)**. It's the main reason segmented streaming exists. HLS (Apple,
2009, RFC 8216 in 2017) and MPEG-DASH (ISO standard, XML manifests) are the two big formats.
They're conceptually the same: a manifest plus segments. Since 2016 both can carry the **same
fMP4 segments** (the CMAF idea), so one encode can serve both. This lesson uses HLS because its
manifests are plain text and easy to read.

:::quiz id=med-02-q1 xp=10
A viewer starts a 2-hour film on hotel Wi-Fi at 8 Mbit/s. After 10 minutes the connection drops to
1.5 Mbit/s. **Predict:** what does a well-configured HLS player do that a single progressive MP4
(encoded at 6 Mbit/s) cannot?

- [ ] It re-encodes the remaining film at a lower bitrate on the viewer's device
- [x] It keeps playing from its buffer and fetches the next segments from a lower-bitrate rendition listed in the playlist
- [ ] It pauses until the bandwidth recovers, then continues at the same quality
- [ ] It switches the current segment to a lower quality mid-segment, frame by frame
> The renditions are encoded ahead of time on the server. The player only *chooses* among them,
> once per segment. Segments start on keyframes (see the frames lesson), which is why switching at
> a segment boundary is clean. Switching mid-segment would mean decoding frames whose reference
> frames belong to another encode. A progressive 6 Mbit/s MP4 needs 6 Mbit/s on average no matter
> what, so on a 1.5 Mbit/s link it stalls over and over. Re-encoding on the client is never done.
:::

## HLS in one picture

```text
                     master.m3u8  (multivariant playlist: "what versions exist?")
                    /           |              \
        360p/index.m3u8   720p/index.m3u8   1080p/index.m3u8   (media playlists: "which segments?")
              |                 |                  |
        init.mp4           init.mp4           init.mp4          (initialization segment, fMP4 only)
        seg0.m4s           seg0.m4s           seg0.m4s          <- 0.000 .. 6.006 s
        seg1.m4s           seg1.m4s           seg1.m4s          <- 6.006 .. 12.012 s
        seg2.m4s           seg2.m4s           seg2.m4s          <- 12.012 .. 18.018 s
          ...                ...                ...

  ABR: the player may take seg0 from 360p, seg1 from 720p, seg2 from 1080p.
       Every rendition is cut at the same times, on keyframes, so the switch is seamless.
```

Everything is plain HTTP GETs of static files, so any web server or CDN can serve HLS. The
playlist MIME type is `application/vnd.apple.mpegurl` (also seen as `application/x-mpegURL`), and
the file extension is `.m3u8` (an M3U playlist in UTF-8).

## The multivariant playlist

The entry point lists the **variant streams** (renditions). RFC 8216 calls it the *master
playlist*. The updated spec draft (RFC 8216bis) and Apple's docs now say **multivariant
playlist**. Same thing.

```text
#EXTM3U
#EXT-X-VERSION:6
#EXT-X-INDEPENDENT-SEGMENTS

#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio/en/index.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Deutsch",LANGUAGE="de",DEFAULT=NO,AUTOSELECT=YES,URI="audio/de/index.m3u8"

#EXT-X-STREAM-INF:BANDWIDTH=1200000,AVERAGE-BANDWIDTH=950000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",AUDIO="aud"
360p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3500000,AVERAGE-BANDWIDTH=2800000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aud"
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=7000000,AVERAGE-BANDWIDTH=5500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"
1080p/index.m3u8
```

- Lines starting with `#EXT` are **tags**. Other lines starting with `#` are comments. Every
  other non-blank line is a **URI**. URIs are relative to the playlist's own URL.
- `#EXT-X-STREAM-INF` describes the variant whose URI is on the **next line**. `BANDWIDTH` is the
  peak bitrate in bits per second, and ABR algorithms compare it to measured throughput. `CODECS`
  uses the same codec strings as `MediaSource.isTypeSupported()`, so a player can skip
  variants the device can't decode before downloading anything.
- `#EXT-X-MEDIA` declares alternate renditions (audio languages, subtitles) that variants refer
  to by `GROUP-ID`.

## The media playlist

Each variant URI points to a **media playlist**, which is the actual list of segments:

```text
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6.006,
seg0.m4s
#EXTINF:6.006,
seg1.m4s
#EXTINF:6.006,
seg2.m4s
#EXTINF:3.003,
seg3.m4s
#EXT-X-ENDLIST
```

| Tag | Meaning |
|---|---|
| `#EXTM3U` | Must be the first line. Otherwise it isn't an HLS playlist |
| `#EXTINF:<duration>,[<title>]` | Duration in seconds of the **next** segment (decimals allowed; the title after the comma is optional and usually empty) |
| `#EXT-X-TARGETDURATION:<n>` | Integer upper bound: every `EXTINF` duration, **rounded to the nearest integer**, must be ≤ n. Players also use it for live reload timing |
| `#EXT-X-MEDIA-SEQUENCE:<n>` | Sequence number of the first segment in this file (default 0). Segment *k* in the list has number n + k |
| `#EXT-X-MAP:URI="…"` | Initialization segment for fMP4 (codec setup, no frames). Applies to the segments after it |
| `#EXT-X-DISCONTINUITY` | Next segment changes encoding parameters or timestamp sequence (ad insertion, stream restart) |
| `#EXT-X-PROGRAM-DATE-TIME` | Maps a segment to a wall-clock time (useful for live "jump to 14:05") |
| `#EXT-X-PLAYLIST-TYPE:VOD` / `EVENT` | VOD: the list never changes. EVENT: segments are only appended, never removed |
| `#EXT-X-ENDLIST` | No more segments will ever be added |

A segment's **start time** isn't written anywhere. You compute it by adding up the
durations of every earlier segment. That gives the player a **timeline**:

```text
 seq:    0              1              2              3
       |--------------|--------------|--------------|-------|
 t:    0.000        6.006         12.012         18.018   21.021
       ^ seg0.m4s     ^ seg1.m4s     ^ seg2.m4s     ^ seg3.m4s

 "Seek to 13.5 s"  ->  13.5 is in [12.012, 18.018)  ->  fetch seg2.m4s (seq 2)
```

The odd `6.006` comes from 29.97 fps video (30000/1001). 180 frames × 1001/30000 s = 6.006 s.
Segments are cut on keyframes, so their durations are whole numbers of frames, not round
seconds. That's normal, and it's why your timeline math must be in floating point.

:::quiz id=med-02-q2 xp=10
A packager writes this playlist. **Predict:** what does a strict validator (e.g. Apple's
`mediastreamvalidator`) say?

```text
#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.006,
a.ts
#EXTINF:6.4,
b.ts
#EXTINF:5.9,
c.ts
#EXT-X-ENDLIST
```

- [x] It is valid: every duration rounds to 6 or less
- [ ] It is invalid: `6.006` is greater than 6
- [ ] It is invalid: `6.4` is greater than 6
- [ ] It is invalid: `5.9` is shorter than the target duration
> It **is valid**. The rule is that each `EXTINF`
> duration *rounded to the nearest integer* must be ≤ `EXT-X-TARGETDURATION`. 6.006 → 6, 6.4 → 6,
> 5.9 → 6. A 6.6 s segment (→ 7) would break the rule. Segments may be *shorter* than the target
> (the last one usually is), and the rule applies to VOD too. Players size their buffers and
> live reload intervals from the target duration, so a lying value causes real stalls.
:::

## Segment formats: TS and fMP4

A media playlist can point at two kinds of segment:

- **MPEG-2 Transport Stream (`.ts`)**. The original HLS format, from broadcast TV. Each segment is
  self-contained: codec info is repeated inside it, so no init segment is needed. Downsides: noticeable
  container overhead (typically somewhere around 5–15 %, more at low bitrates), and **MSE support for
  TS is patchy** (many browsers don't accept `video/mp2t` at all). JavaScript players *transmux*
  it (re-wrap the same compressed frames into fMP4) before appending, which hls.js does
  in a Web Worker.
- **Fragmented MP4 (fMP4, `.m4s` / `.mp4`)**. Supported in HLS since 2016; RFC 8216 requires
  protocol version 6 or higher for `#EXT-X-MAP` in a media playlist. An
  **initialization segment** (`ftyp` + `moov` boxes: track and codec config, no samples) is
  declared once with `#EXT-X-MAP`. Each media segment is one or more `moof` + `mdat` fragments
  (headers + compressed frames). The same files can serve HLS and DASH (CMAF), and MSE accepts
  them directly.

```text
 fMP4 rendition on disk / CDN            what the player appends to MSE, in order
 ---------------------------            ----------------------------------------
 init.mp4   [ftyp][moov]          --->  init.mp4  (once, and again after a codec/rendition change)
 seg0.m4s   [moof][mdat]          --->  seg0.m4s
 seg1.m4s   [moof][mdat]          --->  seg1.m4s
 ...                                    ...
```

:::info
A media segment on its own can't be decoded. The decoder needs the init segment's codec
configuration first (for H.264 the SPS/PPS in the `avcC` box). Forgetting to append the init
segment, or appending the *720p* init and then *1080p* media segments, is one of the most common
causes of "MSE just silently does nothing" (or a `decode` error).
:::

## VOD vs live

The same format covers both:

```text
 VOD (has #EXT-X-ENDLIST)               Live (no ENDLIST) — the sliding window
                                        reload #1  MEDIA-SEQUENCE:100  seg100 seg101 seg102 seg103
 seg0 seg1 seg2 ... seg599 ENDLIST      reload #2  MEDIA-SEQUENCE:101         seg101 seg102 seg103 seg104
 Whole timeline known up front.         reload #3  MEDIA-SEQUENCE:102                seg102 seg103 seg104 seg105
 Seek anywhere.                         Old segments fall off the front, new ones appear at the end.
```

- **VOD**: the playlist is complete. The player fetches it once, knows the total duration and
  can seek anywhere.
- **Live**: no `#EXT-X-ENDLIST`. The player **re-fetches the media playlist** periodically
  (RFC 8216: roughly once per target duration while it keeps changing, sooner if it didn't) and
  appends new segments. Segments are identified by **media sequence number**, not by position in
  the file, because the window slides. RFC 8216 says a client should not start playback **less than
  three target durations from the end** of a live playlist. That's why standard live HLS runs
  roughly 3 × 6 s ≈ 18–30 s behind real time.
- **EVENT** (`#EXT-X-PLAYLIST-TYPE:EVENT`): live, but nothing is removed. Viewers can scrub back to
  the start of the broadcast. When it ends, `#EXT-X-ENDLIST` is appended and it becomes VOD.

:::pro title="Low-latency HLS"
For sports and auctions, 20 s of delay is too much. **LL-HLS** (Apple, now part of the HLS spec
draft) splits segments into **partial segments** (`#EXT-X-PART`, ~0.2–1 s each), lets the player
request a playlist that doesn't exist yet and have the server hold the request until it does
(*blocking playlist reload*), and adds `#EXT-X-PRELOAD-HINT`. That gets latency down to 2–5 s. It
takes server support and careful player tuning, so teams usually use a managed packager or CDN
feature rather than building it themselves.
:::

:::quiz id=med-02-q3 xp=10
A player loads a media playlist with `#EXT-X-TARGETDURATION:4`, `#EXT-X-MEDIA-SEQUENCE:2140`, eight
segments and **no** `#EXT-X-ENDLIST`. **Predict** what a correct player does.

- [ ] Plays from `seg` 2140, and when it reaches the last segment, ends playback
- [x] Treats it as live: starts at least ~3 target durations (about 12 s) before the end, and reloads the playlist every few seconds to discover new segments
- [ ] Reports an error because a VOD playlist must have `#EXT-X-ENDLIST`
- [ ] Downloads all eight segments immediately and then reloads the playlist once per minute
> A missing `ENDLIST` means the server may still add segments, so the stream is live. The player
> keeps reloading and uses the media sequence number to tell new segments from ones it already has.
> Starting at the very start of the window risks those segments disappearing (they are about to
> fall off). Starting at the very end leaves no buffer, so players start about three target
> durations back.
:::

Now turn the playlist text into the timeline the player works with.

:::challenge id=med-02-c1 lang=ts xp=60
title: Parse a media playlist into a timeline
Write two pure functions (no network, no real media APIs):

**`parseMediaPlaylist(text)`** returns
`{ targetDuration, mediaSequence, endList, initUri, segments }` where each segment is
`{ uri, duration, start, sequence }`.

- Accept `\n` or `\r\n` line endings; trim lines and ignore blank lines.
- The first non-blank line must be `#EXTM3U`, otherwise **throw** an `Error`.
- `#EXT-X-TARGETDURATION:<n>` → `targetDuration` (number, default `0`).
- `#EXT-X-MEDIA-SEQUENCE:<n>` → `mediaSequence` (default `0`).
- `#EXT-X-ENDLIST` → `endList: true` (default `false`).
- `#EXT-X-MAP:URI="init.mp4"` (possibly with other attributes, like `BYTERANGE="…"`) → `initUri`
  (default `null`).
- `#EXTINF:<duration>,<optional title>` sets the duration of the **next URI line**.
- Any other line starting with `#` (unknown tags, comments) is ignored.
- `start` is the sum of all previous durations. `sequence` is `mediaSequence + index`.

**`segmentAt(playlist, t)`** returns the segment whose half-open interval
`[start, start + duration)` contains `t`, or `null` if `t` is before 0 or at/after the end.

hint: Split with `text.split(/\r?\n/)`, then `.map(l => l.trim()).filter(Boolean)`.
hint: Keep a `pendingDuration` variable. When you see a non-`#` line, push a segment with it and reset it.
hint: For the `MAP` URI, a regex such as `/URI="([^"]*)"/` pulls the value out of the attribute list.
hint: `parseFloat('6.006,')` is `6.006`, but splitting on the comma first makes the intent clearer.

```ts starter
type Segment = { uri: string; duration: number; start: number; sequence: number }
type MediaPlaylist = {
  targetDuration: number
  mediaSequence: number
  endList: boolean
  initUri: string | null
  segments: Segment[]
}

export function parseMediaPlaylist(text: string): MediaPlaylist {
  // your code
  return { targetDuration: 0, mediaSequence: 0, endList: false, initUri: null, segments: [] }
}

export function segmentAt(pl: MediaPlaylist, t: number): Segment | null {
  // your code
  return null
}
```

```ts solution
type Segment = { uri: string; duration: number; start: number; sequence: number }
type MediaPlaylist = {
  targetDuration: number
  mediaSequence: number
  endList: boolean
  initUri: string | null
  segments: Segment[]
}

export function parseMediaPlaylist(text: string): MediaPlaylist {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (lines[0] !== '#EXTM3U') throw new Error('Not an HLS playlist: missing #EXTM3U')

  const pl: MediaPlaylist = { targetDuration: 0, mediaSequence: 0, endList: false, initUri: null, segments: [] }
  let pending: number | null = null
  let clock = 0

  for (const line of lines.slice(1)) {
    if (line.startsWith('#EXTINF:')) {
      pending = parseFloat(line.slice('#EXTINF:'.length).split(',')[0])
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      pl.targetDuration = Number(line.slice('#EXT-X-TARGETDURATION:'.length))
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      pl.mediaSequence = Number(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length))
    } else if (line === '#EXT-X-ENDLIST') {
      pl.endList = true
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const m = /URI="([^"]*)"/.exec(line)
      pl.initUri = m ? m[1] : null
    } else if (line.startsWith('#')) {
      // unknown tag or comment: ignore
    } else {
      const duration = pending ?? 0
      pl.segments.push({ uri: line, duration, start: clock, sequence: 0 })
      clock += duration
      pending = null
    }
  }
  pl.segments.forEach((s, i) => { s.sequence = pl.mediaSequence + i })
  return pl
}

export function segmentAt(pl: MediaPlaylist, t: number): Segment | null {
  if (t < 0) return null
  for (const s of pl.segments) {
    if (t >= s.start && t < s.start + s.duration) return s
  }
  return null
}
```

```ts tests
const VOD = [
  '#EXTM3U',
  '#EXT-X-VERSION:7',
  '#EXT-X-TARGETDURATION:6',
  '#EXT-X-PLAYLIST-TYPE:VOD',
  '#EXT-X-MAP:URI="init.mp4"',
  '#EXTINF:6.006,',
  'seg0.m4s',
  '#EXTINF:6.006,',
  'seg1.m4s',
  '# a plain comment',
  '#EXTINF:6.006,Chapter 2',
  'seg2.m4s',
  '#EXTINF:3.003,',
  'seg3.m4s',
  '#EXT-X-ENDLIST',
].join('\n')

const LIVE = '#EXTM3U\r\n#EXT-X-TARGETDURATION:4\r\n#EXT-X-MEDIA-SEQUENCE:2140\r\n\r\n#EXTINF:4.0,\r\nlive2140.ts\r\n#EXT-X-PROGRAM-DATE-TIME:2026-11-08T12:00:04Z\r\n#EXTINF:4.0,\r\nlive2141.ts\r\n#EXTINF:3.5,\r\nlive2142.ts\r\n'

test('reads header tags', () => {
  const pl = parseMediaPlaylist(VOD)
  expect(pl.targetDuration).toBe(6)
  expect(pl.mediaSequence).toBe(0)
  expect(pl.endList).toBe(true)
  expect(pl.initUri).toBe('init.mp4')
})

test('builds segments with cumulative start times', () => {
  const pl = parseMediaPlaylist(VOD)
  expect(pl.segments.map((s) => s.uri)).toEqual(['seg0.m4s', 'seg1.m4s', 'seg2.m4s', 'seg3.m4s'])
  expect(pl.segments[2].duration).toBeCloseTo(6.006, 6)
  expect(pl.segments[0].start).toBe(0)
  expect(pl.segments[1].start).toBeCloseTo(6.006, 6)
  expect(pl.segments[3].start).toBeCloseTo(18.018, 6)
  expect(pl.segments.map((s) => s.sequence)).toEqual([0, 1, 2, 3])
})

test('live playlist: CRLF, media sequence, no ENDLIST, no MAP, unknown tags ignored', () => {
  const pl = parseMediaPlaylist(LIVE)
  expect(pl.endList).toBe(false)
  expect(pl.initUri).toBeNull()
  expect(pl.targetDuration).toBe(4)
  expect(pl.segments.map((s) => s.sequence)).toEqual([2140, 2141, 2142])
  expect(pl.segments.map((s) => s.uri)).toEqual(['live2140.ts', 'live2141.ts', 'live2142.ts'])
  expect(pl.segments[2].start).toBeCloseTo(8, 6)
})

test('MAP with extra attributes', () => {
  const pl = parseMediaPlaylist('#EXTM3U\n#EXT-X-MAP:URI="v/init-720.mp4",BYTERANGE="812@0"\n#EXTINF:2,\na.m4s')
  expect(pl.initUri).toBe('v/init-720.mp4')
})

test('rejects text that is not a playlist', () => {
  expect(() => parseMediaPlaylist('<html>404 Not Found</html>')).toThrow()
})

test('segmentAt finds the segment containing t', () => {
  const pl = parseMediaPlaylist(VOD)
  expect(segmentAt(pl, 0)?.uri).toBe('seg0.m4s')
  expect(segmentAt(pl, 13.5)?.uri).toBe('seg2.m4s')
  expect(segmentAt(pl, 20)?.uri).toBe('seg3.m4s')
})

test('segmentAt: a boundary belongs to the next segment; out of range is null', () => {
  const pl = parseMediaPlaylist(VOD)
  const s1 = pl.segments[1]
  expect(segmentAt(pl, s1.start)?.uri).toBe('seg1.m4s')
  expect(segmentAt(pl, -0.5)).toBeNull()
  expect(segmentAt(pl, 21.021 + 0.001)).toBeNull()
  expect(segmentAt(pl, 100)).toBeNull()
})
```
:::

A real player resolves each `uri` against the playlist URL (`new URL(uri, playlistUrl)`) and
uses binary search instead of a linear scan for long VODs. It also keeps the timeline across live
reloads by matching media sequence numbers. The idea is the same.

## Who reads the playlist? Native HLS vs MSE-based players

There are two ways an HLS stream ends up in a `<video>`:

```text
 Native HLS (Safari on macOS/iOS/iPadOS)        MSE-based player (hls.js, Shaka, Video.js…)
 ----------------------------------------       ------------------------------------------------
 video.src = 'https://cdn/x/master.m3u8'         JS fetches playlists + segments (fetch/XHR)
 The browser's media stack does everything:      JS picks the rendition (ABR), transmuxes TS→fMP4
 playlist parsing, ABR, buffering, live reload.  JS appends bytes to a SourceBuffer (MSE)
 You only see normal <video> events.             The <video> decodes and renders what it's given.
```

Detection is the usual `canPlayType` check:

```ts
const video = document.querySelector('video')!
const nativeHls = video.canPlayType('application/vnd.apple.mpegurl') !== '' // "maybe" | "probably" | ""
```

Native HLS has long been a Safari feature (and therefore of practically every browser on iOS,
since they have historically all had to use WebKit). Chromium-based desktop browsers began rolling
out native HLS in late 2025 (around version 141–142), so **feature-detect, don't sniff the user
agent**, and don't assume `canPlayType` returning `"maybe"` means Safari. Everywhere else, a JavaScript player implements HLS on top of MSE. The
canonical open-source one is **hls.js**:

```ts
import Hls from 'hls.js'

const src = 'https://cdn.example.com/films/42/master.m3u8'
const video = document.querySelector('video')!

if (Hls.isSupported()) {            // true when MSE (or ManagedMediaSource) is available
  const hls = new Hls({ maxBufferLength: 30 })   // seconds of forward buffer to aim for
  hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
    console.log('renditions:', data.levels.map((l) => l.height))
  })
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (!data.fatal) return                                         // hls.js retries these itself
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad() // retry loading
    else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError()
    else hls.destroy()                                              // unrecoverable: show an error UI
  })
  hls.loadSource(src)
  hls.attachMedia(video)
} else if (video.canPlayType('application/vnd.apple.mpegurl')) {
  video.src = src                   // native HLS fallback
}
```

hls.js's own docs check `Hls.isSupported()` first, because a JS player gives you control
(ABR tuning, error events, custom loaders) and consistent behaviour across browsers. Some teams
prefer native on Apple devices for battery life and AirPlay. Both are valid choices. Make one on
purpose and test both paths.

:::info title="iPhone and ManagedMediaSource"
For years iPhone Safari had **no MSE at all**, so HLS had to be native there. Since iOS 17.1,
Safari exposes **`ManagedMediaSource`**, an MSE variant where the *browser* may evict buffered
data under memory pressure. It fires `startstreaming` / `endstreaming` to tell you when it wants
data, which lets the radio sleep. It requires either `video.disableRemotePlayback = true` or an
AirPlay-compatible alternative source. hls.js uses it automatically when present (since v1.5,
controlled by the `preferManagedMediaSource` option).
:::

:::job
On day one you won't write an HLS player, you'll *configure* one (hls.js, Shaka, Video.js,
a vendor SDK like Mux or JW Player). Expect tickets like "playback stalls on hotel Wi-Fi",
"live is 40 s behind", "German audio track missing on iOS" or "CORS error on segments from the new
CDN". You fix them by reading the playlists (`curl` the `.m3u8`), the player's error events and the
Network tab. Everything in this lesson is what you need to read those.
:::

## Media Source Extensions from the ground up

**Why MSE exists:** `video.src = 'file.mp4'` lets the browser fetch bytes however it wants. A
streaming player needs to decide **which** bytes, from **which** rendition, **when**. MSE (a W3C
spec) separates *fetching* from *decoding*. Your JavaScript fetches, and the media element
decodes whatever you append.

```text
  your JS                         MediaSource                       HTMLVideoElement
  -------                         -----------                       ----------------
  fetch(init.mp4) ─┐
  fetch(seg0.m4s) ─┼─ appendBuffer ─▶ SourceBuffer "video/mp4; avc1…" ─┐
  fetch(seg1.m4s) ─┘                  (buffered: 0–12.0)               ├─▶ decode + render
  fetch(aud0.m4s) ─── appendBuffer ─▶ SourceBuffer "audio/mp4; mp4a…" ─┘   video.buffered =
                                      (buffered: 0–12.03)                  intersection of both
       ▲                                                                   │
       └──────────────────── 'updateend', 'timeupdate', 'waiting' ─────────┘
```

The minimal working setup:

```ts
const video = document.querySelector('video')!
const mime = 'video/mp4; codecs="avc1.64001f, mp4a.40.2"'

if (!('MediaSource' in window) || !MediaSource.isTypeSupported(mime)) {
  throw new Error(`MSE cannot play ${mime} here`)
}

const ms = new MediaSource()
video.src = URL.createObjectURL(ms)          // a blob: URL that points at the MediaSource

ms.addEventListener('sourceopen', async () => {
  URL.revokeObjectURL(video.src)             // the element is attached; the URL isn't needed any more
  const sb = ms.addSourceBuffer(mime)        // only legal while ms.readyState === 'open'

  for (const url of ['init.mp4', 'seg0.m4s', 'seg1.m4s', 'seg2.m4s']) {
    const data = await (await fetch(url)).arrayBuffer()
    await appendAsync(sb, data)
  }
  ms.endOfStream()                           // readyState → 'ended'; the duration is finalised
}, { once: true })

/** appendBuffer is asynchronous and reports completion via events — wrap it in a Promise. */
function appendAsync(sb: SourceBuffer, data: BufferSource): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { sb.removeEventListener('error', fail); resolve() }
    const fail = () => { sb.removeEventListener('updateend', done); reject(new Error('append failed')) }
    sb.addEventListener('updateend', done, { once: true })
    sb.addEventListener('error', fail, { once: true })
    try {
      sb.appendBuffer(data)                  // may throw synchronously (InvalidStateError, QuotaExceededError)
    } catch (e) {
      sb.removeEventListener('updateend', done)
      sb.removeEventListener('error', fail)
      reject(e)                              // keep the original DOMException so callers can check e.name
    }
  })
}
```

Key pieces:

- **`MediaSource.readyState`**: `'closed'` (not attached) → `'open'` (after `sourceopen`) →
  `'ended'` (after `endOfStream()`). Appending again after `'ended'` moves it back to `'open'`.
- **`addSourceBuffer(mime)`**: one SourceBuffer per track type. Usually one for video and one for
  audio, or one for a muxed stream.
- **`appendBuffer(data)`** starts an **asynchronous** parse. `sb.updating` is `true` until
  `updateend` fires (after `update` on success, or after `error` / `abort`). Calling `appendBuffer`
  or `remove` while `updating` is `true` **throws `InvalidStateError`**. Real players keep a
  **queue** per SourceBuffer and only start the next operation on `updateend`.
- **`sb.buffered`**: a `TimeRanges` object (`length`, `start(i)`, `end(i)`) in seconds.

:::quiz id=med-02-q4 xp=10
**Predict** what happens:

```ts
ms.addEventListener('sourceopen', async () => {
  const sb = ms.addSourceBuffer(mime)
  const [init, seg0] = await Promise.all([fetchBytes('init.mp4'), fetchBytes('seg0.m4s')])
  sb.appendBuffer(init)
  sb.appendBuffer(seg0)
})
```

- [ ] Both are appended in order, because `appendBuffer` is synchronous
- [ ] Both are queued internally by the browser and appended one after the other
- [x] The second call throws `InvalidStateError`, because the SourceBuffer is still `updating` from the first
- [ ] `seg0` replaces `init` in the buffer
> `appendBuffer` returns immediately and processes the data in the background. While
> `sb.updating === true`, a second `appendBuffer` (or `remove`, or changing `mode` /
> `timestampOffset`) throws `InvalidStateError`. MSE has **no built-in queue**. You wait for
> `updateend` (or use a helper like `appendAsync` above) before the next operation. Every MSE
> player has this queue at its core.
:::

### `buffered` is a list of ranges, and gaps stop playback

After appending segments 0, 1 and 3 (segment 2 failed to download), the buffer looks like this:

```text
 media time (s)  0        6        12       18       24
                 |========|========|        |========|
 sb.buffered:    [0, 12.012)                [18.018, 24.024)      length === 2
                                     ^ gap
 playhead ───────────────────────▶  reaches 12.012 → 'waiting', readyState drops, video freezes
```

Code reads it like this (converting to plain arrays is the first thing every player does):

```ts
function toPairs(r: TimeRanges): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < r.length; i++) out.push([r.start(i), r.end(i)])
  return out
}
console.log(toPairs(video.buffered))   // [[0, 12.012], [18.018, 24.024]]
```

Two details that cause real bugs:

1. **Ranges are never exactly the segment boundaries.** Audio frames (AAC: 1024 samples ≈ 21.3 ms at
   48 kHz, covered in *Clean sound at a seam*) and video frames (33.4 ms at 29.97 fps) don't end at the
   same instants. Appending back-to-back segments can leave **tiny gaps** of a few milliseconds.
   Some browsers bridge small gaps, others stall. Players like hls.js have gap-jumping logic
   that nudges `currentTime` over small holes.
2. **`video.buffered` is the intersection** of all active SourceBuffers' ranges. If video is
   buffered to 30 s but audio only to 12 s, the element can only play to 12 s. (After
   `endOfStream()` the spec relaxes this for the final range, so the longer track can play out.)

:::quiz id=med-02-q5 xp=10
The video SourceBuffer has `[0, 8]` and `[9, 20]`. The audio SourceBuffer has `[0, 15]`. **Predict**
`video.buffered`, and what happens when the playhead reaches 8 s.

- [ ] `[0, 20]`; playback continues to 20 s
- [ ] `[0, 15]`; playback continues to 15 s
- [x] `[0, 8]` and `[9, 15]`; playback stalls at 8 s (`waiting`) unless something jumps the gap
- [ ] `[0, 8]`; the audio range is ignored when a video track exists
> The element can only present a time when **every** active track has data for it, so
> `HTMLMediaElement.buffered` is the intersection: [0,8] ∩ [0,15] = [0,8], and [9,20] ∩ [0,15] =
> [9,15]. At 8 s the video track has nothing to show, so the element fires `waiting` and freezes,
> even though "the audio buffer has 7 more seconds". Debug stalls by printing each
> SourceBuffer's ranges separately, not just `video.buffered`.
:::

:::challenge id=med-02-c2 lang=ts xp=60
title: Inspect buffered ranges like a player
Model `TimeRanges` as arrays of `[start, end]` pairs (`Span[]`) and write three pure functions:

1. **`mergeRanges(ranges, tolerance = 0)`**: sort by start, **drop empty or inverted spans**
   (`end <= start`), and merge spans that overlap, touch, or are separated by a gap
   **≤ `tolerance`** seconds. Return a new sorted array (don't mutate the input).
2. **`intersectRanges(a, b)`**: both inputs are already sorted and non-overlapping. Return the
   times covered by **both** (what `video.buffered` shows for an audio and a video SourceBuffer).
   Drop zero-length results.
3. **`bufferedAhead(ranges, t, tolerance = 0)`**: how many seconds can play from `t` without
   a stall? Merge with `tolerance` first. If some span has `start - tolerance <= t < end`, return
   `end - t`. Otherwise return `0`.

hint: For merging, keep the last output span and either extend its end with `Math.max` or push a new copy.
hint: Intersection is a two-pointer walk: overlap = `[max(a.start, b.start), min(a.end, b.end)]`; advance whichever span ends first.
hint: The `start - tolerance` check lets a playhead sitting 5 ms before a span count as "inside it".

```ts starter
type Span = [number, number]

export function mergeRanges(ranges: Span[], tolerance = 0): Span[] {
  return ranges
}

export function intersectRanges(a: Span[], b: Span[]): Span[] {
  return []
}

export function bufferedAhead(ranges: Span[], t: number, tolerance = 0): number {
  return 0
}
```

```ts solution
type Span = [number, number]

export function mergeRanges(ranges: Span[], tolerance = 0): Span[] {
  const sorted = ranges
    .filter(([s, e]) => e > s)
    .map(([s, e]): Span => [s, e])
    .sort((x, y) => x[0] - y[0])
  const out: Span[] = []
  for (const span of sorted) {
    const last = out[out.length - 1]
    if (last && span[0] - last[1] <= tolerance) last[1] = Math.max(last[1], span[1])
    else out.push(span)
  }
  return out
}

export function intersectRanges(a: Span[], b: Span[]): Span[] {
  const out: Span[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i][0], b[j][0])
    const end = Math.min(a[i][1], b[j][1])
    if (end > start) out.push([start, end])
    if (a[i][1] < b[j][1]) i++
    else j++
  }
  return out
}

export function bufferedAhead(ranges: Span[], t: number, tolerance = 0): number {
  for (const [s, e] of mergeRanges(ranges, tolerance)) {
    if (s - tolerance <= t && t < e) return e - t
  }
  return 0
}
```

```ts tests
test('merge: sorts, joins overlaps and touching spans', () => {
  expect(mergeRanges([[12, 18], [0, 6], [5, 12]])).toEqual([[0, 18]])
  expect(mergeRanges([[0, 6], [6, 12]])).toEqual([[0, 12]])
})

test('merge: keeps real gaps, drops empty and inverted spans', () => {
  expect(mergeRanges([[0, 6], [18, 24], [10, 10], [30, 29]])).toEqual([[0, 6], [18, 24]])
})

test('merge: a contained span does not shrink the outer one', () => {
  expect(mergeRanges([[0, 20], [5, 8]])).toEqual([[0, 20]])
})

test('merge: tolerance bridges tiny gaps between segments', () => {
  const r: Span[] = [[0, 6.006], [6.01, 12.012], [12.5, 18]]
  expect(mergeRanges(r)).toHaveLength(3)
  expect(mergeRanges(r, 0.01)).toEqual([[0, 12.012], [12.5, 18]])
})

test('merge does not mutate its input', () => {
  const input: Span[] = [[6, 12], [0, 6]]
  mergeRanges(input)
  expect(input).toEqual([[6, 12], [0, 6]])
})

test('intersect: audio and video buffers', () => {
  expect(intersectRanges([[0, 8], [9, 20]], [[0, 15]])).toEqual([[0, 8], [9, 15]])
  expect(intersectRanges([[0, 10]], [[10, 20]])).toEqual([])
  expect(intersectRanges([[0, 5], [10, 15]], [[3, 12]])).toEqual([[3, 5], [10, 12]])
  expect(intersectRanges([], [[0, 1]])).toEqual([])
})

test('bufferedAhead: inside a span, in a gap, past the end', () => {
  const r: Span[] = [[0, 12], [18, 24]]
  expect(bufferedAhead(r, 4)).toBe(8)
  expect(bufferedAhead(r, 12)).toBe(0)
  expect(bufferedAhead(r, 15)).toBe(0)
  expect(bufferedAhead(r, 30)).toBe(0)
})

test('bufferedAhead: tolerance treats tiny holes and a slightly early playhead as buffered', () => {
  const r: Span[] = [[0, 6.0], [6.004, 12]]
  expect(bufferedAhead(r, 5)).toBeCloseTo(1, 6)
  expect(bufferedAhead(r, 5, 0.01)).toBeCloseTo(7, 6)
  expect(bufferedAhead([[10, 16]], 9.995, 0.01)).toBeCloseTo(6.005, 6)
})
```
:::

### Where appended data goes: `mode`, `timestampOffset`, append windows

Every coded frame inside a segment carries its own timestamps. MSE decides **where on the media
timeline** a frame goes using two SourceBuffer properties:

- **`sb.mode = 'segments'`** (default for MP4/WebM): the frame's own timestamp decides its position,
  **plus `sb.timestampOffset`**. Append segments out of order and they still fall into place. This
  is what ABR players use, since after a seek they fetch segment 37 before segment 3.
- **`sb.mode = 'sequence'`**: media timestamps are only used *relative* to each other. Each append
  is placed **right after the previous one**, whatever its internal timestamps say. The browser
  updates `timestampOffset` for you. Byte streams without their own timestamps (raw ADTS AAC,
  MP3) *must* use `'sequence'`.
- **`sb.timestampOffset`** (seconds) is added to every frame appended afterwards. Use it to shift
  content, e.g. MPEG-TS streams usually start at a non-zero PTS (often a second or more), or you want clip B to start
  where clip A ended.
- **`sb.appendWindowStart` / `appendWindowEnd`**: frames whose times fall outside the window are
  **dropped** during append. Useful to trim overlap between two clips.

```text
 Clip A: frames stamped 0..6      Clip B: frames stamped 100..106   (appended after A)

 mode 'segments', timestampOffset 0       mode 'sequence'                mode 'segments', timestampOffset = -94
 |==A==|                    |==B==|       |==A==|==B==|                  |==A==|==B==|
 0     6                  100   106       0     6     12                 0     6     12
 (a 94 s gap: playback stalls at 6)       (B placed right after A)       (same result, done explicitly)
```

*Seamless loops: from the loop attribute to appending laps* builds on exactly this: appending the
same clip again and again at increasing offsets.

:::quiz id=med-02-q6 xp=10
A SourceBuffer in `'segments'` mode already holds `[0, 6)`. You set `sb.timestampOffset = 6`, then
append a fragment whose frames are stamped 0.0 to 4.0. **Predict** `sb.buffered` afterwards.

- [ ] `[0, 6)`: the new frames overlap existing ones and are discarded
- [ ] `[0, 4)`: the new frames overwrite the start
- [x] `[0, 10)`: the frames are placed at 6.0 to 10.0
- [ ] It throws, because `timestampOffset` can only be set in `'sequence'` mode
> In `'segments'` mode each frame goes to *its own timestamp + `timestampOffset`*, so 0–4 becomes
> 6–10, directly after the existing data, and the ranges merge into one. With `timestampOffset = 0`
> the new frames would go to 0–4 and **replace** the old frames there (overlapping appends
> overwrite). `timestampOffset` works in both modes. It just can't be changed while `updating`.
:::

### Removing data, and the quota

MSE doesn't keep everything forever. Each SourceBuffer has a browser-specific memory budget
(desktop Chromium has long used about 150 MB per video and 12 MB per audio SourceBuffer, with
lower limits on low-memory devices; TVs and phones are often much tighter).
Before each append the browser runs **coded frame eviction**: it may drop data, typically far
behind the playhead, to make room. If it still can't fit the new data, **`appendBuffer` throws
`QuotaExceededError`** and nothing is appended.

You manage memory yourself with **`sb.remove(start, end)`**, which is asynchronous like
`appendBuffer` (same `updating` / `updateend` rules):

```ts
async function appendWithRoom(sb: SourceBuffer, video: HTMLVideoElement, data: ArrayBuffer) {
  try {
    await appendAsync(sb, data)
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'QuotaExceededError')) throw e
    const keepBehind = 10                                  // seconds behind the playhead to keep
    const cut = video.currentTime - keepBehind
    if (sb.buffered.length === 0 || cut <= sb.buffered.start(0)) throw e // nothing safe to remove
    await removeAsync(sb, sb.buffered.start(0), cut)
    await appendAsync(sb, data)                            // retry once
  }
}

function removeAsync(sb: SourceBuffer, start: number, end: number): Promise<void> {
  return new Promise((resolve) => {
    sb.addEventListener('updateend', () => resolve(), { once: true })
    sb.remove(start, end)
  })
}
```

There's a decoding subtlety in `remove()`. Frames depend on earlier frames back to the
previous keyframe (see the frames lesson). Removing frames in the *middle* of a group of pictures
would leave frames whose references are gone. So the spec removes from `start` up to the **next
random access point (keyframe) at or after `end`**. The hole can be bigger than you asked for.

:::quiz id=med-02-q7 xp=10
A video SourceBuffer holds `[0, 60)` with keyframes every 4 s (0, 4, 8, …). The playhead is at 30 s.
A developer frees memory with `sb.remove(10, 21)`. **Predict** `sb.buffered` afterwards.

- [ ] `[0, 10)` and `[21, 60)`
- [x] `[0, 10)` and `[24, 60)`, because removal extends to the next keyframe at or after 21 s
- [ ] `[0, 8)` and `[21, 60)`, because removal starts at the previous keyframe
- [ ] `[0, 60)`, because you can't remove data before the playhead
> Frames 21–24 s are P/B-frames that need the keyframe at 20 s, which was removed. The spec
> therefore extends the removal to the next random access point (24 s). Data before `start` is
> kept: the spec only extends the *end* of a removal, never its start. In practice,
> remove whole ranges well **behind** the playhead (e.g. everything older than `currentTime - 10`)
> and never just ahead of it. A cut ahead of the playhead creates exactly the gap from quiz 5.
:::

## How it breaks in practice

| Symptom | Usual cause | How to detect / fix |
|---|---|---|
| `InvalidStateError: This SourceBuffer is still processing…` | Two appends/removes without waiting for `updateend`; or setting `timestampOffset`/`mode` while `updating` | One operation queue per SourceBuffer; log `sb.updating` before every call |
| Black video, `video.error.code === 4` (`MEDIA_ERR_SRC_NOT_SUPPORTED`) or a `decode` error | Wrong `CODECS` string, media segment appended without (or with the wrong rendition's) init segment | Check `MediaSource.isTypeSupported(mime)`; append the init segment on every rendition switch; inspect with `ffprobe` or an MP4 box viewer |
| Playback freezes, `waiting` fires, "but the buffer has data" | A gap in one SourceBuffer (failed segment, tiny A/V boundary mismatch), or audio buffered less far than video | Print each SourceBuffer's ranges, not just `video.buffered`; bridge small gaps by nudging `currentTime`; refetch missing segments |
| Video starts a few seconds in, or the scrub bar doesn't start at 0:00 | MPEG-TS/fMP4 timestamps don't start at 0 | Set `timestampOffset` to `-firstPts`, or seek to `buffered.start(0)` on load |
| `QuotaExceededError` after ~20 min on a smart TV | Forward buffer too large, nothing removed behind the playhead | Lower the player's max buffer (hls.js `maxBufferLength` / `maxMaxBufferLength`), `remove()` behind the playhead |
| Live stream drifts further and further behind | Player started too far back, stalled, never caught up | Track `liveSyncPosition` / latency; hls.js `liveSyncDuration`, speeding up `playbackRate` slightly to catch up |
| Live stream 404s on segments | Playlist reloaded too rarely: segments fell off the sliding window | Reload about once per target duration (RFC 8216 §6.3.4); check the CDN isn't caching the `.m3u8` for too long (short TTL for playlists, long TTL for segments) |
| Works in Safari, fails in Chrome (or vice versa) | Native HLS path vs hls.js path; TS segments in MSE; CORS headers missing on segments | Test both paths; segments and playlists need `Access-Control-Allow-Origin` when fetched by JS |
| Seeking ends up a few frames off | Seek resolves to the decodable frame, segment-level timeline maths | Covered in *Jumping along a path: seeking without stutter* |

:::pro
Seniors debug streaming with three tools open: the **Network tab** filtered to `m3u8|m4s|ts`
(are segments arriving faster than real time? 404s? CORS?), the player's **debug log**
(`new Hls({ debug: true })`), and the browser's media internals page (`chrome://media-internals`
in Chromium shows every MSE append, buffered range and decoder error). They also validate playlists
in CI with a packager's validator, because a single wrong `EXTINF` or a target duration that is
too small produces bugs that only appear on slow networks.
:::

:::cards id=med-02-cards1 xp=15 title="HLS & MSE"
Q: Multivariant playlist vs media playlist?
A: Multivariant ("master") lists the renditions (`#EXT-X-STREAM-INF` with BANDWIDTH, RESOLUTION, CODECS).
   A media playlist lists one rendition's segments (`#EXTINF` + URI).
Q: What does `#EXT-X-TARGETDURATION` promise?
A: An integer upper bound: every `EXTINF` duration, rounded to the nearest integer, is ≤ it. Live reload timing is based on it.
Q: How do you know a playlist is live?
A: No `#EXT-X-ENDLIST`. The player keeps reloading it and tracks segments by media sequence number.
Q: Why does fMP4 need `#EXT-X-MAP`?
A: Media segments (`moof`+`mdat`) have no codec config. The init segment (`ftyp`+`moov`) must be appended first.
Q: What happens if you call `appendBuffer` while `sb.updating` is true?
A: It throws `InvalidStateError`. Queue operations and start the next one on `updateend`.
Q: What is `video.buffered` with MSE?
A: The intersection of all active SourceBuffers' buffered ranges.
Q: `'segments'` vs `'sequence'` mode?
A: Segments: frames go to their own timestamp + `timestampOffset`. Sequence: each append is placed right after the previous one.
Q: What does `QuotaExceededError` from `appendBuffer` mean?
A: The SourceBuffer is full even after eviction. Nothing was appended. `remove()` data behind the playhead and retry.
Q: Why can `remove(start, end)` remove more than asked?
A: It extends to the next keyframe at or after `end`, because frames after `end` may depend on removed frames.
:::

## Recap

- Streaming cuts video into **segments of a few seconds** at several bitrates, which enables
  **adaptive bitrate**, live, and CDN-friendly caching. HLS and DASH are both "manifest + segments".
- An HLS **multivariant playlist** lists renditions (`#EXT-X-STREAM-INF`: `BANDWIDTH`, `CODECS`,
  `RESOLUTION`). A **media playlist** lists segments (`#EXTINF` duration + URI).
- Segment start times are the **sum of previous durations**. `#EXT-X-TARGETDURATION` bounds the
  rounded durations. `#EXT-X-MEDIA-SEQUENCE` numbers segments.
- Segments are **MPEG-TS** (self-contained, transmuxed by JS players) or **fMP4** with an init
  segment from `#EXT-X-MAP`.
- **VOD** has `#EXT-X-ENDLIST`. **Live** has none: the player reloads the playlist and stays about 3
  target durations behind the live edge.
- Safari plays HLS **natively**. Elsewhere **hls.js** and friends implement HLS on **MSE**.
  Feature-detect with `canPlayType` / `Hls.isSupported()`.
- **MSE**: `MediaSource` → `addSourceBuffer(mime)` → `appendBuffer` (async; wait for
  `updateend`, or you get `InvalidStateError`) → `buffered` `TimeRanges`.
- `video.buffered` is the **intersection** of all tracks. **Gaps stall playback**.
- `'segments'` mode uses media timestamps + `timestampOffset`. `'sequence'` mode places appends
  back to back. Append windows trim frames.
- Memory is limited: `remove()` behind the playhead (it extends to the next keyframe), and handle
  **`QuotaExceededError`**.
