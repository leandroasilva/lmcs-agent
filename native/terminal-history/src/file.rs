use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

use crate::tail::{decode_tail, restore_tail};
use crate::{BoundedHistory, HistoryTail, Restored};

/// Blocking I/O on an already-resolved path; restoration never rewrites the file.
pub fn read_file(path: &Path, byte_limit: usize, line_limit: usize) -> io::Result<Restored> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    let tail = read_tail(&mut file, size, byte_limit)?;
    Ok(restore_tail(tail, byte_limit, line_limit))
}

/// Replaces the file; scheduling, error policy and durability belong to the caller.
pub fn write_file(path: &Path, history: &BoundedHistory) -> io::Result<()> {
    fs::write(path, history.value())
}

fn read_tail(
    reader: &mut (impl Read + Seek),
    size: u64,
    byte_limit: usize,
) -> io::Result<HistoryTail> {
    let length = size.min(byte_limit as u64) as usize;
    let offset = size - length as u64;
    reader.seek(SeekFrom::Start(offset))?;
    let mut bytes = vec![0; length];
    let mut read = 0;
    while read < bytes.len() {
        match reader.read(&mut bytes[read..]) {
            Ok(0) => break,
            Ok(count) => read += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(decode_tail(&bytes[..read], offset > 0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    struct Reader {
        cursor: Cursor<Vec<u8>>,
        requests: Vec<usize>,
        offsets: Vec<u64>,
        max_read: usize,
        read_error: Option<io::ErrorKind>,
        seek_error: bool,
    }

    impl Reader {
        fn new(bytes: &[u8]) -> Self {
            Self {
                cursor: Cursor::new(bytes.to_vec()),
                requests: Vec::new(),
                offsets: Vec::new(),
                max_read: 5,
                read_error: None,
                seek_error: false,
            }
        }
    }

    impl Read for Reader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            self.requests.push(buffer.len());
            if let Some(kind) = self.read_error.take() {
                return Err(kind.into());
            }
            let count = buffer.len().min(self.max_read);
            self.cursor.read(&mut buffer[..count])
        }
    }

    impl Seek for Reader {
        fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
            let SeekFrom::Start(offset) = position else {
                panic!("history must seek from the start");
            };
            self.offsets.push(offset);
            if self.seek_error {
                return Err(io::ErrorKind::InvalidInput.into());
            }
            self.cursor.seek(position)
        }
    }

    #[test]
    fn seeks_to_the_bounded_tail_and_fills_short_reads() {
        let bytes = format!("{}\u{1f600}\u{feff}newest\ré", "old".repeat(32_768));
        let mut reader = Reader::new(bytes.as_bytes());
        let tail = read_tail(&mut reader, bytes.len() as u64, 15).unwrap();
        assert_eq!(reader.offsets, [bytes.len() as u64 - 15]);
        assert_eq!(reader.requests, [15, 10, 5]);
        assert_eq!(tail.history, "\u{feff}newest\ré");
        assert!(tail.truncated);
    }

    #[test]
    fn early_eof_decodes_only_bytes_actually_read() {
        let mut reader = Reader::new(b"discard\xe2\x82");
        let tail = read_tail(&mut reader, 12, 5).unwrap();
        assert_eq!(reader.offsets, [7]);
        assert_eq!(reader.requests, [5, 3]);
        assert_eq!(tail.history, "\u{fffd}");
        assert!(tail.truncated);
    }

    #[test]
    fn growth_after_stat_does_not_extend_the_read() {
        let mut reader = Reader::new(b"original-appended");
        let tail = read_tail(&mut reader, 8, 4).unwrap();
        assert_eq!(reader.offsets, [4]);
        assert_eq!(reader.requests, [4]);
        assert_eq!(tail.history, "inal");
        assert!(tail.truncated);
    }

    #[test]
    fn empty_files_and_zero_budgets_do_not_issue_reads() {
        for (size, limit, offset, truncated) in [(0, 32, 0, false), (7, 0, 7, true)] {
            let mut reader = Reader::new(b"ignored");
            let tail = read_tail(&mut reader, size, limit).unwrap();
            assert_eq!(reader.offsets, [offset]);
            assert!(reader.requests.is_empty());
            assert!(tail.history.is_empty());
            assert_eq!(tail.truncated, truncated);
        }
    }

    #[test]
    fn interrupted_reads_retry_without_skipping_bytes() {
        let mut reader = Reader::new(b"whole");
        reader.read_error = Some(io::ErrorKind::Interrupted);
        let tail = read_tail(&mut reader, 5, 10).unwrap();
        assert_eq!(reader.requests, [5, 5]);
        assert_eq!(tail.history, "whole");
        assert!(!tail.truncated);
    }

    #[test]
    fn seek_and_read_errors_are_not_successful_empty_history() {
        let mut reader = Reader::new(b"whole");
        reader.seek_error = true;
        let error = read_tail(&mut reader, 5, 10).err().unwrap();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(reader.requests.is_empty());

        reader.seek_error = false;
        reader.read_error = Some(io::ErrorKind::PermissionDenied);
        let error = read_tail(&mut reader, 5, 10).err().unwrap();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(reader.requests, [5]);
    }
}
