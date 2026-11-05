import { NanoBananaMCP } from "./mcp"
import "./types"

export { NanoBananaMCP }

const httpHandler = NanoBananaMCP.serve("/mcp")
const sseHandler = NanoBananaMCP.serveSSE("/sse")

const SERVER_NAME = "Nano Banana MCP"
const SERVER_DESC =
  "Generate photorealistic remodeling renders via Google Imagen 4 and Gemini (Nano Banana)."
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024 // 20 MB

const CORS: HeadersInit = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type, x-upload-token",
}

function shortId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16)
}

function extFromMime(mime: string): string {
  if (mime.includes("png")) return "png"
  if (mime.includes("webp")) return "webp"
  if (mime.includes("gif")) return "gif"
  return "jpg"
}

function landing(origin: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>${SERVER_NAME}</title>
<body style="font-family:system-ui;max-width:640px;margin:3rem auto;padding:0 1rem;line-height:1.5;">
<h1>${SERVER_NAME}</h1>
<p>${SERVER_DESC}</p>
<p>Remote MCP endpoint: <code>${origin}/mcp</code> (or SSE: <code>${origin}/sse</code>).</p>
<p>Reference image upload: <a href="${origin}/upload">${origin}/upload</a></p>
<p>Tools: <code>generate_render</code>, <code>generate_render_interactive</code>, <code>propose_render</code>, <code>upscale_render</code>, <code>build_render_prompt</code>, <code>list_renders</code>, <code>list_reference_images</code>, <code>set_render_label</code>, plus <code>find_job</code>, <code>list_job_selections</code> and <code>save_render_to_job</code> when JobTread is connected.</p>
</body>`
}

const UPLOAD_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Upload a reference image</title>
<style>
  body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; color: #1a1a1a; }
  h1 { font-size: 22px; margin-bottom: 6px; }
  .drop { margin-top: 18px; border: 2px dashed rgba(0,0,0,.25); border-radius: 12px; padding: 36px; text-align: center; background: #fffbef; cursor: pointer; transition: border-color .15s, background .15s; }
  .drop.hover { border-color: #f5b301; background: #fff3d6; }
  .drop p { margin: 6px 0; color: #555; font-size: 14px; }
  .result { margin-top: 18px; padding: 14px; border-radius: 10px; background: rgba(0,0,0,.04); display: none; }
  .result.show { display: block; }
  .result code { word-break: break-all; }
  .copy { padding: 6px 12px; border-radius: 6px; border: 0; background: #f5b301; color: #1a1a1a; font-weight: 600; cursor: pointer; font-size: 13px; }
  .err { color: #b00020; font-size: 13px; }
</style>
</head>
<body>
<h1>Upload a reference image</h1>
<p>Drop a JPEG/PNG (≤ 20 MB). You'll get a stable URL to pass into <code>generate_render_interactive</code> as <code>reference_image_urls</code>.</p>
<label for="picker" class="drop" id="drop">
  <p><strong>Drop an image here</strong> or click to pick.</p>
  <p style="font-size:12px;color:#888;">PNG, JPEG, WebP — anything Gemini can read.</p>
  <input id="picker" type="file" accept="image/*" hidden />
</label>
<div id="result" class="result"></div>
<script>
  var drop = document.getElementById("drop");
  var picker = document.getElementById("picker");
  var result = document.getElementById("result");
  function setResult(node) {
    while (result.firstChild) result.removeChild(result.firstChild);
    result.appendChild(node);
    result.classList.add("show");
  }
  function setError(msg) {
    var p = document.createElement("p");
    p.className = "err";
    p.textContent = "Error: " + msg;
    setResult(p);
  }
  function setSuccess(data) {
    var wrap = document.createElement("div");
    var head = document.createElement("p");
    var s = document.createElement("strong");
    s.textContent = "Uploaded.";
    head.appendChild(s);
    var rest = " " + (data.bytes ? (Math.round(data.bytes / 1024) + " KB — ") : "") + (data.mimeType || "");
    head.appendChild(document.createTextNode(rest));
    wrap.appendChild(head);
    var urlRow = document.createElement("p");
    var code = document.createElement("code");
    code.textContent = data.url;
    urlRow.appendChild(code);
    var btn = document.createElement("button");
    btn.className = "copy";
    btn.style.marginLeft = "8px";
    btn.textContent = "Copy URL";
    btn.addEventListener("click", function () {
      navigator.clipboard.writeText(data.url);
      btn.textContent = "Copied!";
      setTimeout(function () { btn.textContent = "Copy URL"; }, 1500);
    });
    urlRow.appendChild(btn);
    wrap.appendChild(urlRow);
    var img = document.createElement("img");
    img.src = data.url;
    img.style.maxWidth = "100%";
    img.style.borderRadius = "8px";
    img.style.marginTop = "8px";
    wrap.appendChild(img);
    setResult(wrap);
  }
  function send(file) {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { setError("File too large (max 20 MB)."); return; }
    var p = document.createElement("p");
    p.textContent = "Uploading " + file.name + "…";
    setResult(p);
    // Forward the page's query string so a shared "?token=..." link authorizes the POST.
    fetch("/upload" + (location.search || ""), { method: "POST", body: file, headers: { "content-type": file.type || "application/octet-stream" } })
      .then(function (r) { if (!r.ok) return r.text().then(function (t) { throw new Error(r.status + " " + t); }); return r.json(); })
      .then(setSuccess)
      .catch(function (err) { setError(err.message); });
  }
  drop.addEventListener("click", function () { picker.click(); });
  picker.addEventListener("change", function () { send(picker.files && picker.files[0]); });
  drop.addEventListener("dragover", function (e) { e.preventDefault(); drop.classList.add("hover"); });
  drop.addEventListener("dragleave", function () { drop.classList.remove("hover"); });
  drop.addEventListener("drop", function (e) {
    e.preventDefault(); drop.classList.remove("hover");
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    send(f);
  });
</script>
</body>
</html>`

// Image magic-byte sniffing — the ground truth for what was actually uploaded.
function detectMimeFromMagic(view: Uint8Array): string | null {
  if (view.length < 4) return null
  if (view[0] === 0xff && view[1] === 0xd8 && view[2] === 0xff) return "image/jpeg"
  if (view[0] === 0x89 && view[1] === 0x50 && view[2] === 0x4e && view[3] === 0x47) return "image/png"
  if (view[0] === 0x52 && view[1] === 0x49 && view[2] === 0x46 && view[3] === 0x46) return "image/webp"
  if (view[0] === 0x47 && view[1] === 0x49 && view[2] === 0x46 && view[3] === 0x38) return "image/gif"
  return null
}

function decodeBase64ToBytes(b64: string): ArrayBuffer {
  const bin = atob(b64.replace(/\s+/g, ""))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}

function looksLikeBase64(s: string): boolean {
  // base64 chars, optional padding, and reasonable length
  return s.length >= 100 && s.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(s)
}

async function handleUpload(request: Request, env: Env, origin: string): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS })
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: CORS })
  }

  // Optional upload gate. When UPLOAD_TOKEN is set, require it via header or
  // ?token= query param. Unset → open (unchanged behavior).
  if (env.UPLOAD_TOKEN) {
    const provided =
      request.headers.get("x-upload-token") ?? new URL(request.url).searchParams.get("token") ?? ""
    if (provided !== env.UPLOAD_TOKEN) {
      return new Response("Unauthorized: missing or invalid upload token (x-upload-token header or ?token=).", {
        status: 401,
        headers: CORS,
      })
    }
  }

  const ct = (request.headers.get("content-type") ?? "").toLowerCase()
  let bytes: ArrayBuffer
  let mime: string | null = null
  let originalName = ""

  if (ct.includes("multipart/form-data")) {
    const form = await request.formData()
    const file = form.get("file")
    if (!(file instanceof File)) {
      return new Response("No 'file' field in form", { status: 400, headers: CORS })
    }
    bytes = await file.arrayBuffer()
    mime = file.type || null
    originalName = file.name || ""
  } else {
    // Read the body once, then auto-detect: raw bytes, data URL, JSON wrapper, or bare base64.
    const raw = await request.arrayBuffer()
    if (raw.byteLength === 0) return new Response("Empty body", { status: 400, headers: CORS })

    const head = new Uint8Array(raw, 0, Math.min(raw.byteLength, 32))
    const magicMime = detectMimeFromMagic(head)

    if (magicMime) {
      // Body is already raw image bytes — easy path.
      bytes = raw
      mime = magicMime
    } else {
      // Try text-based shapes (data URL, JSON wrapper, bare base64).
      let text = ""
      try {
        text = new TextDecoder("utf-8").decode(new Uint8Array(raw)).trim()
      } catch {
        text = ""
      }

      let extractedB64: string | null = null
      let extractedMime: string | null = null

      // data URL: "data:image/png;base64,iVBOR..."
      const dataUrlMatch = text.match(/^data:([^;]+);base64,([\s\S]+)$/i)
      if (dataUrlMatch) {
        extractedMime = dataUrlMatch[1].trim()
        extractedB64 = dataUrlMatch[2].trim()
      }
      // JSON wrapper: {"data":"...","mimeType":"..."} or {"image":"data:..."}
      else if (text.startsWith("{") && text.endsWith("}")) {
        try {
          const j = JSON.parse(text) as Record<string, unknown>
          const candidate =
            (typeof j.data === "string" && j.data) ||
            (typeof j.base64 === "string" && j.base64) ||
            (typeof j.image === "string" && j.image) ||
            (typeof j.b64 === "string" && j.b64) ||
            null
          if (candidate) {
            const inner = candidate.match(/^data:([^;]+);base64,([\s\S]+)$/i)
            if (inner) {
              extractedMime = inner[1].trim()
              extractedB64 = inner[2].trim()
            } else {
              extractedB64 = candidate.replace(/\s+/g, "")
              if (typeof j.mimeType === "string") extractedMime = j.mimeType
              else if (typeof j.mime === "string") extractedMime = j.mime
            }
          }
        } catch {
          /* not valid JSON, fall through */
        }
      }
      // Bare base64 text
      else {
        const stripped = text.replace(/\s+/g, "")
        if (looksLikeBase64(stripped)) {
          extractedB64 = stripped
        }
      }

      if (extractedB64) {
        try {
          bytes = decodeBase64ToBytes(extractedB64)
        } catch (e) {
          return new Response("Body looked like base64 but decoding failed: " + (e instanceof Error ? e.message : String(e)), { status: 400, headers: CORS })
        }
        // Confirm the decoded bytes are actually an image; trust magic bytes over the caller's claimed mime.
        const decodedHead = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 32))
        mime = detectMimeFromMagic(decodedHead) ?? extractedMime ?? (ct.split(";")[0].trim() || null)
      } else {
        // No base64 detected — trust the body as raw bytes.
        bytes = raw
        mime = ct.split(";")[0].trim() || null
      }
    }
  }

  if (bytes.byteLength === 0) {
    return new Response("Empty body", { status: 400, headers: CORS })
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return new Response(`Too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`, {
      status: 413,
      headers: CORS,
    })
  }
  // Final magic-byte check on what we're about to store.
  const finalHead = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 32))
  const finalMagic = detectMimeFromMagic(finalHead)
  if (finalMagic) mime = finalMagic
  if (!mime || !mime.startsWith("image/")) mime = "image/jpeg"

  const ext = extFromMime(mime)
  const id = shortId()
  const key = `refs/${id}.${ext}`

  await env.UPLOADS.put(key, bytes, {
    httpMetadata: { contentType: mime },
    customMetadata: {
      original_name: originalName.slice(0, 200),
      uploaded_at: new Date().toISOString(),
    },
  })

  const filename = `${id}.${ext}`
  const url = `${origin}/img/${filename}`
  return new Response(JSON.stringify({ id, filename, url, mimeType: mime, bytes: bytes.byteLength }), {
    headers: { ...CORS, "content-type": "application/json" },
  })
}

async function handleImageGet(env: Env, url: URL): Promise<Response> {
  const pathname = url.pathname
  const filename = pathname.slice("/img/".length)
  // The widget draws these onto canvases with crossOrigin="anonymous", so every
  // /img/ response (success and 404) needs the permissive CORS header.
  if (!filename || filename.includes("/") || filename.includes("..")) {
    return new Response("Not found", { status: 404, headers: { "access-control-allow-origin": "*" } })
  }
  // Look in both prefixes — refs (uploads) and renders (auto-stored outputs).
  let obj = await env.UPLOADS.get(`refs/${filename}`)
  if (!obj) obj = await env.UPLOADS.get(`renders/${filename}`)
  if (!obj) return new Response("Not found", { status: 404, headers: { "access-control-allow-origin": "*" } })
  const headers: Record<string, string> = {
    "content-type": obj.httpMetadata?.contentType || "image/jpeg",
    "cache-control": "public, max-age=86400",
    "access-control-allow-origin": "*",
  }
  // ?dl=1 forces a download (used by the widget's Download button).
  if (url.searchParams.get("dl") === "1") {
    headers["content-disposition"] = `attachment; filename="${filename}"`
  }
  return new Response(obj.body, { headers })
}

// Re-target a request at a different path (the MCP handlers are bound to the
// bare /mcp and /sse base paths; the gated public paths carry the key segment).
function rewritePath(request: Request, path: string): Request {
  const u = new URL(request.url)
  u.pathname = path
  return new Request(u.toString(), request)
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const gateKey = env.MCP_PATH_KEY

    if (gateKey) {
      // Capability-URL gate: MCP lives only at /mcp/<key> and /sse/<key>.
      if (url.pathname === `/mcp/${gateKey}`) {
        return httpHandler.fetch(rewritePath(request, "/mcp"), env, ctx)
      }
      if (url.pathname === `/sse/${gateKey}`) {
        return sseHandler.fetch(rewritePath(request, "/sse"), env, ctx)
      }
      // The SSE transport advertises /sse/message as its POST endpoint. Keep it
      // reachable: posts require a live sessionId that can only be minted via
      // the gated /sse/<key> GET, so this is not a bypass.
      if (url.pathname === "/sse/message") {
        return sseHandler.fetch(request, env, ctx)
      }
    } else {
      if (url.pathname === "/mcp") return httpHandler.fetch(request, env, ctx)
      if (url.pathname === "/sse" || url.pathname === "/sse/message") {
        return sseHandler.fetch(request, env, ctx)
      }
    }
    if (url.pathname === "/upload") {
      if (request.method === "GET") {
        return new Response(UPLOAD_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } })
      }
      return handleUpload(request, env, url.origin)
    }
    if (url.pathname.startsWith("/img/")) {
      return handleImageGet(env, url)
    }
    if (url.pathname === "/") {
      // When gated, the landing page (which names the MCP endpoints) is hidden.
      if (gateKey) return new Response("Not found", { status: 404 })
      return new Response(landing(url.origin), {
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    }
    return new Response("Not found", { status: 404 })
  },
}
