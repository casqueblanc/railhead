//! Draws a [`View`] onto one frame.
//!
//! At 120 columns and more the agent lanes sit beside the train and conflict panels; from 80 to
//! 119 columns the panels go below the lanes and the lanes drop the claim column. A terminal
//! smaller than [`MIN_WIDTH`]×[`MIN_HEIGHT`] gets a notice instead, and the run goes on.

use ratatui::Frame;
use ratatui::layout::{Alignment, Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Cell, Clear, Paragraph, Row, Table, TableState, Wrap};

use super::view::{
    Lane, Overlap, Phase, Pin, Stage, View, batch_label, class_label, leave_label, seconds,
};
use crate::events::{StopReason, TrainState};

/// The narrowest terminal the view lays out.
pub const MIN_WIDTH: u16 = 80;

/// The shortest terminal the view lays out.
pub const MIN_HEIGHT: u16 = 16;

/// From this width on, the panels sit beside the lanes.
const WIDE: u16 = 120;

const DIM: Style = Style::new().fg(Color::DarkGray);
const BOLD: Style = Style::new().add_modifier(Modifier::BOLD);

/// Draws the whole view.
pub fn draw(frame: &mut Frame, view: &View) {
    let area = frame.area();
    if area.width < MIN_WIDTH || area.height < MIN_HEIGHT {
        too_small(frame, area);
        return;
    }
    let [header, body, footer] = Layout::vertical([
        Constraint::Length(4),
        Constraint::Fill(1),
        Constraint::Length(1),
    ])
    .areas(area);
    draw_header(frame, header, view);
    let (lanes, train, conflicts) = if area.width >= WIDE {
        let [lanes, side] =
            Layout::horizontal([Constraint::Percentage(55), Constraint::Fill(1)]).areas(body);
        let [train, conflicts] =
            Layout::vertical([Constraint::Percentage(50), Constraint::Fill(1)]).areas(side);
        (lanes, train, conflicts)
    } else {
        let [lanes, panels] =
            Layout::vertical([Constraint::Fill(1), Constraint::Length(8)]).areas(body);
        let [train, conflicts] =
            Layout::horizontal([Constraint::Percentage(50), Constraint::Fill(1)]).areas(panels);
        (lanes, train, conflicts)
    };
    if view.detail {
        draw_detail(frame, lanes, view);
    } else {
        draw_lanes(frame, lanes, view, area.width >= WIDE + 10);
    }
    draw_train(frame, train, view);
    draw_conflicts(frame, conflicts, view);
    draw_footer(frame, footer, view);
}

fn too_small(frame: &mut Frame, area: Rect) {
    let text = vec![
        Line::styled("railhead-swarm · simulated run", BOLD),
        Line::raw(format!(
            "The view needs {MIN_WIDTH}×{MIN_HEIGHT}; this terminal is {}×{}.",
            area.width, area.height
        )),
        Line::raw("The run goes on. q stops it."),
    ];
    let [middle] = Layout::vertical([Constraint::Length(3)])
        .flex(ratatui::layout::Flex::Center)
        .areas(area);
    frame.render_widget(
        Paragraph::new(text)
            .alignment(Alignment::Center)
            .wrap(Wrap { trim: true }),
        middle,
    );
}

/// A rate in tenths per minute, as text.
fn rate(tenths: u64) -> String {
    format!("{}.{}/min", tenths / 10, tenths % 10)
}

fn latency(ms: Option<u64>) -> String {
    ms.map_or_else(|| "-".to_owned(), seconds)
}

/// `mm:ss` from a duration.
fn clock(at: std::time::Duration) -> String {
    let secs = at.as_secs();
    format!("{:02}:{:02}", secs / 60, secs % 60)
}

fn stat(name: &str, value: String) -> [Span<'_>; 3] {
    [
        Span::styled(name, DIM),
        Span::styled(value, BOLD),
        Span::raw("  "),
    ]
}

fn draw_header(frame: &mut Frame, area: Rect, view: &View) {
    let tally = &view.tally;
    let latency_now = tally.latency();
    // What matters most comes first, so a narrow terminal cuts only the run's parameters.
    let (label, style) = phase(view.phase);
    let mut first = vec![
        Span::styled(
            " SIMULATED RUN ",
            Style::new()
                .fg(Color::Black)
                .bg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw(format!(" {}  ", clock(view.now))),
        Span::styled(label, style),
        Span::raw("  "),
    ];
    match &view.run {
        Some(run) => {
            first.push(Span::styled(run.repository.clone(), BOLD));
            first.push(Span::styled(
                format!(
                    " · {} agents × {} rounds · seed {}",
                    run.agents, run.rounds, run.seed
                ),
                DIM,
            ));
        }
        None => first.push(Span::styled("starting", DIM)),
    }
    let second: Vec<Span> = [
        stat(
            "pushes ",
            format!("{} ({})", tally.pushes, rate(view.pushes_per_minute())),
        ),
        stat(
            "landings ",
            format!("{} ({})", tally.landings, rate(view.landings_per_minute())),
        ),
        stat(
            "ready→landed p50 ",
            format!(
                "{} p95 {}",
                latency(latency_now.p50_ms),
                latency(latency_now.p95_ms)
            ),
        ),
    ]
    .into_iter()
    .flatten()
    .collect();
    let agents = view.run.as_ref().map_or(0, |run| run.agents);
    let third: Vec<Span> = [
        stat("auto-merged ", tally.auto_merged.to_string()),
        stat("routed ", tally.routed.to_string()),
        stat("redos ", tally.redos.to_string()),
        stat("unlanded ", tally.unlanded().to_string()),
        stat("stalls ", tally.stalls.to_string()),
        stat("failures ", tally.failures.to_string()),
        stat("done ", format!("{}/{agents}", tally.agents_done)),
    ]
    .into_iter()
    .flatten()
    .collect();
    let lines = vec![Line::from(first), Line::from(second), Line::from(third)];
    frame.render_widget(
        Paragraph::new(lines).block(Block::new().borders(ratatui::widgets::Borders::BOTTOM)),
        area,
    );
}

fn phase(phase: Phase) -> (String, Style) {
    match phase {
        Phase::Running => ("running".to_owned(), Style::new().fg(Color::Green)),
        Phase::Paused => (
            "PAUSED: no new claims".to_owned(),
            Style::new().fg(Color::Yellow).add_modifier(Modifier::BOLD),
        ),
        Phase::Stopping => (
            "stopping the agents…".to_owned(),
            Style::new().fg(Color::Red),
        ),
        Phase::Ended(reason) => {
            let reason = match reason {
                StopReason::Completed => "completed",
                StopReason::TimedOut => "timed out",
                StopReason::Interrupted => "stopped",
            };
            (format!("ended: {reason}"), BOLD)
        }
    }
}

const fn stage_style(stage: Stage) -> Style {
    match stage {
        Stage::Idle | Stage::Done => DIM,
        Stage::Claim | Stage::Edit | Stage::Push | Stage::Ready => Style::new().fg(Color::Cyan),
        Stage::Train => Style::new().fg(Color::LightBlue),
        Stage::Landed => Style::new().fg(Color::Green),
        Stage::Unverified | Stage::Redo => Style::new().fg(Color::Yellow),
        Stage::Closed(_) | Stage::Stopped => Style::new().fg(Color::Red),
    }
}

fn panel(title: &str) -> Block<'_> {
    Block::bordered().title(Span::styled(format!(" {title} "), BOLD))
}

fn draw_lanes(frame: &mut Frame, area: Rect, view: &View, with_claim: bool) {
    let block = panel("Agents");
    if view.lanes.is_empty() {
        frame.render_widget(
            Paragraph::new(Line::styled("No agent has reported yet.", DIM)).block(block),
            area,
        );
        return;
    }
    let rows = view.lanes.iter().map(|lane| {
        let mut cells = vec![
            Cell::from(lane.name.clone()),
            Cell::from(Span::styled(lane.stage.label(), stage_style(lane.stage))),
            Cell::from(lane.generation.map_or_else(String::new, |g| g.to_string())),
        ];
        if with_claim {
            cells.push(Cell::from(lane.claim_id.clone().unwrap_or_default()));
        }
        cells.push(Cell::from(lane.landings.to_string()));
        cells.push(Cell::from(
            lane.last()
                .map(|entry| entry.text.clone())
                .unwrap_or_default(),
        ));
        Row::new(cells)
    });
    let mut widths = vec![
        Constraint::Length(8),
        Constraint::Length(10),
        Constraint::Length(3),
    ];
    let mut header = vec!["agent", "step", "gen"];
    if with_claim {
        widths.push(Constraint::Length(14));
        header.push("claim");
    }
    widths.push(Constraint::Length(4));
    header.push("land");
    widths.push(Constraint::Fill(1));
    header.push("last event");
    let table = Table::new(rows, widths)
        .header(Row::new(header).style(DIM))
        .block(block)
        .row_highlight_style(Style::new().add_modifier(Modifier::REVERSED))
        .highlight_symbol("›")
        .highlight_spacing(ratatui::widgets::HighlightSpacing::Always);
    let mut state = TableState::new().with_selected(Some(view.selected));
    frame.render_stateful_widget(table, area, &mut state);
}

fn draw_detail(frame: &mut Frame, area: Rect, view: &View) {
    frame.render_widget(Clear, area);
    let Some(lane) = view.lanes.get(view.selected) else {
        return;
    };
    let block = panel(&lane.name).title_bottom(Line::styled(" enter or esc closes ", DIM));
    let inner = block.inner(area);
    let shown = usize::from(inner.height);
    let lines: Vec<Line> = lane
        .recent
        .iter()
        .skip(lane.recent.len().saturating_sub(shown))
        .map(|entry| {
            Line::from(vec![
                Span::styled(format!("{:>8} ", clock_ms(entry.at)), DIM),
                Span::raw(entry.text.clone()),
            ])
        })
        .collect();
    frame.render_widget(Paragraph::new(lines).block(block), area);
}

/// `+s.t` seconds since the run started.
fn clock_ms(at: std::time::Duration) -> String {
    let ms = u64::try_from(at.as_millis()).unwrap_or(u64::MAX);
    format!("+{}", seconds(ms))
}

fn draw_train(frame: &mut Frame, area: Rect, view: &View) {
    let block = panel("Train");
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let waiting = view.waiting().len();
    let mut lines = vec![Line::from(
        [
            stat("waiting ", waiting.to_string()),
            stat("landed ", view.tally.landings.to_string()),
            stat("unverified ", view.tally.unverified.to_string()),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>(),
    )];
    // Batches with their pins, then the other pins, then the latest landings in the rows left.
    let train = view.train_panel();
    for batch in &train.batches {
        let check = batch
            .check_run_id
            .map_or_else(|| "no check run".to_owned(), str::to_owned);
        lines.push(Line::from(vec![
            Span::styled(
                format!("batch {} ", batch.id),
                Style::new()
                    .fg(Color::LightBlue)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw(format!("{} ", batch_label(batch.state))),
            Span::styled(check, DIM),
        ]));
        for (lane, pin) in &batch.pins {
            lines.push(pin_line("  ", Color::LightBlue, lane, pin, view, None));
        }
    }
    for (lane, pin) in &train.others {
        let (label, color, detail) = match &pin.train {
            Some(TrainState::Queued { position }) => {
                (format!("queued #{position}"), Color::LightBlue, None)
            }
            Some(TrainState::Parked { reason }) => (
                "parked".to_owned(),
                Color::Yellow,
                Some(leave_label(*reason)),
            ),
            Some(TrainState::Dropped { reason }) => {
                ("dropped".to_owned(), Color::Red, Some(leave_label(*reason)))
            }
            Some(TrainState::Landed) => ("merged".to_owned(), Color::Green, None),
            Some(TrainState::Unreadable { code }) => {
                ("pinned".to_owned(), Color::LightBlue, Some(code.as_str()))
            }
            Some(TrainState::Batched { .. } | TrainState::Absent) | None => {
                ("pinned".to_owned(), Color::LightBlue, None)
            }
        };
        lines.push(pin_line(&label, color, lane, pin, view, detail));
    }
    let room = usize::from(inner.height);
    for landing in view
        .landed
        .iter()
        .rev()
        .take(room.saturating_sub(lines.len()))
    {
        let waited = landing
            .ready_to_landed_ms
            .map_or_else(|| "-".to_owned(), seconds);
        lines.push(Line::from(vec![
            Span::styled("landed  ", Style::new().fg(Color::Green)),
            Span::raw(format!("{} {waited:>6} ", landing.agent)),
            Span::styled(
                format!("{} {}", class_label(landing.class), landing.claim_id),
                DIM,
            ),
        ]));
    }
    frame.render_widget(Paragraph::new(lines), inner);
}

/// One waiting pin: its label, agent, how long it has waited, its claim and any detail.
fn pin_line<'a>(
    label: &str,
    color: Color,
    lane: &Lane,
    pin: &Pin,
    view: &View,
    detail: Option<&str>,
) -> Line<'a> {
    let waited = u64::try_from(view.now.saturating_sub(pin.since).as_millis()).unwrap_or(u64::MAX);
    let mut dim = pin.claim_id.clone();
    if let Some(detail) = detail {
        dim.push(' ');
        dim.push_str(detail);
    }
    Line::from(vec![
        Span::styled(format!("{label:<7} "), Style::new().fg(color)),
        Span::raw(format!("{} {:>6} ", lane.name, seconds(waited))),
        Span::styled(dim, DIM),
    ])
}

fn draw_conflicts(frame: &mut Frame, area: Rect, view: &View) {
    let block = panel("Conflicts");
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let mut lines = vec![Line::from(
        [
            stat("auto-merged ", view.tally.auto_merged.to_string()),
            stat("routed ", view.tally.routed.to_string()),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>(),
    )];
    let room = usize::from(inner.height).saturating_sub(1);
    if view.conflicts.is_empty() {
        lines.push(Line::styled("No overlapping edits yet.", DIM));
    }
    for conflict in view.conflicts.iter().rev().take(room) {
        let line = match &conflict.overlap {
            Overlap::AutoMerged {
                claims: [first, second],
            } => Line::from(vec![
                Span::styled("auto-merged ", Style::new().fg(Color::Green)),
                Span::raw(format!("{} ", conflict.path)),
                Span::styled(format!("{first} + {second}"), DIM),
            ]),
            Overlap::Routed {
                agent,
                claim_id,
                other_claim_id,
                redone,
            } => Line::from(vec![
                Span::styled(
                    if *redone {
                        "routed→redo "
                    } else {
                        "routed      "
                    },
                    Style::new().fg(Color::Yellow),
                ),
                Span::raw(format!("{} {agent} ", conflict.path)),
                Span::styled(format!("{claim_id} vs {other_claim_id}"), DIM),
            ]),
        };
        lines.push(line);
    }
    frame.render_widget(Paragraph::new(lines), inner);
}

fn draw_footer(frame: &mut Frame, area: Rect, view: &View) {
    let keys = match view.phase {
        Phase::Running => " q stop · p pause · ↑↓ select · enter events",
        Phase::Paused => " q stop · p resume · ↑↓ select · enter events",
        Phase::Stopping => " stopping: waiting for every agent's process to exit",
        Phase::Ended(_) => " q exit · ↑↓ select · enter events",
    };
    frame.render_widget(Paragraph::new(Line::styled(keys, DIM)), area);
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use ratatui::Terminal;
    use ratatui::backend::TestBackend;

    use super::*;
    use crate::events::Event;
    use crate::tui::view::Key;
    use crate::tui::view::tests::recorded;

    fn render(view: &View, width: u16, height: u16) -> anyhow::Result<Terminal<TestBackend>> {
        let mut terminal = Terminal::new(TestBackend::new(width, height))?;
        terminal.draw(|frame| draw(frame, view))?;
        Ok(terminal)
    }

    /// The recorded run, replayed up to the first event at or after `until`.
    fn replayed(until: Duration) -> anyhow::Result<View> {
        let mut view = View::new();
        for (event, at) in recorded()? {
            if at > until {
                break;
            }
            view.apply(&event, at);
        }
        Ok(view)
    }

    /// The time of the recorded run's first event of `kind`.
    fn first(kind: fn(&Event) -> bool) -> anyhow::Result<Duration> {
        recorded()?
            .into_iter()
            .find(|(event, _)| kind(event))
            .map(|(_, at)| at)
            .ok_or_else(|| anyhow::anyhow!("the recording has no such event"))
    }

    #[test]
    fn an_empty_run() -> anyhow::Result<()> {
        insta::assert_snapshot!(render(&View::new(), 120, 24)?.backend());
        Ok(())
    }

    #[test]
    fn mid_run_wide() -> anyhow::Result<()> {
        let at = first(|e| matches!(e, Event::ConflictRouted { .. }))?;
        let mut view = replayed(at)?;
        view.key(Key::Down);
        insta::assert_snapshot!(render(&view, 140, 30)?.backend());
        Ok(())
    }

    #[test]
    fn a_finished_run_wide() -> anyhow::Result<()> {
        let view = replayed(Duration::MAX)?;
        insta::assert_snapshot!(render(&view, 140, 30)?.backend());
        Ok(())
    }

    #[test]
    fn a_finished_run_at_80_columns() -> anyhow::Result<()> {
        let view = replayed(Duration::MAX)?;
        insta::assert_snapshot!(render(&view, 80, 24)?.backend());
        Ok(())
    }

    #[test]
    fn batches_and_their_checks_in_the_train_panel() -> anyhow::Result<()> {
        let view = crate::tui::view::tests::waiting_on_the_train();
        insta::assert_snapshot!(render(&view, 140, 24)?.backend());
        Ok(())
    }

    #[test]
    fn an_agents_recent_events() -> anyhow::Result<()> {
        let mut view = replayed(Duration::MAX)?;
        view.key(Key::Down);
        view.key(Key::Enter);
        insta::assert_snapshot!(render(&view, 120, 30)?.backend());
        Ok(())
    }

    #[test]
    fn a_paused_run_says_so() -> anyhow::Result<()> {
        let at = first(|e| matches!(e, Event::Pushed { .. }))?;
        let mut view = replayed(at)?;
        view.key(Key::Pause);
        let terminal = render(&view, 100, 20)?;
        let header: String = (0..100)
            .filter_map(|x| terminal.backend().buffer().cell((x, 0)))
            .map(ratatui::buffer::Cell::symbol)
            .collect();
        assert!(header.contains("PAUSED: no new claims"), "{header}");
        Ok(())
    }

    #[test]
    fn a_terminal_below_the_minimum_gets_a_notice() -> anyhow::Result<()> {
        let view = replayed(Duration::MAX)?;
        insta::assert_snapshot!(render(&view, 79, 24)?.backend());
        // Too short is as bad as too narrow, and the smallest terminal still draws.
        let short = render(&view, 120, MIN_HEIGHT - 1)?;
        assert!(format!("{}", short.backend()).contains("this terminal is 120×15"));
        render(&view, 1, 1)?;
        Ok(())
    }

    #[test]
    fn the_selected_lane_is_highlighted() -> anyhow::Result<()> {
        let mut view = replayed(Duration::MAX)?;
        view.key(Key::Down);
        let terminal = render(&view, 120, 24)?;
        let buffer = terminal.backend().buffer();
        // The lanes' table: border, header, then one row per agent from y = 6.
        let marked: Vec<u16> = (6..10)
            .filter(|y| buffer.cell((1, *y)).is_some_and(|c| c.symbol() == "›"))
            .collect();
        assert_eq!(marked, [7]);
        let reversed = buffer
            .cell((3, 7))
            .is_some_and(|c| c.modifier.contains(Modifier::REVERSED));
        assert!(reversed);
        Ok(())
    }
}
