"use strict";
/**
 * History model (v3.1 §2.5): typed command history with
 *  - pixel edits  → 16×16 tile diffs (dirty tiles with before/after bytes)
 *  - structural edits → shallow document snapshots (copy-on-write buffers)
 *  - transactions → composite entries (children undone/redone in order)
 * Memory is capped by a configurable budget (default 64 MB, 16–512 range);
 * oldest entries are evicted when over budget.
 */
Object.defineProperty(exports, "__esModule", { value: true });
