# PixelForge AI — Project Plan (extracted)

> PROVENANCE: The authored `PixelForge_AI_Project_Plan_v3.1.md` file was NOT FOUND in any snapshot or recovery artifact and is considered lost. This document is the authoritative original plan, extracted verbatim from `upload/PixelForge_AI_Desktop_App_Project_Plan.docx` (Version 1.0 · 24 October 2026). The P1 roadmap authorization message (Phase 0–7) serves as the v3.1-era task specification. Nothing below this note was modified from the extracted text.


PRODUCT / DEVELOPMENT PLAN
PixelForge AI
AI-powered pixel art and animation desktop studio

Product direction
A desktop pixel-art editor that supports frame-by-frame animation, AI-assisted sprite creation, and MCP tools for external AI assistants.
Strategy: deliver a dependable manual animation workflow first; layer AI generation and agent-driven controls over the same editable project model.

Document
Status
Platform
Version 1.0  •  24 October 2026
Planning / concept
Windows-first desktop; extensible
Primary audience: indie game developers
Delivery approach: phased MVP
Godot-friendly export initially

Core product promise
“Generate a character, animate it, correct the pixels, and export game-ready assets—inside one desktop workspace.”
Planning assumptions
Solo or small-team development; no fixed budget or delivery date defined.
AI models and provider costs are selectable; generation quality will vary by model and prompt.
MCP means connecting supported external AI assistants to editor tools; MCP itself is not an image model.


01  Product definition
Scope, target users, and the workflows that define success.
Problem statement
Indie developers often move between image generators, pixel editors, animation tools, and game engines. This fragments the workflow, makes generated frames difficult to keep visually consistent, and complicates export. PixelForge AI will provide an editable, agent-accessible workspace for creating and animating small 2D game assets.
Product goals
Enable users to draw, import, edit, and animate pixel art without leaving the desktop app.
Use AI to accelerate sprite ideation and frame preparation while preserving manual control.
Allow compatible AI assistants to inspect projects and execute validated editing operations through MCP.
Produce transparent, predictable, game-ready exports, starting with PNG sprite sheets and metadata.
Primary users and jobs to be done
User
Primary need
Example outcome
Solo game developer
Produce playable assets quickly
32×32 NPC with idle and walk loops
Pixel artist
Retain precise control over pixels
Edit generated poses with layers and tools
AI-assisted developer
Automate repetitive asset operations
Ask an MCP client to build and export a sprite sheet

Core user workflow
01 · Create  Start a project (canvas size, frame rate, transparent background, palette).
02 · Generate / draw  Import artwork, draw manually, or ask AI for a base sprite.
03 · Animate  Build, preview, and revise named animation sequences frame by frame.
04 · Validate  Inspect alignment, transparency, palette and looping behavior.
05 · Export  Save editable source and export frames, sprite sheets and animation metadata.
MVP boundaries
Included in MVP
Deferred / not promised in MVP
Canvas: 16×16 to 256×256; pixel tools; layers; undo/redo
Full image editor feature parity with mature tools
Frame timeline; onion skin; loop playback; FPS control
Skeleton rigging, interpolation, 3D-to-pixel workflows
Import PNG; save projects; transparent PNG & sheet export
Guaranteed one-prompt production-quality animation
Core MCP tools; local authenticated control bridge
Marketplace, accounts, collaboration, cloud sync

02  Functional requirements
Editor and workspace
Pixel-perfect canvas with zoom, pan, grid, checkerboard background, and optional symmetry.
Pencil, eraser, fill, eyedropper, rectangle/selection, move, and palette controls.
Per-frame layers with visibility, ordering, opacity, and basic merge operations.
Unlimited conceptual undo/redo history, subject to configured memory limits; autosave/recovery.
Animation engine
Separate named clips (idle, walk, attack, etc.), each with ordered frames and duration/FPS.
Timeline actions: add, duplicate, delete, reorder, and copy frames; play/pause and looping.
Onion skin preview; frame alignment guides; sprite dimensions remain consistent within a clip.
Animation preview available before export; exports should represent exact stored pixel data.
AI assistance: initial and subsequent
Release
AI capability
Behavior
Early AI
Text-to-base-sprite
Generate candidate art; import as editable raster layer
Early AI
Palette cleanup and resizing
Quantize colors, nearest-neighbor scaling, remove backdrop
Later AI
Pose / frame suggestions
Create candidate frames from a locked reference sprite
Later AI
Region editing
Change selected body part without rewriting the whole sprite
Later AI
Batch / directional animations
Propose idle, walk, attack with shared palette and proportions

AI-generated frames are proposals: the app must let the user accept, edit, or discard each result. Model output should never silently replace the source art.
03  Technical architecture
Recommended implementation stack
Layer
Choice
Purpose
Desktop shell
Electron
Native window, OS file dialogs, process management
Interface
React + TypeScript + Tailwind
Editor panels, inspector, timeline and AI chat
Rendering
HTML Canvas 2D (pixelated)
Deterministic pixel operations and frame playback
State
Zustand or equivalent
Active project, frame, tool and history state
MCP
Official TypeScript MCP SDK
Tool schemas, requests, responses and transport
AI providers
Adapter-based HTTP integration
Cloud generation initially; local backend later
Persistence
Project JSON + PNG layer/frame data
Portable, editable files without a database dependency
Packaging
Electron Builder
Windows installer and versioned releases

Architecture flow
Desktop UI
Canvas • timeline • palettes
Editor core
Project model • commands • undo
Storage / exports
PNG • JSON • sprite sheet
External AI assistant ⇄ local MCP server ⇄ validated editor command bridge; the AI provider adapter connects to editor commands only through user-approved actions.
Separation of concerns
Renderer draws immutable or versioned pixel buffers; UI controls dispatch commands rather than mutating canvas state directly.
Animation engine owns clips, frames, frame timing, and playback independently of AI integrations.
The MCP server and AI adapter call the same editor command layer as the UI, preserving undo/redo and consistent validation.
File paths are scoped to the currently selected project/export location; the UI owns any required confirmation.
04  MCP integration plan
One editor core; multiple entry points, including external agents.
MCP server boundary
Use a local MCP server implemented with TypeScript. For compatible desktop AI clients, stdio is an appropriate initial transport. A command bridge between the MCP server and the running Electron app will expose validated actions and project state. MCP tool responses should return structured results, errors, and relevant paths or previews where supported.
Tool (proposed)
Parameters / behavior
get_project_state
Return canvas, active clip, frame count, layers and export settings
create_project
Name, width, height, palette and default FPS
generate_sprite
Prompt, resolution, style constraints; request new candidate asset
create_animation
Clip name, FPS and frame count; initialize timeline
add_frame / edit_pixels
Insert or modify frame/layer; validate bounds and target
preview_animation
Return preview path or frame snapshot for review
export_spritesheet
Clip, layout, destination and optional metadata flags
save_project
Save to approved project path with versioning/recovery

Example agent-driven scenario
User request  “Create a 32×32 farmer, add a four-frame idle loop, and export it for Godot.”
MCP sequence  create_project → generate_sprite → create_animation → add_frame/edit_pixels → preview_animation → export_spritesheet.
Human review  The user approves generated frames before final export; the assistant receives success/failure details from each tool.
Safety and reliability rules
Validate parameter types, canvas bounds, clip IDs, requested frame counts and color values.
Require user confirmation for destructive operations, overwrites, and external file exports.
Run AI providers and imported files through restricted interfaces; avoid arbitrary shell execution from MCP tools.
Maintain an operation log and undoable command history; expose useful errors to the calling assistant.
Limit access to selected project directories and ensure only the user-approved local client can call the server.
05  AI generation and animation strategy
Generation pipeline
Step
Processing
Success check
1  Specify
Prompt + canvas size + palette + visual reference
Clear size/style constraints
2  Generate
AI provider outputs candidate image(s)
Candidate successfully returned
3  Normalize
Crop, transparent background, nearest-neighbor resize, color quantization
Exact dimensions and alpha channel
4  Pixel review
User inspects and adjusts sprite pixel-by-pixel
Editable raster layer accepted
5  Animate
Use fixed base character; derive controlled pose candidates
Consistent canvas and anchor point
6  QA / export
Loop preview, check jitter, inspect frames; export artifacts
Valid sheet plus metadata

Consistency controls
Lock the base sprite as a visual reference; keep a fixed canvas size, baseline, facing direction and palette.
Use frame differencing/overlay preview to detect unwanted character drift or flicker.
Prefer iterative modifications to existing frames for simple idle/walk animations over independent generation of every frame.
Separate deterministic pixel operations from generative steps so final edits remain precise and reproducible.
Provider strategy
Define an AIProvider interface with methods for generateSprite, editRegion, and suggestPose (when supported). Start with a single provider but avoid embedding model-specific calls in editor components. Optional local models or ComfyUI-compatible workflows can be added behind the same interface when performance permits.
06  Project data, export and interoperability
Suggested editable project layout
farmer.pixelproj/  — project folder or packaged document
  project.json  — dimensions, palette, clips, frame order, version and settings
  sprites/  — base and imported reference images
  clips/idle/frame_001/layer_*.png  — editable layer raster data
  clips/walk/frame_001/layer_*.png
  exports/  — generated sprite sheets and metadata
Export contract
Format
Purpose
Initial support
PNG per frame
Lossless sprite pixels with transparency
MVP
PNG sprite sheet
Grid or horizontal layout of animation frames
MVP
JSON metadata
Clip name, FPS, frame rectangles and anchor/offset
MVP
GIF preview
Simple visual sharing/inspection
Phase 2
Godot presets
Import-friendly naming and animation definitions
Phase 3

The exported pixels and JSON dimensions should match the editor project exactly; nearest-neighbor scaling is optional and must not alter the source frames.
07  Delivery roadmap and checkpoints
Phase
Deliverable
Exit criterion
P1 · Editor foundation
Canvas, layers, tools, undo/redo, project persistence
Draw/edit/save/reopen a valid sprite
P2 · Animation MVP
Timeline, onion skin, playback, sheet export
4-frame idle loop exports and reopens
P3 · AI integration
Base-sprite generation, normalization, editable import
User can accept/edit/discard candidate
P4 · MCP control
Tool server, command bridge, permissions, logging
External assistant edits a test project
P5 · Game-ready polish
Godot presets, batch export, performance testing
Asset imports correctly into Godot

Recommended first sprint
Bootstrap Electron + React + TypeScript app and establish a safe IPC boundary.
Implement 32×32 pixel canvas, pencil/eraser/fill, palette and zoom.
Define the project schema, commands, history, and JSON/PNG persistence.
Add a 4-frame timeline, playback at 8 FPS, and sprite-sheet export.
Create a basic MCP server with get_project_state and create_animation; expand once the command layer is stable.
MVP acceptance checklist
A user can create a transparent 32×32 project and edit pixels with undo/redo.
A four-frame idle animation plays at its configured frame rate without distortion.
The user can save, close, and reopen the project with all frames and layers intact.
A sprite sheet exports at the correct dimensions with transparent background and readable metadata.
A connected MCP client can inspect a project and perform a non-destructive edit through a validated tool.
User approval is required before overwriting an existing file.
08  Risks, decisions and next actions
Risk
Impact
Mitigation
AI pose inconsistency
Visible flicker, unreliable animation
Reference locking, fixed anchors, human review
Poor pixel-art output
Blurry or noisy sprite edges
Palette quantization and pixel-perfect correction
MCP filesystem misuse
Unexpected overwrites or access
Sandboxed paths and confirmations
Large undo / frame memory
Slow UI on complex projects
History limits, efficient buffers, profiling
AI provider cost / latency
Unpredictable usage expense
Pluggable providers, quotas and request previews

Open decisions
Finalize product name and whether Windows is the only initial target.
Choose the first image generation provider and its usage/cost model.
Set target canvas sizes, maximum frame counts, and performance thresholds for release v0.1.
Choose the first supported AI MCP client and its configuration/permission workflow.
Recommended next step
Implement the manual editor and 4-frame animation end-to-end, then introduce MCP control through the same internal command API. Integrate AI sprite generation only after project saving and exports are reliable.
Success demo: “Draw or generate a farmer → animate four idle frames → preview → save → export PNG + JSON → import into a Godot project.”

