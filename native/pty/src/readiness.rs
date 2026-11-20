use std::io;
use std::os::fd::RawFd;
#[cfg(target_os = "macos")]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

pub(super) fn status_flags(fd: RawFd) -> io::Result<i32> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(flags)
    }
}

pub(super) fn set_status_flags(fd: RawFd, flags: i32) -> io::Result<()> {
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags) } < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub(super) struct Readiness {
    queue: OwnedFd,
    cancel: Option<RawFd>,
}

#[cfg(target_os = "macos")]
impl Readiness {
    pub(super) fn new(output: RawFd, cancel: Option<RawFd>, writing: bool) -> io::Result<Self> {
        // macOS poll does not reliably support PTYs; kqueue avoids select's FD_SETSIZE limit.
        let fd = unsafe { libc::kqueue() };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let queue = unsafe { OwnedFd::from_raw_fd(fd) };
        if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
            return Err(io::Error::last_os_error());
        }
        let mut changes = Vec::with_capacity(2);
        changes.push(libc::kevent {
            ident: output as libc::uintptr_t,
            filter: if writing {
                libc::EVFILT_WRITE
            } else {
                libc::EVFILT_READ
            },
            flags: libc::EV_ADD | libc::EV_ENABLE,
            fflags: 0,
            data: 0,
            udata: std::ptr::null_mut(),
        });
        if let Some(cancel) = cancel {
            changes.push(libc::kevent {
                ident: cancel as libc::uintptr_t,
                filter: libc::EVFILT_READ,
                flags: libc::EV_ADD | libc::EV_ENABLE,
                fflags: 0,
                data: 0,
                udata: std::ptr::null_mut(),
            });
        }
        if unsafe {
            libc::kevent(
                fd,
                changes.as_ptr(),
                changes.len() as i32,
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
            )
        } < 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { queue, cancel })
    }

    pub(super) fn wait(&mut self) -> io::Result<bool> {
        loop {
            let mut events: [libc::kevent; 2] = unsafe { std::mem::zeroed() };
            let count = unsafe {
                libc::kevent(
                    self.queue.as_raw_fd(),
                    std::ptr::null(),
                    0,
                    events.as_mut_ptr(),
                    2,
                    std::ptr::null(),
                )
            };
            if count < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            let events = &events[..count as usize];
            if self.cancel.is_some_and(|cancel| {
                events
                    .iter()
                    .any(|event| event.ident == cancel as libc::uintptr_t)
            }) {
                return Ok(false);
            }
            if let Some(event) = events
                .iter()
                .find(|event| event.flags & libc::EV_ERROR != 0)
            {
                return Err(io::Error::from_raw_os_error(event.data as i32));
            }
            if !events.is_empty() {
                return Ok(true);
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub(super) struct Readiness {
    fds: [libc::pollfd; 2],
}

#[cfg(not(target_os = "macos"))]
impl Readiness {
    pub(super) fn new(output: RawFd, cancel: Option<RawFd>, writing: bool) -> io::Result<Self> {
        Ok(Self {
            fds: [
                libc::pollfd {
                    fd: output,
                    events: if writing { libc::POLLOUT } else { libc::POLLIN },
                    revents: 0,
                },
                libc::pollfd {
                    fd: cancel.unwrap_or(-1),
                    events: libc::POLLIN,
                    revents: 0,
                },
            ],
        })
    }

    pub(super) fn wait(&mut self) -> io::Result<bool> {
        loop {
            let count = unsafe { libc::poll(self.fds.as_mut_ptr(), 2, -1) };
            if count < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            if self.fds[1].revents != 0 {
                return Ok(false);
            }
            if self.fds[0].revents & libc::POLLNVAL != 0 {
                return Err(io::Error::from_raw_os_error(libc::EBADF));
            }
            if self.fds[0].revents != 0 {
                return Ok(true);
            }
        }
    }
}
