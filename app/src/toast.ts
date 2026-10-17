/** How long a toast stays, in milliseconds. */
const SHOWN_FOR = 2500;

let current: HTMLElement | null = null;
let timer: number | undefined;

/** A short message at the bottom of the window, gone by itself. */
export function toast(text: string): void {
  current?.remove();
  window.clearTimeout(timer);
  const node = document.createElement("div");
  node.className = "toast";
  const dot = document.createElement("span");
  dot.className = "toast-dot";
  node.append(dot, text);
  document.body.append(node);
  current = node;
  timer = window.setTimeout(() => {
    node.remove();
    if (current === node) current = null;
  }, SHOWN_FOR);
}
