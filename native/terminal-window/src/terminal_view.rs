//! The terminal surface: engine snapshot in, gpui quads and shaped lines out.
//!
//! Painting is deliberately whole-grid rather than dirty-list driven: gpui rebuilds its scene
//! every frame anyway, and `snapshot()` already only reads the rows libghostty-vt marked dirty,
//! which is where the engine's work is saved.
//!
//! Declared deviations from `apps/web/src/terminal/ghostty/core.ts`, all of them input-side or
//! polish, none of them affecting what the shell sees:
//! - no cursor blink (`cursor_blinking` is read and ignored),
//! - no mouse reporting, selection or hover links,
//! - no strikethrough/overline/curly-underline painting, only a plain underline,
//! - no kitty keyboard protocol (see [`crate::input`]).

use std::rc::Rc;

use futures::StreamExt;
use gpui::prelude::*;
use gpui::{
    Bounds, Context, FocusHandle, Font, Hsla, KeyDownEvent, MouseButton, MouseDownEvent, Pixels,
    Rgba, ShapedLine, Size, Task, TextAlign, TextRun, UnderlineStyle, Window, canvas, div, fill,
    point, px, rgb, size,
};
use lmcs_ghostty_vt::terminal::{CELL_WIDE_SPACER_HEAD, CELL_WIDE_SPACER_TAIL, Color};
use lmcs_ghostty_vt::{GhosttyTerminal, Row, Snapshot};

use crate::input;
use crate::pty_bridge::{FromPty, PtyBridge, ToPty};

/// The keymap context the shell's own bindings would be looked up under. Nothing is bound to it
/// yet, so every keystroke reaches [`crate::input`] as text.
const TERMINAL_CONTEXT: &str = "Terminal";

const REGULAR: usize = 0;
const BOLD: usize = 1;
const ITALIC: usize = 2;

#[must_use]
fn font_index(bold: bool, italic: bool) -> usize {
    (if bold { BOLD } else { REGULAR }) + if italic { ITALIC } else { 0 }
}

/// The `GhosttyColor` of a cell as the single integer a run key can compare.
#[must_use]
pub fn color_bits(color: Color) -> u32 {
    (u32::from(color.r) << 16) | (u32::from(color.g) << 8) | u32::from(color.b)
}

/// The engine's viewport math is in whole device pixels, which is what its resize takes.
#[must_use]
fn whole(pixels: Pixels) -> i32 {
    pixels.as_f32().round() as i32
}

#[derive(Clone)]
struct Run {
    text: String,
    font: Font,
    color: Hsla,
    underline: bool,
}

#[derive(Clone)]
struct Block {
    column: usize,
    columns: usize,
    color: Rgba,
}

#[derive(Clone)]
struct RowPaint {
    blocks: Vec<Block>,
    runs: Vec<Run>,
}

#[derive(Clone)]
struct Paint {
    rows: Vec<RowPaint>,
    background: Rgba,
    cursor: Option<(usize, usize)>,
    cursor_color: Rgba,
}

impl Default for Paint {
    fn default() -> Self {
        Self {
            rows: Vec::new(),
            background: rgb(0x00_00_00),
            cursor: None,
            cursor_color: rgb(0x00_00_00),
        }
    }
}

pub struct TerminalView {
    terminal: GhosttyTerminal,
    pty: PtyBridge,
    fonts: [Font; 4],
    font_size: Pixels,
    cell: Size<Pixels>,
    grid: (i32, i32),
    background: Rgba,
    focus: FocusHandle,
    running: bool,
    /// Held so the stream is not cancelled; the task ends when the view is released.
    _output: Task<()>,
}

impl TerminalView {
    pub fn new(
        mut terminal: GhosttyTerminal,
        mut pty: PtyBridge,
        fonts: [Font; 4],
        font_size: Pixels,
        cell: Size<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        // The engine and the child both start at the size the window actually is, so the first
        // frame is already the right grid.
        let grid = grid_for(window.viewport_size(), cell);
        let _ = terminal.resize(grid.0, grid.1, whole(cell.width), whole(cell.height));
        pty.send(ToPty::Resize {
            cols: grid.0 as u32,
            rows: grid.1 as u32,
        });
        let focus = cx.focus_handle();
        window.focus(&focus, cx);

        let output = pty.take_output();
        let _output = cx.spawn_in(window, async move |this, cx| {
            let Some(mut output) = output else { return };
            while let Some(event) = output.next().await {
                // Resumed on the main thread by the executor, which is why no lock is needed.
                let _ = this.update_in(cx, |view, window, cx| {
                    view.receive(event);
                    window.refresh();
                    cx.notify();
                });
            }
        });

        Self {
            terminal,
            pty,
            fonts,
            font_size,
            cell,
            grid,
            background: rgb(0x00_00_00),
            focus,
            running: true,
            _output,
        }
    }

    fn receive(&mut self, event: FromPty) {
        match event {
            FromPty::Output(text) => {
                if self.terminal.write(text.as_bytes()).is_err() {
                    self.running = false;
                }
            }
            FromPty::Exited { code, signal } => {
                self.running = false;
                let _ = self.terminal.write(exit_note(code, signal).as_bytes());
            }
        }
    }

    fn sync_size(&mut self, window: &mut Window) {
        let grid = grid_for(window.viewport_size(), self.cell);
        if grid == self.grid || grid.0 < 1 || grid.1 < 1 {
            return;
        }
        if self
            .terminal
            .resize(
                grid.0,
                grid.1,
                whole(self.cell.width),
                whole(self.cell.height),
            )
            .is_err()
        {
            return;
        }
        self.grid = grid;
        // Only once the engine agrees, so a failed resize cannot leave the two grids apart.
        self.pty.send(ToPty::Resize {
            cols: grid.0 as u32,
            rows: grid.1 as u32,
        });
    }
}

/// What the dead shell leaves on the last line. The shipped client writes nothing and lets the
/// prompt simply stop answering; a window with no server behind it needs its own answer.
#[must_use]
fn exit_note(code: i32, signal: Option<i32>) -> String {
    // A clean POSIX exit arrives as `{ code: n, signal: 0 }` — zero is the library saying "not
    // signaled", not signal zero.
    match signal.filter(|signal| *signal != 0) {
        Some(signal) => format!("\r\n[process exited on signal {signal}]\r\n"),
        None => format!("\r\n[process exited with code {code}]\r\n"),
    }
}

#[must_use]
fn grid_for(viewport: Size<Pixels>, cell: Size<Pixels>) -> (i32, i32) {
    let columns = if cell.width.as_f32() > 0. {
        (viewport.width.as_f32() / cell.width.as_f32()).floor() as i32
    } else {
        1
    };
    let rows = if cell.height.as_f32() > 0. {
        (viewport.height.as_f32() / cell.height.as_f32()).floor() as i32
    } else {
        1
    };
    (columns.max(1), rows.max(1))
}

/// Turns the grid into the draws a frame needs: one background block per colour change, one text
/// run per style change.
fn plan(snapshot: &Snapshot, fonts: &[Font; 4]) -> Paint {
    let rows = snapshot
        .row_data
        .iter()
        .enumerate()
        .map(|(row, cells)| {
            let cursor = (snapshot.cursor_visible && usize::try_from(snapshot.cursor_y) == Ok(row))
                .then(|| usize::try_from(snapshot.cursor_x).unwrap_or(usize::MAX));
            plan_row(cells, cursor, snapshot.background, fonts)
        })
        .collect();
    Paint {
        rows,
        background: rgb(color_bits(snapshot.background)),
        cursor: (snapshot.cursor_visible && snapshot.cursor_x >= 0 && snapshot.cursor_y >= 0)
            .then_some((snapshot.cursor_x as usize, snapshot.cursor_y as usize)),
        cursor_color: rgb(color_bits(snapshot.cursor)),
    }
}

fn plan_row(row: &Row, cursor: Option<usize>, default: Color, fonts: &[Font; 4]) -> RowPaint {
    let default_bits = color_bits(default);
    let mut blocks = Vec::new();
    let mut column = 0;
    while column < row.cells.len() {
        let bits = color_bits(row.cells[column].background);
        if bits == default_bits {
            column += 1;
            continue;
        }
        let start = column;
        while column < row.cells.len() && color_bits(row.cells[column].background) == bits {
            column += 1;
        }
        blocks.push(Block {
            column: start,
            columns: column - start,
            color: rgb(bits),
        });
    }

    let mut runs: Vec<Run> = Vec::new();
    // The run being filled: (colour, face, underline, text).
    let mut open: Option<(u32, usize, bool, String)> = None;
    for (column, cell) in row.cells.iter().enumerate() {
        // A wide character carries its own glyph; its spacer is not a cell to draw.
        if cell.wide == CELL_WIDE_SPACER_TAIL || cell.wide == CELL_WIDE_SPACER_HEAD {
            continue;
        }
        let mut bits = if cell.invisible {
            color_bits(cell.background)
        } else {
            color_bits(cell.foreground)
        };
        // The block is painted under the text, so the character on it flips to the background.
        if cursor == Some(column) {
            bits = default_bits;
        }
        let face = font_index(cell.bold, cell.italic);
        let glyph = if cell.text.is_empty() {
            " "
        } else {
            &cell.text
        };
        match &mut open {
            Some((open_bits, open_face, open_underline, text))
                if *open_bits == bits
                    && *open_face == face
                    && *open_underline == cell.underline =>
            {
                text.push_str(glyph);
            }
            _ => {
                if let Some(finished) = open.take() {
                    runs.push(close_run(finished, fonts));
                }
                open = Some((bits, face, cell.underline, glyph.to_string()));
            }
        }
    }
    if let Some(finished) = open.take() {
        runs.push(close_run(finished, fonts));
    }

    RowPaint { blocks, runs }
}

fn close_run(run: (u32, usize, bool, String), fonts: &[Font; 4]) -> Run {
    let (bits, face, underline, text) = run;
    Run {
        text,
        font: fonts[face].clone(),
        color: rgb(bits).into(),
        underline,
    }
}

impl Render for TerminalView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_size(window);
        let paint = Rc::new(
            self.terminal
                .snapshot()
                .map(|snapshot| plan(&snapshot, &self.fonts))
                .unwrap_or_default(),
        );
        self.background = paint.background;
        let cell = self.cell;
        let font_size = self.font_size;
        let shaping = Rc::clone(&paint);

        div()
            .size_full()
            .relative()
            .overflow_hidden()
            .bg(self.background)
            .track_focus(&self.focus)
            .key_context(TERMINAL_CONTEXT)
            .on_mouse_down(MouseButton::Left, cx.listener(focus_view))
            .on_key_down(cx.listener(|view, event: &KeyDownEvent, _window, cx| {
                if !view.running {
                    return;
                }
                if let Some(bytes) = input::encode(&event.keystroke) {
                    view.pty.send(ToPty::Input(bytes));
                }
                cx.notify();
            }))
            .child(canvas(
                move |_bounds, window, _cx| {
                    let text_system = window.text_system();
                    let mut lines: Vec<(usize, ShapedLine)> =
                        Vec::with_capacity(shaping.rows.len());
                    for (row, paints) in shaping.rows.iter().enumerate() {
                        if paints.runs.is_empty() {
                            continue;
                        }
                        let mut shaped = String::new();
                        let mut runs = Vec::with_capacity(paints.runs.len());
                        for run in &paints.runs {
                            shaped.push_str(&run.text);
                            runs.push(TextRun {
                                len: run.text.len(),
                                font: run.font.clone(),
                                color: run.color,
                                underline: run.underline.then_some(UnderlineStyle {
                                    thickness: px(1.),
                                    color: None,
                                    wavy: false,
                                }),
                                ..Default::default()
                            });
                        }
                        lines.push((
                            row,
                            text_system.shape_line(shaped.into(), font_size, &runs, None),
                        ));
                    }
                    lines
                },
                move |bounds, lines, window, cx| {
                    window.paint_quad(fill(bounds, paint.background));
                    for (row, paints) in paint.rows.iter().enumerate() {
                        for block in &paints.blocks {
                            window.paint_quad(fill(
                                cell_bounds(bounds, cell, row, block.column, block.columns),
                                block.color,
                            ));
                        }
                    }
                    if let Some((column, row)) = paint.cursor {
                        window.paint_quad(fill(
                            cell_bounds(bounds, cell, row, column, 1),
                            paint.cursor_color,
                        ));
                    }
                    for (row, line) in lines {
                        let origin =
                            point(bounds.origin.x, bounds.origin.y + cell.height * row as f32);
                        let _ = line.paint(origin, cell.height, TextAlign::Left, None, window, cx);
                    }
                },
            ))
    }
}

fn focus_view(
    view: &mut TerminalView,
    _event: &MouseDownEvent,
    window: &mut Window,
    _cx: &mut Context<TerminalView>,
) {
    window.focus(&view.focus, _cx);
}

#[must_use]
fn cell_bounds(
    bounds: Bounds<Pixels>,
    cell: Size<Pixels>,
    row: usize,
    column: usize,
    columns: usize,
) -> Bounds<Pixels> {
    Bounds {
        origin: point(
            bounds.origin.x + cell.width * column as f32,
            bounds.origin.y + cell.height * row as f32,
        ),
        size: size(cell.width * columns as f32, cell.height),
    }
}

#[cfg(test)]
mod tests {
    use super::{exit_note, grid_for};
    use gpui::{px, size};

    #[test]
    fn a_zero_signal_is_a_clean_exit() {
        assert_eq!(
            exit_note(3, Some(0)),
            "\r\n[process exited with code 3]\r\n"
        );
        assert_eq!(exit_note(0, None), "\r\n[process exited with code 0]\r\n");
        assert_eq!(
            exit_note(0, Some(9)),
            "\r\n[process exited on signal 9]\r\n"
        );
    }

    #[test]
    fn a_grid_never_shrinks_below_one_cell() {
        let cell = size(px(8.), px(16.));
        assert_eq!(grid_for(size(px(8.5), px(16.5)), cell), (1, 1));
        assert_eq!(grid_for(size(px(0.), px(0.)), cell), (1, 1));
        assert_eq!(grid_for(size(px(800.), px(400.)), cell), (100, 25));
    }
}
