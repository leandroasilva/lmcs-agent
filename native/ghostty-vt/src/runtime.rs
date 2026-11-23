//! The wasm host: loading `ghostty-vt.wasm`, reading the type layout the module describes
//! itself with, allocating inside its memory, and registering the PTY callback.
//!
//! Ported from `apps/web/src/terminal/ghostty/runtime.ts`. Offsets, sizes and field types are
//! never hardcoded: they come from `ghostty_type_json`, so a bumped pin moves with the module.

use std::cell::RefCell;
use std::collections::HashMap;
use std::fmt;
use std::rc::Rc;
use wasmtime::*;

/// The live PTY writer, held in the store state so the host callback can reach it without a
/// global.
///
/// The shipped browser host keeps a `Map` of writers keyed by an id it passes as `userdata`,
/// because one wasm instance is shared by every terminal in the page. A native runtime owns its
/// own store and its own terminal, so there is exactly one slot and `userdata` stays 0.
type WriterSlot = Rc<RefCell<Option<Box<dyn FnMut(&[u8])>>>>;

pub const GHOSTTY_SUCCESS: i32 = 0;

#[derive(Debug)]
pub struct GhosttyError(String);

impl GhosttyError {
    pub(crate) fn message(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for GhosttyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for GhosttyError {}

impl From<wasmtime::Error> for GhosttyError {
    fn from(error: wasmtime::Error) -> Self {
        Self(error.to_string())
    }
}

impl From<serde_json::Error> for GhosttyError {
    fn from(error: serde_json::Error) -> Self {
        Self(error.to_string())
    }
}

#[derive(Clone, Debug)]
pub struct Field {
    pub offset: usize,
    pub size: usize,
    pub ty: String,
}

#[derive(Clone, Debug)]
pub struct Layout {
    pub size: usize,
    pub fields: HashMap<String, Field>,
}

pub struct Runtime {
    store: Store<WriterSlot>,
    instance: Instance,
    memory: Memory,
    table: Table,
    layouts: HashMap<String, Layout>,
    writer: WriterSlot,
    /// Index of the host callback inside `__indirect_function_table`, filled in at load.
    callback_index: u32,
}

impl Runtime {
    /// Instantiates the module and installs the PTY write callback.
    pub fn load(bytes: &[u8]) -> Result<Self, GhosttyError> {
        let engine = Engine::default();
        let module = Module::new(&engine, bytes)?;
        let mut linker: Linker<WriterSlot> = Linker::new(&engine);
        linker.func_wrap(
            "env",
            "log",
            |mut caller: Caller<'_, WriterSlot>, pointer: u32, length: u32| {
                let Some(memory) = caller
                    .get_export("memory")
                    .and_then(|export| export.into_memory())
                else {
                    return;
                };
                let data = memory.data(&caller);
                let start = (pointer as usize).min(data.len());
                let end = (start + length as usize).min(data.len());
                let message = String::from_utf8_lossy(&data[start..end]).into_owned();
                // The browser host logs at `console.debug`; a native build stays quiet unless it is
                // a debug one, since the module is chatty about unknown escape sequences.
                #[cfg(debug_assertions)]
                eprintln!("[libghostty-vt] {message}");
                #[cfg(not(debug_assertions))]
                let _ = message;
            },
        )?;

        let writer: WriterSlot = Rc::new(RefCell::new(None));
        let mut store = Store::new(&engine, writer.clone());
        let instance = linker.instantiate(&mut store, &module)?;
        let memory = instance
            .get_memory(&mut store, "memory")
            .ok_or_else(|| GhosttyError::message("libghostty-vt did not export its memory"))?;
        let table = instance
            .get_table(&mut store, "__indirect_function_table")
            .ok_or_else(|| {
                GhosttyError::message("libghostty-vt did not export its callback table")
            })?;

        let mut runtime = Self {
            store,
            instance,
            memory,
            table,
            layouts: HashMap::new(),
            writer,
            callback_index: 0,
        };
        runtime.layouts = runtime.read_layouts()?;
        runtime.install_write_pty_callback()?;
        Ok(runtime)
    }

    /// `ghostty_type_json` — the module's own description of every struct it hands back.
    fn read_layouts(&mut self) -> Result<HashMap<String, Layout>, GhosttyError> {
        let pointer = self.call("ghostty_type_json", &[])?;
        let text = self.read_cstr(pointer);
        let root: serde_json::Value = serde_json::from_str(&text)?;
        let mut layouts = HashMap::new();
        let Some(entries) = root.as_object() else {
            return Err(GhosttyError::message("ghostty_type_json was not an object"));
        };
        for (name, entry) in entries {
            let mut fields = HashMap::new();
            if let Some(parsed) = entry.get("fields").and_then(serde_json::Value::as_object) {
                for (field, value) in parsed {
                    fields.insert(
                        field.clone(),
                        Field {
                            offset: number(value, "offset"),
                            size: number(value, "size"),
                            ty: value
                                .get("type")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or_default()
                                .to_owned(),
                        },
                    );
                }
            }
            layouts.insert(
                name.clone(),
                Layout {
                    size: entry
                        .get("size")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or_default() as usize,
                    fields,
                },
            );
        }
        Ok(layouts)
    }

    pub fn layout(&self, name: &str) -> Result<&Layout, GhosttyError> {
        self.layouts
            .get(name)
            .ok_or_else(|| GhosttyError::message(format!("no such libghostty-vt layout: {name}")))
    }

    pub fn field(&self, struct_name: &str, field_name: &str) -> Result<&Field, GhosttyError> {
        self.layout(struct_name).and_then(|layout| {
            layout.fields.get(field_name).ok_or_else(|| {
                GhosttyError::message(format!("no such field: {struct_name}.{field_name}"))
            })
        })
    }

    /// Every exported scalar entry point. The module is wasm32, so anything it takes or returns
    /// as a pointer or a `size_t` fits `i32`.
    pub fn call(&mut self, name: &str, args: &[i32]) -> Result<i32, GhosttyError> {
        let function = self
            .instance
            .get_func(&mut self.store, name)
            .ok_or_else(|| {
                GhosttyError::message(format!("libghostty-vt export is unavailable: {name}"))
            })?;
        let signature = function.ty(&self.store);
        if signature.params().len() != args.len() {
            return Err(GhosttyError::message(format!(
                "{name} takes {} arguments, called with {}",
                signature.params().len(),
                args.len()
            )));
        }
        let params: Vec<Val> = args.iter().map(|value| Val::I32(*value)).collect();
        let mut results = vec![Val::I32(0); signature.results().len()];
        function
            .call(&mut self.store, &params, &mut results)
            .map_err(|error| {
                let expected = signature
                    .params()
                    .map(|ty| ty.to_string())
                    .collect::<Vec<_>>()
                    .join(", ");
                let returns = signature
                    .results()
                    .map(|ty| ty.to_string())
                    .collect::<Vec<_>>()
                    .join(", ");
                GhosttyError::message(format!(
                    "{name}({}) -> {error}; the module declares ({expected}) -> ({returns})",
                    args.iter()
                        .map(i32::to_string)
                        .collect::<Vec<_>>()
                        .join(", "),
                ))
            })?;
        Ok(match results.first() {
            Some(Val::I32(value)) => *value,
            Some(Val::I64(value)) => *value as i32,
            _ => 0,
        })
    }

    /// `ghostty_wasm_alloc_u8_array`, zeroed. Several `*_new` calls read the output slot before
    /// writing it, and the shipped host clears it for the same reason.
    pub fn alloc(&mut self, size: usize) -> Result<i32, GhosttyError> {
        let pointer = self.call("ghostty_wasm_alloc_u8_array", &[size as i32])?;
        if pointer == 0 {
            return Err(GhosttyError::message(format!(
                "libghostty-vt failed to allocate {size} bytes"
            )));
        }
        self.zero(pointer, size);
        Ok(pointer)
    }

    pub fn free(&mut self, pointer: i32, size: usize) -> Result<(), GhosttyError> {
        if pointer != 0 {
            self.call("ghostty_wasm_free_u8_array", &[pointer, size as i32])?;
        }
        Ok(())
    }

    /// `ghostty_wasm_alloc_opaque` — a slot that will hold a pointer.
    pub fn alloc_opaque(&mut self) -> Result<i32, GhosttyError> {
        let pointer = self.call("ghostty_wasm_alloc_opaque", &[])?;
        if pointer == 0 {
            return Err(GhosttyError::message(
                "libghostty-vt failed to allocate an opaque pointer",
            ));
        }
        // Uninitialized until a `*_new` writes it; a dispose after a partial initialization must
        // not free garbage.
        self.write(pointer, &0u32.to_le_bytes())?;
        Ok(pointer)
    }

    pub fn free_opaque(&mut self, pointer: i32) -> Result<(), GhosttyError> {
        if pointer != 0 {
            self.call("ghostty_wasm_free_opaque", &[pointer])?;
        }
        Ok(())
    }

    pub fn read_pointer(&self, slot: i32) -> Result<i32, GhosttyError> {
        Ok(u32::from_le_bytes(self.read(slot, 4)?.try_into().expect("4 bytes")) as i32)
    }

    pub fn read(&self, pointer: i32, length: usize) -> Result<Vec<u8>, GhosttyError> {
        let data = self.memory.data(&self.store);
        let start = pointer as usize;
        let end = start.checked_add(length).ok_or_else(|| {
            GhosttyError::message(format!("read of {length} bytes at {pointer} overflowed"))
        })?;
        if end > data.len() {
            return Err(GhosttyError::message(format!(
                "read of {length} bytes at {pointer} ran past {} bytes of memory",
                data.len()
            )));
        }
        Ok(data[start..end].to_vec())
    }

    pub fn read_cstr(&self, pointer: i32) -> String {
        let data = self.memory.data(&self.store);
        let start = (pointer as usize).min(data.len());
        let mut end = start;
        while end < data.len() && data[end] != 0 {
            end += 1;
        }
        String::from_utf8_lossy(&data[start..end]).into_owned()
    }

    pub fn write(&mut self, pointer: i32, bytes: &[u8]) -> Result<(), GhosttyError> {
        let start = pointer as usize;
        let end = start + bytes.len();
        let memory = self.memory;
        let data = memory.data_mut(&mut self.store);
        if end > data.len() {
            return Err(GhosttyError::message(format!(
                "write of {} bytes at {pointer} ran past memory",
                bytes.len()
            )));
        }
        data[start..end].copy_from_slice(bytes);
        Ok(())
    }

    pub fn zero(&mut self, pointer: i32, length: usize) {
        let start = pointer as usize;
        let end = (start + length).min(self.memory.data(&self.store).len());
        let memory = self.memory;
        memory.data_mut(&mut self.store)[start..end].fill(0);
    }

    /// `GhosttyRuntime.setField` — the width comes from the layout, not from the caller.
    pub fn set_field(
        &mut self,
        pointer: i32,
        struct_name: &str,
        field: &str,
        value: i64,
    ) -> Result<(), GhosttyError> {
        let field = self.field(struct_name, field)?.clone();
        let offset = pointer as usize + field.offset;
        let bytes: Vec<u8> = match field.ty.as_str() {
            "bool" | "u8" => vec![value as u8],
            "u16" => (value as u16).to_le_bytes().to_vec(),
            "i32" => (value as i32).to_le_bytes().to_vec(),
            "u32" | "enum" => (value as u32).to_le_bytes().to_vec(),
            "u64" => (value as u64).to_le_bytes().to_vec(),
            other => {
                return Err(GhosttyError::message(format!(
                    "unsupported libghostty-vt field type: {other}"
                )));
            }
        };
        self.write(offset as i32, &bytes)
    }

    /// `GhosttyRuntime.readField`.
    pub fn read_field(
        &self,
        pointer: i32,
        struct_name: &str,
        field: &str,
    ) -> Result<i64, GhosttyError> {
        let field = self.field(struct_name, field)?.clone();
        let offset = pointer as usize + field.offset;
        let bytes = self.read(offset as i32, field.size)?;
        let take = |length: usize| -> i64 {
            let mut buffer = [0u8; 8];
            buffer[..length].copy_from_slice(&bytes[..length]);
            u64::from_le_bytes(buffer) as i64
        };
        Ok(match field.ty.as_str() {
            "bool" | "u8" => i64::from(bytes[0]),
            "u16" => take(2),
            "i32" => i64::from(i32::from_le_bytes(bytes[..4].try_into().expect("4 bytes"))),
            "u32" | "enum" => take(4),
            "u64" => take(8),
            other => {
                return Err(GhosttyError::message(format!(
                    "unsupported libghostty-vt field type: {other}"
                )));
            }
        })
    }

    /// `GhosttyRuntime.attachPtyWriter`, without the trampoline.
    ///
    /// The browser cannot put a JavaScript function into a wasm table, so it ships a 112-byte
    /// module that exports a wasm function which calls back into JS, and works around a WebKit
    /// bug that stores `grow(1, fn)` init values with broken type information. A wasmtime
    /// `Func` is a first-class table entry: `Func::wrap` gives the same
    /// `(terminal, userdata, data, len) -> ()` shape as `GhosttyTerminalWritePtyFn`
    /// (`ghostty/vt/terminal.h:416`), and `grow`-then-`set` matches what the browser host does.
    fn install_write_pty_callback(&mut self) -> Result<(), GhosttyError> {
        let index = self.table.size(&self.store) as u32;
        let callback = Func::wrap(
            &mut self.store,
            |mut caller: Caller<'_, WriterSlot>,
             _terminal: i32,
             _userdata: i32,
             pointer: i32,
             length: i32| {
                let Some(memory) = caller
                    .get_export("memory")
                    .and_then(|export| export.into_memory())
                else {
                    return;
                };
                let chunk = {
                    let data = memory.data(&caller);
                    let start = (pointer as usize).min(data.len());
                    let end = (start + length as usize).min(data.len());
                    data[start..end].to_vec()
                };
                // Callbacks fire inside `ghostty_terminal_vt_write` and must not re-enter it, so
                // this is the one place a writer may touch the terminal from — it gets a copy.
                if let Some(writer) = caller.data_mut().borrow_mut().as_mut() {
                    writer(&chunk);
                }
            },
        );
        self.table.grow(&mut self.store, 1, Ref::Func(None))?;
        self.table
            .set(&mut self.store, u64::from(index), Ref::Func(Some(callback)))?;
        self.callback_index = index;
        Ok(())
    }

    /// GHOSTTY_TERMINAL_OPT_USERDATA (0) and GHOSTTY_TERMINAL_OPT_WRITE_PTY (1), in the order
    /// the shipped host sets them.
    pub fn set_pty_writer(
        &mut self,
        terminal: i32,
        writer: impl FnMut(&[u8]) + 'static,
    ) -> Result<(), GhosttyError> {
        *self.writer.borrow_mut() = Some(Box::new(writer));
        self.call("ghostty_terminal_set", &[terminal, 0, 0])?;
        self.call(
            "ghostty_terminal_set",
            &[terminal, 1, self.callback_index as i32],
        )?;
        Ok(())
    }

    /// `GhosttyRuntime.detachPtyWriter`. `reset_and_write` in the shipped client clears the
    /// writer around a replay so a reset cannot answer queries from a half-built screen.
    pub fn clear_pty_writer(&mut self, terminal: i32) -> Result<(), GhosttyError> {
        self.call("ghostty_terminal_set", &[terminal, 1, 0])?;
        self.call("ghostty_terminal_set", &[terminal, 0, 0])?;
        *self.writer.borrow_mut() = None;
        Ok(())
    }
}

fn number(value: &serde_json::Value, key: &str) -> usize {
    value
        .get(key)
        .and_then(serde_json::Value::as_u64)
        .unwrap_or_default() as usize
}
