// PixelForge AI — planner output schema (P0-2). Shared by the brain route
// (server-side validation), the task-board tooling, and tests. The planner
// may ONLY emit this shape; unknown kinds/fields and malformed values are
// rejected whole — nothing unvalidated reaches a task board or executor.

import { z } from 'zod'

export const brainHexColor = z.string().regex(/^#[0-9a-fA-F]{3,8}$/)

export const brainPlanStepSchema = z
  .object({
    kind: z.enum(['app-vfx', 'app-palette', 'agent']),
    title: z.string().trim().min(1).max(160),
    // app-vfx
    effect: z.string().trim().min(1).max(80).optional(),
    seed: z.number().int().min(0).max(999_999).optional(),
    light: z.number().min(0).max(1).optional(),
    // app-palette
    colors: z.array(brainHexColor).min(2).max(64).optional(),
    // agent
    detail: z.string().trim().min(1).max(1000).optional(),
    // both app kinds may request the project palette ramp
    palette: z.literal('project').optional(),
  })
  .strict()

export const brainPlanSchema = z.object({ steps: z.array(brainPlanStepSchema).min(1).max(8) }).strict()

export type BrainPlanStep = z.infer<typeof brainPlanStepSchema>
