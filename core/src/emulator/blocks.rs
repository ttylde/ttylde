//! Command blocks: where each prompt, command line and output is in the
//! grid, from the OSC 133 marks of the shell.
//!
//! The marks are kept in the cells themselves, in the slot of OSC 8 links:
//! from `A` to `B` the cursor writes with the link of the prompt, from `B`
//! to `C` with the one of the command line. Cells carry their link when
//! they scroll into the history, when the grid is resized and its lines
//! reflow, and lose it when they are written over or leave the history:
//! the marks go where the text goes. The output is not marked, since the
//! program writing it can set links of its own: it is what lies between a
//! command line and the next prompt.
//!
//! How a command ended is kept apart, by the number of its block.

use std::collections::BTreeMap;

use alacritty_terminal::{
    grid::{Dimensions, Scroll},
    index::{Column, Line, Point, Side},
    selection::{Selection, SelectionType},
    term::cell::Hyperlink,
    Term,
};
use serde::Serialize;

use super::listener::InternalEventListener;

const PROMPT: &str = "ttylde-prompt-";
const INPUT: &str = "ttylde-input-";

/// How far the command of a block got.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "state", content = "status", rename_all = "lowercase")]
pub enum BlockState {
    /// The prompt waits: no command yet.
    Waiting,
    Running,
    /// With its exit status, if the shell said it.
    Ended(Option<i32>),
}

/// A prompt on screen, and how its command went.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PromptMark {
    /// The screen row of its first line.
    pub row: u16,
    #[serde(flatten)]
    pub state: BlockState,
}

/// What the marks of a cell say.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Part {
    Prompt(u32),
    Input(u32),
}

pub(super) struct Blocks {
    /// The number of the last prompt: blocks count from 1.
    last: u32,
    states: BTreeMap<u32, BlockState>,
    /// How many states to keep: no more blocks than lines fit in the grid.
    keep: usize,
}

impl Blocks {
    pub(super) fn new(keep: usize) -> Self {
        Blocks {
            last: 0,
            states: BTreeMap::new(),
            keep: keep.max(1),
        }
    }

    /// A prompt starts where the cursor is.
    pub(super) fn prompt(&mut self, term: &mut Term<InternalEventListener>) {
        self.last += 1;
        self.states.insert(self.last, BlockState::Waiting);
        while self.states.len() > self.keep {
            self.states.pop_first();
        }
        write_with(term, Some(link(PROMPT, self.last)));
    }

    /// The prompt ends: what follows is the command line.
    pub(super) fn typed(&mut self, term: &mut Term<InternalEventListener>) {
        if self.last > 0 {
            write_with(term, Some(link(INPUT, self.last)));
        }
    }

    pub(super) fn started(&mut self, term: &mut Term<InternalEventListener>) {
        write_with(term, None);
        if let Some(state @ BlockState::Waiting) = self.states.get_mut(&self.last) {
            *state = BlockState::Running;
        }
    }

    pub(super) fn ended(&mut self, term: &mut Term<InternalEventListener>, status: Option<i32>) {
        write_with(term, None);
        if let Some(state) = self.states.get_mut(&self.last) {
            if !matches!(state, BlockState::Ended(_)) {
                *state = BlockState::Ended(status);
            }
        }
    }

    /// Whether the shell has marked a prompt: it has the integration.
    pub(super) fn marked(&self) -> bool {
        self.last > 0
    }

    fn state(&self, block: u32) -> BlockState {
        // Too old to be kept: it did end.
        self.states
            .get(&block)
            .copied()
            .unwrap_or(BlockState::Ended(None))
    }

    /// The prompts that start on screen, and how their commands went.
    pub(super) fn on_screen(&self, term: &Term<InternalEventListener>) -> Vec<PromptMark> {
        if self.last == 0 {
            return Vec::new();
        }
        let offset = term.grid().display_offset() as i32;
        (0..term.screen_lines() as i32)
            .filter_map(|row| {
                let block = prompt_start(term, Line(row - offset))?;
                Some(PromptMark {
                    row: row as u16,
                    state: self.state(block),
                })
            })
            .collect()
    }

    /// Scrolls the view so that the prompt before the first line shown (or
    /// after it) is the first line shown. Down past the last prompt, the
    /// view goes back to the bottom. Returns whether the view moved.
    pub(super) fn jump(&self, term: &mut Term<InternalEventListener>, up: bool) -> bool {
        let before = term.grid().display_offset();
        let top = -(before as i32);
        let target = if up {
            (term.topmost_line().0..top)
                .rev()
                .find(|&line| prompt_start(term, Line(line)).is_some())
        } else {
            (top + 1..=term.bottommost_line().0)
                .find(|&line| prompt_start(term, Line(line)).is_some())
        };
        let offset = match target {
            Some(line) => (-line).clamp(0, term.grid().history_size() as i32),
            None if up => return false,
            None => 0,
        };
        term.scroll_display(Scroll::Delta(offset - before as i32));
        term.grid().display_offset() != before
    }

    /// The lines of the output of the last command run (still running, or
    /// over), without the empty ones at its end. `None`: no command was run,
    /// or it printed nothing still in the grid.
    pub(super) fn last_output(&self, term: &Term<InternalEventListener>) -> Option<(Line, Line)> {
        let block = self
            .states
            .iter()
            .rev()
            .find(|(_, state)| !matches!(state, BlockState::Waiting))
            .map(|(&block, _)| block)?;

        // From the bottom up: where the next prompt starts, and the last
        // line of the prompt and command line of the block.
        let mut next = None;
        let mut head = None;
        for line in (term.topmost_line().0..=term.bottommost_line().0).rev() {
            let parts = parts(term, Line(line));
            if parts
                .iter()
                .any(|&p| matches!(p, Part::Prompt(n) if n > block))
            {
                next = Some(line);
            }
            if parts
                .iter()
                .any(|&p| p == Part::Prompt(block) || p == Part::Input(block))
            {
                head = Some(line);
                break;
            }
        }

        let start = head? + 1;
        let mut end = match next {
            Some(line) => line - 1,
            None => term.grid().cursor.point.line.0,
        };
        while end >= start && line_is_empty(term, Line(end)) {
            end -= 1;
        }
        (end >= start).then_some((Line(start), Line(end)))
    }
}

/// Selects whole lines, from `start` to `end`.
pub(super) fn select_lines(term: &mut Term<InternalEventListener>, start: Line, end: Line) {
    let mut selection = Selection::new(
        SelectionType::Lines,
        Point::new(start, Column(0)),
        Side::Left,
    );
    selection.update(Point::new(end, Column(0)), Side::Right);
    term.selection = Some(selection);
}

fn link(kind: &str, block: u32) -> Hyperlink {
    Hyperlink::new(Some(format!("{kind}{block}")), String::new())
}

// What the cursor writes from now on carries `link`, or nothing.
fn write_with(term: &mut Term<InternalEventListener>, link: Option<Hyperlink>) {
    term.grid_mut().cursor.template.set_hyperlink(link);
}

fn part(link: &Hyperlink) -> Option<Part> {
    let id = link.id();
    if let Some(n) = id.strip_prefix(PROMPT) {
        return n.parse().ok().map(Part::Prompt);
    }
    id.strip_prefix(INPUT)?.parse().ok().map(Part::Input)
}

// The marks found on a line, each once.
fn parts(term: &Term<InternalEventListener>, line: Line) -> Vec<Part> {
    let mut found = Vec::new();
    let row = &term.grid()[line];
    for column in 0..term.columns() {
        if let Some(part) = row[Column(column)].hyperlink().as_ref().and_then(part) {
            if !found.contains(&part) {
                found.push(part);
            }
        }
    }
    found
}

fn prompt_of(parts: &[Part]) -> Option<u32> {
    parts.iter().find_map(|&p| match p {
        Part::Prompt(n) => Some(n),
        Part::Input(_) => None,
    })
}

// The block whose prompt starts on `line`: a prompt of more lines starts on
// the first one.
fn prompt_start(term: &Term<InternalEventListener>, line: Line) -> Option<u32> {
    let block = prompt_of(&parts(term, line))?;
    let above = line - 1;
    if above >= term.topmost_line() && parts(term, above).contains(&Part::Prompt(block)) {
        return None;
    }
    Some(block)
}

pub(super) fn line_is_empty(term: &Term<InternalEventListener>, line: Line) -> bool {
    let row = &term.grid()[line];
    (0..term.columns()).all(|c| {
        let cell = &row[Column(c)];
        cell.c == ' ' || cell.c == '\0' || cell.c == '\t'
    })
}
