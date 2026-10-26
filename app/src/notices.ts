// Notices: news from where the user is not, stacked at the bottom right of
// the window, each with a way to go there. Unlike a toast, a notice can
// be acted on: the end of a command in another space now, an agent asking
// for input later.

/** How long a notice that asks for nothing stays, in milliseconds. */
const SHOWN_FOR = 6000;

/** How many notices are shown at most: a new one pushes out the oldest. */
const MAX_NOTICES = 3;

export type NoticeContent<K> = {
  /** What the notice is about: a new notice on the same thing replaces it. */
  key: K;
  title: string;
  /** What happened there, as code: a command. */
  subject: string;
  /** Said after the subject, in the color of the outcome. */
  outcome: string;
  /** The state it is in, as a status dot: see `status.ts`. */
  status: "done" | "error";
  /** One that asks for something stays until dismissed or acted on. */
  sticky: boolean;
  /** The label of the button that goes there. */
  action: string;
};

type Shown<K> = {
  key: K;
  node: HTMLElement;
  sticky: boolean;
  /** How long it has left, in milliseconds, while the clock is stopped. */
  left: number;
  /** When the clock started, while it runs. */
  since: number | null;
  timer: number | undefined;
};

/**
 * The stack of notices. The clock of one that goes by itself runs only
 * while the window is in front and the pointer is not on it: a notice
 * that came while the user was away waits for them.
 */
export class Notices<K> {
  private shown: Shown<K>[] = [];
  private stack = document.createElement("div");

  constructor(private go: (key: K) => void) {
    this.stack.className = "notices";
    document.body.append(this.stack);
    window.addEventListener("focus", () => {
      for (const notice of this.shown) this.start(notice);
    });
    window.addEventListener("blur", () => {
      for (const notice of this.shown) this.stop(notice);
    });
  }

  /** Shows `content`, under those already there. */
  show(content: NoticeContent<K>): void {
    this.forget(content.key);
    const node = document.createElement("div");
    node.className = "notice";

    const dot = document.createElement("span");
    dot.className = "status-dot";
    dot.dataset.status = content.status;
    const text = document.createElement("div");
    text.className = "notice-text";
    const title = document.createElement("div");
    title.className = "notice-title";
    title.textContent = content.title;
    const line = document.createElement("div");
    line.className = "notice-line";
    const subject = document.createElement("span");
    subject.className = "notice-subject";
    subject.textContent = content.subject;
    const outcome = document.createElement("span");
    outcome.className = "notice-outcome";
    outcome.dataset.status = content.status;
    outcome.textContent = content.outcome;
    line.append(subject, outcome);
    text.append(title, line);

    const go = document.createElement("button");
    go.type = "button";
    go.className = "notice-go";
    go.textContent = content.action;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "notice-close";
    close.title = "Dismiss";
    close.textContent = "×";
    node.append(dot, text, go, close);

    const notice: Shown<K> = {
      key: content.key,
      node,
      sticky: content.sticky,
      left: SHOWN_FOR,
      since: null,
      timer: undefined,
    };
    go.addEventListener("click", () => {
      this.remove(notice);
      this.go(notice.key);
    });
    close.addEventListener("click", () => this.remove(notice));
    node.addEventListener("mouseenter", () => this.stop(notice));
    node.addEventListener("mouseleave", () => this.start(notice));
    // The focus stays in the terminal: the notice is used with the pointer.
    node.addEventListener("mousedown", (e) => e.preventDefault());

    this.shown.push(notice);
    this.stack.append(node);
    while (this.shown.length > MAX_NOTICES) this.remove(this.shown[0]);
    this.start(notice);
  }

  /** The notice about `key` has been answered, if there is one: it goes. */
  forget(key: K): void {
    const notice = this.shown.find((shown) => shown.key === key);
    if (notice) this.remove(notice);
  }

  private start(notice: Shown<K>): void {
    if (notice.sticky || notice.since !== null || !document.hasFocus()) return;
    if (notice.node.matches(":hover")) return;
    notice.since = Date.now();
    notice.timer = window.setTimeout(() => this.remove(notice), notice.left);
  }

  private stop(notice: Shown<K>): void {
    if (notice.since === null) return;
    window.clearTimeout(notice.timer);
    notice.left -= Date.now() - notice.since;
    notice.since = null;
  }

  private remove(notice: Shown<K>): void {
    window.clearTimeout(notice.timer);
    notice.node.remove();
    this.shown = this.shown.filter((shown) => shown !== notice);
  }
}
