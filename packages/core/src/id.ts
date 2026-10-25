/**
 * Identifier generation — ported from the web prototype's factory.ts
 * (src/lib/pixelforge/factory.ts) verbatim, minus nothing: it was already
 * DOM-free (Date.now + Math.random only), so it runs in Node/Electron main,
 * workers and tests alike.
 */

let counter = 0;

export function uid(prefix = 'id'): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}
