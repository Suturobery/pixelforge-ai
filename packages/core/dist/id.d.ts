/**
 * Identifier generation — ported from the web prototype's factory.ts
 * (src/lib/pixelforge/factory.ts) verbatim, minus nothing: it was already
 * DOM-free (Date.now + Math.random only), so it runs in Node/Electron main,
 * workers and tests alike.
 */
export declare function uid(prefix?: string): string;
