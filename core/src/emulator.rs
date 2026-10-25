//! The terminal emulator: bytes in, frames out.
//!
//! Split by concern: colors in `color`, mouse selection in `selection`,
//! unit tests in `tests`. All of them extend `Emulator`.

mod blocks;
mod color;
mod listener;
mod osc;
mod selection;
#[cfg(test)]
mod tests;

use std::mem;

use alacritty_terminal::{
    event::Event,
    grid::{Dimensions, Scroll},
    index::{Column, Line, Point},
    selection::SelectionRange,
    term::{cell::Flags, Config, TermDamage, TermMode},
    vte::{
        ansi::{Color, CursorShape as VtCursorShape, NamedColor, Processor},
        Parser,
    },
    Term,
};

use crate::{
    command::Mark,
    cwd::Location,
    emulator::{
        blocks::Blocks,
        osc::{Announcement, OscWatcher},
    },
    frame::{Cursor, CursorShape, Frame, LineUpdate, Segment, SegmentFlags},
    input::{InputMode, MouseTracking},
    theme::Theme,
};

use listener::InternalEventListener;

pub use blocks::{BlockState, PromptMark};
pub use selection::{SelectionKind, SelectionSide};

/// What the terminal asks of whoever drives it, collected while parsing.
#[derive(Debug, PartialEq)]
pub enum EmulatorEvent {
    Title(String),
    ResetTitle,
    Bell,
    Write(Vec<u8>),
    Location(Location),
    Mark(Mark),
}

struct Size {
    cols: u16,
    rows: u16,
    history: usize,
}

impl Dimensions for Size {
    fn columns(&self) -> usize {
        usize::from(self.cols)
    }

    fn screen_lines(&self) -> usize {
        usize::from(self.rows)
    }

    fn total_lines(&self) -> usize {
        usize::from(self.rows) + self.history
    }
}

pub struct Emulator {
    dirty: bool,
    term: Term<InternalEventListener>,
    events: InternalEventListener,
    parser: Processor,
    theme: Theme,
    force_full: bool,
    history: usize,
    /// Selection as of the last frame, to mark its rows dirty when it changes.
    last_selection: Option<SelectionRange>,
    focused: bool,
    /// Reads the same bytes as `parser`, for what it leaves out
    osc_parser: Parser,
    osc: OscWatcher,
    blocks: Blocks,
}

impl Emulator {
    pub fn new(cols: u16, rows: u16, theme: Theme, history: usize) -> Self {
        let config = Config {
            scrolling_history: history,
            ..Default::default()
        };

        let events = InternalEventListener::default();
        let term = Term::new(
            config,
            &Size {
                cols,
                rows,
                history,
            },
            events.clone(),
        );
        let parser = Processor::new();

        Emulator {
            dirty: false,
            term,
            events,
            parser,
            theme,
            force_full: true,
            history,
            last_selection: None,
            focused: true,
            osc_parser: Parser::default(),
            osc: OscWatcher::default(),
            blocks: Blocks::new(history + usize::from(rows)),
        }
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        self.dirty = true;
        // Where a mark falls in the grid is where the cursor is once the
        // terminal has read up to it: the bytes go to both parsers a piece
        // at a time, cut after every byte that can end an OSC (BEL, or the
        // `\` of ST).
        let mut rest = bytes;
        while !rest.is_empty() {
            let end = rest
                .iter()
                .position(|&b| b == 0x07 || b == b'\\')
                .map_or(rest.len(), |i| i + 1);
            let (piece, tail) = rest.split_at(end);
            let from = self.osc.len();
            self.osc_parser.advance(&mut self.osc, piece);
            self.parser.advance(&mut self.term, piece);
            if self.osc.len() > from {
                self.place_marks(from);
            }
            rest = tail;
        }
    }

    // The marks announced from the `from`th on, where the cursor is now.
    fn place_marks(&mut self, from: usize) {
        for announcement in self.osc.since(from) {
            let term = &mut self.term;
            match announcement {
                Announcement::Mark(Mark::Prompt) => self.blocks.prompt(term),
                Announcement::Typed => self.blocks.typed(term),
                Announcement::Mark(Mark::Start(_)) => self.blocks.started(term),
                Announcement::Mark(Mark::End(status)) => self.blocks.ended(term, *status),
                Announcement::Mark(Mark::Text(_)) | Announcement::Location(_) => {}
            }
        }
    }

    /// The prompts that start on screen, and how their commands went.
    pub fn prompts_on_screen(&self) -> Vec<PromptMark> {
        self.blocks.on_screen(&self.term)
    }

    /// Scrolls to the prompt above the first line shown, or below it.
    /// Returns whether the view moved.
    pub fn jump_to_prompt(&mut self, up: bool) -> bool {
        let moved = self.blocks.jump(&mut self.term, up);
        self.dirty |= moved;
        moved
    }

    /// The output of the last command run, as text.
    pub fn last_output(&self) -> Option<String> {
        let (start, end) = self.blocks.last_output(&self.term)?;
        let last = Column(self.term.last_column().0);
        Some(
            self.term
                .bounds_to_string(Point::new(start, Column(0)), Point::new(end, last)),
        )
    }

    /// The last `count` lines of the output of the last command run, as
    /// text: what the card of a tab shows. Without the marks of the shell,
    /// the last lines of the screen that are not empty, as it does not say
    /// where an output starts.
    pub fn output_tail(&self, count: usize) -> Vec<String> {
        let lines: Vec<Line> = match self.blocks.last_output(&self.term) {
            Some((start, end)) => {
                let from = start.0.max(end.0 + 1 - count as i32);
                (from..=end.0).map(Line).collect()
            }
            None if self.blocks.marked() => Vec::new(),
            None => {
                let mut lines: Vec<Line> = (0..self.term.screen_lines() as i32)
                    .rev()
                    .map(Line)
                    .filter(|&line| !blocks::line_is_empty(&self.term, line))
                    .take(count)
                    .collect();
                lines.reverse();
                lines
            }
        };
        lines.into_iter().map(|line| self.text_of(line)).collect()
    }

    // The text of a line of the grid, without the spaces at its end.
    fn text_of(&self, line: Line) -> String {
        let row = &self.term.grid()[line];
        let mut text = String::new();
        for column in 0..self.term.columns() {
            let cell = &row[Column(column)];
            if cell
                .flags
                .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
            {
                continue;
            }
            text.push(match cell.c {
                '\0' | '\t' => ' ',
                c => c,
            });
            text.extend(cell.zerowidth().into_iter().flatten());
        }
        text.truncate(text.trim_end().len());
        text
    }

    /// Selects the output of the last command run, and scrolls to where it
    /// starts if that is not in view. Returns whether there was one.
    pub fn select_last_output(&mut self) -> bool {
        let Some((start, end)) = self.blocks.last_output(&self.term) else {
            return false;
        };
        blocks::select_lines(&mut self.term, start, end);
        let top = -(self.display_offset() as i32);
        let bottom = top + self.term.screen_lines() as i32 - 1;
        if start.0 < top || start.0 > bottom {
            let offset = (-start.0).clamp(0, self.term.grid().history_size() as i32);
            self.term
                .scroll_display(Scroll::Delta(offset - self.display_offset() as i32));
        }
        self.dirty = true;
        true
    }

    #[cfg(test)]
    fn line_text(&self, row: usize) -> String {
        let total_cols = self.term.columns();
        let mut text = String::new();
        let offset = self.display_offset() as i32;
        let line = &self.term.grid()[Line(row as i32 - offset)];
        for c in 0..total_cols {
            let cell = &line[Column(c)];
            text.push(cell.c);
        }

        text.trim_end().to_string()
    }

    /// The state that affects key encoding, read from the modes programs
    /// enable with `CSI ? n h` sequences.
    pub fn input_mode(&self) -> InputMode {
        let mode = self.term.mode();
        InputMode {
            app_cursor: mode.contains(TermMode::APP_CURSOR),
            bracketed_paste: mode.contains(TermMode::BRACKETED_PASTE),
            alt_screen: mode.contains(TermMode::ALT_SCREEN),
            alternate_scroll: mode.contains(TermMode::ALTERNATE_SCROLL),
            sgr_mouse: mode.contains(TermMode::SGR_MOUSE),
            focus_events: mode.contains(TermMode::FOCUS_IN_OUT),
            mouse: if mode.contains(TermMode::MOUSE_MOTION) {
                MouseTracking::Motion
            } else if mode.contains(TermMode::MOUSE_DRAG) {
                MouseTracking::Drag
            } else if mode.contains(TermMode::MOUSE_REPORT_CLICK) {
                MouseTracking::Click
            } else {
                MouseTracking::Off
            },
        }
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.term.resize(Size {
            cols,
            rows,
            history: self.history,
        });
        self.force_full = true;
        self.dirty = true;
    }

    fn line_segments(&self, row: usize) -> Vec<Segment> {
        let total_cols = self.term.columns();
        let mut segments: Vec<Segment> = Vec::new();
        let offset = self.display_offset() as i32;
        let line = &self.term.grid()[Line(row as i32 - offset)];
        let selection = self.term.renderable_content().selection;
        for c in 0..total_cols {
            let cell = &line[Column(c)];
            // check PLACEHOLDER
            if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                continue;
            }

            // check COLORS
            let mut fg = self.resolve(cell.fg);
            let mut bg = self.resolve(cell.bg);
            if cell.flags.contains(Flags::INVERSE) {
                mem::swap(&mut fg, &mut bg);
            }
            // check SELECTION: after INVERSE, so a selected cell always gets
            // the selection background
            let point = Point::new(Line(row as i32 - offset), Column(c));
            if selection.is_some_and(|range| range.contains(point)) {
                bg = self.theme.selection;
            }
            if cell.flags.contains(Flags::DIM) {
                fg = Self::dim(fg, bg);
            }
            if cell.flags.contains(Flags::HIDDEN) {
                fg = bg;
            }

            // the marks that combine with the character live in the same cell
            let mut text = cell.c.to_string();
            let marks = cell.zerowidth();
            if let Some(marks) = marks {
                text.extend(marks);
            }

            // check ATTRIBUTES
            let mut attributes: u8 = 0;
            if cell.flags.contains(Flags::BOLD) {
                attributes |= SegmentFlags::BOLD;
            }
            if cell.flags.contains(Flags::ITALIC) {
                attributes |= SegmentFlags::ITALIC;
            }
            if cell.flags.contains(Flags::STRIKEOUT) {
                attributes |= SegmentFlags::STRIKE;
            }
            if cell.flags.contains(Flags::WIDE_CHAR) {
                attributes |= SegmentFlags::WIDE;
            }
            if cell.flags.intersects(Flags::ALL_UNDERLINES) {
                attributes |= SegmentFlags::UNDERLINE;
            }
            if marks.is_some() {
                attributes |= SegmentFlags::CLUSTER;
            }

            // check WIDTH
            let width: u16 = if cell.flags.contains(Flags::WIDE_CHAR) {
                2
            } else {
                1
            };

            // check if attach the current char to the current segment
            if let Some(last) = segments.last_mut() {
                let is_same =
                    marks.is_none() && fg == last.fg && bg == last.bg && attributes == last.flags;
                if is_same {
                    last.text.push_str(&text);
                    last.cols += width;
                    continue;
                }
            }

            segments.push(Segment {
                text,
                cols: width,
                fg,
                bg,
                flags: attributes,
            })
        }

        segments
    }

    fn cursor(&self) -> Option<Cursor> {
        let content = self.term.renderable_content();
        let vt = content.cursor;

        let col: u16 = vt.point.column.0 as u16;

        let offset = self.display_offset() as i32;
        let row: i32 = vt.point.line.0 + offset;
        if row >= self.term.screen_lines() as i32 {
            return None;
        }

        let mut shape: CursorShape = match vt.shape {
            VtCursorShape::Hidden => return None,
            VtCursorShape::Beam => CursorShape::Beam,
            VtCursorShape::Block => CursorShape::Block,
            VtCursorShape::HollowBlock => CursorShape::Hollow,
            VtCursorShape::Underline => CursorShape::Underline,
        };

        if !self.focused {
            shape = CursorShape::Hollow;
        }

        Some(Cursor {
            row: row as u16,
            col,
            shape,
            color: self.resolve(Color::Named(NamedColor::Cursor)),
        })
    }

    pub fn frame(&mut self) -> Option<Frame> {
        // dimensions
        let rows = self.term.screen_lines();
        let columns = self.term.columns();

        // check the updated lines
        let mut full = self.force_full;
        if !full && !self.dirty {
            return None;
        }

        self.dirty = false;

        let mut changed: Vec<usize> = Vec::new();
        match self.term.damage() {
            TermDamage::Full => full = true,
            TermDamage::Partial(lines) => changed.extend(lines.map(|d| d.line)),
        }
        self.term.reset_damage();
        self.force_full = false;

        // the selection is not part of alacritty's damage: we mark the rows
        // of the old and the new selection ourselves
        let selection = self.term.renderable_content().selection;
        if !full {
            for range in [self.last_selection, selection].into_iter().flatten() {
                changed.extend(self.selection_rows(&range));
            }
            changed.sort_unstable();
            changed.dedup();
        }
        self.last_selection = selection;

        if full {
            changed = (0..rows).collect();
        }

        // cursor
        let cursor = self.cursor();

        // compute updated lines
        let line_updates: Vec<LineUpdate> = changed
            .iter()
            .map(|&row| LineUpdate {
                row: row as u16,
                segments: self.line_segments(row),
            })
            .collect();

        // remember and return
        Some(Frame {
            cols: columns as u16,
            rows: rows as u16,
            background: self.resolve(Color::Named(NamedColor::Background)),
            lines: line_updates,
            full,
            cursor,
            offset: self.display_offset() as u32,
            history: self.term.grid().history_size() as u32,
            mouse: self.input_mode().mouse != MouseTracking::Off,
        })
    }

    pub fn display_offset(&self) -> usize {
        self.term.grid().display_offset()
    }

    pub fn scroll(&mut self, delta: i32) {
        let before = self.display_offset();
        self.term.scroll_display(Scroll::Delta(delta));
        if self.display_offset() != before {
            self.dirty = true;
        }
    }

    /// A selection dragged past the top or bottom edge: the view scrolls by
    /// `delta` rows (up when positive, as `scroll`) and the selection
    /// extends to the given cell of the screen, which now shows other
    /// lines. The start of the selection stays on its line of the history.
    pub fn scroll_selection(&mut self, delta: i32, row: u16, col: u16, side: SelectionSide) {
        self.scroll(delta);
        self.update_selection(row, col, side);
    }

    pub fn scroll_to_bottom(&mut self) {
        if self.display_offset() != 0 {
            self.term.scroll_display(Scroll::Bottom);
            self.dirty = true;
        }
    }

    /// Drains the events produced by the bytes fed so far. Color queries
    /// are answered here, since the reply depends on the theme.
    pub fn take_events(&mut self) -> Vec<EmulatorEvent> {
        let mut events: Vec<EmulatorEvent> = self
            .events
            .take()
            .into_iter()
            .filter_map(|event| match event {
                Event::Title(title) => Some(EmulatorEvent::Title(title)),
                Event::ResetTitle => Some(EmulatorEvent::ResetTitle),
                Event::Bell => Some(EmulatorEvent::Bell),
                Event::PtyWrite(text) => Some(EmulatorEvent::Write(text.into_bytes())),
                Event::ColorRequest(index, format) => {
                    let rgb = color::u32_to_rgb(self.resolve_index(index));
                    Some(EmulatorEvent::Write(format(rgb).into_bytes()))
                }
                _ => None,
            })
            .collect();

        events.extend(self.osc.take().into_iter().filter_map(|a| match a {
            Announcement::Location(location) => Some(EmulatorEvent::Location(location)),
            Announcement::Mark(mark) => Some(EmulatorEvent::Mark(mark)),
            Announcement::Typed => None,
        }));
        events
    }

    /// The secret the session's shell puts in the marks that carry the
    /// text of a command; `None`: no text is believed.
    pub fn set_nonce(&mut self, nonce: Option<String>) {
        self.osc.nonce = nonce;
    }

    /// Tells the emulator whether its window has the focus.
    /// Returns `false` if that was already known.
    pub fn set_focused(&mut self, focused: bool) -> bool {
        if self.focused == focused {
            return false;
        }

        self.focused = focused;
        self.dirty = true;
        true
    }
}
