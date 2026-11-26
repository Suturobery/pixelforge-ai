import { describe, expect, it } from 'bun:test';
import {
  CommandBus,
  composeFrameRgba,
  createProject,
  hitTestVectorShapes,
  projectFromSerialized,
  renderCelWithVectors,
  sampleBezierPixelPerfect,
  serializeProjectV2,
  validateSerializedProjectV2,
  validateVectorShapes,
  type VectorShape,
} from '../src';

describe('Pixel-Perfect Editable Vectors', () => {
  it('samples Bézier curves with zero L-corner doubles (pixel-perfect cleanup)', () => {
    const pts = sampleBezierPixelPerfect([
      { x: 2, y: 20 },
      { x: 16, y: 2 },
      { x: 30, y: 20 },
    ]);
    expect(pts.length).toBeGreaterThan(15);
    expect(pts[0]).toEqual({ x: 2, y: 20 });
    expect(pts[pts.length - 1]).toEqual({ x: 30, y: 20 });

    // Verify no 1px L-corner doubles remain in the curve path
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      const c = pts[i + 1]!;
      const abOrtho = (a.x === b.x && Math.abs(a.y - b.y) === 1) || (a.y === b.y && Math.abs(a.x - b.x) === 1);
      const bcOrtho = (b.x === c.x && Math.abs(b.y - c.y) === 1) || (b.y === c.y && Math.abs(b.x - c.x) === 1);
      const acDiag = Math.abs(a.x - c.x) === 1 && Math.abs(a.y - c.y) === 1;
      expect(abOrtho && bcOrtho && acDiag).toBe(false);
    }
  });

  it('composes vectors + Live FX modifiers non-destructively, round-trips v2 persistence, and bakes cleanly', async () => {
    const proj = createProject({ name: 'vec-test', width: 24, height: 24 });
    const bus = new CommandBus(proj);
    const clip = bus.getProject().clips[0]!;
    const frame = clip.frames[0]!;
    const layer = clip.layers[0]!;

    const shapes: VectorShape[] = [
      {
        id: 'arc1',
        kind: 'curve',
        points: [
          { x: 4, y: 18 },
          { x: 12, y: 4 },
          { x: 20, y: 18 },
        ],
        stroke: '#38b764',
        strokeWidth: 1,
      },
      {
        id: 'orb1',
        kind: 'ellipse',
        points: [
          { x: 9, y: 12 },
          { x: 15, y: 18 },
        ],
        stroke: '#f4f4f4',
        fill: '#3b5dc9',
      },
    ];

    bus.execute(
      'cel.setVectors',
      { clipId: clip.id, frameId: frame.id, layerId: layer.id, vectors: shapes },
      'ui',
    );
    // Attach a live outline modifier on top of the vector layer!
    bus.execute(
      'layer.setProps',
      {
        clipId: clip.id,
        layerId: layer.id,
        patch: {
          modifiers: {
            outline: { enabled: true, mode: 'solid', color: '#1a1c2c', connectivity: 4 },
          },
        },
      },
      'ui',
    );

    const cur = bus.getProject();
    const cel = cur.clips[0]!.frames[0]!.cels[layer.id]!;
    // Raw raster buffer is still 100% transparent (non-destructive!)
    expect(cel.buffer.every((v) => v === 0)).toBe(true);
    expect(cel.vectors).toHaveLength(2);

    // Vector-only rasterization renders green curve + blue/white orb
    const vecOnly = renderCelWithVectors(cel, 24, 24);
    let vecOpaque = 0;
    for (let i = 3; i < vecOnly.length; i += 4) if (vecOnly[i]! > 0) vecOpaque++;
    expect(vecOpaque).toBeGreaterThan(25);

    // Composited frame includes BOTH vectors AND the live outline modifier (more opaque px than vectors alone)
    const composed = composeFrameRgba(cur, cur.clips[0]!, cur.clips[0]!.frames[0]!);
    let composedOpaque = 0;
    for (let i = 3; i < composed.length; i += 4) if (composed[i]! > 0) composedOpaque++;
    expect(composedOpaque).toBeGreaterThan(vecOpaque);

    // Full v2 serialization + schema validation + round-trip preserves vectors
    const { projectJson, celPngs } = await serializeProjectV2(cur);
    expect(validateSerializedProjectV2(projectJson)).toEqual([]);
    const restored = await projectFromSerialized(projectJson, (src) => celPngs.get(src));
    expect(restored.clips[0]!.frames[0]!.cels[layer.id]!.vectors).toEqual(shapes);

    // Baking commits vector pixels into cel.buffer and clears cel.vectors (undoable)
    bus.execute('cel.bakeVectors', { clipId: clip.id, frameId: frame.id, layerId: layer.id }, 'ui');
    const afterBake = bus.getProject().clips[0]!.frames[0]!.cels[layer.id]!;
    expect(afterBake.vectors).toBeUndefined();
    let bakedOpaque = 0;
    for (let i = 3; i < afterBake.buffer.length; i += 4) if (afterBake.buffer[i]! > 0) bakedOpaque++;
    expect(bakedOpaque).toBe(vecOpaque);

    // Undo restores editable vectors & empty raw buffer
    bus.undo();
    const afterUndo = bus.getProject().clips[0]!.frames[0]!.cels[layer.id]!;
    expect(afterUndo.vectors).toHaveLength(2);
    expect(afterUndo.buffer.every((v) => v === 0)).toBe(true);
  });

  it('hit-tests handles before shape bodies and validates malformed vector payloads', () => {
    const shapes: VectorShape[] = [
      {
        id: 'line1',
        kind: 'line',
        points: [
          { x: 2, y: 2 },
          { x: 10, y: 2 },
        ],
        stroke: '#ff0000',
      },
    ];
    expect(hitTestVectorShapes(shapes, 2.2, 2.1, 1.0)).toEqual({
      kind: 'handle',
      shapeId: 'line1',
      pointIndex: 0,
    });
    expect(hitTestVectorShapes(shapes, 6, 2, 1.0)).toEqual({
      kind: 'shape',
      shapeId: 'line1',
    });
    expect(hitTestVectorShapes(shapes, 6, 12, 1.0)).toBeNull();

    expect(validateVectorShapes('nope')).toBeTruthy();
    expect(
      validateVectorShapes([{ id: 'bad', kind: 'curve', points: [{ x: 0, y: 0 }, { x: 5, y: 5 }], stroke: '#ffffff' }]),
    ).toBeTruthy();
    expect(
      validateVectorShapes([{ id: 'nocolor', kind: 'line', points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] }]),
    ).toBeTruthy();
  });
});
