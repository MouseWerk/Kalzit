//! Panics go through tracing as errors, so the log (kalzit.log for the Windows service) holds
//! them and the Windows event log gets its short note; the default hook still prints them, which
//! is what a console run shows.

/// Installs the hook in front of the one already set (the default hook, normally).
pub fn install() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log(info);
        previous(info);
    }));
}

/// Logs a panic as an error with target `kalzit::panic`: the thread, the place and the message.
fn log(info: &std::panic::PanicHookInfo<'_>) {
    let payload = info.payload();
    let message = payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("(no message)");
    let place = info.location().map_or_else(String::new, |l| format!(" at {}:{}", l.file(), l.line()));
    let thread = std::thread::current();
    let name = thread.name().unwrap_or("unnamed");
    tracing::error!(target: "kalzit::panic", "panic in thread {name}{place}: {message}");
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct Captured(Arc<Mutex<Vec<u8>>>);

    impl std::io::Write for Captured {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_panic_is_logged_as_an_error() {
        let captured = Captured::default();
        let writer = captured.clone();
        let subscriber = tracing_subscriber::fmt().with_ansi(false).with_writer(move || writer.clone()).finish();
        super::install();
        tracing::subscriber::with_default(subscriber, || {
            let outcome = std::panic::catch_unwind(|| panic!("the answer is {}", 42));
            assert!(outcome.is_err());
        });
        let text = String::from_utf8(captured.0.lock().unwrap().clone()).unwrap();
        assert!(text.contains("ERROR"), "{text}");
        assert!(text.contains("kalzit::panic"), "{text}");
        assert!(text.contains("panic_log.rs:"), "{text}");
        assert!(text.contains("the answer is 42"), "{text}");
    }
}
