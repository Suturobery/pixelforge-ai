"use strict";
/**
 * In-memory FileFs — used by unit tests and available to embedders that keep
 * projects in virtual storage. Mirrors the semantics the store relies on
 * (rename over existing target, stat mtime, recursive mkdir).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryFs = void 0;
class MemoryFs {
    files = new Map();
    dirs = new Set();
    clock = 1_000_000;
    now() {
        this.clock += 7;
        return this.clock;
    }
    norm(path) {
        return path.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
    }
    async writeFile(path, data) {
        const p = this.norm(path);
        this.mkdirpSync(this.parentOf(p));
        this.files.set(p, { data: data.slice(), mtimeMs: this.now() });
    }
    async readFile(path) {
        const f = this.files.get(this.norm(path));
        if (!f)
            throw new Error(`ENOENT: ${path}`);
        return f.data.slice();
    }
    async rename(from, to) {
        const f = this.files.get(this.norm(from));
        if (!f)
            throw new Error(`ENOENT: ${from}`);
        this.files.delete(this.norm(from));
        this.files.set(this.norm(to), { ...f, mtimeMs: this.now() });
    }
    async unlink(path) {
        const p = this.norm(path);
        if (!this.files.has(p))
            throw new Error(`ENOENT: ${path}`);
        this.files.delete(p);
    }
    async exists(path) {
        const p = this.norm(path);
        return this.files.has(p) || this.dirs.has(p);
    }
    async mkdir(path) {
        this.mkdirpSync(this.norm(path));
    }
    async listDir(path) {
        const p = this.norm(path);
        if (!this.dirs.has(p) && !this.files.has(p))
            throw new Error(`ENOENT: ${path}`);
        const prefix = p === '/' ? '/' : `${p}/`;
        const names = new Set();
        for (const key of this.files.keys()) {
            if (key.startsWith(prefix)) {
                const rest = key.slice(prefix.length);
                if (rest.length > 0 && !rest.includes('/'))
                    names.add(rest);
            }
        }
        for (const key of this.dirs) {
            if (key.startsWith(prefix)) {
                const rest = key.slice(prefix.length);
                if (rest.length > 0 && !rest.includes('/'))
                    names.add(rest);
            }
        }
        return [...names];
    }
    async stat(path) {
        const f = this.files.get(this.norm(path));
        if (!f)
            return null;
        return { mtimeMs: f.mtimeMs, size: f.data.length };
    }
    /** Test helper: raw byte access for tamper simulations. */
    peek(path) {
        return this.files.get(this.norm(path))?.data;
    }
    parentOf(path) {
        const i = path.lastIndexOf('/');
        return i <= 0 ? '/' : path.slice(0, i);
    }
    mkdirpSync(path) {
        const parts = path.split('/').filter(Boolean);
        let cur = '';
        this.dirs.add('/');
        for (const part of parts) {
            cur += `/${part}`;
            this.dirs.add(cur);
        }
    }
}
exports.MemoryFs = MemoryFs;
