# Building anything in this look

This is the craft note the writer reads. It is about **method**, not about subjects: any story can be built here, and the
same rules apply to a lighthouse, a bridge, a market stall, a rocket or a castle gate.

## The unit

One block is one unit. Coordinates are whole numbers, `y = 0` is the ground plane, and nothing may sit below it. You
build upwards from the ground, not outwards from a centre.

A person is 2 blocks tall. That is the scale everything else is judged against: a door a person walks through is 2 wide
and 3 high, a table is 2 blocks, a two-storey house is 7 to 9 blocks to the eaves.

## Silhouette first

Before any detail, the subject must be readable in one glance **from above and from the side**. If the outline does not
say what it is, no material will save it. So:

- The axis that carries the identity is the widest one. A wing, a span, a wall, a row of arches: make it clearly wider
  than everything else (a third wider at least). A tower is the tallest thing, by the same margin.
- Build the big masses first (body, span, tower), then add one layer of detail. Two layers of detail on a wrong
  silhouette is worse than none on a right one.
- Never represent a subject that has parts as a single box. "A gate" is not a box; it is two piers, a span with an
  opening, and a top. A box says "block", not "gate".

## Thickness and hollows

- A wall or a deck is 1 block thick. A load-bearing pier or a leg is 2.
- Anything a person enters is hollow: `walls` for the perimeter, a `roof` on top, a floor of `box` one layer thick.
- Openings are cut, not implied. A door is a hole in `walls` (`openings`), 2 wide and 3 to 4 high. Windows are 1×1 or
  1×2, and they sit one block above the floor line.

## Symmetry

Buildings, gates, bridges, vehicles and tools are symmetric. Count the blocks either side of the middle and make the
two numbers **equal** before you answer; the check will tell you if they are not. Asymmetry is a decision you make on
purpose (a chimney, a leaning mast, a broken wall), never an accident of coordinates.

## Proportion, in blocks

- Doorway 2×3. Window 1×1 or 1×2. Person 2 tall.
- Roof rise is about half the depth it covers; a gable runs the long way, a hip steps in on all four sides.
- A round tower's height is 2 to 4 times its radius. Radius 2 is a turret, 3 a tower, 4 and up a keep.
- A span (bridge, arch, gate) is 8 to 16 long for a path 3 wide; its piers are as tall as the gap is wide divided by 2.
- Anything that flies or floats is wider than it is long, and its supports reach the ground.

## Materials say what a thing is

Pick **three at most** per object, one of them dominant:

- `mcl_core:stonebrick` walls, piers, defence. `mcl_core:cobble` rough or old masonry, foundations.
- `mcl_core:wood` structure, roofs, decks, anything built by hand. `mcl_core:tree` posts and beams.
- `mcl_core:brick_block` finished, town work, chimneys. `mcl_core:clay` plaster and light walls.
- `mcl_core:glass` openings only. `mcl_core:leaves` growth. `mcl_core:obsidian` metal, dark fittings, wheels.
- `mcl_core:sand`, `mcl_core:snowblock`, `mcl_core:dirt` ground, banks, drifts. Never a wall.

A material that is not on this list is not a block this pack has, and it will be drawn as stonebrick and noted.

## Patterns that work

These are shapes to start from, not subjects to copy:

- **Shell and roof** — `walls` [w, h, d] with the door cut, `roof` [w, d] on top. Every building is this.
- **Pier and span** — two `box` piers 2 wide, a `box` deck between them, `walls` with a large opening above the deck.
- **Column and cap** — `cylinder` hollow, a `roof` style `flat` two blocks wider than the radius as the cap.
- **Base, body, head** — three stacked masses with each one narrower than the one below: towers, lighthouses, statues.
- **Deck and hull** — a long `box` deck, a `prism` on each side for the hull's slope (`axis` along the length, `flip`
  to turn it), 1 block walls as the rail.
- **Body, span, tail, nose** — a long body, one wide span across it, a small span and a fin at the back, a `prism` or a
  narrow box at the front. This is how anything with a fuselage is built, whatever it is.

## Before you answer

1. Is every part on the ground or on something that is? Nothing hangs in the air unless it is meant to.
2. Is the build symmetric where the subject is? Are the two counts equal?
3. Is the widening that identifies the subject at least a third wider than the rest?
4. Does the tallest mass belong to the part that should be tallest?
5. Are there three materials or fewer, and is one of them dominant?