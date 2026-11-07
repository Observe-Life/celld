// Copyright 2026 Observe-Life. Apache-2.0 license.

//! The records center: explicit errors and structured logs, persisted.
//!
//! One writer per node: a bounded channel feeds a thread that batches
//! inserts into a SQLite database (WAL). The main container's database is
//! the fleet's records center; other nodes ship their records to it over
//! `POST /records/append` on the internal listener (see main.rs). Nothing
//! here blocks the request path: a full channel drops the record and counts
//! the drop, because observability must never become the failure.

use anyhow::Result;
use rusqlite::Connection;
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const CHANNEL_CAPACITY: usize = 4_096;
const BATCH_MAX: usize = 256;
const FLUSH_INTERVAL: Duration = Duration::from_secs(2);

static SENDER: OnceLock<Option<SyncSender<Record>>> = OnceLock::new();
static DROPPED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[derive(Debug)]
pub struct Record {
    pub subject_type: &'static str,
    pub subject_id: String,
    pub module: &'static str,
    pub level: &'static str,
    pub code: String,
    pub message: String,
    pub context: String,
    /// The container the record came from. `None` stamps the writer's own
    /// label; shipped records carry the shipper's.
    pub container: Option<String>,
}

fn now_iso() -> String {
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs();
    let ms = d.subsec_millis();
    // RFC3339 without an external crate: seconds since epoch to UTC fields.
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Civil-from-days (Howard Hinnant's algorithm).
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let dday = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{dday:02}T{h:02}:{mi:02}:{s:02}.{ms:03}Z")
}

fn schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS records(
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           ts TEXT NOT NULL,
           kind TEXT NOT NULL,
           subject_type TEXT NOT NULL,
           subject_id TEXT NOT NULL,
           container TEXT NOT NULL,
           module TEXT NOT NULL,
           level TEXT NOT NULL,
           code TEXT NOT NULL,
           message_full TEXT NOT NULL,
           context_json TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_records_ts ON records(ts);
         CREATE INDEX IF NOT EXISTS idx_records_subject ON records(subject_id);
         CREATE INDEX IF NOT EXISTS idx_records_module_level ON records(module, level);
         CREATE TABLE IF NOT EXISTS push_outbox(
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           ts TEXT NOT NULL,
           aggregated_text TEXT NOT NULL,
           count INTEGER NOT NULL DEFAULT 1,
           status TEXT NOT NULL DEFAULT 'pending',
           sent_at TEXT
         );",
    )?;
    Ok(())
}

fn writer(db_path: String, container: String, rx: Receiver<Record>) {
    let conn = match Connection::open(&db_path) {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(target: "celld::records", error = %e, "records db open failed; records are dropped for this session");
            return;
        }
    };
    let _ = conn.pragma_update(None, "synchronous", "NORMAL");
    if let Err(e) = schema(&conn) {
        tracing::error!(target: "celld::records", error = %e, "records schema failed");
        return;
    }
    let mut batch: Vec<Record> = Vec::with_capacity(BATCH_MAX);
    let last_flush = std::time::Instant::now();
    loop {
        let deadline = std::time::Instant::now() + FLUSH_INTERVAL;
        loop {
            match rx.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now())) {
                Ok(r) => batch.push(r),
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    flush(&conn, &container, &mut batch);
                    return;
                }
            }
            if batch.len() >= BATCH_MAX {
                break;
            }
        }
        flush(&conn, &container, &mut batch);
        let _ = last_flush;
    }
}

fn flush(conn: &Connection, default_container: &str, batch: &mut Vec<Record>) {
    if batch.is_empty() {
        return;
    }
    let mut stmt = match conn.prepare(
        "INSERT INTO records(ts,kind,subject_type,subject_id,container,module,level,code,message_full,context_json)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
    ) {
        Ok(s) => s,
        Err(e) => {
            tracing::error!(target: "celld::records", error = %e, "records insert prepare failed");
            batch.clear();
            return;
        }
    };
    for r in batch.drain(..) {
        let kind = if r.level == "error" { "error" } else { "log" };
        let _ = stmt.execute(rusqlite::params![
            now_iso(),
            kind,
            r.subject_type,
            r.subject_id,
            r.container.as_deref().unwrap_or(default_container),
            r.module,
            r.level,
            r.code,
            r.message,
            r.context,
        ]);
    }
}

static INIT: OnceLock<()> = OnceLock::new();

/// Initialize once from the environment. `CELLD_RECORDS_DB` names the local
/// database (the records center on the main container); `CELLD_RECORDS_ENDPOINT`
/// makes this node ship its records to that center over the internal
/// listener. With neither, the node records nothing and counts drops.
pub fn ensure_init() {
    if INIT.get().is_some() {
        return;
    }
    let node = std::env::var("CELLD_NODE").unwrap_or_else(|_| "celld".into());
    if let Ok(db) = std::env::var("CELLD_RECORDS_DB") {
        if !db.is_empty() {
            let _ = init(&db, &node);
            return;
        }
    }
    if let Ok(ep) = std::env::var("CELLD_RECORDS_ENDPOINT") {
        if !ep.is_empty() {
            let _ = sender_init(&ep, &node);
            return;
        }
    }
    INIT.set(()).ok();
}

fn sender_init(endpoint: &str, container: &str) -> Result<()> {
    let (tx, rx): (SyncSender<Record>, Receiver<Record>) = mpsc::sync_channel(CHANNEL_CAPACITY);
    let endpoint = endpoint.to_string();
    let container = container.to_string();
    std::thread::Builder::new()
        .name("records-sender".into())
        .spawn(move || sender(endpoint, container, rx))?;
    SENDER.set(Some(tx)).ok();
    Ok(())
}

/// Ship mode: drain the channel and POST batches to the records center.
/// A failed shipment keeps the batch and retries on the next tick, so a
/// short collector outage loses nothing; the cap bounds memory.
fn sender(endpoint: String, container: String, rx: Receiver<Record>) {
    let mut batch: Vec<Record> = Vec::new();
    loop {
        match rx.recv_timeout(FLUSH_INTERVAL) {
            Ok(r) => batch.push(r),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                ship(&endpoint, &container, &mut batch);
                return;
            }
        }
        if batch.len() >= BATCH_MAX || !batch.is_empty() {
            ship(&endpoint, &container, &mut batch);
        }
        while batch.len() > 4 * BATCH_MAX {
            batch.remove(0);
        }
    }
}

fn ship(endpoint: &str, container: &str, batch: &mut Vec<Record>) {
    if batch.is_empty() {
        return;
    }
    let records: Vec<serde_json::Value> = batch
        .iter()
        .map(|r| {
            serde_json::json!({
                "subject_type": r.subject_type,
                "subject_id": r.subject_id,
                "module": r.module,
                "level": r.level,
                "code": r.code,
                "message": r.message,
                "context": r.context,
            })
        })
        .collect();
    let body = serde_json::json!({ "container": container, "records": records }).to_string();
    match http_post_json(endpoint, &body) {
        Ok(status) if (200..300).contains(&status) => batch.clear(),
        status => {
            tracing::warn!(target: "celld::records", status = ?status, "records shipment deferred; will retry");
            if batch.len() > 4 * BATCH_MAX {
                batch.drain(..BATCH_MAX);
            }
        }
    }
}

/// Minimal HTTP/1.1 POST over a blocking socket. The endpoint is an internal
/// listener on the fleet network, so plaintext is the transport contract.
fn http_post_json(url: &str, body: &str) -> std::io::Result<u16> {
    use std::io::{Read, Write};
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "records endpoint must be http://"))?;
    let (hostport, path) = match rest.split_once('/') {
        Some((h, pth)) => (h, format!("/{}", pth)),
        None => (rest, "/".to_string()),
    };
    let mut stream = std::net::TcpStream::connect(hostport)?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(5))).ok();
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: {hostport}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream.write_all(request.as_bytes())?;
    let mut head = [0u8; 512];
    let n = stream.read(&mut head).unwrap_or(0);
    let text = String::from_utf8_lossy(&head[..n]);
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(0);
    Ok(status)
}

/// Receive shipped records from a peer node. Returns the accepted count.
pub fn ingest_json(bytes: &[u8]) -> Result<usize> {
    let value: serde_json::Value = serde_json::from_slice(bytes)?;
    let shipper = value
        .get("container")
        .and_then(|v| v.as_str())
        .unwrap_or("peer")
        .to_string();
    let items = value
        .get("records")
        .and_then(|v| v.as_array())
        .ok_or_else(|| anyhow::anyhow!("records array missing"))?;
    let Some(handle) = ingest_handle() else {
        return Err(anyhow::anyhow!("records center disabled on this node"));
    };
    let mut accepted = 0usize;
    for item in items {
        let get = |k: &str| {
            item.get(k)
                .map(|v| v.as_str().unwrap_or_default().to_string())
                .unwrap_or_default()
        };
        let level = get("level");
        let module = get("module");
        let subject_type_raw = get("subject_type");
        let subject_type: &'static str = match subject_type_raw.as_str() {
            "instance" | "node" => Box::leak(subject_type_raw.into_boxed_str()),
            _ => "instance",
        };
        let r = Record {
            subject_type,
            subject_id: get("subject_id"),
            module: Box::leak(module.into_boxed_str()),
            level: Box::leak(level.into_boxed_str()),
            code: get("code"),
            message: get("message"),
            context: get("context"),
            container: Some(shipper.clone()),
        };
        if handle.push(r) {
            accepted += 1;
        }
    }
    Ok(accepted)
}

/// Initialize the writer. Returns after the schema is ensured on a probe
/// connection; the writer thread owns its own connection afterwards.
pub fn init(db_path: &str, container: &str) -> Result<()> {
    {
        let conn = Connection::open(db_path)?;
        schema(&conn)?;
    }
    let (tx, rx): (SyncSender<Record>, Receiver<Record>) = mpsc::sync_channel(CHANNEL_CAPACITY);
    let container = container.to_string();
    let db = db_path.to_string();
    std::thread::Builder::new()
        .name("records-writer".into())
        .spawn(move || writer(db, container, rx))?;
    let _ = SENDER.set(Some(tx));
    Ok(())
}

fn send(r: Record) {
    ensure_init();
    match SENDER.get_or_init(|| None).as_ref() {
        Some(tx) => {
            if tx.try_send(r).is_err() {
                DROPPED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
        }
        None => {
            DROPPED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    }
}

pub fn error(subject_type: &'static str, subject_id: &str, module: &'static str, code: &str, message: String, context: String) {
    send(Record { subject_type, subject_id: subject_id.to_string(), module, level: "error", code: code.to_string(), message, context, container: None });
}

pub fn warn(subject_type: &'static str, subject_id: &str, module: &'static str, code: &str, message: String, context: String) {
    send(Record { subject_type, subject_id: subject_id.to_string(), module, level: "warn", code: code.to_string(), message, context, container: None });
}

pub fn info(subject_type: &'static str, subject_id: &str, module: &'static str, code: &str, message: String, context: String) {
    send(Record { subject_type, subject_id: subject_id.to_string(), module, level: "info", code: code.to_string(), message, context, container: None });
}

/// Dropped-record counter, surfaced by diagnose so a silent observability
/// failure is itself observable.
pub fn dropped() -> u64 {
    DROPPED.load(std::sync::atomic::Ordering::Relaxed)
}

/// Shared handle for the /records/append receiver: funnels shipped records
/// from peer nodes into this node's writer.
pub struct Ingest {
    tx: SyncSender<Record>,
    _guard: Arc<()>,
}

impl Ingest {
    pub fn push(&self, r: Record) -> bool {
        self.tx.try_send(r).is_ok()
    }
}

/// A process-wide ingest handle clone for the internal route; the writer
/// thread keeps draining it.
pub fn ingest_handle() -> Option<Ingest> {
    SENDER.get().and_then(|s| s.as_ref()).map(|tx| Ingest {
        tx: tx.clone(),
        _guard: Arc::new(()),
    })
}
