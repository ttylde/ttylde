use std::{
    mem::take,
    sync::{Arc, Mutex},
};

use alacritty_terminal::event::{Event, EventListener};

#[derive(Clone, Default)]
pub(super) struct InternalEventListener(Arc<Mutex<Vec<Event>>>);

impl InternalEventListener {
    pub(super) fn take(&self) -> Vec<Event> {
        take(&mut *self.0.lock().unwrap())
    }
}

impl EventListener for InternalEventListener {
    fn send_event(&self, event: Event) {
        self.0.lock().unwrap().push(event);
    }
}
