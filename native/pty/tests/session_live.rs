#![cfg(any(target_os = "macos", target_os = "linux"))]

use std::collections::BTreeSet;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use lmcs_pty::native_pty::NativePtySpawner;
use lmcs_pty::node_pty::{PtyExitEvent, exit_event};
use lmcs_pty::output::TerminalOutput;
use lmcs_pty::session::{PtySession, SessionEvent};
use lmcs_pty::spawn::PtySpawnInput;
use lmcs_pty::{Delivery, Env, PendingEvent, Pipe, Platform, Sanitized};

const DEADLINE: Duration = Duration::from_secs(10);

fn spawn(command: &str) -> PtySession {
    let cwd = std::env::temp_dir().to_string_lossy().into_owned();
    let env = Env::from_pairs([
        ("PATH".to_string(), "/usr/bin:/bin".to_string()),
        ("HOME".to_string(), cwd.clone()),
    ]);
    let args = vec!["-c".to_string(), command.to_string()];
    PtySession::spawn(
        NativePtySpawner::new(if cfg!(target_os = "macos") {
            Platform::Darwin
        } else {
            Platform::Linux
        }),
        &PtySpawnInput {
            shell: "/bin/sh",
            args: Some(&args),
            cwd: &cwd,
            cols: 80,
            rows: 24,
            env: &env,
        },
    )
    .unwrap()
}

fn collect(command: &str, acknowledge: Option<&str>) -> (Vec<String>, PtyExitEvent) {
    let mut session = spawn(command);
    let mut chunks = Vec::new();
    let mut acknowledged = false;
    let exit = loop {
        match session
            .recv_timeout(DEADLINE)
            .unwrap()
            .expect("exit must precede closure")
        {
            SessionEvent::Data(text) => {
                assert!(!text.is_empty());
                chunks.push(text);
                if !acknowledged
                    && acknowledge.is_some_and(|prefix| chunks.concat().contains(prefix))
                {
                    acknowledged = true;
                    assert_eq!(session.try_write(b"\n").unwrap(), 1);
                }
            }
            SessionEvent::Exit(exit) => break exit,
            SessionEvent::Writable => panic!("unrequested writable notification"),
        }
    };
    assert_eq!(session.recv().unwrap(), None);
    assert_eq!(session.recv_timeout(Duration::ZERO).unwrap(), None);
    assert_eq!(
        session.try_write(b"late").unwrap_err().kind(),
        io::ErrorKind::NotConnected
    );
    (chunks, exit)
}

#[test]
fn output_and_incomplete_utf8_arrive_before_exactly_one_exit() {
    let (chunks, exit) = collect("printf '%1048576s' ''; printf 'tail\\303'; exit 7", None);
    assert_eq!(
        chunks.concat(),
        format!("{}tail\u{fffd}", " ".repeat(1_048_576))
    );
    assert_eq!(exit, exit_event(7, Some(0)));
    assert!(chunks.len() > 64);
}

#[test]
fn controls_remain_available_while_exit_observation_is_blocked() {
    let mut session =
        spawn("stty -echo; printf ready; IFS= read -r ack; stty size; IFS= read -r ack");
    assert_eq!(
        session.recv_timeout(DEADLINE).unwrap(),
        Some(SessionEvent::Data("ready".to_string()))
    );
    assert_eq!(
        session.recv_timeout(Duration::ZERO).unwrap_err().kind(),
        io::ErrorKind::TimedOut
    );
    session.resize(132, 43).unwrap();
    assert_eq!(session.try_write(b"\n").unwrap(), 1);
    let mut text = String::new();
    while !text.contains("43 132") {
        let Some(SessionEvent::Data(data)) = session.recv_timeout(DEADLINE).unwrap() else {
            panic!("child exited before control input")
        };
        text.push_str(&data);
    }
    session.kill(Some("SIGKILL")).unwrap();
    loop {
        match session.recv_timeout(DEADLINE).unwrap().unwrap() {
            SessionEvent::Data(_) => (),
            SessionEvent::Writable => panic!("unrequested writable notification"),
            SessionEvent::Exit(exit) => {
                assert_eq!(exit, exit_event(0, Some(9)));
                break;
            }
        }
    }
    assert_eq!(session.recv().unwrap(), None);
}

#[test]
fn large_duplex_input_makes_progress_without_blocking_output_or_controls() {
    let (done, receipt) = mpsc::channel();
    let worker = thread::spawn(move || {
        let mut session = spawn("stty raw -echo; printf ready; exec cat");
        assert_eq!(
            session.recv_timeout(DEADLINE).unwrap(),
            Some(SessionEvent::Data("ready".to_string()))
        );
        let input = "x€𐀀".repeat(2_097_152);
        let mut written = session.try_write(input.as_bytes()).unwrap();
        assert!(
            written > 0 && written < input.len(),
            "large input must allow partial progress"
        );
        session.resize(132, 43).unwrap();
        session.request_writable().unwrap();
        let mut output = String::new();
        let mut notifications = 0;
        while output.len() < input.len() {
            match session.recv_timeout(DEADLINE).unwrap().unwrap() {
                SessionEvent::Writable => {
                    notifications += 1;
                    match session.try_write(&input.as_bytes()[written..]) {
                        Ok(0) => panic!("input made no progress"),
                        Ok(count) => written += count,
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => (),
                        Err(error) => panic!("input failed: {error}"),
                    }
                    if written < input.len() {
                        session.request_writable().unwrap();
                    }
                }
                SessionEvent::Data(data) => output.push_str(&data),
                SessionEvent::Exit(_) => panic!("exit before echoed input"),
            }
        }
        assert!(notifications > 0);
        assert_eq!(written, input.len());
        assert_eq!(output, input);
        session.kill(Some("SIGKILL")).unwrap();
        assert_eq!(
            session.recv_timeout(DEADLINE).unwrap(),
            Some(SessionEvent::Exit(exit_event(0, Some(9))))
        );
        assert_eq!(session.recv().unwrap(), None);
        done.send(()).unwrap();
    });
    receipt
        .recv_timeout(DEADLINE)
        .expect("duplex input stalled the session");
    worker.join().unwrap();
}

#[test]
fn cancellation_and_drop_join_workers_and_reap_idle_or_busy_children() {
    for command in [
        "stty -echo; printf ready; IFS= read -r ack",
        "while :; do printf '%4096s' ''; done",
    ] {
        for explicit in [false, true] {
            let mut session = spawn(command);
            assert!(matches!(
                session.recv_timeout(DEADLINE).unwrap(),
                Some(SessionEvent::Data(_))
            ));
            let pid = session.pid();
            let (done, receipt) = mpsc::channel();
            let worker = thread::spawn(move || {
                let result = if explicit {
                    session.cancel()
                } else {
                    drop(session);
                    Ok(())
                };
                done.send(result).unwrap();
            });
            receipt
                .recv_timeout(DEADLINE)
                .expect("session cancellation stalled")
                .unwrap();
            worker.join().unwrap();
            let mut status = 0;
            assert_eq!(
                unsafe { libc::waitpid(pid as libc::pid_t, &mut status, libc::WNOHANG) },
                -1
            );
            assert_eq!(
                io::Error::last_os_error().raw_os_error(),
                Some(libc::ECHILD)
            );
        }
    }
}

const SILENT_INPUT_BYTES: usize = 2_097_152;

fn fill_input(session: &mut PtySession, input: &[u8]) -> usize {
    let mut written = 0;
    loop {
        assert!(
            written < input.len(),
            "fixture must hold input backpressure"
        );
        match session.try_write(&input[written..]) {
            Ok(0) => panic!("input made no progress"),
            Ok(count) => written += count,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return written,
            Err(error) => panic!("input failed: {error}"),
        }
    }
}

#[test]
fn writable_notifications_resume_input_without_any_child_output() {
    let fixture = Fixture::new();
    let mut session = fixture.spawn("input");
    let mut control = fixture.accept();
    receive_through(&mut session, "input-ready");
    let input = "x€𐀀".repeat(SILENT_INPUT_BYTES / 8);
    let mut written = fill_input(&mut session, input.as_bytes());
    assert!(written > 0);
    session.request_writable().unwrap();
    session.resize(132, 43).unwrap();
    control.write_all(b"r").unwrap();
    let mut notifications = 0;
    while written < input.len() {
        assert_eq!(
            session.recv_timeout(DEADLINE).unwrap(),
            Some(SessionEvent::Writable),
            "the child emits no output while receiving input"
        );
        notifications += 1;
        match session.try_write(&input.as_bytes()[written..]) {
            Ok(0) => panic!("input made no progress"),
            Ok(count) => written += count,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => (),
            Err(error) => panic!("input failed: {error}"),
        }
        if written < input.len() {
            session.request_writable().unwrap();
        }
    }
    assert!(notifications > 0);
    receipt(&mut control, b'd');
    control.write_all(b"q").unwrap();
    assert_eq!(
        session.recv_timeout(DEADLINE).unwrap(),
        Some(SessionEvent::Exit(exit_event(7, Some(0))))
    );
    assert_eq!(session.recv().unwrap(), None);
    assert_eq!(
        session.request_writable().unwrap_err().kind(),
        io::ErrorKind::NotConnected
    );
}

#[test]
fn cancellation_and_drop_reap_with_writable_observation_pending() {
    for explicit in [false, true] {
        let fixture = Fixture::new();
        let mut session = fixture.spawn("input");
        let _control = fixture.accept();
        receive_through(&mut session, "input-ready");
        fill_input(&mut session, &vec![b'x'; SILENT_INPUT_BYTES]);
        session.request_writable().unwrap();
        let pid = session.pid();
        let (done, completion) = mpsc::channel();
        let worker = thread::spawn(move || {
            let result = if explicit {
                session.cancel()
            } else {
                drop(session);
                Ok(())
            };
            done.send(result).unwrap();
        });
        completion.recv_timeout(DEADLINE).unwrap().unwrap();
        worker.join().unwrap();
        let mut status = 0;
        assert_eq!(
            unsafe { libc::waitpid(pid as libc::pid_t, &mut status, libc::WNOHANG) },
            -1
        );
        assert_eq!(
            io::Error::last_os_error().raw_os_error(),
            Some(libc::ECHILD)
        );
    }
}

#[test]
fn exit_does_not_wait_for_the_child_to_accept_remaining_input() {
    let fixture = Fixture::new();
    let mut session = fixture.spawn("input");
    let mut control = fixture.accept();
    receive_through(&mut session, "input-ready");
    fill_input(&mut session, &vec![b'x'; SILENT_INPUT_BYTES]);
    session.request_writable().unwrap();
    control.write_all(b"q").unwrap();
    let mut notifications = 0;
    loop {
        match session.recv_timeout(DEADLINE).unwrap().unwrap() {
            SessionEvent::Writable => {
                notifications += 1;
                assert!(notifications <= 1);
            }
            SessionEvent::Exit(exit) => {
                assert_eq!(exit, exit_event(7, Some(0)));
                break;
            }
            SessionEvent::Data(text) => panic!("unexpected output: {text:?}"),
        }
    }
    assert_eq!(session.recv().unwrap(), None);
}

static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);

struct Fixture {
    listener: UnixListener,
    path: std::path::PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "pty-{}-{}.sock",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        let listener = UnixListener::bind(&path).unwrap();
        Self { listener, path }
    }

    fn spawn(&self, mode: &str) -> PtySession {
        let executable = std::env::current_exe().unwrap();
        let env = Env::from_pairs([
            ("LMCS_PTY_FIXTURE".to_string(), mode.to_string()),
            (
                "LMCS_PTY_CONTROL".to_string(),
                self.path.to_string_lossy().into_owned(),
            ),
        ]);
        let args = vec![
            "--exact".to_string(),
            "session_fixture".to_string(),
            "--nocapture".to_string(),
        ];
        PtySession::spawn(
            NativePtySpawner::new(if cfg!(target_os = "macos") {
                Platform::Darwin
            } else {
                Platform::Linux
            }),
            &PtySpawnInput {
                shell: executable.to_str().unwrap(),
                args: Some(&args),
                cwd: "/",
                cols: 80,
                rows: 24,
                env: &env,
            },
        )
        .unwrap()
    }

    fn accept(&self) -> UnixStream {
        let mut poll = libc::pollfd {
            fd: self.listener.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        assert_eq!(
            unsafe { libc::poll(&mut poll, 1, DEADLINE.as_millis() as i32) },
            1,
            "fixture failed to connect"
        );
        let (stream, _) = self.listener.accept().unwrap();
        stream.set_read_timeout(Some(DEADLINE)).unwrap();
        stream.set_write_timeout(Some(DEADLINE)).unwrap();
        stream
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn receipt(stream: &mut UnixStream, expected: u8) {
    let mut byte = [0];
    stream.read_exact(&mut byte).unwrap();
    assert_eq!(byte[0], expected);
}

fn fixture_command(stream: &mut UnixStream) -> u8 {
    let mut byte = [0];
    if stream.read_exact(&mut byte).is_err() {
        unsafe { libc::_exit(0) };
    }
    byte[0]
}

#[test]
fn session_fixture() {
    let Ok(mode) = std::env::var("LMCS_PTY_FIXTURE") else {
        return;
    };
    unsafe {
        libc::signal(libc::SIGHUP, libc::SIG_IGN);
    }
    let path = std::env::var("LMCS_PTY_CONTROL").unwrap();
    let mut control = UnixStream::connect(&path).unwrap();
    control.set_read_timeout(Some(DEADLINE)).unwrap();
    match mode.as_str() {
        "input" => {
            let mut termios = std::mem::MaybeUninit::<libc::termios>::uninit();
            assert_eq!(unsafe { libc::tcgetattr(0, termios.as_mut_ptr()) }, 0);
            let mut termios = unsafe { termios.assume_init() };
            unsafe { libc::cfmakeraw(&mut termios) };
            assert_eq!(unsafe { libc::tcsetattr(0, libc::TCSANOW, &termios) }, 0);
            std::io::stdout().write_all(b"input-ready").unwrap();
            std::io::stdout().flush().unwrap();
            if fixture_command(&mut control) == b'q' {
                unsafe { libc::_exit(7) };
            }
            let pattern = "x€𐀀".as_bytes();
            let mut total = 0;
            let mut buffer = [0; 4096];
            while total < SILENT_INPUT_BYTES {
                let count = std::io::stdin().read(&mut buffer).unwrap();
                assert!(count > 0 && total + count <= SILENT_INPUT_BYTES);
                for (index, byte) in buffer[..count].iter().enumerate() {
                    assert_eq!(*byte, pattern[(total + index) % pattern.len()]);
                }
                total += count;
            }
            control.write_all(b"d").unwrap();
            assert_eq!(fixture_command(&mut control), b'q');
            unsafe { libc::_exit(7) };
        }
        "eof" => {
            std::io::stdout().write_all(b"before-eof").unwrap();
            std::io::stdout().flush().unwrap();
            assert_eq!(fixture_command(&mut control), b'c');
            for fd in [0, 1, 2] {
                unsafe {
                    libc::close(fd);
                }
            }
            control.write_all(b"c").unwrap();
            assert_eq!(fixture_command(&mut control), b'q');
            unsafe { libc::_exit(7) };
        }
        "parent" => {
            #[expect(
                clippy::zombie_processes,
                reason = "This fixture exits first so the surviving descendant is reparented."
            )]
            let _descendant = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "session_fixture", "--nocapture"])
                .env("LMCS_PTY_FIXTURE", "descendant")
                .spawn()
                .unwrap();
            control.write_all(b"p").unwrap();
            assert_eq!(fixture_command(&mut control), b'q');
            unsafe { libc::_exit(7) };
        }
        "descendant" => {
            std::io::stdout().write_all(b"held-prefix\xc3").unwrap();
            std::io::stdout().flush().unwrap();
            control.write_all(b"d").unwrap();
            assert_eq!(fixture_command(&mut control), b'q');
            unsafe { libc::_exit(0) };
        }
        other => panic!("unknown fixture {other}"),
    }
}

fn receive_through(session: &mut PtySession, marker: &str) -> String {
    let mut text = String::new();
    while !text.contains(marker) {
        let Some(SessionEvent::Data(data)) = session.recv_timeout(DEADLINE).unwrap() else {
            panic!("exit before {marker}")
        };
        text.push_str(&data);
    }
    text
}

#[test]
fn closing_output_does_not_replace_the_later_child_status() {
    let fixture = Fixture::new();
    let mut session = fixture.spawn("eof");
    let mut control = fixture.accept();
    receive_through(&mut session, "before-eof");
    control.write_all(b"c").unwrap();
    receipt(&mut control, b'c');
    let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
    assert_eq!(
        unsafe {
            libc::waitid(
                libc::P_PID,
                session.pid(),
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOWAIT | libc::WNOHANG,
            )
        },
        0
    );
    assert_eq!(
        unsafe { info.assume_init().si_pid() },
        0,
        "child must still be alive after closing output"
    );
    control.write_all(b"q").unwrap();
    assert_eq!(
        session.recv_timeout(DEADLINE).unwrap(),
        Some(SessionEvent::Exit(exit_event(7, Some(0))))
    );
    assert_eq!(session.recv().unwrap(), None);
}

#[test]
fn a_surviving_descendant_does_not_prevent_session_exit() {
    let fixture = Fixture::new();
    let mut session = fixture.spawn("parent");
    let mut parent = fixture.accept();
    receipt(&mut parent, b'p');
    let mut descendant = fixture.accept();
    receipt(&mut descendant, b'd');
    let mut text = receive_through(&mut session, "held-prefix");
    let started = Instant::now();
    parent.write_all(b"q").unwrap();
    loop {
        match session.recv_timeout(DEADLINE).unwrap().unwrap() {
            SessionEvent::Data(data) => text.push_str(&data),
            SessionEvent::Writable => panic!("unrequested writable notification"),
            SessionEvent::Exit(exit) => {
                assert_eq!(exit, exit_event(7, Some(0)));
                break;
            }
        }
    }
    if cfg!(target_os = "macos") {
        assert!(
            text.ends_with("held-prefix\u{fffd}"),
            "macOS closes the slave when its session leader exits: {text:?}"
        );
    } else {
        assert!(
            started.elapsed() >= Duration::from_millis(200),
            "stream closed without the drain deadline"
        );
        assert!(
            !text.contains('\u{fffd}'),
            "forced closure must discard the incomplete character: {text:?}"
        );
    }
    eprintln!(
        "surviving descendant: exit after {:?}, EOF replacement={}",
        started.elapsed(),
        text.contains('\u{fffd}')
    );
    assert_eq!(session.recv().unwrap(), None);
    descendant.write_all(b"q").unwrap();
    assert_eq!(descendant.read(&mut [0]).unwrap(), 0);
}

fn identity(_: &str, text: &str) -> Sanitized {
    Sanitized {
        visible: text.to_string(),
        pending: String::new(),
    }
}

#[test]
fn the_pipe_receives_data_then_exit_with_its_original_walker_rules() {
    let mut session = spawn("printf tail; exit 3");
    let pid = session.pid();
    let mut pipe = Pipe::new();
    assert_eq!(pipe.start(pid), 1);
    for expected in [true, false] {
        let event = match session.recv_timeout(DEADLINE).unwrap().unwrap() {
            SessionEvent::Data(data) => PendingEvent::Data(data),
            SessionEvent::Exit(exit) => PendingEvent::Exit(exit),
            SessionEvent::Writable => panic!("unrequested writable notification"),
        };
        assert_eq!(pipe.enqueue(pid, event), expected);
    }
    assert_eq!(session.recv().unwrap(), None);
    assert_eq!(
        pipe.drain_next(pid, identity),
        Some(Delivery::Output {
            sequence: 2,
            data: "tail".to_string(),
            visible: "tail".to_string(),
            history_grew: true,
        })
    );
    assert_eq!(
        pipe.drain_next(pid, identity),
        Some(Delivery::Exit {
            sequence: 3,
            exit_code: Some(3),
            exit_signal: Some(0)
        })
    );
    assert_eq!(pipe.drain_next(pid, identity), None);
}

#[test]
fn real_pty_output_updates_bounded_history_without_sanitizing_live_data() {
    let mut session = spawn(
        "stty -echo; printf 'prefix\\033[6'; IFS= read -r ack; \
         printf 'n\\033[31mred\\033[0m'; printf '%1048576s' ''; printf 'tail\\303'; exit 7",
    );
    let pid = session.pid();
    let mut output = TerminalOutput::new(lmcs_terminal_history::BoundedHistory::with_limits(
        2,
        64,
        b"restored\n",
    ));
    assert_eq!(output.start(pid), 1);
    let mut raw = String::new();
    let mut sequence = 1;
    let mut waiting_to_acknowledge = false;
    let mut acknowledged = false;
    loop {
        let event = match session.recv_timeout(DEADLINE).unwrap().unwrap() {
            SessionEvent::Data(data) => PendingEvent::Data(data),
            SessionEvent::Exit(exit) => PendingEvent::Exit(exit),
            SessionEvent::Writable => {
                assert!(waiting_to_acknowledge && !acknowledged);
                assert_eq!(output.sequence(), sequence);
                assert_eq!(output.history().value(), b"restored\nprefix");
                assert_eq!(session.try_write(b"\n").unwrap(), 1);
                acknowledged = true;
                continue;
            }
        };
        assert!(output.enqueue(pid, event));
        sequence += 1;
        match output.drain_next(pid).unwrap() {
            Delivery::Output {
                sequence: stamp,
                data,
                ..
            } => {
                assert_eq!(stamp, sequence);
                raw.push_str(&data);
            }
            Delivery::Exit {
                sequence: stamp,
                exit_code,
                exit_signal,
            } => {
                assert_eq!(stamp, sequence);
                assert_eq!((exit_code, exit_signal), (Some(7), Some(0)));
                break;
            }
        }
        assert_eq!(output.drain_next(pid), None);
        assert!(output.history().bytes() <= 64);
        if !waiting_to_acknowledge && raw.ends_with("prefix\x1b[6") {
            assert_eq!(output.history().value(), b"restored\nprefix");
            waiting_to_acknowledge = true;
            session.request_writable().unwrap();
        }
    }
    assert!(acknowledged);
    assert_eq!(
        raw,
        format!(
            "prefix\x1b[6n\x1b[31mred\x1b[0m{}tail\u{fffd}",
            " ".repeat(1_048_576)
        )
    );
    assert_eq!(
        output.history().value(),
        format!("{}tail\u{fffd}", " ".repeat(57)).as_bytes()
    );
    assert_eq!(output.history().bytes(), 64);
    assert_eq!(output.drain_next(pid), None);
    assert_eq!(session.recv().unwrap(), None);
    assert!(!output.enqueue(pid, PendingEvent::Data("late".to_string())));
}

#[test]
fn session_matches_the_nine_real_node_pty_scenarios() {
    let Ok(path) = std::env::var("LMCS_READER_TRACE") else {
        eprintln!("skipped session live golden: set LMCS_READER_TRACE");
        return;
    };
    let mut names = BTreeSet::new();
    for line in BufReader::new(std::fs::File::open(path).unwrap()).lines() {
        let case: serde_json::Value = serde_json::from_str(&line.unwrap()).unwrap();
        let name = case["name"].as_str().unwrap();
        assert!(names.insert(name.to_string()));
        let (chunks, exit) = collect(
            case["command"].as_str().unwrap(),
            case["acknowledge"].as_str(),
        );
        let events = case["deliveries"].as_array().unwrap();
        let expected: String = events
            .iter()
            .filter(|event| event["kind"] == "data")
            .map(|event| event["text"].as_str().unwrap())
            .collect();
        assert_eq!(chunks.concat(), expected, "{name}");
        let last = events.last().unwrap();
        assert_eq!(last["kind"], "exit");
        assert_eq!(
            Some(i64::from(exit.exit_code)),
            last["code"].as_i64(),
            "{name}"
        );
        assert_eq!(
            exit.signal.map(i64::from),
            last["signal"].as_i64(),
            "{name}"
        );
        if let Some(prefix) = case["acknowledge"].as_str() {
            assert_eq!(chunks[0], prefix);
        }
    }
    assert_eq!(
        names,
        [
            "burst",
            "splitMultibyte",
            "tailThenExit",
            "tailThenExitAgain",
            "incompleteTwoByteEof",
            "incompleteThreeByteEof",
            "incompleteFourByteEof",
            "invalidSurrogate",
            "invalidByte"
        ]
        .into_iter()
        .map(str::to_string)
        .collect()
    );
    eprintln!(
        "session live golden: 9 real PTYs, full output and automatically observed exit compared"
    );
}
