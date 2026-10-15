//! The commands a shell runs, as its integration script announces them
//! (see `shell`): where a prompt starts, which command starts and how it
//! ends.
//!
//! The marks come out of the terminal output, where they can repeat: fish 4
//! marks prompts and commands by itself, and the script adds a second
//! start with the text. `Tracker` turns them into one start and one end for
//! each command.

/// What a shell marks with OSC 133 (or VS Code's OSC 633).
#[derive(Debug, Clone, PartialEq)]
pub enum Mark {
    /// A prompt starts: the shell waits for a command.
    Prompt,
    /// A command starts. The text is there only when the sequence carried
    /// the session's nonce: any program can print the rest.
    Start(Option<String>),
    /// The text of the command about to start, on its own (VS Code's
    /// `633;E`, sent before the start). With the nonce, as for `Start`.
    Text(String),
    /// The command ended, with its exit status if the shell said it.
    End(Option<i32>),
}

/// What changed for the session, after a mark.
#[derive(Debug, Clone, PartialEq)]
pub enum Change {
    Prompt,
    /// A command started, or its text arrived after it did. `None`: the
    /// shell did not say it, or the command starts with a space, which by
    /// convention keeps it out of every history.
    Started(Option<String>),
    Ended(Option<i32>),
}

#[derive(Debug, Default)]
pub struct Tracker {
    running: bool,
    /// Text of the running command, once known.
    text: Option<String>,
    /// Text that came before its command started.
    pending: Option<String>,
}

impl Tracker {
    pub fn mark(&mut self, mark: Mark) -> Vec<Change> {
        match mark {
            Mark::Prompt => {
                let mut changes = Vec::new();
                // A command ended without saying so.
                if self.running {
                    changes.extend(self.end(None));
                }
                self.pending = None;
                changes.push(Change::Prompt);
                changes
            }
            Mark::Start(text) => {
                let text = text.or_else(|| self.pending.take()).and_then(keepable);
                if !self.running {
                    self.running = true;
                    self.text = text.clone();
                    return vec![Change::Started(text)];
                }
                self.learn(text)
            }
            Mark::Text(text) => {
                if self.running {
                    self.learn(keepable(text))
                } else {
                    self.pending = Some(text);
                    Vec::new()
                }
            }
            Mark::End(status) => self.end(status),
        }
    }

    // A second start of the running command, which may know its text.
    fn learn(&mut self, text: Option<String>) -> Vec<Change> {
        if self.text.is_some() || text.is_none() {
            return Vec::new();
        }
        self.text = text.clone();
        vec![Change::Started(text)]
    }

    fn end(&mut self, status: Option<i32>) -> Vec<Change> {
        if !self.running {
            return Vec::new();
        }
        self.running = false;
        self.text = None;
        vec![Change::Ended(status)]
    }
}

/// The text worth keeping: not empty, and not starting with a space.
fn keepable(text: String) -> Option<String> {
    (!text.trim().is_empty() && !text.starts_with(' ')).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn started(text: &str) -> Vec<Change> {
        vec![Change::Started(Some(text.into()))]
    }

    #[test]
    fn a_command_starts_and_ends() {
        let mut tracker = Tracker::default();
        assert_eq!(tracker.mark(Mark::Start(Some("ls".into()))), started("ls"));
        assert_eq!(
            tracker.mark(Mark::End(Some(0))),
            vec![Change::Ended(Some(0))]
        );
        assert_eq!(tracker.mark(Mark::Prompt), vec![Change::Prompt]);
    }

    // fish 4 marks the start itself, the script adds one with the text:
    // in either order, one command.
    #[test]
    fn a_second_start_only_adds_the_text() {
        let mut tracker = Tracker::default();
        assert_eq!(tracker.mark(Mark::Start(None)), vec![Change::Started(None)]);
        assert_eq!(
            tracker.mark(Mark::Start(Some("make".into()))),
            started("make")
        );
        assert!(tracker.mark(Mark::Start(None)).is_empty());

        let mut tracker = Tracker::default();
        tracker.mark(Mark::Start(Some("make".into())));
        assert!(tracker.mark(Mark::Start(None)).is_empty());
        assert!(tracker.mark(Mark::Start(Some("other".into()))).is_empty());
    }

    #[test]
    fn a_second_end_is_ignored() {
        let mut tracker = Tracker::default();
        tracker.mark(Mark::Start(None));
        assert_eq!(tracker.mark(Mark::End(Some(1))).len(), 1);
        assert!(tracker.mark(Mark::End(Some(1))).is_empty());
    }

    // A prompt while a command runs: it ended without a word.
    #[test]
    fn a_prompt_ends_the_command() {
        let mut tracker = Tracker::default();
        tracker.mark(Mark::Start(Some("vim".into())));
        assert_eq!(
            tracker.mark(Mark::Prompt),
            vec![Change::Ended(None), Change::Prompt]
        );
    }

    // VS Code sends the text first, then the start.
    #[test]
    fn text_before_the_start_belongs_to_it() {
        let mut tracker = Tracker::default();
        assert!(tracker.mark(Mark::Text("cargo test".into())).is_empty());
        assert_eq!(tracker.mark(Mark::Start(None)), started("cargo test"));
    }

    #[test]
    fn text_after_the_start_is_learned() {
        let mut tracker = Tracker::default();
        tracker.mark(Mark::Start(None));
        assert_eq!(
            tracker.mark(Mark::Text("cargo test".into())),
            started("cargo test")
        );
    }

    // Text left from a command that never started does not stick to the
    // next one.
    #[test]
    fn pending_text_ends_at_the_prompt() {
        let mut tracker = Tracker::default();
        tracker.mark(Mark::Text("lost".into()));
        tracker.mark(Mark::Prompt);
        assert_eq!(tracker.mark(Mark::Start(None)), vec![Change::Started(None)]);
    }

    #[test]
    fn commands_starting_with_a_space_are_not_kept() {
        let mut tracker = Tracker::default();
        assert_eq!(
            tracker.mark(Mark::Start(Some(" export TOKEN=x".into()))),
            vec![Change::Started(None)]
        );
        // Nor learned from a second start.
        assert!(tracker
            .mark(Mark::Start(Some(" export TOKEN=x".into())))
            .is_empty());
    }
}
