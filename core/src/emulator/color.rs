//! Color resolution: from alacritty's `Color` to `0xRRGGBB`.

use alacritty_terminal::vte::ansi::{Color, Rgb};

use super::Emulator;

pub(super) fn rgb_to_u32(rgb: Rgb) -> u32 {
    (u32::from(rgb.r) << 16) | (u32::from(rgb.g) << 8) | u32::from(rgb.b)
}

impl Emulator {
    /// A terminal color as `0xRRGGBB`. Runtime overrides (OSC 4/10/11)
    /// take precedence over the theme.
    pub(super) fn resolve(&self, color: Color) -> u32 {
        let index = match color {
            Color::Spec(rgb) => return rgb_to_u32(rgb),
            Color::Indexed(i) => i as usize,
            Color::Named(named) => named as usize,
        };
        if let Some(rgb) = self.term.colors()[index] {
            return rgb_to_u32(rgb);
        }
        match index {
            0..=255 => self.theme.color(index as u8),
            256 | 267 => self.theme.foreground,
            257 => self.theme.background,
            258 => self.theme.cursor,
            259..=266 => Self::dim(self.theme.ansi[index - 259], self.theme.background),
            _ => Self::dim(self.theme.foreground, self.theme.background),
        }
    }

    /// Dims `color` by moving it a third of the way toward `background`,
    /// one channel at a time.
    pub(super) fn dim(color: u32, background: u32) -> u32 {
        let channel = |shift: u32| {
            let c = (color >> shift) & 0xff;
            let b = (background >> shift) & 0xff;
            ((c * 2 + b) / 3) << shift
        };
        channel(16) | channel(8) | channel(0)
    }
}
