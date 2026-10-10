use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
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
// 字段顺序是**判据的一部分**：Rust 结构体序列化的键顺序必须与 TS `normalizeDoc` / `joinClaim`
// 的插入顺序一致（claimId, holderId, paths, mode, ttlSec, expiresAt, createdAt, holderName,
// note, readable, readers, seq, writer），否则黄金语料 `tests/fixtures/merge-golden.json` 的
// 逐字节比较会红（见下面的 merge 层注释）。
pub struct Claim {
    pub claim_id: String,
    pub holder_id: String,
    pub paths: Vec<String>,
    pub mode: Mode,
    pub ttl_sec: i64,
    pub expires_at: i64,
    pub created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub holder_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
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
// 顶层字段顺序同样与 TS `normalizeDoc` 的输出顺序一致，见上（writer 在 claims 之前）。
pub struct StateDocument {
    pub schema_version: i32,
    pub seq: i64,
    /// 单元 C：最后一次落盘这份文档的写者戳（写后验证用）。老状态文件缺省空串。
    #[serde(default)]
    pub writer: String,
    pub claims: Vec<Claim>,
    pub messages: Vec<Message>,
    pub holders: Vec<Holder>,
    /// 单元 C：终态墓碑表（claimId -> 墓碑值：原租约到期与"释放时刻 + ttl"的上界，取大者）。
    /// release / 自动释放 / reap 走这里，而不是把声明从数组里删掉 —— 删除在 join 下不单调，
    /// 墓碑才单调。BTreeMap（而不是 HashMap）：序列化时按键升序，与 TS 的规范序一致。
    #[serde(default)]
    pub released: BTreeMap<String, i64>,
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
            released: BTreeMap::new(),
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

// ---- 收敛层（单元 C，CLI 侧）：与 src/collab-core.ts 的 mergeDocs 逐字段同源 ----
//
// 为什么 CLI 也要合并：插件的写路径是 读 → `mergeDocs(盘上, 副本)` → 应用 op → 写 →
// **写后验证**；CLI 若还是 读 → 改 → `save_state`，它就会把插件刚写的整份覆盖掉
// （反过来也是），只能靠对方"下次再写"自愈。这里把同一个半格 join 移植过来，两条写路径
// 因此说同一种语言。
//
// **这是同一算法的第二份实现，靠黄金语料防漂移**：`tests/fixtures/merge-golden.json` 由
// `tests/gen-merge-golden.mjs` 从 TS 的 `mergeDocs` 现算生成；TS 侧
// `tests/collab-merge-golden.mjs` 与 Rust 侧 `test_merge_golden_corpus_matches_ts` 都断言
// 自己的输出与语料**逐字节相同**。TS 改了而语料没重跑 ⇒ TS 红；重跑了而 Rust 没跟上 ⇒ Rust 红。
// 结构体字段顺序也是判据：Rust 的键顺序必须与 TS `normalizeDoc` 的插入顺序一致，否则字节不等。
//
// 分量语义：`seq` 取 max（Lamport）；`writer` 取字典序 max（写盘前由写路径盖上本次写者戳）；
// `released` 求并（同键取大）；claims/messages/holders 按 id **逐字段** join（不是整条二选一，
// 否则并发续租的 expiresAt、并发登记的 readers 会丢）。输出是规范序，可直接逐字节比较。

/// 墓碑表上限（单元 D，与 TS 的 `MAX_RELEASED` 同值同规则）：按 `(墓碑值, claimId)` 保留最大的
/// N 条、丢最旧的。N 取 4096 的理由：墓碑最多活到"释放时刻 + ttl"（ttl 上限 24h），一次释放只
/// 产生一条，4096 条仍在 KB 级，只在异常密集的释放下才生效。规则**只看数据**，两个副本 GC 出
/// 同样结果 —— 否则不收敛。
const MAX_RELEASED: usize = 4096;

fn mode_str(m: &Mode) -> &'static str {
    match m {
        Mode::Exclusive => "exclusive",
        Mode::Shared => "shared",
        Mode::Read => "read",
    }
}

/// `(seq, writer)` 全序，与 TS `compareSeqWriter` 同一条判据（游标与记录排序共用）。
fn compare_seq_writer(a_seq: i64, a_writer: &str, b_seq: i64, b_writer: &str) -> std::cmp::Ordering {
    a_seq.cmp(&b_seq).then_with(|| a_writer.cmp(b_writer))
}

/// 字符串集合求并 + 规范序（字典序去重）。顺序不能带进结果，否则交换律被数组顺序破坏。
fn join_str_set(a: &[String], b: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for x in a.iter().chain(b.iter()) {
        if !out.contains(x) {
            out.push(x.clone());
        }
    }
    out.sort();
    out
}

/// 可选字符串取大；`None` 是底，有值的一方胜出。
fn join_max_str(a: &Option<String>, b: &Option<String>) -> Option<String> {
    match (a, b) {
        (None, None) => None,
        (None, Some(y)) => Some(y.clone()),
        (Some(x), None) => Some(x.clone()),
        (Some(x), Some(y)) => Some(if x >= y { x.clone() } else { y.clone() }),
    }
}

fn join_claim(a: &Claim, b: &Claim) -> Claim {
    Claim {
        claim_id: a.claim_id.clone(),
        holder_id: if a.holder_id >= b.holder_id {
            a.holder_id.clone()
        } else {
            b.holder_id.clone()
        },
        paths: join_str_set(&a.paths, &b.paths),
        mode: if mode_str(&a.mode) >= mode_str(&b.mode) {
            a.mode.clone()
        } else {
            b.mode.clone()
        },
        ttl_sec: a.ttl_sec.max(b.ttl_sec),
        expires_at: a.expires_at.max(b.expires_at),
        // createdAt 取小：创建时刻只能"更早"，不能被后到的副本推后。
        created_at: a.created_at.min(b.created_at),
        holder_name: join_max_str(&a.holder_name, &b.holder_name),
        note: join_max_str(&a.note, &b.note),
        // readable 取"与"（false 优先 = 更严格的可见性不会被翻松）。
        readable: a.readable && b.readable,
        readers: join_str_set(&a.readers, &b.readers),
        seq: a.seq.max(b.seq),
        writer: if a.writer >= b.writer {
            a.writer.clone()
        } else {
            b.writer.clone()
        },
    }
}

fn join_message(a: &Message, b: &Message) -> Message {
    let channel = if a.channel >= b.channel {
        a.channel.clone()
    } else {
        b.channel.clone()
    };
    let author = if a.author >= b.author {
        a.author.clone()
    } else {
        b.author.clone()
    };
    let body = if a.body >= b.body {
        a.body.clone()
    } else {
        b.body.clone()
    };
    Message {
        msg_id: a.msg_id.clone(),
        seq: a.seq.max(b.seq),
        channel: if channel.is_empty() {
            "general".to_string()
        } else {
            channel
        },
        author,
        ts: a.ts.max(b.ts),
        body,
        reply_to: join_max_str(&a.reply_to, &b.reply_to),
        writer: if a.writer >= b.writer {
            a.writer.clone()
        } else {
            b.writer.clone()
        },
    }
}

fn join_holder(a: &Holder, b: &Holder) -> Holder {
    Holder {
        holder_id: a.holder_id.clone(),
        name: if a.name >= b.name {
            a.name.clone()
        } else {
            b.name.clone()
        },
        kind: if a.kind >= b.kind {
            a.kind.clone()
        } else {
            b.kind.clone()
        },
        session_id: join_max_str(&a.session_id, &b.session_id),
        last_seen_at: a.last_seen_at.max(b.last_seen_at),
        proc: join_max_str(&a.proc, &b.proc),
    }
}

/// 按 id 把一组记录折叠成逐字段 join（同一 id 的多份全部并进来，不是二选一）。
fn fold_by<T: Clone>(
    rows: &[T],
    id_of: impl Fn(&T) -> String,
    join: impl Fn(&T, &T) -> T,
) -> Vec<T> {
    let mut at: HashMap<String, usize> = HashMap::new();
    let mut out: Vec<T> = Vec::new();
    for x in rows {
        let id = id_of(x);
        if id.is_empty() {
            continue;
        }
        match at.get(&id) {
            Some(&i) => out[i] = join(&out[i], x),
            None => {
                at.insert(id, out.len());
                out.push(join(x, x));
            }
        }
    }
    out
}

/// 规范形：补默认、同 id 逐字段折叠、剔除墓碑表里那些 id 的声明、全部数组排成确定性顺序。
/// 它就是幂等律里的"规范形"：`merge_docs(a, a)` 逐字段等于 `normalize_doc(a)`。
fn normalize_doc(s: &StateDocument) -> StateDocument {
    let mut released: BTreeMap<String, i64> = BTreeMap::new();
    for (k, v) in s.released.iter() {
        if !k.is_empty() {
            released.insert(k.clone(), *v);
        }
    }
    let mut claims: Vec<Claim> = fold_by(&s.claims, |c| c.claim_id.clone(), join_claim)
        .into_iter()
        .filter(|c| !released.contains_key(&c.claim_id))
        .collect();
    claims.sort_by(|x, y| {
        compare_seq_writer(x.seq, &x.writer, y.seq, &y.writer)
            .then_with(|| x.claim_id.cmp(&y.claim_id))
    });
    let mut messages: Vec<Message> = fold_by(&s.messages, |m| m.msg_id.clone(), join_message);
    messages.sort_by(|x, y| {
        compare_seq_writer(x.seq, &x.writer, y.seq, &y.writer)
            .then_with(|| x.msg_id.cmp(&y.msg_id))
    });
    let mut holders: Vec<Holder> = fold_by(&s.holders, |h| h.holder_id.clone(), join_holder);
    holders.sort_by(|x, y| x.holder_id.cmp(&y.holder_id));
    StateDocument {
        schema_version: 1,
        seq: s.seq,
        writer: s.writer.clone(),
        claims,
        messages,
        holders,
        released,
    }
}

/// **半格 join**：`merge_docs(a, b)` = a 与 b 的最小上界。两步：两边的记录直接拼接，
/// 再交给 `normalize_doc`（按 id 逐字段 join 折叠、剔除墓碑、排成规范序）。
fn merge_docs(a: &StateDocument, b: &StateDocument) -> StateDocument {
    let a = normalize_doc(a);
    let b = normalize_doc(b);
    let mut released = a.released.clone();
    for (k, v) in b.released.iter() {
        match released.get(k) {
            Some(cur) if *cur >= *v => {}
            _ => {
                released.insert(k.clone(), *v);
            }
        }
    }
    normalize_doc(&StateDocument {
        schema_version: 1,
        seq: a.seq.max(b.seq),
        writer: if a.writer >= b.writer {
            a.writer.clone()
        } else {
            b.writer.clone()
        },
        claims: a.claims.iter().chain(b.claims.iter()).cloned().collect(),
        messages: a.messages.iter().chain(b.messages.iter()).cloned().collect(),
        holders: a.holders.iter().chain(b.holders.iter()).cloned().collect(),
        released,
    })
}

/// 给若干条声明立墓碑：墓碑值 = `max(现有值, claim.expiresAt, 释放时刻 + ttlSec)`。
///
/// 第三项堵住一个真实边角：若有一条**并发续租**在释放之后才被合并进来，它的 `expiresAt`
/// 可以大于原 `expiresAt`；只取原值的话，墓碑按自己的到期被 GC 之后那条声明会**重新具备权威**
/// （同一个 holder 有两个进程在写 —— 会话被恢复的现场）。取"释放时刻 + ttl"把整段可能的续租
/// 窗口盖住，墓碑因此活到那之后，而那时的声明必然已过期。
fn bury(s: &mut StateDocument, claims: &[Claim], t: i64) {
    for c in claims {
        if c.claim_id.is_empty() {
            continue;
        }
        let exp = c
            .expires_at
            .max(t.saturating_add(c.ttl_sec.saturating_mul(1000)));
        let cur = s.released.get(&c.claim_id).copied();
        let v = match cur {
            Some(cur) => cur.max(exp),
            None => exp,
        };
        s.released.insert(c.claim_id.clone(), v);
    }
}

/// 惰性清理（与 TS `sweep` 的确定性规则同源）：过期声明、按值到期的墓碑、墓碑表上限。
/// 判据只看数据与传入的 t，不看本地计数/插入顺序 —— 同一份数据在任何副本上得到同一结果。
fn sweep_state(s: &mut StateDocument, t: i64) {
    s.claims.retain(|c| c.expires_at > t);
    s.released.retain(|_, exp| *exp > t);
    if s.released.len() > MAX_RELEASED {
        let mut entries: Vec<(String, i64)> =
            s.released.iter().map(|(k, v)| (k.clone(), *v)).collect();
        // 保留 (墓碑值, claimId) 最大的 MAX_RELEASED 条；同值先按 claimId 降序，确定性地丢最旧。
        entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.0.cmp(&a.0)));
        let keep: BTreeSet<String> = entries
            .into_iter()
            .take(MAX_RELEASED)
            .map(|(k, _)| k)
            .collect();
        s.released.retain(|k, _| keep.contains(k));
    }
}

/// 一次写命令的结果（打印在事务**之外**：重试会多次执行 apply，不能重复打印）。
enum WriteOutcome {
    Claim { claim: Claim, paths: Vec<String> },
    Release { released: usize },
    Posted { msg_id: String, channel: String },
    Conflict(Vec<ConflictInfo>),
    None,
}

/// 写入失败是否属于"读之后文件被别人改过"，值得重读后重试（`save_state` 的守卫文案）。
fn is_stale(e: &anyhow::Error) -> bool {
    let m = format!("{e:#}");
    m.contains("modified by another process") || m.contains("lost-update guard")
}

/// **写后验证**：落盘成功不等于这份内容还在盘上。重读主文件，确认写者戳还是自己；
/// 是别人（非空且不同）⇒ 被覆盖了（false）⇒ 重读重合并重试；观测不到 ⇒ 不判定（true）。
fn write_landed(path: &Path, writer: &str) -> bool {
    if writer.is_empty() {
        return true;
    }
    let Ok(text) = fs::read_to_string(path) else {
        return true;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return true;
    };
    match v.get("writer").and_then(|w| w.as_str()) {
        Some(w) if !w.is_empty() => w == writer,
        _ => true,
    }
}

/// 读改写事务（与 TS `state-core.mutate()` 同一个形状）：
/// 读盘 → `merge_docs(盘上, 我的副本)` → sweep → 应用本次命令 → 写 → **写后验证**；
/// 写失败（乐观并发冲突）或验证发现被覆盖时，重读 + 重合并 + 重试（最多 5 轮）。
///
/// 重试**不重跑 apply**：命令的效果已经留在 `applied` 里，下一轮只把它与新盘 join 起来再写
/// （对 claim 重跑只是幂等，但对 post 会多出一条 seq 不同的留言 = 同一条消息落两条）。
fn commit<F>(
    state_file: &Path,
    writer: &str,
    seed: StateDocument,
    mut apply: F,
) -> Result<WriteOutcome>
where
    F: FnMut(&mut StateDocument) -> Result<WriteOutcome>,
{
    let mut replica = normalize_doc(&seed);
    let mut applied: Option<StateDocument> = None;
    let mut outcome: Option<WriteOutcome> = None;
    for attempt in 0..5 {
        let loaded = load_state(state_file)?;
        let mut next: StateDocument;
        if let Some(prev) = applied.as_ref() {
            next = merge_docs(&loaded.doc, prev);
            next.writer = writer.to_string();
            sweep_state(&mut next, now_ms());
        } else {
            // 「我的」= 盘上 ∪ 本实例的副本（半格 join）；盖上本次写者戳（apply 里的 id 从它取，
            // 它同时是写后验证的判据）。
            let mut mine = merge_docs(&loaded.doc, &replica);
            mine.writer = writer.to_string();
            sweep_state(&mut mine, now_ms());
            replica = normalize_doc(&mine);
            let out = apply(&mut mine)?;
            if let WriteOutcome::Conflict(_) = out {
                // 冲突分支**绝不写盘**：被挡回的命令没有产生任何该持久化的状态。
                return Ok(out);
            }
            outcome = Some(out);
            next = mine;
        }
        next.writer = writer.to_string();
        applied = Some(next.clone());
        match save_state(state_file, &next, loaded.raw.as_deref()) {
            Ok(()) => {}
            Err(e) if is_stale(&e) && attempt < 4 => continue,
            Err(e) => return Err(e),
        }
        // 先把本次结果留在 applied（已在上方），再验证：验证失败时下一轮就是
        // merge(新盘, 我的结果) —— 我的改动不会被丢掉。
        if write_landed(state_file, writer) {
            return Ok(outcome.unwrap_or(WriteOutcome::None));
        }
    }
    anyhow::bail!(
        "State file {} is busy: could not land a merged write after 5 attempts. No partial state \
         was left behind; re-run the command.",
        state_file.display()
    )
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let state_file = cli.file.unwrap_or_else(resolve_default_state_file);
    // 初始快照：读命令直接用它；写命令把它当「我的副本」的起点交给 commit（commit 内部会重读）。
    let LoadedState { doc: mut state, raw: _ } = load_state(&state_file)?;
    let now = now_ms();
    // 本进程的写者戳（单元 C）：所有 id 都带它，写盘前也把它盖在文档上（写后验证的判据）。
    let writer = writer_id();

    // 惰性过期（读路径用；写路径由 commit 内的 sweep_state 再跑一遍）
    state.claims.retain(|c| c.expires_at > now);
    // 墓碑的**确定性** GC（与 TS 侧 sweep 同一条规则）。
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

            // 冲突检测 + 立声明，整段在 commit 的**合并基**上执行：重试用合并后的状态重新判，
            // 所以不会因为盘上刚多出一条别人的声明而漏判。
            // 与 src/collab-core.ts 的 claim() 同源：
            //   - read 是纯观测：他人 mode=read 的声明不排他（跳过），自己 mode=read 时整段跳过（不被挡）；
            //   - shared 同样跳过（会被独占挡，但不挡别人）。
            let outcome = commit(&state_file, &writer, state, |s| {
                let mut conflicts: Vec<ConflictInfo> = Vec::new();
                if mode != Mode::Read {
                    for c in &s.claims {
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
                                            c.holder_name
                                                .clone()
                                                .unwrap_or_else(|| c.holder_id.clone()),
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
                    return Ok(WriteOutcome::Conflict(conflicts));
                }

                // s.writer 已由 commit 盖成本次写者戳；Lamport：seq 是「盘上 ∪ 我的副本」的最大值 +1。
                // seq 可能与另一个写者相撞，id 因 `@<writer>` 而仍然唯一。
                s.seq += 1;
                let claim_id = format!("c_{}@{}", s.seq, writer);
                let claim = Claim {
                    claim_id: claim_id.clone(),
                    holder_id: holder.clone(),
                    holder_name: Some(name.clone()),
                    paths: norm_paths.clone(),
                    mode: mode.clone(),
                    ttl_sec: ttl,
                    expires_at: now + ttl * 1000,
                    note: note.clone(),
                    created_at: now,
                    readable: true,
                    readers: Vec::new(),
                    seq: s.seq,
                    writer: writer.clone(),
                };
                s.claims.push(claim.clone());
                Ok(WriteOutcome::Claim {
                    claim,
                    paths: norm_paths.clone(),
                })
            })?;

            match outcome {
                WriteOutcome::Conflict(conflicts) => {
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
                WriteOutcome::Claim { claim, paths } => {
                    if cli.json {
                        println!("{}", serde_json::to_string_pretty(&claim)?);
                    } else {
                        println!(
                            "✅ Successfully claimed [{}] for paths: {:?}",
                            claim.claim_id, paths
                        );
                    }
                }
                _ => unreachable!("claim commit returns Claim or Conflict"),
            }
        }
        Commands::Release {
            claim_id,
            paths,
            holder,
        } => {
            let outcome = commit(&state_file, &writer, state, |s| {
                // 单元 C：release 不再"从数组里删掉就完事"，而是**立墓碑**。
                // 删除在 join 下不单调：另一份还握着旧副本的写者会把这条声明并回盘上；墓碑才单调。
                let mut buried: Vec<Claim> = Vec::new();
                if let Some(cid) = claim_id.as_deref() {
                    for c in s
                        .claims
                        .iter()
                        .filter(|c| c.claim_id == cid && c.holder_id == holder)
                    {
                        buried.push(c.clone());
                    }
                    s.claims
                        .retain(|c| !(c.claim_id == cid && c.holder_id == holder));
                } else if !paths.is_empty() {
                    let npaths: Vec<String> = paths.iter().filter_map(|p| norm_path(p)).collect();
                    for c in s.claims.iter().filter(|c| {
                        c.holder_id == holder
                            && c.paths.iter().any(|cp| npaths.iter().any(|p| overlaps(p, cp)))
                    }) {
                        buried.push(c.clone());
                    }
                    s.claims.retain(|c| {
                        !(c.holder_id == holder
                            && c.paths.iter().any(|cp| npaths.iter().any(|p| overlaps(p, cp))))
                    });
                } else {
                    anyhow::bail!("claim_id or paths required for release");
                }
                let released = buried.len();
                bury(s, &buried, now);
                Ok(WriteOutcome::Release { released })
            })?;
            if let WriteOutcome::Release { released } = outcome {
                println!("Released {} claim(s)", released);
            }
        }
        Commands::Board {
            post,
            channel,
            author,
            since,
            limit,
        } => {
            if let Some(body) = post {
                let outcome = commit(&state_file, &writer, state, |s| {
                    s.seq += 1;
                    let msg = Message {
                        msg_id: format!("m_{}@{}", s.seq, writer),
                        seq: s.seq,
                        channel: channel.clone(),
                        author: author.clone(),
                        ts: now,
                        body: body.clone(),
                        reply_to: None,
                        writer: writer.clone(),
                    };
                    s.messages.push(msg.clone());
                    Ok(WriteOutcome::Posted {
                        msg_id: msg.msg_id,
                        channel: channel.clone(),
                    })
                })?;
                if let WriteOutcome::Posted { msg_id, channel } = outcome {
                    println!("Posted message [{}] to #{}", msg_id, channel);
                }
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

    // ---- 单元 D：黄金语料（TS ↔ Rust 防漂移）与 CLI 合并写路径 ----

    /// 测试用通用声明构造。
    fn full_claim(id: &str, holder: &str, paths: &[&str], writer: &str, seq: i64, exp: i64) -> Claim {
        Claim {
            claim_id: id.into(),
            holder_id: holder.into(),
            paths: paths.iter().map(|s| s.to_string()).collect(),
            mode: Mode::Exclusive,
            ttl_sec: 1800,
            expires_at: exp,
            created_at: 1,
            holder_name: Some(holder.into()),
            note: None,
            readable: true,
            readers: vec![],
            seq,
            writer: writer.into(),
        }
    }

    #[derive(Deserialize)]
    struct GoldenCase {
        name: String,
        a: StateDocument,
        b: StateDocument,
        expected: String,
    }

    #[derive(Deserialize)]
    struct Golden {
        cases: Vec<GoldenCase>,
    }

    /// 黄金语料（单元 D）：Rust 的 `merge_docs` 必须与 TS 现算的 `expected` **逐字节相同**。
    /// 这是同一算法两份实现的防漂移机制：改了 TS 不重跑语料 ⇒ TS 测试红；重跑了 Rust 没跟上 ⇒ 这里红。
    /// 逐字节比较把**字段顺序**也钉住了（Rust 结构体的键顺序必须与 TS normalizeDoc 的插入顺序一致）。
    #[test]
    fn test_merge_golden_corpus_matches_ts() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/merge-golden.json");
        let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let g: Golden = serde_json::from_str(&raw).expect("parse merge-golden.json");
        assert!(g.cases.len() >= 12, "corpus too small: {}", g.cases.len());
        for c in &g.cases {
            let got = serde_json::to_string(&merge_docs(&c.a, &c.b)).expect("serialize merged");
            assert_eq!(got, c.expected, "case {}: merged bytes differ from the TS corpus", c.name);
            let swapped = serde_json::to_string(&merge_docs(&c.b, &c.a)).expect("serialize swapped");
            assert_eq!(swapped, c.expected, "case {}: commutativity bytes differ", c.name);
            let idem = serde_json::to_string(&normalize_doc(&c.a)).expect("serialize normalized");
            let idem2 = serde_json::to_string(&merge_docs(&c.a, &c.a)).expect("serialize idempotent");
            assert_eq!(idem2, idem, "case {}: idempotence", c.name);
        }
    }

    /// 「插件先写、CLI 再写」：CLI 的写必须把盘上插件的记录并进来。
    /// 负向对照见 `test_negative_control_whole_file_overwrite_loses_plugin_update`。
    #[test]
    fn test_cli_merge_keeps_plugin_update() {
        let dir = unique_tmp_dir("cli-merge-plugin");
        let path = dir.join("state.json");
        // 盘上：插件已经写好的文档（含它的一条声明），写者戳是 plugin-1。
        let plugin_doc = StateDocument {
            seq: 1,
            writer: "plugin-1".into(),
            claims: vec![full_claim("c_1@plugin-1", "agent:P", &["src/p/"], "plugin-1", 1, 9_999_999_999_999)],
            ..Default::default()
        };
        fs::write(&path, serde_json::to_string(&plugin_doc).unwrap()).unwrap();

        // CLI 进程在插件写之前就把盘读成了空（seed 为空），随后才写自己的声明。
        let out = commit(&path, "cli-w", StateDocument::default(), |s| {
            s.seq += 1;
            let c = full_claim(
                &format!("c_{}@cli-w", s.seq),
                "cli:user",
                &["src/c/"],
                "cli-w",
                s.seq,
                9_999_999_999_999,
            );
            s.claims.push(c.clone());
            Ok(WriteOutcome::Claim { claim: c, paths: vec!["src/c/".into()] })
        })
        .expect("commit must succeed");
        assert!(matches!(out, WriteOutcome::Claim { .. }));

        let back: StateDocument = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let ids: Vec<&str> = back.claims.iter().map(|c| c.claim_id.as_str()).collect();
        assert!(ids.contains(&"c_1@plugin-1"), "plugin record must survive the CLI write: {ids:?}");
        assert!(ids.iter().any(|i| i.ends_with("@cli-w")), "CLI record must be present: {ids:?}");
        assert_eq!(back.writer, "cli-w", "the landed writer stamp is the CLI's own");
        fs::remove_dir_all(&dir).ok();
    }

    /// 负向对照（RED）：退回"读 → 改 → 整份覆盖"（不 merge）⇒ 插件的记录确实被覆盖掉。
    /// 这正是单元 D 要堵的那条旧 CLI 写路径。
    #[test]
    fn test_negative_control_whole_file_overwrite_loses_plugin_update() {
        let dir = unique_tmp_dir("cli-neg-overwrite");
        let path = dir.join("state.json");
        let plugin_doc = StateDocument {
            seq: 1,
            writer: "plugin-1".into(),
            claims: vec![full_claim("c_1@plugin-1", "agent:P", &["src/p/"], "plugin-1", 1, 9_999_999_999_999)],
            ..Default::default()
        };
        fs::write(&path, serde_json::to_string(&plugin_doc).unwrap()).unwrap();

        // 旧写路径：拿 CLI 自己那份（空 seed + 自己的声明）整份替换。
        let doc = StateDocument {
            seq: 1,
            writer: "cli-w".into(),
            claims: vec![full_claim("c_1@cli-w", "cli:user", &["src/c/"], "cli-w", 1, 9_999_999_999_999)],
            ..Default::default()
        };
        fs::write(&path, serde_json::to_string(&doc).unwrap()).unwrap();

        let back: StateDocument = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(back.claims.len(), 1, "RED: the overwrite leaves only the CLI's record");
        assert_eq!(back.claims[0].claim_id, "c_1@cli-w");
        fs::remove_dir_all(&dir).ok();
    }

    /// 「CLI 先写、插件再写」：插件做一次 **merge(盘上, 自己的副本)** 的正常写 ⇒ 两边都在；
    /// 负向对照（同一测试内）：插件整份覆盖自己的副本 ⇒ CLI 的记录丢。
    #[test]
    fn test_cli_first_then_plugin_merge_keeps_both() {
        let dir = unique_tmp_dir("cli-first-plugin-second");
        let path = dir.join("state.json");
        // CLI 先写（走 commit）。
        commit(&path, "cli-w", StateDocument::default(), |s| {
            s.seq += 1;
            let c = full_claim(
                &format!("c_{}@cli-w", s.seq),
                "cli:user",
                &["src/c/"],
                "cli-w",
                s.seq,
                9_999_999_999_999,
            );
            s.claims.push(c.clone());
            Ok(WriteOutcome::Claim { claim: c, paths: vec!["src/c/".into()] })
        })
        .expect("CLI commit must succeed");

        // 插件随后写：副本是它在 CLI 写之前读到的空盘，但它会先 merge(盘上, 副本)。
        let plugin_replica = StateDocument::default();
        let loaded: StateDocument = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let mut next = merge_docs(&loaded, &plugin_replica);
        next.writer = "plugin-1".into();
        next.seq += 1;
        next.claims.push(full_claim(
            &format!("c_{}@plugin-1", next.seq),
            "agent:P",
            &["src/p/"],
            "plugin-1",
            next.seq,
            9_999_999_999_999,
        ));
        fs::write(&path, serde_json::to_string(&next).unwrap()).unwrap();
        let back: StateDocument = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let writers: Vec<&str> = back.claims.iter().map(|c| c.writer.as_str()).collect();
        assert!(writers.contains(&"cli-w") && writers.contains(&"plugin-1"), "both must survive: {writers:?}");

        // 负向对照（RED）：插件不合并、拿自己的副本整份覆盖 ⇒ CLI 的记录丢。
        let neg = dir.join("neg.json");
        let mut own = StateDocument::default();
        own.writer = "plugin-1".into();
        own.seq = 1;
        own.claims.push(full_claim("c_1@plugin-1", "agent:P", &["src/p/"], "plugin-1", 1, 9_999_999_999_999));
        fs::write(&neg, serde_json::to_string(&own).unwrap()).unwrap();
        let neg_back: StateDocument = serde_json::from_str(&fs::read_to_string(&neg).unwrap()).unwrap();
        assert_eq!(neg_back.claims.len(), 1, "RED: whole-file overwrite loses the CLI record");
        assert_eq!(neg_back.claims[0].writer, "plugin-1");
        fs::remove_dir_all(&dir).ok();
    }

    // ---- 单元 D：墓碑值取上界 + 墓碑表有界 ----

    /// 墓碑值 = `max(现有值, claim.expiresAt, 释放时刻 + ttlSec)`：把"释放之后才合并进来的
    /// 并发续租"整段窗口盖住，墓碑 GC 之后那条声明仍不具备权威。负向对照（同测试内）：
    /// 退回"只取原 expiresAt"⇒ 墓碑先被 GC、续租复活成权威。
    #[test]
    fn test_tombstone_upper_bound_covers_concurrent_renewal() {
        let mut claim = full_claim("c_1@wA", "agent:A", &["src/a/"], "wA", 1, 10000);
        claim.ttl_sec = 10; // 释放于 t=1000 时墓碑 = max(10000, 1000+10000) = 11000
        let mut d = StateDocument::default();
        d.claims.push(claim.clone());
        d.claims.clear();
        bury(&mut d, &[claim.clone()], 1000);
        assert_eq!(
            d.released.get("c_1@wA"),
            Some(&11000),
            "release at t=1000 with ttl=10s => max(10000, 1000+10000)"
        );

        // 并发续租：另一个进程在 t=500 续租 ⇒ expiresAt = 10500 > 原 10000；它在释放之后才合并进来。
        let mut renewed = claim.clone();
        renewed.expires_at = 10500;
        let mut replica = StateDocument::default();
        replica.claims.push(renewed);

        // 正题：在"旧墓碑会被 GC、而续租还没到期"的窗口（10200）里，墓碑必须还在。
        let mut before = d.clone();
        sweep_state(&mut before, 10200);
        assert_eq!(before.released.get("c_1@wA"), Some(&11000), "tombstone must survive 10200");
        assert_eq!(merge_docs(&before, &replica).claims.len(), 0, "renewal must stay buried");

        // 墓碑按自己的值被 GC 之后，那条续租也已过期（10500 <= 11000）⇒ 仍无权威。
        let mut after_gc = d.clone();
        sweep_state(&mut after_gc, 11000);
        assert!(after_gc.released.is_empty(), "tombstone is GC'd at its own value");
        let merged = normalize_doc(&merge_docs(&after_gc, &replica));
        assert_eq!(merged.claims.len(), 1);
        assert_eq!(merged.claims[0].expires_at, 10500, "revived but already expired");

        // 负向对照（RED）：只取原 expiresAt（= 10000）⇒ 10200 就被 GC，续租复活成权威。
        let mut old = StateDocument::default();
        old.released.insert("c_1@wA".into(), 10000);
        let mut old_after = old.clone();
        sweep_state(&mut old_after, 10200);
        assert!(old_after.released.is_empty(), "RED: the old tombstone is gone at 10200");
        assert_eq!(
            normalize_doc(&merge_docs(&old_after, &replica)).claims.len(),
            1,
            "RED: the concurrent renewal becomes authoritative again"
        );
    }

    /// 墓碑表有界：超过 `MAX_RELEASED` 时按 (墓碑值, claimId) 保留最大的那些、丢最旧的；
    /// 规则只看数据 ⇒ 插入顺序不同也 GC 出同样结果。负向对照（同测试内）：保留最小的 N 条
    /// ⇒ 最新（值最大）的墓碑被丢，被它镇住的声明复活成权威。
    #[test]
    fn test_tombstone_table_bounded_and_deterministic() {
        let total = MAX_RELEASED + 5;
        let id_of = |i: usize| format!("c_{i}@wA");
        let build = |ascending: bool| {
            let mut d = StateDocument::default();
            let mut order: Vec<usize> = (0..total).collect();
            if !ascending {
                order.reverse();
            }
            for i in order {
                d.released.insert(id_of(i), 1000 + i as i64);
            }
            d
        };
        let mut a = build(true);
        let mut b = build(false);
        sweep_state(&mut a, 0);
        sweep_state(&mut b, 0);
        assert_eq!(a.released.len(), MAX_RELEASED);
        assert_eq!(
            serde_json::to_string(&a).unwrap(),
            serde_json::to_string(&b).unwrap(),
            "the cap must be deterministic across insertion orders"
        );
        for i in 0..5 {
            assert!(!a.released.contains_key(&id_of(i)), "oldest tombstone {i} must be dropped");
        }
        assert!(
            a.released.contains_key(&id_of(total - 1)) && a.released.contains_key(&id_of(total - 5)),
            "the newest tombstones must be kept"
        );

        // 负向对照（RED）：保留最小的 N 条 ⇒ 最新的墓碑被丢，被它镇住的声明复活。
        let mut all: Vec<(String, i64)> = build(true).released.into_iter().collect();
        all.sort_by(|x, y| x.1.cmp(&y.1).then_with(|| x.0.cmp(&y.0)));
        let wrong: BTreeMap<String, i64> = all.into_iter().take(MAX_RELEASED).collect();
        let newest = id_of(total - 1);
        assert!(!wrong.contains_key(&newest), "RED: keep-smallest drops the newest tombstone");
        let mut wrong_doc = StateDocument::default();
        wrong_doc.released = wrong;
        let mut replica = StateDocument::default();
        replica.claims.push(full_claim(
            &newest,
            "agent:A",
            &["src/a/"],
            "wA",
            1,
            1000 + (total as i64 - 1),
        ));
        let merged = normalize_doc(&merge_docs(&wrong_doc, &replica));
        assert_eq!(merged.claims.len(), 1, "RED: the buried claim revives under keep-smallest");
        assert_eq!(merged.claims[0].claim_id, newest);
    }
}

