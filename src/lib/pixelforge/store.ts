'use client'

import { create } from 'zustand'
import type {
  Facing,
  PixelGrid,
  PresetId,
  Rect,
  Rig,
} from './types'
import type { PresetVersion } from './presets'
import { cloneGrid } from './sprite'
import { DEFAULT_PARAMS } from './presets'
import type { PlaybackMode } from './playback'
import { getFixture, type FixtureId } from './fixtures'

const STORAGE_KEY = 'pixelforge-motion-v1'
const MAX_UNDO = 60

export type Tool = 'pencil' | 'eraser' | 'picker'

interface Snapshot {
  grid: PixelGrid
  rig: Rig
}

interface PersistShape {
  width: number
  height: number
  data: number[]
  rig: Rig
  durationOverrides: (number | undefined)[]
  params: { amplitude: number; speed: number; facing: Facing }
  presetId: PresetId
  presetVersion: PresetVersion
  color: string
}

export interface EditorStore {
  grid: PixelGrid
  rig: Rig
  template: FixtureId | 'custom'
  tool: Tool
  color: string
  zoom: number
  showRects: boolean
  activePart: string | null
  presetId: PresetId
  presetVersion: PresetVersion
  params: { amplitude: number; speed: number; facing: Facing }
  durationOverrides: (number | undefined)[]
  playbackMode: PlaybackMode
  playing: boolean
  currentStep: number
  undoStack: Snapshot[]
  redoStack: Snapshot[]
  savedAt: number | null

  setTool: (t: Tool) => void
  setColor: (c: string) => void
  setZoom: (z: number) => void
  setShowRects: (v: boolean) => void
  setActivePart: (id: string | null) => void
  setPreset: (id: PresetId) => void
  setPresetVersion: (v: PresetVersion) => void
  setParams: (p: Partial<{ amplitude: number; speed: number; facing: Facing }>) => void
  resetParams: () => void
  setPlaybackMode: (m: PlaybackMode) => void
  setPlaying: (v: boolean) => void
  setCurrentStep: (i: number) => void
  setDuration: (frame: number, ms: number | undefined) => void
  resetDurations: () => void

  paintPixel: (x: number, y: number) => void
  beginStroke: () => void
  endStroke: () => void
  setPartRect: (partId: string, rect: Rect) => void

  loadTemplate: (id: FixtureId) => void
  save: () => void
  load: () => boolean
  undo: () => void
  redo: () => void
}

function deepRig(rig: Rig): Rig {
  return { parts: rig.parts.map((p) => ({ ...p, rect: { ...p.rect } })) }
}

function pushUndo(state: EditorStore): Snapshot {
  return { grid: cloneGrid(state.grid), rig: deepRig(state.rig) }
}

export const useEditor = create<EditorStore>((set, get) => ({
  ...(() => {
    const { grid, rig } = getFixture('simple')
    return { grid, rig, template: 'simple' as FixtureId }
  })(),
  tool: 'pencil',
  color: '#e8b796',
  zoom: 12,
  showRects: true,
  activePart: 'armL',
  presetId: 'walk',
  presetVersion: 'v2',
  params: { ...DEFAULT_PARAMS },
  durationOverrides: [],
  playbackMode: 'loop',
  playing: true,
  currentStep: 0,
  undoStack: [],
  redoStack: [],
  savedAt: null,

  setTool: (tool) => set({ tool }),
  setColor: (color) => set({ color }),
  setZoom: (zoom) => set({ zoom: Math.min(24, Math.max(4, zoom)) }),
  setShowRects: (showRects) => set({ showRects }),
  setActivePart: (activePart) => set({ activePart }),
  setPreset: (presetId) =>
    set((s) => {
      const set = getPresetSet(s.presetVersion)
      const loops = set[presetId].loops
      return {
        presetId,
        durationOverrides: [],
        currentStep: 0,
        // R8: one-shot presets play once; loops play looped by default
        playbackMode: loops ? 'loop' : 'once',
      }
    }),
  setPresetVersion: (presetVersion) =>
    set((s) => {
      const set = getPresetSet(presetVersion)
      const loops = set[s.presetId].loops
      return {
        presetVersion,
        durationOverrides: [],
        currentStep: 0,
        playbackMode: loops ? 'loop' : 'once',
      }
    }),
  setParams: (p) => set((s) => ({ params: { ...s.params, ...p } })),
  resetParams: () => set({ params: { ...DEFAULT_PARAMS } }),
  setPlaybackMode: (playbackMode) => set({ playbackMode, currentStep: 0 }),
  setPlaying: (playing) => set({ playing }),
  setCurrentStep: (currentStep) => set({ currentStep }),
  setDuration: (frame, ms) =>
    set((s) => {
      const overrides = [...s.durationOverrides]
      overrides[frame] = ms
      return { durationOverrides: overrides }
    }),
  resetDurations: () => set({ durationOverrides: [] }),

  beginStroke: () => set((s) => ({ undoStack: [...s.undoStack.slice(-MAX_UNDO + 1), pushUndo(s)], redoStack: [] })),
  endStroke: () => {
    get().save()
  },
  paintPixel: (x, y) =>
    set((s) => {
      const { tool, color, grid } = s
      if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return {}
      const g = cloneGrid(grid)
      const i = (y * g.width + x) * 4
      if (tool === 'pencil') {
        const hex = color.replace('#', '')
        const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex
        const n = parseInt(full, 16)
        g.data[i] = (n >> 16) & 255
        g.data[i + 1] = (n >> 8) & 255
        g.data[i + 2] = n & 255
        g.data[i + 3] = 255
      } else if (tool === 'eraser') {
        g.data[i] = 0
        g.data[i + 1] = 0
        g.data[i + 2] = 0
        g.data[i + 3] = 0
      }
      return { grid: g }
    }),

  setPartRect: (partId, rect) =>
    set((s) => {
      const snapshot = pushUndo(s)
      const rig = deepRig(s.rig)
      const part = rig.parts.find((p) => p.id === partId)
      if (part) part.rect = { ...rect }
      return { rig, undoStack: [...s.undoStack.slice(-MAX_UNDO + 1), snapshot], redoStack: [], savedAt: null }
    }),

  loadTemplate: (id) => {
    const s = get()
    const snapshot = pushUndo(s)
    const { grid, rig } = getFixture(id)
    set({
      grid,
      rig,
      template: id,
      durationOverrides: [],
      currentStep: 0,
      undoStack: [...s.undoStack.slice(-MAX_UNDO + 1), snapshot],
      redoStack: [],
      savedAt: null,
    })
    get().save()
  },

  save: () => {
    const s = get()
    const payload: PersistShape = {
      width: s.grid.width,
      height: s.grid.height,
      data: Array.from(s.grid.data),
      rig: s.rig,
      durationOverrides: s.durationOverrides,
      params: s.params,
      presetId: s.presetId,
      presetVersion: s.presetVersion,
      color: s.color,
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
      set({ savedAt: Date.now() })
    } catch {
      /* storage full — ignore */
    }
  },

  load: () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return false
      const p = JSON.parse(raw) as PersistShape
      if (!p.data || p.width < 8 || p.height < 8) return false
      set({
        grid: { width: p.width, height: p.height, data: new Uint8ClampedArray(p.data) },
        rig: p.rig,
        template: 'custom',
        durationOverrides: p.durationOverrides ?? [],
        params: p.params ?? { ...DEFAULT_PARAMS },
        presetId: p.presetId ?? 'walk',
        presetVersion: p.presetVersion ?? 'v2',
        color: p.color ?? '#e8b796',
        currentStep: 0,
        savedAt: Date.now(),
      })
      return true
    } catch {
      return false
    }
  },

  undo: () =>
    set((s) => {
      const prev = s.undoStack[s.undoStack.length - 1]
      if (!prev) return {}
      return {
        grid: prev.grid,
        rig: prev.rig,
        undoStack: s.undoStack.slice(0, -1),
        redoStack: [...s.redoStack, pushUndo(s)],
        savedAt: null,
      }
    }),
  redo: () =>
    set((s) => {
      const next = s.redoStack[s.redoStack.length - 1]
      if (!next) return {}
      return {
        grid: next.grid,
        rig: next.rig,
        redoStack: s.redoStack.slice(0, -1),
        undoStack: [...s.undoStack.slice(-MAX_UNDO + 1), pushUndo(s)],
        savedAt: null,
      }
    }),
}))
