/** The last folder of a path: the name a tab takes from where it works. */
export function folderName(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  return parts[parts.length - 1] ?? "/";
}
