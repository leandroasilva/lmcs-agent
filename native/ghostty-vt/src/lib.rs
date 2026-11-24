//! The terminal engine the shipped client already uses: `libghostty-vt`, compiled to
//! WebAssembly, running under a Rust host.
//!
//! Ported from `apps/web/src/terminal/ghostty/` (`runtime.ts` for the wasm host and `core.ts`
//! for the terminal). Decision #30 chose this over another Rust terminal crate and over linking
//! `libghostty-vt` natively: the same bytes the browser runs means the native client renders
//! what 200k users see today, and a golden can compare the two hosts cell for cell.
//!
//! The artifact is the one the web bundle already ships, so a build has exactly one engine.
//! `native/libghostty-vt/VERSION` is the pin, and the module reports it itself through
//! `ghostty_build_info`, which is what [`build_info`] checks.

pub mod runtime;
pub mod terminal;

pub use runtime::{GhosttyError, Layout, Runtime};
pub use terminal::{
    Cell, DEFAULT_BACKGROUND, DEFAULT_FOREGROUND, GhosttyTerminal, Row, Snapshot, Theme,
};

/// The engine, as the web client ships it.
pub const GHOSTTY_WASM: &[u8] =
    include_bytes!("../../../apps/web/src/terminal/ghostty/vendor/ghostty-vt.wasm");

/// `GHOSTTY_BUILD_INFO_*` tags from `ghostty/vt/build_info.h`.
pub const BUILD_INFO_VERSION_STRING: i32 = 5;
pub const BUILD_INFO_VERSION_BUILD: i32 = 10;

pub fn load_embedded() -> Result<Runtime, GhosttyError> {
    Runtime::load(GHOSTTY_WASM)
}

/// `ghostty_build_info(tag, GhosttyString *out)`.
///
/// The struct is written **inline** at the address passed: reading the slot as a pointer and
/// dereferencing again yields the string's own bytes reinterpreted as an address.
///
/// `GhosttyString` is not in the shipped client's vocabulary — `core.ts` never reads one — and its
/// fields are `pointer` and `usize`, which `GhosttyRuntime.readField` rejects, so the two words are
/// decoded here rather than through the layout-driven codec.
pub fn build_info(runtime: &mut Runtime, tag: i32) -> Result<String, GhosttyError> {
    let out = runtime.alloc(8)?;
    let result = runtime.call("ghostty_build_info", &[tag, out])?;
    let text = if result != 0 {
        String::new()
    } else {
        let words = runtime.read(out, 8)?;
        let pointer = u32::from_le_bytes(words[..4].try_into().expect("4 bytes")) as i32;
        let length = u32::from_le_bytes(words[4..][..4].try_into().expect("4 bytes")) as usize;
        String::from_utf8_lossy(&runtime.read(pointer, length)?).into_owned()
    };
    runtime.free(out, 8)?;
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The engine the web bundle ships and the headers the pin names are the same revision; a
    /// bump that moves one without the other changes what a terminal renders.
    #[test]
    fn embedded_engine_matches_the_pinned_revision() {
        let mut runtime = load_embedded().expect("load the shipped ghostty-vt.wasm");
        let commit = build_info(&mut runtime, BUILD_INFO_VERSION_BUILD).expect("build info");
        let pinned = include_str!("../../libghostty-vt/VERSION").trim();
        assert_eq!(commit, pinned);
        let version = build_info(&mut runtime, BUILD_INFO_VERSION_STRING).expect("version");
        assert!(
            version.contains(pinned),
            "version string {version} does not carry the pin {pinned}"
        );
    }

    /// `GhosttyRow` and `GhosttyCell` are `uint64_t` (`ghostty/vt/screen.h:40,51`) on a 32-bit
    /// module, so their getters take an `i64` where every other handle in the render path is an
    /// `i32`. Reading those as pointers asks the engine for a different row and fails the call.
    #[test]
    fn row_and_cell_handles_are_sixty_four_bits() {
        let module =
            wasmtime::Module::new(&wasmtime::Engine::default(), GHOSTTY_WASM).expect("parse wasm");
        for name in ["ghostty_row_get", "ghostty_cell_get"] {
            let export = module
                .exports()
                .find(|export| export.name() == name)
                .expect(name);
            let extern_type = export.ty();
            let signature = extern_type
                .func()
                .expect("the row and cell getters are functions");
            assert_eq!(
                // `ValType` is not `PartialEq`, so the module's own spelling is the comparison.
                signature
                    .params()
                    .map(|param| param.to_string())
                    .collect::<Vec<_>>()
                    .join(", "),
                "i64, i32, i32",
                "{name} changed shape"
            );
        }
    }

    #[test]
    fn the_module_describes_its_own_layouts() {
        let runtime = load_embedded().expect("load the shipped ghostty-vt.wasm");
        for name in [
            "GhosttyTerminalOptions",
            "GhosttyStyle",
            "GhosttyTerminalScrollViewport",
            "GhosttyString",
        ] {
            let layout = runtime.layout(name).expect(name);
            assert!(layout.size > 0, "{name} has no size");
        }
        // The offsets the port reads, with the values the first probe measured.
        assert_eq!(
            runtime
                .field("GhosttyTerminalOptions", "cols")
                .expect("cols")
                .offset,
            0
        );
        assert_eq!(
            runtime
                .field("GhosttyTerminalOptions", "rows")
                .expect("rows")
                .offset,
            2
        );
    }
}
