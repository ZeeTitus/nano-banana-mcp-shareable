// Imagen 4 REST client — one-shot text-to-image via the :predict endpoint.
// https://ai.google.dev/gemini-api/docs/imagen

import { GoogleApiError, type GeneratedImage } from "./google"

export type ImagenQuality = "fast" | "standard" | "ultra"
export type ImagenAspectRatio = "1:1" | "3:4" | "4:3" | "9:16" | "16:9"

const MODEL_BY_QUALITY: Record<ImagenQuality, string> = {
  fast: "imagen-4.0-fast-generate-001",
  standard: "imagen-4.0-generate-001",
  ultra: "imagen-4.0-ultra-generate-001",
}

export interface ImagenParams {
  prompt: string
  numImages?: number
  aspectRatio?: ImagenAspectRatio
  quality?: ImagenQuality
}

interface ImagenResponse {
  predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }>
}

export async function generateWithImagen(apiKey: string, p: ImagenParams): Promise<GeneratedImage[]> {
  const quality = p.quality ?? "standard"
  const model = MODEL_BY_QUALITY[quality]
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict`

  const parameters: Record<string, unknown> = {
    sampleCount: Math.min(Math.max(p.numImages ?? 2, 1), 4),
    aspectRatio: p.aspectRatio ?? "16:9",
  }
  // imageSize is only honored by Standard/Ultra; Fast rejects it.
  if (quality !== "fast") parameters.imageSize = "1K"

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ instances: [{ prompt: p.prompt }], parameters }),
  })

  if (!res.ok) {
    throw new GoogleApiError(res.status, await res.text())
  }

  const data = (await res.json()) as ImagenResponse
  return (data.predictions ?? [])
    .filter((pred) => pred.bytesBase64Encoded)
    .map((pred) => ({
      base64: pred.bytesBase64Encoded as string,
      mimeType: pred.mimeType ?? "image/png",
    }))
}
