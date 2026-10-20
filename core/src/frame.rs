use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Frame {
    pub cols: u16,
    pub rows: u16,
    pub full: bool,
    /// Background of empty cells, already resolved (theme or program override).
    pub background: u32,
    pub lines: Vec<LineUpdate>,
    pub cursor: Option<Cursor>,
    pub offset: u32,
    pub history: u32,
    pub mouse: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LineUpdate {
    pub row: u16,
    pub segments: Vec<Segment>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Segment {
    pub text: String,
    pub cols: u16,
    pub fg: u32,
    pub bg: u32,
    pub flags: u8,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Cursor {
    pub row: u16,
    pub col: u16,
    pub shape: CursorShape,
    pub color: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CursorShape {
    Block,
    Underline,
    Beam,
    Hollow,
}

/// Attributes of a `Segment`, as bits of `Segment::flags`.
///
/// Attributes combine, so this is not an enum: each constant takes a
/// different bit and a set of attributes is a single `u8`.
///
/// ```text
/// BOLD              = 0000_0001
/// UNDERLINE         = 0000_0100
/// BOLD | UNDERLINE  = 0000_0101   // bold and underlined at once
///
/// flags & SegmentFlags::BOLD != 0 // "is it bold?"
/// ```
pub struct SegmentFlags;
impl SegmentFlags {
    pub const BOLD: u8 = 1;
    pub const ITALIC: u8 = 1 << 1;
    pub const UNDERLINE: u8 = 1 << 2;
    pub const STRIKE: u8 = 1 << 3;
    pub const WIDE: u8 = 1 << 4;
    /// The text is one cell: a character with the marks that combine with it.
    pub const CLUSTER: u8 = 1 << 5;
}
