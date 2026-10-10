//! The terminal emulator: bytes in, frames out.
//!
//! Split by concern: colors in `color`, mouse selection in `selection`,
//! unit tests in `tests`. All of them extend `Emulator`.

mod color;
mod listener;
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
    vte::ansi::{Color, CursorShape as VtCursorShape, NamedColor, Processor},
    Term,
};

use crate::{
    frame::{Cursor, CursorShape, Frame, LineUpdate, Segment, SegmentFlags},
    input::{InputMode, MouseTracking},
    theme::Theme,
};

use listener::InternalEventListener;

pub use selection::{SelectionKind, SelectionSide};

/// What the terminal asks of whoever drives it, collected while parsing.
#[derive(Debug, PartialEq)]
pub enum EmulatorEvent {
    Title(String),
    ResetTitle,
    Bell,
    Write(Vec<u8>),
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
        }
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        self.dirty = true;
        self.parser.advance(&mut self.term, bytes);
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

    pub fn scroll_to_bottom(&mut self) {
        if self.display_offset() != 0 {
            self.term.scroll_display(Scroll::Bottom);
            self.dirty = true;
        }
    }

    /// Drains the events produced by the bytes fed so far. Color queries
    /// are answered here, since the reply depends on the theme.
    pub fn take_events(&self) -> Vec<EmulatorEvent> {
        self.events
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
            .collect()
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
