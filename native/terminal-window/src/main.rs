//! Milestone A: a window that runs a real shell.
//!
//! Nothing here is terminal semantics — the grid comes from the shipped `ghostty-vt.wasm`
//! (decision #30) and the child from the ported PTY session (fatia 10/11). This `main` only
//! picks a font, measures a cell from it, and hands both to the view, which is what decides the
//! grid.
//!
//! Run it with no arguments; `$LMCS_TERMINAL_FONT` and `$LMCS_TERMINAL_FONT_SIZE` override the
//! face, and `$LMCS_TERMINAL_CWD` the directory the shell starts in.

mod input;
mod pty_bridge;
mod terminal_view;

use gpui::{
    App, AppContext, Bounds, Font, Pixels, Size, TitlebarOptions, WindowBounds, WindowOptions,
    font, px, size,
};
use gpui_platform::application;
use lmcs_ghostty_vt::terminal::Color;
use lmcs_ghostty_vt::{
    DEFAULT_BACKGROUND, DEFAULT_FOREGROUND, GhosttyTerminal, Theme, load_embedded,
};
use pty_bridge::PtyBridge;
use terminal_view::TerminalView;

/// The grid the shell is spawned with, before the window knows its own size. The view resizes
/// both the engine and the child to the real viewport on its first frame.
const INITIAL_COLS: u32 = 80;
const INITIAL_ROWS: u32 = 24;

const REGULAR: usize = 0;

fn main() {
    let cwd = std::env::var("LMCS_TERMINAL_CWD").unwrap_or_else(|_| {
        std::env::current_dir()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|_| "/".to_string())
    });

    // The shell starts before the window: a machine with no usable shell should fail here, not
    // behind an empty frame.
    let bridge = match PtyBridge::start(&cwd, INITIAL_COLS, INITIAL_ROWS) {
        Ok(bridge) => bridge,
        Err(error) => {
            for message in error.messages() {
                eprintln!("{message}");
            }
            return;
        }
    };
    let title = format!("{} — {cwd}", bridge.shell_label);

    let family = std::env::var("LMCS_TERMINAL_FONT").unwrap_or_else(|_| {
        if cfg!(target_os = "macos") {
            "Menlo".to_string()
        } else {
            "DejaVu Sans Mono".to_string()
        }
    });
    let font_size = std::env::var("LMCS_TERMINAL_FONT_SIZE")
        .ok()
        .and_then(|value| value.parse::<f32>().ok())
        .unwrap_or(14.);

    application().run(move |cx| {
        let Some((fonts, cell)) = measure(&family, px(font_size), cx) else {
            eprintln!("cannot measure the terminal font {family}");
            cx.quit();
            return;
        };
        let engine = match build_engine(&cell) {
            Ok(engine) => engine,
            Err(error) => {
                eprintln!("cannot start the terminal engine: {error}");
                cx.quit();
                return;
            }
        };
        let Ok(_window) = cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                    None,
                    size(
                        px(cell.width.as_f32() * INITIAL_COLS as f32),
                        px(cell.height.as_f32() * INITIAL_ROWS as f32),
                    ),
                    cx,
                ))),
                titlebar: Some(TitlebarOptions {
                    title: Some(title.into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
            move |window, cx| {
                // Bring ourselves forward the way a terminal opened from a shell would be. The
                // window handle itself is only an id, so it needs no owner.
                window.activate_window();
                cx.new(|cx| {
                    TerminalView::new(engine, bridge, fonts, px(font_size), cell, window, cx)
                })
            },
        ) else {
            eprintln!("cannot open a window");
            cx.quit();
            return;
        };
        cx.activate(true);
    });
}

/// The four faces the engine can ask for and the cell they occupy.
fn measure(family: &str, font_size: Pixels, cx: &App) -> Option<([Font; 4], Size<Pixels>)> {
    let base = font(family);
    let fonts = [
        base.clone(),
        base.clone().bold(),
        base.clone().italic(),
        base.clone().bold().italic(),
    ];
    let text_system = cx.text_system();
    let face = text_system.resolve_font(&fonts[REGULAR]);
    // A missing `0` advance would mean the face fell back to something non-monospace; the width
    // of the em is the honest fallback in that case.
    let width = text_system
        .ch_advance(face, font_size)
        .unwrap_or(px(font_size.as_f32() * 0.6));
    let height = text_system.ascent(face, font_size) + text_system.descent(face, font_size);
    if width.as_f32() <= 0. || height.as_f32() <= 0. {
        return None;
    }
    Some((fonts, size(width, height)))
}

fn build_engine(cell: &Size<Pixels>) -> Result<GhosttyTerminal, Box<dyn std::error::Error>> {
    Ok(GhosttyTerminal::new(
        load_embedded()?,
        INITIAL_COLS as i32,
        INITIAL_ROWS as i32,
        cell.width.as_f32().round() as i32,
        cell.height.as_f32().round() as i32,
        &Theme {
            foreground: DEFAULT_FOREGROUND,
            background: DEFAULT_BACKGROUND,
            cursor: Color {
                r: 0x7f,
                g: 0x84,
                b: 0x8c,
            },
        },
    )?)
}
