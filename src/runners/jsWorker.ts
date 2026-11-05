// Web Worker: runs non-React challenges off the main thread (killable on infinite loops).
import { runChallenge, type ChallengeInput } from './execute.ts'

self.onmessage = async (e: MessageEvent<{ ch: ChallengeInput; code: string }>) => {
  try {
    const v = await runChallenge(e.data.ch, e.data.code, {})
    ;(self as unknown as Worker).postMessage({ ok: true, verdict: v })
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ ok: false, error: String((err as Error)?.message ?? err) })
  }
}
