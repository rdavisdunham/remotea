/**
 * Eridani's MCP server for spawned agents (task 3bc2803c).
 *
 * A run's agent reports through Eridani's MCP tools (submit_plan, task_step,
 * task_interview, session_link). A fresh worktree has no `.mcp.json` and the
 * host may have no user-scope server, so every spawn (and every resume)
 * brings its own:
 *
 *   claude  `--mcp-config <dir>/eridani-mcp/<surf>.json`, a file (mode 0600,
 *           outside the worktree so it is never committed) naming the
 *           server `eridani`: `{type: "http", url, headers: {Authorization:
 *           "Bearer <key>"}}`. No `--strict-mcp-config`: the user's own
 *           servers stay available.
 *   codex   `-c mcp_servers.eridani.url="<url>"`
 *           `-c mcp_servers.eridani.bearer_token_env_var="REMOTEA_ERIDANI_MCP_TOKEN"`,
 *           with the key in that variable of the session's environment
 *           (supplied at launch, never written to eridani-runs.json).
 *
 * The URL is `<eridani origin>/api/v1/external/mcp/` (the trailing slash is
 * required), derived from the link URL, or `mcpUrl` in eridani.json. The key
 * is an Eridani bot key with agents:session, tasks and notes read/write,
 * read from `mcpKeyFile` (per target, else global, else
 * `<config dir>/eridani-mcp-token`). It is never the link key (a file that
 * holds the link key is refused), and it never appears in argv, logs, the
 * outbox, the journal or the status file.
 *
 * When it cannot be set up (no key file, a bad URL) the agent is spawned
 * without it and the spawn outcome and hello say why: `mcp: {configured:
 * false, reason}`.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ERIDANI_KEY_RE, loadEridaniConfig, readEridaniFile, readEridaniToken } from './config';
import type { ExecutionTarget } from './eridani-targets';

/** The default key file, in the config dir. */
export const ERIDANI_MCP_KEY_FILE = 'eridani-mcp-token';
/** Where per-run Claude MCP configs are written, in the config dir. */
export const ERIDANI_MCP_DIR = 'eridani-mcp';
/** The server's name in the agent's MCP list. */
export const MCP_SERVER_NAME = 'eridani';
/** Codex reads the bearer token from this variable (outside the ERIDANI_* names Eridani may set). */
export const MCP_TOKEN_ENV = 'REMOTEA_ERIDANI_MCP_TOKEN';
/** The Eridani tools a configured session can call (named in the SessionStart context). */
export const ERIDANI_MCP_TOOLS = ['submit_plan', 'submit_plan_review', 'task_step', 'task_interview', 'session_link'] as const;
const MCP_PATH = '/api/v1/external/mcp/';

/** Readiness as reported upstream (spawn outcome, hello target). */
export interface McpStatus {
  configured: boolean;
  /** Why not configured (never contains the key). */
  reason?: string;
}

export type McpResolution = { configured: true; url: string; key: string } | { configured: false; reason: string };

/** Loopback hosts, where cleartext http is allowed (a local Eridani). */
function loopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

/** The MCP endpoint for a link URL (wss://host/… → https://host/api/v1/external/mcp/), or null. */
export function mcpUrlFromLink(linkUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(linkUrl);
  } catch {
    return null;
  }
  if (u.protocol === 'wss:') return `https://${u.host}${MCP_PATH}`;
  if (u.protocol === 'ws:' && loopback(u.hostname)) return `http://${u.host}${MCP_PATH}`;
  return null;
}

/** Why an `mcpUrl` is refused, or null. The key goes in a header: https, or http to this machine only. */
export function mcpUrlError(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'mcpUrl is not a URL';
  }
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:' && loopback(u.hostname)) return null;
  return 'mcpUrl must start with https:// (http:// only for localhost)';
}

/** A key file setting as a path: absolute, `~/…`, or relative to the config dir. */
export function keyFilePath(dir: string, setting: string | undefined): string {
  if (!setting) return path.join(dir, ERIDANI_MCP_KEY_FILE);
  if (setting === '~' || setting.startsWith('~/')) return path.join(os.homedir(), setting.slice(1));
  return path.resolve(dir, setting);
}

/** A key file setting is a one-line path. */
export function keyFileSettingOk(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 1024 && !/[\0\r\n]/.test(v);
}

/**
 * Where a target's agent finds Eridani's MCP server, and with which key.
 * Reads eridani.json and the key file on every call (a new key needs no
 * restart). The result's `key` must only ever reach the agent's MCP config.
 */
export function resolveMcp(dir: string, target: Pick<ExecutionTarget, 'mcpKeyFile'> | null): McpResolution {
  const file = readEridaniFile(dir);
  let url: string | null;
  if (file.mcpUrl !== undefined) {
    if (typeof file.mcpUrl !== 'string') return { configured: false, reason: 'mcpUrl in eridani.json is not a string' };
    const err = mcpUrlError(file.mcpUrl);
    if (err) return { configured: false, reason: err };
    const u = new URL(file.mcpUrl);
    url = u.pathname.endsWith('/') ? u.toString() : `${u.toString()}/`;
  } else {
    const cfg = loadEridaniConfig(dir);
    if (!cfg) return { configured: false, reason: 'no Eridani link configured (eridani.json has no url)' };
    url = mcpUrlFromLink(cfg.url);
    if (!url) return { configured: false, reason: 'cannot derive the MCP URL from the link URL (set mcpUrl in eridani.json)' };
  }
  const globalSetting = file.mcpKeyFile;
  if (globalSetting !== undefined && !keyFileSettingOk(globalSetting)) return { configured: false, reason: 'mcpKeyFile in eridani.json is not a path' };
  const keyFile = keyFilePath(dir, target?.mcpKeyFile ?? (globalSetting as string | undefined));
  let raw: string;
  try {
    raw = fs.readFileSync(keyFile, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { configured: false, reason: code === 'ENOENT' ? `no MCP key file at ${keyFile}` : `cannot read the MCP key file ${keyFile} (${code ?? 'error'})` };
  }
  const key = raw.trim();
  if (!ERIDANI_KEY_RE.test(key)) return { configured: false, reason: `the MCP key file ${keyFile} does not hold an Eridani bot key (eri_bot_…)` };
  if (key === readEridaniToken(dir)) return { configured: false, reason: `the MCP key file ${keyFile} holds the link key; mint a separate bot key for MCP` };
  return { configured: true, url, key };
}

/** The status to report for a resolution (drops the key). */
export function mcpStatus(r: McpResolution): McpStatus {
  return r.configured ? { configured: true } : { configured: false, reason: r.reason };
}

/** The Claude Code `--mcp-config` file's contents. */
export function claudeMcpConfig(url: string, key: string): string {
  return JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2) + '\n';
}

/** Codex `-c` overrides (the key is read from MCP_TOKEN_ENV, never put on the command line). */
export function codexMcpArgs(url: string): string[] {
  return ['-c', `mcp_servers.${MCP_SERVER_NAME}.url=${JSON.stringify(url)}`, '-c', `mcp_servers.${MCP_SERVER_NAME}.bearer_token_env_var=${JSON.stringify(MCP_TOKEN_ENV)}`];
}

/** Write a file only its owner can read, atomically. */
export function writePrivate(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}
