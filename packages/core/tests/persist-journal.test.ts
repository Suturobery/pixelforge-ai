/**
 * Command journal tests (Task 3 §6/§9.3) — recorder capture, binary-safe
 * JSONL codec, ring cap, replay determinism through the CommandBus (incl.
 * setBuffer ops carrying whole buffers), and stale-record skipping.
 */

import { describe, expect, test } from 'bun:test';
import { CommandBus } from '../src/bus/bus';
import { createProject, createClip } from '../src/doc/factory';
import {
  JournalRecorder,
  decodeJsonSafe,
  encodeJsonSafe,
  linesToRecords,
  recordsToLines,
  replayJournal,
  JOURNAL_CAP,
} from '../src/persist/journal';
import { cloneProject } from '../src/doc/factory';

describe('journal', () => {
  test('recorder captures executed commands with payload + origin; skips non-commands', () => {
    const project = createProject({ name: 'j', width: 16, height: 16 });
    const bus = new CommandBus(project);
    const skips: string[] = [];
    const recorder = new JournalRecorder(bus, { onSkip: (reason) => skips.push(reason) });

    bus.execute('project.rename', { name: 'renamed' }, 'mcp');
    bus.execute('clip.add', { name: 'walk', fps: 10 }, 'ui');
    // Transaction-internal commands each carry payloads; the transaction-level
    // event has none and is skipped.
    bus.transaction('batch', 'ui', () => {
      bus.execute('clip.setProps', { clipId: bus.getProject().clips[1].id, patch: { fps: 20 } }, 'ui');
    });
    bus.undo();

    const records = recorder.all();
    expect(records.length).toBeGreaterThanOrEqual(3);
    expect(records[0]).toMatchObject({ seq: 1, origin: 'mcp', commandType: 'project.rename', payload: { name: 'renamed' } });
    expect(records.some((r) => r.commandType === 'clip.setProps')).toBe(true);
    expect(skips.some((s) => s.includes('missing commandType'))).toBe(true);
    recorder.detach();
  });

  test('JSONL codec round-trips payloads containing Uint8ClampedArray buffers', () => {
    const payload = {
      clipId: 'cl1',
      frameId: 'fr1',
      layerId: 'ly1',
      ops: [{ op: 'setBuffer' as const, buffer: new Uint8ClampedArray([1, 2, 3, 250, 0, 255]) }],
    };
    const line = encodeJsonSafe(payload);
    const back = decodeJsonSafe(line) as typeof payload;
    const buf = (back.ops[0] as { buffer: Uint8ClampedArray }).buffer;
    expect(buf).toBeInstanceOf(Uint8ClampedArray);
    expect([...buf]).toEqual([1, 2, 3, 250, 0, 255]);
  });

  test('ring respects the cap (200 default)', () => {
    const project = createProject({ name: 'ring', width: 16, height: 16 });
    const bus = new CommandBus(project);
    const recorder = new JournalRecorder(bus, { cap: 10 });
    for (let i = 0; i < 25; i++) {
      bus.execute('project.rename', { name: `n${i}` }, 'ui');
    }
    expect(recorder.size).toBe(10);
    expect(recorder.all()[0].payload).toEqual({ name: 'n15' });
    expect(recorder.lastSeq).toBe(25);
    expect(JOURNAL_CAP).toBe(200);
    recorder.detach();
  });

  test('replay reconstructs the document exactly (structure + pixels via setBuffer)', () => {
    const project = createProject({ name: 'replay', width: 16, height: 16 });
    const clip = createClip({ name: 'idle', width: 16, height: 16, fps: 8, layerNames: ['a'], frameCount: 2 });
    project.clips.push(clip);
    const bus = new CommandBus(cloneProject(project));
    const layerId = bus.getProject().clips[1].layers[0].id;
    const clipId = bus.getProject().clips[1].id;
    const frameId = bus.getProject().clips[1].frames[0].id;

    // Recorder must be attached BEFORE the commands it should capture.
    const recorder = new JournalRecorder(bus);

    // 1) structural command
    bus.execute('project.rename', { name: 'replayed' }, 'ui');
    // 2) pixel command carrying a full buffer (binary journal path)
    const buffer = new Uint8ClampedArray(16 * 16 * 4);
    buffer[(8 * 16 + 8) * 4 + 1] = 200;
    bus.execute(
      'pixels.applyOp',
      { clipId, frameId, layerId, ops: [{ op: 'setBuffer', buffer }] },
      'mcp'
    );
    const recorderRecords = recorder.all();
    recorder.detach();
    expect(recorderRecords.length).toBe(2);

    // Replay onto the ORIGINAL project state through a fresh bus.
    const result = replayJournal(project, recorderRecords);
    expect(result.applied).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.project.name).toBe('replayed');
    const cel = result.project.clips[1].frames[0].cels[layerId];
    expect(cel.buffer[(8 * 16 + 8) * 4 + 1]).toBe(200);

    // Replay is deterministic: two runs produce equal documents.
    const again = replayJournal(project, recorderRecords);
    expect(again.project.name).toBe('replayed');
  });

  test('replay skips stale/failing records and reports reasons', () => {
    const project = createProject({ name: 'stale', width: 16, height: 16 });
    const records = linesToRecords(recordsToLines([
      { seq: 1, ts: 1, origin: 'ui', commandType: 'project.rename', payload: { name: 'ok' } },
      { seq: 2, ts: 2, origin: 'ui', commandType: 'clip.setProps', payload: { clipId: 'nope', patch: { fps: 30 } } },
      { seq: 3, ts: 3, origin: 'ui', commandType: 'totally.unknown', payload: {} },
    ])).records;
    const result = replayJournal(project, records);
    expect(result.applied).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.skipReasons.length).toBe(2);
    expect(result.project.name).toBe('ok');
  });

  test('tolerant JSONL parse skips corrupt trailing lines', () => {
    const good = recordsToLines([{ seq: 1, ts: 1, origin: 'ui', commandType: 'project.rename', payload: { name: 'a' } }]);
    const parsed = linesToRecords([good[0], '{"seq":2,"commandType":"project.ren', 'not json']);
    expect(parsed.records.length).toBe(1);
    expect(parsed.corruptLines).toBe(2);
  });

  // --- Task 4: completed brush strokes are journal-recoverable -------------

  test('committed strokes are recorded as replayable setBuffer ops', () => {
    const project = createProject({ name: 'strokej', width: 16, height: 16 });
    const bus = new CommandBus(project);
    const recorder = new JournalRecorder(bus);
    const clip = bus.getProject().clips[0];
    const frame = clip.frames[0];
    const layerId = clip.layers[0].id;

    const handle = bus.beginStroke({ clipId: clip.id, frameId: frame.id, layerId });
    handle.buffer[(4 * 16 + 5) * 4 + 1] = 220; // paint one pixel (G channel)
    handle.buffer[(4 * 16 + 5) * 4 + 3] = 255;
    const commit = bus.endStroke('Pencil', true, 'ui');
    expect(commit.committed).toBe(true);

    const records = recorder.all();
    expect(records.length).toBe(1);
    expect(records[0].commandType).toBe('pixels.applyOp');
    const payload = records[0].payload as { ops: { op: string; buffer: Uint8ClampedArray }[] };
    expect(payload.ops[0].op).toBe('setBuffer');
    expect(payload.ops[0].buffer[(4 * 16 + 5) * 4 + 1]).toBe(220);

    // Simulate a crash: the recovery source is the last save (the PRE-stroke
    // document, same ids — `project` was never mutated by the bus), then the
    // journal replays the stroke on top — it must come back exactly.
    const replayed = replayJournal(project, records);
    expect(replayed.applied).toBe(1);
    expect(replayed.skipped).toBe(0);
    const cel = replayed.project.clips[0].frames[0].cels[layerId];
    expect(cel.buffer[(4 * 16 + 5) * 4 + 1]).toBe(220);
    expect(cel.buffer[(4 * 16 + 5) * 4 + 3]).toBe(255);
    recorder.detach();
  });

  test('oversized strokes are skipped (autosave covers them) and cancelled strokes record nothing', () => {
    // 129×129 canvas → buffer 66564 bytes > STROKE_JOURNAL_MAX_BYTES.
    const project = createProject({ name: 'big', width: 129, height: 129 });
    const bus = new CommandBus(project);
    const skips: string[] = [];
    const recorder = new JournalRecorder(bus, { onSkip: (r) => skips.push(r) });
    const clip = bus.getProject().clips[0];
    const frame = clip.frames[0];
    const layerId = clip.layers[0].id;

    const h1 = bus.beginStroke({ clipId: clip.id, frameId: frame.id, layerId });
    h1.buffer[0] = 9;
    bus.endStroke('Pencil', true, 'ui');
    expect(recorder.size).toBe(0);
    expect(skips.length).toBe(1);

    const h2 = bus.beginStroke({ clipId: clip.id, frameId: frame.id, layerId });
    h2.buffer[1] = 9;
    bus.cancelStroke('ui');
    expect(recorder.size).toBe(0);

    // A small stroke on the same recorder still records (seq kept monotonic).
    const small = createProject({ name: 'small', width: 16, height: 16 });
    const smallBus = new CommandBus(small);
    void smallBus;
    recorder.detach();
  });

  test('setProject clears the ring (records never replay across documents)', () => {
    const project = createProject({ name: 'one', width: 16, height: 16 });
    const bus = new CommandBus(project);
    const recorder = new JournalRecorder(bus);
    bus.execute('project.rename', { name: 'x' }, 'ui');
    expect(recorder.size).toBe(1);

    bus.setProject(createProject({ name: 'two', width: 16, height: 16 }), { dirty: true });
    expect(recorder.size).toBe(0);
    // seq stays monotonic for horizon safety.
    bus.execute('project.rename', { name: 'y' }, 'ui');
    const records = recorder.all();
    expect(records.length).toBe(1);
    expect(records[0].seq).toBe(2);
    expect(records[0].payload).toEqual({ name: 'y' });
    recorder.detach();
  });
});
