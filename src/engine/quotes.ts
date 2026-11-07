// Normalises "look-alike" quote characters to real ASCII quotes.
// German keyboards: the key next to Backspace types ´ (acute accent) / ` — the real apostrophe is Shift+#.
// Autocorrect / copy-paste from docs can also insert typographic quotes (’ ‘ ‚ “ ” „ « »).
const SINGLE = /[´‘’‚‛′]/g // ´ ‘ ’ ‚ ‛ ′
const DOUBLE = /[“”„‟″«»]/g // “ ” „ ‟ ″ « »
export function normalizeQuotes(s: string): string {
  return s.replace(SINGLE, "'").replace(DOUBLE, '"')
}
export const hasLookalikeQuotes = (s: string) => SINGLE.test(s) || DOUBLE.test(s)
