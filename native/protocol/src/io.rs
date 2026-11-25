//! The socket: bytes off a real connection in, bytes onto it out, and what the loop did to it.
//!
//! [`crate::transport`] is a function of bytes: `push(&[u8]) -> Output`, with no idea that a socket
//! exists. This module is the caller that hypothesis needs and cannot be tested by itself, because the
//! claims it makes only exist once something is reading the other end:
//!
//! - **A read is not a frame.** One `read` can hand back half a head, several frames, or a frame whose
//!   bytes arrived in two segments, and `Connection::push` is built for exactly that. The loop therefore
//!   owns no framing at all and never assumes a boundary.
//! - **The handshake and the first frame can share a segment.** A client that writes
//!   `GET /ws…\r\n\r\n` and then a `Request` quickly enough gets both into one read, so the bytes after
//!   the head's `CRLFCRLF` have to survive into the loop rather than be dropped with the buffer.
//! - **FIN is a decision, not a consequence.** `Output::hang_up` says whether *this* side finishes the
//!   socket, and the capture drew the line: a close the peer asked for and every framing fault FIN, the
//!   protocol's own `8800` does not (`upgrade-golden.ts`, `teardown.*`), so after a detach the loop keeps
//!   reading — and a peer that then sends its own close does get the FIN.
//! - **A refusal's own header is not the whole answer.** `ws`'s upgrade refusals carry `Connection:
//!   close` and the response pipeline's carry `keep-alive`, but two of the capture's `keep-alive` answers
//!   were followed by a FIN anyway (`handshake.postMethod`, `handshake.otherPath`) — the ones whose
//!   *request* asked for an upgrade and never got one. See [`keeps_alive`].
//! - **The route is the caller's.** `crate::transport::authenticated` examines the method only, so this
//!   layer is where [`Route::path`] is compared: a `GET /nope` with perfect upgrade headers gets the
//!   router's 404, not a `101` (`handshake.otherPath`).
//!
//! Nothing here knows the protocol's semantics, the ticket store, or the database: [`Route`] is those
//! callbacks, and the default implementations are what a golden needs (no attribution, no row). No
//! runtime either — the crate has no async dependency and this layer does not need one: one blocking
//! thread per connection, which is also what `ws` gives a socket.

use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;

use crate::auth::{CredentialNames, Replay, Stored, StoredSession};
use crate::http::Origin;
use crate::session::Group;
use crate::transport::{Connection, Seam};

/// `--max-http-header-size`'s Node default, which is the bound the shipped server runs with because
/// nothing in `apps/server` raises it. A head over it is finished with, not buffered forever.
pub const DEFAULT_MAX_HEAD: usize = 16 * 1024;

/// The route's side of one connection: what a [`Seam`] needs that this crate cannot own.
///
/// Every method has a default so a golden can drive a socket with a stub group and no store, and so the
/// fields a real server fills are named rather than guessed at the call site.
pub trait Route {
    /// The dispatch group, fresh per connection: `ws.ts:3811` builds the rpc layer around the session,
    /// so two sockets never share one [`Group`]'s in-flight state.
    fn group(&self) -> Group;

    /// The path the router mounts the websocket on. Nothing in [`crate::transport`] matches it — the
    /// seam only reads the method, and `authenticated` says so — so a request that misses the path has
    /// to be answered here, as the router answers it (`handshake.otherPath`).
    fn path(&self) -> &str {
        "/ws"
    }

    /// Whether the router hands this request to the websocket handler at all. Anything else is answered
    /// before auth, with the router's own 404 (`handshake.postMethod`, `handshake.otherPath`).
    fn matches(&self, request: &crate::http::Request<'_>) -> bool {
        request.method == "GET" && target(request.target) == self.path()
    }

    /// The wall clock in integer milliseconds, which is the caller's because Node stamps it per request.
    fn now(&self) -> i64 {
        0
    }

    /// The `Date` header for whatever the connection writes.
    fn date(&self) -> String {
        String::new()
    }

    /// The trace the response headers carry. The shipped route opens no span before auth, so the
    /// measured value is `"unavailable"`.
    fn trace_id(&self) -> String {
        "unavailable".to_owned()
    }

    /// The HMAC key for `wsTicket`.
    fn secret(&self) -> &[u8] {
        &[]
    }

    fn dev_session_id(&self) -> Option<&str> {
        None
    }

    /// The cookie names the credential-of-last-resort path reads.
    fn names(&self) -> CredentialNames<'_> {
        CredentialNames {
            session: "",
            legacy: None,
            dev: None,
        }
    }

    /// `authSessions.getById`.
    fn lookup(&self, _ticket_id: &str) -> Stored {
        Stored::Missing
    }

    /// `ServerSecretStore.create`, which a DPoP proof's `jti` spends itself through.
    fn record(&self, _key: &str, _value: &[u8]) -> Replay {
        Replay::Stored
    }

    /// The bound on a request head. See [`DEFAULT_MAX_HEAD`].
    fn max_head(&self) -> usize {
        DEFAULT_MAX_HEAD
    }

    /// The row's attribution and `markConnected`, which the route runs **before** writing the head:
    /// `seam.badKeyAuthorized` measured a refused socket that had already marked the row.
    fn attributed(&self, _session_id: &str, _origin: &Origin) {}

    /// `markDisconnected`, which the shipped route runs only when a connection it counted is gone.
    fn released(&self, _session_id: &str) {}
}

/// The socket operation `Read + Write` cannot name: finishing our half, which is what a client sees as
/// FIN. [`TcpStream`] is the one this layer serves; a test with an in-memory pipe can implement it too,
/// which is why `serve` is generic rather than welded to a TCP socket.
pub trait Socket: Read + Write {
    fn half_close(&mut self) -> std::io::Result<()>;
}

impl Socket for TcpStream {
    fn half_close(&mut self) -> std::io::Result<()> {
        self.shutdown(Shutdown::Write)
    }
}

/// What one connection ended as, from this side.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Ending {
    /// A head was answered without a socket: `Denied`, `Refused`, `NotUpgrade`, `NoRoute`.
    /// `keep_alive` is the answer's own `Connection` header, and it is what the caller does with the
    /// socket, so a port that always closed would be answering a 401 by dropping a keep-alive client.
    Http { keep_alive: bool },
    /// A websocket ran to the end of its socket. `hang_up` is whether this side FINed, which is the
    /// difference between the protocol's teardown (`8800`, TCP left for the peer) and everything else.
    Socket { hang_up: bool, frames: usize },
    /// The peer finished the connection before a whole request head arrived.
    Eof,
    /// The head outgrew [`Route::max_head`], so nothing was answered.
    TooLarge,
}

/// One connection, from the first byte to the last.
///
/// `Err` is a socket failure (the peer reset, the write went nowhere); an `Ok` is a protocol ending,
/// including every way the peer can hang up on us.
pub fn serve<S: Socket>(socket: &mut S, route: &dyn Route) -> std::io::Result<Ending> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 8 * 1024];
    let head_end = loop {
        if let Some(end) = head_finished(&buffer) {
            break end;
        }
        if buffer.len() > route.max_head() {
            return Ok(Ending::TooLarge);
        }
        let read = socket.read(&mut chunk)?;
        if read == 0 {
            return Ok(Ending::Eof);
        }
        buffer.extend_from_slice(&chunk[..read]);
    };

    let head = String::from_utf8_lossy(&buffer[..head_end]).into_owned();
    let request = crate::http::Request::parse(&head);
    let date = route.date();
    let trace_id = route.trace_id();
    let names = route.names();
    let mut lookup = |ticket_id: &str| route.lookup(ticket_id);
    let mut record = |key: &str, value: &[u8]| route.record(key, value);
    // The router's own step, which the seam deliberately does not take.
    let seam = if !route.matches(&request) {
        Seam::NoRoute {
            head: crate::http::routed(&date, crate::http::Routed::NoRoute),
        }
    } else {
        crate::transport::authenticated(
            &request,
            route.group(),
            route.now(),
            route.secret(),
            route.dev_session_id(),
            &names,
            &mut lookup,
            &mut record,
            &date,
            &trace_id,
        )
    };
    // The bytes past the head already belong to the socket: reading them here rather than re-reading is
    // the whole reason this function keeps a buffer instead of a `BufReader`.
    let mut pending = buffer.split_off(head_end);

    match seam {
        Seam::Connected {
            session_id,
            origin,
            head,
            mut connection,
        } => {
            route.attributed(&session_id, &origin);
            socket.write_all(&head)?;
            let ending = run(socket, &mut connection, &mut pending)?;
            route.released(&session_id);
            Ok(ending)
        }
        Seam::Denied { head, .. }
        | Seam::Refused { head, .. }
        | Seam::NotUpgrade { head, .. }
        | Seam::NoRoute { head } => {
            let keep_alive = keeps_alive(&head, request.upgrade.is_some());
            socket.write_all(&head)?;
            if !keep_alive {
                socket.half_close()?;
            }
            Ok(Ending::Http { keep_alive })
        }
    }
}

/// The loop, once the `101` is on the wire.
fn run<S: Socket>(
    socket: &mut S,
    connection: &mut Connection,
    pending: &mut Vec<u8>,
) -> std::io::Result<Ending> {
    let mut chunk = [0u8; 8 * 1024];
    let mut frames = 0;
    let mut hang_up = false;
    loop {
        if !pending.is_empty() {
            let input = std::mem::take(pending);
            let output = connection.push(&input);
            frames += write_frames(socket, &output.frames)?;
            if output.hang_up {
                socket.half_close()?;
                hang_up = true;
                break;
            }
            continue;
        }
        let read = socket.read(&mut chunk)?;
        // The peer's FIN. After a teardown this is the normal ending: the `8800` was written, TCP was
        // left alone, and the peer is the one who finishes it (`teardown.thenCanary`).
        if read == 0 {
            break;
        }
        pending.extend_from_slice(&chunk[..read]);
    }
    Ok(Ending::Socket { hang_up, frames })
}

/// Writes each frame as it was produced rather than one buffer for the whole `Output`, because the
/// capture's answers are one `socket.write` per frame and a coalesced write is a different set of
/// segments on the wire. Returns how many frames went out.
fn write_frames<S: Write>(socket: &mut S, frames: &[Vec<u8>]) -> std::io::Result<usize> {
    for frame in frames {
        socket.write_all(frame)?;
    }
    Ok(frames.len())
}

/// The index just past a request head's `CRLFCRLF`, or `None` while it is still arriving.
#[must_use]
pub fn head_finished(buffer: &[u8]) -> Option<usize> {
    buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|position| position + 4)
}

/// What the socket does after a non-`101` answer, which the capture says is **not** what the answer's own
/// header says. `ws`'s refusals say `Connection: close` and close. The router's two answers say
/// `keep-alive` — and the ones written to a request that carried an `Upgrade` header are destroyed anyway
/// (`handshake.postMethod`, `handshake.otherPath`), while the one written to a request that never asked
/// (`handshake.noUpgradeHeader`) is the only answer in the capture whose socket survived. A port that
/// trusted the header alone would be holding a socket Node lets go.
#[must_use]
pub fn keeps_alive(head: &[u8], asked_to_upgrade: bool) -> bool {
    !head_advertises_close(head) && !asked_to_upgrade
}

/// The answer's own `Connection` header, read for a `close` that is not a bare token of a longer list.
fn head_advertises_close(head: &[u8]) -> bool {
    let text = String::from_utf8_lossy(head);
    text.lines().any(|line| {
        let Some((name, value)) = line.split_once(':') else {
            return false;
        };
        name.trim().eq_ignore_ascii_case("connection")
            && value
                .split(',')
                .any(|token| token.trim().eq_ignore_ascii_case("close"))
    })
}

/// The path part of a request target: `/nope` and `/ws?t=1`, never the query.
fn target(target: &str) -> &str {
    target.split('?').next().unwrap_or(target)
}

/// A [`Route`] over a fixed group and a closed store, which is what a socket-level golden needs: the
/// dispatch answers, and the credential is whatever the golden minted.
pub struct Stub {
    pub group: fn() -> Group,
    /// The `Date` header for every answer. A golden hands over the capture's own placeholder
    /// (`"__DATE__"`) so the head comparison stays byte-exact.
    pub date: String,
    pub secret: Vec<u8>,
    /// The one row [`Self::lookup`] knows, which is how a golden presents a credential the seam accepts.
    pub session: Option<StoredSession>,
    /// The clock the ticket is checked against.
    pub now: i64,
    pub dev_session_id: Option<String>,
    pub path: String,
    pub max_head: usize,
}

impl Stub {
    #[must_use]
    pub fn new(group: fn() -> Group) -> Self {
        Self {
            group,
            date: String::new(),
            secret: Vec::new(),
            session: None,
            now: 0,
            dev_session_id: None,
            path: "/ws".to_owned(),
            max_head: DEFAULT_MAX_HEAD,
        }
    }
}

impl Route for Stub {
    fn group(&self) -> Group {
        (self.group)()
    }

    fn date(&self) -> String {
        self.date.clone()
    }

    fn path(&self) -> &str {
        &self.path
    }

    fn secret(&self) -> &[u8] {
        &self.secret
    }

    fn dev_session_id(&self) -> Option<&str> {
        self.dev_session_id.as_deref()
    }

    fn lookup(&self, session_id: &str) -> Stored {
        self.session
            .clone()
            .filter(|row| row.session_id == session_id)
            .map_or(Stored::Missing, Stored::Found)
    }

    fn max_head(&self) -> usize {
        self.max_head
    }
}

/// A listener that speaks one [`Route`], on a port the OS picked.
///
/// Dropping it stops accepting: the flag is checked after each `accept`, and the connect is what wakes
/// the blocked one, so the thread finishes rather than being abandoned.
pub struct Server {
    address: SocketAddr,
    stop: Arc<AtomicBool>,
    accepting: Option<JoinHandle<()>>,
}

impl Server {
    pub fn bind(route: Arc<dyn Route + Send + Sync>) -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let address = listener.local_addr()?;
        let stop = Arc::new(AtomicBool::new(false));
        let accepting = {
            let stop = Arc::clone(&stop);
            std::thread::spawn(move || {
                for accepted in listener.incoming() {
                    if stop.load(Ordering::SeqCst) {
                        return;
                    }
                    let Ok(mut socket) = accepted else { continue };
                    let route = Arc::clone(&route);
                    std::thread::spawn(move || {
                        let _ = serve(&mut socket, &*route);
                    });
                }
            })
        };
        Ok(Self {
            address,
            stop,
            accepting: Some(accepting),
        })
    }

    #[must_use]
    pub fn address(&self) -> SocketAddr {
        self.address
    }

    /// A client socket already pointed at this server, with `TCP_NODELAY` on: the golden writes whole
    /// frames, and whether the OS splits them is not what this layer controls.
    pub fn connect(&self) -> std::io::Result<TcpStream> {
        let socket = TcpStream::connect(self.address)?;
        socket.set_nodelay(true)?;
        Ok(socket)
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.address);
        if let Some(accepting) = self.accepting.take() {
            let _ = accepting.join();
        }
    }
}
