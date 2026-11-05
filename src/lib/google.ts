// Shared types and error handling for the Google Generative Language REST API.

export interface GeneratedImage {
  /** Base64-encoded image bytes (no data: prefix). */
  base64: string
  mimeType: string
}

export class GoogleApiError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`Google API error ${status}`)
    this.name = "GoogleApiError"
  }
}

function truncate(s: string, n = 2000): string {
  return s.length > n ? s.slice(0, n) + "…" : s
}

/** Turn a raw Google API failure into an actionable, human-readable message. */
export function friendlyGoogleError(e: unknown): string {
  if (e instanceof GoogleApiError) {
    switch (e.status) {
      case 400:
        return (
          `Google rejected the request (400). This usually means a safety filter blocked the prompt ` +
          `(real people, named brands, or sensitive content) or a parameter was invalid. ` +
          `Try rephrasing: describe the room, materials, and lighting; avoid naming real people or brand names.\n\n` +
          `Details: ${truncate(e.body)}`
        )
      case 401:
      case 403:
        return (
          `Google auth failed (${e.status}). The GEMINI_API_KEY is missing, invalid, or lacks access to the image models. ` +
          `Re-set it with: npx wrangler secret put GEMINI_API_KEY\n\nDetails: ${truncate(e.body)}`
        )
      case 429:
        return (
          `Rate limited by Google (429). You hit a per-minute or daily image cap. ` +
          `Wait a moment and retry, or use a billing-enabled API key for higher limits.`
        )
      default:
        return `Google API error ${e.status}.\n\nDetails: ${truncate(e.body)}`
    }
  }
  return `Unexpected error: ${e instanceof Error ? e.message : String(e)}`
}
