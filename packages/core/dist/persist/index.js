"use strict";
/**
 * Persistence barrel — the complete Task 3 file-format API surface.
 * Re-exported by the package root (src/index.ts).
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryFs = void 0;
__exportStar(require("./errors"), exports);
__exportStar(require("./crc32"), exports);
__exportStar(require("./base64"), exports);
__exportStar(require("./digest"), exports);
__exportStar(require("./png"), exports);
__exportStar(require("./zip"), exports);
__exportStar(require("./paths"), exports);
__exportStar(require("./schema"), exports);
__exportStar(require("./serialize"), exports);
__exportStar(require("./container"), exports);
__exportStar(require("./journal"), exports);
var memory_fs_1 = require("./memory-fs");
Object.defineProperty(exports, "MemoryFs", { enumerable: true, get: function () { return memory_fs_1.MemoryFs; } });
__exportStar(require("./store"), exports);
