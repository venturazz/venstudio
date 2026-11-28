/**
 * What the parts actually build, read the way the page reads them.
 *
 * The page compiles `intent.parts` with the pack's own compiler (`render/world.js`). A writer that never sees its own
 * build is writing blind: it can name a scene "a gate with two towers" and send one box. So this module compiles the
 * same parts to the same node list, and returns two things a *text* writer can act on:
 *
 *   - measurements (blocks, bounds, symmetry, ground gap, layers) — the check a model cannot argue with;
 *   - a projection from above and from the side, as characters — the shape, in the only medium the writer reads.
 *
 * It is a deliberate second implementation of `world.js`, because the portal cannot import a pack's browser module into
 * its server bundle. `voxel.test.ts` compiles the same fixtures through the pack's real `world.js` and fails if the two
 * ever disagree, so this file cannot drift silently.
 */

const PRIMITIVES = ["box", "walls", "roof", "cylinder", "prism", "stair", "path", "tree", "blocks"] as const;
const FALLBACK_MATERIAL = "mcl_core:stonebrick";
const MAX_PARTS = 64;
const MAX_BLOCKS = 24000;
const LIMIT = 96;

type Vec3 = [number, number, number];
export type VoxelNode = [number, number, number, string, number];

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const int = (v: unknown, d: number) => (isNum(v) ? Math.round(v) : d);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export type Compiled = { nodes: VoxelNode[]; notes: string[]; size: Vec3; blocks: number };

export function voxelise(parts: unknown, known?: Set<string>): Compiled {
  const nodes = new Map<string, VoxelNode>();
  const notes: string[] = [];
  const put = (x: number, y: number, z: number, name: string) => {
    if (!isNum(x) || !isNum(y) || !isNum(z)) return;
    const ix = Math.round(x), iy = Math.round(y), iz = Math.round(z);
    if (Math.abs(ix) > LIMIT || Math.abs(iy) > LIMIT || Math.abs(iz) > LIMIT) return;
    if (iy < 0) return;
    if (nodes.size >= MAX_BLOCKS) return;
    nodes.set(`${ix},${iy},${iz}`, [ix, iy, iz, name, 0]);
  };
  const mat = (p: Record<string, unknown>, at: string) => {
    const m = typeof p.material === "string" ? p.material.trim() : "";
    if (!m) return FALLBACK_MATERIAL;
    const shaped = /^[a-z0-9_]+:[a-z0-9_]+$/.test(m);
    if (!shaped || (known && !known.has(m))) {
      notes.push(`${at}: material "${m}" is not a block this pack has; drew ${FALLBACK_MATERIAL}`);
      return FALLBACK_MATERIAL;
    }
    return m;
  };

  const list = Array.isArray(parts) ? parts : [];
  if (!Array.isArray(parts)) return { nodes: [], notes: ["no parts"], size: [1, 1, 1], blocks: 0 };
  if (list.length > MAX_PARTS) notes.push(`${list.length} parts, only the first ${MAX_PARTS} drawn`);

  list.slice(0, MAX_PARTS).forEach((raw, i) => {
    const part = (raw && typeof raw === "object" ? raw : null) as Record<string, unknown> | null;
    const at = `part ${i + 1}${part && part.kind ? ` (${String(part.kind)})` : ""}`;
    if (!part) {
      notes.push(`${at}: not an object`);
      return;
    }
    const at0 = Array.isArray(part.at) ? (part.at as unknown[]) : [0, 0, 0];
    const ox = int(at0[0], 0), oy = int(at0[1], 0), oz = int(at0[2], 0);
    const sizeRaw = Array.isArray(part.size) ? (part.size as unknown[]) : [1, 1, 1];
    const [w, h, d] = [0, 1, 2].map((k) => clamp(int(sizeRaw[k], 1), 1, 48));
    const m = mat(part, at);
    switch (part.kind) {
      case "box": {
        const hollow = part.hollow === true;
        for (let x = 0; x < w; x++)
          for (let y = 0; y < h; y++)
            for (let z = 0; z < d; z++) {
              const edge = x === 0 || x === w - 1 || z === 0 || z === d - 1;
              if (hollow && !edge) continue;
              put(ox + x, oy + y, oz + z, m);
            }
        break;
      }
      case "walls": {
        const openings = Array.isArray(part.openings) ? (part.openings as unknown[]) : [];
        const open = (x: number, y: number) =>
          openings.some((o) => {
            const op = (o && typeof o === "object" ? o : null) as Record<string, unknown> | null;
            if (!op || !Array.isArray(op.at)) return false;
            const oa = Math.round(Number((op.at as unknown[])[0])), ob = Math.round(Number((op.at as unknown[])[1]));
            const ow = clamp(int(op.w, 1), 1, 12), oh = clamp(int(op.h, 1), 1, 12);
            return x >= oa && x < oa + ow && y >= ob && y < ob + oh;
          });
        for (let x = 0; x < w; x++)
          for (let y = 0; y < h; y++)
            for (let z = 0; z < d; z++) {
              const edge = x === 0 || x === w - 1 || z === 0 || z === d - 1;
              if (!edge) continue;
              if (open(x, y) && (z === 0 || z === d - 1) && d > 1) continue;
              if (open(z, y) && (x === 0 || x === w - 1) && w > 1) continue;
              if (open(x, y) && d <= 1) continue;
              put(ox + x, oy + y, oz + z, m);
            }
        break;
      }
      case "roof": {
        const rw = Math.max(1, int(sizeRaw[0], 1));
        const rd = Math.max(1, int(sizeRaw.length > 1 ? sizeRaw[1] : undefined, rw));
        const style = part.style === "hip" || part.style === "flat" ? part.style : "gable";
        const rise = clamp(int(part.rise, Math.max(2, Math.ceil(Math.min(rw, rd) / 2))), 1, 16);
        if (style === "flat") {
          for (let x = -1; x <= rw; x++) for (let z = -1; z <= rd; z++) put(ox + x, oy, oz + z, m);
          break;
        }
        if (style === "hip") {
          for (let k = 0; k < rise; k++) {
            const x0 = k, x1 = rw - 1 - k, z0 = k, z1 = rd - 1 - k;
            if (x0 > x1 || z0 > z1) break;
            for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) put(ox + x, oy + k, oz + z, m);
          }
          break;
        }
        for (let k = 0; k < rise; k++) {
          const z0 = k, z1 = rd - 1 - k;
          if (z0 > z1) break;
          for (let x = 0; x < rw; x++) for (let z = z0; z <= z1; z++) put(ox + x, oy + k, oz + z, m);
        }
        break;
      }
      case "cylinder": {
        const r = clamp(int(part.radius, 3), 1, 20);
        const tall = clamp(int(part.height, h), 1, 48);
        const hollow = part.hollow !== false;
        for (let y = 0; y < tall; y++)
          for (let x = -r; x <= r; x++)
            for (let z = -r; z <= r; z++) {
              const dd = Math.sqrt(x * x + z * z);
              if (dd > r + 0.35) continue;
              if (hollow && dd < r - 1) continue;
              put(ox + x, oy + y, oz + z, m);
            }
        break;
      }
      case "prism": {
        const axis = part.axis === "x" ? "x" : "z";
        const len = axis === "x" ? w : d;
        const wid = axis === "x" ? d : w;
        for (let i = 0; i < len; i++) {
          const from = part.flip === true ? len - 1 - i : i;
          const colH = Math.max(1, Math.round((h * (len - from)) / len));
          for (let b = 0; b < wid; b++)
            for (let y = 0; y < colH; y++)
              put(axis === "x" ? ox + i : ox + b, oy + y, axis === "x" ? oz + b : oz + i, m);
        }
        break;
      }
      case "stair": {
        const steps = clamp(int(part.rise, h), 1, 16);
        for (let z = 0; z < d; z++) {
          const top = Math.min(steps, 1 + Math.floor((z * steps) / Math.max(1, d - 1)));
          for (let y = 0; y < top; y++) for (let x = 0; x < w; x++) put(ox + x, oy + y, oz + z, m);
        }
        break;
      }
      case "path": {
        for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) put(ox + x, 0, oz + z, m);
        break;
      }
      case "tree": {
        const trunk = clamp(int(part.rise, 4), 2, 14);
        const leaf = typeof part.leaf === "string" ? part.leaf : "mcl_core:leaves";
        for (let y = 0; y < trunk; y++) put(ox, oy + y, oz, m);
        for (let dx = -2; dx <= 2; dx++)
          for (let dz = -2; dz <= 2; dz++)
            for (let dy = 0; dy <= 2; dy++) {
              if (Math.abs(dx) + Math.abs(dz) + dy > 3) continue;
              put(ox + dx, oy + trunk - 1 + dy, oz + dz, leaf);
            }
        break;
      }
      case "blocks": {
        const raw = Array.isArray(part.nodes) ? (part.nodes as unknown[]) : [];
        for (const n of raw) {
          if (!Array.isArray(n) || n.length < 4) continue;
          put(Number(n[0]), Number(n[1]), Number(n[2]), typeof n[3] === "string" ? (n[3] as string) : m);
        }
        break;
      }
      default:
        notes.push(`${at}: unknown kind "${String(part.kind)}"; it can build ${PRIMITIVES.join(", ")}`);
    }
  });

  const out = [...nodes.values()].sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2]);
  let maxX = 0, maxY = 0, maxZ = 0, minX = 0, minZ = 0;
  for (const [x, y, z] of out) {
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
    minX = Math.min(minX, x);
    minZ = Math.min(minZ, z);
  }
  if (out.length === 0) notes.push("nothing was built: no part produced a block");
  return { nodes: out, notes, size: [maxX - minX + 1, maxY + 1, maxZ - minZ + 1], blocks: out.length };
}

export type SketchCheck = {
  parts: number;
  blocks: number;
  size: Vec3;
  /** Blocks left and right of the mirror line, per axis: a symmetric build has equal counts. */
  symmetry: { x: [number, number]; z: [number, number] };
  /** The lowest block. 0 touches the ground plane; anything above floats. */
  groundGap: number;
  /** How many height levels the build occupies: a single box has one. */
  layers: number;
  notes: string[];
};

export type Sketch = { check: SketchCheck; top: string[]; side: string[]; legend: string[] };

const MAX_COLS = 44;
const MAX_ROWS = 22;

/** Rows shrink by sampling when a build is wider than a phone screen's worth of characters. */
function grid(cells: Set<string>, x0: number, x1: number, y0: number, y1: number, flipY: boolean): string[] {
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const stepX = Math.max(1, Math.ceil(w / MAX_COLS));
  const stepY = Math.max(1, Math.ceil(h / MAX_ROWS));
  const rows: string[] = [];
  const ys = flipY ? [...Array(Math.ceil(h / stepY))].map((_, i) => y1 - i * stepY) : [...Array(Math.ceil(h / stepY))].map((_, i) => y0 + i * stepY);
  for (const y of ys) {
    let line = "";
    for (let x = x0; x <= x1; x += stepX) {
      let hit = false;
      for (let dx = 0; dx < stepX && !hit; dx++)
        for (let dy = 0; dy < stepY && !hit; dy++) if (cells.has(`${x + dx},${flipY ? y - dy : y + dy}`)) hit = true;
      line += hit ? "#" : ".";
    }
    rows.push(line);
  }
  return rows;
}

/**
 * The build as measurements plus two drawings.
 *
 * `top` looks down the y axis (x to the right, z downwards), `side` looks along z (x to the right, y upwards). Anything
 * taller or wider than the character budget is sampled, never cropped: a writer must see the whole thing or it will
 * "fix" a wing it cannot see.
 */
export function sketchOf(parts: unknown, known?: Set<string>): Sketch {
  const c = voxelise(parts, known);
  const nodes = c.nodes;
  const xs = nodes.map((n) => n[0]), ys = nodes.map((n) => n[1]), zs = nodes.map((n) => n[2]);
  const minX = xs.length ? Math.min(...xs) : 0, maxX = xs.length ? Math.max(...xs) : 0;
  const minY = ys.length ? Math.min(...ys) : 0, maxY = ys.length ? Math.max(...ys) : 0;
  const minZ = zs.length ? Math.min(...zs) : 0, maxZ = zs.length ? Math.max(...zs) : 0;

  const leftX = nodes.filter((n) => n[0] < 0).length, rightX = nodes.filter((n) => n[0] > 0).length;
  const leftZ = nodes.filter((n) => n[2] < 0).length, rightZ = nodes.filter((n) => n[2] > 0).length;

  const topCells = new Set<string>();
  const sideCells = new Set<string>();
  const materials = new Set<string>();
  for (const [x, y, z, name] of nodes) {
    topCells.add(`${x},${z}`);
    sideCells.add(`${x},${y}`);
    materials.add(name);
  }

  return {
    check: {
      parts: Array.isArray(parts) ? parts.length : 0,
      blocks: c.blocks,
      size: c.size,
      symmetry: { x: [leftX, rightX], z: [leftZ, rightZ] },
      groundGap: minY,
      layers: new Set(ys).size,
      notes: c.notes,
    },
    top: grid(topCells, minX, maxX, minZ, maxZ, false),
    side: grid(sideCells, minX, maxX, minY, maxY, true),
    legend: [...materials].slice(0, 6),
  };
}

/** One line a writer (and the owner) can read: what the parts measurably are. */
export function checkLine(c: SketchCheck): string {
  const [lx, rx] = c.symmetry.x;
  const [lz, rz] = c.symmetry.z;
  const sym = lx === rx ? `symmetric ${lx}/${rx}` : `asymmetric x ${lx}/${rx}`;
  const symZ = lz === rz ? "symmetric z" : `asymmetric z ${lz}/${rz}`;
  const ground = c.groundGap === 0 ? "stands on the ground" : `floats ${c.groundGap} above the ground`;
  return `${c.parts} parts, ${c.blocks} blocks, ${c.size[0]}x${c.size[1]}x${c.size[2]}, ${sym}, ${symZ}, ${ground}, ${c.layers} height levels${c.notes.length ? `, ${c.notes.length} notes` : ""}`;
}

/** The drawings as text, for a prompt or a card. */
export function sketchText(s: Sketch): string {
  return [`seen from above (x right, z down):`, ...s.top.map((r) => `  ${r}`), `seen from the side (x right, y up):`, ...s.side.map((r) => `  ${r}`)].join("\n");
}