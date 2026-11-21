import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  readonly dir: string;
  readonly file: string;
  info(tag: string, data?: unknown): void;
  warn(tag: string, data?: unknown): void;
  error(tag: string, data?: unknown): void;
}

const KEEP_DAYS = 7;
const MAX_LOG_FILE_BYTES = 2 * 1024 * 1024;
const RETAIN_LOG_FILE_BYTES = 1024 * 1024;

/**
 * Minimal crash-safe, rotating, local-only file logger (v3.1 §8.4).
 * Files live under the OS userData dir; nothing is ever sent anywhere.
 */
export function createLogger(): Logger {
  const dir = path.join(app.getPath('userData'), 'logs');
  try {
    fs.mkdirSync(dir, { recursive: true });
    rotate(dir);
  } catch {
    // Logging setup must never block startup; fall back to console-only.
    return consoleLogger('<unavailable>');
  }

  const file = path.join(dir, `main-${new Date().toISOString().slice(0, 10)}.log`);
  const write = (level: LogLevel, tag: string, data?: unknown): void => {
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${tag}${data === undefined ? '' : ` ${safeJson(data)}`}\n`;
    try {
      fs.appendFileSync(file, line);
      trimCurrentLog(file);
    } catch {
      // Never throw from the logger.
    }
    if (level === 'error') console.error(line.trim());
    else if (process.env.PF_VERBOSE === '1') console.log(line.trim());
  };

  return {
    dir,
    file,
    info: (tag, data) => write('info', tag, data),
    warn: (tag, data) => write('warn', tag, data),
    error: (tag, data) => write('error', tag, data),
  };
}

/** Bound a noisy single-day log while retaining its latest useful tail. */
function trimCurrentLog(file: string): void {
  try {
    const size = fs.statSync(file).size;
    if (size <= MAX_LOG_FILE_BYTES) return;
    const start = Math.max(0, size - RETAIN_LOG_FILE_BYTES);
    const tail = fs.readFileSync(file).subarray(start);
    const firstNewline = tail.indexOf(0x0a);
    fs.writeFileSync(file, firstNewline >= 0 ? tail.subarray(firstNewline + 1) : tail);
  } catch {
    // Logging remains best-effort.
  }
}

/** Console-only fallback used when the log dir cannot be created. */
function consoleLogger(fileLabel: string): Logger {
  const emit =
    (level: LogLevel) =>
    (tag: string, data?: unknown): void => {
      const line = `[${level.toUpperCase()}] ${tag}${data === undefined ? '' : ` ${safeJson(data)}`}`;
      if (level === 'error') console.error(line);
      else console.log(line);
    };
  return {
    dir: fileLabel,
    file: fileLabel,
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
  };
}

/** Drop log files older than KEEP_DAYS. */
function rotate(dir: string): void {
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.log')) continue;
    const full = path.join(dir, entry);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    } catch {
      // Best effort.
    }
  }
}

function safeJson(data: unknown): string {
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}
