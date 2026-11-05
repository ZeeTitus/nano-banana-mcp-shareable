// Gemini native image generation (Nano Banana) client.
// Uses the standard :generateContent endpoint — NOT a separate "interactions" endpoint.
// Reference images are passed as inlineData parts; output images come back as
// inlineData parts on the first candidate. https://ai.google.dev/gemini-api/docs/image-generation

import { GoogleApiError, type GeneratedImage } from "./google"

export type NanoBananaModel = "flash" | "pro"

const MODEL_MAP: Record<NanoBananaModel, string> = {
  flash: "gemini-3.1-flash-image-preview",
  pro: "gemini-3-pro-image-preview",
}

export interface ReferenceImage {
  /** Base64-encoded image bytes (no data: prefix). */
  data: string
  mimeType?: string
}

export interface NanoBananaParams {
  prompt: string
  /** Refs that define room geometry/camera/fixtures — the model must preserve them. */
  structuralRefs?: ReferenceImage[]
  /** Refs the model borrows lighting/color/mood from only — never geometry. */
  styleRefs?: ReferenceImage[]
  /** Exact products/materials to install (e.g. a cabinet pull from the job's selections). */
  productRefs?: ReferenceImage[]
  model?: NanoBananaModel
  aspectRatio?: string
  imageSize?: string
  /** Pro-only reasoning budget. When set (and not "off") maps to generationConfig.thinkingConfig. */
  thinkingLevel?: "off" | "low" | "high"
  /**
   * "room" (default) labels references as room geometry / style anchors.
   * "general" labels them neutrally so non-room requests (flyers, graphics,
   * product shots) aren't pushed toward preserving a "room".
   */
  refLabels?: "room" | "general"
}

export interface NanoBananaResult {
  images: GeneratedImage[]
  /** Any text the model returned alongside the image (e.g. an explanation of edits). */
  text?: string
}

interface GeminiPart {
  text?: string
  inlineData?: { data: string; mimeType?: string }
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>
}

export async function generateWithNanoBanana(
  apiKey: string,
  p: NanoBananaParams,
): Promise<NanoBananaResult> {
  const model = MODEL_MAP[p.model ?? "flash"]
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`

  // Interleave labeled text parts with their images so the model knows the role
  // of each reference: structural refs are ground truth, product refs are exact
  // items to install, style anchors are aesthetic-only. Refs come first, the
  // actual instruction is the last part.
  const structural = p.structuralRefs ?? []
  const style = p.styleRefs ?? []
  const products = p.productRefs ?? []
  const general = p.refLabels === "general"
  const parts: GeminiPart[] = []
  structural.forEach((ref, i) => {
    parts.push({
      text: general
        ? `REFERENCE IMAGE ${i + 1}:`
        : `STRUCTURAL REFERENCE ${i + 1} — this image defines the room's geometry, camera angle, and fixture positions. Preserve everything in it unless the instruction says otherwise:`,
    })
    parts.push({ inlineData: { data: ref.data, mimeType: ref.mimeType ?? "image/png" } })
  })
  products.forEach((ref, k) => {
    parts.push({
      text: `PRODUCT REFERENCE ${k + 1} — the exact product or material to use. Reproduce its design, shape, proportions, finish, and color faithfully wherever the instruction says to use it, at a realistic scale for the scene. Ignore its background, packaging, and any text or watermarks:`,
    })
    parts.push({ inlineData: { data: ref.data, mimeType: ref.mimeType ?? "image/png" } })
  })
  style.forEach((ref, j) => {
    parts.push({
      text: general
        ? `STYLE REFERENCE ${j + 1} — match the look and feel of this image, not its content:`
        : `STYLE ANCHOR ${j + 1} — borrow ONLY the lighting quality, color grading, material treatment, and photographic mood from this image. Do NOT copy any geometry, layout, or fixtures from it:`,
    })
    parts.push({ inlineData: { data: ref.data, mimeType: ref.mimeType ?? "image/png" } })
  })
  parts.push({ text: p.prompt })

  const generationConfig: Record<string, unknown> = {
    responseModalities: ["TEXT", "IMAGE"],
  }
  // Gemini image models take aspect ratio / size under generationConfig.imageConfig
  // (string values like "16:9", "2K"). NOT responseFormat — that uses a different enum.
  if (p.aspectRatio || p.imageSize) {
    generationConfig.imageConfig = {
      ...(p.aspectRatio ? { aspectRatio: p.aspectRatio } : {}),
      ...(p.imageSize ? { imageSize: p.imageSize } : {}),
    }
  }
  // Pro reasoning budget. Preview models may not accept thinkingConfig — the
  // request below retries once without it if the API 400s on "thinking".
  if (p.thinkingLevel && p.thinkingLevel !== "off") {
    generationConfig.thinkingConfig = { thinkingLevel: p.thinkingLevel }
  }

  async function post(cfg: Record<string, unknown>): Promise<Response> {
    return fetch(url, {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: cfg }),
    })
  }

  let res = await post(generationConfig)

  if (!res.ok) {
    const body = await res.text()
    // Preview models sometimes reject thinkingConfig outright. If so, drop it and retry once.
    if (res.status === 400 && "thinkingConfig" in generationConfig && /thinking/i.test(body)) {
      const { thinkingConfig: _drop, ...rest } = generationConfig
      res = await post(rest)
      if (!res.ok) throw new GoogleApiError(res.status, await res.text())
    } else {
      throw new GoogleApiError(res.status, body)
    }
  }

  const data = (await res.json()) as GeminiResponse
  const outParts = data.candidates?.[0]?.content?.parts ?? []

  const images: GeneratedImage[] = []
  let text = ""
  for (const part of outParts) {
    if (part.inlineData?.data) {
      images.push({ base64: part.inlineData.data, mimeType: part.inlineData.mimeType ?? "image/png" })
    } else if (part.text) {
      text += part.text
    }
  }

  return { images, text: text.trim() || undefined }
}
