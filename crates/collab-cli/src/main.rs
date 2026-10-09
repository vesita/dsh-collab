use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Exclusive,
    Shared,
    /// 只读观测（schema `$defs.Mode` 的第三个成员）：不排他，也不被他人排他。
    /// **必须能反序列化** —— TS 侧会写入 mode:"read" 的声明，缺这个变体会让整个状态文件解析失败。
    Read,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
    pub claim_id: String,
    pub holder_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub holder_name: Option<String>,
    pub paths: Vec<String>,
    pub mode: Mode,
    pub ttl_sec: i64,
    pub expires_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub created_at: i64,
    /// 可读性（0.8.0 功能 C）：true = 他人可读（默认），false = 他人读取也要先协商。
    /// `default` 让 0.7.0 之前的状态文件照常解析成"可读"。
    #[serde(default = "default_readable")]
    pub readable: bool,
    /// 读者（0.8.0 功能 D，反向注册）：被本声明通知过的会话 holderId。
    /// **必须参与反序列化**，否则本 CLI 的一次 claim/release 回写就会静默抹掉全部读者的登记。
    #[serde(default)]
    pub readers: Vec<String>,
    /// 单元 C：Lamport 逻辑时钟序号（写时 bump 过所见最大值）。id = `c_<seq>@<writer>`。
    #[serde(default)]
    pub seq: i64,
    /// 单元 C：写者戳（本 CLI 进程的身份）。两个写者撞上同一个 seq 也不会撞 id。
    #[serde(default)]
    pub writer: String,
}

/// 缺省可读（与 TS 侧 `isReadable` 的归一一致）。
fn default_readable() -> bool {
    true
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub msg_id: String,
    pub seq: i64,
    pub channel: String,
    pub author: String,
    pub ts: i64,
    /// 正文上限 8000 字符（SSOT `$defs.Message.properties.body.maxLength`；
    /// 同值常量见 collab-core 的 `MESSAGE_BODY_MAX_CHARS`；超限由 post() 以 bad-request 挡回，不截断）。
    pub body: String,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    /// 单元 C：写者戳（msgId = `m_<seq>@<writer>`）。
    #[serde(default)]
    pub writer: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Holder {
    pub holder_id: String,
    pub name: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proc: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StateDocument {
    pub schema_version: i32,
    pub seq: i64,
    pub claims: Vec<Claim>,
    pub messages: Vec<Message>,
    pub holders: Vec<Holder>,
    /// 单元 C：最后一次落盘这份文档的写者戳（写后验证用）。老状态文件缺省空串。
    #[serde(default)]
    pub writer: String,
    /// 单元 C：终态墓碑表（claimId -> 原租约 expiresAt）。release / 自动释放 / reap 走这里，
    /// 而不是把声明从数组里删掉 —— 删除在 join 下不单调，墓碑才单调。
    #[serde(default)]
    pub released: HashMap<String, i64>,
}

impl Default for StateDocument {
    fn default() -> Self {
        Self {
            schema_version: 1,
            seq: 0,
            claims: vec![],
            messages: vec![],
            holders: vec![],
            writer: String::new(),
            released: HashMap::new(),
        }
    }
}

/// schema `$defs.ConflictInfo.properties.suggestedAction` 的枚举派生。
/// snake_case 序列化：wait / negotiate / switch_path。
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SuggestedAction {
    Wait,
    Negotiate,
    SwitchPath,
}

/// schema `$defs.ConflictInfo` 的 Rust 派生（TS 侧同名类型见 src/types/collab.d.ts 的 ConflictInfo）。
/// 由 `claim` 的冲突分支真实构造，因此不是"仅供对照"的死类型。
/// 与 TS 侧 `conflictError()` 同源：required = claimId/holderId/path/overlapsWith/mode/expiresAt，
/// 其余为可选。
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConflictInfo {
    pub claim_id: String,
    pub holder_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub holder_name: Option<String>,
    pub path: String,
    pub overlaps_with: String,
    pub mode: Mode,
    pub expires_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining_sec: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_action: Option<SuggestedAction>,
}

/// schema `$defs.TeamScopeTask` 的 Rust 派生：官方 Agent Teams 任务的**只读**视图。
/// 数据由 dsh-experimental-agent-team 拥有，**不是本插件的状态**；只取在跑任务（status
/// `in_progress`）的 writeScopes（项目相对路径前缀）做 advisory 交叉预警。
/// 只读类型：CLI 从不构造它，只反序列化宿主给的任务视图。
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TeamScopeTask {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_name: Option<String>,
    pub write_scopes: Vec<String>,
}

/// schema `$defs.TeamScopeOverlap` 的 Rust 派生：团队任务写域与 collab_lock 声明的重叠
/// （advisory 交叉预警，**不改变任何门控**）。`scope` = 团队任务声明的写域，
/// `path` = 相撞的那条 collab 路径。
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TeamScopeOverlap {
    pub task_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    pub scope: String,
    pub path: String,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// 本 CLI 进程的**写者戳**（单元 C）：每进程稳定、唯一。
///
/// 为什么不是随机数了事：它决定记录 id 的全局唯一性（`c_<seq>@<writer>`）与写后验证的判据。
/// 这里用 `<pid>-<启动毫秒>-<进程内计数器>`：pid 把不同进程分开，毫秒与计数器把同一 pid
/// 在不同时刻/不同调用点分开（内核会复用 pid，单比 pid 不够）。不读 /proc，跨平台都拿得到。
/// 令牌里不含白名单外的字符，因此可以安全地嵌进 `id` 与 `"<seq>@<writer>"` 游标。
pub fn writer_id() -> String {
    static CALLS: AtomicU64 = AtomicU64::new(0);
    let n = CALLS.fetch_add(1, Ordering::Relaxed);
    format!("{}-{}-{}", std::process::id(), now_ms(), n)
}

pub fn norm_path(p: &str) -> Option<String> {
    let trimmed = p.trim();
    if trimmed.is_empty() {
        return None;
    }
    let s = trimmed.replace('\\', "/");
    let mut s_clean = s.as_str();
    while let Some(rest) = s_clean.strip_prefix("./") {
        s_clean = rest;
    }
    while let Some(rest) = s_clean.strip_prefix('/') {
        s_clean = rest;
    }
    let mut parts = Vec::new();
    for seg in s_clean.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            parts.pop();
        } else {
            parts.push(seg);
        }
    }
    if parts.is_empty() {
        return None;
    }
    let mut out = parts.join("/");
    if s.ends_with('/') {
        out.push('/');
    }
    Some(out)
}

pub fn segs(p: &str) -> Vec<&str> {
    p.split('/').filter(|x| !x.is_empty()).collect()
}

pub fn hash_project_key(s: &str) -> String {
    let mut h1: u32 = 0xdeadbeef;
    let mut h2: u32 = 0x41c64e6d;
    for &b in s.as_bytes() {
        let ch = b as u32;
        h1 = (h1 ^ ch).wrapping_mul(2654435761);
        h2 = (h2 ^ ch).wrapping_mul(1597334677);
    }
    h1 = (h1 ^ (h1 >> 16)).wrapping_mul(2246822507) ^ (h2 ^ (h2 >> 13)).wrapping_mul(3266489909);
    h2 = (h2 ^ (h2 >> 16)).wrapping_mul(2246822507) ^ (h1 ^ (h1 >> 13)).wrapping_mul(3266489909);
    let val: u64 = ((h2 as u64 & 0x1fffff) * 4294967296) + (h1 as u64);
    format!("{:012x}", val)
}

/// 展开开头的 `~` / `~/`，与 TS 侧 `src/paths.ts` 的 expandHome 语义一致。
fn expand_home(p: &str, home: Option<&str>) -> String {
    if let Some(h) = home {
        if p == "~" {
            return h.to_string();
        }
        if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
            return PathBuf::from(h).join(rest).to_string_lossy().into_owned();
        }
    }
    p.to_string()
}

pub fn resolve_default_state_file() -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let norm_cwd = cwd.to_string_lossy().replace('\\', "/");
    let parts: Vec<&str> = norm_cwd.split('/').filter(|x| !x.is_empty()).collect();
    let base = parts.last().unwrap_or(&"default").replace(|c: char| !c.is_alphanumeric() && c != '_' && c != '-', "_");
    let hash = hash_project_key(&norm_cwd);
    let file_name = format!("{}-{}.json", base, hash);

    let home_env = std::env::var("HOME").ok().filter(|h| !h.trim().is_empty());
    // DSH_HOME 优先；纯空白视为未设置；开头的 `~` 按 HOME 展开。
    // 与 TS 侧 paths.ts 的 dshHomeDir 保持同一语义；仅当 HOME 也缺失时退到进程 cwd 下的 .dsh。
    let explicit = std::env::var("DSH_HOME")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .map(|v| expand_home(&v, home_env.as_deref()));
    let home = explicit
        .map(PathBuf::from)
        .or_else(|| home_env.map(|h| PathBuf::from(h).join(".dsh")))
        .unwrap_or_else(|| cwd.join(".dsh"));

    let target_dir = home.join("collab").join("projects");
    let _ = fs::create_dir_all(&target_dir);
    target_dir.join(file_name)
}

pub fn overlaps(a: &str, b: &str) -> bool {
    let sa = segs(a);
    let sb = segs(b);
    let n = sa.len().min(sb.len());
    sa[..n] == sb[..n]
}

#[derive(Parser)]
#[command(name = "collab-cli")]
#[command(about = "High-performance Multi-Agent Collaboration CLI for DSH", long_about = None)]
struct Cli {
    #[arg(short, long, global = true, help = "Path to state file")]
    file: Option<PathBuf>,

    #[arg(long, global = true, help = "Output as JSON")]
    json: bool,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    #[command(about = "List active claims & project status")]
    List,

    #[command(about = "Overview of active claims grouped by holders")]
    Overview,

    #[command(about = "Claim directory or file paths for exclusive or shared work")]
    Claim {
        #[arg(required = true, help = "Paths to claim (directories end with /)")]
        paths: Vec<String>,
        #[arg(long, default_value = "cli:user", help = "Holder ID")]
        holder: String,
        #[arg(short, long, default_value = "CLI User", help = "Holder Name")]
        name: String,
        #[arg(short, long, default_value = "1800", help = "TTL in seconds")]
        ttl: i64,
        #[arg(long, help = "Shared mode")]
        shared: bool,
        #[arg(long, help = "Note explaining purpose")]
        note: Option<String>,
    },

    #[command(about = "Release active claims by claimId or paths")]
    Release {
        #[arg(long, help = "Claim ID to release")]
        claim_id: Option<String>,
        #[arg(long, help = "Paths to release")]
        paths: Vec<String>,
        #[arg(long, default_value = "cli:user", help = "Holder ID")]
        holder: String,
    },

    #[command(about = "Send or read messages from collaboration board")]
    Board {
        #[arg(long, help = "Post message body")]
        post: Option<String>,
        #[arg(short, long, default_value = "general", help = "Channel")]
        channel: String,
        #[arg(long, default_value = "cli:user", help = "Author")]
        author: String,
        #[arg(long, default_value = "0", help = "Read messages with seq > since")]
        since: i64,
        #[arg(long, default_value = "50", help = "Max messages to read")]
        limit: usize,
    },

    #[command(about = "Check current git status against active claims to prevent conflict before editing/committing")]
    GitCheck,
}

/// 加载结果：解析出的文档 + **加载时的原始字节**。
///
/// `raw` 是丢失更新守卫的判据：保存前把它与磁盘现状逐字节比较，不一致就拒绝写入。
/// `None` 表示加载时文件不存在（守卫会在文件"凭空出现"时同样拒绝）。
struct LoadedState {
    doc: StateDocument,
    raw: Option<Vec<u8>>,
}

/// 读文件字节；文件不存在返回 `Ok(None)`（而不是错误），其余 IO 错误照常上抛。
fn read_state_bytes(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("Failed to read state file {}", path.display())),
    }
}

fn load_state(path: &Path) -> Result<LoadedState> {
    match read_state_bytes(path)? {
        Some(raw) => {
            let doc: StateDocument =
                serde_json::from_slice(&raw).context("Failed to parse JSON")?;
            Ok(LoadedState {
                doc,
                raw: Some(raw),
            })
        }
        None => Ok(LoadedState {
            doc: StateDocument::default(),
            raw: None,
        }),
    }
}

/// 同目录兄弟文件名：在目标文件名后追加 `suffix`（与目标**同目录**，
/// 否则跨文件系统的 `rename` 不是原子的）。
fn sibling_with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|s| s.to_os_string())
        .unwrap_or_else(|| "state.json".into());
    name.push(suffix);
    match path.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir.join(name),
        _ => PathBuf::from(name),
    }
}

/// 同目录临时文件路径：带 pid + 纳秒 + 进程内计数器，保证同进程内并发调用也不撞名。
fn temp_sibling(path: &Path) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    sibling_with_suffix(
        path,
        &format!(".tmp-{}-{}-{}", std::process::id(), nanos, n),
    )
}

/// 跨进程写锁：同目录 `<name>.lock`，`create_new` 保证获取是原子的。
///
/// 只用来把 `[重读 → rename]` 临界区串行化。**光靠重读比较挡不住丢失更新**：
/// 重读本身要读完整个状态文件（大文件几十毫秒），若临界区不互斥，多个进程会在
/// 任何一次 `rename` 落地之前全部通过守卫，随后互相覆盖。持有时间 = 一次重读 + 一次改名。
struct WriteLock {
    path: PathBuf,
}

impl WriteLock {
    fn acquire(target: &Path) -> Result<Self> {
        let path = sibling_with_suffix(target, ".lock");
        let deadline = SystemTime::now() + Duration::from_secs(10);
        loop {
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut f) => {
                    let _ = writeln!(f, "{}", std::process::id());
                    return Ok(WriteLock { path });
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    if lock_is_stale(&path) {
                        let _ = fs::remove_file(&path);
                        continue;
                    }
                    if SystemTime::now() >= deadline {
                        anyhow::bail!(
                            "Refusing to write state file {}: another process holds the write \
                             lock {} (lost-update guard). No changes were written.",
                            target.display(),
                            path.display()
                        );
                    }
                    thread::sleep(Duration::from_millis(5));
                }
                Err(e) => {
                    return Err(e)
                        .with_context(|| format!("Failed to create write lock {}", path.display()))
                }
            }
        }
    }
}

impl Drop for WriteLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

/// 锁是否已僵死：持有者写下的 pid 已不存在，或锁文件太旧（临界区只有毫秒级，30s 足够）。
fn lock_is_stale(lock: &Path) -> bool {
    let Ok(content) = fs::read_to_string(lock) else {
        return true;
    };
    let Ok(pid) = content.trim().parse::<u32>() else {
        return true;
    };
    if Path::new("/proc").is_dir() && !Path::new(&format!("/proc/{pid}")).exists() {
        return true;
    }
    match fs::metadata(lock).and_then(|m| m.modified()) {
        Ok(mtime) => SystemTime::now()
            .duration_since(mtime)
            .map(|age| age > Duration::from_secs(30))
            .unwrap_or(false),
        Err(_) => true,
    }
}

/// 有守卫的原子替换：同目录临时文件 `write_all` + `sync_all`，**紧接着**在写锁内跑
/// `guard`，通过后 `rename` 到目标（POSIX 上原子）。任一步失败都清理临时文件与写锁。
///
/// 顺序是关键：耗时的临时文件写入放在临界区**之外**（各进程的临时文件名唯一，互不干扰），
/// 只有 `[重读 → rename]` 进锁。若把守卫提到写临时文件之前，所有并发进程都会在任何人
/// 改名之前通过守卫；若不给临界区加锁，多个进程仍会在同一次重读窗口里一起通过。二者
/// 都会让守卫形同虚设。
fn atomic_replace<F>(target: &Path, bytes: &[u8], guard: F) -> Result<()>
where
    F: FnOnce() -> Result<()>,
{
    let tmp = temp_sibling(target);
    let result = (|| -> Result<()> {
        let mut f = fs::File::create(&tmp)
            .with_context(|| format!("Failed to create temp file {}", tmp.display()))?;
        f.write_all(bytes)
            .with_context(|| format!("Failed to write temp state file {}", tmp.display()))?;
        f.sync_all()
            .with_context(|| format!("Failed to sync temp state file {}", tmp.display()))?;
        drop(f);
        let _lock = WriteLock::acquire(target)?;
        guard()?;
        fs::rename(&tmp, target).with_context(|| {
            format!(
                "Failed to atomically rename {} -> {}",
                tmp.display(),
                target.display()
            )
        })?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// 保存状态：**有守卫的原子替换**。
///
/// 1. 紧凑序列化：与 TS 侧 `JSON.stringify` 同格式，消除来回翻倍。
/// 2. 原子：同目录临时文件 + `rename`，读方永远不会看到 0 字节或半截内容。
/// 3. 守卫：`rename` 之前重读磁盘现状，与加载时的原始字节逐字节比较；
///    不一致 = 本次读取之后文件被别的进程改过 ⇒ 拒绝写入（宁可失败报错，也不静默覆盖）。
fn save_state(path: &Path, doc: &StateDocument, expected: Option<&[u8]>) -> Result<()> {
    let content = serde_json::to_string(doc).context("Failed to serialize state")?;
    atomic_replace(path, content.as_bytes(), || {
        let actual =
            read_state_bytes(path).context("Failed to re-read state file before saving")?;
        let unchanged = match (expected, actual.as_deref()) {
            (None, None) => true,
            (Some(loaded), Some(actual)) => loaded == actual,
            // 一边有、一边没有：文件在本次读取之后被创建或删除，同样算被改过。
            _ => false,
        };
        if !unchanged {
            anyhow::bail!(
                "Refusing to write state file {}: the file was modified by another process after \
                 this process read it (lost-update guard). No changes were written. Re-run the \
                 command so it reads the current state.",
                path.display()
            );
        }
        Ok(())
    })
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let state_file = cli.file.unwrap_or_else(resolve_default_state_file);
    // 加载时的原始字节必须一路带到保存点，作为丢失更新守卫的基准。
    let LoadedState {
        doc: mut state,
        raw: loaded_raw,
    } = load_state(&state_file)?;
    let now = now_ms();
    // 本进程的写者戳（单元 C）：所有 id 都带它，写盘前也把它盖在文档上（写后验证的判据）。
    let writer = writer_id();

    // 惰性过期
    state.claims.retain(|c| c.expires_at > now);
    // 墓碑的**确定性** GC（与 TS 侧 sweep 同一条规则）：原租约已过期 ⇒ 丢掉墓碑。
    state.released.retain(|_, exp| *exp > now);

    match cli.command {
        Commands::List => {
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&state)?);
            } else {
                println!("=== DSH Multi-Agent Collaboration Claims ===");
                println!("State File: {:?}", state_file);
                println!("Active Claims: {}", state.claims.len());
                for c in &state.claims {
                    let rem_sec = (c.expires_at - now) / 1000;
                    println!(
                        "- [{}] {} by {} (mode: {:?}, remaining: {}s, note: {})",
                        c.claim_id,
                        c.paths.join(", "),
                        c.holder_name.as_deref().unwrap_or(&c.holder_id),
                        c.mode,
                        rem_sec,
                        c.note.as_deref().unwrap_or("-")
                    );
                }
            }
        }
        Commands::Overview => {
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&state.claims)?);
            } else {
                println!("=== Project Collaboration Overview ===");
                println!("Total active claims: {}", state.claims.len());
                for c in &state.claims {
                    println!("* Holder: {} | Paths: {:?}", c.holder_id, c.paths);
                }
            }
        }
        Commands::Claim {
            paths,
            holder,
            name,
            ttl,
            shared,
            note,
        } => {
            let norm_paths: Vec<String> = paths.iter().filter_map(|p| norm_path(p)).collect();
            if norm_paths.is_empty() {
                anyhow::bail!("No valid paths provided");
            }

            let mode = if shared {
                Mode::Shared
            } else {
                Mode::Exclusive
            };

            // 冲突检测。与 src/collab-core.ts 的 claim() 同源：
            //   - read 是纯观测：他人 mode=read 的声明不排他（跳过），自己 mode=read 时整段跳过（不被挡）；
            //   - shared 同样跳过（会被独占挡，但不挡别人）。
            let mut conflicts: Vec<ConflictInfo> = Vec::new();
            if mode != Mode::Read {
                for c in &state.claims {
                    if c.holder_id == holder
                        || c.expires_at <= now
                        || c.mode == Mode::Shared
                        || c.mode == Mode::Read
                    {
                        continue;
                    }
                    for p in &norm_paths {
                        for cp in &c.paths {
                            if overlaps(p, cp) {
                                let remaining_sec = ((c.expires_at - now) / 1000).max(0);
                                conflicts.push(ConflictInfo {
                                    claim_id: c.claim_id.clone(),
                                    holder_id: c.holder_id.clone(),
                                    holder_name: Some(
                                        c.holder_name.clone().unwrap_or_else(|| c.holder_id.clone()),
                                    ),
                                    path: p.clone(),
                                    overlaps_with: cp.clone(),
                                    mode: c.mode.clone(),
                                    expires_at: c.expires_at,
                                    remaining_sec: Some(remaining_sec),
                                    // 与 TS conflictError() 同阈值：<=30s 建议等待，否则协商。
                                    suggested_action: Some(if remaining_sec <= 30 {
                                        SuggestedAction::Wait
                                    } else {
                                        SuggestedAction::Negotiate
                                    }),
                                });
                                break;
                            }
                        }
                    }
                }
            }

            if !conflicts.is_empty() {
                if cli.json {
                    let err = serde_json::json!({
                        "ok": false,
                        "error": "conflict",
                        "conflicts": conflicts
                    });
                    println!("{}", serde_json::to_string_pretty(&err)?);
                } else {
                    eprintln!("❌ Claim Conflict detected!");
                    for cf in &conflicts {
                        eprintln!(
                            "  - Path '{}' overlaps with '{}' held by {} (expires in {}s)",
                            cf.path,
                            cf.overlaps_with,
                            cf.holder_id,
                            cf.remaining_sec.unwrap_or(0)
                        );
                    }
                    eprintln!("💡 Suggestion: wait for lease expiration or negotiate via collab_board");
                }
                std::process::exit(1);
            }

            state.seq += 1;
            state.writer = writer.clone();
            // Lamport + 写者戳：seq 可能与另一个写者相撞，id 因 `@<writer>` 而仍然唯一。
            let claim_id = format!("c_{}@{}", state.seq, writer);
            let claim = Claim {
                claim_id: claim_id.clone(),
                holder_id: holder.clone(),
                holder_name: Some(name.clone()),
                paths: norm_paths.clone(),
                mode,
                ttl_sec: ttl,
                expires_at: now + ttl * 1000,
                note,
                created_at: now,
                readable: true,
                readers: Vec::new(),
                seq: state.seq,
                writer: writer.clone(),
            };
            state.claims.push(claim.clone());
            save_state(&state_file, &state, loaded_raw.as_deref())?;

            if cli.json {
                println!("{}", serde_json::to_string_pretty(&claim)?);
            } else {
                println!("✅ Successfully claimed [{}] for paths: {:?}", claim_id, norm_paths);
            }
        }
        Commands::Release {
            claim_id,
            paths,
            holder,
        } => {
            let before = state.claims.len();
            // 单元 C：release 不再"从数组里删掉就完事"，而是**立墓碑**（claimId -> 原 expiresAt）。
            // 删除在 join 下不单调：另一份还握着旧副本的写者会把这条声明并回盘上；墓碑才单调。
            let mut buried: Vec<(String, i64)> = Vec::new();
            if let Some(cid) = claim_id {
                for c in state.claims.iter().filter(|c| c.claim_id == cid && c.holder_id == holder) {
                    buried.push((c.claim_id.clone(), c.expires_at));
                }
                state.claims.retain(|c| !(c.claim_id == cid && c.holder_id == holder));
            } else if !paths.is_empty() {
                let npaths: Vec<String> = paths.iter().filter_map(|p| norm_path(p)).collect();
                for c in state.claims.iter().filter(|c| {
                    c.holder_id == holder
                        && c.paths.iter().any(|cp| npaths.iter().any(|p| overlaps(p, cp)))
                }) {
                    buried.push((c.claim_id.clone(), c.expires_at));
                }
                state.claims.retain(|c| {
                    !(c.holder_id == holder
                        && c.paths.iter().any(|cp| npaths.iter().any(|p| overlaps(p, cp))))
                });
            } else {
                anyhow::bail!("claim_id or paths required for release");
            }
            let released = before - state.claims.len();
            state.writer = writer.clone();
            for (id, exp) in &buried {
                let cur = state.released.get(id).copied();
                if cur.is_none() || *exp > cur.unwrap_or(i64::MIN) {
                    state.released.insert(id.clone(), *exp);
                }
            }
            save_state(&state_file, &state, loaded_raw.as_deref())?;
            println!("Released {} claim(s)", released);
        }
        Commands::Board {
            post,
            channel,
            author,
            since,
            limit,
        } => {
            if let Some(body) = post {
                state.seq += 1;
                state.writer = writer.clone();
                let msg = Message {
                    msg_id: format!("m_{}@{}", state.seq, writer),
                    seq: state.seq,
                    channel: channel.clone(),
                    author,
                    ts: now,
                    body,
                    reply_to: None,
                    writer: writer.clone(),
                };
                state.messages.push(msg.clone());
                save_state(&state_file, &state, loaded_raw.as_deref())?;
                println!("Posted message [{}] to #{}", msg.msg_id, channel);
            } else {
                // 游标是复合值 (seq, writer)：数字 --since 解释为 (since, "")，与 TS 侧同一条判据
                // （不漏；seq 恰好等于 since 且带写者戳的记录会被再送一遍）。
                let msgs: Vec<&Message> = state
                    .messages
                    .iter()
                    .filter(|m| m.channel == channel && (m.seq, m.writer.as_str()) > (since, ""))
                    .take(limit)
                    .collect();
                println!("=== Channel #{} Messages ===", channel);
                for m in msgs {
                    println!("[{}] <{}> {}", m.seq, m.author, m.body);
                }
            }
        }
        Commands::GitCheck => {
            println!("🔍 Inspecting git status against collaborative locks...");
            let output = Command::new("git")
                .args(["status", "--porcelain"])
                .output()
                .context("Failed to execute git command")?;
            let stdout = String::from_utf8_lossy(&output.stdout);
            let mut modified_files = Vec::new();
            for line in stdout.lines() {
                if line.len() > 3 {
                    let file = line[3..].trim();
                    modified_files.push(file.to_string());
                }
            }

            if modified_files.is_empty() {
                println!("✨ Git workspace is clean. No local uncommitted modifications.");
                return Ok(());
            }

            println!("Modified files in git: {:?}", modified_files);
            let mut warnings = Vec::new();
            for file in &modified_files {
                let norm = norm_path(file).unwrap_or_else(|| file.clone());
                for c in &state.claims {
                    if c.expires_at <= now || c.mode == Mode::Shared || c.mode == Mode::Read {
                        continue;
                    }
                    for cp in &c.paths {
                        if overlaps(&norm, cp) {
                            warnings.push(format!(
                                "⚠️ Warning: Modified file '{}' conflicts with active exclusive claim by '{}' on '{}' (remaining: {}s)",
                                file,
                                c.holder_id,
                                cp,
                                (c.expires_at - now) / 1000
                            ));
                        }
                    }
                }
            }

            if warnings.is_empty() {
                println!("✅ All git modified files are safe from other agents' active claims!");
            } else {
                for w in &warnings {
                    eprintln!("{}", w);
                }
                eprintln!("⚠️ Warning: Proceed with caution or coordinate with collaborator.");
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 0.8.0 回归：`readable` / `readers` 必须能读进来、也能写回去。
    /// 反例（修复前）：struct 里没有这两个字段 ⇒ 解析时被丢弃 ⇒ 本 CLI 一次写回
    /// 就把所有 claim 的读者登记与可读性抹掉（静默数据丢失）。
    #[test]
    fn test_readable_and_readers_round_trip() {
        let raw = r#"{
          "schemaVersion": 1,
          "seq": 2,
          "claims": [{
            "claimId": "c_1", "holderId": "agent:a", "holderName": "A",
            "paths": ["src/a/"], "mode": "exclusive", "ttlSec": 1800,
            "expiresAt": 99999999999999, "note": "", "createdAt": 1,
            "readable": false, "readers": ["agent:b", "agent:c"]
          }],
          "messages": [], "holders": []
        }"#;
        let doc: StateDocument = serde_json::from_str(raw).expect("state must parse");
        assert_eq!(doc.claims[0].readable, false);
        assert_eq!(doc.claims[0].readers, vec!["agent:b".to_string(), "agent:c".to_string()]);
        let out = serde_json::to_string(&doc).expect("state must serialize");
        assert!(out.contains("\"readable\":false"), "readable must survive a write-back: {out}");
        assert!(out.contains("\"agent:b\""), "readers must survive a write-back: {out}");

        // 老状态文件没有这两个字段 -> 解析成"可读 + 空读者"
        let legacy = r#"{
          "schemaVersion": 1, "seq": 1,
          "claims": [{
            "claimId": "c_1", "holderId": "agent:a", "paths": ["src/a/"],
            "mode": "exclusive", "ttlSec": 1800, "expiresAt": 99999999999999,
            "createdAt": 1
          }],
          "messages": [], "holders": []
        }"#;
        let old: StateDocument = serde_json::from_str(legacy).expect("legacy state must parse");
        assert_eq!(old.claims[0].readable, true, "a missing readable field means readable");
        assert!(old.claims[0].readers.is_empty(), "a missing readers field means no readers");
    }

    #[test]
    fn test_expand_home_matches_ts_semantics() {
        // 与 src/paths.ts 的 expandHome 对齐：~ 与 ~/ 展开，其余原样
        assert_eq!(expand_home("~/.dsh", Some("/home/u")), "/home/u/.dsh");
        assert_eq!(expand_home("~", Some("/home/u")), "/home/u");
        assert_eq!(expand_home("/abs/.dsh", Some("/home/u")), "/abs/.dsh");
        assert_eq!(expand_home("rel/.dsh", Some("/home/u")), "rel/.dsh");
        // 没有 HOME 时保持字面量，由调用方决定后果
        assert_eq!(expand_home("~/.dsh", None), "~/.dsh");
    }

    #[test]
    fn test_norm_path() {
        assert_eq!(norm_path("src/backend/"), Some("src/backend/".to_string()));
        assert_eq!(norm_path("./src/backend/models"), Some("src/backend/models".to_string()));
        assert_eq!(norm_path("C:\\src"), Some("C:/src".to_string()));
        assert_eq!(norm_path("src/foo/../bar/"), Some("src/bar/".to_string()));
    }

    #[test]
    fn test_overlaps() {
        assert!(overlaps("src/backend/", "src/backend/models/"));
        assert!(overlaps("src/backend/", "src/backend"));
        assert!(!overlaps("src/foo", "src/foobar"));
    }

    #[test]
    fn test_hash_project_key() {
        let h1 = hash_project_key("/home/vesita/coding/my/dsh-collab");
        assert_eq!(h1, "83f418894e9dd");
    }

    /// 回归：schema `$defs.Mode` 有第三个成员 `read`，TS 侧会真的写进状态文件。
    /// 反例（修复前）：enum 只有 Exclusive/Shared ⇒ 带 read 声明的整份状态文件解析失败（CLI 全挂）。
    #[test]
    fn test_read_mode_deserializes_and_round_trips() {
        let raw = r#"{
          "schemaVersion": 1, "seq": 1,
          "claims": [{
            "claimId": "c_1", "holderId": "agent:a", "paths": ["src/a/"],
            "mode": "read", "ttlSec": 1800, "expiresAt": 99999999999999, "createdAt": 1
          }],
          "messages": [], "holders": []
        }"#;
        let doc: StateDocument = serde_json::from_str(raw).expect("mode:read must parse");
        assert_eq!(doc.claims[0].mode, Mode::Read);
        let out = serde_json::to_string(&doc).expect("must serialize");
        assert!(out.contains("\"mode\":\"read\""), "read must survive a write-back: {out}");
    }

    /// schema 里 StateDocument 的 claims/messages/holders 是 **required**：
    /// 派生产物不得对它们放行（历史漂移：三个字段都带 #[serde(default)]，把必填当成了可选）。
    #[test]
    fn test_state_document_requires_arrays() {
        assert!(
            serde_json::from_str::<StateDocument>(r#"{ "schemaVersion": 1, "seq": 0 }"#).is_err(),
            "claims/messages/holders are required by the schema"
        );
    }

    /// ConflictInfo 是 schema `$defs.ConflictInfo` 的 Rust 派生，且被 claim 的冲突分支真实构造。
    #[test]
    fn test_conflict_info_serializes_like_schema() {
        let c = ConflictInfo {
            claim_id: "c_1".into(),
            holder_id: "agent:b".into(),
            holder_name: Some("B".into()),
            path: "src/a/".into(),
            overlaps_with: "src/a/".into(),
            mode: Mode::Exclusive,
            expires_at: 1,
            remaining_sec: Some(5),
            suggested_action: Some(SuggestedAction::Wait),
        };
        let s = serde_json::to_string(&c).expect("must serialize");
        assert!(s.contains("\"claimId\":\"c_1\""), "{s}");
        assert!(s.contains("\"overlapsWith\":\"src/a/\""), "{s}");
        assert!(s.contains("\"suggestedAction\":\"wait\""), "{s}");
        let sw = serde_json::to_string(&SuggestedAction::SwitchPath).unwrap();
        assert_eq!(sw, "\"switch_path\"");
    }

    // ---- R3a: 原子写 + 丢失更新守卫 ----

    /// 测试用唯一临时目录（不引入新依赖：pid + 纳秒）。
    fn unique_tmp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "collab-cli-test-{}-{}-{}",
            tag,
            std::process::id(),
            nanos
        ));
        fs::create_dir_all(&dir).expect("create tmp dir");
        dir
    }

    fn sample_claim(id: &str) -> Claim {
        Claim {
            claim_id: id.into(),
            holder_id: "cli:user".into(),
            holder_name: Some("CLI".into()),
            paths: vec!["src/a/".into()],
            mode: Mode::Exclusive,
            ttl_sec: 1800,
            expires_at: 99999999999999,
            note: None,
            created_at: 1,
            readable: true,
            readers: vec![],
            seq: 1,
            writer: "test".into(),
        }
    }

    /// 状态目录里残留的临时文件 / 写锁（应恒为空）。
    fn leftovers(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .expect("read tmp dir")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".tmp-") || n.ends_with(".lock"))
            .collect()
    }

    /// 正常路径：无并发改动 ⇒ 保存成功、内容正确、紧凑格式、无临时文件残留。
    #[test]
    fn test_save_state_normal_path_is_compact_and_clean() {
        let dir = unique_tmp_dir("normal");
        let path = dir.join("state.json");
        let loaded = load_state(&path).expect("load a missing file");
        assert!(loaded.raw.is_none(), "a missing file loads as raw=None");
        let mut doc = loaded.doc;
        doc.seq = 1;
        doc.claims.push(sample_claim("c_1"));

        save_state(&path, &doc, loaded.raw.as_deref()).expect("uncontended save must succeed");

        let raw = fs::read_to_string(&path).expect("read back");
        assert!(
            !raw.contains('\n'),
            "must be compact like TS JSON.stringify: {raw}"
        );
        let back: StateDocument = serde_json::from_str(&raw).expect("parse back");
        assert_eq!(back.seq, 1);
        assert_eq!(back.claims.len(), 1);
        assert_eq!(back.claims[0].claim_id, "c_1");
        assert!(
            leftovers(&dir).is_empty(),
            "no temp file may remain: {:?}",
            leftovers(&dir)
        );
        fs::remove_dir_all(&dir).ok();
    }

    /// 正常路径（文件已存在且未被改动）⇒ 守卫放行。
    #[test]
    fn test_save_state_allows_write_when_file_unchanged() {
        let dir = unique_tmp_dir("unchanged");
        let path = dir.join("state.json");
        let first = serde_json::to_string(&StateDocument::default()).unwrap();
        fs::write(&path, &first).unwrap();

        let loaded = load_state(&path).expect("load existing file");
        assert_eq!(loaded.raw.as_deref(), Some(first.as_bytes()));
        let mut doc = loaded.doc;
        doc.seq = 7;

        save_state(&path, &doc, loaded.raw.as_deref()).expect("unchanged file must be writable");
        let back: StateDocument =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(back.seq, 7);
        assert!(leftovers(&dir).is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    /// 守卫命中：加载后文件被别的进程创建 ⇒ 保存必须失败且报清楚原因，别动对方的数据。
    #[test]
    fn test_save_state_refuses_when_file_created_since_load() {
        let dir = unique_tmp_dir("guard-created");
        let path = dir.join("state.json");
        let loaded = load_state(&path).expect("load a missing file");
        let mut doc = loaded.doc;
        doc.seq = 1;
        doc.claims.push(sample_claim("c_1"));

        // 模拟另一个进程在本次读取之后写入
        let other = br#"{"schemaVersion":1,"seq":9,"claims":[],"messages":[],"holders":[]}"#;
        fs::write(&path, other).unwrap();

        let err = save_state(&path, &doc, loaded.raw.as_deref()).expect_err("guard must refuse");
        let msg = format!("{err:#}");
        assert!(msg.contains("modified by another process"), "{msg}");
        assert!(msg.contains("lost-update guard"), "{msg}");

        assert_eq!(
            fs::read(&path).unwrap(),
            other,
            "the other process's bytes must survive untouched"
        );
        assert!(
            leftovers(&dir).is_empty(),
            "refusal must not leave temp files: {:?}",
            leftovers(&dir)
        );
        fs::remove_dir_all(&dir).ok();
    }

    /// 守卫命中：加载后文件被别的进程改写 ⇒ 保存必须失败且不改动磁盘。
    #[test]
    fn test_save_state_refuses_when_existing_file_changed() {
        let dir = unique_tmp_dir("guard-changed");
        let path = dir.join("state.json");
        let original = serde_json::to_string(&StateDocument::default()).unwrap();
        fs::write(&path, &original).unwrap();

        let loaded = load_state(&path).expect("load existing file");
        let mut doc = loaded.doc;
        doc.claims.push(sample_claim("c_1"));

        let other_doc = StateDocument {
            seq: 42,
            ..Default::default()
        };
        let other = serde_json::to_string(&other_doc).unwrap();
        fs::write(&path, &other).unwrap();

        let err = save_state(&path, &doc, loaded.raw.as_deref()).expect_err("guard must refuse");
        assert!(format!("{err:#}").contains("modified by another process"));
        assert_eq!(fs::read_to_string(&path).unwrap(), other);
        fs::remove_dir_all(&dir).ok();
    }

    /// 丢失更新守卫的直接证据：两次加载后先后保存，第二次必须被挡下，
    /// 磁盘上保留第一次写入的那条 claim（一个都不丢，也不静默覆盖）。
    #[test]
    fn test_guard_stops_lost_update_between_two_loads() {
        let dir = unique_tmp_dir("lost-update");
        let path = dir.join("state.json");
        fs::write(
            &path,
            serde_json::to_string(&StateDocument::default()).unwrap(),
        )
        .unwrap();

        let a = load_state(&path).expect("load a");
        let b = load_state(&path).expect("load b");

        let mut doc_a = a.doc.clone();
        doc_a.seq = 1;
        doc_a.claims.push(sample_claim("c_a"));
        save_state(&path, &doc_a, a.raw.as_deref()).expect("first writer wins");

        let mut doc_b = b.doc.clone();
        doc_b.seq = 1;
        doc_b.claims.push(sample_claim("c_b"));
        let err = save_state(&path, &doc_b, b.raw.as_deref()).expect_err("stale writer must fail");
        assert!(format!("{err:#}").contains("modified by another process"));

        let back: StateDocument =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(back.claims.len(), 1, "no lost update, no silent overwrite");
        assert_eq!(back.claims[0].claim_id, "c_a");
        fs::remove_dir_all(&dir).ok();
    }

    /// 失败路径清理：`rename` 失败（目标是目录）时临时文件必须被删掉。
    #[test]
    fn test_atomic_write_cleans_temp_when_rename_fails() {
        let dir = unique_tmp_dir("rename-fail");
        let target = dir.join("target-is-a-dir");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("occupied"), b"x").unwrap(); // 非空目录 ⇒ rename 必然失败

        let err =
            atomic_replace(&target, b"{}", || Ok(())).expect_err("rename onto a dir must fail");
        assert!(format!("{err:#}").contains("rename"), "{err:#}");
        assert!(
            leftovers(&dir).is_empty(),
            "failed write must clean its temp file: {:?}",
            leftovers(&dir)
        );
        fs::remove_dir_all(&dir).ok();
    }

    /// 守卫在 `rename` 之前失败时，临时文件必须清理、目标原封不动。
    #[test]
    fn test_atomic_replace_cleans_temp_when_guard_refuses() {
        let dir = unique_tmp_dir("guard-temp");
        let target = dir.join("state.json");
        fs::write(&target, b"original").unwrap();

        let err = atomic_replace(&target, b"{}", || anyhow::bail!("guard said no"))
            .expect_err("guard refusal must abort the replace");
        assert!(format!("{err:#}").contains("guard said no"));
        assert_eq!(
            fs::read(&target).unwrap(),
            b"original",
            "target must be untouched"
        );
        assert!(
            leftovers(&dir).is_empty(),
            "guard refusal must clean its temp file: {:?}",
            leftovers(&dir)
        );
        fs::remove_dir_all(&dir).ok();
    }

    /// 写锁必须在 Drop 时释放，且僵死（持有者 pid 不存在 / 内容不可解析）的锁可被回收。
    #[test]
    fn test_write_lock_release_and_stale_detection() {
        let dir = unique_tmp_dir("write-lock");
        let target = dir.join("state.json");
        let lock_path = sibling_with_suffix(&target, ".lock");

        {
            let lock = WriteLock::acquire(&target).expect("first acquire must succeed");
            assert!(lock_path.exists(), "lock file must exist while held");
            assert!(!lock_is_stale(&lock_path), "our own live lock is not stale");
            drop(lock);
        }
        assert!(!lock_path.exists(), "lock must be released on drop");

        fs::write(&lock_path, format!("{}\n", u32::MAX)).unwrap();
        assert!(lock_is_stale(&lock_path), "a dead holder's lock is stale");
        fs::write(&lock_path, "not-a-pid").unwrap();
        assert!(lock_is_stale(&lock_path), "an unparsable lock is stale");
        fs::remove_dir_all(&dir).ok();
    }
}

