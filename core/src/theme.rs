#[derive(Debug, Clone, PartialEq)]
pub struct Theme {
    pub foreground: u32,
    pub background: u32,
    pub cursor: u32,
    pub selection: u32,
    pub ansi: [u32; 16],
}

impl Theme {
    pub fn color(&self, index: u8) -> u32 {
        let index_u32: u32 = u32::from(index);
        match index {
            0..=15 => self.ansi[index as usize],
            // 6×6×6 cube: each component goes from 0 to 5.
            16..=231 => {
                let i = index_u32 - 16;
                let level = |v: u32| if v == 0 { 0 } else { 55 + 40 * v };
                (level(i / 36) << 16) | (level(i / 6 % 6) << 8) | level(i % 6)
            }
            // 24-step grayscale, from 0x08 to 0xee.
            232..=255 => {
                let v = 8 + 10 * (index_u32 - 232);
                (v << 16) | (v << 8) | v
            }
        }
    }
}

impl Theme {
    /// Dark text on white: the colors of the interface around the terminal.
    pub fn light() -> Self {
        Theme {
            foreground: 0x15211c,
            background: 0xffffff,
            cursor: 0x2466ff,
            selection: 0xcfddff,
            ansi: [
                // normal: black, red, green, yellow, blue, magenta, cyan, white
                0x15211c, 0xd04a42, 0x1f9a6a, 0x8a7d12, 0x1f52d6, 0x7c5cf0, 0x0f8a9d, 0x5f6f68,
                // bright, same order: on white the bright ones are the darker
                0x74827c, 0xb9382f, 0x157a53, 0x6e630c, 0x123dba, 0x5b3fd0, 0x0b6f80, 0x93a19b,
            ],
        }
    }

    /// Light text on near black.
    pub fn dark() -> Self {
        Theme {
            foreground: 0xd8d8d2,
            background: 0x16161a,
            cursor: 0xe8e8e2,
            selection: 0x3a3f58,
            ansi: [
                // normal: black, red, green, yellow, blue, magenta, cyan, white
                0x26262c, 0xe0606e, 0x8cc67a, 0xe2c26c, 0x6ea0e8, 0xc084e0, 0x62c2c8, 0xc8c8c2,
                // bright, same order
                0x5c5c66, 0xf08894, 0xa8dc98, 0xf0d890, 0x92bcf4, 0xd4a6ee, 0x8cdce0, 0xf4f4f0,
            ],
        }
    }
}

impl Default for Theme {
    fn default() -> Self {
        Theme::light()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The first 16 indices are the theme's ANSI palette.
    #[test]
    fn ansi_indices_come_from_the_palette() {
        let theme = Theme::default();
        assert_eq!(theme.color(0), theme.ansi[0]);
        assert_eq!(theme.color(15), theme.ansi[15]);
    }

    // The 6×6×6 cube starts at black (16), ends at white (231),
    // and a single channel is 55 + 40·v, as in xterm.
    #[test]
    fn cube_follows_xterm_levels() {
        let theme = Theme::default();
        assert_eq!(theme.color(16), 0x000000);
        assert_eq!(theme.color(231), 0xffffff);
        assert_eq!(theme.color(196), 0xff0000); // 16 + 5·36
        assert_eq!(theme.color(46), 0x00ff00); // 16 + 5·6
        assert_eq!(theme.color(21), 0x0000ff); // 16 + 5
        assert_eq!(theme.color(17), 0x00005f); // blue at level 1
    }

    // Grays go from 0x08 to 0xee in steps of 10.
    #[test]
    fn grayscale_ramp() {
        let theme = Theme::default();
        assert_eq!(theme.color(232), 0x080808);
        assert_eq!(theme.color(233), 0x121212);
        assert_eq!(theme.color(255), 0xeeeeee);
    }
}
