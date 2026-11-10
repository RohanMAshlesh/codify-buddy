/** Fast token estimate (~4 chars/token for code and English). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Truncate text to roughly `maxTokens`, keeping head and tail. */
export function truncateMiddle(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  const dropped = text.length - 2 * half;
  return `${text.slice(0, half)}\n\n… [${dropped} characters truncated] …\n\n${text.slice(-half)}`;
}
