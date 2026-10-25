/**
 * In-memory FileFs — used by unit tests and available to embedders that keep
 * projects in virtual storage. Mirrors the semantics the store relies on
 * (rename over existing target, stat mtime, recursive mkdir).
 */
import type { FileFs } from './store';
export declare class MemoryFs implements FileFs {
    private files;
    private dirs;
    private clock;
    private now;
    private norm;
    writeFile(path: string, data: Uint8Array): Promise<void>;
    readFile(path: string): Promise<Uint8Array>;
    rename(from: string, to: string): Promise<void>;
    unlink(path: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    mkdir(path: string): Promise<void>;
    listDir(path: string): Promise<string[]>;
    stat(path: string): Promise<{
        mtimeMs: number;
        size: number;
    } | null>;
    /** Test helper: raw byte access for tamper simulations. */
    peek(path: string): Uint8Array | undefined;
    private parentOf;
    private mkdirpSync;
}
