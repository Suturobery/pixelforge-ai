"use strict";
// PixelForge AI — character kit insertion (Create Character → canvas).
//
// Inserts a kit character as a NEW regular clip via the sanctioned CommandBus
// path, in ONE transaction: clip + 4 layers (Body/Outfit/Head/Item) + painted
// frame-1 cels + motion parts (legL/legR/armL/body/head/armR). A failure
// anywhere rolls the whole transaction back — the document is never left
// half-inserted — and the composite history entry makes the insertion a
// single undo step.
//
// Pure core orchestration: no React/zustand — unit tests drive this headlessly.
Object.defineProperty(exports, "__esModule", { value: true });
exports.insertCharacter = insertCharacter;
const kit_1 = require("./kit");
/**
 * Insert the character as a new clip. Throws (document untouched) when the
 * selection is invalid or the canvas is not the kit's 32×32.
 */
function insertCharacter(bus, selection, opts = {}) {
    (0, kit_1.validateKitSelection)(selection); // throws before any mutation
    const project = bus.getProject();
    if (project.width !== kit_1.KIT_CANVAS || project.height !== kit_1.KIT_CANVAS) {
        throw new Error(`Character kit needs a ${kit_1.KIT_CANVAS}×${kit_1.KIT_CANVAS} canvas — the current project is ${project.width}×${project.height}.`);
    }
    const origin = opts.origin ?? 'ui';
    const label = opts.clipName?.trim() || (0, kit_1.kitSelectionLabel)(selection);
    const fps = Math.min(60, Math.max(1, Math.round(opts.fps ?? 8)));
    const buffers = (0, kit_1.composeKitBuffers)(selection, project.palette);
    let result = null;
    bus.transaction(`Add character: ${label}`, origin, () => {
        bus.execute('clip.add', { name: label, fps }, origin);
        const clip = bus.getProject().clips.at(-1);
        if (!clip)
            throw new Error('character insertion: clip.add produced no clip');
        const clipId = clip.id;
        // the clip's base layer becomes Body; Outfit/Head/Item stack above it
        const baseLayerId = clip.layers[0]?.id;
        if (!baseLayerId)
            throw new Error('character insertion: clip has no base layer');
        bus.execute('layer.setProps', { clipId, layerId: baseLayerId, patch: { name: kit_1.KIT_LAYERS[0].name } }, origin);
        const layerIds = { body: baseLayerId, outfit: '', head: '', item: '' };
        for (const spec of kit_1.KIT_LAYERS.slice(1)) {
            bus.execute('layer.add', { clipId, name: spec.name }, origin);
            const added = bus.getProject().clips.find((c) => c.id === clipId)?.layers.at(-1)?.id;
            if (!added)
                throw new Error(`character insertion: layer "${spec.name}" was not added`);
            layerIds[spec.grid] = added;
        }
        // paint frame 1 (the idle/walk anchor pose)
        const frameId = bus.getProject().clips.find((c) => c.id === clipId)?.frames[0]?.id;
        if (!frameId)
            throw new Error('character insertion: clip has no frame');
        for (const spec of kit_1.KIT_LAYERS) {
            bus.execute('pixels.applyOp', { clipId, frameId, layerId: layerIds[spec.grid], ops: [{ op: 'setBuffer', buffer: buffers[spec.grid] }] }, origin);
        }
        // pre-tag the motion parts (names are the preset roles) so Idle/Walk
        // animate the character in the existing Motion panel with no extra setup
        const parts = kit_1.KIT_LAYERS.flatMap((spec) => spec.parts.map((p) => ({
            name: p.name,
            layerId: layerIds[spec.grid],
            ...(p.rect ? { rect: { ...p.rect } } : {}),
        })));
        bus.execute('part.set', { clipId, parts }, origin);
        result = { clipId, layerIds };
    });
    if (!result)
        throw new Error('character insertion failed — the document was left unchanged');
    return result;
}
