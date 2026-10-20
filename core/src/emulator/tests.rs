use alacritty_terminal::{
    index::{Column, Line},
    vte::ansi::{Color, NamedColor, Rgb},
};

use super::*;
use crate::{command::Mark, cwd::Location};

#[test]
fn write_text_on_two_lines() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"hello\r\nrust!");

    assert_eq!(emulator.line_text(0), "hello");
    assert_eq!(emulator.line_text(1), "rust!");
}

#[test]
fn check_cursor_position() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"hello\r\nrust!");

    let point = emulator.term.grid().cursor.point;
    assert_eq!(point.line, Line(1));
    assert_eq!(point.column, Column(5));

    emulator.feed(b"\r\n");
    let point = emulator.term.grid().cursor.point;
    assert_eq!(point.line, Line(2));
    assert_eq!(point.column, Column(0));
}

#[test]
fn check_the_escape_parsing() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"\x1b[31mrosso");

    let cell = &emulator.term.grid()[Line(0)][Column(0)];
    let cell_color = cell.fg;
    let line_text = emulator.line_text(0);
    assert_eq!(cell_color, Color::Named(NamedColor::Red));
    assert_eq!(line_text, "rosso");
}

// The three kinds of `Color` resolve to `0xRRGGBB` through the theme.
#[test]
fn resolve_colors_with_the_theme() {
    let emulator = Emulator::new(20, 5, Theme::default(), 100);

    assert_eq!(
        emulator.resolve(Color::Named(NamedColor::Red)),
        emulator.theme.ansi[1]
    );
    assert_eq!(
        emulator.resolve(Color::Named(NamedColor::Foreground)),
        emulator.theme.foreground
    );
    assert_eq!(emulator.resolve(Color::Indexed(196)), 0xff0000);
    assert_eq!(
        emulator.resolve(Color::Spec(Rgb { r: 1, g: 2, b: 3 })),
        0x010203
    );
}

// Adjacent cells with the same style merge into a single segment.
#[test]
fn two_styles_make_two_segments() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"\x1b[31mab");

    let segments = emulator.line_segments(0);
    assert_eq!(segments.len(), 2);
    assert_eq!(segments[0].text, "ab");
    assert_eq!(segments[0].cols, 2);
    assert_eq!(segments[0].fg, emulator.theme.ansi[1]);
    // the rest of the row: spaces with default colors
    assert_eq!(segments[1].cols, 18);
    assert_eq!(segments[1].fg, emulator.theme.foreground);
    assert_eq!(segments[1].bg, emulator.theme.background);
}

// A color change mid-row starts a new segment.
#[test]
fn color_change_splits_the_segment() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"a\x1b[31mb");

    let segments = emulator.line_segments(0);
    assert_eq!(segments.len(), 3);
    assert_eq!(segments[0].text, "a");
    assert_eq!(segments[1].text, "b");
    assert_eq!(segments[1].fg, emulator.theme.ansi[1]);
}

// Several attributes on one cell end up as bits in the same `u8`.
#[test]
fn attributes_are_combined_as_bits() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"\x1b[1;4mx");

    let segments = emulator.line_segments(0);
    assert_eq!(
        segments[0].flags,
        SegmentFlags::BOLD | SegmentFlags::UNDERLINE
    );
    assert_eq!(segments[1].flags, 0);
}

// `INVERSE` swaps foreground and background already in the core.
#[test]
fn inverse_swaps_the_colors() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"\x1b[7mx");

    let segments = emulator.line_segments(0);
    assert_eq!(segments[0].fg, emulator.theme.background);
    assert_eq!(segments[0].bg, emulator.theme.foreground);
}

// A wide character takes two columns and its spacer is skipped.
#[test]
fn wide_char_takes_two_columns() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed("日".as_bytes());

    let segments = emulator.line_segments(0);
    assert_eq!(segments[0].text, "日");
    assert_eq!(segments[0].cols, 2);
    assert_eq!(segments[0].flags, SegmentFlags::WIDE);
    assert_eq!(segments[1].cols, 18);
}

// A combining mark has no cell of its own: it travels with the character
// before it, in a segment that holds that cell alone.
#[test]
fn combining_mark_stays_with_its_character() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed("e\u{301}".as_bytes());

    let segments = emulator.line_segments(0);
    assert_eq!(segments[0].text, "e\u{301}");
    assert_eq!(segments[0].cols, 1);
    assert_eq!(segments[0].flags, SegmentFlags::CLUSTER);
    assert_eq!(segments[1].cols, 19);
}

// Every mark is kept, in the order it arrived.
#[test]
fn several_marks_stack_on_one_cell() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed("a\u{308}\u{301}".as_bytes());

    let segments = emulator.line_segments(0);
    assert_eq!(segments[0].text, "a\u{308}\u{301}");
    assert_eq!(segments[0].cols, 1);
}

// The text around a cluster is not merged with it, same style or not:
// the renderer has to know where the cluster begins and ends.
#[test]
fn cluster_splits_the_text_around_it() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed("ae\u{301}b".as_bytes());

    let segments = emulator.line_segments(0);
    assert_eq!(segments[0].text, "a");
    assert_eq!(segments[0].flags, 0);
    assert_eq!(segments[1].text, "e\u{301}");
    assert_eq!(segments[1].flags, SegmentFlags::CLUSTER);
    // `b` and the rest of the row
    assert_eq!(segments[2].text.trim_end(), "b");
    assert_eq!(segments[2].cols, 18);
    assert_eq!(segments[2].flags, 0);
}

// Two clusters side by side have the same style and the same flags, and
// still make two segments: one cell each.
#[test]
fn adjacent_clusters_stay_separate() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed("e\u{301}o\u{308}".as_bytes());

    let segments = emulator.line_segments(0);
    assert_eq!(segments[0].text, "e\u{301}");
    assert_eq!(segments[0].cols, 1);
    assert_eq!(segments[1].text, "o\u{308}");
    assert_eq!(segments[1].cols, 1);
}

// The mark of a wide character belongs to the character, not to its spacer.
#[test]
fn wide_char_can_be_a_cluster() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed("日\u{301}".as_bytes());

    let segments = emulator.line_segments(0);
    assert_eq!(segments[0].text, "日\u{301}");
    assert_eq!(segments[0].cols, 2);
    assert_eq!(
        segments[0].flags,
        SegmentFlags::WIDE | SegmentFlags::CLUSTER
    );
    assert_eq!(segments[1].cols, 18);
}

// Text without marks is as before: one segment, no flag.
#[test]
fn plain_text_is_not_a_cluster() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"abc");

    let segments = emulator.line_segments(0);
    assert_eq!(segments.len(), 1);
    assert_eq!(segments[0].cols, 20);
    assert_eq!(segments[0].flags, 0);
}

// The cursor follows the written text, with the default block shape.
#[test]
fn cursor_follows_the_text() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"ping");

    let expected = Cursor {
        row: 0,
        col: 4,
        shape: CursorShape::Block,
        color: Theme::default().cursor,
    };
    assert_eq!(emulator.cursor(), Some(expected));
}

// `\x1b[?25l` hides the cursor, `\x1b[?25h` shows it again.
#[test]
fn hidden_cursor_is_none() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);

    emulator.feed(b"\x1b[?25l");
    assert_eq!(emulator.cursor(), None);

    emulator.feed(b"\x1b[?25h");
    assert!(emulator.cursor().is_some());
}

// Programs change the cursor shape with `DECSCUSR` (`\x1b[ q`).
#[test]
fn cursor_shape_follows_the_program() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);

    emulator.feed(b"\x1b[6 q");
    assert_eq!(emulator.cursor().unwrap().shape, CursorShape::Beam);

    emulator.feed(b"\x1b[4 q");
    assert_eq!(emulator.cursor().unwrap().shape, CursorShape::Underline);
}

// `CSI ? 1 h` enables application cursor keys, `CSI ? 2004 h` bracketed paste.
#[test]
fn input_mode_follows_the_program() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    let mode = emulator.input_mode();
    assert!(!mode.app_cursor);
    assert!(!mode.bracketed_paste);
    assert!(!mode.alt_screen);
    // as in xterm, alternate scroll is on by default
    assert!(mode.alternate_scroll);

    emulator.feed(b"\x1b[?1h\x1b[?2004h\x1b[?1049h");
    let mode = emulator.input_mode();
    assert!(mode.app_cursor);
    assert!(mode.bracketed_paste);
    assert!(mode.alt_screen);
}

// `CSI ? 1000 h` asks for clicks, 1002 adds drags, 1003 every move; each
// replaces the one before. `CSI ? 1006 h` picks the SGR format.
#[test]
fn mouse_tracking_follows_the_program() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    let mode = emulator.input_mode();
    assert_eq!(mode.mouse, MouseTracking::Off);
    assert!(!mode.sgr_mouse);

    emulator.feed(b"\x1b[?1000h\x1b[?1006h");
    let mode = emulator.input_mode();
    assert_eq!(mode.mouse, MouseTracking::Click);
    assert!(mode.sgr_mouse);

    emulator.feed(b"\x1b[?1002h");
    assert_eq!(emulator.input_mode().mouse, MouseTracking::Drag);
    emulator.feed(b"\x1b[?1003h");
    assert_eq!(emulator.input_mode().mouse, MouseTracking::Motion);
    emulator.feed(b"\x1b[?1003l");
    assert_eq!(emulator.input_mode().mouse, MouseTracking::Off);
}

// Without the focus the cursor is hollow whatever shape the program chose,
// and gets its shape back with the focus.
#[test]
fn cursor_is_hollow_without_focus() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"\x1b[6 q");
    assert_eq!(emulator.cursor().unwrap().shape, CursorShape::Beam);

    assert!(emulator.set_focused(false));
    assert_eq!(emulator.cursor().unwrap().shape, CursorShape::Hollow);
    assert!(emulator.set_focused(true));
    assert_eq!(emulator.cursor().unwrap().shape, CursorShape::Beam);
}

// A cursor the program hid stays hidden.
#[test]
fn hidden_cursor_stays_hidden_without_focus() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"\x1b[?25l");
    emulator.set_focused(false);
    assert_eq!(emulator.cursor(), None);
}

// A focus change produces a frame on its own; repeating it does not.
#[test]
fn focus_change_produces_a_frame_once() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.frame();
    assert!(!emulator.set_focused(true));
    assert_eq!(emulator.frame(), None);

    assert!(emulator.set_focused(false));
    let frame = emulator.frame().unwrap();
    assert_eq!(frame.cursor.unwrap().shape, CursorShape::Hollow);
    assert!(!emulator.set_focused(false));
    assert_eq!(emulator.frame(), None);
}

// `CSI ? 1004 h` asks for focus reports.
#[test]
fn focus_events_follow_the_program() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    assert!(!emulator.input_mode().focus_events);
    emulator.feed(b"\x1b[?1004h");
    assert!(emulator.input_mode().focus_events);
    emulator.feed(b"\x1b[?1004l");
    assert!(!emulator.input_mode().focus_events);
}

// Rows that scroll off the screen stay in the history, with negative indices.
#[test]
fn scrolled_out_lines_stay_in_history() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    for i in 0..10 {
        emulator.feed(format!("row {i}\r\n").as_bytes());
    }

    // 11 rows touched (10 written plus the empty cursor row), 5 visible
    assert_eq!(emulator.term.grid().history_size(), 6);
    // Line(-1) is the row just above the screen: "row 5"
    assert_eq!(emulator.term.grid()[Line(-1)][Column(4)].c, '5');
    assert_eq!(emulator.line_text(0), "row 6");
}

// Scrolling moves the view into the history and stops at its bounds.
#[test]
fn scrolling_shows_the_history() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    for i in 0..10 {
        emulator.feed(format!("row {i}\r\n").as_bytes());
    }

    emulator.scroll(3);
    assert_eq!(emulator.display_offset(), 3);
    assert_eq!(emulator.line_text(0), "row 3");

    // no going past the history: the view stops at the first row
    emulator.scroll(100);
    assert_eq!(emulator.display_offset(), 6);
    assert_eq!(emulator.line_text(0), "row 0");

    emulator.scroll_to_bottom();
    assert_eq!(emulator.display_offset(), 0);
    assert_eq!(emulator.line_text(0), "row 6");
}

// A scroll produces a full frame; a no-op scroll produces none.
#[test]
fn scroll_produces_a_full_frame_only_when_the_view_moves() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    for i in 0..10 {
        emulator.feed(format!("row {i}\r\n").as_bytes());
    }
    emulator.frame();

    emulator.scroll(2);
    let frame = emulator.frame().unwrap();
    assert!(frame.full);
    assert_eq!(frame.lines[0].segments[0].text.trim_end(), "row 4");
    assert_eq!((frame.offset, frame.history), (2, 6));

    // already at the bottom: scrolling down changes nothing
    emulator.scroll_to_bottom();
    emulator.frame();
    emulator.scroll(-1);
    assert_eq!(emulator.frame(), None);
}

// Scrolling back pushes the cursor past the bottom edge, where it disappears.
#[test]
fn cursor_disappears_when_scrolled_back() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    for i in 0..10 {
        emulator.feed(format!("row {i}\r\n").as_bytes());
    }
    assert_eq!(emulator.cursor().unwrap().row, 4);

    emulator.scroll(1);
    assert_eq!(emulator.cursor(), None);

    emulator.scroll_to_bottom();
    assert_eq!(emulator.cursor().unwrap().row, 4);
}

// The first frame is full: the renderer starts from an empty screen.
#[test]
fn first_frame_is_full() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);

    let frame = emulator.frame().unwrap();
    assert!(frame.full);
    assert_eq!(frame.lines.len(), 5);
    assert_eq!((frame.cols, frame.rows), (20, 5));
}

// After the first frame only the touched rows are sent.
#[test]
fn next_frame_has_only_changed_lines() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.frame();

    emulator.feed(b"ping");
    let frame = emulator.frame().unwrap();
    assert!(!frame.full);
    assert_eq!(frame.lines.len(), 1);
    assert_eq!(frame.lines[0].row, 0);
    // "ping" and the spaces after it share a style: a single segment
    assert!(frame.lines[0].segments[0].text.starts_with("ping"));
    assert_eq!(frame.lines[0].segments[0].cols, 20);
}

// Nothing new, no frame.
#[test]
fn no_changes_means_no_frame() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.frame();

    assert_eq!(emulator.frame(), None);
}

// Moving the cursor dirties both the row it left and the row it reached.
#[test]
fn cursor_move_damages_both_lines() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"ping");
    emulator.frame();

    emulator.feed(b"\r\n");
    let frame = emulator.frame().unwrap();
    let rows: Vec<u16> = frame.lines.iter().map(|l| l.row).collect();
    assert_eq!(rows, vec![0, 1]);
    assert_eq!(frame.cursor.unwrap().row, 1);
}

// Dragging from (0,0) to (1,2) selects the first two rows.
#[test]
fn dragging_selects_a_range_of_text() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"foo\r\ndue\r\ntre");

    emulator.start_selection(0, 0, SelectionSide::Left, SelectionKind::Simple);
    emulator.update_selection(1, 2, SelectionSide::Right);

    assert_eq!(emulator.selection_text(), Some("foo\ndue".to_string()));
}

// Double click takes the word, triple click the whole row (newline included).
#[test]
fn word_and_line_selection() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"foo bar\r\ntre");

    emulator.start_selection(0, 5, SelectionSide::Left, SelectionKind::Word);
    assert_eq!(emulator.selection_text(), Some("bar".to_string()));

    emulator.start_selection(0, 5, SelectionSide::Left, SelectionKind::Line);
    assert_eq!(emulator.selection_text(), Some("foo bar\n".to_string()));
}

// No selection, no text; same after `clear_selection`.
#[test]
fn clearing_removes_the_selection() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"foo");
    assert_eq!(emulator.selection_text(), None);

    emulator.start_selection(0, 0, SelectionSide::Left, SelectionKind::Line);
    emulator.clear_selection();

    assert_eq!(emulator.selection_text(), None);
}

// Selection follows the history: row 0 of a scrolled screen is the old row.
#[test]
fn selection_uses_screen_coordinates_when_scrolled() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"foo\r\ndue\r\ntre\r\nquattro\r\ncinque\r\nsei\r\nsette");
    emulator.scroll(2);

    emulator.start_selection(0, 0, SelectionSide::Left, SelectionKind::Line);

    assert_eq!(emulator.selection_text(), Some("foo\n".to_string()));
}

// Changing the selection produces a frame, even without new output.
#[test]
fn selection_changes_make_the_emulator_dirty() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"foo");
    emulator.frame();

    emulator.start_selection(0, 0, SelectionSide::Left, SelectionKind::Simple);
    assert!(emulator.frame().is_some());

    emulator.clear_selection();
    assert!(emulator.frame().is_some());

    emulator.clear_selection();
    assert_eq!(emulator.frame(), None);
}

// Selected cells get the theme's selection background, the others don't.
#[test]
fn selected_cells_get_the_selection_background() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    let theme = Theme::default();
    emulator.feed(b"foo bar");

    emulator.start_selection(0, 0, SelectionSide::Left, SelectionKind::Simple);
    emulator.update_selection(0, 2, SelectionSide::Right);

    let segments = emulator.line_segments(0);
    assert_eq!(segments[0].text, "foo");
    assert_eq!(segments[0].bg, theme.selection);
    assert_eq!(segments[1].bg, theme.background);
}

// The selection wins even over an INVERSE cell.
#[test]
fn selection_background_overrides_inverse() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"\x1b[7mab\x1b[0m");

    emulator.start_selection(0, 0, SelectionSide::Left, SelectionKind::Word);

    let segments = emulator.line_segments(0);
    assert_eq!(segments[0].text, "ab");
    assert_eq!(segments[0].bg, Theme::default().selection);
    assert_eq!(segments[0].fg, Theme::default().background);
}

// After `clear_selection` the background is back to normal.
#[test]
fn clearing_restores_the_background() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"foo");

    emulator.start_selection(0, 0, SelectionSide::Left, SelectionKind::Line);
    emulator.clear_selection();

    let segments = emulator.line_segments(0);
    assert!(segments.iter().all(|s| s.bg == Theme::default().background));
}

// Starting a selection dirties its rows, not just the cursor row.
#[test]
fn selection_damages_its_rows() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"foo\r\ndue\r\ntre\r\nquattro");
    emulator.frame();

    emulator.start_selection(0, 0, SelectionSide::Left, SelectionKind::Simple);
    emulator.update_selection(1, 2, SelectionSide::Right);

    let frame = emulator.frame().unwrap();
    assert!(!frame.full);
    let rows: Vec<u16> = frame.lines.iter().map(|l| l.row).collect();
    // rows 0 and 1 selected, row 3 holds the cursor
    assert_eq!(rows, vec![0, 1, 3]);
}

// Shrinking the selection also redraws the rows that lost it.
#[test]
fn shrinking_the_selection_redraws_the_old_rows() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"foo\r\ndue\r\ntre\r\nquattro");
    emulator.start_selection(0, 0, SelectionSide::Left, SelectionKind::Simple);
    emulator.update_selection(2, 2, SelectionSide::Right);
    emulator.frame();

    emulator.update_selection(0, 2, SelectionSide::Right);

    let frame = emulator.frame().unwrap();
    let rows: Vec<u16> = frame.lines.iter().map(|l| l.row).collect();
    assert_eq!(rows, vec![0, 1, 2, 3]);
    let background = Theme::default().background;
    let row1 = &frame.lines[1];
    assert!(row1.segments.iter().all(|s| s.bg == background));
}

// Clearing the selection redraws the rows that were selected.
#[test]
fn clearing_the_selection_redraws_its_rows() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"foo\r\ndue\r\ntre\r\nquattro");
    emulator.start_selection(1, 0, SelectionSide::Left, SelectionKind::Line);
    emulator.frame();

    emulator.clear_selection();

    let frame = emulator.frame().unwrap();
    let rows: Vec<u16> = frame.lines.iter().map(|l| l.row).collect();
    assert_eq!(rows, vec![1, 3]);
}

// A selection that scrolled into the history yields no off-screen rows.
#[test]
fn selection_rows_are_clipped_to_the_screen() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"foo\r\ndue\r\ntre");
    emulator.start_selection(0, 0, SelectionSide::Left, SelectionKind::Simple);
    emulator.update_selection(1, 2, SelectionSide::Right);
    emulator.frame();

    // five more rows push the first two into the history
    emulator.feed(b"\r\n4\r\n5\r\n6\r\n7\r\n8");

    let frame = emulator.frame().unwrap();
    assert!(frame.lines.iter().all(|l| l.row < 5));
}

// The frame carries the theme background; a program can change it with OSC 11.
#[test]
fn frame_carries_the_background_color() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    assert_eq!(
        emulator.frame().unwrap().background,
        Theme::default().background
    );

    emulator.feed(b"\x1b]11;#102030\x07");
    assert_eq!(emulator.frame().unwrap().background, 0x102030);
}

// OSC 0 sets the window title.
#[test]
fn title_changes_become_events() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"\x1b]0;ciao\x07");

    assert_eq!(
        emulator.take_events(),
        vec![EmulatorEvent::Title("ciao".into())]
    );
}

#[test]
fn bell_becomes_an_event() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"\x07");

    assert_eq!(emulator.take_events(), vec![EmulatorEvent::Bell]);
}

// Device Attributes is a query: the answer must go back to the PTY.
#[test]
fn device_attributes_query_is_answered() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"\x1b[c");

    assert_eq!(
        emulator.take_events(),
        vec![EmulatorEvent::Write(b"\x1b[?6c".to_vec())]
    );
}

// OSC 11 asks for the background: the reply carries the theme color.
#[test]
fn background_color_query_is_answered_with_the_theme() {
    let mut emulator = Emulator::new(20, 5, Theme::dark(), 100);
    emulator.feed(b"\x1b]11;?\x07");

    assert_eq!(
        emulator.take_events(),
        vec![EmulatorEvent::Write(
            b"\x1b]11;rgb:1616/1616/1a1a\x07".to_vec()
        )]
    );
}

// Events are handed over once; plain output produces none.
#[test]
fn events_are_drained_once() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"\x07");

    assert_eq!(emulator.take_events().len(), 1);
    assert!(emulator.take_events().is_empty());

    emulator.feed(b"hello");
    assert!(emulator.take_events().is_empty());
}

fn located(path: &str) -> Vec<EmulatorEvent> {
    vec![EmulatorEvent::Location(Location {
        host: "mac".into(),
        path: path.into(),
    })]
}

// OSC 7 is how a shell says where it is.
#[test]
fn working_directory_becomes_an_event() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"\x1b]7;file://mac/Users/me\x07");

    assert_eq!(emulator.take_events(), located("/Users/me"));
}

// An OSC ends with BEL or with `ESC \`.
#[test]
fn working_directory_can_end_with_st() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"\x1b]7;file://mac/tmp\x1b\\");

    assert_eq!(emulator.take_events(), located("/tmp"));
}

// A read from the PTY can stop in the middle of a sequence.
#[test]
fn working_directory_split_across_reads() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"\x1b]7;file://mac/Us");
    assert!(emulator.take_events().is_empty());

    emulator.feed(b"ers/me\x07");
    assert_eq!(emulator.take_events(), located("/Users/me"));
}

// The parser splits an OSC at every `;`: one in the path must come back.
#[test]
fn working_directory_keeps_its_semicolons() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"\x1b]7;file://mac/tmp/a;b;c\x07");

    assert_eq!(emulator.take_events(), located("/tmp/a;b;c"));
}

#[test]
fn working_directory_that_is_not_a_file_uri_is_ignored() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"\x1b]7;/Users/me\x07");
    emulator.feed(b"\x1b]7\x07");
    emulator.feed(b"\x1b]7;file://mac/tmp/\xff\x07");

    assert!(emulator.take_events().is_empty());
}

// The second parser reads the same bytes: it must not answer for the first.
#[test]
fn other_sequences_are_not_working_directories() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"\x1b]0;file://mac/tmp\x07");

    assert_eq!(
        emulator.take_events(),
        vec![EmulatorEvent::Title("file://mac/tmp".into())]
    );
}

// The folder is announced before the prompt that follows it.
#[test]
fn working_directory_and_title_arrive_together() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"\x1b]7;file://mac/tmp\x07\x1b]0;zsh\x07");

    let events = emulator.take_events();
    assert_eq!(events.len(), 2);
    assert!(events.contains(&EmulatorEvent::Title("zsh".into())));
    assert!(events.contains(&located("/tmp")[0]));
}

fn marked(nonce: Option<&str>, bytes: &[u8]) -> Vec<EmulatorEvent> {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.set_nonce(nonce.map(String::from));
    emulator.feed(bytes);
    emulator.take_events()
}

fn mark(mark: Mark) -> Vec<EmulatorEvent> {
    vec![EmulatorEvent::Mark(mark)]
}

// OSC 133 marks the prompt and the end of a command, with its status.
#[test]
fn prompts_and_ends_become_marks() {
    assert_eq!(marked(None, b"\x1b]133;A\x07"), mark(Mark::Prompt));
    assert_eq!(
        marked(None, b"\x1b]133;D;127\x07"),
        mark(Mark::End(Some(127)))
    );
    assert_eq!(marked(None, b"\x1b]133;D\x07"), mark(Mark::End(None)));
    // The end of the prompt only places the command line: see `blocks`.
    assert!(marked(None, b"\x1b]133;B\x07").is_empty());
}

// The text of a command counts only with the nonce of the session.
#[test]
fn the_text_of_a_command_needs_the_nonce() {
    let start = b"\x1b]133;C;cmdline_url=npm%20run%20dev%3B%20caff%C3%A8;nonce=s3cret\x07";
    assert_eq!(
        marked(Some("s3cret"), start),
        mark(Mark::Start(Some("npm run dev; caffè".into())))
    );
    assert_eq!(marked(Some("other"), start), mark(Mark::Start(None)));
    assert_eq!(marked(None, start), mark(Mark::Start(None)));
    assert_eq!(
        marked(Some("s3cret"), b"\x1b]133;C;cmdline_url=ls\x07"),
        mark(Mark::Start(None))
    );
    // An empty nonce is no nonce.
    assert_eq!(
        marked(Some(""), b"\x1b]133;C;cmdline_url=ls;nonce=\x07"),
        mark(Mark::Start(None))
    );
    assert_eq!(
        marked(Some("s3cret"), b"\x1b]133;C\x07"),
        mark(Mark::Start(None))
    );
}

// VS Code's 633 marks the same way, and sends the text on its own.
#[test]
fn vscode_marks_are_understood() {
    assert_eq!(marked(None, b"\x1b]633;A\x07"), mark(Mark::Prompt));
    assert_eq!(
        marked(Some("n"), b"\x1b]633;E;echo a\\x3bb \\\\ c;n\x07"),
        mark(Mark::Text("echo a;b \\ c".into()))
    );
    assert!(marked(Some("n"), b"\x1b]633;E;echo;wrong\x07").is_empty());
    // `E` is VS Code's only.
    assert!(marked(Some("n"), b"\x1b]133;E;echo;n\x07").is_empty());
}

// Long command lines arrive whole.
#[test]
fn long_command_lines_arrive_whole() {
    let text = "x".repeat(5000);
    let start = format!("\x1b]133;C;cmdline_url={text};nonce=n\x07");
    assert_eq!(
        marked(Some("n"), start.as_bytes()),
        mark(Mark::Start(Some(text)))
    );
}

// A prompt, `cmd` typed after it, its output, its end with `status`.
fn block(cmd: &str, output: &str, status: i32) -> String {
    format!("\x1b]133;A\x07$ \x1b]133;B\x07{cmd}\r\n\x1b]133;C\x07{output}\x1b]133;D;{status}\x07")
}

const PROMPT: &str = "\x1b]133;A\x07$ \x1b]133;B\x07";

fn prompts(emulator: &mut Emulator) -> Vec<(u16, BlockState)> {
    emulator
        .prompts_on_screen()
        .iter()
        .map(|p| (p.row, p.state))
        .collect()
}

// Each prompt on screen, with how its command ended; the one waiting too.
#[test]
fn prompts_on_screen_know_how_their_command_went() {
    let mut emulator = Emulator::new(20, 8, Theme::default(), 100);
    let bytes = block("ls", "a\r\n", 0) + &block("false", "", 1) + PROMPT;
    emulator.feed(bytes.as_bytes());
    assert_eq!(
        prompts(&mut emulator),
        vec![
            (0, BlockState::Ended(Some(0))),
            (2, BlockState::Ended(Some(1))),
            (3, BlockState::Waiting),
        ]
    );
}

#[test]
fn a_command_without_its_end_is_running() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(format!("{PROMPT}sleep 9\r\n\x1b]133;C\x07").as_bytes());
    assert_eq!(prompts(&mut emulator), vec![(0, BlockState::Running)]);
}

// The bytes of a mark can arrive in two reads.
#[test]
fn a_mark_cut_in_two_is_placed() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"out\r\n\x1b]13");
    emulator.feed(b"3;A\x07$ ");
    assert_eq!(prompts(&mut emulator), vec![(1, BlockState::Waiting)]);
}

// A prompt of two lines starts once.
#[test]
fn a_prompt_of_two_lines_starts_on_the_first() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"\x1b]133;A\x07~/code main\r\n$ \x1b]133;B\x07");
    assert_eq!(prompts(&mut emulator), vec![(0, BlockState::Waiting)]);
}

// Without the integration nothing is marked.
#[test]
fn plain_output_has_no_prompts() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(b"$ ls\r\na\r\n");
    assert!(prompts(&mut emulator).is_empty());
}

// The marks go with the lines into the history, and back.
#[test]
fn marks_scroll_into_the_history() {
    let mut emulator = Emulator::new(20, 3, Theme::default(), 100);
    let bytes = block("seq", "1\r\n2\r\n3\r\n4\r\n", 0) + PROMPT;
    emulator.feed(bytes.as_bytes());
    // On screen: 3, 4 and the prompt waiting.
    assert_eq!(prompts(&mut emulator), vec![(2, BlockState::Waiting)]);
    emulator.scroll(4);
    assert_eq!(
        prompts(&mut emulator),
        vec![(0, BlockState::Ended(Some(0)))]
    );
}

// Narrower, the lines reflow: the prompts are still where their text is.
#[test]
fn marks_follow_the_text_when_lines_reflow() {
    let mut emulator = Emulator::new(20, 6, Theme::default(), 100);
    let bytes = block("echo", "abcdefghijklmnop\r\n", 0) + PROMPT;
    emulator.feed(bytes.as_bytes());
    emulator.resize(8, 6);
    // The output takes two lines now, and the first prompt went into the
    // history to keep the cursor where it was.
    assert_eq!(prompts(&mut emulator), vec![(2, BlockState::Waiting)]);
    emulator.scroll(1);
    assert_eq!(
        prompts(&mut emulator),
        vec![(0, BlockState::Ended(Some(0))), (3, BlockState::Waiting)]
    );
}

// Written over, a prompt is gone.
#[test]
fn a_prompt_written_over_is_gone() {
    let mut emulator = Emulator::new(20, 5, Theme::default(), 100);
    emulator.feed(format!("{PROMPT}\x1b[H\x1b[2J").as_bytes());
    assert!(prompts(&mut emulator).is_empty());
}

// Links of a program in its output are not marks.
#[test]
fn links_in_the_output_are_not_marks() {
    let mut emulator = Emulator::new(30, 5, Theme::default(), 100);
    let output = "\x1b]8;;file:///a\x07a\x1b]8;;\x07\r\n";
    let bytes = block("ls", output, 0) + PROMPT;
    emulator.feed(bytes.as_bytes());
    assert_eq!(emulator.last_output().as_deref(), Some("a"));
    assert_eq!(prompts(&mut emulator).len(), 2);
}

#[test]
fn the_output_of_the_last_command() {
    let mut emulator = Emulator::new(20, 8, Theme::default(), 100);
    let bytes = block("ls", "x\r\n", 0) + &block("seq 2", "1\r\n2\r\n\r\n", 0) + PROMPT;
    emulator.feed(bytes.as_bytes());
    // The empty line at its end is left out.
    assert_eq!(emulator.last_output().as_deref(), Some("1\n2"));
}

#[test]
fn the_output_of_a_command_still_running() {
    let mut emulator = Emulator::new(20, 8, Theme::default(), 100);
    emulator.feed(format!("{PROMPT}tail\r\n\x1b]133;C\x07one\r\ntwo").as_bytes());
    assert_eq!(emulator.last_output().as_deref(), Some("one\ntwo"));
}

#[test]
fn no_output_without_a_command() {
    let mut emulator = Emulator::new(20, 8, Theme::default(), 100);
    emulator.feed(PROMPT.as_bytes());
    assert_eq!(emulator.last_output(), None);
    emulator.feed(format!("true\r\n\x1b]133;C\x07\x1b]133;D;0\x07{PROMPT}").as_bytes());
    assert_eq!(emulator.last_output(), None);
}

#[test]
fn selecting_the_last_output() {
    let mut emulator = Emulator::new(20, 8, Theme::default(), 100);
    let bytes = block("seq 2", "1\r\n2\r\n", 0) + PROMPT;
    emulator.feed(bytes.as_bytes());
    assert!(emulator.select_last_output());
    assert_eq!(emulator.selection_text().as_deref(), Some("1\n2\n"));
}

// Up, each prompt comes to the top of the view; down, back to the bottom.
#[test]
fn jumping_from_prompt_to_prompt() {
    let mut emulator = Emulator::new(20, 3, Theme::default(), 100);
    let bytes = block("a", "1\r\n2\r\n", 0) + &block("b", "3\r\n4\r\n", 0) + PROMPT;
    emulator.feed(bytes.as_bytes());
    // Lines: $ a, 1, 2, $ b, 3, 4, $ — the last three on screen.
    assert!(emulator.jump_to_prompt(true));
    assert_eq!(emulator.line_text(0), "$ b");
    assert!(emulator.jump_to_prompt(true));
    assert_eq!(emulator.line_text(0), "$ a");
    // None above the first.
    assert!(!emulator.jump_to_prompt(true));
    assert!(emulator.jump_to_prompt(false));
    assert_eq!(emulator.line_text(0), "$ b");
    // The last prompt cannot be on top: the view goes to the bottom.
    assert!(emulator.jump_to_prompt(false));
    assert_eq!(emulator.display_offset(), 0);
    assert!(!emulator.jump_to_prompt(false));
}
