// build_render_prompt composer — turns structured room data into a detailed
// architectural-visualization prompt. This is the "secret sauce": it bakes in
// photography conventions that make renders look like real listing photos.

export interface Material {
  name: string
  location?: string
}

export interface Dimensions {
  lengthFt?: number
  widthFt?: number
  ceilingHeightFt?: number
}

export interface BuildPromptInput {
  roomType: string
  dimensions?: Dimensions
  materials?: Material[]
  fixtures?: string[]
  styleDirection?: string
  cameraAngle?: string
  lighting?: string
}

const ROOM_LABELS: Record<string, string> = {
  bathroom: "master bathroom",
  kitchen: "kitchen remodel",
  basement: "finished basement",
  bedroom: "bedroom",
  living_room: "living room",
  livingroom: "living room",
  exterior: "home exterior",
  office: "home office",
  laundry: "laundry room",
  mudroom: "mudroom",
}

function humanizeRoom(roomType: string): string {
  const key = roomType.trim().toLowerCase().replace(/\s+/g, "_")
  return ROOM_LABELS[key] ?? roomType.trim().toLowerCase().replace(/_/g, " ")
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s
}

function buildDimensionsClause(d?: Dimensions): string {
  if (!d) return ""
  const ceiling = d.ceilingHeightFt ?? 9
  if (d.lengthFt && d.widthFt) {
    return `The room is approximately ${d.lengthFt} ft by ${d.widthFt} ft with ${ceiling} ft ceilings.`
  }
  if (d.ceilingHeightFt) {
    return `The room has ${ceiling} ft ceilings.`
  }
  return ""
}

function buildMaterialsClause(materials?: Material[]): string {
  if (!materials?.length) return ""
  const parts = materials.map((m) =>
    m.location ? `${capitalize(m.location)}: ${m.name}` : m.name,
  )
  return `Finishes — ${parts.join("; ")}.`
}

/**
 * Style-preset preambles. These get prepended to every render prompt so the
 * baseline output looks like architectural photography, not generic CGI. The
 * room preset captures preferences observed from side-by-side comparisons with
 * higher-quality renders (soft realistic light, lived-in staging, magazine color
 * grading). Tune these to your own taste; they are the biggest quality lever.
 *
 * Lighting language must never mention windows or daylight: the model adds
 * windows to justify it (verified 2026-10-20 — "daylight pouring through the
 * windows" put three new windows into a windowless basement). Light comes from
 * the scene's EXISTING sources only.
 */
export const STYLE_PREAMBLES: Record<string, string> = {
  room: [
    "PHOTOGRAPHY STYLE — render as if it's a photograph for a high-end residential remodel magazine.",
    "- Lighting: soft, bright, realistic light from the light sources that already exist in the scene — its own openings if it has any, otherwise its ceiling lights, recessed cans, sconces, pendants, and lamps. Realistic ambient occlusion, high dynamic range, warm inviting tones on surfaces. Never add a light source or opening to brighten the room.",
    "- Composition: 24mm wide-angle lens, eye-level perspective, sharp focus throughout, clean horizons.",
    "- Staging: lived-in but tasteful — minimal decor such as a plant, a basket, or a folded towel, only where it fits. Never sterile, never cluttered, no people.",
    "- Materials: accurate textures with honest reflections; subtle imperfections and patina; real wood grain; natural stone variation; visible weave on fabrics.",
    "- Color: warm neutral palette, clean white balance, no oversaturation, no plasticky CGI sheen.",
    "- Avoid: contrived perfection, video-game gloss, flat fluorescent lighting, dead static air.",
  ].join("\n"),
  natural: [
    "Photorealistic architectural interior photograph.",
    "Soft, realistic light from the scene's existing light sources; realistic shadows and ambient occlusion; sharp focus.",
    "Lived-in but tasteful staging; accurate materials and textures.",
    "Magazine-quality color grading; no CGI sheen.",
  ].join("\n"),
  // Everything that ISN'T a room render: social posts, flyers, signage mockups,
  // team graphics, product shots, illustrations. No room/staging assumptions.
  general: [
    "Follow the instruction below exactly — it defines the subject, style, and composition.",
    "- If the instruction asks for text in the image, render it legibly and spell it exactly as given. Otherwise include no text.",
    "- Clean, professional finish. No watermarks, no stock-photo artifacts, no distorted hands or faces.",
    "- No real-world brand logos or trademarks (vehicles, tools, products) unless the instruction asks for them.",
    "- If reference images are provided, use them the way the instruction describes (edit them, place them, or match their look).",
  ].join("\n"),
  raw: "",
}

export type StylePreset = "room" | "natural" | "general" | "raw"

// Users (and Claude) naturally write "natural light" / "daylight"; with a structural
// reference the model reads that as "add a window". Leave their words alone, but
// pin down what they mean right after them.
// Stems match "natural lighting", "daylit"...; whole words only for "sunny"/"airy" (not "dairy").
const WINDOW_LIGHT_WORDS = /\b(natural[\s-]*light|day[\s-]*li[gt]|sun[\s-]*light|sunlit|sun-drenched|golden[\s-]*hour|light[\s-]*filled)|\b(sunny|airy)\b/i
const WINDOW_LIGHT_NOTE =
  "LIGHTING NOTE: any mention above of natural light, daylight, sunlight, or a bright and airy feel means clean, bright, realistic light from the room's EXISTING windows and fixtures only. It never means adding a window, skylight, or sunbeam from an opening that isn't in the structural reference."

/**
 * Wraps a user prompt with strong instructions to preserve the reference image's
 * geometry, perspective, and fixture positions while only changing materials and
 * finishes. Used when a reference image is provided in structural mode (the
 * default for generate_render_interactive). Nano Banana otherwise treats
 * references as loose style inspiration and invents new room layouts.
 */
export function buildStructurePreamble(
  userInstruction: string,
  opts?: { hasStyleRef?: boolean; hasProductRef?: boolean },
): string {
  const refRoleClause = opts?.hasStyleRef
    ? "REFERENCE IMAGE ROLES: Image 1 (the first reference) is the STRUCTURAL GROUND TRUTH for THIS room — every geometric decision comes from it. Any ADDITIONAL reference images are STYLE ANCHORS — borrow ONLY their lighting quality, color grading, material treatment, and photographic mood. NEVER copy fixtures, layout, room shape, camera angle, or any geometry from style-anchor images."
    : "The reference image is your STRUCTURAL GROUND TRUTH for THIS room. It may be a SketchUp model, line drawing, unfinished construction photo, or rough sketch — treat every geometric element as final."
  // Product refs (from the job's selections) name exact items to install. They are
  // not rooms — keep them out of the geometry rules, but let them replace the
  // matching item in place.
  const productClause = opts?.hasProductRef
    ? "PRODUCT REFERENCES (images labeled PRODUCT REFERENCE) show the exact products or materials selected for this job. They are NOT the room — never copy their background or framing. Where the user instruction says to use one, replace the matching item in the room with that exact product — same design, shape, finish, and color — in the same position, at a realistic scale. Everything else stays as described below."
    : ""

  return [
    "You are rendering a photorealistic AFTER photo of the SAME room shown in the structural reference.",
    "",
    refRoleClause,
    "",
    ...(productClause ? [productClause, ""] : []),
    "STRUCTURAL FIDELITY IS NON-NEGOTIABLE.",
    "Preserve EXACTLY, to the inch, from the structural reference:",
    "- Room geometry, dimensions, ceiling height, all wall positions and angles.",
    "- Camera viewing angle, framing, perspective lines, vanishing points.",
    "- The position, size, and shape of every wall, window, door, ceiling, and floor.",
    "- The position, size, count, and shape of every fixture (tub, shower, vanity, sink, toilet, mirror, light fixture, outlet, switch, shelf, hook).",
    "- The lighting direction and time of day implied by the structural reference.",
    "Do NOT carry over modeling-software artifacts: no axis/orientation markers, grid lines, UI overlays, watermarks, or section cuts — the output is a photograph.",
    "",
    "Even a 5-degree camera shift, a window moved 6 inches, a vanity that grew an extra drawer, or a fixture that drifted to a new position counts as a structural failure. If the user instruction does not explicitly tell you to change a specific element, that element stays exactly where it is and looks exactly as it does in the structural reference.",
    "",
    "DO NOT ADD ANY WINDOWS. Never invent windows, skylights, glass doors, or any other opening that does not exist in the structural reference — a solid wall stays a solid wall. This is the most common failure mode and it is never acceptable. Lighting words never justify one: no new windows, no window-shaped patches of sunlight on walls or floors, no windows reflected in screens, glass, or mirrors, and no greenery or sky that implies an opening that isn't there.",
    "",
    "VIEWS THROUGH OPENINGS: whatever is visible through doorways, cased openings, pass-throughs, and existing windows must match the structural reference exactly. If the reference shows a blank wall through an opening, it stays a blank wall — never invent a window, an outdoor view, or a new room beyond an opening.",
    "",
    "COLORS: Keep colors similar to what's shown in the structural reference. Your job is to enhance realism, not to recolor the room. Only change a color when the user instruction below explicitly asks for that specific change.",
    "",
    "CHANGE only what the user instruction below describes — and ONLY those changes:",
    "- Finishes, materials, colors, and textures.",
    "- Surface treatments (tile pattern, paint color, flooring species, countertop material).",
    "- Decorative styling and hardware finish (brushed nickel vs. matte black, etc.).",
    "- Lighting quality and atmosphere (warm/cool, day/dusk) — but NOT the lighting direction.",
    "",
    "The output must be the SAME room from the SAME camera angle, photorealistically completed. If you cannot preserve the structure exactly while making the requested changes, prefer preserving the structure.",
    "",
    `User instruction: ${userInstruction}`,
    ...(WINDOW_LIGHT_WORDS.test(userInstruction) ? ["", WINDOW_LIGHT_NOTE] : []),
  ].join("\n")
}

export function buildRenderPrompt(input: BuildPromptInput): string {
  const style = (input.styleDirection ?? "modern").trim()
  const room = humanizeRoom(input.roomType)
  const camera = input.cameraAngle ?? "wide shot from the doorway"
  const lighting = input.lighting ?? "bright, even, realistic lighting"

  const fixturesClause = input.fixtures?.length
    ? `Fixtures and features: ${input.fixtures.join(", ")}.`
    : ""

  const lines = [
    `Photorealistic architectural interior photograph of a ${style} ${room}.`,
    buildDimensionsClause(input.dimensions),
    buildMaterialsClause(input.materials),
    fixturesClause,
    `${capitalize(camera)}, shot with a 24mm wide-angle lens.`,
    `Lighting: ${lighting}.`,
    `Professional real estate photography, high dynamic range, sharp focus throughout, ` +
      `realistic materials and reflections, accurate scale and proportions, ` +
      `styled with minimal tasteful decor. No people, no text, no watermarks.`,
  ].filter((line) => line.length > 0)

  return lines.join("\n")
}
