import { McpAgent } from "agents/mcp"
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import "./types"
import { generateWithImagen } from "./lib/imagen"
import { generateWithNanoBanana } from "./lib/nano-banana"
import { buildRenderPrompt, buildStructurePreamble, STYLE_PREAMBLES } from "./lib/prompts"
import { friendlyGoogleError, type GeneratedImage } from "./lib/google"
import { RENDER_WIDGET_HTML, RENDER_WIDGET_URI, UI_MIME, widgetCsp } from "./lib/render-widget"
import {
  fileRenderOnJob,
  findJobs,
  friendlyJobTreadError,
  getJob,
  jobTreadConfig,
  listJobSelectionImages,
  listOpenJobs,
  jobFilesUrl,
  localDate,
} from "./lib/jobtread"

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] })

function shortId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16)
}

// Per-image cost estimate (USD). flash flat; pro depends on output size (4K costs more).
function perImageCostUsd(model: "flash" | "pro", imageSize?: string): number {
  if (model === "flash") return 0.039
  return imageSize === "4K" ? 0.24 : 0.134
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

// Fetch a public image URL and convert to base64 for Gemini. Used by the
// reference_image_urls path so callers can hand the Worker a URL instead of
// shipping megabytes of base64 through the chat transport.
async function fetchImageAsRef(url: string): Promise<{ data: string; mimeType: string }> {
  const res = await fetch(url, { method: "GET" })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const mimeType = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0].trim()
  if (!mimeType.startsWith("image/")) throw new Error(`expected image, got ${mimeType}`)
  const buf = await res.arrayBuffer()
  // Use Buffer (nodejs_compat is on) — reliable for any size, no spread limits.
  const data = Buffer.from(buf).toString("base64")
  return { data, mimeType }
}

// The widget can legitimately send ~700 KB base64 (its own renders before refine).
// The chat transport itself caps tool args ~3 KB, so anything bigger over chat
// won't even reach us. Cap acts as a sanity guard for inline payloads, not a
// transport limit. Widget should prefer reference_image_urls for prior renders;
// this cap is the fallback safety net.
const MAX_INLINE_REF_B64_CHARS = 1_000_000
// Floor: Gemini rejects sub-thumbnail images ("unable to process input image").
// Bounce truly tiny inline refs with a clear error instead. Kept low: the area
// editor's crops of plain walls compress small, and 100px product images were
// verified to work (2026-10-14).
const MIN_INLINE_REF_B64_CHARS = 8_000
// Selection images under this size are the ~100px supplier thumbnails some
// budget lines carry — usable as a hint, too small for exact detail.
const LOW_RES_KB = 8

// Public origin for every stored-image URL (/img/...). Comes from the
// PUBLIC_ORIGIN var in wrangler.jsonc and is set once in init(). Use a custom
// domain: claude.ai's analysis sandbox is blocked by Cloudflare's default bot
// protection on workers.dev, and JobTread must be able to fetch these URLs.
let WORKER_ORIGIN = ""
// Whether the JobTread features are on (JOBTREAD_GRANT_KEY set). Set in init().
let JOBTREAD_ENABLED = false

function normalizeOrigin(o: string | undefined): string {
  return (o ?? "").trim().replace(/\/+$/, "")
}

function detectImageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png"
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "image/webp"
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif"
  return null
}

/**
 * When a stored image was made. Metadata edits (labels, JobTread saves) re-put the
 * R2 object, which resets `uploaded` — so prefer the original created_at.
 */
function createdTime(o: R2Object): Date {
  const t = Date.parse(o.customMetadata?.created_at ?? "")
  return Number.isNaN(t) ? o.uploaded : new Date(t)
}

function archivedUrl(filename: string): string {
  return `${WORKER_ORIGIN}/img/${filename}`
}

/**
 * Trailing text block listing the archived render URLs. Lives in `content` (not
 * just structuredContent) so Claude can read it in chat and pass a URL back as
 * reference_image_urls when the user asks for a follow-up edit ("make the tile
 * darker"). Kept as its own block — the widget only shows the first text block.
 */
function followUpBlock(filenames: (string | null)[]) {
  const urls = filenames.filter((f): f is string => !!f).map(archivedUrl)
  if (urls.length === 0) return []
  return [
    {
      type: "text" as const,
      text:
        "Render URL(s) — for a follow-up edit to one of these, call generate_render_interactive with it as reference_image_urls." +
        (JOBTREAD_ENABLED ? " To file one on a JobTread job, use find_job then save_render_to_job." : "") +
        "\n" +
        urls.map((u, i) => `${i + 1}. ${u}`).join("\n"),
    },
  ]
}

export class NanoBananaMCP extends McpAgent<Env, Record<string, never>, Record<string, never>> {
  server = new McpServer({ name: "nano-banana", version: "0.1.0" })

  private apiKey(): string | null {
    return this.env.GEMINI_API_KEY || null
  }

  /**
   * Every object under a prefix, with metadata. R2 returns keys in lexical (not
   * date) order and can truncate a page early when metadata is included, so a
   * single list() call misses objects — follow the cursor to the end.
   */
  private async listAll(prefix: string): Promise<R2Object[]> {
    const out: R2Object[] = []
    let cursor: string | undefined
    for (let page = 0; page < 50; page++) {
      const listed = await this.env.UPLOADS.list({
        prefix,
        cursor,
        include: ["httpMetadata", "customMetadata"],
      })
      out.push(...listed.objects)
      if (!listed.truncated) break
      cursor = listed.cursor
    }
    return out
  }

  /**
   * The newest renders with metadata, without reading the whole library's
   * metadata (that took 7-8 s at ~a few hundred renders and kept growing). Keys
   * alone list fast; metadata comes from head() on only the newest candidates.
   * `uploaded` resets when metadata is re-put (labels, JobTread saves), so take a
   * cushion of candidates and order the final set by created_at.
   */
  private async recentRenders(want: number, matches?: (o: R2Object) => boolean): Promise<R2Object[]> {
    const keys: R2Object[] = []
    let cursor: string | undefined
    for (let page = 0; page < 50; page++) {
      const listed = await this.env.UPLOADS.list({ prefix: "renders/", cursor, limit: 1000 })
      keys.push(...listed.objects)
      if (!listed.truncated) break
      cursor = listed.cursor
    }
    keys.sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime())
    // Filtered lookups scan deeper (a job's renders may be older); stop once enough match.
    const scanCap = Math.min(keys.length, matches ? 600 : Math.max(want * 3, 30))
    const out: R2Object[] = []
    for (let i = 0; i < scanCap; i += 50) {
      const heads = await Promise.all(
        keys.slice(i, Math.min(i + 50, scanCap)).map((k) => this.env.UPLOADS.head(k.key)),
      )
      for (const h of heads) if (h && (!matches || matches(h))) out.push(h)
      if (matches && out.length >= want) break
    }
    return out.sort((a, b) => createdTime(b).getTime() - createdTime(a).getTime()).slice(0, want)
  }

  /**
   * Archive renders to R2 (the growing library). Returns one filename per image,
   * index-aligned with `images` — null where that write failed (tolerated; a
   * failed archive never fails the response).
   */
  private async archiveRenders(
    images: GeneratedImage[],
    meta: Record<string, string>,
  ): Promise<(string | null)[]> {
    const results = await Promise.allSettled(
      images.map(async (im) => {
        const filename = `${shortId()}.${im.mimeType.includes("png") ? "png" : "jpg"}`
        await this.env.UPLOADS.put(`renders/${filename}`, base64ToBytes(im.base64), {
          httpMetadata: { contentType: im.mimeType },
          customMetadata: { created_at: new Date().toISOString(), label: "", ...meta },
        })
        return filename
      }),
    )
    return results.map((r) => (r.status === "fulfilled" ? r.value : null))
  }

  async init() {
    WORKER_ORIGIN = normalizeOrigin(this.env.PUBLIC_ORIGIN)
    if (!WORKER_ORIGIN) console.warn("PUBLIC_ORIGIN is not set — stored image URLs will be broken. See SETUP.md.")
    const jtEnabled = !!this.env.JOBTREAD_GRANT_KEY
    JOBTREAD_ENABLED = jtEnabled
    const jtCfg = jobTreadConfig(this.env as unknown as Record<string, unknown>)
    const csp = widgetCsp(WORKER_ORIGIN, jtEnabled)

    // -------- MCP Apps UI resource (interactive render widget) --------
    // Inject the origin, the JobTread on/off flag, and the upload token (so the
    // widget's own uploads clear the /upload gate). The HTML only travels over
    // the (gated) MCP connection.
    const widgetHtml = RENDER_WIDGET_HTML.replace("__UPLOAD_TOKEN__", this.env.UPLOAD_TOKEN ?? "")
      .replace("__WORKER_ORIGIN__", WORKER_ORIGIN)
      .replace("__JOBTREAD_ENABLED__", jtEnabled ? "true" : "false")
    const widgetContents = (uri: URL) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: UI_MIME,
          text: widgetHtml,
          _meta: { ui: { csp } },
        },
      ],
    })
    this.server.registerResource(
      "render-widget",
      RENDER_WIDGET_URI,
      { mimeType: UI_MIME, _meta: { ui: { csp } } },
      async (uri) => widgetContents(uri),
    )
    // claude.ai caches a connector's tool list, so after a widget-URI bump a chat
    // can still ask for an older viewer-vNN. Answer every version with the
    // current widget instead of "not found" ("problem displaying content").
    // Unlisted, so only RENDER_WIDGET_URI shows in resources/list.
    this.server.registerResource(
      "render-widget-legacy",
      new ResourceTemplate("ui://nano-banana/viewer-{version}.html", { list: undefined }),
      { mimeType: UI_MIME, _meta: { ui: { csp } } },
      async (uri) => widgetContents(uri),
    )

    // -------- generate_render (Imagen 4, one-shot) --------
    this.server.tool(
      "generate_render",
      "Generate photorealistic images from a text prompt using Google Imagen 4. Best for one-shot room renders, material visualizations, and design concepts. Returns the generated image(s) inline. Tip: call build_render_prompt first to compose a strong prompt.",
      {
        prompt: z
          .string()
          .describe(
            "Detailed description of the image. Be specific about materials, lighting, camera angle, and style. Max ~480 tokens. English only.",
          ),
        num_images: z
          .number()
          .int()
          .min(1)
          .max(4)
          .optional()
          .default(2)
          .describe("Number of image variations to generate (1-4). Default 2."),
        aspect_ratio: z
          .enum(["1:1", "3:4", "4:3", "9:16", "16:9"])
          .optional()
          .default("16:9")
          .describe("Image aspect ratio. Default '16:9' for room renders."),
        quality: z
          .enum(["fast", "standard", "ultra"])
          .optional()
          .default("standard")
          .describe("Quality tier: 'fast' ($0.02/img), 'standard' ($0.04/img), 'ultra' ($0.06/img)."),
      },
      async ({ prompt, num_images, aspect_ratio, quality }) => {
        const key = this.apiKey()
        if (!key) return text("GEMINI_API_KEY is not set. Run: npx wrangler secret put GEMINI_API_KEY")
        try {
          const images = await generateWithImagen(key, {
            prompt,
            numImages: num_images,
            aspectRatio: aspect_ratio,
            quality,
          })
          if (images.length === 0) {
            return text("Imagen returned no images. Try rephrasing the prompt or a different quality tier.")
          }
          const archived = await this.archiveRenders(images, {
            source: "generate_render",
            prompt: prompt.slice(0, 500),
            model: `imagen-${quality}`,
          })
          return {
            content: [
              {
                type: "text" as const,
                text: `Generated ${images.length} image(s) with Imagen 4 (${quality}, ${aspect_ratio}).`,
              },
              ...images.map((img) => ({ type: "image" as const, data: img.base64, mimeType: img.mimeType })),
              ...followUpBlock(archived),
            ],
          }
        } catch (e) {
          return text(friendlyGoogleError(e))
        }
      },
    )

    // -------- generate_render_interactive (Nano Banana, reference images + editing) --------
    this.server.registerTool(
      "generate_render_interactive",
      {
        title: "Generate / edit render (interactive)",
        description:
          "Generate or edit photorealistic images using Gemini's conversational image generation (Nano Banana). Supports multiple reference images for style/structure matching and iterative editing instructions.\n\n" +
          "**WHEN THE USER ATTACHES AN IMAGE IN CHAT and asks for a render: DO NOT call this tool directly. Call `propose_render` instead** — it opens the interactive widget with your prompt pre-filled, and the user uploads their reference inside the widget with one click. Image bytes cannot reliably flow from a chat attachment to this tool: the chat transport caps tool arguments at ~3 KB, and the code tool's outbound HTTP is blocked by the Anthropic sandbox.\n\n" +
          "Call this tool directly only when:\n" +
          "- You have public reference URLs already (pass as `reference_image_urls`).\n" +
          "- You're doing text-to-image with no reference (pure prompt).\n" +
          "- The user wants a FOLLOW-UP EDIT to an image already made in this chat (see below).\n" +
          "- You're being called from the interactive widget itself (refine/regenerate).\n\n" +
          "**FOLLOW-UP EDITS** ('make the tile darker', 'swap to brass', 'change the headline'): every result ends with a 'Render URL(s)' list. Pass the URL of the image being edited as `reference_image_urls: [url]`, write the prompt as just the change, and set `style_preset` to 'raw' for room renders or 'general' for general images. Default to the most recent image unless the user points at another. For images from earlier conversations, find the URL with `list_renders`.\n\n" +
          (jtEnabled
            ? "**JOB SELECTIONS AS PRODUCTS** ('use the cabinet pull we selected', 'put the Kohler faucet in'): call list_job_selections for the job, pass the chosen image URL(s) as `product_reference_urls`, and say in the prompt where each product goes. Combine with reference_image_urls to change an existing render.\n\n"
            : "**PRODUCT IMAGES** ('use this faucet'): pass public product image URL(s) as `product_reference_urls` and say in the prompt where each product goes.\n\n") +
          "**PICK THE STYLE PRESET:** 'room' (default) is for remodel/room renders only — it adds magazine-photo staging and room-geometry rules. For ANYTHING ELSE — social posts, flyers, yard-sign or truck-wrap mockups, hiring/team graphics, product shots, illustrations, headshot cleanups, fun images — use 'general'. Prefer model 'pro' when the image must contain readable text.",
        inputSchema: {
          prompt: z.string().describe("Text description or editing instruction for the image."),
          reference_images: z
            .array(
              z.object({
                data: z.string().describe("Base64-encoded image data (no data: prefix)."),
                mime_type: z.string().optional().default("image/png"),
              }),
            )
            .max(14)
            .optional()
            .describe("Optional base64 reference images for style/content guidance. Up to 14."),
          model: z
            .enum(["flash", "pro"])
            .optional()
            .default("flash")
            .describe("'flash' for speed/cost (~$0.04/img), 'pro' for max quality (~$0.13/img, up to $0.24 at 4K)."),
          aspect_ratio: z
            .string()
            .optional()
            .describe("Optional aspect ratio, e.g. '16:9', '4:3', '1:1'."),
          image_size: z
            .enum(["512", "1K", "2K", "4K"])
            .optional()
            .describe("Optional output size. '512' is flash-only; '4K' is pro and costs more."),
          reference_mode: z
            .enum(["structure", "style"])
            .optional()
            .default("structure")
            .describe(
              "How to use reference images for ROOM renders. 'structure' (default): preserve the reference's geometry, perspective, camera angle, and fixture positions; change only finishes/materials/styling per the prompt. Use this for SketchUp renders, line drawings, or existing-condition photos. 'style': use the reference loosely as style inspiration only (the model may invent a new layout). Ignored when style_preset is 'general' — there the prompt alone says how to use the references.",
            ),
          batch_count: z
            .number()
            .int()
            .min(1)
            .max(6)
            .optional()
            .default(1)
            .describe(
              "Number of independent variations to generate from the same prompt + reference, in parallel. Useful for showing a client multiple finish options on the same geometry. Costs scale linearly (6 pro renders ≈ $0.80; 6 flash ≈ $0.24).",
            ),
          style_preset: z
            .enum(["room", "natural", "general", "raw"])
            .optional()
            .default("room")
            .describe(
              "Baseline preamble prepended to the prompt. 'room' (default): ROOM RENDERS ONLY — high-end residential remodel magazine, soft realistic light from the room's existing sources, lived-in staging, no CGI sheen. 'natural': generic photoreal interior preamble. 'general': anything that isn't a room render (marketing graphics, flyers, signage mockups, product shots, illustrations) — no room assumptions, legible text when asked. 'raw': no preamble; use for follow-up edits of a room render.",
            ),
          reference_image_urls: z
            .array(z.string().url())
            .max(4)
            .optional()
            .describe(
              "STRUCTURAL reference URLs. These define the room's geometry and camera angle — the model must preserve everything in them. Up to 4 (typically 1).",
            ),
          style_reference_urls: z
            .array(z.string().url())
            .max(3)
            .optional()
            .describe(
              "STYLE-ANCHOR reference URLs (separate from structural). The model borrows lighting, color grading, material treatment, and mood from these — NOT geometry. Use this when you have a known-good past render whose aesthetic you want to anchor a new render to. Up to 3.",
            ),
          product_reference_urls: z
            .array(z.string().url())
            .max(4)
            .optional()
            .describe(
              "PRODUCT reference URLs — exact products/materials to install (a cabinet pull, faucet, tile). Any public product image URL works; with JobTread connected, list_job_selections returns the job's selected products. The prompt should say where each goes, e.g. 'install the cabinet pull from product reference 1 on every drawer'. Up to 4.",
            ),
          thinking_level: z
            .enum(["off", "low", "high"])
            .optional()
            .describe(
              "Pro-only reasoning budget. Defaults to 'high' when model is 'pro', 'off' for flash. 'high' gives the model more room to reason about geometry/finish fidelity.",
            ),
          variation_axes: z
            .string()
            .optional()
            .describe(
              "When batch_count > 1, what should vary between variations, e.g. 'backsplash tile and hardware finish'. Each variation gets a distinct-design instruction appended.",
            ),
          job_tag: z
            .string()
            .max(80)
            .optional()
            .describe(
              "Optional job/project tag, e.g. 'smith-kitchen' or a job number. Stored with the render so it can be found later with list_renders.",
            ),
          job_id: z
            .string()
            .max(40)
            .optional()
            .describe("Optional JobTread job ID (from find_job). Stored with the render so list_renders can filter by the real job."),
          skip_archive: z
            .boolean()
            .optional()
            .default(false)
            .describe("Widget-internal: don't store the result in the render library (the area editor stores its stitched-back final image with store_edited_render instead). Leave false from chat."),
        },
        _meta: {
          ui: { resourceUri: RENDER_WIDGET_URI },
          "ui/resourceUri": RENDER_WIDGET_URI,
        },
      },
      async ({ prompt, reference_images, reference_image_urls, style_reference_urls, product_reference_urls, model, aspect_ratio, image_size, reference_mode, batch_count, style_preset, thinking_level, variation_axes, job_tag, job_id, skip_archive }) => {
        const key = this.apiKey()
        if (!key) return text("GEMINI_API_KEY is not set. Run: npx wrangler secret put GEMINI_API_KEY")

        // Light call-shape log — useful for "what did Claude send" if anything misbehaves.
        console.log(
          `generate_render_interactive: inline_refs=${reference_images?.length ?? 0}, ` +
            `url_refs=${reference_image_urls?.length ?? 0}, style_refs=${style_reference_urls?.length ?? 0}, product_refs=${product_reference_urls?.length ?? 0}, ` +
            `model=${model}, inline_sizes=[${(reference_images ?? []).map((r) => r.data?.length ?? 0).join(",")}], ` +
            `urls=[${(reference_image_urls ?? []).join(",")}], styles=[${(style_reference_urls ?? []).join(",")}]`,
        )

        // Guard against oversized OR too-small inline references. Both make Gemini fail.
        const sizes = (reference_images ?? []).map((r) => r.data?.length ?? 0)
        const oversized = sizes.filter((n) => n > MAX_INLINE_REF_B64_CHARS)
        const undersized = sizes.filter((n) => n > 0 && n < MIN_INLINE_REF_B64_CHARS)
        if (undersized.length > 0 || oversized.length > 0) {
          const note =
            undersized.length > 0
              ? "Inline reference is too small — Gemini rejects sub-thumbnail images as 'unable to process'."
              : "Inline reference is too large — the chat transport corrupts long tool arguments."
          return text(
            `${note}\n\n` +
              "Inline reference_images shouldn't be used for user-attached chat images. Use the `propose_render` tool instead — it opens the interactive widget with your prompt pre-filled and the user uploads the reference there in one click (the widget handles bytes natively, bypassing both the chat transport size cap and the sandbox HTTP block).",
          )
        }

        const batch = Math.min(Math.max(batch_count ?? 1, 1), 6)

        // Fetch URL-based references server-side. Structural URLs first (these
        // are "image 1, 2, ..."), then style anchors (these get the role of
        // aesthetic-only refs in the preamble).
        const fetchErrors: string[] = []
        async function fetchList(urls: string[] | undefined) {
          if (!urls?.length) return [] as { data: string; mimeType: string }[]
          const out: { data: string; mimeType: string }[] = []
          const results = await Promise.allSettled(urls.map((u) => fetchImageAsRef(u)))
          for (let i = 0; i < results.length; i++) {
            const r = results[i]
            if (r.status === "fulfilled") out.push(r.value)
            else
              fetchErrors.push(
                `Could not fetch ${urls[i]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
              )
          }
          return out
        }
        const fetchedStructural = await fetchList(reference_image_urls)
        const fetchedStyle = await fetchList(style_reference_urls)
        const productRefs = await fetchList(product_reference_urls)

        const inlineRefs = reference_images?.map((r) => ({ data: r.data, mimeType: r.mime_type })) ?? []
        // Structural = inline refs + fetched structural URLs; style = fetched style URLs.
        // nano-banana.ts interleaves and labels each group.
        const structuralRefs = [...inlineRefs, ...fetchedStructural]
        const styleRefs = fetchedStyle
        const hasRef = structuralRefs.length > 0
        const hasStyleRef = styleRefs.length > 0
        const hasProductRef = productRefs.length > 0
        const isGeneral = style_preset === "general"

        // Style preamble (always — unless 'raw') bakes in the architectural-photo
        // baseline so output matches magazine-quality references, not generic CGI.
        const stylePreamble = STYLE_PREAMBLES[style_preset ?? "room"] ?? ""
        // Structure preamble (when reference present in 'structure' mode) preserves
        // the reference's geometry while only changing materials/finishes. The
        // hasStyleRef flag adjusts the preamble to label image roles correctly.
        // Never for 'general' — its references aren't rooms.
        const userPromptWithStructure =
          hasRef && reference_mode === "structure" && !isGeneral
            ? buildStructurePreamble(prompt, { hasStyleRef, hasProductRef })
            : prompt
        const effectivePrompt = stylePreamble
          ? `${stylePreamble}\n\n${userPromptWithStructure}`
          : userPromptWithStructure
        // Default to 2K on pro — same price as 1K, meaningful quality lift.
        const effectiveImageSize = image_size ?? (model === "pro" ? "2K" : undefined)
        // Thinking budget: caller override, else 'high' on pro / 'off' on flash.
        const effectiveThinking = thinking_level ?? (model === "pro" ? "high" : "off")
        // Per-variation instruction so a batch produces distinct options rather
        // than N near-duplicates. Appended per-call (1-based); nothing when batch is 1.
        // With a room reference, "distinctly different design interpretation" made
        // the model move the camera and invent openings (2026-10-21), so room
        // batches only vary surface choices.
        const callOnce = (variationIndex: number) => {
          let callPrompt = effectivePrompt
          if (batch > 1) {
            callPrompt +=
              hasRef && !isGeneral
                ? `\n\nVARIATION ${variationIndex} OF ${batch}: the SAME room from the SAME camera with the SAME geometry, windows, and doors as the structural reference. ` +
                  `Make this option's finish choices noticeably different from the other options — vary only finishes, materials, colors, and decor` +
                  (variation_axes ? ` (specifically: ${variation_axes})` : "") +
                  `. Never change the camera, layout, or openings to make it different.`
                : `\n\nVARIATION ${variationIndex} OF ${batch}: produce a distinctly different design interpretation from the other variations` +
                  (variation_axes ? ` — specifically vary: ${variation_axes}` : "") +
                  `.`
          }
          return generateWithNanoBanana(key, {
            prompt: callPrompt,
            structuralRefs,
            styleRefs,
            productRefs,
            model,
            aspectRatio: aspect_ratio,
            imageSize: effectiveImageSize,
            thinkingLevel: effectiveThinking,
            refLabels: isGeneral ? "general" : "room",
          })
        }

        // Parallel fan-out. Partial failures are tolerated — return what we have
        // and note how many calls failed.
        const settled = await Promise.allSettled(
          Array.from({ length: batch }, (_v, i) => callOnce(i + 1)),
        )
        const allImages: GeneratedImage[] = []
        const notes: string[] = []
        const errors: string[] = []
        for (const r of settled) {
          if (r.status === "fulfilled") {
            allImages.push(...r.value.images)
            if (r.value.text) notes.push(r.value.text)
          } else {
            errors.push(friendlyGoogleError(r.reason))
          }
        }

        if (allImages.length === 0) {
          const errBlock = errors.length
            ? `All ${batch} attempt(s) failed:\n\n${errors.join("\n---\n")}`
            : "Nano Banana returned no image. Try a clearer instruction, or add a reference image."
          const fetchBlock = fetchErrors.length ? `\n\nReference URL errors:\n${fetchErrors.join("\n")}` : ""
          return text(
            (notes.length ? `Model said: ${notes.join("\n")}\n\n` : "") + errBlock + fetchBlock,
          )
        }

        // Archive every successful render to R2 (the growing library).
        const archived = skip_archive ? allImages.map(() => null) : await this.archiveRenders(allImages, {
          prompt: prompt.slice(0, 500),
          model,
          has_reference: String(hasRef),
          product_refs: String(productRefs.length),
          reference_mode: reference_mode ?? "structure",
          style_preset: style_preset ?? "room",
          ...(job_tag ? { job_tag } : {}),
          ...(job_id ? { jt_job_id: job_id } : {}),
        })

        const partialFailNote = errors.length
          ? `\n\n(Note: ${errors.length} of ${batch} call(s) failed and were dropped.)`
          : ""
        const summary =
          `Generated ${allImages.length} image(s) with Nano Banana (${model}` +
          (isGeneral ? ", general" : hasRef ? `, ${reference_mode} mode` : "") +
          (batch > 1 ? `, batch of ${batch}` : "") +
          `).` +
          (notes.length ? `\n\nModel notes: ${notes.join("\n")}` : "") +
          partialFailNote +
          `\n\nThe render(s) appear in the viewer above and are saved in this chat's Content panel for history.`
        return {
          // Image content blocks land in claude.ai's Content panel for chat
          // history. The widget also reads them via app.ontoolresult.
          content: [
            { type: "text" as const, text: summary },
            ...allImages.map((im) => ({
              type: "image" as const,
              data: im.base64,
              mimeType: im.mimeType,
            })),
            ...followUpBlock(archived),
          ],
          structuredContent: {
            imageCount: allImages.length,
            batchRequested: batch,
            batchFailed: errors.length,
            model,
            aspectRatio: aspect_ratio ?? null,
            referenceMode: hasRef && !isGeneral ? reference_mode : null,
            stylePreset: style_preset ?? "room",
            prompt,
            jobTag: job_tag ?? null,
            // Per-image cost × successful images, rounded to 3 decimals. The widget
            // accumulates this into a session cost counter.
            estimatedCostUsd:
              Math.round(perImageCostUsd(model, effectiveImageSize) * allImages.length * 1000) / 1000,
            // Index-aligned with the image blocks; null where the archive write failed.
            archivedFilenames: archived,
            // Full URLs the widget can use for downloads (bypasses sandboxed-iframe
            // download restrictions on data: URLs).
            archivedUrls: archived.map((fn) => (fn ? archivedUrl(fn) : null)),
          },
        }
      },
    )

    // -------- build_render_prompt (prompt composer, no API call) --------
    this.server.tool(
      "build_render_prompt",
      "Compose an optimized architectural-render prompt from structured room data (room type, dimensions, materials, fixtures, style, camera, lighting). Does NOT call any image API — it returns a prompt string to pass into generate_render or generate_render_interactive.",
      {
        room_type: z
          .string()
          .describe("Type of room: bathroom, kitchen, basement, bedroom, living_room, exterior, etc."),
        dimensions: z
          .object({
            length_ft: z.number().optional(),
            width_ft: z.number().optional(),
            ceiling_height_ft: z.number().optional().default(9),
          })
          .optional()
          .describe("Room dimensions if known."),
        materials: z
          .array(
            z.object({
              name: z.string(),
              location: z.string().optional(),
            }),
          )
          .optional()
          .describe(
            "Finish materials with location, e.g. [{name:'White subway tile 3x6', location:'shower walls'}].",
          ),
        fixtures: z
          .array(z.string())
          .optional()
          .describe("Key fixtures, e.g. ['matte black rain showerhead', 'frameless glass enclosure']."),
        style_direction: z
          .string()
          .optional()
          .default("modern")
          .describe("Design style: modern, transitional, farmhouse, contemporary, traditional, industrial."),
        camera_angle: z
          .string()
          .optional()
          .default("wide shot from the doorway")
          .describe("Camera perspective: wide shot, eye level, overhead, corner view, detail shot."),
        lighting: z
          .string()
          .optional()
          .default("bright, even, realistic lighting")
          .describe("Lighting mood: bright and even, warm evening, moody/dramatic. Fine to say 'natural daylight' for a pure text render; for a room photo, describe its existing light sources instead (daylight wording makes the model add windows)."),
      },
      async ({ room_type, dimensions, materials, fixtures, style_direction, camera_angle, lighting }) => {
        const prompt = buildRenderPrompt({
          roomType: room_type,
          dimensions: dimensions
            ? {
                lengthFt: dimensions.length_ft,
                widthFt: dimensions.width_ft,
                ceilingHeightFt: dimensions.ceiling_height_ft,
              }
            : undefined,
          materials,
          fixtures,
          styleDirection: style_direction,
          cameraAngle: camera_angle,
          lighting,
        })
        return text(
          `${prompt}\n\n---\nPass the text above as the \`prompt\` to generate_render (one-shot) ` +
            `or generate_render_interactive (with reference images / editing).`,
        )
      },
    )

    // -------- propose_render (chat -> widget handoff) --------
    // The chat-attachment path. Claude writes a strong photoreal prompt based on the
    // user's attached image + intent, calls this tool. The render widget opens
    // pre-filled. The user clicks 📎 Reference, picks the image they already have
    // on their disk, presses Generate. No image bytes flow through chat or the
    // sandbox — both are restricted.
    this.server.registerTool(
      "propose_render",
      {
        title: "Propose a render (open widget with a prompt)",
        description:
          "USE THIS when a user attaches an image in chat and wants a new image made from it — a photoreal room render, OR any other edit/graphic built from their photo (e.g., 'put our logo on this truck', 'turn this job photo into an Instagram post'). You write the prompt; the widget opens below the chat with that prompt pre-filled; the user uploads their image there and presses Generate.\n\n" +
          "Do NOT use this to edit an image that was already generated in this chat — call generate_render_interactive with that image's URL instead (no re-upload needed).\n\n" +
          "Set `style_preset`: 'room' (default) for remodel/room renders; 'general' for everything else.\n\n" +
          "For ROOM renders ('room'), write a strong photoreal-render prompt:\n" +
          "- Describe materials, finishes, fixtures, colors, lighting quality and direction, atmosphere.\n" +
          "- If preserving a reference's geometry/layout (the usual case for remodel renders), say so explicitly.\n" +
          "- ALWAYS end the prompt with this standard note, verbatim: 'Keep colors similar to what's shown. Only enhance realism. DO NOT ADD ANY WINDOWS!'\n" +
          "- Architectural-photography language helps (e.g., 'photorealistic interior photograph, soft even light, sharp focus, 24mm wide-angle').\n" +
          "- Don't write 'natural light', 'daylight', or 'sunlight' for a room photo — the model adds windows to justify it. Describe light from the room's existing fixtures and openings instead.\n\n" +
          "For GENERAL images, describe the subject, layout, style, and any exact text to include. Do not add the room note.\n\n" +
          "Do NOT attempt to upload the image yourself — outbound HTTP from your code tool is sandboxed off, and tool arguments can't carry image bytes. The widget handles upload natively.",
        inputSchema: {
          prompt: z
            .string()
            .min(20)
            .describe(
              "A complete, specific render prompt that will be pre-filled in the widget's instruction box. Should describe materials/finishes/lighting/style, not refer to 'the attached image' (the user will upload it inside the widget).",
            ),
          style_preset: z
            .enum(["room", "general"])
            .optional()
            .default("room")
            .describe("'room' (default) for room/remodel renders; 'general' for anything else. Sets the widget's mode."),
        },
        _meta: {
          ui: { resourceUri: RENDER_WIDGET_URI },
          "ui/resourceUri": RENDER_WIDGET_URI,
        },
      },
      async ({ prompt, style_preset }) => {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "Render proposal queued. The interactive viewer is open below — click 📎 Reference, upload the image, and press Generate. Your prompt has been pre-filled and you can edit it before generating.\n\n" +
                `Prompt: ${prompt}`,
            },
          ],
          structuredContent: { action: "propose", prompt, stylePreset: style_preset ?? "room" },
        }
      },
    )

    // -------- upscale_render (take a previous render and bump to 4K) --------
    this.server.registerTool(
      "upscale_render",
      {
        title: "Upscale a render to 4K",
        description:
          "Take a previously generated render (by archived URL) and produce a higher-resolution, sharper version. Re-runs through Nano Banana Pro at 4K with a 'preserve composition, enhance texture detail' prompt. Cost: ~$0.24 per upscale.\n\n" +
          "Get the URL from a prior generate_render_interactive call's `structuredContent.archivedUrls`, or from `list_reference_images`. The result lands in the widget gallery as the next version.",
        inputSchema: {
          image_url: z
            .string()
            .url()
            .describe("URL of the image to upscale (typically a value from `archivedUrls` in a previous generate_render_interactive result)."),
          enhancement_hint: z
            .string()
            .optional()
            .describe("Optional hint about what to enhance — e.g. 'improve fabric texture detail', 'sharpen wood grain'. Defaults to a general enhancement pass."),
          job_tag: z
            .string()
            .max(80)
            .optional()
            .describe("Optional job/project tag stored with the upscaled render so it can be found later with list_renders."),
          job_id: z
            .string()
            .max(40)
            .optional()
            .describe("Optional JobTread job ID (from find_job) stored with the upscaled render."),
        },
        _meta: {
          ui: { resourceUri: RENDER_WIDGET_URI },
          "ui/resourceUri": RENDER_WIDGET_URI,
        },
      },
      async ({ image_url, enhancement_hint, job_tag, job_id }) => {
        const key = this.apiKey()
        if (!key) return text("GEMINI_API_KEY is not set. Run: npx wrangler secret put GEMINI_API_KEY")

        let ref: { data: string; mimeType: string }
        try {
          ref = await fetchImageAsRef(image_url)
        } catch (e) {
          return text(`Could not fetch image at ${image_url}: ${e instanceof Error ? e.message : String(e)}`)
        }

        const upscalePrompt = [
          "Upscale and enhance this photograph to higher resolution and sharper detail.",
          "PRESERVE EXACTLY: the entire composition, every fixture and surface, all geometry, perspective, lighting direction and quality, color palette.",
          "ENHANCE: pixel-level detail; texture fidelity (wood grain, stone variation, fabric weave, metal finish, glass reflections); edge sharpness; subtle realism.",
          "Same image, just more resolution. Do not change anything in the scene.",
          enhancement_hint ? `Specific enhancement focus: ${enhancement_hint}` : "",
        ]
          .filter(Boolean)
          .join("\n")

        try {
          const { images, text: note } = await generateWithNanoBanana(key, {
            prompt: upscalePrompt,
            structuralRefs: [ref],
            model: "pro",
            imageSize: "4K",
            thinkingLevel: "high",
          })

          if (images.length === 0) {
            return text(
              (note ? `Model said: ${note}\n\n` : "") +
                "Upscale failed — Nano Banana returned no image. Retry, or try the lower-cost path (re-render with model=pro, image_size=2K).",
            )
          }

          // Archive the upscaled result to R2 so it has its own URL.
          const archived = await this.archiveRenders(images, {
            source: "upscale_render",
            upscaled_from: image_url,
            model: "pro",
            ...(job_tag ? { job_tag } : {}),
            ...(job_id ? { jt_job_id: job_id } : {}),
          })

          return {
            content: [
              {
                type: "text" as const,
                text: `Upscaled to 4K (${Math.round(images[0].base64.length * 0.75 / 1024)} KB). The new version is in the viewer above.`,
              },
              ...images.map((im) => ({
                type: "image" as const,
                data: im.base64,
                mimeType: im.mimeType,
              })),
              ...followUpBlock(archived),
            ],
            structuredContent: {
              imageCount: images.length,
              model: "pro",
              imageSize: "4K",
              source: "upscale",
              upscaledFrom: image_url,
              jobTag: job_tag ?? null,
              estimatedCostUsd: 0.24,
              archivedFilenames: archived,
              archivedUrls: archived.map((fn) => (fn ? archivedUrl(fn) : null)),
            },
          }
        } catch (e) {
          return text(friendlyGoogleError(e))
        }
      },
    )

    // -------- list_reference_images (browse the R2 library) --------
    this.server.registerTool(
      "list_reference_images",
      {
        title: "List reference images",
        description:
          "Return URLs and metadata of recently uploaded reference images in the Nano Banana library. Useful for finding a previously uploaded reference to reuse in a generate_render_interactive call (e.g., the user already uploaded a SketchUp render earlier in this chat).",
        inputSchema: {
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .default(20)
            .describe("Maximum number of results to return."),
        },
      },
      async ({ limit }) => {
        const all = await this.listAll("refs/")
        if (all.length === 0) return text("No reference images uploaded yet.")
        const sorted = all.sort((a, b) => createdTime(b).getTime() - createdTime(a).getTime()).slice(0, limit ?? 20)
        const lines = sorted.map((obj) => {
          const filename = obj.key.replace(/^refs\//, "")
          const url = archivedUrl(filename)
          const sizeKb = Math.round(obj.size / 1000)
          const date = obj.uploaded.toISOString()
          return `- ${url}  (${obj.httpMetadata?.contentType ?? "?"}, ${sizeKb} KB, ${date})`
        })
        return text(`${sorted.length} reference image(s):\n\n${lines.join("\n")}`)
      },
    )

    // -------- set_render_label (name a render for later reference) --------
    this.server.registerTool(
      "set_render_label",
      {
        title: "Label a render",
        description:
          "Attach a short human label to a stored render or reference image (e.g. 'client pick', 'v2 backsplash'). Labels show up in list_renders and help find a specific image later.",
        inputSchema: {
          filename: z
            .string()
            .describe("The bare filename like 'abc123.jpg'. A full /img/ URL is tolerated (the last path segment is used)."),
          label: z.string().max(80).describe("The label to set. Pass an empty string to clear it."),
        },
      },
      async ({ filename, label }) => {
        // Tolerate a full URL — take the last path segment, strip any query string.
        const bare = filename.split("?")[0].split("/").filter(Boolean).pop() ?? filename
        // R2 can't patch metadata in place: read the object, then re-put the same
        // body/httpMetadata with merged customMetadata (label replaced).
        let key = `renders/${bare}`
        let obj = await this.env.UPLOADS.get(key)
        if (!obj) {
          key = `refs/${bare}`
          obj = await this.env.UPLOADS.get(key)
        }
        if (!obj) {
          return text(`No stored image found named '${bare}' (looked in renders/ and refs/).`)
        }
        const merged = { ...(obj.customMetadata ?? {}), label }
        await this.env.UPLOADS.put(key, obj.body, {
          httpMetadata: obj.httpMetadata,
          customMetadata: merged,
        })
        return {
          content: [{ type: "text" as const, text: `Labeled ${bare} as "${label}".` }],
          structuredContent: { filename: bare, label },
        }
      },
    )

    // -------- list_renders (browse generated renders) --------
    this.server.registerTool(
      "list_renders",
      {
        title: "List generated renders",
        description:
          "Return recently generated renders (URLs + metadata) from the library. Filterable by job_tag or JobTread job_id. Renders already filed in JobTread show 'saved → {job number}'. The interactive widget calls this on connect to restore its gallery.",
        inputSchema: {
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .default(12)
            .describe("Maximum number of renders to return."),
          job_tag: z
            .string()
            .optional()
            .describe("Optional job tag to filter by — only renders stored with a matching job_tag are returned."),
          job_id: z
            .string()
            .optional()
            .describe("Optional JobTread job ID — only renders generated for, or saved to, that job are returned."),
        },
      },
      async ({ limit, job_tag, job_id }) => {
        const matches =
          job_tag || job_id
            ? (o: R2Object) =>
                (!job_tag || (o.customMetadata?.job_tag ?? "") === job_tag) &&
                (!job_id || o.customMetadata?.jt_job_id === job_id || o.customMetadata?.jt_saved_job_id === job_id)
            : undefined
        const objs = await this.recentRenders(limit ?? 12, matches)

        if (objs.length === 0) {
          const filter = job_id ? `job ${job_id}` : job_tag ? `job_tag '${job_tag}'` : ""
          return {
            content: [{ type: "text" as const, text: filter ? `No renders found for ${filter}.` : "No renders generated yet." }],
            structuredContent: { renders: [] },
          }
        }

        const renders = objs.map((o) => {
          const filename = o.key.replace(/^renders\//, "")
          const meta = o.customMetadata ?? {}
          return {
            url: archivedUrl(filename),
            filename,
            uploadedAt: createdTime(o).toISOString(),
            prompt: meta.prompt ?? null,
            model: meta.model ?? null,
            jobTag: meta.job_tag ?? null,
            label: meta.label || null,
            stylePreset: meta.style_preset ?? null,
            jtJobId: meta.jt_job_id ?? null,
            jtSavedJobId: meta.jt_saved_job_id ?? null,
            jtSavedJobNumber: meta.jt_saved_job_number ?? null,
            jtFileName: meta.jt_file_name ?? null,
          }
        })

        const lines = renders.map((r) => {
          const bits = [r.url]
          if (r.label) bits.push(`label="${r.label}"`)
          if (r.jobTag) bits.push(`job=${r.jobTag}`)
          if (r.jtSavedJobNumber) bits.push(`saved → ${r.jtSavedJobNumber}`)
          if (r.stylePreset === "general") bits.push("general")
          if (r.model) bits.push(r.model)
          bits.push(r.uploadedAt.slice(0, 10))
          if (r.prompt) bits.push(`"${r.prompt.slice(0, 80)}"`)
          return `- ${bits.join("  ")}`
        })

        return {
          content: [{ type: "text" as const, text: `${renders.length} render(s):\n\n${lines.join("\n")}` }],
          structuredContent: { renders },
        }
      },
    )

    // -------- store_edited_render (area editor's stitched-back result) --------
    // The widget's area editor sends only a crop around the painted area to the
    // model, then pastes the edited crop back into the full-resolution base with a
    // feathered mask, so nothing outside the area can change. It uploads that final
    // image to /upload (refs/) and calls this to move it into the render library.
    this.server.registerTool(
      "store_edited_render",
      {
        title: "Store an area-edited render (widget)",
        description:
          "Widget-internal: moves an uploaded, stitched-back area edit from the upload area into the render library so it behaves like any other render (gallery, upscale, Save to JobTread when connected).",
        inputSchema: {
          image_url: z.string().describe("The /img/ URL returned by the widget's /upload."),
          prompt: z.string().max(2000).describe("The user's edit instruction."),
          edited_from: z.string().optional().describe("URL of the render that was edited."),
          job_tag: z.string().max(80).optional(),
          job_id: z.string().max(40).optional(),
        },
        _meta: { ui: { visibility: ["app"] } },
      },
      async ({ image_url, prompt, edited_from, job_tag, job_id }) => {
        const bare = image_url.split("?")[0].split("/").filter(Boolean).pop() ?? ""
        if (!/^[a-f0-9]{16}\.(jpg|png|webp)$/.test(bare)) return text(`'${bare}' isn't an upload from this widget.`)
        const obj = await this.env.UPLOADS.get(`refs/${bare}`)
        if (!obj) return text(`No uploaded image named '${bare}'.`)
        await this.env.UPLOADS.put(`renders/${bare}`, obj.body, {
          httpMetadata: obj.httpMetadata,
          customMetadata: {
            prompt: prompt.slice(0, 500),
            model: "pro",
            created_at: new Date().toISOString(),
            source: "area_edit",
            style_preset: "raw",
            label: "",
            ...(edited_from ? { edited_from } : {}),
            ...(job_tag ? { job_tag } : {}),
            ...(job_id ? { jt_job_id: job_id } : {}),
          },
        })
        await this.env.UPLOADS.delete(`refs/${bare}`)
        const url = archivedUrl(bare)
        return {
          content: [{ type: "text" as const, text: `Stored the area edit as ${url}` }, ...followUpBlock([bare])],
          structuredContent: { archivedFilenames: [bare], archivedUrls: [url], prompt },
        }
      },
    )

    // ======== JobTread tools — registered only when JOBTREAD_GRANT_KEY is set ========
    if (!jtEnabled) return

    // -------- find_job (JobTread lookup) --------
    this.server.registerTool(
      "find_job",
      {
        title: "Find a JobTread job",
        description:
          "Look up a JobTread job by job number (e.g. '24-1001' or just '1001'), job name, or customer name. Open jobs only unless include_closed. Use this before save_render_to_job. If more than one job matches, show the user the job numbers and names and ask which one — never guess between jobs.",
        inputSchema: {
          query: z.string().min(2).describe("Job number, job name, or customer name."),
          include_closed: z.boolean().optional().default(false).describe("Also search closed jobs."),
          limit: z.number().int().min(1).max(25).optional().default(8).describe("Max matches to return."),
        },
      },
      async ({ query, include_closed, limit }) => {
        const key = this.env.JOBTREAD_GRANT_KEY
        if (!key) return text("JobTread isn't connected (JOBTREAD_GRANT_KEY is not set).")
        try {
          const jobs = await findJobs(key, query, { includeClosed: include_closed, limit })
          const lines = jobs.map(
            (j) => `- ${j.number} · ${j.name}${j.customer ? ` — ${j.customer}` : ""}${j.closed ? " (closed)" : ""}  [job_id ${j.jobId}]`,
          )
          return {
            content: [
              {
                type: "text" as const,
                text: jobs.length
                  ? `${jobs.length} job(s) matching '${query}':\n${lines.join("\n")}`
                  : `No ${include_closed ? "" : "open "}jobs match '${query}'.`,
              },
            ],
            structuredContent: { jobs },
          }
        } catch (e) {
          return text(friendlyJobTreadError(e))
        }
      },
    )

    // -------- list_open_jobs (widget job pick list) --------
    this.server.registerTool(
      "list_open_jobs",
      {
        title: "List open JobTread jobs (widget picker)",
        description:
          "Every open JobTread job (number, name, customer), newest first. Used by the render widget's job pick list. In chat, use find_job instead — it's targeted and much smaller.",
        inputSchema: {},
        // MCP Apps: callable by the widget, hidden from the model where the host supports it.
        _meta: { ui: { visibility: ["app"] } },
      },
      async () => {
        const key = this.env.JOBTREAD_GRANT_KEY
        if (!key) return text("JobTread isn't connected (JOBTREAD_GRANT_KEY is not set).")
        try {
          const jobs = await listOpenJobs(key)
          return {
            content: [{ type: "text" as const, text: `${jobs.length} open job(s) loaded for the picker.` }],
            structuredContent: { jobs },
          }
        } catch (e) {
          return text(friendlyJobTreadError(e))
        }
      },
    )

    // -------- list_job_selections (product images to use as references) --------
    this.server.registerTool(
      "list_job_selections",
      {
        title: "List a job's selection images",
        description:
          "Product images selected for a JobTread job — images attached to budget line items (e.g. 'Cabinet Pull Specification', 'Tub Faucet Specification') plus images in the job's '" + jtCfg.selectionsFolder + "' folder. Pass chosen URLs to generate_render_interactive as product_reference_urls. URLs are signed and short-lived: list, then use them right away. Small (~100px) images are marked low-res — they guide style but won't reproduce fine detail.",
        inputSchema: {
          job_id: z.string().describe("JobTread job ID from find_job."),
        },
      },
      async ({ job_id }) => {
        const key = this.env.JOBTREAD_GRANT_KEY
        if (!key) return text("JobTread isn't connected (JOBTREAD_GRANT_KEY is not set).")
        try {
          const images = await listJobSelectionImages(key, job_id, jtCfg)
          if (images.length === 0) {
            return {
              content: [{ type: "text" as const, text: `No product images on this job's budget lines or in '${jtCfg.selectionsFolder}'.` }],
              structuredContent: { images: [] },
            }
          }
          const lines = images.map(
            (i) =>
              `- ${i.item}${i.group ? ` [${i.group}]` : ""} — ${i.fileName} (${i.sizeKb} KB${i.sizeKb < LOW_RES_KB ? ", low-res" : ""}): ${i.url}`,
          )
          return {
            content: [{ type: "text" as const, text: `${images.length} selection image(s):\n${lines.join("\n")}` }],
            structuredContent: { images, lowResKb: LOW_RES_KB },
          }
        } catch (e) {
          return text(friendlyJobTreadError(e))
        }
      },
    )

    // -------- save_render_to_job (file a render on a JobTread job) --------
    this.server.registerTool(
      "save_render_to_job",
      {
        title: "Save a render to a JobTread job",
        description:
          `File a Nano Banana render on a JobTread job: folder '${jtCfg.rendersFolder}', tag '${jtCfg.renderTag}', named 'Render - {Room} - YYYY-MM-DD'. Use when the user asks to save/put/file/send a render to a job.\n\n` +
          "Steps: resolve the job with find_job first (confirm by job number if there's any doubt), and ask for the room if it isn't obvious from the prompt. Set mark_latest only when the user says this render replaces earlier ones for that room.\n\n" +
          "Saving never makes a render visible to the client — never tell the user it is. Client visibility is set by a person in JobTread.",
        inputSchema: {
          render: z
            .string()
            .describe("The render's archived URL (from a result's 'Render URL(s)' list or list_renders) or its bare filename like 'abc123.jpg'."),
          job_id: z.string().describe("JobTread job ID from find_job."),
          room: z.string().min(1).max(40).describe("Room or area for the file name, e.g. 'Kitchen', 'Primary Bath', 'Exterior'."),
          mark_latest: z
            .boolean()
            .optional()
            .default(false)
            .describe(`Tag this render '${jtCfg.latestTag}' and move earlier renders of the same room to '${jtCfg.outdatedTag}'. Only when the user says this one supersedes them.`),
          note: z.string().max(300).optional().describe("Optional note added to the file description in JobTread."),
          confirm_closed_job: z
            .boolean()
            .optional()
            .default(false)
            .describe("Required to save to a closed job. Only set after the user explicitly confirms."),
        },
      },
      async ({ render, job_id, room, mark_latest, note, confirm_closed_job }) => {
        const key = this.env.JOBTREAD_GRANT_KEY
        if (!key) return text("JobTread isn't connected (JOBTREAD_GRANT_KEY is not set).")

        // Only renders from our own archive — never arbitrary URLs.
        const bare = render.split("?")[0].split("/").filter(Boolean).pop() ?? render
        const r2Key = `renders/${bare}`
        const head = await this.env.UPLOADS.head(r2Key)
        if (!head) {
          return text(
            `'${bare}' isn't a Nano Banana render. Only renders made here can be saved to JobTread — use a URL from a result's 'Render URL(s)' list or from list_renders.`,
          )
        }
        const meta = head.customMetadata ?? {}

        if (meta.jt_saved_job_id === job_id && meta.jt_file_id) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Already saved to ${meta.jt_saved_job_number ?? "this job"} as "${meta.jt_file_name}". Nothing changed.\n${jobFilesUrl(job_id)}`,
              },
            ],
            structuredContent: {
              saved: true,
              alreadySaved: true,
              filename: bare,
              jobId: job_id,
              jobNumber: meta.jt_saved_job_number ?? null,
              fileName: meta.jt_file_name ?? null,
              jobFilesUrl: jobFilesUrl(job_id),
            },
          }
        }

        try {
          const job = await getJob(key, job_id)
          if (!job) return text(`No JobTread job found with id '${job_id}'. Look it up with find_job.`)
          if (job.closed && !confirm_closed_job) {
            return text(
              `${job.number} · ${job.name} is closed. Confirm with the user that the render belongs on a closed job, then call again with confirm_closed_job: true.`,
            )
          }

          const createdAt = meta.created_at ? new Date(meta.created_at) : head.uploaded
          // Archived prompts can carry internal preambles (area-edit instructions);
          // keep only the user's instruction.
          let prompt = meta.prompt ?? ""
          const uiMark = prompt.indexOf("User instruction: ")
          if (uiMark >= 0) prompt = prompt.slice(uiMark + "User instruction: ".length)
          const description =
            `Generated by Nano Banana (${meta.model ?? "render"}, ${localDate(createdAt, jtCfg.timeZone)}).` +
            (note ? ` Note: ${note}` : "") +
            (prompt ? ` Prompt: ${prompt.slice(0, 300)}` : "")

          const result = await fileRenderOnJob(key, {
            jobId: job_id,
            imageUrl: archivedUrl(bare),
            room,
            createdAt,
            ext: bare.endsWith(".png") ? "png" : "jpg",
            description,
            markLatest: mark_latest,
          }, jtCfg)

          // Remember the save on the R2 object (no duplicates; widget shows a ✓).
          // R2 can't patch metadata in place — re-put the body with merged metadata.
          const warnings = [...result.warnings]
          try {
            const obj = await this.env.UPLOADS.get(r2Key)
            if (obj) {
              await this.env.UPLOADS.put(r2Key, obj.body, {
                httpMetadata: obj.httpMetadata,
                customMetadata: {
                  ...(obj.customMetadata ?? {}),
                  jt_saved_job_id: job_id,
                  jt_saved_job_number: job.number,
                  jt_file_id: result.fileId,
                  jt_file_name: result.fileName,
                  jt_saved_at: new Date().toISOString(),
                },
              })
            }
          } catch {
            warnings.push("Saved to JobTread, but couldn't record the save in the render library — a repeat save would create a duplicate.")
          }

          const tagsApplied = result.markedLatest ? `${jtCfg.renderTag}, ${jtCfg.latestTag}` : jtCfg.renderTag
          const lines = [
            `Saved to ${job.number} · ${job.name} → ${result.folder} as "${result.fileName}" (tagged ${tagsApplied}).`,
            ...(result.outdated.length ? [`Marked ${jtCfg.outdatedTag}: ${result.outdated.join(", ")}.`] : []),
            "Not visible to the client yet — share it from JobTread when it's ready.",
            jobFilesUrl(job_id),
            ...warnings.map((w) => `⚠ ${w}`),
          ]
          return {
            content: [{ type: "text" as const, text: lines.join("\n") }],
            structuredContent: {
              saved: true,
              alreadySaved: false,
              filename: bare,
              jobId: job_id,
              jobNumber: job.number,
              jobName: job.name,
              fileId: result.fileId,
              fileName: result.fileName,
              folder: result.folder,
              markedLatest: result.markedLatest,
              outdated: result.outdated,
              warnings,
              jobFilesUrl: jobFilesUrl(job_id),
            },
          }
        } catch (e) {
          return text(friendlyJobTreadError(e))
        }
      },
    )
  }
}
