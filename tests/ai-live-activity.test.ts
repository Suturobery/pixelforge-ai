import { describe, expect, test } from 'bun:test'
import { createProject } from '@pixelforge/core'
import {
  composeProgressiveReveal,
  diffChangedPixels,
  finishActiveReveals,
  flashAiRegion,
  getAiActivitySnapshot,
  getUndoStepsForAiEntry,
  replayAiActivityEntry,
  resetAiActivityForTests,
  setAiAutoFollow,
  setAiComparePreview,
  setAiPaused,
} from '@/lib/pixelforge/ai-live-activity'
import { executeMcpTool } from '@/lib/pixelforge/mcp-tools'
import { getBus, useEditor } from '@/lib/pixelforge/store'

const ctx = { clientId: 'codex-1', clientName: 'Codex', tier: 'L1' as const }

describe('Live AI Artist Activity Overlay & Co-Pilot HUD', () => {
  test('diffChangedPixels returns serpentine coordinates, full orderedIndices, and exact bbox', () => {
    const before = new Uint8ClampedArray(8 * 8 * 4)
    const after = new Uint8ClampedArray(8 * 8 * 4)
    const paint = (x: number, y: number) => {
      const i = (y * 8 + x) * 4
      after[i] = 20
      after[i + 1] = 184
      after[i + 2] = 166
      after[i + 3] = 255
    }
    paint(2, 1)
    paint(3, 1)
    paint(2, 2)
    paint(3, 2)

    const diff = diffChangedPixels(before, after, 8, 8)
    expect(diff.totalChanged).toBe(4)
    expect(diff.bbox).toEqual({ x: 2, y: 1, w: 2, h: 2 })
    // Row 1 goes left->right, row 2 reverses right->left (serpentine brush order)
    expect(diff.pixels).toEqual([
      { x: 2, y: 1 },
      { x: 3, y: 1 },
      { x: 3, y: 2 },
      { x: 2, y: 2 },
    ])
    expect(Array.from(diff.orderedIndices)).toEqual([10, 11, 19, 18])

    // Progressive reveal compositor: 0% = before, 50% = first 2 pixels, 100% = after
    const reveal = {
      clipId: 'c1',
      frameId: 'f1',
      width: 8,
      height: 8,
      before,
      after,
      orderedIndices: diff.orderedIndices,
    }
    const at0 = composeProgressiveReveal(reveal, 0)
    expect(at0[10 * 4 + 3]).toBe(0)
    const atHalf = composeProgressiveReveal(reveal, 0.5)
    expect(atHalf[10 * 4 + 3]).toBe(255)
    expect(atHalf[11 * 4 + 3]).toBe(255)
    expect(atHalf[19 * 4 + 3]).toBe(0)
    expect(atHalf[18 * 4 + 3]).toBe(0)
    const atFull = composeProgressiveReveal(reveal, 1)
    expect(atFull[18 * 4 + 3]).toBe(255)
  })

  test('executeMcpTool emits a progressive reveal pulse, status banner, and undoable feed entry', async () => {
    resetAiActivityForTests()
    useEditor.getState().newProject(createProject({ name: 'LiveOverlayTest', width: 16, height: 16 }))

    const res = await executeMcpTool(
      'fill_rect',
      { from: { x: 4, y: 4 }, to: { x: 7, y: 7 }, color: '#14b8a6', filled: true },
      ctx,
    )
    expect(res.ok).toBe(true)

    const snap = getAiActivitySnapshot()
    expect(snap.banner).not.toBeNull()
    expect(snap.banner!.clientName).toBe('Codex')
    expect(snap.banner!.totalChanged).toBe(16)
    expect(snap.pulses.length).toBeGreaterThanOrEqual(1)
    const pulse = snap.pulses.at(-1)!
    expect(pulse.clientName).toBe('Codex')
    expect(pulse.pixels.length).toBe(16)
    expect(pulse.bbox).toEqual({ x: 4, y: 4, w: 4, h: 4 })
    expect(pulse.reveal).toBeDefined()
    expect(pulse.reveal!.orderedIndices.length).toBe(16)

    // Activity feed entry tracks undo depth and Before/After compare snapshot
    expect(snap.feed.length).toBe(1)
    const entry = snap.feed[0]!
    expect(entry.totalChanged).toBe(16)
    expect(entry.compare).toBeDefined()
    expect(
      getUndoStepsForAiEntry(entry, useEditor.getState().historyUndoDepth, useEditor.getState().loadEpoch),
    ).toBe(1)

    // Hold-to-Compare activates before-buffer preview and finishActiveReveals clears both
    setAiComparePreview(entry.id)
    expect(getAiActivitySnapshot().comparePreview?.entryId).toBe(entry.id)
    finishActiveReveals()
    expect(getAiActivitySnapshot().comparePreview).toBeNull()
    expect(getAiActivitySnapshot().pulses.at(-1)?.reveal).toBeUndefined()

    // Clicking a feed row flashes a highlightOnly region pulse
    flashAiRegion(entry.id)
    expect(getAiActivitySnapshot().pulses.at(-1)?.highlightOnly).toBe(true)

    // Replay re-emits a full progressive reveal pulse for that step
    expect(replayAiActivityEntry(entry.id)).toBe(true)
    const replayed = getAiActivitySnapshot().pulses.at(-1)!
    expect(replayed.highlightOnly).toBeUndefined()
    expect(replayed.reveal?.orderedIndices.length).toBe(16)

    resetAiActivityForTests()
  })

  test('activity feed per-step undo computes multi-step counts and invalidates branched redo entries', async () => {
    resetAiActivityForTests()
    useEditor.getState().newProject(createProject({ name: 'FeedUndoTest', width: 16, height: 16 }))

    await executeMcpTool('fill_rect', { from: { x: 0, y: 0 }, to: { x: 2, y: 2 }, color: '#14b8a6', filled: true }, ctx)
    await executeMcpTool('fill_rect', { from: { x: 4, y: 4 }, to: { x: 6, y: 6 }, color: '#f59e0b', filled: true }, ctx)

    const [step2, step1] = getAiActivitySnapshot().feed
    const st = useEditor.getState()
    expect(getUndoStepsForAiEntry(step2!, st.historyUndoDepth, st.loadEpoch)).toBe(1)
    expect(getUndoStepsForAiEntry(step1!, st.historyUndoDepth, st.loadEpoch)).toBe(2)

    // Undo step 2, then make a new manual edit → step 2 is now on an overwritten redo branch and invalidated
    getBus().undo()
    const clip = getBus().getProject().clips[0]!
    getBus().execute('frame.add', { clipId: clip.id }, 'ui')

    const [afterStep2, afterStep1] = getAiActivitySnapshot().feed
    const stAfter = useEditor.getState()
    expect(getUndoStepsForAiEntry(afterStep2!, stAfter.historyUndoDepth, stAfter.loadEpoch)).toBeNull()
    expect(getUndoStepsForAiEntry(afterStep1!, stAfter.historyUndoDepth, stAfter.loadEpoch)).toBe(2)

    resetAiActivityForTests()
  })

  test('Artist Priority Pause holds mutating tools while allowing read-only inspection', async () => {
    resetAiActivityForTests()
    useEditor.getState().newProject(createProject({ name: 'PauseTest', width: 16, height: 16 }))
    setAiPaused(true)

    const blocked = await executeMcpTool(
      'fill_rect',
      { from: { x: 1, y: 1 }, to: { x: 3, y: 3 }, color: '#ef4444', filled: true },
      ctx,
    )
    expect(blocked.ok).toBe(false)
    expect(blocked.error?.code).toBe('artist_paused')
    expect(getAiActivitySnapshot().feed[0]?.status).toBe('paused')

    // Read-only L0 inspection still works while paused
    const inspect = await executeMcpTool('get_project_state', {}, { ...ctx, tier: 'L0' })
    expect(inspect.ok).toBe(true)

    // Resume allows writes again
    setAiPaused(false)
    const resumed = await executeMcpTool(
      'fill_rect',
      { from: { x: 1, y: 1 }, to: { x: 3, y: 3 }, color: '#22c55e', filled: true },
      ctx,
    )
    expect(resumed.ok).toBe(true)

    resetAiActivityForTests()
  })

  test('mid-stroke editor_busy emits a live waiting notice banner for the artist', async () => {
    resetAiActivityForTests()
    useEditor.getState().newProject(createProject({ name: 'BusyNoticeTest', width: 16, height: 16 }))
    const handle = useEditor.getState().beginStroke()
    expect(handle).not.toBeNull()

    const res = await executeMcpTool(
      'fill_rect',
      { from: { x: 0, y: 0 }, to: { x: 2, y: 2 }, color: '#14b8a6', filled: true },
      ctx,
    )
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('editor_busy')
    const banner = getAiActivitySnapshot().banner
    expect(banner?.tone).toBe('waiting')
    expect(banner?.label).toContain('painting')

    useEditor.getState().cancelStroke()
    resetAiActivityForTests()
  })

  test('painting an off-frame follows when Auto-Follow is ON, and reports offView when OFF', async () => {
    resetAiActivityForTests()
    useEditor.getState().newProject(createProject({ name: 'OffFrameTest', width: 16, height: 16 }))
    const clip = getBus().getProject().clips[0]!
    getBus().execute('frame.add', { clipId: clip.id }, 'mcp')
    useEditor.setState({ activeFrameIndex: 0, playing: false })

    // Auto-Follow OFF keeps artist on frame 0 and flags offView for Jump button
    setAiAutoFollow(false)
    const offRes = await executeMcpTool(
      'fill_rect',
      { frameIndex: 1, from: { x: 2, y: 2 }, to: { x: 3, y: 3 }, color: '#38bdf8', filled: true },
      ctx,
    )
    expect(offRes.ok).toBe(true)
    expect(useEditor.getState().activeFrameIndex).toBe(0)
    expect(getAiActivitySnapshot().banner?.offView).toBe(true)

    // Auto-Follow ON moves artist to frame 1
    setAiAutoFollow(true)
    const res = await executeMcpTool(
      'fill_rect',
      { frameIndex: 1, from: { x: 2, y: 2 }, to: { x: 5, y: 3 }, color: '#f59e0b', filled: true },
      ctx,
    )
    expect(res.ok).toBe(true)

    const target = getBus().getProject().clips[0]!.frames[1]!
    const pulse = getAiActivitySnapshot().pulses.at(-1)!
    expect(pulse.pixels.length).toBe(8)
    expect(pulse.bbox).toEqual({ x: 2, y: 2, w: 4, h: 2 })
    expect(useEditor.getState().activeFrameIndex).toBe(1)
    expect(getBus().getProject().clips[0]!.frames[useEditor.getState().activeFrameIndex]!.id).toBe(target.id)

    resetAiActivityForTests()
  })

  test('creating a brand-new clip (skin variants) sweeps the new clip in from empty and follows it', async () => {
    resetAiActivityForTests()
    useEditor.getState().newProject(createProject({ name: 'NewClipTest', width: 16, height: 16 }))
    await executeMcpTool(
      'fill_rect',
      { from: { x: 3, y: 3 }, to: { x: 8, y: 8 }, color: '#3b82f6', filled: true },
      ctx,
    )
    resetAiActivityForTests()
    const sourceClipId = getBus().getProject().clips[0]!.id

    const res = await executeMcpTool('create_skin_variants', { presets: ['fire'] }, ctx)
    expect(res.ok).toBe(true)

    const clips = getBus().getProject().clips
    expect(clips.length).toBe(2)
    const created = clips[1]!
    const pulse = getAiActivitySnapshot().pulses.at(-1)!
    expect(pulse.pixels.length).toBeGreaterThan(0)
    expect(pulse.reveal?.clipId).toBe(created.id)
    expect(useEditor.getState().activeClipId).toBe(created.id)
    expect(created.id).not.toBe(sourceClipId)

    resetAiActivityForTests()
  })

  test('get_project_state exposes live artistContext (selection, colors, symmetry, tiledWrap, aiPaused)', async () => {
    resetAiActivityForTests()
    useEditor.getState().newProject(createProject({ name: 'ArtistCtxTest', width: 32, height: 32 }))
    useEditor.setState({
      selection: { x: 6, y: 4, w: 12, h: 10 },
      primary: '#ffaa00',
      secondary: '#112233',
      mirrorX: true,
      mirrorY: false,
      tiledWrap: true,
    })
    setAiPaused(true)

    const res = await executeMcpTool('get_project_state', {}, { ...ctx, tier: 'L0' })
    expect(res.ok).toBe(true)
    const data = res.data as {
      artistContext?: {
        selection: { x: number; y: number; w: number; h: number } | null
        primaryColor: string
        secondaryColor: string
        mirrorX: boolean
        mirrorY: boolean
        tiledWrap: boolean
        aiPaused: boolean
      }
    }
    expect(data.artistContext).toMatchObject({
      selection: { x: 6, y: 4, w: 12, h: 10 },
      primaryColor: '#ffaa00',
      secondaryColor: '#112233',
      mirrorX: true,
      mirrorY: false,
      tiledWrap: true,
      aiPaused: true,
    })

    resetAiActivityForTests()
  })
})
