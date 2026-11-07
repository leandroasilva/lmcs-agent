use lmcs_output_window::{
    FromClient, FromServer, MAX_PENDING_BYTES, OutputWindow, Receive, Send, TRACKED_METHODS,
};

const CLIENT: &str = "desktop";
const REQUEST: &str = "1";

fn request(method: &str) -> FromClient {
    FromClient::Request {
        id: REQUEST.to_owned(),
        method: method.to_owned(),
    }
}

/// The transport core holds one credit: it may emit a chunk only once the
/// previous one was acknowledged, by us on the client's behalf or by the client.
struct Stream {
    window: OutputWindow,
    credit: bool,
    delivered: usize,
}

impl Stream {
    fn new(method: &str) -> Self {
        let mut window = OutputWindow::new();
        assert_eq!(window.on_client(CLIENT, request(method)), Receive::Forward);
        Self {
            window,
            credit: true,
            delivered: 0,
        }
    }

    /// Returns false when the window had no credit left for this chunk.
    fn emit(&mut self, encoded_len: usize) -> bool {
        if !self.credit {
            return false;
        }
        self.credit = matches!(
            self.window.on_server(
                CLIENT,
                FromServer::Chunk {
                    request_id: REQUEST.to_owned(),
                    encoded_len,
                },
            ),
            Send::DeliverAndAck
        );
        self.delivered += 1;
        true
    }

    /// A real ack arrives from the client. Returns whether the core saw it.
    fn client_ack(&mut self) -> bool {
        let forwarded = self.window.on_client(
            CLIENT,
            FromClient::Ack {
                request_id: REQUEST.to_owned(),
            },
        ) == Receive::Forward;
        self.credit |= forwarded;
        forwarded
    }
}

#[test]
fn widens_streamed_methods_to_eight_one_byte_chunks() {
    for method in TRACKED_METHODS {
        let mut stream = Stream::new(method);
        for _ in 0..8 {
            assert!(stream.emit(1), "{method} should keep flowing");
        }
        assert_eq!(stream.delivered, 8, "{method}");
        assert!(!stream.emit(1), "{method} should stall past the cap");
        assert!(stream.client_ack(), "{method}");
        assert!(stream.emit(1), "{method}");
    }
}

#[test]
fn a_sixty_four_kibibyte_chunk_is_the_whole_window() {
    for method in TRACKED_METHODS {
        let mut stream = Stream::new(method);
        assert!(stream.emit(MAX_PENDING_BYTES));
        assert!(!stream.emit(1), "{method}");
        assert!(stream.client_ack(), "{method}");
        assert!(stream.emit(1), "{method}");
    }
}

#[test]
fn the_byte_budget_stalls_before_the_chunk_cap() {
    let mut stream = Stream::new("terminal.attach");
    for _ in 0..4 {
        assert!(stream.emit(MAX_PENDING_BYTES / 4));
    }
    assert_eq!(stream.delivered, 4);
    assert!(!stream.emit(1));
}

#[test]
fn untracked_methods_keep_the_transports_single_chunk_ceiling() {
    let mut stream = Stream::new("subscribeTerminalMetadata");
    assert!(stream.emit(1));
    assert!(!stream.emit(1));
    assert_eq!(stream.window.pending(CLIENT, REQUEST), None);
    assert!(stream.client_ack());
    assert!(stream.emit(1));
    assert_eq!(stream.delivered, 2);
}

#[test]
fn swallows_client_acks_for_chunks_already_acked_internally() {
    let mut stream = Stream::new("terminal.attach");
    assert!(stream.emit(1));
    assert!(!stream.client_ack());
    assert_eq!(stream.window.pending(CLIENT, REQUEST), Some(0));
}

#[test]
fn interrupt_passes_through_and_exit_clears_the_window() {
    let mut stream = Stream::new("terminal.attach");
    assert!(stream.emit(1));
    assert_eq!(stream.window.pending(CLIENT, REQUEST), Some(1));

    assert_eq!(
        stream.window.on_client(
            CLIENT,
            FromClient::Interrupt {
                request_id: REQUEST.to_owned(),
            },
        ),
        Receive::Forward
    );
    assert_eq!(stream.window.pending(CLIENT, REQUEST), Some(1));

    assert_eq!(
        stream.window.on_server(
            CLIENT,
            FromServer::Exit {
                request_id: REQUEST.to_owned(),
            },
        ),
        Send::Deliver
    );
    assert_eq!(stream.window.pending(CLIENT, REQUEST), None);
}

#[test]
fn reopening_a_request_id_keeps_the_outstanding_window() {
    let mut stream = Stream::new("terminal.attach");
    assert!(stream.emit(1));
    assert_eq!(
        stream.window.on_client(CLIENT, request("terminal.attach")),
        Receive::Forward
    );
    assert_eq!(
        stream.window.pending(CLIENT, REQUEST),
        Some(1),
        "a fresh request must not drop credits the client still owes"
    );
}
