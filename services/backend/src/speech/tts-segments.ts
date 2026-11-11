/** Stable, lossless chunks below both the general and signed-provider limits. */
export function splitTeachingSpeech(text: string, limit = 120): string[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid TTS chunk size');
  const characters = Array.from(text.trim());
  const chunks: string[] = [];
  while (characters.length) {
    let end = Math.min(limit, characters.length);
    if (end < characters.length) {
      for (let i = end - 1; i >= Math.floor(limit / 2); i -= 1) {
        if (/[\s.!?。！？；;]/u.test(characters[i]!)) { end = i + 1; break; }
      }
    }
    chunks.push(characters.splice(0, end).join(''));
  }
  return chunks;
}
