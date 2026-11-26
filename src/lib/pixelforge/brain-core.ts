// PixelForge AI — Brain Core facade (shared-Brain evolution, Phase 1).
//
// One stable contract for the deterministic Brain surface shared by the
// Brain Panel, the editor executor and MCP relays: the interpreter, learning
// memory and their re-exports. Subscription-only product — there is NO
// provider/API-key path here (agent reasoning happens in the artist's own
// IDE, connected through MCP).

import type { SecondBrainMemory } from '@/lib/pixelforge/second-brain-intelligence'

// --- shared deterministic Brain service (interpreter + learning memory) ----

export {
  interpretAndEnhancePrompt,
  resolveMotionPresetSynonym,
  detectStarterTemplateHint,
  buildIdeAgentHandoffPrompt,
  fuzzyFindByName,
  readBrainMemory,
  writeBrainMemory,
  recordBrainFeedback,
  recordAgentContextEvent,
  addBrainPreference,
  removeBrainPreference,
  subscribeBrainMemory,
  clearBrainSessionContext,
  resetBrainMemory,
  exportBrainMemory,
} from '@/lib/pixelforge/second-brain-intelligence'

export type {
  InterpretedPrompt,
  PromptCorrection,
  DetectedIntent,
  BrainProjectContext,
  BrainFeedbackEntry,
  AgentContextEvent,
  SecondBrainMemory,
  StarterTemplateHint,
} from '@/lib/pixelforge/second-brain-intelligence'
