//! A small in-process MongoDB for the router tests: speaks OP_MSG, answers the handshake and the
//! commands Kalzit sends, and records every command it receives. Real servers are tested in
//! `server/tests/mongodb.rs`.

use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex};

use bson::{Bson, Document, doc};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Clone, Default)]
pub struct Behaviour {
    /// `authenticatedUserPrivileges` in `connectionStatus`.
    pub privileges: Vec<Document>,
    /// `hostInfo` succeeds, as on a server without access control.
    pub access_control_off: bool,
    /// The documents every `aggregate` and `find` answers (before `$skip`/`$limit`).
    pub documents: Vec<Document>,
    pub collections: Vec<Document>,
    /// Added to the handshake answer (a replica set name and members, say).
    pub hello_extra: Document,
}

pub struct FakeMongo {
    pub port: u16,
    /// What the server answers; tests may change it while it runs.
    pub behaviour: Arc<Mutex<Behaviour>>,
    pub commands: Arc<Mutex<Vec<Document>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for FakeMongo {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl FakeMongo {
    pub async fn start(behaviour: Behaviour) -> Self {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let commands = Arc::new(Mutex::new(Vec::new()));
        let seen = commands.clone();
        let behaviour = Arc::new(Mutex::new(behaviour));
        let shared = behaviour.clone();
        let task = tokio::spawn(async move {
            let mut conns = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    Ok((stream, _)) = listener.accept() => {
                        let (b, seen) = (shared.clone(), seen.clone());
                        conns.spawn(async move { let _ = serve(stream, &b, &seen).await; });
                    }
                    Some(_) = conns.join_next() => {}
                }
            }
        });
        Self { port, behaviour, commands, task }
    }

    /// The names of the commands received, without the handshake and monitoring.
    pub fn command_names(&self) -> Vec<String> {
        self.commands
            .lock()
            .unwrap()
            .iter()
            .filter_map(|c| c.keys().next().cloned())
            .filter(|n| !matches!(n.as_str(), "hello" | "isMaster" | "ismaster" | "endSessions"))
            .collect()
    }

    pub fn last(&self, name: &str) -> Option<Document> {
        self.commands.lock().unwrap().iter().rev().find(|c| c.keys().next().map(String::as_str) == Some(name)).cloned()
    }
}

async fn serve(mut s: TcpStream, b: &Mutex<Behaviour>, seen: &Mutex<Vec<Document>>) -> std::io::Result<()> {
    loop {
        let mut header = [0u8; 16];
        s.read_exact(&mut header).await?;
        let len = i32::from_le_bytes(header[0..4].try_into().unwrap()) as usize;
        let request_id = i32::from_le_bytes(header[4..8].try_into().unwrap());
        let op = i32::from_le_bytes(header[12..16].try_into().unwrap());
        let mut body = vec![0u8; len - 16];
        s.read_exact(&mut body).await?;
        assert_eq!(op, 2013, "the driver speaks OP_MSG");
        let flags = u32::from_le_bytes(body[0..4].try_into().unwrap());
        let end = if flags & 1 == 1 { body.len() - 4 } else { body.len() };
        let mut i = 4;
        let mut command = Document::new();
        while i < end {
            let kind = body[i];
            i += 1;
            let size = i32::from_le_bytes(body[i..i + 4].try_into().unwrap()) as usize;
            if kind == 0 {
                command = Document::from_reader(&mut &body[i..i + size]).unwrap();
            } else {
                // Document sequences (bulk writes) are never sent by Kalzit.
                panic!("unexpected document sequence");
            }
            i += size;
        }
        seen.lock().unwrap().push(command.clone());
        let reply = answer(&command, &b.lock().unwrap().clone());
        let mut doc_bytes = Vec::new();
        reply.to_writer(&mut doc_bytes).unwrap();
        let total = 16 + 4 + 1 + doc_bytes.len();
        let mut out = Vec::with_capacity(total);
        out.extend((total as i32).to_le_bytes());
        out.extend(1_i32.to_le_bytes());
        out.extend(request_id.to_le_bytes());
        out.extend(2013_i32.to_le_bytes());
        out.extend(0_u32.to_le_bytes());
        out.push(0);
        out.extend(doc_bytes);
        s.write_all(&out).await?;
    }
}

fn cursor(ns: &str, docs: Vec<Document>) -> Document {
    doc! { "cursor": { "id": 0_i64, "ns": ns, "firstBatch": docs.into_iter().map(Bson::Document).collect::<Vec<_>>() }, "ok": 1.0 }
}

fn answer(c: &Document, b: &Behaviour) -> Document {
    let name = c.keys().next().cloned().unwrap_or_default();
    match name.as_str() {
        "hello" | "isMaster" | "ismaster" => {
            let mut hello = doc! {
                "ismaster": true, "isWritablePrimary": true, "helloOk": true, "maxBsonObjectSize": 16_777_216,
                "maxMessageSizeBytes": 48_000_000, "maxWriteBatchSize": 100_000, "localTime": bson::DateTime::now(),
                "logicalSessionTimeoutMinutes": 30, "connectionId": 1, "minWireVersion": 0, "maxWireVersion": 21,
                "readOnly": false, "ok": 1.0
            };
            hello.extend(b.hello_extra.clone());
            hello
        }
        "connectionStatus" => doc! {
            "authInfo": {
                "authenticatedUsers": [], "authenticatedUserRoles": [],
                "authenticatedUserPrivileges": b.privileges.iter().cloned().map(Bson::Document).collect::<Vec<_>>(),
            },
            "ok": 1.0
        },
        "hostInfo" if b.access_control_off => doc! { "system": { "hostname": "fake" }, "ok": 1.0 },
        "hostInfo" => {
            doc! { "ok": 0.0, "errmsg": "not authorized on admin to execute command", "code": 13, "codeName": "Unauthorized" }
        }
        "buildInfo" => doc! { "version": "8.0.4", "versionArray": [8, 0, 4, 0], "ok": 1.0 },
        "ping" | "endSessions" | "killCursors" => doc! { "ok": 1.0 },
        "listCollections" => cursor("db.$cmd.listCollections", b.collections.clone()),
        "listIndexes" => cursor(
            "db.x",
            vec![
                doc! { "v": 2, "key": { "_id": 1 }, "name": "_id_" },
                doc! { "v": 2, "key": { "ts": -1, "land": 1 }, "name": "ts_land", "unique": true },
            ],
        ),
        "aggregate" => {
            let stages = c.get_array("pipeline").cloned().unwrap_or_default();
            let mut docs = b.documents.clone();
            if stages.iter().any(|s| s.as_document().is_some_and(|d| d.contains_key("$sample"))) {
                return cursor("db.x", docs);
            }
            for stage in stages {
                let Bson::Document(stage) = stage else { continue };
                if let Some(n) = stage.get("$skip").and_then(Bson::as_i64) {
                    docs = docs.into_iter().skip(n as usize).collect();
                }
                if let Some(n) = stage.get("$limit").and_then(Bson::as_i64) {
                    docs.truncate(n as usize);
                }
            }
            cursor("db.x", docs)
        }
        "find" => {
            let skip = c.get("skip").and_then(|v| v.as_i64().or(v.as_i32().map(i64::from))).unwrap_or(0) as usize;
            let limit = c.get("limit").and_then(|v| v.as_i64().or(v.as_i32().map(i64::from)));
            let mut docs: Vec<Document> = b.documents.iter().skip(skip).cloned().collect();
            if let Some(l) = limit {
                docs.truncate(l as usize);
            }
            cursor("db.x", docs)
        }
        _ => {
            doc! { "ok": 0.0, "errmsg": format!("no such command: '{name}'"), "code": 59, "codeName": "CommandNotFound" }
        }
    }
}
