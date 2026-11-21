#![cfg(unix)]

use std::collections::BTreeSet;
use std::io::{self, BufRead, BufReader};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use lmcs_pty::native_pty::{NativePtyProcess, NativePtySpawner};
use lmcs_pty::node_pty::{PtyExitEvent, exit_event};
use lmcs_pty::reader::PtyReader;
use lmcs_pty::spawn::PtySpawnInput;
use lmcs_pty::{Delivery, Env, PendingEvent, Pipe, Platform, Sanitized, Spawner};

const DEADLINE: Duration = Duration::from_secs(10);

struct ChildGuard {
    process: Option<NativePtyProcess>,
    waited: bool,
}

impl ChildGuard {
    fn spawn(command: &str) -> Self {
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let env = Env::from_pairs([
            ("PATH".to_string(), "/usr/bin:/bin".to_string()),
            ("HOME".to_string(), cwd.clone()),
        ]);
        let args = vec!["-c".to_string(), command.to_string()];
        let platform = if cfg!(target_os = "macos") {
            Platform::Darwin
        } else {
            Platform::Linux
        };
        let process = NativePtySpawner::new(platform)
            .spawn(&PtySpawnInput {
                shell: "/bin/sh",
                args: Some(&args),
                cwd: &cwd,
                cols: 80,
                rows: 24,
                env: &env,
            })
            .unwrap();
        Self {
            process: Some(process),
            waited: false,
        }
    }

    fn process(&mut self) -> &mut NativePtyProcess {
        self.process.as_mut().unwrap()
    }

    fn wait(&mut self) -> PtyExitEvent {
        let exit = self.process().wait().unwrap();
        self.waited = true;
        exit
    }

    fn terminate(&mut self) -> PtyExitEvent {
        let mut process = self.process.take().unwrap();
        process.kill(Some("SIGKILL")).unwrap();
        process.close_and_wait().unwrap()
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if !self.waited
            && let Some(mut process) = self.process.take()
        {
            let _ = process.kill(Some("SIGKILL"));
            let _ = process.close_and_wait();
        }
    }
}

fn identity(_: &str, data: &str) -> Sanitized {
    Sanitized {
        visible: data.to_string(),
        pending: String::new(),
    }
}

fn collect(command: &str, acknowledge: Option<&str>) -> (Vec<String>, PtyExitEvent) {
    let mut child = ChildGuard::spawn(command);
    let mut reader = child.process().start_reader().unwrap();
    let mut pipe = Pipe::new();
    let pid = child.process().pid();
    assert_eq!(pipe.start(pid), 1);
    let mut chunks = Vec::new();
    let mut text = String::new();
    let mut acknowledged = false;
    while let Some(data) = reader.recv_timeout(DEADLINE).unwrap() {
        assert!(
            !data.is_empty(),
            "empty decoder writes are not data callbacks"
        );
        assert!(pipe.enqueue(pid, PendingEvent::Data(data.clone())));
        let event = pipe.drain_next(pid, identity).unwrap();
        assert_eq!(
            event,
            Delivery::Output {
                sequence: chunks.len() as u64 + 2,
                data: data.clone(),
                visible: data.clone(),
                history_grew: true,
            }
        );
        assert_eq!(pipe.drain_next(pid, identity), None);
        text.push_str(&data);
        chunks.push(data);
        if !acknowledged && acknowledge.is_some_and(|prefix| text.contains(prefix)) {
            acknowledged = true;
            child.process().write("\n").unwrap();
        }
    }
    let exit = child.wait();
    // Exit is still supplied by the owner after EOF; the reader itself never fabricates it.
    assert!(pipe.enqueue(pid, PendingEvent::Exit(exit)));
    assert_eq!(
        pipe.drain_next(pid, identity),
        Some(Delivery::Exit {
            sequence: chunks.len() as u64 + 2,
            exit_code: Some(exit.exit_code),
            exit_signal: exit.signal,
        })
    );
    assert_eq!(pipe.drain_next(pid, identity), None);
    (chunks, exit)
}

#[test]
fn large_output_reaches_the_pipe_before_the_owner_publishes_exit() {
    let (chunks, exit) = collect("printf '%1048576s' ''; printf 'tail\\n'", None);
    assert_eq!(
        chunks.concat(),
        format!("{}tail\r\n", " ".repeat(1_048_576))
    );
    assert!(chunks.len() > 64);
    assert_eq!(exit, exit_event(0, Some(0)));
}

#[test]
fn an_acknowledged_prefix_forces_split_utf8_across_thread_deliveries() {
    let (chunks, exit) = collect(
        "stty -echo; printf 'prefix\\303'; IFS= read -r ack; printf '\\251\\n'",
        Some("prefix"),
    );
    assert_eq!(chunks.first().map(String::as_str), Some("prefix"));
    assert!(chunks.len() >= 2);
    assert_eq!(chunks.concat(), "prefixé\r\n");
    assert_eq!(exit, exit_event(0, Some(0)));
}

fn stop_with_deadline(reader: PtyReader, explicit: bool) {
    let (done, completed) = mpsc::channel();
    let worker = thread::spawn(move || {
        let result = if explicit {
            reader.cancel()
        } else {
            drop(reader);
            Ok(())
        };
        done.send(result).unwrap();
    });
    completed
        .recv_timeout(DEADLINE)
        .expect("reader failed to join")
        .unwrap();
    worker.join().unwrap();
}

#[test]
fn cancel_and_drop_wake_an_idle_reader_without_killing_the_child() {
    for explicit in [true, false] {
        let mut child = ChildGuard::spawn("stty -echo; printf ready; IFS= read -r ack; exit 7");
        let mut reader = child.process().start_reader().unwrap();
        assert_eq!(
            reader.recv_timeout(DEADLINE).unwrap().as_deref(),
            Some("ready")
        );
        stop_with_deadline(reader, explicit);
        child.process().write("\n").unwrap();
        assert_eq!(child.wait(), exit_event(7, Some(0)));
    }
}

#[test]
fn cancel_during_output_joins_before_the_child_is_killed() {
    let mut child = ChildGuard::spawn("while :; do printf '%4096s' ''; done");
    let mut reader = child.process().start_reader().unwrap();
    assert!(!reader.recv_timeout(DEADLINE).unwrap().unwrap().is_empty());
    stop_with_deadline(reader, true);
    assert_eq!(child.terminate(), exit_event(0, Some(9)));
}

#[test]
fn output_can_only_be_owned_by_one_reader_even_after_cancellation() {
    let mut child = ChildGuard::spawn("stty -echo; printf ready; IFS= read -r ack; exit 0");
    let reader = child.process().start_reader().unwrap();
    assert_eq!(
        child.process().reader_mut().err().unwrap().kind(),
        io::ErrorKind::AlreadyExists
    );
    assert_eq!(
        child.process().start_reader().err().unwrap().kind(),
        io::ErrorKind::AlreadyExists
    );
    stop_with_deadline(reader, true);
    assert_eq!(
        child.process().start_reader().err().unwrap().kind(),
        io::ErrorKind::AlreadyExists
    );
}

#[test]
fn input_backpressure_preserves_the_full_write_after_starting_the_reader() {
    let mut child =
        ChildGuard::spawn("stty raw -echo; printf ready; dd bs=1 count=131072 2>/dev/null | wc -c");
    let mut reader = child.process().start_reader().unwrap();
    assert_eq!(
        reader.recv_timeout(DEADLINE).unwrap().as_deref(),
        Some("ready")
    );
    child.process().write(&"x".repeat(131_072)).unwrap();
    let mut output = String::new();
    while let Some(data) = reader.recv_timeout(DEADLINE).unwrap() {
        output.push_str(&data);
    }
    assert_eq!(output.trim(), "131072");
    assert_eq!(child.wait(), exit_event(0, Some(0)));
}

#[test]
fn child_status_is_observed_without_consuming_reader_eof_and_is_cached() {
    for (command, expected) in [
        ("exit 7", exit_event(7, Some(0))),
        ("kill -9 $$", exit_event(0, Some(9))),
    ] {
        let mut child = ChildGuard::spawn(&format!(
            "stty -echo; printf ready; IFS= read -r ack; {command}"
        ));
        let mut reader = child.process().start_reader().unwrap();
        assert_eq!(
            reader.recv_timeout(DEADLINE).unwrap().as_deref(),
            Some("ready")
        );
        assert_eq!(child.process().try_wait().unwrap(), None);
        let pid = child.process().pid();
        let (done, completion) = mpsc::channel();
        let observer = thread::spawn(move || {
            let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::uninit();
            loop {
                let result = unsafe {
                    libc::waitid(
                        libc::P_PID,
                        pid,
                        info.as_mut_ptr(),
                        libc::WEXITED | libc::WNOWAIT,
                    )
                };
                if result == 0 {
                    done.send(Ok(())).unwrap();
                    break;
                }
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::Interrupted {
                    done.send(Err(error)).unwrap();
                    break;
                }
            }
        });
        child.process().write("\n").unwrap();
        completion.recv_timeout(DEADLINE).unwrap().unwrap();
        observer.join().unwrap();
        assert_eq!(child.process().try_wait().unwrap(), Some(expected));
        assert_eq!(child.process().try_wait().unwrap(), Some(expected));
        assert_eq!(child.wait(), expected);
        assert_eq!(reader.recv_timeout(DEADLINE).unwrap(), None);
    }
}

#[test]
fn reader_output_matches_the_real_node_pty_probe() {
    let Ok(path) = std::env::var("LMCS_READER_TRACE") else {
        eprintln!("skipped reader live golden: set LMCS_READER_TRACE to the node-pty probe trace");
        return;
    };
    let file = std::fs::File::open(path).unwrap();
    let mut names = BTreeSet::new();
    for line in BufReader::new(file).lines() {
        let case: serde_json::Value = serde_json::from_str(&line.unwrap()).unwrap();
        let name = case["name"].as_str().unwrap();
        assert!(names.insert(name.to_string()), "duplicate case {name}");
        let deliveries = case["deliveries"].as_array().unwrap();
        let expected: String = deliveries
            .iter()
            .filter(|event| event["kind"] == "data")
            .map(|event| event["text"].as_str().unwrap())
            .collect();
        let (chunks, exit) = collect(
            case["command"].as_str().unwrap(),
            case["acknowledge"].as_str(),
        );
        assert_eq!(chunks.concat(), expected, "{name}");
        let last = deliveries.last().unwrap();
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
            assert_eq!(chunks[0], prefix, "{name}");
        }
    }
    let expected = [
        "burst",
        "splitMultibyte",
        "tailThenExit",
        "tailThenExitAgain",
        "incompleteTwoByteEof",
        "incompleteThreeByteEof",
        "incompleteFourByteEof",
        "invalidSurrogate",
        "invalidByte",
    ];
    assert_eq!(names, expected.into_iter().map(str::to_string).collect());
    eprintln!(
        "reader live golden: 9 real PTYs compared by full text and exit; OS read chunk sizes are not compared"
    );
}
