//! RESP2, the protocol of Redis and Valkey: a command is an array of bulk strings, binary-safe,
//! so an argument can never become a second command. Replies are read with a byte limit, so a
//! large value or a long list cannot fill memory, and with a depth limit for nested arrays.

use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt};

/// One reply.
#[derive(Clone, Debug, PartialEq)]
pub enum Reply {
    /// `+OK`
    Status(String),
    /// `-ERR ...`: the server refused the command; the connection stays usable.
    Error(String),
    Int(i64),
    /// `$-1` is `Nil`.
    Bulk(Vec<u8>),
    Array(Vec<Reply>),
    /// A missing value (`$-1`, `*-1`).
    Nil,
}

impl Reply {
    /// The reply as text: statuses and bulk strings (lossy for binary), integers in decimal.
    pub fn text(&self) -> Option<String> {
        match self {
            Reply::Status(s) => Some(s.clone()),
            Reply::Bulk(b) => Some(String::from_utf8_lossy(b).into_owned()),
            Reply::Int(i) => Some(i.to_string()),
            _ => None,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RespError {
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("the server's answer is not RESP: {0}")]
    Protocol(String),
    /// The reply is larger than the response may be; the rest is still on the wire.
    #[error("the answer is larger than the response size limit")]
    TooLarge,
}

/// Longest line of a reply header or status; values arrive as bulk strings.
const MAX_LINE: usize = 64 * 1024;
/// Deepest nesting of arrays (RediSearch and time series answers nest four deep).
const MAX_DEPTH: usize = 32;
/// What each element costs besides its bytes, so a million empty strings count too.
const ELEMENT_COST: usize = 16;

/// A command as RESP: `*<n>\r\n` and `$<len>\r\n<bytes>\r\n` per argument.
pub fn encode(args: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + args.iter().map(|a| a.len() + 16).sum::<usize>());
    out.extend_from_slice(format!("*{}\r\n", args.len()).as_bytes());
    for arg in args {
        out.extend_from_slice(format!("${}\r\n", arg.len()).as_bytes());
        out.extend_from_slice(arg);
        out.extend_from_slice(b"\r\n");
    }
    out
}

/// Reads one line without its `\r\n`, at most `MAX_LINE` bytes.
async fn line<R: AsyncBufRead + Unpin>(r: &mut R) -> Result<Vec<u8>, RespError> {
    let mut out = Vec::new();
    loop {
        let buf = r.fill_buf().await?;
        if buf.is_empty() {
            return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof).into());
        }
        match buf.iter().position(|b| *b == b'\n') {
            Some(at) => {
                out.extend_from_slice(&buf[..at]);
                r.consume(at + 1);
                break;
            }
            None => {
                let n = buf.len();
                out.extend_from_slice(buf);
                r.consume(n);
            }
        }
        if out.len() > MAX_LINE {
            return Err(RespError::Protocol("a line is too long".into()));
        }
    }
    if out.last() == Some(&b'\r') {
        out.pop();
    }
    if out.len() > MAX_LINE {
        return Err(RespError::Protocol("a line is too long".into()));
    }
    Ok(out)
}

fn number(text: &[u8]) -> Result<i64, RespError> {
    std::str::from_utf8(text)
        .ok()
        .and_then(|t| t.parse().ok())
        .ok_or_else(|| RespError::Protocol(format!("{:?} is not a number", String::from_utf8_lossy(text))))
}

enum Item {
    Value(Reply),
    /// An array of this many elements follows.
    Array(usize),
}

/// One element: a value, or the header of an array. `budget` is what may still be read.
async fn item<R: AsyncBufRead + Unpin>(r: &mut R, budget: &mut usize) -> Result<Item, RespError> {
    let header = line(r).await?;
    spend(budget, header.len() + ELEMENT_COST)?;
    let Some((&kind, rest)) = header.split_first() else {
        return Err(RespError::Protocol("an empty line".into()));
    };
    let text = || String::from_utf8_lossy(rest).into_owned();
    Ok(match kind {
        b'+' => Item::Value(Reply::Status(text())),
        b'-' => Item::Value(Reply::Error(text())),
        b':' => Item::Value(Reply::Int(number(rest)?)),
        b'$' => match number(rest)? {
            -1 => Item::Value(Reply::Nil),
            len if len < 0 => return Err(RespError::Protocol("a negative length".into())),
            len => {
                let len = len as usize;
                spend(budget, len)?;
                let mut data = vec![0u8; len + 2];
                r.read_exact(&mut data).await?;
                if !data.ends_with(b"\r\n") {
                    return Err(RespError::Protocol("a bulk string without its line end".into()));
                }
                data.truncate(len);
                Item::Value(Reply::Bulk(data))
            }
        },
        b'*' => match number(rest)? {
            -1 => Item::Value(Reply::Nil),
            len if len < 0 => return Err(RespError::Protocol("a negative length".into())),
            len => {
                // Every element costs at least its header, so the budget bounds the length.
                spend(budget, 0)?;
                Item::Array(len as usize)
            }
        },
        other => return Err(RespError::Protocol(format!("unknown reply type {:?}", other as char))),
    })
}

fn spend(budget: &mut usize, bytes: usize) -> Result<(), RespError> {
    *budget = budget.checked_sub(bytes).ok_or(RespError::TooLarge)?;
    Ok(())
}

/// Reads one whole reply, nested arrays included, spending at most `budget` bytes.
pub async fn read<R: AsyncBufRead + Unpin>(r: &mut R, budget: &mut usize) -> Result<Reply, RespError> {
    let mut stack: Vec<(usize, Vec<Reply>)> = Vec::new();
    loop {
        let mut value = match item(r, budget).await? {
            Item::Array(0) => Reply::Array(Vec::new()),
            Item::Array(n) => {
                if stack.len() >= MAX_DEPTH {
                    return Err(RespError::Protocol("arrays are nested too deep".into()));
                }
                // The length is the server's word; the budget decides what is really read.
                stack.push((n, Vec::with_capacity(n.min(1024))));
                continue;
            }
            Item::Value(v) => v,
        };
        loop {
            let Some((len, items)) = stack.last_mut() else { return Ok(value) };
            items.push(value);
            if items.len() < *len {
                break;
            }
            let (_, items) = stack.pop().expect("the stack has this array");
            value = Reply::Array(items);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn parse(bytes: &[u8], budget: usize) -> Result<Reply, RespError> {
        let mut r = tokio::io::BufReader::new(bytes);
        let mut budget = budget;
        read(&mut r, &mut budget).await
    }

    #[test]
    fn commands_are_arrays_of_bulk_strings() {
        let out = encode(&[b"GET".to_vec(), b"a b\r\n*1".to_vec()]);
        assert_eq!(out, b"*2\r\n$3\r\nGET\r\n$7\r\na b\r\n*1\r\n");
    }

    #[tokio::test]
    async fn replies_of_every_type_nest() {
        let r = parse(b"*4\r\n+OK\r\n:-5\r\n$5\r\nGr\xc3\xbc\xc3\r\n*2\r\n$-1\r\n*0\r\n", 1 << 20).await.unwrap();
        assert_eq!(
            r,
            Reply::Array(vec![
                Reply::Status("OK".into()),
                Reply::Int(-5),
                Reply::Bulk(b"Gr\xc3\xbc\xc3".to_vec()),
                Reply::Array(vec![Reply::Nil, Reply::Array(vec![])]),
            ])
        );
        assert_eq!(parse(b"-ERR unknown\r\n", 100).await.unwrap(), Reply::Error("ERR unknown".into()));
        assert_eq!(parse(b"*-1\r\n", 100).await.unwrap(), Reply::Nil);
    }

    #[tokio::test]
    async fn the_budget_and_the_depth_bound_what_is_read() {
        assert!(matches!(parse(b"$100\r\n", 50).await, Err(RespError::TooLarge)));
        // A long array of tiny elements runs out of budget too.
        let many = format!("*100000\r\n{}", ":1\r\n".repeat(100_000));
        assert!(matches!(parse(many.as_bytes(), 10_000).await, Err(RespError::TooLarge)));
        let deep = "*1\r\n".repeat(40) + ":1\r\n";
        assert!(matches!(parse(deep.as_bytes(), 1 << 20).await, Err(RespError::Protocol(_))));
        assert!(matches!(parse(b"$3\r\nabcde", 100).await, Err(RespError::Protocol(_) | RespError::Io(_))));
        assert!(matches!(parse(b"?x\r\n", 100).await, Err(RespError::Protocol(_))));
        assert!(matches!(parse(b":1", 100).await, Err(RespError::Io(_))));
        let long = vec![b'+'; MAX_LINE + 10];
        assert!(matches!(parse(&long, 1 << 20).await, Err(RespError::Protocol(_))));
    }
}
