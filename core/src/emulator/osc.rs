use alacritty_terminal::vte::Perform;

use crate::cwd::{parse_osc7, Location};

#[derive(Default)]
pub(super) struct OscWatcher {
    locations: Vec<Location>,
}

impl OscWatcher {
    pub(super) fn take(&mut self) -> Vec<Location> {
        std::mem::take(&mut self.locations)
    }
}

impl Perform for OscWatcher {
    fn osc_dispatch(&mut self, params: &[&[u8]], _bell_terminated: bool) {
        if params.first() != Some(&&b"7"[..]) {
            return;
        }

        // The parser splits at every `;`: one in the path comes back here.
        let uri = params[1..].join(&b';');
        let Ok(uri) = std::str::from_utf8(&uri) else {
            return;
        };

        if let Some(location) = parse_osc7(uri) {
            self.locations.push(location);
        }
    }
}
