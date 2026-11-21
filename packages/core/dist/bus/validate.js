"use strict";
/**
 * Hand-rolled payload validators (zero dependencies — zod stays in the MCP
 * package where the prototype already uses it, v3.1 §5.3).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.HEX_RE = void 0;
exports.assertObject = assertObject;
exports.getString = getString;
exports.getOptionalString = getOptionalString;
exports.getInt = getInt;
exports.getOptionalInt = getOptionalInt;
exports.getNumber = getNumber;
exports.getBool = getBool;
exports.getOptionalBool = getOptionalBool;
exports.getLoopMode = getLoopMode;
exports.getOptionalLoopMode = getOptionalLoopMode;
exports.getHexColor = getHexColor;
exports.getRgba = getRgba;
const errors_1 = require("./errors");
function assertObject(payload, what) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        (0, errors_1.fail)(`${what} must be an object`);
    }
    return payload;
}
function getString(o, key, what) {
    const v = o[key];
    if (typeof v !== 'string' || v.length === 0)
        (0, errors_1.fail)(`${what}: "${key}" must be a non-empty string`);
    return v;
}
function getOptionalString(o, key, what) {
    const v = o[key];
    if (v === undefined)
        return undefined;
    if (typeof v !== 'string')
        (0, errors_1.fail)(`${what}: "${key}" must be a string`);
    return v;
}
function getInt(o, key, what, min, max) {
    const v = o[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
        (0, errors_1.fail)(`${what}: "${key}" must be an integer`);
    }
    if (min !== undefined && v < min)
        (0, errors_1.fail)(`${what}: "${key}" must be ≥ ${min}`);
    if (max !== undefined && v > max)
        (0, errors_1.fail)(`${what}: "${key}" must be ≤ ${max}`);
    return v;
}
function getOptionalInt(o, key, what, min, max) {
    if (o[key] === undefined)
        return undefined;
    return getInt(o, key, what, min, max);
}
function getNumber(o, key, what) {
    const v = o[key];
    if (typeof v !== 'number' || !Number.isFinite(v))
        (0, errors_1.fail)(`${what}: "${key}" must be a number`);
    return v;
}
function getBool(o, key, what) {
    const v = o[key];
    if (typeof v !== 'boolean')
        (0, errors_1.fail)(`${what}: "${key}" must be a boolean`);
    return v;
}
function getOptionalBool(o, key, what) {
    if (o[key] === undefined)
        return undefined;
    return getBool(o, key, what);
}
const LOOP_MODES = ['forward', 'reverse', 'pingpong'];
function getLoopMode(o, key, what) {
    const v = o[key];
    if (typeof v !== 'string' || !LOOP_MODES.includes(v)) {
        (0, errors_1.fail)(`${what}: "${key}" must be one of ${LOOP_MODES.join(' | ')}`);
    }
    return v;
}
function getOptionalLoopMode(o, key, what) {
    if (o[key] === undefined)
        return undefined;
    return getLoopMode(o, key, what);
}
exports.HEX_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
function getHexColor(o, key, what) {
    const v = getString(o, key, what);
    if (!exports.HEX_RE.test(v))
        (0, errors_1.fail)(`${what}: "${key}" must be a hex color like #rrggbb`);
    return v.toLowerCase();
}
function getRgba(o, key, what) {
    const v = o[key];
    if (!Array.isArray(v) || v.length !== 4)
        (0, errors_1.fail)(`${what}: "${key}" must be [r,g,b,a]`);
    const out = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
        const n = v[i];
        if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 255) {
            (0, errors_1.fail)(`${what}: "${key}" channels must be numbers 0–255`);
        }
        out[i] = Math.round(n);
    }
    return out;
}
