import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  detectMcpClients,
  installMcpClient,
  uninstallMcpClient,
} from '../src/mcp/client-installer';

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pf-mcp-installer-'));
}

const VALID_ENDPOINT = 'http://127.0.0.1:3030/mcp';
const VALID_TOKEN = 'pfm_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

describe('1-click MCP client installer', () => {
  test('detects installed IDE folders and existing pixelforge-ai config', () => {
    const home = makeTempHome();
    try {
      fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
      fs.mkdirSync(path.join(home, '.codex'), { recursive: true });

      const initial = detectMcpClients({ homeDir: home });
      const cursor = initial.find((c) => c.id === 'cursor')!;
      const codex = initial.find((c) => c.id === 'codex')!;
      const windsurf = initial.find((c) => c.id === 'windsurf')!;

      expect(cursor.detected).toBe(true);
      expect(cursor.configured).toBe(false);
      expect(codex.detected).toBe(true);
      expect(windsurf.detected).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('merges JSON config safely with backup and preserves existing servers', () => {
    const home = makeTempHome();
    try {
      const cursorDir = path.join(home, '.cursor');
      const cursorCfg = path.join(cursorDir, 'mcp.json');
      fs.mkdirSync(cursorDir, { recursive: true });
      fs.writeFileSync(
        cursorCfg,
        JSON.stringify({ mcpServers: { github: { url: 'https://api.github.com/mcp' } }, extra: true }, null, 2),
      );

      const res = installMcpClient(
        { clientId: 'cursor', endpoint: VALID_ENDPOINT, token: VALID_TOKEN },
        { homeDir: home },
      );
      expect(res.ok).toBe(true);
      expect(res.backupPath).toBe(`${cursorCfg}.pixelforge.bak`);
      expect(fs.existsSync(res.backupPath!)).toBe(true);

      const written = JSON.parse(fs.readFileSync(cursorCfg, 'utf8'));
      expect(written.extra).toBe(true);
      expect(written.mcpServers.github.url).toBe('https://api.github.com/mcp');
      expect(written.mcpServers['pixelforge-ai']).toEqual({
        url: VALID_ENDPOINT,
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
      });

      const after = detectMcpClients({ homeDir: home }).find((c) => c.id === 'cursor')!;
      expect(after.configured).toBe(true);

      const removed = uninstallMcpClient({ clientId: 'cursor' }, { homeDir: home });
      expect(removed.ok).toBe(true);
      expect(removed.removed).toBe(true);
      const afterRemove = JSON.parse(fs.readFileSync(cursorCfg, 'utf8'));
      expect(afterRemove.mcpServers.github.url).toBe('https://api.github.com/mcp');
      expect(afterRemove.mcpServers['pixelforge-ai']).toBeUndefined();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('upserts and removes TOML block cleanly for Codex while preserving other sections', () => {
    const home = makeTempHome();
    try {
      const codexDir = path.join(home, '.codex');
      const codexCfg = path.join(codexDir, 'config.toml');
      fs.mkdirSync(codexDir, { recursive: true });
      fs.writeFileSync(codexCfg, 'model = "gpt-5"\n\n[mcp_servers.other]\nurl = "http://127.0.0.1:9999/mcp"\n');

      const first = installMcpClient(
        { clientId: 'codex', endpoint: VALID_ENDPOINT, token: VALID_TOKEN },
        { homeDir: home },
      );
      expect(first.ok).toBe(true);

      const text1 = fs.readFileSync(codexCfg, 'utf8');
      expect(text1).toContain('model = "gpt-5"');
      expect(text1).toContain('[mcp_servers.other]');
      expect(text1).toContain('[mcp_servers.pixelforge-ai]');
      expect(text1).toContain(`Authorization = "Bearer ${VALID_TOKEN}"`);

      // Re-installing updates in place without duplicating the section
      const token2 = 'pfm_999999999999999999999999999999999999';
      const second = installMcpClient(
        { clientId: 'codex', endpoint: VALID_ENDPOINT, token: token2 },
        { homeDir: home },
      );
      expect(second.ok).toBe(true);
      const text2 = fs.readFileSync(codexCfg, 'utf8');
      expect(text2.match(/\[mcp_servers\.pixelforge-ai\]/g)?.length).toBe(1);
      expect(text2).toContain(`Authorization = "Bearer ${token2}"`);
      expect(text2).toContain('[mcp_servers.other]');

      const removed = uninstallMcpClient({ clientId: 'codex' }, { homeDir: home });
      expect(removed.ok).toBe(true);
      expect(removed.removed).toBe(true);
      const text3 = fs.readFileSync(codexCfg, 'utf8');
      expect(text3).not.toContain('[mcp_servers.pixelforge-ai]');
      expect(text3).toContain('[mcp_servers.other]');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('replaces existing pixelforge-ai sub-tables instead of creating duplicate keys (Codex)', () => {
    const home = makeTempHome();
    try {
      const codexDir = path.join(home, '.codex');
      const codexCfg = path.join(codexDir, 'config.toml');
      fs.mkdirSync(codexDir, { recursive: true });
      fs.writeFileSync(
        codexCfg,
        [
          'model = "gpt-5"',
          '',
          '[mcp_servers.pixelforge-ai]',
          'url = "http://127.0.0.1:3030/mcp"',
          '',
          '[mcp_servers.pixelforge-ai.http_headers]',
          'Authorization = "Bearer pfm_OLDOLDOLDOLDOLDOLDOLD"',
          '',
          '[mcp_servers.pixelforge-ai-project-control]',
          'url = "http://127.0.0.1:57980/mcp"',
          '',
          '[desktop]',
          'x = 1',
          '',
        ].join('\r\n'),
      );

      expect(detectMcpClients({ homeDir: home }).find((c) => c.id === 'codex')!.configured).toBe(true);

      const res = installMcpClient(
        { clientId: 'codex', endpoint: VALID_ENDPOINT, token: VALID_TOKEN },
        { homeDir: home },
      );
      expect(res.ok).toBe(true);
      const text = fs.readFileSync(codexCfg, 'utf8');
      expect(text).not.toContain('[mcp_servers.pixelforge-ai.http_headers]');
      expect(text).not.toContain('pfm_OLDOLD');
      expect(text.match(/http_headers/g)?.length).toBe(1);
      expect(text.match(/^\[mcp_servers\.pixelforge-ai\]/gm)?.length).toBe(1);
      expect(text).toContain(`Authorization = "Bearer ${VALID_TOKEN}"`);
      expect(text).toContain('[mcp_servers.pixelforge-ai-project-control]');
      expect(text).toContain('[desktop]\r\nx = 1');
      expect(text).not.toMatch(/(?<!\r)\n/); // CRLF preserved

      const removed = uninstallMcpClient({ clientId: 'codex' }, { homeDir: home });
      expect(removed.removed).toBe(true);
      const after = fs.readFileSync(codexCfg, 'utf8');
      expect(after).not.toMatch(/^\[mcp_servers\.pixelforge-ai[\].]/m);
      expect(after).toContain('[mcp_servers.pixelforge-ai-project-control]');
      expect(after).toContain('[desktop]\r\nx = 1');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('ignores look-alikes, quoted stray sub-tables, and multi-line array elements in Codex TOML', () => {
    const home = makeTempHome();
    try {
      const codexDir = path.join(home, '.codex');
      const codexCfg = path.join(codexDir, 'config.toml');
      fs.mkdirSync(codexDir, { recursive: true });
      fs.writeFileSync(
        codexCfg,
        [
          'matrix = [',
          '  ["a"],',
          '  ["b"]',
          ']',
          '',
          '[mcp_servers.pixel-forge-ai] # look-alike',
          'url = "http://127.0.0.1:4444/mcp"',
          '',
          '[mcp_servers."pixelforge-ai"] # primary',
          'url = "http://127.0.0.1:3030/mcp"',
          '',
          '[desktop]',
          'keep = true',
          '',
          "[mcp_servers.'pixelforge-ai'.env]",
          'FOO = "bar"',
          '',
        ].join('\n'),
      );

      const res = installMcpClient(
        { clientId: 'codex', endpoint: VALID_ENDPOINT, token: VALID_TOKEN },
        { homeDir: home },
      );
      expect(res.ok).toBe(true);
      const text = fs.readFileSync(codexCfg, 'utf8');
      expect(text).toContain('  ["a"],\n  ["b"]\n]');
      expect(text).toContain('[mcp_servers.pixel-forge-ai] # look-alike');
      expect(text).toContain('[desktop]\nkeep = true');
      expect(text).not.toContain("[mcp_servers.'pixelforge-ai'.env]");
      expect(text).not.toContain('FOO = "bar"');
      expect(text.match(/^\[mcp_servers\.pixelforge-ai\]/gm)?.length).toBe(1);
      expect(text).toContain(`Authorization = "Bearer ${VALID_TOKEN}"`);
      expect(text).not.toMatch(/\n{3,}/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('rejects unknown client IDs, non-loopback URLs, and invalid tokens', () => {
    const home = makeTempHome();
    try {
      expect(
        installMcpClient({ clientId: '../etc/passwd', endpoint: VALID_ENDPOINT, token: VALID_TOKEN }, { homeDir: home }).ok,
      ).toBe(false);
      expect(
        installMcpClient({ clientId: 'cursor', endpoint: 'https://evil.example/mcp', token: VALID_TOKEN }, { homeDir: home }).ok,
      ).toBe(false);
      expect(
        installMcpClient({ clientId: 'cursor', endpoint: VALID_ENDPOINT, token: 'not-a-pfm-token' }, { homeDir: home }).ok,
      ).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
