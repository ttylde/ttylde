//! Mouse selection: screen coordinates in, selected text out.

use alacritty_terminal::{
    grid::Dimensions,
    index::{Column, Line, Point, Side},
    selection::{Selection, SelectionRange, SelectionType},
};
use serde::Deserialize;

use super::Emulator;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum SelectionKind {
    Simple,
    Word,
    Line,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum SelectionSide {
    Left,
    Right,
}

impl From<SelectionKind> for SelectionType {
    fn from(kind: SelectionKind) -> Self {
        match kind {
            SelectionKind::Line => SelectionType::Lines,
            SelectionKind::Simple => SelectionType::Simple,
            SelectionKind::Word => SelectionType::Semantic,
        }
    }
}

impl From<SelectionSide> for Side {
    fn from(side: SelectionSide) -> Self {
        match side {
            SelectionSide::Left => Side::Left,
            SelectionSide::Right => Side::Right,
        }
    }
}

impl Emulator {
    /// Converts a screen row/column into grid coordinates, accounting for
    /// how far the view has scrolled into the history.
    pub(super) fn grid_point(&self, row: u16, col: u16) -> Point {
        let line = row as i32 - self.display_offset() as i32;
        Point::new(Line(line), Column(col as usize))
    }

    pub fn start_selection(
        &mut self,
        row: u16,
        col: u16,
        side: SelectionSide,
        kind: SelectionKind,
    ) {
        let point = self.grid_point(row, col);
        self.term.selection = Some(Selection::new(kind.into(), point, side.into()));
        self.dirty = true;
    }

    pub fn update_selection(&mut self, row: u16, col: u16, side: SelectionSide) {
        let point = self.grid_point(row, col);
        if let Some(selection) = self.term.selection.as_mut() {
            selection.update(point, side.into());
            self.dirty = true;
        }
    }

    pub fn clear_selection(&mut self) {
        if self.term.selection.take().is_some() {
            self.dirty = true;
        }
    }

    pub fn selection_text(&self) -> Option<String> {
        self.term.selection_to_string()
    }

    /// Screen rows covered by a selection range, dropping those that
    /// scrolled out of view into the history.
    pub(super) fn selection_rows(&self, range: &SelectionRange) -> impl Iterator<Item = usize> {
        let offset = self.display_offset() as i32;
        let rows = self.term.screen_lines() as i32;
        let start = (range.start.line.0 + offset).max(0);
        let end = (range.end.line.0 + offset).min(rows - 1);
        (start..=end).map(|row| row as usize)
    }
}
