//! The terminal itself: create it, feed it the bytes a shell prints, ask it what is on screen.
//!
//! Ported from `apps/web/src/terminal/ghostty/core.ts`. What is here is the output path —
//! `initialize`, `write`, `resize`, `setTheme`, `scroll`, `snapshot` and the row and cell readers
//! it walks. What is deliberately **not** here yet: `resetAndWrite` (a replay path — there is no
//! replay until a terminal restores from history), key and mouse encoding (`encodeKey`/
//! `encodeMouse`, which need browser `KeyboardEvent`/layout-map equivalents) and selection. The
//! window in `native/terminal-window` sends keystrokes as plain bytes, which is a declared
//! deviation, not an oversight.

use crate::runtime::{GHOSTTY_SUCCESS, GhosttyError, Runtime};
use wasmtime::Val;

/// `MAX_SCROLLBACK_ROWS` (`core.ts:12`).
const MAX_SCROLLBACK_ROWS: i64 = 10_000;

/// `RENDER_DATA` — tags for `ghostty_render_state_get`/`_set` (`ghostty/vt/render.h`).
mod render {
    pub const COLS: i32 = 1;
    pub const ROWS: i32 = 2;
    pub const DIRTY: i32 = 3;
    pub const ROW_ITERATOR: i32 = 4;
    pub const BACKGROUND: i32 = 5;
    pub const FOREGROUND: i32 = 6;
    pub const CURSOR: i32 = 7;
    pub const CURSOR_HAS_VALUE: i32 = 8;
    pub const CURSOR_STYLE: i32 = 10;
    pub const CURSOR_VISIBLE: i32 = 11;
    pub const CURSOR_BLINKING: i32 = 12;
    pub const CURSOR_IN_VIEWPORT: i32 = 14;
    pub const CURSOR_X: i32 = 15;
    pub const CURSOR_Y: i32 = 16;
    /// Argument to `ghostty_render_state_set` that clears the whole-state dirty flag.
    pub const SET_DIRTY: i32 = 0;
}

/// `ROW_DATA` and `RAW_ROW_DATA`.
mod row_data {
    pub const DIRTY: i32 = 1;
    pub const RAW: i32 = 2;
    pub const CELLS: i32 = 3;
    pub const WRAPS_TO_NEXT: i32 = 1;
    pub const IS_WRAP_CONTINUATION: i32 = 2;
    /// Argument to `ghostty_render_state_row_set` that marks a row clean.
    pub const SET_DIRTY: i32 = 0;
}

/// `CELL_DATA` and `RAW_CELL_DATA`.
mod cell_data {
    pub const RAW: i32 = 1;
    pub const STYLE: i32 = 2;
    pub const GRAPHEMES_LENGTH: i32 = 3;
    pub const GRAPHEMES: i32 = 4;
    pub const BACKGROUND: i32 = 5;
    pub const FOREGROUND: i32 = 6;
    pub const SELECTED: i32 = 7;
    pub const WIDE: i32 = 3;
}

/// `GHOSTTY_CELL_WIDE`.
pub const CELL_WIDE_NARROW: i64 = 0;
pub const CELL_WIDE_WIDE: i64 = 1;
pub const CELL_WIDE_SPACER_TAIL: i64 = 2;
pub const CELL_WIDE_SPACER_HEAD: i64 = 3;

/// `GHOSTTY_TERMINAL_OPT_*` used by this port: cursor blink default, then the three colors.
const OPTION_CURSOR_BLINK: i32 = 23;
const OPTION_COLOR_FOREGROUND: i32 = 11;
const OPTION_COLOR_BACKGROUND: i32 = 12;
const OPTION_COLOR_CURSOR: i32 = 13;

/// `GHOSTTY_TERMINAL_SCROLL_VIEWPORT` tags.
const SCROLL_TO_BOTTOM: i32 = 1;
const SCROLL_VIEWPORT_ROWS: i32 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Color {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

/// `GhosttyTheme`. The selection overlay color stays in the renderer, as it does in the client.
#[derive(Clone, Copy, Debug)]
pub struct Theme {
    pub foreground: Color,
    pub background: Color,
    pub cursor: Color,
}

/// The client's fallbacks, so a snapshot without a theme answer looks like the client's.
pub const DEFAULT_FOREGROUND: Color = Color {
    r: 229,
    g: 231,
    b: 235,
};
pub const DEFAULT_BACKGROUND: Color = Color { r: 0, g: 0, b: 0 };

/// `GhosttyCell`.
#[derive(Clone, Debug, PartialEq)]
pub struct Cell {
    pub text: String,
    pub wide: i64,
    pub foreground: Color,
    pub background: Color,
    pub bold: bool,
    pub italic: bool,
    pub invisible: bool,
    pub strikethrough: bool,
    pub overline: bool,
    pub underline: bool,
    pub selected: bool,
}

impl Cell {
    /// `GhosttyTerminalCore.emptyCell`.
    fn empty(foreground: Color, background: Color) -> Self {
        Self {
            text: String::new(),
            wide: CELL_WIDE_NARROW,
            foreground,
            background,
            bold: false,
            italic: false,
            invisible: false,
            strikethrough: false,
            overline: false,
            underline: false,
            selected: false,
        }
    }
}

/// `GhosttyRow`.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub cells: Vec<Cell>,
    pub text: String,
    pub is_wrap_continuation: bool,
    pub wraps_to_next: bool,
}

/// `GhosttySnapshot`, borrowing the row cache the core keeps alive between snapshots.
#[derive(Debug)]
pub struct Snapshot<'a> {
    pub cols: i32,
    pub rows: i32,
    pub foreground: Color,
    pub background: Color,
    pub cursor: Color,
    pub cursor_x: i32,
    pub cursor_y: i32,
    pub cursor_visible: bool,
    pub cursor_blinking: bool,
    pub cursor_style: i32,
    pub dirty_rows: Vec<usize>,
    pub row_data: &'a [Row],
}

pub struct GhosttyTerminal {
    runtime: Runtime,
    terminal: i32,
    terminal_slot: i32,
    render_state: i32,
    render_state_slot: i32,
    row_iterator_slot: i32,
    row_cells_slot: i32,
    scratch: i32,
    style: i32,
    style_size: usize,
    graphemes: i32,
    grapheme_capacity: usize,
    rows: Vec<Row>,
}

impl GhosttyTerminal {
    /// `GhosttyTerminalCore.create` plus the part of `initialize` that builds terminal state.
    /// Key and mouse encoders are skipped with the rest of the input path.
    pub fn new(
        mut runtime: Runtime,
        cols: i32,
        rows: i32,
        cell_width: i32,
        cell_height: i32,
        theme: &Theme,
    ) -> Result<Self, GhosttyError> {
        let options_layout = runtime.layout("GhosttyTerminalOptions")?.size;
        let options = runtime.alloc(options_layout)?;
        let mut terminal = Self {
            runtime,
            terminal: 0,
            terminal_slot: 0,
            render_state: 0,
            render_state_slot: 0,
            row_iterator_slot: 0,
            row_cells_slot: 0,
            scratch: 0,
            style: 0,
            style_size: 0,
            graphemes: 0,
            grapheme_capacity: 0,
            rows: Vec::new(),
        };
        terminal
            .runtime
            .set_field(options, "GhosttyTerminalOptions", "cols", i64::from(cols))?;
        terminal
            .runtime
            .set_field(options, "GhosttyTerminalOptions", "rows", i64::from(rows))?;
        terminal.runtime.set_field(
            options,
            "GhosttyTerminalOptions",
            "max_scrollback",
            MAX_SCROLLBACK_ROWS,
        )?;

        terminal.terminal_slot = terminal.runtime.alloc_opaque()?;
        GhosttyTerminal::assert_success(
            "ghostty_terminal_new",
            terminal.runtime.call(
                "ghostty_terminal_new",
                &[0, terminal.terminal_slot, options],
            )?,
        )?;
        terminal.runtime.free(options, options_layout)?;
        terminal.terminal = terminal.runtime.read_pointer(terminal.terminal_slot)?;
        terminal.apply_default_cursor_blink()?;

        terminal.render_state_slot = terminal.runtime.alloc_opaque()?;
        GhosttyTerminal::assert_success(
            "ghostty_render_state_new",
            terminal
                .runtime
                .call("ghostty_render_state_new", &[0, terminal.render_state_slot])?,
        )?;
        terminal.render_state = terminal.runtime.read_pointer(terminal.render_state_slot)?;

        // Both iterators have to exist before `snapshot()` binds them: binding a row iterator
        // that was never allocated returns -2 and leaves the slot null. `core.ts` does not check
        // that get's return value, so skipping the `_new` here would silently render nothing.
        terminal.row_iterator_slot = terminal.runtime.alloc_opaque()?;
        GhosttyTerminal::assert_success(
            "ghostty_render_state_row_iterator_new",
            terminal.runtime.call(
                "ghostty_render_state_row_iterator_new",
                &[0, terminal.row_iterator_slot],
            )?,
        )?;
        terminal.row_cells_slot = terminal.runtime.alloc_opaque()?;
        GhosttyTerminal::assert_success(
            "ghostty_render_state_row_cells_new",
            terminal.runtime.call(
                "ghostty_render_state_row_cells_new",
                &[0, terminal.row_cells_slot],
            )?,
        )?;

        terminal.scratch = terminal.runtime.alloc(16)?;
        terminal.style_size = terminal.runtime.layout("GhosttyStyle")?.size;
        terminal.style = terminal.runtime.alloc(terminal.style_size)?;
        terminal.runtime.set_field(
            terminal.style,
            "GhosttyStyle",
            "size",
            terminal.style_size as i64,
        )?;

        terminal.set_theme(theme)?;
        terminal.resize(cols, rows, cell_width, cell_height)?;
        Ok(terminal)
    }

    pub fn runtime_mut(&mut self) -> &mut Runtime {
        &mut self.runtime
    }

    /// `GhosttyTerminalCore.initialize`'s `applyDefaultCursorBlink`.
    fn apply_default_cursor_blink(&mut self) -> Result<(), GhosttyError> {
        let blink = self.runtime.alloc(1)?;
        self.runtime.write(blink, &[1])?;
        self.runtime.call(
            "ghostty_terminal_set",
            &[self.terminal, OPTION_CURSOR_BLINK, blink],
        )?;
        self.runtime.free(blink, 1)
    }

    /// `GhosttyTerminalCore.write`.
    pub fn write(&mut self, data: &[u8]) -> Result<(), GhosttyError> {
        if data.is_empty() {
            return Ok(());
        }
        let pointer = self.runtime.alloc(data.len())?;
        self.runtime.write(pointer, data)?;
        self.runtime.call(
            "ghostty_terminal_vt_write",
            &[self.terminal, pointer, data.len() as i32],
        )?;
        self.runtime.free(pointer, data.len())
    }

    /// `GhosttyTerminalCore.resize`, with the same clamps.
    pub fn resize(
        &mut self,
        cols: i32,
        rows: i32,
        cell_width: i32,
        cell_height: i32,
    ) -> Result<(), GhosttyError> {
        let result = self.runtime.call(
            "ghostty_terminal_resize",
            &[
                self.terminal,
                cols.clamp(1, u16::MAX as i32),
                rows.clamp(1, u16::MAX as i32),
                cell_width.max(1),
                cell_height.max(1),
            ],
        )?;
        Self::assert_success("ghostty_terminal_resize", result)
    }

    /// `GhosttyTerminalCore.setTheme`.
    pub fn set_theme(&mut self, theme: &Theme) -> Result<(), GhosttyError> {
        let color = self.runtime.alloc(3)?;
        for (option, value) in [
            (OPTION_COLOR_FOREGROUND, theme.foreground),
            (OPTION_COLOR_BACKGROUND, theme.background),
            (OPTION_COLOR_CURSOR, theme.cursor),
        ] {
            self.runtime.write(color, &[value.r, value.g, value.b])?;
            self.runtime
                .call("ghostty_terminal_set", &[self.terminal, option, color])?;
        }
        self.runtime.free(color, 3)
    }

    /// `GhosttyTerminalCore.scroll`, in rows.
    pub fn scroll(&mut self, delta_rows: i32) -> Result<(), GhosttyError> {
        let layout = self
            .runtime
            .layout("GhosttyTerminalScrollViewport")?
            .clone();
        let scroll = self.runtime.alloc(layout.size)?;
        self.runtime.set_field(
            scroll,
            "GhosttyTerminalScrollViewport",
            "tag",
            i64::from(SCROLL_VIEWPORT_ROWS),
        )?;
        let value = layout
            .fields
            .get("value")
            .ok_or_else(|| GhosttyError::message("GhosttyTerminalScrollViewport has no value"))?;
        self.runtime
            .write(scroll + value.offset as i32, &delta_rows.to_le_bytes())?;
        self.runtime
            .call("ghostty_terminal_scroll_viewport", &[self.terminal, scroll])?;
        self.runtime.free(scroll, layout.size)
    }

    /// `GhosttyTerminalCore.scrollToBottom`.
    pub fn scroll_to_bottom(&mut self) -> Result<(), GhosttyError> {
        let size = self.runtime.layout("GhosttyTerminalScrollViewport")?.size;
        let scroll = self.runtime.alloc(size)?;
        self.runtime.set_field(
            scroll,
            "GhosttyTerminalScrollViewport",
            "tag",
            i64::from(SCROLL_TO_BOTTOM),
        )?;
        self.runtime
            .call("ghostty_terminal_scroll_viewport", &[self.terminal, scroll])?;
        self.runtime.free(scroll, size)
    }

    /// `GhosttyTerminalCore.snapshot`.
    pub fn snapshot(&mut self) -> Result<Snapshot<'_>, GhosttyError> {
        Self::assert_success(
            "ghostty_render_state_update",
            self.runtime.call(
                "ghostty_render_state_update",
                &[self.render_state, self.terminal],
            )?,
        )?;
        let cols = self.get_render_u16(render::COLS)?;
        let row_count = self.get_render_u16(render::ROWS)?;
        let dirty = self.get_render_u32(render::DIRTY)?;
        let foreground = self.get_render_color(render::FOREGROUND, DEFAULT_FOREGROUND)?;
        let background = self.get_render_color(render::BACKGROUND, DEFAULT_BACKGROUND)?;
        let cursor = if self.get_render_bool(render::CURSOR_HAS_VALUE)? {
            self.get_render_color(render::CURSOR, foreground)?
        } else {
            foreground
        };
        let cursor_in_viewport = self.get_render_bool(render::CURSOR_IN_VIEWPORT)?;
        let cursor_visible = self.get_render_bool(render::CURSOR_VISIBLE)? && cursor_in_viewport;
        let cursor_x = if cursor_in_viewport {
            self.get_render_u16(render::CURSOR_X)?
        } else {
            -1
        };
        let cursor_y = if cursor_in_viewport {
            self.get_render_u16(render::CURSOR_Y)?
        } else {
            -1
        };

        let shape_changed = self.rows.len() != row_count as usize
            || self.rows.iter().any(|row| row.cells.len() != cols as usize);
        if shape_changed {
            self.rows = (0..row_count)
                .map(|_| Row {
                    cells: (0..cols)
                        .map(|_| Cell::empty(foreground, background))
                        .collect(),
                    text: String::new(),
                    is_wrap_continuation: false,
                    wraps_to_next: false,
                })
                .collect();
        }

        let mut dirty_rows = Vec::new();
        if dirty != 0 {
            Self::assert_success(
                "ghostty_render_state_get(row iterator)",
                self.runtime.call(
                    "ghostty_render_state_get",
                    &[
                        self.render_state,
                        render::ROW_ITERATOR,
                        self.row_iterator_slot,
                    ],
                )?,
            )?;
            let iterator = self.runtime.read_pointer(self.row_iterator_slot)?;
            let mut row_index = 0;
            while row_index < row_count
                && self
                    .runtime
                    .call("ghostty_render_state_row_iterator_next", &[iterator])?
                    != 0
            {
                // `dirty == 2` is "every row changed"; 1 is "some rows did".
                let row_dirty = dirty == 2 || self.get_row_bool(iterator, row_data::DIRTY)?;
                if row_dirty {
                    let row = self.read_row(iterator, cols, foreground, background)?;
                    dirty_rows.push(row_index as usize);
                    self.rows[row_index as usize] = row;
                    self.runtime.write(self.scratch, &[0])?;
                    self.runtime.call(
                        "ghostty_render_state_row_set",
                        &[iterator, row_data::SET_DIRTY, self.scratch],
                    )?;
                }
                row_index += 1;
            }
            self.runtime.write(self.scratch, &0u32.to_le_bytes())?;
            self.runtime.call(
                "ghostty_render_state_set",
                &[self.render_state, render::SET_DIRTY, self.scratch],
            )?;
        }

        Ok(Snapshot {
            cols,
            rows: row_count,
            foreground,
            background,
            cursor,
            cursor_x,
            cursor_y,
            cursor_visible,
            cursor_blinking: self.get_render_bool(render::CURSOR_BLINKING)?,
            cursor_style: self.get_render_u32(render::CURSOR_STYLE)? as i32,
            dirty_rows,
            row_data: &self.rows,
        })
    }

    /// `GhosttyTerminalCore.readRow`.
    fn read_row(
        &mut self,
        iterator: i32,
        cols: i32,
        default_foreground: Color,
        default_background: Color,
    ) -> Result<Row, GhosttyError> {
        Self::assert_success(
            "ghostty_render_state_row_get(raw)",
            self.runtime.call(
                "ghostty_render_state_row_get",
                &[iterator, row_data::RAW, self.scratch],
            )?,
        )?;
        // `GhosttyRow` is a `uint64_t` handle, not a wasm32 pointer: the tag half is part of it.
        let raw_row = self.runtime.read_handle(self.scratch)?;
        let is_wrap_continuation =
            self.get_raw_row_bool(raw_row, row_data::IS_WRAP_CONTINUATION)?;
        let wraps_to_next = self.get_raw_row_bool(raw_row, row_data::WRAPS_TO_NEXT)?;

        Self::assert_success(
            "ghostty_render_state_row_get(cells)",
            self.runtime.call(
                "ghostty_render_state_row_get",
                &[iterator, row_data::CELLS, self.row_cells_slot],
            )?,
        )?;
        let cells_iterator = self.runtime.read_pointer(self.row_cells_slot)?;
        let mut cells: Vec<Cell> = Vec::new();
        while (cells.len() as i32) < cols
            && self
                .runtime
                .call("ghostty_render_state_row_cells_next", &[cells_iterator])?
                != 0
        {
            let mut foreground =
                self.get_cell_color(cells_iterator, cell_data::FOREGROUND, default_foreground)?;
            let mut background =
                self.get_cell_color(cells_iterator, cell_data::BACKGROUND, default_background)?;
            self.runtime.zero(self.style, self.style_size);
            self.runtime
                .set_field(self.style, "GhosttyStyle", "size", self.style_size as i64)?;
            self.runtime.call(
                "ghostty_render_state_row_cells_get",
                &[cells_iterator, cell_data::STYLE, self.style],
            )?;

            let grapheme_length = self.get_cell_u32(cells_iterator, cell_data::GRAPHEMES_LENGTH)?;
            let mut text = String::new();
            if grapheme_length > 0 {
                let buffer_size = (grapheme_length as usize) * 4;
                if buffer_size > self.grapheme_capacity {
                    let capacity = buffer_size.max(self.grapheme_capacity * 2);
                    let buffer = self.runtime.alloc(capacity)?;
                    self.runtime.free(self.graphemes, self.grapheme_capacity)?;
                    self.graphemes = buffer;
                    self.grapheme_capacity = capacity;
                }
                if self.runtime.call(
                    "ghostty_render_state_row_cells_get",
                    &[cells_iterator, cell_data::GRAPHEMES, self.graphemes],
                )? == GHOSTTY_SUCCESS
                {
                    text = self.read_graphemes(buffer_size, grapheme_length)?;
                }
            }

            // A wide glyph occupies the cell to its right with an empty spacer; the client reads
            // the raw cell to learn which of the two it is looking at.
            let mut wide = CELL_WIDE_NARROW;
            if text.is_empty() && cells.last().is_some_and(|cell| !cell.text.is_empty()) {
                Self::assert_success(
                    "ghostty_render_state_row_cells_get(raw)",
                    self.runtime.call(
                        "ghostty_render_state_row_cells_get",
                        &[cells_iterator, cell_data::RAW, self.scratch],
                    )?,
                )?;
                let raw_cell = self.runtime.read_handle(self.scratch)?;
                self.runtime.write(self.scratch + 8, &0u32.to_le_bytes())?;
                Self::assert_success(
                    "ghostty_cell_get(wide)",
                    self.runtime.call_vals(
                        "ghostty_cell_get",
                        &[
                            Val::I64(raw_cell as i64),
                            Val::I32(cell_data::WIDE),
                            Val::I32(self.scratch + 8),
                        ],
                    )?,
                )?;
                wide = i64::from(u32::from_le_bytes(
                    self.runtime
                        .read(self.scratch + 8, 4)?
                        .try_into()
                        .expect("4 bytes"),
                ));
            }

            let selected = self.get_cell_bool(cells_iterator, cell_data::SELECTED)?;
            // Read the style last: allocation and ABI calls above can grow wasm memory.
            if self.style_bool("inverse")? {
                std::mem::swap(&mut foreground, &mut background);
            }
            if self.style_bool("faint")? {
                foreground = blend(foreground, background);
            }
            cells.push(Cell {
                text,
                wide,
                foreground,
                background,
                bold: self.style_bool("bold")?,
                italic: self.style_bool("italic")?,
                invisible: self.style_bool("invisible")?,
                strikethrough: self.style_bool("strikethrough")?,
                overline: self.style_bool("overline")?,
                underline: self.style_i32("underline")? != 0,
                selected,
            });
        }
        while (cells.len() as i32) < cols {
            cells.push(Cell::empty(default_foreground, default_background));
        }
        // `GhosttyRow.text`: empty cells count as a space, then trailing blanks go.
        let text = cells
            .iter()
            .map(|cell| {
                if cell.text.is_empty() {
                    " "
                } else {
                    &cell.text
                }
            })
            .collect::<String>()
            .trim_end()
            .to_owned();
        Ok(Row {
            cells,
            text,
            is_wrap_continuation,
            wraps_to_next,
        })
    }

    /// `ghosttyCellText` — codepoints are little-endian u32s. The shipped client reads through a
    /// `DataView` because the byte allocator does not guarantee 4-byte alignment; a raw read
    /// here has the same property.
    fn read_graphemes(&self, buffer_size: usize, count: u32) -> Result<String, GhosttyError> {
        let bytes = self.runtime.read(self.graphemes, buffer_size)?;
        let mut text = String::new();
        for index in 0..count as usize {
            let start = index * 4;
            let codepoint =
                u32::from_le_bytes(bytes[start..start + 4].try_into().expect("4 bytes"));
            text.push(char::from_u32(codepoint).unwrap_or('\u{FFFD}'));
        }
        Ok(text)
    }

    /// Style fields are read through `read_field`, after every allocation in the cell loop:
    /// those calls can grow wasm memory and the offsets come from the module's own layout.
    fn style_bool(&self, field: &str) -> Result<bool, GhosttyError> {
        Ok(self.runtime.read_field(self.style, "GhosttyStyle", field)? != 0)
    }

    fn style_i32(&self, field: &str) -> Result<i32, GhosttyError> {
        Ok(self.runtime.read_field(self.style, "GhosttyStyle", field)? as i32)
    }

    fn get_raw_row_bool(&mut self, raw_row: u64, data: i32) -> Result<bool, GhosttyError> {
        self.runtime.write(self.scratch + 8, &[0])?;
        Ok(self.runtime.call_vals(
            "ghostty_row_get",
            &[
                Val::I64(raw_row as i64),
                Val::I32(data),
                Val::I32(self.scratch + 8),
            ],
        )? == GHOSTTY_SUCCESS
            && self.runtime.read(self.scratch + 8, 1)?[0] != 0)
    }

    fn get_render_u16(&mut self, data: i32) -> Result<i32, GhosttyError> {
        self.runtime.zero(self.scratch, 2);
        Self::assert_success(
            "ghostty_render_state_get",
            self.runtime.call(
                "ghostty_render_state_get",
                &[self.render_state, data, self.scratch],
            )?,
        )?;
        Ok(i32::from(u16::from_le_bytes(
            self.runtime
                .read(self.scratch, 2)?
                .try_into()
                .expect("2 bytes"),
        )))
    }

    fn get_render_u32(&mut self, data: i32) -> Result<u32, GhosttyError> {
        self.runtime.zero(self.scratch, 4);
        Self::assert_success(
            "ghostty_render_state_get",
            self.runtime.call(
                "ghostty_render_state_get",
                &[self.render_state, data, self.scratch],
            )?,
        )?;
        Ok(u32::from_le_bytes(
            self.runtime
                .read(self.scratch, 4)?
                .try_into()
                .expect("4 bytes"),
        ))
    }

    fn get_render_bool(&mut self, data: i32) -> Result<bool, GhosttyError> {
        self.runtime.zero(self.scratch, 1);
        Self::assert_success(
            "ghostty_render_state_get",
            self.runtime.call(
                "ghostty_render_state_get",
                &[self.render_state, data, self.scratch],
            )?,
        )?;
        Ok(self.runtime.read(self.scratch, 1)?[0] != 0)
    }

    /// `getColor` — unlike the scalar getters this tolerates a failure and keeps the fallback.
    fn get_render_color(&mut self, data: i32, fallback: Color) -> Result<Color, GhosttyError> {
        self.runtime.zero(self.scratch, 3);
        let result = self.runtime.call(
            "ghostty_render_state_get",
            &[self.render_state, data, self.scratch],
        )?;
        Ok(if result == GHOSTTY_SUCCESS {
            read_color(&self.runtime.read(self.scratch, 3)?)
        } else {
            fallback
        })
    }

    fn get_row_bool(&mut self, iterator: i32, data: i32) -> Result<bool, GhosttyError> {
        self.runtime.zero(self.scratch, 1);
        Ok(self.runtime.call(
            "ghostty_render_state_row_get",
            &[iterator, data, self.scratch],
        )? == GHOSTTY_SUCCESS
            && self.runtime.read(self.scratch, 1)?[0] != 0)
    }

    fn get_cell_u32(&mut self, iterator: i32, data: i32) -> Result<u32, GhosttyError> {
        self.runtime.zero(self.scratch, 4);
        let result = self.runtime.call(
            "ghostty_render_state_row_cells_get",
            &[iterator, data, self.scratch],
        )?;
        Ok(if result == GHOSTTY_SUCCESS {
            u32::from_le_bytes(
                self.runtime
                    .read(self.scratch, 4)?
                    .try_into()
                    .expect("4 bytes"),
            )
        } else {
            0
        })
    }

    fn get_cell_bool(&mut self, iterator: i32, data: i32) -> Result<bool, GhosttyError> {
        self.runtime.zero(self.scratch, 1);
        Ok(self.runtime.call(
            "ghostty_render_state_row_cells_get",
            &[iterator, data, self.scratch],
        )? == GHOSTTY_SUCCESS
            && self.runtime.read(self.scratch, 1)?[0] != 0)
    }

    fn get_cell_color(
        &mut self,
        iterator: i32,
        data: i32,
        fallback: Color,
    ) -> Result<Color, GhosttyError> {
        self.runtime.zero(self.scratch, 3);
        let result = self.runtime.call(
            "ghostty_render_state_row_cells_get",
            &[iterator, data, self.scratch],
        )?;
        Ok(if result == GHOSTTY_SUCCESS {
            read_color(&self.runtime.read(self.scratch, 3)?)
        } else {
            fallback
        })
    }

    /// The wasm calls report failure as a negative return code rather than through an error
    /// payload, so the operation name is what makes a trap readable.
    fn assert_success(operation: &str, result: i32) -> Result<(), GhosttyError> {
        if result == GHOSTTY_SUCCESS {
            Ok(())
        } else {
            Err(GhosttyError::message(format!(
                "{operation} failed with result {result}"
            )))
        }
    }
}

impl Drop for GhosttyTerminal {
    fn drop(&mut self) {
        // `dispose()` in the client, in the same order: engine objects first, then the host
        // allocations that held them. Skipping the `_free` calls leaks inside the wasm heap,
        // where the allocator cannot give the pages back to the OS.
        for (slot, free) in [
            (self.row_cells_slot, "ghostty_render_state_row_cells_free"),
            (
                self.row_iterator_slot,
                "ghostty_render_state_row_iterator_free",
            ),
        ] {
            if let Ok(handle) = self.runtime.read_pointer(slot)
                && handle != 0
            {
                let _ = self.runtime.call(free, &[handle]);
            }
        }
        if self.render_state != 0 {
            let _ = self
                .runtime
                .call("ghostty_render_state_free", &[self.render_state]);
        }
        if self.terminal != 0 {
            let _ = self.runtime.call("ghostty_terminal_free", &[self.terminal]);
        }
        let _ = self.runtime.free(self.style, self.style_size);
        let _ = self.runtime.free(self.graphemes, self.grapheme_capacity);
        let _ = self.runtime.free(self.scratch, 16);
        for slot in [
            self.row_cells_slot,
            self.row_iterator_slot,
            self.render_state_slot,
            self.terminal_slot,
        ] {
            let _ = self.runtime.free_opaque(slot);
        }
    }
}

fn read_color(bytes: &[u8]) -> Color {
    Color {
        r: bytes[0],
        g: bytes[1],
        b: bytes[2],
    }
}

/// `blend` — the client's faint-cell mix, in the same integer form.
fn blend(foreground: Color, background: Color) -> Color {
    let channel =
        |front: u8, back: u8| ((u16::from(front) * 155 + u16::from(back) * 100) / 255) as u8;
    Color {
        r: channel(foreground.r, background.r),
        g: channel(foreground.g, background.g),
        b: channel(foreground.b, background.b),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CELL_WIDE_SPACER_TAIL, Color, DEFAULT_BACKGROUND, DEFAULT_FOREGROUND, GhosttyTerminal,
        Theme,
    };
    use crate::load_embedded;
    use std::cell::RefCell;
    use std::rc::Rc;

    /// The renderer's cell metrics do not reach the engine, so any size is a valid one here.
    fn terminal(cols: i32, rows: i32) -> GhosttyTerminal {
        let theme = Theme {
            foreground: DEFAULT_FOREGROUND,
            background: DEFAULT_BACKGROUND,
            cursor: DEFAULT_FOREGROUND,
        };
        GhosttyTerminal::new(
            load_embedded().expect("load the shipped ghostty-vt.wasm"),
            cols,
            rows,
            8,
            16,
            &theme,
        )
        .expect("build a terminal")
    }

    #[test]
    fn written_bytes_land_in_the_grid() {
        let mut terminal = terminal(80, 24);
        terminal.write(b"hello\r\nworld").expect("write");
        let snapshot = terminal.snapshot().expect("snapshot");
        assert_eq!((snapshot.cols, snapshot.rows), (80, 24));
        assert_eq!(snapshot.row_data[0].text, "hello");
        assert_eq!(snapshot.row_data[1].text, "world");
        assert_eq!((snapshot.cursor_x, snapshot.cursor_y), (5, 1));
        assert!(snapshot.cursor_visible);
    }

    /// The renderer repaints `dirty_rows` only, so a clean snapshot must not report work and a
    /// one-line write must not dirty the screen. `dirty == 2` ("everything changed") is what the
    /// engine reports for the very first update of a fresh render state.
    #[test]
    fn only_changed_rows_are_reported_dirty() {
        let mut terminal = terminal(80, 24);
        terminal.write(b"hello\r\nworld").expect("write");
        assert_eq!(terminal.snapshot().expect("first").dirty_rows.len(), 24);
        assert!(
            terminal.snapshot().expect("idle").dirty_rows.is_empty(),
            "a snapshot with nothing written must not queue a repaint"
        );
        terminal.write(b"!").expect("write");
        assert_eq!(
            terminal.snapshot().expect("one row").dirty_rows,
            vec![1],
            "only the row the cursor is on changed"
        );
    }

    #[test]
    fn a_wide_glyph_reserves_the_cell_after_it() {
        let mut terminal = terminal(80, 4);
        terminal.write("🙂".as_bytes()).expect("write");
        let snapshot = terminal.snapshot().expect("snapshot");
        let row = &snapshot.row_data[0];
        assert_eq!(row.cells[0].text, "🙂");
        assert_eq!(row.cells[1].text, "");
        assert_eq!(row.cells[1].wide, CELL_WIDE_SPACER_TAIL);
        assert_eq!(row.text, "🙂");
    }

    #[test]
    fn sgr_truecolor_reaches_the_cell() {
        let mut terminal = terminal(80, 4);
        terminal
            .write(b"\x1b[38;2;10;20;30mR\x1b[0m")
            .expect("write colors");
        let snapshot = terminal.snapshot().expect("snapshot");
        let row = &snapshot.row_data[0];
        assert_eq!(row.cells[0].text, "R");
        assert_eq!(
            row.cells[0].foreground,
            Color {
                r: 10,
                g: 20,
                b: 30
            }
        );
        assert_eq!(row.cells[1].foreground, DEFAULT_FOREGROUND);
    }

    #[test]
    fn resize_reshapes_the_grid_and_clamps_zero() {
        let mut terminal = terminal(80, 24);
        terminal.resize(40, 12, 8, 16).expect("resize");
        let snapshot = terminal.snapshot().expect("snapshot");
        assert_eq!((snapshot.cols, snapshot.rows), (40, 12));
        assert_eq!(snapshot.row_data[0].cells.len(), 40);
        terminal.resize(0, 0, 8, 16).expect("clamped resize");
        let snapshot = terminal.snapshot().expect("after clamp");
        assert_eq!((snapshot.cols, snapshot.rows), (1, 1));
    }

    /// The gate for decision #30, in production code rather than a probe: a host `Func` goes
    /// straight into `__indirect_function_table`, with no 112-byte trampoline module, and the
    /// engine answers a query through it from inside `vt_write`.
    #[test]
    fn the_engine_answers_queries_through_the_pty_writer() {
        let mut terminal = terminal(80, 4);
        let handle = terminal.terminal;
        let replies = Rc::new(RefCell::new(Vec::new()));
        let sink = Rc::clone(&replies);
        terminal
            .runtime_mut()
            .set_pty_writer(handle, move |chunk| {
                sink.borrow_mut().extend_from_slice(chunk);
            })
            .expect("attach writer");
        terminal.write(b"\x1b[6n\x1b[0c").expect("write queries");
        // The writer closure holds the other strong reference, so read through the `Rc`.
        let text = String::from_utf8(replies.borrow().clone()).expect("ascii reply");
        assert_eq!(text, "\x1b[1;1R\x1b[?62;22c");
    }
}
