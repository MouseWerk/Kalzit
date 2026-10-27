//! A server-sent events parser for streamed answers: bytes in, events out. Lines end with `\n`,
//! `\r\n` or `\r`; an empty line ends an event; `data:` lines are joined with `\n`; comments
//! (`:`) and unknown fields are ignored. A line may be split across chunks, also inside a UTF-8
//! character.

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Event {
    /// The `event:` field, empty when the event had none.
    pub name: String,
    pub data: String,
}

#[derive(Default)]
pub struct Parser {
    /// Bytes of the line not yet ended.
    line: Vec<u8>,
    /// The last chunk ended in `\r`; a `\n` right after belongs to it.
    after_cr: bool,
    name: String,
    data: Vec<String>,
}

impl Parser {
    /// Feeds a chunk; returns the events it completed.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<Event> {
        let mut out = Vec::new();
        for &b in bytes {
            if self.after_cr {
                self.after_cr = false;
                if b == b'\n' {
                    continue;
                }
            }
            match b {
                b'\n' | b'\r' => {
                    self.after_cr = b == b'\r';
                    let line = std::mem::take(&mut self.line);
                    self.line_done(&line, &mut out);
                }
                _ => self.line.push(b),
            }
        }
        out
    }

    /// The end of the stream: a last event without its empty line still counts.
    pub fn finish(&mut self) -> Vec<Event> {
        let mut out = Vec::new();
        if !self.line.is_empty() {
            let line = std::mem::take(&mut self.line);
            self.line_done(&line, &mut out);
        }
        self.dispatch(&mut out);
        out
    }

    fn line_done(&mut self, line: &[u8], out: &mut Vec<Event>) {
        if line.is_empty() {
            self.dispatch(out);
            return;
        }
        let line = String::from_utf8_lossy(line);
        if line.starts_with(':') {
            return;
        }
        let (field, value) = match line.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (line.as_ref(), ""),
        };
        match field {
            "event" => self.name = value.to_string(),
            "data" => self.data.push(value.to_string()),
            _ => {}
        }
    }

    fn dispatch(&mut self, out: &mut Vec<Event>) {
        let name = std::mem::take(&mut self.name);
        if self.data.is_empty() {
            return;
        }
        let data = std::mem::take(&mut self.data).join("\n");
        out.push(Event { name, data });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(name: &str, data: &str) -> Event {
        Event { name: name.into(), data: data.into() }
    }

    #[test]
    fn events_split_anywhere_come_out_whole() {
        let text = "event: a\ndata: {\"x\":\"ä\"}\n\n: ping\r\ndata: one\r\ndata: two\r\n\r\ndata: last";
        let bytes = text.as_bytes();
        for cut in 0..bytes.len() {
            let mut p = Parser::default();
            let mut out = p.push(&bytes[..cut]);
            out.extend(p.push(&bytes[cut..]));
            out.extend(p.finish());
            assert_eq!(out, vec![ev("a", "{\"x\":\"ä\"}"), ev("", "one\ntwo"), ev("", "last")], "cut at {cut}");
        }
    }

    #[test]
    fn a_lone_carriage_return_ends_a_line() {
        let mut p = Parser::default();
        let mut out = p.push(b"data: x\r\r");
        out.extend(p.push(b"\ndata: y\n\n"));
        assert_eq!(out, vec![ev("", "x"), ev("", "y")]);
    }
}
