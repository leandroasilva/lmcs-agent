//! Chunk credit window for streamed terminal output, ported from
//! `apps/server/src/terminal/OutputProtocol.ts`.

use std::collections::{HashMap, VecDeque};

pub const MAX_PENDING_CHUNKS: usize = 8;
pub const MAX_PENDING_BYTES: usize = 64 * 1024;

/// Streaming methods this policy widens. Any other method keeps whatever the
/// transport itself allows, which is a single unacknowledged chunk.
pub const TRACKED_METHODS: [&str; 2] = ["terminal.attach", "subscribeTerminalEvents"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FromClient {
    Request { id: String, method: String },
    Ack { request_id: String },
    Interrupt { request_id: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FromServer {
    /// `encoded_len` is the size of the frame as the serializer will put it on the wire.
    Chunk {
        request_id: String,
        encoded_len: usize,
    },
    Exit {
        request_id: String,
    },
}

#[must_use]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Send {
    Deliver,
    /// Inject the ack straight into the transport core; routing it back through
    /// `on_client` would shift the window a second time.
    DeliverAndAck,
}

#[must_use]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Receive {
    Forward,
    Swallow,
}

#[derive(Default)]
struct Window {
    sizes: VecDeque<usize>,
}

impl Window {
    fn is_full(&self) -> bool {
        self.sizes.len() >= MAX_PENDING_CHUNKS
            || self.sizes.iter().sum::<usize>() >= MAX_PENDING_BYTES
    }
}

#[derive(Default)]
pub struct OutputWindow {
    windows: HashMap<(String, String), Window>,
}

impl OutputWindow {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn on_client(&mut self, client_id: &str, message: FromClient) -> Receive {
        match message {
            FromClient::Request { id, method } => {
                if TRACKED_METHODS.contains(&method.as_str()) {
                    self.windows.entry((client_id.to_owned(), id)).or_default();
                }
                Receive::Forward
            }
            FromClient::Ack { request_id } => {
                let key = (client_id.to_owned(), request_id);
                let Some(window) = self.windows.get_mut(&key) else {
                    return Receive::Forward;
                };
                let was_full = window.is_full();
                window.sizes.pop_front();
                if !was_full || window.is_full() {
                    Receive::Swallow
                } else {
                    Receive::Forward
                }
            }
            FromClient::Interrupt { .. } => Receive::Forward,
        }
    }

    pub fn on_server(&mut self, client_id: &str, message: FromServer) -> Send {
        match message {
            FromServer::Exit { request_id } => {
                self.windows.remove(&(client_id.to_owned(), request_id));
                Send::Deliver
            }
            FromServer::Chunk {
                request_id,
                encoded_len,
            } => {
                let key = (client_id.to_owned(), request_id);
                match self.windows.get_mut(&key) {
                    None => Send::Deliver,
                    Some(window) => {
                        window.sizes.push_back(encoded_len);
                        if window.is_full() {
                            Send::Deliver
                        } else {
                            Send::DeliverAndAck
                        }
                    }
                }
            }
        }
    }

    pub fn pending(&self, client_id: &str, request_id: &str) -> Option<usize> {
        self.windows
            .get(&(client_id.to_owned(), request_id.to_owned()))
            .map(|window| window.sizes.len())
    }
}
