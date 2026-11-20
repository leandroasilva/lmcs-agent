//! Asks a real pseudo terminal the same questions the packaged `node-pty` was asked, so the
//! swap of PTY libraries is a measured difference rather than an assumed one.
//!
//! Run the other side on the same host and compare by eye:
//! `node apps/server/scripts/node-pty-child-probe.ts` prints one line per scenario, in the same
//! `key=value|key=value` shape this test parses. The scenarios that appear here are the ones both
//! probes can ask; the differences they showed are written into
//! [`lmcs_pty::native_pty`][native_pty].
//!
//! Nothing in here is a replay of a captured trace: these tests spawn, read the child's own
//! report, and wait for it, so they are the part of the port that can only be checked against an
//! operating system. They are also the reason [`Spawner`] exists as a seam — everything above it
//! is replayed by `node_pty_golden.rs` instead. The probe needs a POSIX shell, so the file is
//! empty on Windows.

#![cfg(unix)]

use std::io::Read;
use std::time::{Duration, Instant};

use lmcs_pty::env::Env;
use lmcs_pty::native_pty::{NativePtyProcess, NativePtySpawner};
use lmcs_pty::node_pty::{PtyExitEvent, exit_event};
use lmcs_pty::shell::ShellCandidate;
use lmcs_pty::spawn::{PtySpawnInput, SpawnTarget, is_retryable_shell_spawn_error, try_spawn};
use lmcs_pty::utf8::Utf8Decoder;
use lmcs_pty::{Platform, Spawner};

/// What the child is asked to report about itself, field for field the way
/// `apps/server/scripts/node-pty-child-probe.ts` asks it of the packaged `node-pty`. Every field
/// is one of the decisions the port makes: `term` and `terms` are the forced `TERM` and its single
/// entry, `leak` is a variable the parent process has and the spawn environment does not, `shell`
/// is the one neither library was given, `size` is the kernel's window (`rows` then `cols`, the
/// order `stty` prints and neither library's call spells), `pwd` is the cwd the manager asked for,
/// and `arg0`/`argc` are how the arguments arrive.
const PROBE: &str = concat!(
    "printf 'term=%s|terms=%s|marker=%s|leak=%s|shell=%s|size=%s|pwd=%s|arg0=%s|argc=%s\\n' ",
    "\"$TERM\" \"$(env | grep -c '^TERM=')\" spawned \"${CARGO_MANIFEST_DIR-}\" \"$SHELL\" ",
    "\"$(stty size < /dev/tty 2>/dev/null)\" \"$(/bin/pwd)\" \"$0\" \"$#\"",
);

/// A variable the test process always has (cargo sets it for the test binary) and no spawn
/// environment below ever names, so seeing it in the child means the server's environment leaked.
const LEAKED_KEY: &str = "CARGO_MANIFEST_DIR";

fn host_platform() -> Platform {
    // The `process.platform` spelling the shipped code reads, which is what [`Platform`] keys on.
    Platform::from_node_str(match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    })
}

/// The smallest environment a `/bin/sh` can run the probe in: `PATH` for the four programs the
/// probe calls, and a `HOME` for the shells that read one. Nothing else, which is the point.
fn minimal_env() -> Env {
    Env::from_pairs([
        ("PATH".to_string(), "/bin:/usr/bin".to_string()),
        (
            "HOME".to_string(),
            std::env::temp_dir().to_string_lossy().into_owned(),
        ),
    ])
}

fn sh(script: &str) -> Vec<String> {
    vec!["-c".to_string(), script.to_string()]
}

/// Opens one real terminal for a `/bin/sh`, the way the manager does it.
fn spawn_in(args: &[String], env: &Env, cols: u32, rows: u32) -> NativePtyProcess {
    let cwd = std::env::current_dir()
        .expect("a working directory to spawn from")
        .to_string_lossy()
        .into_owned();
    NativePtySpawner::new(host_platform())
        .spawn(&PtySpawnInput {
            shell: "/bin/sh",
            args: Some(args),
            cwd: &cwd,
            cols,
            rows,
            env,
        })
        .expect("the terminal opens")
}

/// A child that stays up until it is killed, so what a test measures is the kill. `exec` puts the
/// program under the pid the manager holds, which is how the shipped kill sequence reaches a shell.
fn spawn_waiting_child() -> NativePtyProcess {
    let args = sh("exec sleep 30");
    spawn_in(&args, &minimal_env(), 80, 24)
}

/// Runs one command in a real terminal and returns what the child wrote plus how it ended.
fn run(args: &[String], env: &Env, cols: u32, rows: u32) -> (String, PtyExitEvent) {
    let mut process = spawn_in(args, env, cols, rows);
    let mut reader = process.take_reader().expect("the output side");
    let output = read_until_eof(&mut reader);
    let event = process.wait().expect("the child is waited on");
    (output, event)
}

/// Reads to the end of the terminal, which is the child exiting, and gives up loudly rather than
/// letting a mutation hang the suite.
fn read_until_eof(reader: &mut dyn Read) -> String {
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => bytes.extend_from_slice(&buffer[..read]),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => panic!("the terminal output stopped: {error}"),
        }
        assert!(
            Instant::now() < deadline,
            "no end-of-output after 20s: {}",
            String::from_utf8_lossy(&bytes)
        );
    }
    // A pseudo terminal turns every newline into a carriage return plus one, and the shell may
    // echo nothing at all here, since nothing is ever written to it.
    String::from_utf8(bytes)
        .expect("the child wrote text")
        .replace("\r\n", "\n")
}

fn field(output: &str, key: &str) -> String {
    let line = output
        .lines()
        .find(|line| line.starts_with("term="))
        .unwrap_or_else(|| panic!("the probe line is missing from {output:?}"));
    line.split('|')
        .find_map(|part| part.strip_prefix(&format!("{key}=")))
        .unwrap_or_else(|| panic!("no {key}= in {line:?}"))
        .to_string()
}

#[test]
fn the_child_sees_the_terminal_the_port_asked_for_and_nothing_the_server_had() {
    let (output, event) = run(&sh(PROBE), &minimal_env(), 132, 43);

    assert_eq!(field(&output, "term"), "xterm-256color");
    assert_eq!(
        field(&output, "terms"),
        "1",
        "one TERM, not the library's and ours"
    );
    assert_eq!(field(&output, "marker"), "spawned");
    // Both libraries name a shell the caller never passed: `CommandBuilder` injects `SHELL` after
    // clearing, `node-pty`'s helper resolves the login shell. Measured as `shell=/bin/zsh`.
    assert!(!field(&output, "shell").is_empty());
    assert_eq!(
        field(&output, "leak"),
        "",
        "the server's {LEAKED_KEY} belongs to the server"
    );
    assert_eq!(
        field(&output, "size"),
        "43 132",
        "rows then cols, the kernel's order"
    );
    assert_eq!(
        field(&output, "pwd"),
        std::env::current_dir()
            .expect("a working directory")
            .canonicalize()
            .expect("that is a real directory")
            .to_string_lossy(),
        "the directory the manager named, not $HOME"
    );
    assert_eq!(field(&output, "arg0"), "/bin/sh");
    assert_eq!(
        field(&output, "argc"),
        "0",
        "the list is passed, not joined"
    );
    assert_eq!(event, exit_event(0, Some(0)));
}

#[test]
fn a_term_the_call_carried_is_overwritten_before_the_child_sees_it() {
    // The shipped adapter only sets TERM on Windows, and the Unix library overwrites it anyway;
    // measured on the packaged library as `termDumb`, `termEmpty` and the plain `probe`.
    for term in ["dumb", ""] {
        let env = Env::from_pairs([
            ("PATH".to_string(), "/bin:/usr/bin".to_string()),
            (
                "HOME".to_string(),
                std::env::temp_dir().to_string_lossy().into_owned(),
            ),
            ("TERM".to_string(), term.to_string()),
        ]);
        let (output, _) = run(&sh(PROBE), &env, 80, 24);
        assert_eq!(
            field(&output, "term"),
            "xterm-256color",
            "the child never sees the {term:?} the call carried"
        );
        assert_eq!(field(&output, "terms"), "1");
    }
}

#[test]
fn an_exit_is_a_code_and_a_kill_is_a_signal() {
    // Both numbers come from the same wait status the shipped adapter reads: `{3, 0}` for an exit
    // and `{0, 9}` for a kill, measured as `exit3` and `killSelf9`.
    assert_eq!(
        run(&sh("exit 0"), &minimal_env(), 80, 24).1,
        exit_event(0, Some(0))
    );
    assert_eq!(
        run(&sh("exit 3"), &minimal_env(), 80, 24).1,
        exit_event(3, Some(0))
    );
    assert_eq!(
        run(&sh("kill -9 $$"), &minimal_env(), 80, 24).1,
        exit_event(0, Some(9))
    );
    assert_eq!(
        run(&sh("kill -TERM $$"), &minimal_env(), 80, 24).1,
        exit_event(0, Some(15))
    );
}

#[test]
fn a_window_too_wide_for_the_kernel_narrows_the_way_it_did_before() {
    // 65539 is 3 mod 2^16: `unsigned short` truncation, which the packaged library also did
    // (`hugeCols` reported `size=3 3`), so neither library clamps.
    let (output, _) = run(&sh(PROBE), &minimal_env(), 65_539, 3);
    assert_eq!(field(&output, "size"), "3 3");
}

#[test]
fn resize_moves_the_window_the_kernel_holds_and_the_window_the_child_sees() {
    let mut process = spawn_waiting_child();

    assert_eq!(process.size().expect("the kernel's size").cols, 80);
    process.resize(100, 30).expect("a resize");
    let size = process.size().expect("the kernel's size");
    assert_eq!((size.cols, size.rows), (100, 30), "the swap happens once");

    // The same window from inside the child, which is the line the `resize` scenario of the
    // `node-pty` probe prints for a `resize(100, 30)`: `30 100`. The child only looks after it is
    // handed a line, so the resize is certainly first.
    let args = sh("read -r _ ; stty size < /dev/tty");
    let mut watching = spawn_in(&args, &minimal_env(), 80, 24);
    watching.resize(100, 30).expect("a resize");
    watching.write("\n").expect("the line the child waits for");
    let mut reader = watching
        .take_reader()
        .expect("the output side of the watching child");
    assert_eq!(read_until_eof(&mut reader).trim(), "30 100");
    assert_eq!(
        watching.wait().expect("the child is waited on"),
        exit_event(0, Some(0))
    );

    process
        .kill(Some("SIGTERM"))
        .expect("the manager's first kill");
    assert_eq!(
        process.wait().expect("the child is waited on"),
        exit_event(0, Some(15))
    );
}

#[test]
fn a_kill_with_no_signal_is_the_hangup_the_shipped_call_sends() {
    // `killNoSignal`: `node-pty`'s one-argument-less kill reports signal 1, and the shipped Windows
    // branch reaches that call by dropping the signal, so "no signal" carries a meaning here rather
    // than an absence of one.
    let mut process = spawn_waiting_child();
    process.kill(None).expect("the hangup");
    assert_eq!(
        process.wait().expect("the child is waited on"),
        exit_event(0, Some(1))
    );
}

#[test]
fn a_shell_that_is_not_there_fails_in_the_way_the_candidate_walk_needs() {
    let spawner = NativePtySpawner::new(host_platform());
    let env = minimal_env();
    let error = spawner
        .spawn(&PtySpawnInput {
            shell: "/bin/definitely-not-here",
            args: None,
            cwd: "/tmp",
            cols: 80,
            rows: 24,
            env: &env,
        })
        .expect_err("a missing shell cannot open a terminal");

    // The packaged library does not throw at all here, which is why the shipped walk never ran;
    // `portable-pty` resolves the program first and says ENOENT, which the retry predicate reads.
    assert!(
        is_retryable_shell_spawn_error(&error),
        "{:?}",
        error.messages()
    );
    assert_eq!(error.shell.as_deref(), Some("/bin/definitely-not-here"));
    assert_eq!(
        error.message(),
        "Failed to spawn PTY process '/bin/definitely-not-here' with node-pty."
    );
}

#[test]
fn the_walk_past_a_missing_shell_lands_on_the_one_that_is_there() {
    // The whole point of `try_spawn`, run against a real terminal: the first candidate is the
    // one the machine does not have.
    let spawner = NativePtySpawner::new(host_platform());
    let env = minimal_env();
    let candidates = [
        ShellCandidate {
            shell: "/bin/definitely-not-here".to_string(),
            args: None,
        },
        ShellCandidate {
            shell: "/bin/sh".to_string(),
            args: Some(sh(PROBE)),
        },
    ];
    let spawned = try_spawn(
        &spawner,
        &candidates,
        SpawnTarget {
            cwd: &std::env::current_dir()
                .expect("a working directory to spawn from")
                .to_string_lossy(),
            cols: 132,
            rows: 43,
            env: &env,
        },
    )
    .expect("the second shell is there");

    // The label is the command the manager reports, so it names the shell that worked and the
    // arguments it was given, not the one the machine turned out not to have.
    assert_eq!(
        spawned.shell_label,
        ["/bin/sh".to_string(), "-c".to_string(), PROBE.to_string()].join(" ")
    );
    let mut process: NativePtyProcess = spawned.process;
    let mut reader = process.take_reader().expect("the output side");
    let output = read_until_eof(&mut reader);
    assert_eq!(
        process.wait().expect("the child is waited on"),
        exit_event(0, Some(0))
    );
    assert_eq!(field(&output, "size"), "43 132");
    assert_eq!(field(&output, "term"), "xterm-256color");
}

#[test]
fn the_incremental_decoder_handles_real_pty_bytes_and_flushes_before_wait() {
    let cases = [
        ("printf 'prefix\\303\\251\\n'", "prefixé\r\n".to_string()),
        ("printf '\\342\\202\\254'", "€".to_string()),
        ("printf '\\360\\237\\230\\200'", "\u{1f600}".to_string()),
        ("printf 'prefix\\303'", "prefix\u{fffd}".to_string()),
        ("printf 'prefix\\342\\202'", "prefix\u{fffd}".to_string()),
        (
            "printf 'prefix\\360\\237\\230'",
            "prefix\u{fffd}".to_string(),
        ),
        (
            "printf 'prefix\\355\\240\\200'",
            "prefix\u{fffd}\u{fffd}\u{fffd}".to_string(),
        ),
        ("printf 'prefix\\377'", "prefix\u{fffd}".to_string()),
        ("printf '%131072s' ''", " ".repeat(131_072)),
    ];
    for (script, expected) in cases {
        for read_size in [1, 1024] {
            let mut process = spawn_in(&sh(script), &minimal_env(), 80, 24);
            let mut decoder = Utf8Decoder::new();
            let mut output = String::new();
            let mut buffer = vec![0_u8; read_size];
            loop {
                match process.reader_mut().read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => output.push_str(&decoder.write(&buffer[..read])),
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) => panic!("PTY read failed: {error}"),
                }
            }
            output.push_str(&decoder.finish());
            let event = process.wait().expect("the child is reaped");
            assert_eq!(output, expected, "{script}, read size {read_size}");
            assert_eq!(event, exit_event(0, Some(0)));
        }
    }
}
