/**
 * The filters of the actions of the palette: `@space` keeps those of the
 * space shown, as `@installed` keeps the installed extensions in VS Code.
 * More come with the actions they gather (`@tab`, `@terminal`).
 */
export const FILTERS = [{ token: "@space", label: "Actions and settings of this space" }];

/** What the text typed in the actions asks for. */
export type Asked =
  /** No filter: every action the text is part of. */
  | { kind: "all"; text: string }
  /** A filter is being typed: the ones it can still be. */
  | { kind: "choosing"; filters: typeof FILTERS }
  /** A filter, and the text that narrows it. */
  | { kind: "filter"; token: string; text: string };

/**
 * Reads `typed`: a word starting with `@` first is a filter, finished once
 * a space follows it or it is one of `FILTERS` exactly.
 */
export function asked(typed: string): Asked {
  const text = typed.trimStart();
  if (!text.startsWith("@")) return { kind: "all", text: text.trim().toLowerCase() };
  const [word] = text.split(/\s/, 1);
  const rest = text.slice(word.length);
  const exact = FILTERS.find((f) => f.token === word.toLowerCase());
  if (exact && (rest.length > 0 || text === word)) {
    return { kind: "filter", token: exact.token, text: rest.trim().toLowerCase() };
  }
  if (rest.length > 0) return { kind: "choosing", filters: [] };
  return {
    kind: "choosing",
    filters: FILTERS.filter((f) => f.token.startsWith(word.toLowerCase())),
  };
}
