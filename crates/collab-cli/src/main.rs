use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Exclusive,
    Shared,
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
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub msg_id: String,
    pub seq: i64,
    pub channel: String,
    pub author: String,
    pub ts: i64,
    pub body: String,
    #[serde(default)]
    pub mentions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
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
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StateDocument {
    pub schema_version: i32,
    pub seq: i64,
    #[serde(default)]
    pub claims: Vec<Claim>,
    #[serde(default)]
    pub messages: Vec<Message>,
    #[serde(default)]
    pub holders: Vec<Holder>,
}

impl Default for StateDocument {
    fn default() -> Self {
        Self {
            schema_version: 1,
            seq: 0,
            claims: vec![],
            messages: vec![],
            holders: vec![],
        }
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
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

pub fn resolve_default_state_file() -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let norm_cwd = cwd.to_string_lossy().replace('\\', "/");
    let parts: Vec<&str> = norm_cwd.split('/').filter(|x| !x.is_empty()).collect();
    let base = parts.last().unwrap_or(&"default").replace(|c: char| !c.is_alphanumeric() && c != '_' && c != '-', "_");
    let hash = hash_project_key(&norm_cwd);
    let file_name = format!("{}-{}.json", base, hash);

    let home = std::env::var("DSH_HOME")
        .map(PathBuf::from)
        .or_else(|_| std::env::var("HOME").map(|h| PathBuf::from(h).join(".dsh")))
        .unwrap_or_else(|_| PathBuf::from(".dsh"));

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

fn load_state(path: &Path) -> Result<StateDocument> {
    if !path.exists() {
        return Ok(StateDocument::default());
    }
    let content = fs::read_to_string(path).context("Failed to read state file")?;
    let doc: StateDocument = serde_json::from_str(&content).context("Failed to parse JSON")?;
    Ok(doc)
}

fn save_state(path: &Path, doc: &StateDocument) -> Result<()> {
    let content = serde_json::to_string_pretty(doc).context("Failed to serialize state")?;
    fs::write(path, content).context("Failed to write state file")?;
    Ok(())
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let state_file = cli.file.unwrap_or_else(resolve_default_state_file);
    let mut state = load_state(&state_file)?;
    let now = now_ms();

    // 惰性过期
    state.claims.retain(|c| c.expires_at > now);

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

            // 冲突检测
            let mut conflicts = Vec::new();
            for c in &state.claims {
                if c.holder_id == holder || c.expires_at <= now || c.mode == Mode::Shared {
                    continue;
                }
                for p in &norm_paths {
                    for cp in &c.paths {
                        if overlaps(p, cp) {
                            let rem = ((c.expires_at - now) / 1000).max(0);
                            conflicts.push(format!(
                                "Path '{}' overlaps with '{}' held by {} (expires in {}s)",
                                p, cp, c.holder_id, rem
                            ));
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
                    for cf in conflicts {
                        eprintln!("  - {}", cf);
                    }
                    eprintln!("💡 Suggestion: wait for lease expiration or negotiate via collab_board");
                }
                std::process::exit(1);
            }

            state.seq += 1;
            let claim_id = format!("c_{}", state.seq);
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
            };
            state.claims.push(claim.clone());
            save_state(&state_file, &state)?;

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
            if let Some(cid) = claim_id {
                state.claims.retain(|c| !(c.claim_id == cid && c.holder_id == holder));
            } else if !paths.is_empty() {
                let npaths: Vec<String> = paths.iter().filter_map(|p| norm_path(p)).collect();
                state.claims.retain(|c| {
                    !(c.holder_id == holder
                        && c.paths.iter().any(|cp| npaths.iter().any(|p| overlaps(p, cp))))
                });
            } else {
                anyhow::bail!("claim_id or paths required for release");
            }
            let released = before - state.claims.len();
            save_state(&state_file, &state)?;
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
                let msg = Message {
                    msg_id: format!("m_{}", state.seq),
                    seq: state.seq,
                    channel: channel.clone(),
                    author,
                    ts: now,
                    body,
                    mentions: vec![],
                    reply_to: None,
                };
                state.messages.push(msg.clone());
                save_state(&state_file, &state)?;
                println!("Posted message [{}] to #{}", msg.msg_id, channel);
            } else {
                let msgs: Vec<&Message> = state
                    .messages
                    .iter()
                    .filter(|m| m.channel == channel && m.seq > since)
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
                    if c.expires_at <= now || c.mode == Mode::Shared {
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
}

