//! `--tui`: a live view of the run on the terminal.
//!
//! The view draws on standard error, so the JSON lines on standard output can still be redirected
//! to a file; when standard output is the terminal too, the lines are not written. It runs on a
//! thread of its own and receives every event the writer writes, then the summary. Its keys reach
//! the run through [`Controls`]: `q` stops the run as Ctrl-C does, and `p` holds new claims back
//! until pressed again. Once the run has ended the view stays up until `q`.

mod draw;
mod view;

use std::io::{self, Stderr};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;
use ratatui::crossterm::event::{self, KeyCode, KeyEventKind, KeyModifiers};
use ratatui::crossterm::{execute, terminal};
use tokio::sync::{mpsc, oneshot, watch};

use crate::events::{EVENT_QUEUE, Event};
use view::{Action, Key, View};

/// How often the view redraws without input, so its clock and waits move.
const TICK: Duration = Duration::from_millis(100);

/// What the view sends the run.
pub struct Controls {
    /// Resolves when the operator asks the run to stop, or the view is gone.
    pub stop: oneshot::Receiver<()>,
    /// `true` while the operator holds new claims back.
    pub paused: watch::Receiver<bool>,
}

/// The running view. Dropped without [`Tui::finish`], as when the run fails, it closes at once
/// and gives the terminal back.
pub struct Tui {
    events: Option<mpsc::Sender<Event>>,
    thread: Option<JoinHandle<io::Result<()>>>,
    close: Arc<AtomicBool>,
}

impl Tui {
    /// Takes over the terminal and starts the view of a run that started at `started`.
    ///
    /// # Errors
    ///
    /// When standard error is not a terminal, or the terminal cannot be set up.
    pub fn start(started: Instant) -> io::Result<(Self, Controls)> {
        use std::io::IsTerminal as _;
        if !io::stderr().is_terminal() {
            return Err(io::Error::other(
                "--tui needs standard error to be a terminal",
            ));
        }
        let screen = Screen::enter()?;
        let (events, received) = mpsc::channel(EVENT_QUEUE);
        let (stop, stop_received) = oneshot::channel();
        let (pause, paused) = watch::channel(false);
        let close = Arc::new(AtomicBool::new(false));
        let closed = Arc::clone(&close);
        let thread = std::thread::Builder::new()
            .name("railhead-swarm-tui".to_owned())
            .spawn(move || run(screen, started, received, stop, &pause, &closed))?;
        Ok((
            Self {
                events: Some(events),
                thread: Some(thread),
                close,
            },
            Controls {
                stop: stop_received,
                paused,
            },
        ))
    }

    /// Shows `event`. Waits while the view is behind; a view that has closed drops it.
    pub async fn show(&self, event: &Event) {
        if let Some(events) = &self.events {
            // A closed view already stopped the run through `Controls::stop`.
            let _ = events.send(event.clone()).await;
        }
    }

    /// Waits for the operator to close the view, then gives the terminal back.
    ///
    /// # Errors
    ///
    /// When drawing or reading the terminal failed.
    pub fn finish(mut self) -> io::Result<()> {
        self.events = None;
        self.thread.take().map_or(Ok(()), |thread| {
            thread
                .join()
                .map_err(|_| io::Error::other("the terminal view stopped unexpectedly"))?
        })
    }
}

impl Drop for Tui {
    fn drop(&mut self) {
        self.close.store(true, Ordering::SeqCst);
        self.events = None;
        if let Some(thread) = self.thread.take() {
            // The run is already failing; its own error is the one to report.
            let _ = thread.join();
        }
    }
}

/// The terminal in raw mode on the alternate screen, given back when dropped.
struct Screen(Terminal<CrosstermBackend<Stderr>>);

impl Screen {
    fn enter() -> io::Result<Self> {
        terminal::enable_raw_mode()?;
        let mut stderr = io::stderr();
        if let Err(error) = execute!(stderr, terminal::EnterAlternateScreen) {
            let _ = terminal::disable_raw_mode();
            return Err(error);
        }
        let terminal = match Terminal::new(CrosstermBackend::new(stderr)) {
            Ok(terminal) => terminal,
            Err(error) => {
                let _ = execute!(io::stderr(), terminal::LeaveAlternateScreen);
                let _ = terminal::disable_raw_mode();
                return Err(error);
            }
        };
        // From here on, dropping the screen restores the terminal.
        let mut screen = Self(terminal);
        screen.0.hide_cursor()?;
        Ok(screen)
    }
}

impl Drop for Screen {
    fn drop(&mut self) {
        // Every step is tried, so one failure leaves no more of the terminal broken than it must.
        let _ = execute!(self.0.backend_mut(), terminal::LeaveAlternateScreen);
        let _ = self.0.show_cursor();
        let _ = terminal::disable_raw_mode();
    }
}

/// The key `code` with `modifiers` stands for.
fn key(code: KeyCode, modifiers: KeyModifiers) -> Option<Key> {
    match code {
        KeyCode::Char('q' | 'Q') => Some(Key::Quit),
        // Raw mode turns Ctrl-C into a key press instead of an interrupt.
        KeyCode::Char('c') if modifiers.contains(KeyModifiers::CONTROL) => Some(Key::Quit),
        KeyCode::Char('p' | 'P') => Some(Key::Pause),
        KeyCode::Up | KeyCode::Char('k') => Some(Key::Up),
        KeyCode::Down | KeyCode::Char('j') => Some(Key::Down),
        KeyCode::Enter => Some(Key::Enter),
        KeyCode::Esc => Some(Key::Escape),
        _ => None,
    }
}

/// The view's loop: draws, folds in events, handles keys, until the operator closes an ended
/// run or the run they stopped has ended.
fn run(
    mut screen: Screen,
    started: Instant,
    mut received: mpsc::Receiver<Event>,
    stop: oneshot::Sender<()>,
    pause: &watch::Sender<bool>,
    close: &AtomicBool,
) -> io::Result<()> {
    let mut view = View::new();
    let mut stop = Some(stop);
    let mut ended = false;
    while !close.load(Ordering::SeqCst) {
        view.tick(started.elapsed());
        screen.0.draw(|frame| draw::draw(frame, &view))?;
        if event::poll(TICK)? {
            // A resize needs nothing more than the next draw, which fits the new size.
            if let event::Event::Key(press) = event::read()?
                && press.kind == KeyEventKind::Press
                && let Some(key) = key(press.code, press.modifiers)
            {
                match view.key(key) {
                    Action::None => {}
                    Action::Pause(paused) => {
                        pause.send_replace(paused);
                    }
                    Action::Stop => {
                        if let Some(stop) = stop.take() {
                            let _ = stop.send(());
                        }
                    }
                    Action::Exit => return Ok(()),
                }
            }
        }
        loop {
            match received.try_recv() {
                Ok(event) => view.apply(&event, started.elapsed()),
                Err(mpsc::error::TryRecvError::Empty) => break,
                Err(mpsc::error::TryRecvError::Disconnected) => {
                    ended = true;
                    break;
                }
            }
        }
        // The operator stopped the run and it has finished stopping: nothing is left to watch.
        if ended && stop.is_none() {
            break;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_map_to_the_views_actions() {
        let none = KeyModifiers::NONE;
        assert_eq!(key(KeyCode::Char('q'), none), Some(Key::Quit));
        assert_eq!(
            key(KeyCode::Char('c'), KeyModifiers::CONTROL),
            Some(Key::Quit)
        );
        assert_eq!(key(KeyCode::Char('p'), none), Some(Key::Pause));
        assert_eq!(key(KeyCode::Up, none), Some(Key::Up));
        assert_eq!(key(KeyCode::Down, none), Some(Key::Down));
        assert_eq!(key(KeyCode::Enter, none), Some(Key::Enter));
        assert_eq!(key(KeyCode::Esc, none), Some(Key::Escape));
        // A plain `c`, or any other key, does nothing.
        assert_eq!(key(KeyCode::Char('c'), none), None);
        assert_eq!(key(KeyCode::Char('x'), none), None);
        assert_eq!(key(KeyCode::Tab, none), None);
    }
}
