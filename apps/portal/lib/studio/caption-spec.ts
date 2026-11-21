/**
 * Caption geometry, as data.
 *
 * The burn-in used to carry one font size and no margins, which is how a 1920-wide number ends up on a
 * portrait frame, and why a caption can sit under a platform's own overlay. The numbers below are the
 * measured ones from the flat-vector reference: 36-44 px for a wide face and 54-58 px for a narrow one,
 * a 4 px outline, a 3 px shadow, 90 px of side margin and 74 px off the bottom — all at 1920x1080.
 *
 * Every value here scales by frame height, and the margins are floored at the template's safe area, so
 * the same spec is correct for a 1080x1920 short and a 1920x1080 long video. A template should read this
 * instead of deriving sizes from the font it happens to get.
 */

export const CAPTION_REFERENCE_FRAME = { width: 1920, height: 1080 } as const;

/** Comfortable burn-in size at the reference frame, per face width. */
export const WIDE_FACE_PX: [number, number] = [36, 44];
export const NARROW_FACE_PX: [number, number] = [54, 58];
export const REFERENCE_OUTLINE_PX = 4;
export const REFERENCE_SHADOW_PX = 3;
export const REFERENCE_MARGIN_X_PX = 90;
export const REFERENCE_MARGIN_BOTTOM_PX = 74;
export const DEFAULT_SAFE_AREA_PCT = 8;
/** Below this an outline stops reading as an outline on a phone. */
export const MIN_OUTLINE_PX = 2;
/** The worker draws card text at a third of the size as line spacing; captions follow it. */
export const LINE_SPACING_RATIO = 1 / 3;

export interface CaptionSpec {
  /** Font to burn with. Null means the library has none, and the worker then skips captions. */
  fontAssetId: string | null;
  /** Chosen size: the top of the measured range, because a small caption earns a second complaint. */
  fontSizePx: number;
  minFontSizePx: number;
  maxFontSizePx: number;
  lineSpacingPx: number;
  outlinePx: number;
  shadowPx: number;
  marginXPx: number;
  marginBottomPx: number;
  /** Width the words may use before they have to wrap. */
  maxWidthPx: number;
  /** True when the face is narrow, which needs the larger sizes. */
  narrowFace: boolean;
  safeAreaPct: number;
}

export interface CaptionSpecInput {
  width: number;
  height: number;
  fontAssetId?: string | null;
  /** A narrow face (handwriting, condensed) needs the larger range. */
  narrowFace?: boolean;
  /** Percentage of each axis the platform's own overlay may cover. */
  safeAreaPct?: number;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export function captionSpecFor(input: CaptionSpecInput): CaptionSpec {
  const width = Math.max(1, Math.round(input.width));
  const height = Math.max(1, Math.round(input.height));
  const narrowFace = input.narrowFace === true;
  const safeAreaPct = input.safeAreaPct ?? DEFAULT_SAFE_AREA_PCT;
  const scale = height / CAPTION_REFERENCE_FRAME.height;
  const [minFace, maxFace] = narrowFace ? NARROW_FACE_PX : WIDE_FACE_PX;
  const maxFontSizePx = even(maxFace * scale);
  const minFontSizePx = Math.min(even(minFace * scale), maxFontSizePx);
  const safeMargin = (axis: number) => Math.round((axis * safeAreaPct) / 100);
  // The sides follow the measured ratio, so the caption keeps the reference's line length in any frame. The
  // bottom takes whichever is larger: that strip is where a platform puts its own controls.
  const marginXPx = Math.round((REFERENCE_MARGIN_X_PX * width) / CAPTION_REFERENCE_FRAME.width);
  const marginBottomPx = Math.max(Math.round(REFERENCE_MARGIN_BOTTOM_PX * scale), safeMargin(height));
  return {
    fontAssetId: input.fontAssetId ?? null,
    // The top of the range: the reference's own comfortable band already sits well inside the frame.
    fontSizePx: maxFontSizePx,
    minFontSizePx,
    maxFontSizePx,
    lineSpacingPx: Math.max(2, Math.round(maxFontSizePx * LINE_SPACING_RATIO)),
    outlinePx: Math.max(MIN_OUTLINE_PX, Math.round(REFERENCE_OUTLINE_PX * scale)),
    shadowPx: Math.max(1, Math.round(REFERENCE_SHADOW_PX * scale)),
    marginXPx,
    marginBottomPx,
    maxWidthPx: Math.max(0, width - 2 * marginXPx),
    narrowFace,
    safeAreaPct,
  };
}

/** A spec is unusable when the words have nowhere to go. */
export function captionSpecIssues(spec: CaptionSpec, frame: { width: number; height: number }, opts: { required?: boolean } = {}): string[] {
  const issues: string[] = [];
  const above = frame.height - spec.marginBottomPx;
  const twoLines = spec.fontSizePx * 2 + spec.lineSpacingPx;
  if (twoLines > above) {
    issues.push(`Two lines of ${spec.fontSizePx} px captions need ${twoLines} px, but only ${above} px sits above the ${spec.marginBottomPx} px bottom margin`);
  }
  if (spec.maxWidthPx < spec.fontSizePx * 4) {
    issues.push(`The side margins leave ${spec.maxWidthPx} px for words, too little for ${spec.fontSizePx} px text`);
  }
  if (spec.outlinePx * 2 >= spec.fontSizePx) issues.push(`A ${spec.outlinePx} px outline swallows ${spec.fontSizePx} px text`);
  if (opts.required && !spec.fontAssetId) issues.push("Captions are required, but the library has no font to burn them with");
  return issues;
}
