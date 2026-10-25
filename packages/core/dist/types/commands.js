"use strict";
/**
 * Command envelope & bus contracts (v3.1 §2.5).
 *
 * Every document mutation — UI, AI, or MCP — goes through the CommandBus
 * (v1 §03 separation-of-concerns, enforced in code). There is no separate
 * AI/MCP mutation path.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.unsubscribe = unsubscribe;
function unsubscribe() { }
