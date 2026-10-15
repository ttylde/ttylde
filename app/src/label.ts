/** The last folder of a path: the name a tab takes from where it works. */
export function folderName(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  return parts[parts.length - 1] ?? "/";
}

/** `path` with the home written `~`, as a shell prompt writes it. */
export function tildePath(path: string, home: string | null): string {
  if (!home) return path;
  const base = home.replace(/\/+$/, "");
  if (path === base) return "~";
  return path.startsWith(`${base}/`) ? `~${path.slice(base.length)}` : path;
}
