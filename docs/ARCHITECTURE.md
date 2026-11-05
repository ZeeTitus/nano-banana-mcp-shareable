# Architecture

## The pieces

```
claude.ai chat ──MCP (Streamable HTTP or SSE)──▶  Worker  /mcp/<MCP_PATH_KEY>
      │                                              │
      │  widget iframe (MCP Apps)                    ├─ NanoBananaMCP Durable Object (one per MCP session)
      │    ├─ calls tools through the host ─────────▶│     tools, widget resource
      │    └─ fetch PUBLIC_ORIGIN/upload, /img/ ────▶├─ /upload   store a reference image in R2
      │                                              ├─ /img/<f>  serve any stored image (public)
      ▼                                              │
  user sees renders                                  ├──▶ Google Generative Language API (Gemini image, Imagen 4)
                                                     ├──▶ R2 bucket (UPLOADS): refs/ and renders/
                                                     └──▶ JobTread Pave API (optional)
```

- **`src/index.ts`** routes HTTP. With `MCP_PATH_KEY` set, MCP is only reachable at `/mcp/<key>` and `/sse/<key>`; bare `/mcp`, `/sse`, and `/` return 404. `/sse/message` stays open because posting to it needs a session ID that only the gated GET can mint.
- **`src/mcp.ts`** is an `McpAgent` (Cloudflare `agents` package) holding an `McpServer`. `init()` runs per session, reads config from `env`, registers the widget resource and every tool.
- **The widget** (`src/lib/render-widget.ts`) is a single self-contained HTML page. It loads `@modelcontextprotocol/ext-apps` from esm.sh, receives tool results via `app.ontoolresult`, and calls tools itself with `app.callServerTool`. Tools linked to it carry `_meta.ui.resourceUri`, which is how claude.ai knows to render it inline.

## Request flows

**Text-only render.** Claude calls `generate_render_interactive` with a prompt → server prepends the style preamble → Gemini → images archived to `renders/` → result has image blocks (for chat history), a text block listing the archive URLs (so Claude can do follow-up edits), and `structuredContent` the widget reads.

**User attaches a photo in chat.** Claude can't forward the bytes (see limits below), so it calls `propose_render` with a prompt. The widget opens with the prompt pre-filled; the user picks the photo in the widget; the widget sends it to `generate_render_interactive` as `reference_images` base64. The structure preamble pins geometry, camera, openings, and fixtures to the reference.

**Follow-up edit in chat** ("make the tile darker"). Claude passes the previous render's `/img/` URL as `reference_image_urls` with `style_preset: "raw"` and only the change as the prompt. The server fetches the URL and sends it to Gemini.

**Area edit (paint a region).** The widget crops around the painted area, sends only the crop to the model with `skip_archive: true`, pastes the result back into the full-resolution image through a feathered mask (pixels outside the area can't change), uploads the stitched image to `/upload`, and calls `store_edited_render` to move it from `refs/` into `renders/`. An earlier "draw a red outline on the whole image" approach was intermittently ignored by the model; crop-and-stitch fixed it.

**Batches.** `batch_count` fans out parallel calls. Room batches vary only finishes: telling the model to make each option a "distinctly different design" made it move the camera and add openings.

## Prompt layers

Applied in this order (see `src/lib/prompts.ts`):

1. **Style preamble** by `style_preset`:
   - `room` (default): magazine-style remodel photography, light only from the scene's existing sources, tasteful staging.
   - `natural`: a lighter photoreal-interior preamble.
   - `general`: for anything that isn't a room. No room assumptions; render requested text exactly.
   - `raw`: nothing. Used for follow-up edits so preambles don't stack.
2. **Structure preamble**, only with a reference in `structure` mode and not `general`. Labels image roles (structural vs style anchor vs product), forbids new windows and invented views through openings, keeps colors unless asked.
3. **Lighting note**, appended when the user's words include "natural light", "daylight", "sunny", and similar. Those words alone made the model add windows to a windowless basement.
4. **Variation suffix** for batches.

Reference images are interleaved with text labels in the Gemini request (`src/lib/nano-banana.ts`) so the model knows which image is which.

## Storage (R2 `UPLOADS`)

| Prefix | What | Written by |
|---|---|---|
| `refs/<16hex>.<ext>` | Uploaded references | `POST /upload` |
| `renders/<16hex>.<ext>` | Generated renders | tools, `store_edited_render` |

Both are served at `PUBLIC_ORIGIN/img/<16hex>.<ext>`. `?dl=1` forces a download.

Render `customMetadata`: `created_at`, `label`, `prompt` (first 500 chars), `model`, `style_preset`, `reference_mode`, `has_reference`, `product_refs`, `source`, `job_tag`, and when relevant `upscaled_from`, `edited_from`, `jt_job_id`, plus `jt_saved_job_id`, `jt_saved_job_number`, `jt_file_id`, `jt_file_name`, `jt_saved_at` after a JobTread save.

R2 can't patch metadata in place, so labeling or recording a save re-puts the object. That resets `uploaded`, which is why everything sorts by `created_at`. `list_renders` lists keys (fast), then `head()`s only the newest candidates; reading metadata for the whole library got slow past a few hundred renders.

`/upload` accepts raw bytes, multipart (`file` field), a data URL, JSON (`{data, mimeType}` and a few aliases), or bare base64, up to 20 MB, and trusts magic bytes over the declared type. That flexibility exists because models emit uploads in every one of those shapes.

## Security

- **MCP access:** capability URL. Anyone with `/mcp/<MCP_PATH_KEY>` can use every tool and spend your Google credits. Rotate by putting a new secret.
- **Uploads:** `UPLOAD_TOKEN` via `x-upload-token` header or `?token=`. The widget gets the token injected into its HTML, which only travels over the gated MCP connection.
- **Images:** `/img/` is public. Filenames are 64 random bits, so they work as unguessable links, but anyone holding a URL can view it. Don't store anything you wouldn't put behind a share link.
- **JobTread:** the grant key acts as one JobTread user. Saves only accept renders from this server's own bucket, never arbitrary URLs.
- **Want real auth?** Put Cloudflare Access in front of the domain (service tokens for non-browser clients), or swap the capability gate for OAuth using `@cloudflare/workers-oauth-provider`. Not included here.

## Platform limits that shaped the design

| Limit | Consequence |
|---|---|
| claude.ai silently drops tool calls whose arguments exceed roughly 3 KB | Chat attachments can't be passed inline → `propose_render` + widget upload |
| claude.ai's code sandbox blocks most outbound HTTP | Claude can't upload attachments itself either |
| workers.dev bot protection can't be disabled | Custom domain with Bot Fight Mode off |
| claude.ai caches widget HTML by URI and caches tool lists | Version the widget URI; the legacy `viewer-{version}` template serves current HTML to old chats |
| Gemini rejects very small images | Minimum inline size guard; ~100 px product thumbnails still work as style hints |
| Pro image model sometimes rejects `thinkingConfig` | Client retries once without it |
