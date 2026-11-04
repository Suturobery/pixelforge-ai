# Build a tileset

<!-- Adapted from with-pebbly/aseprite-ai-artist (MIT) for PixelForge. -->

## Decide the grid before anything else

Tile size is the one decision everything else depends on, and it belongs to
the game, not the art. Ask if you do not know it. 16×16 and 32×32 are the
common answers.

## Seamless tiles

A tile is seamless when its right edge continues into its own left edge, and
its bottom into its own top. Method that works:

1. Draw the tile's interior first, ignoring edges.
2. Draw the edge pattern on one side.
3. Make the first and last columns continue into each other. This is exact
   pixel work — do it against the actual pixel data, not by eye.
4. Same for top and bottom rows.
5. Stamp the tile in a 3×3 block and preview. Seams show up immediately when
   tiled; they are invisible in isolation.

**Avoid a repeating feature.** A distinctive rock in the middle of a grass
tile becomes a visible grid the moment it repeats. Keep repeating tiles
low-contrast and put distinctive elements in occasional variant tiles.

## Autotiling

A blob-47 set covers every neighbour combination for a 4-connected terrain
(47 tiles). Build the terrain body first, then the edge and corner cases —
hand-authoring them in the wrong order is where this goes wrong.

## From a painted mockup

Painting a level by hand and extracting tiles from it produces better-looking
tilesets than authoring tiles in isolation, because you see the whole picture
while drawing.

1. Paint the mockup on a layer, on a canvas that is a whole number of tiles
   in each direction.
2. Extract the unique tiles; a 400-cell mockup that yields 300 tiles was
   painted without regard to the grid — redraw with the grid visible rather
   than accept it.
3. Hide (never delete) the mockup layer to compare later.

## Export

Sprite sheet as a grid with padding; JSON metadata records tile size and the
layout so Tiled/Godot can slice it (`export` topic).
