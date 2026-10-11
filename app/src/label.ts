/**
 * The two letters that stand for a tab when the sidebar is a rail.
 *
 * A title of several words gives the initials of the first two; a single
 * word gives its first two letters. A path counts for its last folder, the
 * one that tells two tabs apart.
 */
export function shortLabel(title: string): string {
  const words = title.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
  if (words.length >= 2) return firstChars(words[0], 1) + firstChars(words[1], 1);

  const word = words[0] ?? "";
  const parts = word.split(/[/:]/).filter((part) => /[\p{L}\p{N}]/u.test(part));
  const folder = parts[parts.length - 1] ?? word;
  return firstChars(folder, 2) || "··";
}

// Letters and digits only, counted by code point.
function firstChars(text: string, count: number): string {
  return Array.from(text.replace(/[^\p{L}\p{N}]/gu, ""))
    .slice(0, count)
    .join("");
}
