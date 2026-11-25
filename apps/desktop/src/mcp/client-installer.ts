/**
 * PixelForge AI desktop — 1-Click MCP Client Auto-Setup.
 *
 * Detects installed MCP-capable IDEs at their documented config paths and
 * safely upserts/removes ONLY the `pixelforge-ai` server entry.
 *
 * Security invariants:
 *   • Allowlisted client IDs only — the renderer never passes raw file paths.
 *   • Endpoint must be local loopback (`http://127.0.0.1:<port>/mcp` or localhost).
 *   • Existing config files are backed up (`<file>.pixelforge.bak`) before the
 *     first modification and written atomically (`.tmp` + rename).
 *   • Unrelated MCP servers and settings are preserved verbatim.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type McpClientId = 'cursor' | 'windsurf' | 'claude-code' | 'codex' | 'antigravity';

export interface DetectedMcpClient {
  id: McpClientId;
  name: string;
  configPath: string;
  detected: boolean;
  configured: boolean;
  format: 'json' | 'toml';
}

export interface InstallMcpClientResult {
  ok: boolean;
  clientId: McpClientId;
  configPath?: string;
  backupPath?: string | null;
  error?: string;
}

export interface UninstallMcpClientResult {
  ok: boolean;
  clientId: McpClientId;
  removed?: boolean;
  error?: string;
}

export interface ClientInstallerEnv {
  homeDir?: string;
  platform?: NodeJS.Platform;
}

interface ClientSpec {
  id: McpClientId;
  name: string;
  format: 'json' | 'toml';
  /** Relative segments from homeDir to the config file. */
  configRel: string[];
  /** Relative segments from homeDir to the client's root folder (for detection). */
  detectDirRel: string[];
  /** Shape of the JSON entry written under `mcpServers["pixelforge-ai"]`. */
  jsonStyle?: 'cursor' | 'windsurf' | 'claude-code';
}

const SERVER_KEY = 'pixelforge-ai';

const CLIENT_SPECS: readonly ClientSpec[] = [
  {
    id: 'cursor',
    name: 'Cursor',
    format: 'json',
    configRel: ['.cursor', 'mcp.json'],
    detectDirRel: ['.cursor'],
    jsonStyle: 'cursor',
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    format: 'json',
    configRel: ['.claude.json'],
    detectDirRel: ['.claude'],
    jsonStyle: 'claude-code',
  },
  {
    id: 'codex',
    name: 'Codex',
    format: 'toml',
    configRel: ['.codex', 'config.toml'],
    detectDirRel: ['.codex'],
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    format: 'json',
    configRel: ['.codeium', 'windsurf', 'mcp_config.json'],
    detectDirRel: ['.codeium', 'windsurf'],
    jsonStyle: 'windsurf',
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    format: 'json',
    configRel: ['.gemini', 'antigravity', 'mcp_config.json'],
    detectDirRel: ['.gemini', 'antigravity'],
    jsonStyle: 'windsurf',
  },
];

function getSpec(clientId: string): ClientSpec | null {
  return CLIENT_SPECS.find((s) => s.id === clientId) ?? null;
}

function resolvePaths(spec: ClientSpec, env?: ClientInstallerEnv) {
  const home = env?.homeDir ?? os.homedir();
  return {
    configPath: path.join(home, ...spec.configRel),
    detectDir: path.join(home, ...spec.detectDirRel),
  };
}

function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return (
      u.protocol === 'http:' &&
      (u.hostname === '127.0.0.1' || u.hostname === 'localhost') &&
      u.pathname === '/mcp'
    );
  } catch {
    return false;
  }
}

function isValidToken(token: string): boolean {
  return typeof token === 'string' && /^pfm_[A-Za-z0-9_-]{16,128}$/.test(token.trim());
}

// ---------------------------------------------------------------------------
// TOML helpers for Codex `~/.codex/config.toml`
// ---------------------------------------------------------------------------

const TOML_SECTION_HEADER = `[mcp_servers.${SERVER_KEY}]`;
const TOML_SECTION_RE =
  /(?:^|\r?\n)\[mcp_servers\.(?:"pixelforge-ai"|'pixelforge-ai'|pixelforge-ai)\][^\r\n]*(?:\r?\n(?!\[)[^\r\n]*)*/;

function hasTomlServer(raw: string): boolean {
  return TOML_SECTION_RE.test(raw);
}

function tomlEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildTomlBlock(endpoint: string, token: string): string {
  return [
    TOML_SECTION_HEADER,
    `url = "${tomlEscape(endpoint)}"`,
    `http_headers = { Authorization = "Bearer ${tomlEscape(token)}" }`,
  ].join('\n');
}

function upsertTomlServer(raw: string, endpoint: string, token: string): string {
  const block = buildTomlBlock(endpoint, token);
  if (TOML_SECTION_RE.test(raw)) {
    return raw.replace(TOML_SECTION_RE, (match) => {
      const prefix = match.startsWith('\r\n') ? '\r\n' : match.startsWith('\n') ? '\n' : '';
      return `${prefix}${block}`;
    });
  }
  const trimmed = raw.trimEnd();
  return trimmed.length > 0 ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

function removeTomlServer(raw: string): { next: string; removed: boolean } {
  if (!TOML_SECTION_RE.test(raw)) return { next: raw, removed: false };
  const next = raw.replace(TOML_SECTION_RE, '').replace(/\n{3,}/g, '\n\n').trimStart();
  return { next: next.length > 0 && !next.endsWith('\n') ? `${next}\n` : next, removed: true };
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

function buildJsonEntry(style: NonNullable<ClientSpec['jsonStyle']>, endpoint: string, token: string) {
  const headers = { Authorization: `Bearer ${token}` };
  if (style === 'windsurf') {
    return { serverUrl: endpoint, headers };
  }
  if (style === 'claude-code') {
    return { type: 'http', url: endpoint, headers };
  }
  return { url: endpoint, headers };
}

function hasJsonServer(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    return Boolean(parsed && typeof parsed === 'object' && parsed.mcpServers && SERVER_KEY in parsed.mcpServers);
  } catch {
    return false;
  }
}

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.pf-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

function backupIfExists(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const bak = `${filePath}.pixelforge.bak`;
  fs.copyFileSync(filePath, bak);
  return bak;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function detectMcpClients(env?: ClientInstallerEnv): DetectedMcpClient[] {
  return CLIENT_SPECS.map((spec) => {
    const { configPath, detectDir } = resolvePaths(spec, env);
    const configExists = fs.existsSync(configPath);
    const detected = configExists || fs.existsSync(detectDir);
    let configured = false;
    if (configExists) {
      try {
        const raw = fs.readFileSync(configPath, 'utf8');
        configured = spec.format === 'toml' ? hasTomlServer(raw) : hasJsonServer(raw);
      } catch {
        configured = false;
      }
    }
    return {
      id: spec.id,
      name: spec.name,
      configPath,
      detected,
      configured,
      format: spec.format,
    };
  });
}

export function installMcpClient(
  input: { clientId: string; endpoint: string; token: string },
  env?: ClientInstallerEnv,
): InstallMcpClientResult {
  const spec = getSpec(input.clientId);
  if (!spec) {
    return { ok: false, clientId: input.clientId as McpClientId, error: 'Unsupported IDE client.' };
  }
  if (!isLoopbackEndpoint(input.endpoint)) {
    return { ok: false, clientId: spec.id, error: 'MCP endpoint must be a local loopback URL.' };
  }
  if (!isValidToken(input.token)) {
    return { ok: false, clientId: spec.id, error: 'Invalid client token.' };
  }

  const { configPath } = resolvePaths(spec, env);
  try {
    const existed = fs.existsSync(configPath);
    const raw = existed ? fs.readFileSync(configPath, 'utf8') : '';
    const backupPath = backupIfExists(configPath);

    if (spec.format === 'toml') {
      const next = upsertTomlServer(raw, input.endpoint, input.token.trim());
      atomicWrite(configPath, next);
      return { ok: true, clientId: spec.id, configPath, backupPath };
    }

    let doc: Record<string, unknown> = {};
    if (raw.trim().length > 0) {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
          ok: false,
          clientId: spec.id,
          error: `Existing ${path.basename(configPath)} is not a JSON object — edit it manually.`,
        };
      }
      doc = { ...(parsed as Record<string, unknown>) };
    }
    const existingServers =
      doc.mcpServers && typeof doc.mcpServers === 'object' && !Array.isArray(doc.mcpServers)
        ? { ...(doc.mcpServers as Record<string, unknown>) }
        : {};
    existingServers[SERVER_KEY] = buildJsonEntry(spec.jsonStyle ?? 'cursor', input.endpoint, input.token.trim());
    doc.mcpServers = existingServers;
    atomicWrite(configPath, `${JSON.stringify(doc, null, 2)}\n`);
    return { ok: true, clientId: spec.id, configPath, backupPath };
  } catch (err) {
    return {
      ok: false,
      clientId: spec.id,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function uninstallMcpClient(
  input: { clientId: string },
  env?: ClientInstallerEnv,
): UninstallMcpClientResult {
  const spec = getSpec(input.clientId);
  if (!spec) {
    return { ok: false, clientId: input.clientId as McpClientId, error: 'Unsupported IDE client.' };
  }
  const { configPath } = resolvePaths(spec, env);
  if (!fs.existsSync(configPath)) {
    return { ok: true, clientId: spec.id, removed: false };
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    if (spec.format === 'toml') {
      const { next, removed } = removeTomlServer(raw);
      if (removed) {
        backupIfExists(configPath);
        atomicWrite(configPath, next);
      }
      return { ok: true, clientId: spec.id, removed };
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const servers = parsed?.mcpServers as Record<string, unknown> | undefined;
    if (!servers || typeof servers !== 'object' || !(SERVER_KEY in servers)) {
      return { ok: true, clientId: spec.id, removed: false };
    }
    backupIfExists(configPath);
    const nextServers = { ...servers };
    delete nextServers[SERVER_KEY];
    const nextDoc = { ...parsed, mcpServers: nextServers };
    atomicWrite(configPath, `${JSON.stringify(nextDoc, null, 2)}\n`);
    return { ok: true, clientId: spec.id, removed: true };
  } catch (err) {
    return {
      ok: false,
      clientId: spec.id,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
