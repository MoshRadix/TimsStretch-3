export const PHONETIC_THAANA: Record<string, string> = {
  q: "ް", w: "އ", e: "ެ", r: "ރ", t: "ތ", y: "ޔ", u: "ު", i: "ި", o: "ޮ", p: "ޕ",
  a: "ަ", s: "ސ", d: "ދ", f: "ފ", g: "ގ", h: "ހ", j: "ޖ", k: "ކ", l: "ލ",
  z: "ޒ", x: "×", c: "ޗ", v: "ވ", b: "ބ", n: "ނ", m: "މ",
  Q: "ޤ", W: "ޢ", E: "ޭ", R: "ޜ", T: "ޓ", Y: "ޠ", U: "ޫ", I: "ީ", O: "ޯ", P: "÷",
  A: "ާ", S: "ށ", D: "ޑ", F: "ﷲ", G: "ޣ", J: "ޛ", K: "ޚ", H: "ޙ", L: "ޅ",
  Z: "ޡ", X: "ޘ", C: "ޝ", V: "ޥ", B: "ޞ", N: "ޏ", M: ">",
  ",": "،", ";": "؛", "?": "؟",
};

export function mapKeyToThaana(key: string): string | null {
  if (Object.prototype.hasOwnProperty.call(PHONETIC_THAANA, key)) {
    return PHONETIC_THAANA[key];
  }
  return null;
}

export function countWordsAndChars(text: string): { words: number; chars: number } {
  const chars = text.length;
  const trimmed = text.trim();
  if (!trimmed) {
    return { words: 0, chars };
  }
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  return { words, chars };
}
