import type {
  AttemptKind,
  MainWatch,
  Mode,
  OutboxEffect,
  Phase,
  PhaseKind,
} from "../core/thread-machine.js";

export type { AttemptKind, MainWatch, Mode, OutboxEffect, Phase, PhaseKind };

export type ReviewerVendor = "openai" | "gemini" | "anthropic";

export type ReviewVerdict = "approve" | "veto";

export interface ReviewFinding {
  file: string;
  line?: number;
  severity: "blocker" | "major" | "minor";
  summary: string;
  suggestion?: string;
}

export interface ThreadRecord {
  issueNumber: number;
  repo: string;
  title: string;
  themeLabel: string | null;
  bodySha256: string;
  phase: Phase;
  state: PhaseKind;
  version: number;
  mode: Mode;
  branchName: string;
  lastSummary: string | null;
  implementCount: number;
  revisionCount: number;
  rebaseCount: number;
  implementerVendors: ReviewerVendor[];
  createdAt: number;
  updatedAt: number;
}

export interface AttemptRecord {
  id: number;
  repo: string;
  issueNumber: number;
  kind: AttemptKind;
  status: "running" | "succeeded" | "failed" | "aborted";
  headSha: string | null;
  costUsd: number;
  transcriptPath: string | null;
  errorMessage: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface ReviewRecord {
  id: number;
  repo: string;
  issueNumber: number;
  headSha: string;
  vendor: ReviewerVendor;
  verdict: ReviewVerdict;
  findingsJson: string;
  costUsd: number;
  createdAt: number;
}

export interface MergeRecord {
  id: number;
  repo: string;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  squashSha: string | null;
  shadowOnly: boolean;
  disagreed: boolean;
  dayKey: string;
  mainWatch: MainWatch;
  createdAt: number;
}

export interface OutboxRecord {
  id: number;
  repo: string;
  effect: OutboxEffect;
  attempts: number;
  lastError: string | null;
  createdAt: number;
}

export interface DaemonCommandRecord {
  id: number;
  repo: string;
  issueNumber: number;
  kind: "handoff";
  status: "pending" | "completed" | "failed";
  resultJson: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ScoutProposalRecord {
  repo: string;
  issueNumber: number;
  scoutName: string;
  contentSha256: string;
  titleFp: string;
  createdAt: number;
}

export interface AuditLogEntry {
  id: number;
  ts: number;
  repo: string | null;
  topic: string;
  issueNumber: number | null;
  actor: string;
  payloadJson: string;
}

export const LEDGER_SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS threads (
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  theme_label TEXT,
  body_sha256 TEXT NOT NULL,
  phase_json TEXT NOT NULL,
  state TEXT GENERATED ALWAYS AS (json_extract(phase_json, '$.kind')) STORED,
  version INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'autonomous' CHECK (mode IN ('autonomous', 'advisory')),
  branch_name TEXT NOT NULL,
  last_summary TEXT,
  implement_count INTEGER NOT NULL DEFAULT 0,
  revision_count INTEGER NOT NULL DEFAULT 0,
  rebase_count INTEGER NOT NULL DEFAULT 0,
  implementer_vendors_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo, issue_number)
);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  head_sha TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  transcript_path TEXT,
  error_message TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  FOREIGN KEY (repo, issue_number) REFERENCES threads(repo, issue_number)
);

CREATE TABLE IF NOT EXISTS pushed_shas (
  repo TEXT NOT NULL,
  sha TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  origin TEXT NOT NULL, -- 'broker' | 'owner_resume'
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repo, sha),
  FOREIGN KEY (repo, issue_number) REFERENCES threads(repo, issue_number)
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  vendor TEXT NOT NULL,
  verdict TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(repo, issue_number, head_sha, vendor),
  FOREIGN KEY (repo, issue_number) REFERENCES threads(repo, issue_number)
);

CREATE TABLE IF NOT EXISTS merges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  squash_sha TEXT,
  shadow_only INTEGER NOT NULL DEFAULT 0,
  disagreed INTEGER NOT NULL DEFAULT 0,
  day_key TEXT NOT NULL,
  main_watch_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (repo, issue_number) REFERENCES threads(repo, issue_number)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_merges_shadow_unique
  ON merges(repo, issue_number, head_sha)
  WHERE shadow_only = 1;

CREATE TABLE IF NOT EXISTS daily_spend (
  day_key TEXT PRIMARY KEY,
  usd REAL NOT NULL DEFAULT 0,
  reserved_usd REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  effect_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS daemon_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result_json TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  repo TEXT,
  topic TEXT NOT NULL,
  issue_number INTEGER,
  actor TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_topic_ts ON audit_log(topic, ts);
CREATE INDEX IF NOT EXISTS idx_audit_log_issue ON audit_log(repo, issue_number, ts);

CREATE TABLE IF NOT EXISTS system_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_cooldowns (
  provider TEXT PRIMARY KEY,
  until_ts INTEGER NOT NULL,
  reason TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scout_proposals (
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  scout_name TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  title_fp TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repo, issue_number)
);

CREATE INDEX IF NOT EXISTS idx_scout_proposals_fp ON scout_proposals(repo, title_fp);
`;
