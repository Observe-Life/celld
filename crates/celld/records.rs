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
    // Journal mode DELETE, not WAL: peer nodes read this database through a
    // read-only bind mount of the single file, and a WAL reader without its
    // -wal sidecar sees a stale snapshot (the 2026-11-07 cooldown that never
    // took). DELETE keeps the database self-contained in one file.
    conn.execute_batch(
        "PRAGMA journal_mode=DELETE;
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
         CREATE TABLE IF NOT EXISTS otel_spans(
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           ts TEXT NOT NULL,
           container TEXT NOT NULL,
           trace_id TEXT,
           span_id TEXT,
           name TEXT NOT NULL,
           duration_us INTEGER,
           ok INTEGER,
           error TEXT,
           cell TEXT,
           attrs_json TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_otel_spans_trace ON otel_spans(trace_id);
         CREATE INDEX IF NOT EXISTS idx_otel_spans_ts ON otel_spans(ts);
         CREATE TABLE IF NOT EXISTS otel_logs(
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           ts TEXT NOT NULL,
           container TEXT NOT NULL,
           trace_id TEXT,
           span_id TEXT,
           severity TEXT NOT NULL,
           body TEXT NOT NULL,
           attrs_json TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_otel_logs_trace ON otel_logs(trace_id);
         CREATE INDEX IF NOT EXISTS idx_otel_logs_ts ON otel_logs(ts);
         CREATE TABLE IF NOT EXISTS alert_ack(
           fingerprint TEXT PRIMARY KEY,
           acked_at TEXT NOT NULL,
           note TEXT NOT NULL,
           until TEXT NOT NULL
         );
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
    let ts = now_iso();
    fn container_of<'a>(r: &'a Record, default_container: &'a str) -> &'a str {
        r.container.as_deref().unwrap_or(default_container)
    }
    let mut otel_span: Option<rusqlite::Statement<'_>> = None;
    let mut otel_log: Option<rusqlite::Statement<'_>> = None;
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
    batch.retain(|r| {
        match r.level {
            "ack_request" => {
                if r.message.contains(ACK_PHRASE) {
                    let now = now_iso();
                    let until = iso_offset(ACK_COOLDOWN_SECS as i64);
                    if let Ok(mut stmt) = conn.prepare(
                        "INSERT OR REPLACE INTO alert_ack(fingerprint,acked_at,note,until) VALUES(?1,?2,?3,?4)",
                    ) {
                        for fp in r.code.split(',').filter(|f| !f.is_empty()) {
                            let _ = stmt.execute(rusqlite::params![fp, now, r.message, until]);
                        }
                    }
                }
                false
            }
            "otel_span" => {
                if otel_span.is_none() {
                    otel_span = conn.prepare(
                        "INSERT INTO otel_spans(ts,container,trace_id,span_id,name,duration_us,ok,error,cell,attrs_json)
                         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                    ).ok();
                }
                if let Some(stmt) = otel_span.as_mut() {
                    let ctx: serde_json::Value = serde_json::from_str(&r.context).unwrap_or_default();
                    let _ = stmt.execute(rusqlite::params![
                        ts,
                        container_of(r, default_container),
                        ctx.get("trace_id").and_then(|v| v.as_str()),
                        ctx.get("span_id").and_then(|v| v.as_str()),
                        r.code,
                        ctx.get("duration_us").and_then(|v| v.as_i64()),
                        ctx.get("ok").and_then(|v| v.as_bool()).map(|b| b as i64),
                        ctx.get("error").and_then(|v| v.as_str()),
                        ctx.get("cell").and_then(|v| v.as_str()),
                        r.context,
                    ]);
                }
                false
            }
            "otel_log" => {
                if otel_log.is_none() {
                    otel_log = conn.prepare(
                        "INSERT INTO otel_logs(ts,container,trace_id,span_id,severity,body,attrs_json)
                         VALUES(?1,?2,?3,?4,?5,?6,?7)",
                    ).ok();
                }
                if let Some(stmt) = otel_log.as_mut() {
                    let ctx: serde_json::Value = serde_json::from_str(&r.context).unwrap_or_default();
                    let _ = stmt.execute(rusqlite::params![
                        ts,
                        container_of(r, default_container),
                        ctx.get("trace_id").and_then(|v| v.as_str()),
                        ctx.get("span_id").and_then(|v| v.as_str()),
                        r.code,
                        r.message,
                        r.context,
                    ]);
                }
                false
            }
            _ => true,
        }
    });
    for r in batch.drain(..) {
        let kind = if r.level == "error" { "error" } else { "log" };
        let _ = stmt.execute(rusqlite::params![
            ts,
            kind,
            r.subject_type,
            r.subject_id,
            container_of(&r, default_container),
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
    let node = std::env::var("CELLD_RECORDS_LABEL")
        .or_else(|_| std::env::var("CELLD_NODE"))
        .unwrap_or_else(|_| "celld".into());
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

/// Synchronous one-shot shipment for one-shot CLI commands: the sender
/// thread cannot help here, because the process exits before its timer
/// fires (the 2026-11-07 ack that never arrived).
pub fn ship_now(endpoint: &str, container: &str, records: Vec<Record>) -> Result<()> {
    let mut batch = records;
    ship(endpoint, container, &mut batch);
    if !batch.is_empty() {
        anyhow::bail!("shipment failed; {} record(s) kept", batch.len());
    }
    Ok(())
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

pub const ACK_PHRASE: &str = "我知道了，我会转告用户的";
const ACK_COOLDOWN_SECS: u64 = 3 * 3600;

fn fingerprint(container: &str, module: &str, code: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in format!("{container}|{module}|{code}").as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

fn iso_offset(extra: i64) -> String {
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = (d.as_secs() as i64 + extra).max(0) as u64;
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
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
    format!("{y:04}-{m:02}-{dday:02}T{h:02}:{mi:02}:{s:02}Z")
}

pub struct Alert {
    pub fingerprint: String,
    pub container: String,
    pub module: String,
    pub code: String,
    pub count: u64,
    pub latest: String,
    pub sample: String,
}

/// 记录中心库路径：主容器取 CELLD_RECORDS_DB，其余取只读挂载/缺省路径。
fn alerts_db() -> String {
    std::env::var("CELLD_RECORDS_DB")
        .or_else(|_| std::env::var("CELLD_ALERTS_DB"))
        .unwrap_or_else(|_| "/var/lib/celld/records-center.db".into())
}

/// Minimal HTTP/1.1 GET over a blocking socket; returns the body.
fn http_get_json(url: &str) -> std::io::Result<String> {
    use std::io::{Read, Write};
    let rest = url.strip_prefix("http://").ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "records endpoint must be http://")
    })?;
    let (hostport, path) = match rest.split_once('/') {
        Some((h, pth)) => (h, format!("/{}", pth)),
        None => (rest, "/".to_string()),
    };
    let mut stream = std::net::TcpStream::connect(hostport)?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(5))).ok();
    stream.write_all(format!("GET {path} HTTP/1.1\r\nHost: {hostport}\r\nConnection: close\r\n\r\n").as_bytes())?;
    let mut response = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => response.extend_from_slice(&buf[..n]),
            Err(_) => break,
        }
        if response.len() > 4 * 1024 * 1024 {
            break;
        }
    }
    let text = String::from_utf8_lossy(&response);
    Ok(text.split("\r\n\r\n").skip(1).collect::<Vec<_>>().join("\r\n\r\n"))
}

/// 未确认告警的统一入口：分节点走 HTTP 查主节点；主节点（无 ENDPOINT）读本地库。
pub fn alerts_current() -> Result<Vec<Alert>> {
    if let Ok(endpoint) = std::env::var("CELLD_RECORDS_ENDPOINT") {
        if !endpoint.is_empty() {
            let base = endpoint.trim_end_matches("/append");
            let body = http_get_json(&format!("{base}/records/alerts"))?;
            let value: serde_json::Value = serde_json::from_str(&body)?;
            let mut out = Vec::new();
            for item in value
                .get("alerts")
                .and_then(|v| v.as_array())
                .ok_or_else(|| anyhow::anyhow!("alerts array missing"))?
            {
                out.push(Alert {
                    fingerprint: item.get("fingerprint").and_then(|v| v.as_str()).unwrap_or("").into(),
                    container: item.get("container").and_then(|v| v.as_str()).unwrap_or("").into(),
                    module: item.get("module").and_then(|v| v.as_str()).unwrap_or("").into(),
                    code: item.get("code").and_then(|v| v.as_str()).unwrap_or("").into(),
                    count: item.get("count").and_then(|v| v.as_u64()).unwrap_or(0),
                    latest: item.get("latest").and_then(|v| v.as_str()).unwrap_or("").into(),
                    sample: item.get("sample").and_then(|v| v.as_str()).unwrap_or("").into(),
                });
            }
            return Ok(out);
        }
    }
    unacked_alerts(&alerts_db())
}

/// 最近 error 级记录（JSON 行）——分节点走 HTTP；主节点读本地库。
pub fn errors_current() -> Result<Vec<serde_json::Value>> {
    if let Ok(endpoint) = std::env::var("CELLD_RECORDS_ENDPOINT") {
        if !endpoint.is_empty() {
            let base = endpoint.trim_end_matches("/append");
            let body = http_get_json(&format!("{base}/records/errors"))?;
            let value: serde_json::Value = serde_json::from_str(&body)?;
            return Ok(value
                .get("errors")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default());
        }
    }
    let conn = Connection::open_with_flags(alerts_db().as_str(), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut stmt = conn.prepare(
        "SELECT json_object('ts',ts,'container',container,'module',module,'code',code,'level',level,'message',message_full)
         FROM records WHERE level='error' ORDER BY id DESC LIMIT 50",
    )?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    Ok(rows
        .filter_map(|r| r.ok())
        .filter_map(|s| serde_json::from_str(&s).ok())
        .collect())
}

/// 主节点路由用：未确认告警的 JSON（供 GET /records/alerts）。
pub fn alerts_json() -> Result<serde_json::Value> {
    let alerts = unacked_alerts(&alerts_db())?;
    let items: Vec<serde_json::Value> = alerts
        .iter()
        .map(|a| {
            serde_json::json!({
                "fingerprint": a.fingerprint,
                "container": a.container,
                "module": a.module,
                "code": a.code,
                "count": a.count,
                "latest": a.latest,
                "sample": a.sample,
            })
        })
        .collect();
    Ok(serde_json::json!({ "alerts": items }))
}

/// 主节点路由用：最近 error 记录的 JSON（供 GET /records/errors）。
pub fn errors_json() -> Result<serde_json::Value> {
    let conn = Connection::open_with_flags(alerts_db().as_str(), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut stmt = conn.prepare(
        "SELECT json_object('ts',ts,'container',container,'module',module,'code',code,'level',level,'message',message_full)
         FROM records WHERE level='error' ORDER BY id DESC LIMIT 50",
    )?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let items: Vec<serde_json::Value> = rows
        .filter_map(|r| r.ok())
        .filter_map(|s| serde_json::from_str(&s).ok())
        .collect();
    Ok(serde_json::json!({ "errors": items }))
}

/// 未确认的 error 级报错（近 24 小时、按 容器+模块+错误码 聚合、排除冷却中的指纹）。
pub fn unacked_alerts(db_path: &str) -> Result<Vec<Alert>> {
    let conn = Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let cutoff = iso_offset(0);
    let day_ago = iso_offset(-86_400);
    let mut out = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT container, module, code, COUNT(*), MAX(ts), MAX(message_full)
         FROM records
         WHERE level='error' AND kind='error' AND ts >= ?1
         GROUP BY container, module, code",
    )?;
    let rows = stmt.query_map(rusqlite::params![day_ago], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, u64>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
        ))
    })?;
    for r in rows {
        let (container, module, code, count, latest, sample) = r?;
        let fp = fingerprint(&container, &module, &code);
        let covered: Option<String> = conn
            .query_row(
                "SELECT until FROM alert_ack WHERE fingerprint=?1",
                rusqlite::params![fp],
                |row| row.get(0),
            )
            .ok();
        if let Some(until) = covered {
            if until.as_str() > cutoff.as_str() {
                continue;
            }
        }
        out.push(Alert { fingerprint: fp, container, module, code, count, latest, sample });
    }
    out.sort_by_key(|a| std::cmp::Reverse(a.count));
    Ok(out)
}

/// 确认一批指纹（校验原句），全部进入 3 小时冷却；确认语落库存档。
pub fn ack_all(db_path: &str, note: &str) -> Result<usize> {
    if !note.contains(ACK_PHRASE) {
        anyhow::bail!("确认语必须包含原句：{ACK_PHRASE}");
    }
    let alerts = unacked_alerts(db_path)?;
    let conn = Connection::open(db_path)?;
    let now = iso_offset(0);
    let until = iso_offset(ACK_COOLDOWN_SECS as i64);
    let mut n = 0;
    for a in &alerts {
        conn.execute(
            "INSERT OR REPLACE INTO alert_ack(fingerprint,acked_at,note,until) VALUES(?1,?2,?3,?4)",
            rusqlite::params![a.fingerprint, now, note, until],
        )?;
        n += 1;
    }
    Ok(n)
}

/// 进门横幅：有未确认报错时打印到 stderr（半强制）。任何失败都静默。
pub fn banner_if_needed() {
    if std::env::var("CELLD_RECORDS_BANNER").as_deref() == Ok("0") {
        return;
    }
    if let Ok(alerts) = alerts_current() {
        if !alerts.is_empty() {
            for line in banner_text(&alerts) {
                eprintln!("{line}");
            }
        }
    }
}

/// `celld records ...` 子命令。async 仅为与其它 cli::run 签名一致。
pub async fn cli(arguments: Vec<String>) -> Result<()> {
    ensure_init();
    let sub = arguments.first().map(String::as_str).unwrap_or("alert");
    match sub {
        "alert" | "banner" => {
            let alerts = alerts_current()?;
            if alerts.is_empty() {
                println!("当前没有未确认的 error 级报错。");
                return Ok(());
            }
            for line in banner_text(&alerts) {
                println!("{line}");
            }
            Ok(())
        }
        "ack" => {
            let alerts = alerts_current()?;
            let note = arguments
                .iter()
                .position(|a| a == "--note")
                .and_then(|i| arguments.get(i + 1))
                .cloned()
                .unwrap_or_default();
            if !note.contains(ACK_PHRASE) {
                anyhow::bail!("请原句回复确认语：{ACK_PHRASE}（可在其后附加补充说明）");
            }
            let fps: Vec<String> = alerts.iter().map(|a| a.fingerprint.clone()).collect();
            if let Ok(endpoint) = std::env::var("CELLD_RECORDS_ENDPOINT") {
                if !endpoint.is_empty() {
                    let label =
                        std::env::var("CELLD_RECORDS_LABEL").unwrap_or_else(|_| "peer".into());
                    ship_now(
                        &endpoint,
                        &label,
                        vec![Record {
                            subject_type: "node",
                            subject_id: label.clone(),
                            module: "records",
                            level: "ack_request",
                            code: fps.join(","),
                            message: note,
                            context: "{}".to_string(),
                            container: None,
                        }],
                    )?;
                    println!(
                        "已转交主节点确认（{} 个指纹），进入 3 小时冷却。别忘了在回答里转告用户。",
                        fps.len()
                    );
                    return Ok(());
                }
            }
            let db = std::env::var("CELLD_RECORDS_DB")
                .unwrap_or_else(|_| "/var/lib/celld/records-center.db".into());
            let n = ack_all(&db, &note)?;
            println!("已确认 {n} 条报错，进入 3 小时冷却。别忘了在回答里转告用户。");
            Ok(())
        }
        "status" => {
            for row in errors_current()? {
                println!("{row}");
            }
            Ok(())
        }
        other => anyhow::bail!("未知子命令 records {other:?}；可用：alert / ack / status"),
    }
}

/// 横幅文本（alert 与进门横幅共用）。
fn banner_text(alerts: &[Alert]) -> Vec<String> {
    let mut lines = vec![format!(
        "[记录中心·未确认报错 {} 条——进门必读，处理前不得忽略]",
        alerts.len()
    )];
    for (i, a) in alerts.iter().enumerate().take(9) {
        lines.push(format!(
            "{}. [{}] {}/{} ×{} 最新 {} | {}",
            i + 1,
            a.container,
            a.module,
            a.code,
            a.count,
            a.latest.chars().take(19).collect::<String>(),
            a.sample.chars().take(60).collect::<String>()
        ));
    }
    if alerts.len() > 9 {
        lines.push(format!("… 其余 {} 条见完整查询", alerts.len() - 9));
    }
    lines.push(
        "完整查看所有报错（必须看完，再在回答中统一汇报给用户，不得遗漏）：".into(),
    );
    lines.push("  celld records status".into());
    lines.push("解除阻断（原句确认，三小时冷却）：".into());
    lines.push("  celld records ack --note \u{22}我知道了，我会转告用户的\u{22}".into());
    lines
}

/// Dropped-record counter, surfaced by diagnose so a silent observability
/// failure is itself observable.
pub fn dropped() -> u64 {
    DROPPED.load(std::sync::atomic::Ordering::Relaxed)
}

/// A sender clone for in-process producers (the telemetry sink). Fails when
/// records are disabled or the sink is the shipper mode.
pub fn channel() -> Result<SyncSender<Record>> {
    ensure_init();
    SENDER
        .get()
        .and_then(|s| s.as_ref())
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("records writer not initialized"))
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
