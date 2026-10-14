// TypeScript mirror of the frame types defined in core/src/frame.rs.

export type Segment = {
  text: string;
  cols: number;
  fg: number;
  bg: number;
  flags: number;
};

export type LineUpdate = { row: number; segments: Segment[] };

export type CursorShape = "block" | "underline" | "beam" | "hollow";

export type Cursor = { row: number; col: number; shape: CursorShape; color: number };

export type Frame = {
  cols: number;
  rows: number;
  full: boolean;
  background: number;
  lines: LineUpdate[];
  cursor: Cursor | null;
  offset: number;
  history: number;
  /** The program asked for mouse events. */
  mouse: boolean;
};

/** Mirror of `Font` in core/src/config.rs. */
export type Font = { family: string; size: number };

/** Mirror of `Tab` in core/src/state.rs. */
export type SavedTab = { name: string | null; color: string; icon: string; cwd: string | null };

/** Mirror of `Space` in core/src/state.rs. `closed_at`: `null` if it is open. */
export type SavedSpace = {
  id: number;
  name: string;
  color: string;
  folder: string;
  shell: string | null;
  closed_at: number | null;
  shown: number;
  tabs: SavedTab[];
};

/** Mirror of `State` in core/src/state.rs. */
export type SavedState = {
  shown: number | null;
  /** When it was written, in milliseconds since 1970. */
  saved_at: number | null;
  spaces: SavedSpace[];
  /** The tabs pinned outside of every space. */
  pinned: SavedTab[];
};

/** Mirror of `Status` in core/src/git.rs. */
export type GitStatus = { branch: string; dirty: boolean };

export type SessionEvent =
  | { type: "Frame"; data: Frame }
  | { type: "Title"; data: string }
  | { type: "TitleReset" }
  | { type: "Cwd"; data: string }
  | { type: "Git"; data: GitStatus | null }
  | { type: "Bell" }
  | { type: "Exit" };

// Same bits as SegmentFlags in the core.
export const SegmentFlags = {
  BOLD: 1,
  ITALIC: 1 << 1,
  UNDERLINE: 1 << 2,
  STRIKE: 1 << 3,
  WIDE: 1 << 4,
  CLUSTER: 1 << 5,
} as const;
