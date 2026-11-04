// PixelForge AI desktop — platform launcher for the bundled MCP mini-service
// (embed v1). Spawns the project's OWN local service and adapts it to the
// SpawnedService contract the supervisor state machine expects.
//
// dev:      `bun src/index.ts` inside mini-services/mcp-server (bun is the
//           documented runtime of that package)
// packaged: the compiled server executable shipped under resources/mcp/
//           (electron-builder extraResources — Task: packaging milestone)

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import type { SpawnedService } from './supervisor-core';

export function resolveServiceDir(appPath: string, resourcesPath: string, packaged: boolean): string {
  if (packaged) return path.join(resourcesPath, 'mcp');
  // <workspace>/apps/desktop → <workspace>/mini-services/mcp-server
  return path.resolve(appPath, '..', '..', 'mini-services', 'mcp-server');
}

export function createServiceLauncher(
  serviceDir: string,
  packaged: boolean,
  dataDir: string,
  port: number,
  onError: (err: unknown) => void,
): () => SpawnedService | null {
  return (): SpawnedService | null => {
    try {
      let cmd: string;
      let args: string[];
      if (packaged) {
        cmd = path.join(serviceDir, process.platform === 'win32' ? 'mcp-server.exe' : 'mcp-server');
        args = [];
        if (!existsSync(cmd)) return null; // packaging milestone ships this
      } else {
        cmd = 'bun';
        args = ['src/index.ts'];
      }
      // The compiled exe has no source-relative db dir — point it at a
      // writable per-user data dir. Dev keeps the workspace db/ default
      // unless PF_MCP_DATA_DIR is already set.
      const env = {
        ...process.env,
        PF_MCP_PORT: String(port),
        ...(packaged && !process.env.PF_MCP_DATA_DIR ? { PF_MCP_DATA_DIR: dataDir } : {}),
        // compiled exe cannot resolve source-relative knowledge/ — ship it
        // next to the exe (electron-builder extraResources) and point at it
        ...(packaged ? { PF_KNOWLEDGE_DIR: path.join(serviceDir, 'knowledge') } : {}),
      };
      const child = spawn(cmd, args, { cwd: serviceDir, stdio: 'ignore', windowsHide: true, env });
      return {
        pid: child.pid,
        stop(signal?: string) {
          child.kill((signal as NodeJS.Signals | undefined) ?? 'SIGTERM');
        },
        onExit(listener) {
          child.on('exit', (code) => listener(code));
        },
      };
    } catch (err) {
      onError(err);
      return null;
    }
  };
}
