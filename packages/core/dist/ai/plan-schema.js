"use strict";
// PixelForge AI — planner output schema (P0-2). Shared by the brain route
// (server-side validation), the task-board tooling, and tests. The planner
// may ONLY emit this shape; unknown kinds/fields and malformed values are
// rejected whole — nothing unvalidated reaches a task board or executor.
Object.defineProperty(exports, "__esModule", { value: true });
exports.brainPlanSchema = exports.brainPlanStepSchema = exports.brainHexColor = void 0;
const zod_1 = require("zod");
exports.brainHexColor = zod_1.z.string().regex(/^#[0-9a-fA-F]{3,8}$/);
exports.brainPlanStepSchema = zod_1.z
    .object({
    kind: zod_1.z.enum(['app-vfx', 'app-palette', 'agent']),
    title: zod_1.z.string().trim().min(1).max(160),
    // app-vfx
    effect: zod_1.z.string().trim().min(1).max(80).optional(),
    seed: zod_1.z.number().int().min(0).max(999_999).optional(),
    light: zod_1.z.number().min(0).max(1).optional(),
    // app-palette
    colors: zod_1.z.array(exports.brainHexColor).min(2).max(64).optional(),
    // agent
    detail: zod_1.z.string().trim().min(1).max(1000).optional(),
    // both app kinds may request the project palette ramp
    palette: zod_1.z.literal('project').optional(),
})
    .strict();
exports.brainPlanSchema = zod_1.z.object({ steps: zod_1.z.array(exports.brainPlanStepSchema).min(1).max(8) }).strict();
