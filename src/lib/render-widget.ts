// MCP Apps UI resource for the interactive render tool.
//
// Self-contained HTML page that loads @modelcontextprotocol/ext-apps from a
// CDN. Receives tool results via app.ontoolresult, displays renders in a
// gallery + large preview pane, supports refine/edit/upscale/compare/export,
// and opens images at full browser size via app.openLink.

// URI is version-bumped on widget changes so claude.ai re-fetches the cached copy.
export const RENDER_WIDGET_URI = "ui://nano-banana/viewer-v1.html"
export const UI_MIME = "text/html;profile=mcp-app"

/**
 * Content-security policy the host applies to the widget iframe. `origin` is the
 * Worker's PUBLIC_ORIGIN (images + /upload). cdn.jobtread.com serves the job's
 * selection-image thumbnails, so it is only allowed when JobTread is enabled.
 */
export function widgetCsp(origin: string, jobTreadEnabled: boolean) {
  const own = origin ? [origin] : []
  return {
    resourceDomains: ["https://esm.sh", "data:", ...own, ...(jobTreadEnabled ? ["https://cdn.jobtread.com"] : [])],
    connectDomains: ["https://esm.sh", ...own],
  }
}

export const RENDER_WIDGET_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Nano Banana Render</title>
<style>
  /* ---------- Theme tokens (light default, dark override below) ---------- */
  :root {
    color-scheme: light dark;
    --accent: #f5b301;
    --accent-hover: #e6a500;
    --accent-ink: #1a1a1a;           /* text on the yellow buttons — dark in both modes */
    --bg: transparent;
    --fg: #1a1a1a;
    --muted: #6b6b6b;
    --panel: #ffffff;
    --panel-2: rgba(0,0,0,.04);
    --border: rgba(0,0,0,.16);
    --border-strong: rgba(0,0,0,.28);
    --tile-border: rgba(0,0,0,.12);
    --overlay-ink: #ffffff;
    --overlay-bg: rgba(0,0,0,.62);
    --overlay-bg-strong: rgba(0,0,0,.85);
    --input-bg: #ffffff;
    --input-fg: #1a1a1a;
    --danger: #c0261a;
    --danger-bg: rgba(192,38,26,.10);
    --pin: #7c3aed;
    --pin-hover: #6d28d9;
    --menu-shadow: 0 8px 28px rgba(0,0,0,.22);
    --skeleton-1: rgba(0,0,0,.06);
    --skeleton-2: rgba(0,0,0,.12);
    --drop-highlight: rgba(245,179,1,.14);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fg: #ededed;
      --muted: #9a9a9a;
      --panel: #232323;
      --panel-2: rgba(255,255,255,.05);
      --border: rgba(255,255,255,.18);
      --border-strong: rgba(255,255,255,.32);
      --tile-border: rgba(255,255,255,.14);
      --overlay-ink: #ffffff;
      --overlay-bg: rgba(0,0,0,.72);
      --overlay-bg-strong: rgba(0,0,0,.92);
      --input-bg: #2b2b2b;
      --input-fg: #ededed;
      --danger: #ff7368;
      --danger-bg: rgba(255,115,104,.14);
      --pin: #a78bfa;
      --pin-hover: #8b5cf6;
      --menu-shadow: 0 8px 28px rgba(0,0,0,.55);
      --skeleton-1: rgba(255,255,255,.05);
      --skeleton-2: rgba(255,255,255,.12);
      --drop-highlight: rgba(245,179,1,.10);
    }
  }

  * { box-sizing: border-box; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 14px; background: var(--bg); color: var(--fg); }
  .wrap { max-width: 960px; position: relative; }

  .badge { display:inline-flex; align-items:center; gap:8px; font-weight:600; font-size:12px; color:var(--fg); margin-bottom:8px; }
  .dot { width:9px; height:9px; border-radius:50%; background:var(--accent); box-shadow:0 0 0 4px rgba(245,179,1,.22); }

  .statusrow { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; margin:4px 0 10px; }
  .status { font-size:12px; color:var(--muted); flex:1; min-width:180px; }
  .status.err { color:var(--danger); font-weight:600; }
  .cost { font-size:12px; color:var(--muted); white-space:nowrap; font-variant-numeric:tabular-nums; }

  /* ---------- Gallery + tiles ---------- */
  .gallery { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:10px; }
  .tile { position:relative; }
  .tile img { width:100%; height:auto; border-radius:10px; border:1px solid var(--tile-border); display:block; cursor:pointer; background:var(--panel-2); }
  .tile.sel img { outline:3px solid var(--accent); outline-offset:1px; }
  .tile.previewing img { box-shadow:0 0 0 3px var(--pin); }
  .tile .label { position:absolute; top:6px; left:6px; background:var(--overlay-bg); color:var(--overlay-ink); font-size:11px; padding:2px 7px; border-radius:6px; pointer-events:none; max-width:70%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tile .pinbadge { position:absolute; top:6px; left:6px; background:var(--pin); color:#fff; font-size:11px; padding:2px 6px; border-radius:6px; pointer-events:none; }
  .tile .menubtn { position:absolute; top:6px; right:6px; background:var(--overlay-bg); color:var(--overlay-ink); font-size:14px; line-height:1; padding:3px 9px 5px; border-radius:6px; border:0; cursor:pointer; font-family:inherit; }
  .tile .menubtn:hover { background:var(--overlay-bg-strong); }

  /* Skeleton loader tiles */
  .skel { border-radius:10px; border:1px solid var(--tile-border); aspect-ratio:16/9; position:relative; overflow:hidden; background:var(--skeleton-1); }
  .skel::after { content:""; position:absolute; inset:0; background:linear-gradient(90deg, transparent, var(--skeleton-2), transparent); transform:translateX(-100%); animation:shimmer 1.3s infinite; }
  @keyframes shimmer { 100% { transform:translateX(100%); } }

  /* ---------- Popover menu (in-widget, replaces prompt/alert) ---------- */
  .popover { position:absolute; z-index:50; min-width:200px; background:var(--panel); border:1px solid var(--border); border-radius:10px; box-shadow:var(--menu-shadow); padding:5px; }
  .popover button { display:block; width:100%; text-align:left; background:transparent; border:0; color:var(--fg); font-size:13px; font-family:inherit; padding:8px 10px; border-radius:6px; cursor:pointer; }
  .popover button:hover { background:var(--panel-2); }
  .popover .rename-row { display:flex; gap:6px; padding:6px; }
  .popover .rename-row input { flex:1; min-width:0; padding:6px 8px; border-radius:6px; border:1px solid var(--border); background:var(--input-bg); color:var(--input-fg); font-size:13px; font-family:inherit; }
  .popover .rename-row .mini { padding:6px 10px; border-radius:6px; border:0; background:var(--accent); color:var(--accent-ink); font-weight:600; cursor:pointer; font-size:13px; }
  .popover .rename-row .mini.secondary { background:transparent; border:1px solid var(--border); color:var(--fg); font-weight:500; }

  /* ---------- Preview pane ---------- */
  .preview { display:none; margin-top:16px; padding:14px; border:1px solid var(--border); border-radius:12px; background:var(--panel); }
  .preview.open { display:block; }
  .preview-head { display:flex; align-items:center; gap:8px; margin-bottom:10px; flex-wrap:wrap; }
  .preview-head .ptitle { font-weight:600; font-size:14px; color:var(--fg); }
  .preview-head .pclose { margin-left:auto; background:transparent; border:0; color:var(--muted); font-size:18px; cursor:pointer; line-height:1; padding:2px 6px; }
  .preview-stage { position:relative; max-width:100%; }
  .preview-stage img.single { display:block; max-width:100%; height:auto; border-radius:10px; }
  .preview-prompt { font-size:12px; color:var(--muted); margin-top:8px; white-space:pre-wrap; }
  .preview-actions { display:flex; gap:8px; margin-top:12px; flex-wrap:wrap; }
  .preview-actions button { padding:8px 13px; border-radius:8px; border:1px solid var(--border); background:var(--panel); color:var(--fg); font-size:13px; font-family:inherit; cursor:pointer; }
  .preview-actions button.primary { background:var(--accent); color:var(--accent-ink); border:0; font-weight:600; }
  .preview-actions button:disabled { opacity:.5; cursor:default; }
  .preview-rename { display:none; gap:6px; margin-top:10px; }
  .preview-rename.open { display:flex; }
  .preview-rename input { flex:1; padding:8px 10px; border-radius:8px; border:1px solid var(--border); background:var(--input-bg); color:var(--input-fg); font-size:13px; font-family:inherit; }
  .preview-rename button { padding:8px 12px; border-radius:8px; border:0; background:var(--accent); color:var(--accent-ink); font-weight:600; cursor:pointer; font-size:13px; }
  .preview-rename button.secondary { background:transparent; border:1px solid var(--border); color:var(--fg); font-weight:500; }
  .compare-hint { font-size:12px; color:var(--accent); font-weight:600; margin-top:8px; display:none; }
  .compare-hint.show { display:block; }

  /* Before/after slider */
  .cmp { position:relative; max-width:100%; border-radius:10px; overflow:hidden; user-select:none; touch-action:none; }
  .cmp img { display:block; width:100%; height:auto; }
  .cmp .after-wrap { position:absolute; top:0; left:0; bottom:0; overflow:hidden; }
  /* The inner img is pinned to the FULL pane width via JS so the wrapper clips
     (reveals) it — sizing it to the wrapper would rescale it as the divider moves. */
  .cmp .after-wrap img { position:absolute; top:0; left:0; height:100%; max-width:none; object-fit:cover; }
  .cmp .divider { position:absolute; top:0; bottom:0; width:2px; background:var(--accent); cursor:ew-resize; }
  .cmp .divider::after { content:""; position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); width:28px; height:28px; border-radius:50%; background:var(--accent); box-shadow:0 1px 6px rgba(0,0,0,.4); }
  .cmp .cmp-lab { position:absolute; top:8px; background:var(--overlay-bg); color:var(--overlay-ink); font-size:11px; padding:2px 7px; border-radius:6px; pointer-events:none; }
  .cmp .cmp-lab.left { left:8px; }
  .cmp .cmp-lab.right { right:8px; }
  .cmp-side { display:flex; gap:8px; }
  .cmp-side figure { flex:1; margin:0; min-width:0; }
  .cmp-side figure img { width:100%; height:auto; border-radius:10px; display:block; }
  .cmp-side figcaption { font-size:11px; color:var(--muted); margin-top:4px; text-align:center; }

  /* ---------- Refine form: options row, prompt, then Job (left) + Generate (right) ---------- */
  .refine { margin-top:14px; }
  .refine textarea { width:100%; margin-top:8px; padding:9px 11px; border-radius:8px; border:1px solid var(--border); background:var(--input-bg); color:var(--input-fg); font-size:13px; font-family:inherit; line-height:1.45; min-height:38px; max-height:240px; resize:vertical; overflow-y:auto; }
  /* Options bar is ONE row: controls shrink (and, last resort, scroll) instead of wrapping. */
  .toolbar { display:flex; gap:6px; flex-wrap:nowrap; align-items:center; overflow-x:auto; scrollbar-width:none; }
  .toolbar::-webkit-scrollbar { display:none; }
  .toolbar > * { flex:0 1 auto; min-width:0; }
  .toolbar .tspacer { flex:1 1 0; }
  .toolbar select { flex-shrink:0; }
  /* Narrow (phone) widths: icon-only buttons so the row still fits without clipping text. */
  @media (max-width: 520px) { .toolbar .tlabel { display:none; } }
  .toolbar select { padding:6px 4px; border-radius:7px; border:1px solid var(--border); font-size:12px; background:var(--input-bg); color:var(--input-fg); font-family:inherit; }
  .upload { display:inline-flex; align-items:center; padding:6px 9px; border-radius:7px; border:1px solid var(--border); background:var(--panel); color:var(--fg); font-size:12px; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .editbtn, .exportbtn { padding:6px 9px; border-radius:7px; border:1px solid var(--border); background:var(--panel); color:var(--fg); cursor:pointer; font-size:12px; font-family:inherit; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .editbtn:disabled, .exportbtn:disabled { opacity:.5; cursor:default; }
  /* Selections picker: the job's product images, used as product references. */
  .selpanel { display:none; margin-top:8px; max-height:320px; overflow-y:auto; border:1px solid var(--border); border-radius:10px; padding:8px; background:var(--panel); }
  .selpanel.open { display:block; }
  .selhead { display:flex; justify-content:space-between; gap:8px; font-size:12px; color:var(--muted); margin-bottom:8px; }
  .selhead button { border:0; background:transparent; color:var(--muted); cursor:pointer; font-size:12px; font-family:inherit; padding:0; }
  .selgrid { display:grid; grid-template-columns:repeat(auto-fill, minmax(104px, 1fr)); gap:8px; }
  .selitem { position:relative; border:2px solid transparent; border-radius:8px; background:var(--panel-2); cursor:pointer; padding:4px; text-align:left; font-family:inherit; color:var(--fg); }
  .selitem.on { border-color:var(--accent); }
  .selitem img { display:block; width:100%; aspect-ratio:1; object-fit:contain; background:#fff; border-radius:5px; }
  .selitem .sname { font-size:11px; margin-top:4px; line-height:1.25; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
  .selitem .sgroup { font-size:10px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .selitem .lowres { position:absolute; top:7px; left:7px; font-size:9px; background:var(--overlay-bg); color:var(--overlay-ink); padding:1px 5px; border-radius:5px; }
  .selitem .check { position:absolute; top:7px; right:7px; width:18px; height:18px; border-radius:50%; background:var(--accent); color:var(--accent-ink); font-size:11px; font-weight:700; display:none; align-items:center; justify-content:center; }
  .selitem.on .check { display:flex; }
  .selchips { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
  .selchips:empty { display:none; }
  .selchip { display:inline-flex; align-items:center; gap:2px; font-size:11px; padding:3px 3px 3px 9px; border-radius:999px; border:1px solid var(--accent); background:var(--panel); color:var(--fg); }
  .selchip button { border:0; background:transparent; color:var(--muted); cursor:pointer; font-size:14px; line-height:1; padding:0 5px; }
  .actionrow { display:flex; gap:8px; align-items:center; margin-top:8px; }
  .actionrow .tspacer { flex:1 1 0; }
  /* Generate is the ONLY accent (primary) button; Edit/Export are neutral. */
  #refineBtn { flex:0 0 auto; padding:9px 18px; border-radius:8px; border:0; background:var(--accent); color:var(--accent-ink); font-weight:600; cursor:pointer; font-family:inherit; font-size:13px; }
  #refineBtn:disabled { opacity:.5; cursor:default; }
  /* Job pick list: in normal flow under the Job box, so the widget grows instead of clipping it. */
  .jobresults { display:none; margin-top:6px; max-height:260px; overflow-y:auto; background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:4px; }
  .jobresults.open { display:block; }
  .jobresults button { display:block; width:100%; text-align:left; background:transparent; border:0; color:var(--fg); font-size:12px; font-family:inherit; padding:7px 9px; border-radius:6px; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .jobresults button:hover, .jobresults button.active { background:var(--panel-2); }
  .jobresults .jnum { font-weight:600; }
  .jobresults .jmuted { color:var(--muted); }
  .jobresults .jempty, .jobresults .jfoot { font-size:12px; color:var(--muted); padding:7px 9px; }
  .tile .savedbadge { position:absolute; bottom:6px; left:6px; background:var(--overlay-bg); color:var(--overlay-ink); font-size:11px; padding:2px 7px; border-radius:6px; pointer-events:none; }
  .popover.inline { position:static; display:inline-block; margin-top:10px; box-shadow:none; }
  .popover .save-form { display:flex; flex-direction:column; gap:8px; padding:8px; min-width:240px; }
  .popover .save-form .stitle { font-size:12px; font-weight:600; color:var(--fg); }
  .popover .save-form input[type=text] { padding:6px 8px; border-radius:6px; border:1px solid var(--border); background:var(--input-bg); color:var(--input-fg); font-size:13px; font-family:inherit; }
  .popover .save-form label { font-size:12px; color:var(--muted); display:flex; align-items:center; gap:6px; }
  .popover .save-form .srow { display:flex; gap:6px; }
  .popover .save-form .mini { padding:6px 10px; border-radius:6px; border:0; background:var(--accent); color:var(--accent-ink); font-weight:600; cursor:pointer; font-size:13px; }
  .popover .save-form .mini.secondary { background:transparent; border:1px solid var(--border); color:var(--fg); font-weight:500; }
  .popover .save-form .mini:disabled { opacity:.5; cursor:default; }
  #jobTag { flex:0 1 340px; min-width:0; padding:8px 10px; border-radius:8px; border:1px solid var(--border); background:var(--input-bg); color:var(--input-fg); font-size:12px; font-family:inherit; }
  #variationAxes { display:none; width:100%; margin-top:8px; padding:8px 10px; border-radius:8px; border:1px solid var(--border); background:var(--input-bg); color:var(--input-fg); font-size:12px; font-family:inherit; }
  #variationAxes.show { display:block; }

  .refname { font-size:11px; color:var(--muted); margin-top:6px; display:block; min-height:14px; }
  .note { font-size:12px; color:var(--muted); margin-top:8px; white-space:pre-wrap; }

  /* Drag-over highlight for drop-anywhere */
  .wrap.dragging::after { content:"Drop image to use as reference"; position:fixed; inset:10px; border:3px dashed var(--accent); border-radius:16px; background:var(--drop-highlight); display:flex; align-items:center; justify-content:center; font-weight:600; color:var(--fg); font-size:15px; z-index:200; pointer-events:none; }

  /* ---------- Area editor ---------- */
  .editor { display:none; margin-top:14px; padding:12px; border:1px solid var(--border); border-radius:10px; background:var(--panel); }
  .editor.open { display:block; }
  .editor h3 { margin:0 0 8px; font-size:13px; font-weight:600; color:var(--fg); }
  .editor-canvas-wrap { position:relative; display:inline-block; max-width:100%; }
  .editor-base, .editor-overlay { display:block; max-width:100%; height:auto; border-radius:8px; }
  .editor-overlay { position:absolute; left:0; top:0; cursor:crosshair; touch-action:none; }
  .editor-tools { display:flex; gap:8px; align-items:center; margin-top:10px; flex-wrap:wrap; }
  .editor-tools label { font-size:12px; color:var(--muted); display:inline-flex; align-items:center; gap:6px; }
  .editor-tools input[type=range] { width:120px; }
  .editor-tools textarea { flex:1; min-width:220px; padding:9px 11px; border-radius:8px; border:1px solid var(--border); background:var(--input-bg); color:var(--input-fg); font-size:13px; font-family:inherit; line-height:1.45; min-height:38px; max-height:200px; resize:vertical; overflow-y:auto; }
  .editor-tools button { padding:9px 14px; border-radius:8px; border:0; background:var(--accent); color:var(--accent-ink); font-weight:600; cursor:pointer; font-family:inherit; }
  .editor-tools button.secondary { background:var(--panel); border:1px solid var(--border); color:var(--fg); font-weight:500; }
</style>
</head>
<body>
  <div class="wrap" id="wrap">
    <div class="badge"><span class="dot"></span> Nano Banana render</div>
    <div class="statusrow">
      <div id="status" class="status">Connecting&hellip;</div>
      <div id="cost" class="cost"></div>
    </div>
    <div id="gallery" class="gallery"></div>

    <!-- Large preview pane -->
    <div id="preview" class="preview">
      <div class="preview-head">
        <span id="previewTitle" class="ptitle"></span>
        <button id="previewClose" class="pclose" title="Close preview">&times;</button>
      </div>
      <div id="previewStage" class="preview-stage"></div>
      <div id="comparePicking" class="compare-hint">Compare mode: click another tile to pick the comparison partner.</div>
      <div id="previewPrompt" class="preview-prompt"></div>
      <div class="preview-rename" id="previewRename">
        <input id="previewRenameInput" type="text" placeholder="New label" />
        <button id="previewRenameSave">Save</button>
        <button id="previewRenameCancel" class="secondary">Cancel</button>
      </div>
      <div class="preview-actions" id="previewActions"></div>
      <div id="previewSave"></div>
    </div>

    <!-- Refine form: one options row, the prompt box, then Job (left) + Generate (right) -->
    <form id="refine" class="refine">
      <div class="toolbar">
        <label class="upload" title="Upload a reference photo">&#128206;<span class="tlabel">&nbsp;Reference</span><input id="refFile" type="file" accept="image/*" hidden /></label>
        <button id="selBtn" type="button" class="editbtn" title="Use products from the picked job's selections (cabinet pulls, faucets, tile...)">&#127991;<span class="tlabel">&nbsp;Selections</span></button>
        <select id="mode" title="Room: remodel photo style that keeps the room's geometry. General: flyers, social posts, mockups, anything else.">
          <option value="room">Room</option>
          <option value="general">General</option>
        </select>
        <select id="variations" title="Number of variations">
          <option value="1">1&times;</option>
          <option value="2">2&times;</option>
          <option value="3">3&times;</option>
          <option value="4">4&times;</option>
          <option value="6">6&times;</option>
        </select>
        <select id="model" title="Flash: fast and cheap (~$0.04). Pro: best quality (~$0.13).">
          <option value="flash">Flash</option>
          <option value="pro">Pro</option>
        </select>
        <span class="tspacer"></span>
        <button id="editBtn" type="button" class="editbtn" title="Paint over an area to edit just that region">&#9999;<span class="tlabel">&nbsp;Edit area</span></button>
        <button id="exportBtn" type="button" class="exportbtn" title="Compose all renders onto one sheet to share">&#128228;<span class="tlabel">&nbsp;Export</span></button>
      </div>
      <div id="selChips" class="selchips"></div>
      <div id="selPanel" class="selpanel"></div>
      <textarea id="instruction" rows="1" placeholder="Describe the change, or 'apply these finishes' with a reference (Enter to submit, Shift+Enter for newline)"></textarea>
      <div class="actionrow">
        <input id="jobTag" type="text" placeholder="Job &mdash; click to pick, or type a number or name" autocomplete="off" title="Pick a JobTread job: renders are tagged with it, and Save to JobTread files them there" />
        <span class="tspacer"></span>
        <button id="refineBtn" type="submit">Generate</button>
      </div>
      <div id="jobResults" class="jobresults"></div>
      <input id="variationAxes" type="text" placeholder="What should vary between variations? (e.g. backsplash + hardware)" />
    </form>
    <span id="refName" class="refname"></span>
    <div id="note" class="note"></div>

    <!-- Area editor -->
    <div id="editor" class="editor">
      <h3>Paint over the area to change (red). Then describe the change &mdash; or attach a product photo to drop into that area &mdash; and Apply.</h3>
      <div class="editor-canvas-wrap">
        <canvas id="editBase" class="editor-base"></canvas>
        <canvas id="editOverlay" class="editor-overlay"></canvas>
      </div>
      <div class="editor-tools">
        <label>Brush <input id="brushSize" type="range" min="6" max="80" value="28" /></label>
        <label><input id="fillMode" type="checkbox" /> Fill mode (click inside a closed outline)</label>
        <button id="clearMask" type="button" class="secondary">Clear mask</button>
        <label class="upload">&#128206; Area reference<input id="editRefFile" type="file" accept="image/*" hidden /></label>
        <textarea id="editInstruction" rows="1" placeholder="What to change in the highlighted area (e.g. &quot;remove this light fixture&quot;, or attach a photo above and say &quot;install these&quot;)"></textarea>
        <button id="applyEdit" type="button">Apply edit</button>
        <button id="cancelEdit" type="button" class="secondary">Close</button>
      </div>
      <span id="editRefName" class="refname"></span>
    </div>
  </div>
  <script type="module">
    import { App } from "https://esm.sh/@modelcontextprotocol/ext-apps@1.7.2/app-with-deps";

    // Injected server-side from the PUBLIC_ORIGIN var (see src/mcp.ts init()).
    var WORKER_ORIGIN = "__WORKER_ORIGIN__";
    // "true" when the JOBTREAD_GRANT_KEY secret is set; otherwise the job picker,
    // Selections, and Save to JobTread are hidden and the Job box is a plain tag.
    var JOBTREAD_ENABLED = "__JOBTREAD_ENABLED__" === "true";
    // Injected server-side when the resource is served (empty when /upload is open).
    // This HTML only travels over the gated MCP connection, so authorized clients only.
    var UPLOAD_TOKEN = "__UPLOAD_TOKEN__";

    // ---------- Cost estimates (used only when structuredContent lacks the field) ----------
    var COST_FLASH = 0.039, COST_PRO = 0.134, COST_UPSCALE = 0.24;

    // ---------- Element handles ----------
    var wrapEl = document.getElementById("wrap");
    var statusEl = document.getElementById("status");
    var costEl = document.getElementById("cost");
    var galleryEl = document.getElementById("gallery");
    var noteEl = document.getElementById("note");
    var btn = document.getElementById("refineBtn");
    var editBtnEl = document.getElementById("editBtn");
    var exportBtnEl = document.getElementById("exportBtn");
    var modelSel = document.getElementById("model");
    var modeSel = document.getElementById("mode");
    var variationsSel = document.getElementById("variations");
    var variationAxesEl = document.getElementById("variationAxes");
    var jobTagEl = document.getElementById("jobTag");
    if (!JOBTREAD_ENABLED) {
      jobTagEl.placeholder = "Project tag (optional) \u2014 e.g. smith-kitchen";
      jobTagEl.title = "Renders are stored with this tag so you can find them later (list_renders).";
    }
    // These now live inside the form — Enter must not fire a (paid) generate.
    [variationAxesEl].forEach(function (el) {
      el.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); try { el.blur(); } catch (er) {} }
      });
    });
    var refFile = document.getElementById("refFile");
    var refName = document.getElementById("refName");

    // ---------- State ----------
    // History entries: { data?, url?, mimeType, label, kind, filename?, prompt? }
    var history = [];
    var baseIndex = -1;
    var previewIndex = -1;
    var comparePartner = -1;     // index of chosen compare partner (-1 = auto)
    var compareOff = false;      // user chose Single view; stays off until they pick a compare again
    var comparePickMode = false; // clicking a tile picks the partner
    var compareView = "slider";  // "slider" | "side"
    var comparePct = 50;         // slider divider position (% from left) — export uses it
    var styleAnchorIdxs = [];    // pinned tiles (mood board)
    var MAX_STYLE_ANCHORS = 3;
    var pendingRef = null;       // uploaded reference photo {data, mimeType}
    var renderCounter = 0;
    var restoreCounter = 0;
    var sessionCost = 0;
    var userTouchedModel = false;
    var inFlight = false;
    var skeletonCount = 0;

    function esc(s) { return String(s == null ? "" : s); }

    // ---------- JobTread job picker ----------
    // Pick list of every open job, loaded once (list_open_jobs) and filtered
    // locally as you type. selectedJob is set only by picking from the list;
    // free text left unpicked still goes out as a plain job_tag (older behaviour).
    var selectedJob = null; // { jobId, number, name, customer }
    var jobResultsEl = document.getElementById("jobResults");
    var allJobs = null;     // null until loaded
    var jobsLoading = null; // in-flight promise
    var jobsError = "";
    var jobMatches = [];
    var jobActive = -1;
    var jobSearchSeq = 0;
    var JOB_LIST_MAX = 60;

    function addJobArgs(args) {
      if (selectedJob) { args.job_id = selectedJob.jobId; args.job_tag = selectedJob.number; return; }
      var jt = jobTagEl.value.trim();
      if (jt) args.job_tag = jt;
    }
    function jobLabel(j) { return j.number + " \\u00b7 " + j.name; }
    function loadJobs() {
      if (allJobs) return Promise.resolve();
      if (jobsLoading) return jobsLoading;
      if (!app || typeof app.callServerTool !== "function") return Promise.resolve();
      jobsLoading = app.callServerTool({ name: "list_open_jobs", arguments: {} }, { timeout: 30000 })
        .then(function (r) {
          var sc = (r && r.structuredContent) ? r.structuredContent : {};
          if (Array.isArray(sc.jobs)) { allJobs = sc.jobs; jobsError = ""; }
          else jobsError = (r && r.content && r.content[0] && r.content[0].text) || "Couldn't load jobs.";
        })
        .catch(function (err) { jobsError = "Couldn't load jobs: " + (err && err.message ? err.message : err); })
        .then(function () {
          jobsLoading = null;
          if (jobResultsEl.classList.contains("open")) refreshJobList();
        });
      return jobsLoading;
    }
    function filterJobs(q) {
      var tokens = q.toLowerCase().split(/\\s+/).filter(Boolean);
      if (!tokens.length) return allJobs.slice();
      return allJobs.filter(function (j) {
        var hay = (j.number + " " + j.name + " " + (j.customer || "")).toLowerCase();
        return tokens.every(function (t) { return hay.indexOf(t) >= 0; });
      });
    }
    function closeJobResults() { jobResultsEl.classList.remove("open"); jobActive = -1; }
    function pickJob(j) {
      if (!selectedJob || selectedJob.jobId !== j.jobId) clearSelections();
      selectedJob = j;
      jobTagEl.value = jobLabel(j);
      closeJobResults();
      setStatus("Job set: " + jobLabel(j) + ". New renders are tagged with it; use \\u2026 \\u2192 Save to JobTread to file one there.");
    }
    function paintJobResults(note) {
      clearNode(jobResultsEl);
      if (note) {
        var e = document.createElement("div");
        e.className = "jempty";
        e.textContent = note;
        jobResultsEl.appendChild(e);
      }
      var shown = jobMatches.slice(0, JOB_LIST_MAX);
      shown.forEach(function (j, i) {
        var b = document.createElement("button");
        b.type = "button";
        if (i === jobActive) b.className = "active";
        var num = document.createElement("span");
        num.className = "jnum";
        num.textContent = j.number;
        b.appendChild(num);
        b.appendChild(document.createTextNode(" \\u00b7 " + j.name));
        if (j.customer) {
          var m = document.createElement("span");
          m.className = "jmuted";
          m.textContent = " \\u2014 " + j.customer;
          b.appendChild(m);
        }
        if (selectedJob && selectedJob.jobId === j.jobId) b.appendChild(document.createTextNode("  \\u2713"));
        // mousedown (not click) so it fires before the input's blur closes the list.
        b.addEventListener("mousedown", function (ev) { ev.preventDefault(); pickJob(j); });
        jobResultsEl.appendChild(b);
      });
      if (jobMatches.length > shown.length) {
        var f = document.createElement("div");
        f.className = "jfoot";
        f.textContent = "Showing " + shown.length + " of " + jobMatches.length + " open jobs \\u2014 type to narrow.";
        jobResultsEl.appendChild(f);
      }
      jobResultsEl.classList.add("open");
      var act = jobResultsEl.querySelector("button.active");
      if (act) { try { act.scrollIntoView({ block: "nearest" }); } catch (er) {} }
    }
    function refreshJobList() {
      if (!JOBTREAD_ENABLED) { closeJobResults(); return; } // free-text project tag only
      // With a job already picked, show the whole list (the box holds its label, not a query).
      var q = selectedJob ? "" : jobTagEl.value.trim();
      if (allJobs) {
        jobMatches = filterJobs(q);
        jobActive = jobMatches.length ? 0 : -1;
        paintJobResults(jobMatches.length ? "" : (q ? "No open jobs match \\u201c" + q + "\\u201d." : "No open jobs."));
        // A job opened after the list loaded won't be local yet; ask the server.
        if (!jobMatches.length && q.length >= 2) searchJobsServer(q);
        return;
      }
      jobMatches = [];
      paintJobResults(jobsError && !jobsLoading ? jobsError : "Loading jobs\\u2026");
      loadJobs();
    }
    function searchJobsServer(q) {
      var seq = ++jobSearchSeq;
      app.callServerTool({ name: "find_job", arguments: { query: q, limit: 8 } }, { timeout: 20000 })
        .then(function (r) {
          if (seq !== jobSearchSeq || jobTagEl.value.trim() !== q) return; // superseded
          var sc = (r && r.structuredContent) ? r.structuredContent : {};
          var found = Array.isArray(sc.jobs) ? sc.jobs : [];
          if (!found.length) return;
          jobMatches = found;
          jobActive = 0;
          paintJobResults();
        })
        .catch(function () {});
    }
    jobTagEl.addEventListener("focus", function () {
      try { jobTagEl.select(); } catch (er) {}
      refreshJobList();
    });
    jobTagEl.addEventListener("click", function () {
      if (!jobResultsEl.classList.contains("open")) refreshJobList();
    });
    jobTagEl.addEventListener("input", function () {
      selectedJob = null;
      refreshJobList();
    });
    // Lives inside the form: Enter must pick a job (or just blur), never fire a paid generate.
    jobTagEl.addEventListener("keydown", function (e) {
      var open = jobResultsEl.classList.contains("open") && jobMatches.length > 0;
      var visible = Math.min(jobMatches.length, JOB_LIST_MAX);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (!jobResultsEl.classList.contains("open")) { refreshJobList(); return; }
        if (open) { jobActive = (jobActive + 1) % visible; paintJobResults(); }
      }
      else if (e.key === "ArrowUp" && open) { e.preventDefault(); jobActive = (jobActive - 1 + visible) % visible; paintJobResults(); }
      else if (e.key === "Enter") {
        e.preventDefault();
        if (open && jobActive >= 0) pickJob(jobMatches[jobActive]);
        else { try { jobTagEl.blur(); } catch (er) {} }
      }
      else if (e.key === "Escape") { closeJobResults(); }
    });
    jobTagEl.addEventListener("blur", function () { setTimeout(closeJobResults, 150); });


    // ---------- Selections picker (job product images → product references) ----------
    var selBtnEl = document.getElementById("selBtn");
    if (!JOBTREAD_ENABLED) selBtnEl.style.display = "none";
    var selPanelEl = document.getElementById("selPanel");
    var selChipsEl = document.getElementById("selChips");
    var selCache = {};     // jobId -> { images, lowResKb }
    var selChosen = [];    // chosen images (max SEL_MAX), in pick order = PRODUCT REFERENCE 1, 2...
    var SEL_MAX = 4;

    function selName(img) {
      var n = (img.item || "").replace(/\\s+specification$/i, "").trim();
      // Budget lines are often ALL CAPS ("MAIN LEVEL SHOWER WALL TILE") — soften for display.
      if (n && n === n.toUpperCase()) n = n.toLowerCase().replace(/\\b[a-z]/g, function (c) { return c.toUpperCase(); });
      return n || img.fileName;
    }
    function addProductArgs(args) {
      if (selChosen.length) args.product_reference_urls = selChosen.map(function (i) { return i.url; });
    }
    function paintSelChips() {
      clearNode(selChipsEl);
      selChosen.forEach(function (img, k) {
        var chip = document.createElement("span");
        chip.className = "selchip";
        chip.title = (img.group ? img.group + " — " : "") + img.fileName;
        chip.appendChild(document.createTextNode("🏷 " + (selChosen.length > 1 ? (k + 1) + ". " : "") + selName(img)));
        var x = document.createElement("button");
        x.type = "button";
        x.textContent = "×";
        x.title = "Remove";
        x.addEventListener("click", function () { toggleSel(img); });
        chip.appendChild(x);
        selChipsEl.appendChild(chip);
      });
    }
    function toggleSel(img) {
      var at = -1;
      for (var i = 0; i < selChosen.length; i++) if (selChosen[i].fileId === img.fileId) at = i;
      if (at >= 0) selChosen.splice(at, 1);
      else if (selChosen.length >= SEL_MAX) { setStatus("Up to " + SEL_MAX + " products per render — remove one first.", true); return; }
      else selChosen.push(img);
      paintSelChips();
      if (selPanelEl.classList.contains("open")) paintSelPanel();
      if (selChosen.length) {
        setStatus(selChosen.length + " product" + (selChosen.length > 1 ? "s" : "") + " selected — say where to use " + (selChosen.length > 1 ? "them" : "it") +
          ", e.g. “install the " + selName(selChosen[0]).toLowerCase() + " on every drawer”, then Generate (or use Edit area).");
      }
    }
    function clearSelections() {
      selChosen = [];
      paintSelChips();
      selPanelEl.classList.remove("open");
    }
    function paintSelPanel() {
      clearNode(selPanelEl);
      var job = selectedJob;
      var entry = job ? selCache[job.jobId] : null;
      var head = document.createElement("div");
      head.className = "selhead";
      var label = document.createElement("span");
      head.appendChild(label);
      var close = document.createElement("button");
      close.type = "button";
      close.textContent = "Close";
      close.addEventListener("click", function () { selPanelEl.classList.remove("open"); });
      head.appendChild(close);
      selPanelEl.appendChild(head);
      if (!entry) { label.textContent = "Loading selections for " + (job ? job.number : "the job") + "…"; return; }
      if (entry.error) { label.textContent = entry.error; return; }
      if (!entry.images.length) { label.textContent = "No product images on " + job.number + "'s budget lines or in its selections folder."; return; }
      label.textContent = job.number + " selections — click up to " + SEL_MAX + " to use as products.";
      var grid = document.createElement("div");
      grid.className = "selgrid";
      entry.images.forEach(function (img) {
        var on = selChosen.some(function (c) { return c.fileId === img.fileId; });
        var b = document.createElement("button");
        b.type = "button";
        b.className = "selitem" + (on ? " on" : "");
        b.title = selName(img) + (img.group ? " (" + img.group + ")" : "") + " — " + img.fileName;
        var im = document.createElement("img");
        im.loading = "lazy";
        im.alt = "";
        im.src = img.thumbUrl;
        b.appendChild(im);
        if (img.sizeKb < (entry.lowResKb || 8)) {
          var lr = document.createElement("span");
          lr.className = "lowres";
          lr.textContent = "low-res";
          lr.title = "Small product image — the render will match its style and finish, not every detail. Attach a full-size product photo in JobTread for an exact match.";
          b.appendChild(lr);
        }
        var ck = document.createElement("span");
        ck.className = "check";
        ck.textContent = "✓";
        b.appendChild(ck);
        var nm = document.createElement("div");
        nm.className = "sname";
        nm.textContent = selName(img);
        b.appendChild(nm);
        if (img.group) {
          var gp = document.createElement("div");
          gp.className = "sgroup";
          gp.textContent = img.group;
          b.appendChild(gp);
        }
        b.addEventListener("click", function () { toggleSel(img); });
        grid.appendChild(b);
      });
      selPanelEl.appendChild(grid);
    }
    function loadSelections(job) {
      if (selCache[job.jobId]) return;
      app.callServerTool({ name: "list_job_selections", arguments: { job_id: job.jobId } }, { timeout: 60000 })
        .then(function (r) {
          var sc = (r && r.structuredContent) ? r.structuredContent : {};
          selCache[job.jobId] = Array.isArray(sc.images)
            ? { images: sc.images, lowResKb: sc.lowResKb || 8 }
            : { images: [], error: (r && r.content && r.content[0] && r.content[0].text) || "Couldn't load selections." };
        })
        .catch(function (err) { selCache[job.jobId] = { images: [], error: "Couldn't load selections: " + (err && err.message ? err.message : err) }; })
        .then(function () {
          // Repaint only if the panel is still showing this job.
          if (selPanelEl.classList.contains("open") && selectedJob && selectedJob.jobId === job.jobId) paintSelPanel();
          if (selCache[job.jobId] && selCache[job.jobId].error) delete selCache[job.jobId]; // retry next open
        });
    }
    selBtnEl.addEventListener("click", function () {
      if (!selectedJob) {
        setStatus("Pick a job first — the Selections button shows that job's products.", true);
        try { jobTagEl.focus(); } catch (e) {}
        return;
      }
      if (selPanelEl.classList.contains("open")) { selPanelEl.classList.remove("open"); return; }
      selPanelEl.classList.add("open");
      paintSelPanel();
      loadSelections(selectedJob);
    });

    // ---------- Save to JobTread ----------
    function jobFilesUrl(jobId) { return "https://app.jobtread.com/jobs/" + jobId + "/files"; }
    function defaultRoom(im) {
      var l = (im.label || "").trim();
      if (!l || /^(v|r)\\d+$/i.test(l) || l === "Source") return "";
      return l;
    }
    // host: the gallery tile (floating popover) or previewSaveEl (inline under the preview buttons).
    function startSave(idx, host) {
      closePopover();
      var im = history[idx];
      if (!im || !im.filename) {
        setStatus("Only generated renders can be saved to JobTread \\u2014 generate one from this reference first.", true);
        return;
      }
      if (!selectedJob) {
        setStatus("Pick a job first \\u2014 type a job number or name in the Job box, then choose it from the list.", true);
        try { jobTagEl.focus(); } catch (e) {}
        return;
      }
      if (!host) return;
      var inline = host === previewSaveEl;
      var job = selectedJob;
      var pop = document.createElement("div");
      pop.className = inline ? "popover inline" : "popover";
      pop.addEventListener("click", function (e) { e.stopPropagation(); });
      var form = document.createElement("div");
      form.className = "save-form";
      var title = document.createElement("div");
      title.className = "stitle";
      title.textContent = "Save to " + job.number + " \\u00b7 " + job.name;
      var room = document.createElement("input");
      room.type = "text";
      room.placeholder = "Room (e.g. Kitchen)";
      room.maxLength = 40;
      room.value = defaultRoom(im);
      var lab = document.createElement("label");
      var chk = document.createElement("input");
      chk.type = "checkbox";
      lab.appendChild(chk);
      lab.appendChild(document.createTextNode("Mark as latest for this room"));
      var row = document.createElement("div");
      row.className = "srow";
      var save = document.createElement("button");
      save.type = "button";
      save.className = "mini";
      save.textContent = "Save";
      var cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "mini secondary";
      cancel.textContent = "Cancel";
      function submit() {
        var r = room.value.trim();
        if (!r) { try { room.focus(); } catch (e) {} return; }
        closePopover();
        saveToJob(idx, job, r, chk.checked);
      }
      save.addEventListener("click", submit);
      cancel.addEventListener("click", function () { closePopover(); });
      room.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); submit(); }
        else if (e.key === "Escape") { closePopover(); }
      });
      row.appendChild(save); row.appendChild(cancel);
      form.appendChild(title); form.appendChild(room); form.appendChild(lab); form.appendChild(row);
      pop.appendChild(form);
      if (inline) {
        clearNode(host);
        host.appendChild(pop);
      } else {
        host.appendChild(pop);
        positionPopover(pop, host);
      }
      openPopover = pop;
      try { pop.scrollIntoView({ block: "nearest" }); room.focus(); } catch (e) {}
    }
    function saveToJob(idx, job, room, markLatest) {
      var im = history[idx];
      setStatus("Saving " + labelAt(idx) + " to " + job.number + "\\u2026");
      app.callServerTool({
        name: "save_render_to_job",
        arguments: { render: im.filename, job_id: job.jobId, room: room, mark_latest: !!markLatest },
      }, { timeout: 60000 })
        .then(function (r) {
          var sc = (r && r.structuredContent) ? r.structuredContent : {};
          var t = (r && r.content && r.content[0] && r.content[0].text) || "";
          // Status shows the plain-language lines; the bare link becomes a preview button.
          var msg = t.split("\\n").filter(function (l) { return l.indexOf("https://") !== 0; }).join(" ");
          if (!sc.saved) { setStatus(msg || "Save failed.", true); return; }
          im.jt = { jobId: sc.jobId || job.jobId, jobNumber: sc.jobNumber || job.number, fileName: sc.fileName || "" };
          paintGallery();
          if (previewIndex === idx) openPreview(idx);
          setStatus(msg);
        })
        .catch(function (err) { setStatus("Save to JobTread failed: " + (err && err.message ? err.message : err), true); });
    }

    // ---------- History helpers ----------
    function pushRender(data, mimeType, url, prompt, filename) {
      renderCounter += 1;
      history.push({ data: data, url: url || undefined, mimeType: mimeType, label: "v" + renderCounter, kind: "render", prompt: prompt || undefined, filename: filename || undefined });
      return history.length - 1;
    }
    function pushSource(data, mimeType) {
      history.push({ data: data, mimeType: mimeType, label: "Source", kind: "source" });
      baseIndex = history.length - 1;
      return baseIndex;
    }
    function labelAt(idx) { return idx >= 0 && idx < history.length ? history[idx].label : "?"; }
    function entrySrc(im) {
      if (im.url) return im.url;
      return "data:" + (im.mimeType || "image/png") + ";base64," + im.data;
    }
    function makeImg(im) {
      var img = new Image();
      if (im.url) img.crossOrigin = "anonymous";
      img.src = entrySrc(im);
      return img;
    }

    function addCost(sc, model, imageCount) {
      var c = (sc && typeof sc.estimatedCostUsd === "number") ? sc.estimatedCostUsd : null;
      if (c == null) {
        var n = imageCount || 1;
        if (model === "upscale") c = COST_UPSCALE;
        else c = (model === "pro" ? COST_PRO : COST_FLASH) * n;
      }
      sessionCost += c;
      renderCost();
    }
    function renderCost() {
      costEl.textContent = sessionCost > 0 ? ("Session: ~$" + sessionCost.toFixed(2)) : "";
    }

    function setStatus(msg, isErr) {
      statusEl.textContent = msg;
      if (isErr) statusEl.classList.add("err"); else statusEl.classList.remove("err");
    }

    // ---------- Form enable/disable during flight ----------
    function setFormDisabled(disabled) {
      inFlight = disabled;
      btn.disabled = disabled;
      editBtnEl.disabled = disabled;
      exportBtnEl.disabled = disabled;
      modelSel.disabled = disabled;
      variationsSel.disabled = disabled;
    }

    // ---------- Skeleton loaders ----------
    function showSkeletons(n) {
      skeletonCount = n;
      for (var i = 0; i < n; i++) {
        var sk = document.createElement("div");
        sk.className = "skel skel-loader";
        galleryEl.appendChild(sk);
      }
    }
    function clearSkeletons() {
      skeletonCount = 0;
      var nodes = galleryEl.querySelectorAll(".skel-loader");
      for (var i = 0; i < nodes.length; i++) nodes[i].parentNode.removeChild(nodes[i]);
    }

    function clearGallery() {
      var nodes = galleryEl.querySelectorAll(".tile");
      for (var i = 0; i < nodes.length; i++) nodes[i].parentNode.removeChild(nodes[i]);
    }

    function selectBase(idx) {
      baseIndex = idx;
      paintGallery();
      setStatus("Next refine starts from " + labelAt(idx) + ".");
    }

    // ---------- Full-size open / download / upscale ----------
    function openFullSize(idx) {
      if (idx < 0 || idx >= history.length) return;
      var im = history[idx];
      if (im.url && app && typeof app.openLink === "function") {
        app.openLink({ url: im.url }).catch(function (err) { setStatus("Couldn't open new tab: " + (err && err.message ? err.message : err), true); });
        return;
      }
      if (im.url) { try { window.open(im.url, "_blank"); } catch (e) {} }
      else { try { window.open(entrySrc(im), "_blank"); } catch (e) {} }
    }

    function downloadIndex(idx) {
      if (idx < 0 || idx >= history.length) return;
      var im = history[idx];
      if (im.url && app && typeof app.openLink === "function") {
        app.openLink({ url: im.url + (im.url.indexOf("?") === -1 ? "?dl=1" : "&dl=1") }).catch(function () { fallbackDownload(im); });
        return;
      }
      fallbackDownload(im);
    }
    function fallbackDownload(im) {
      if (!im.data) { setStatus("Nothing to download for this tile.", true); return; }
      var ext = im.mimeType && im.mimeType.indexOf("png") >= 0 ? "png" : "jpg";
      var filename = "nano-banana-" + im.label.replace(/[^a-z0-9]/gi, "-").toLowerCase() + "." + ext;
      var a = document.createElement("a");
      a.href = "data:" + (im.mimeType || "image/jpeg") + ";base64," + im.data;
      a.download = filename;
      a.target = "_blank";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }

    function upscaleIndex(idx) {
      if (idx < 0 || idx >= history.length) return;
      var im = history[idx];
      if (!im.url) {
        setStatus("Cannot upscale: this tile has no archived URL (uploaded references can't be upscaled directly — generate a render from it first).", true);
        return;
      }
      setStatus("Upscaling " + labelAt(idx) + " to 4K\\u2026 ~30-60s (\\u2248$0.24)");
      showSkeletons(1);
      setFormDisabled(true);
      var args = { image_url: im.url };
      addJobArgs(args);
      app.callServerTool({ name: "upscale_render", arguments: args }, { timeout: 240000 })
        .then(function (r) { render(r, "upscale"); })
        .catch(function (err) { clearSkeletons(); setStatus("Upscale failed: " + (err && err.message ? err.message : err), true); })
        .then(function () { setFormDisabled(false); });
    }

    // ---------- Rename ----------
    function doRename(idx, newLabel) {
      if (idx < 0 || idx >= history.length) return;
      newLabel = (newLabel || "").trim();
      if (!newLabel) return;
      var im = history[idx];
      im.label = newLabel;
      paintGallery();
      if (previewIndex === idx) openPreview(idx);
      if (im.filename && app && typeof app.callServerTool === "function") {
        app.callServerTool({ name: "set_render_label", arguments: { filename: im.filename, label: newLabel } }, { timeout: 20000 })
          .catch(function (err) { setStatus("Renamed locally, but saving to server failed: " + (err && err.message ? err.message : err), true); });
      }
    }

    // ---------- Pin/unpin ----------
    function togglePin(idx) {
      var pos = styleAnchorIdxs.indexOf(idx);
      if (pos >= 0) {
        styleAnchorIdxs.splice(pos, 1);
        setStatus(styleAnchorIdxs.length
          ? "Unpinned " + labelAt(idx) + ". " + styleAnchorIdxs.length + " anchor(s) remaining: " + styleAnchorIdxs.map(labelAt).join(", ") + "."
          : "Unpinned " + labelAt(idx) + ". No style anchors active.");
      } else {
        if (!history[idx].url) { setStatus("Can't pin: this tile has no archived URL.", true); return; }
        if (styleAnchorIdxs.length >= MAX_STYLE_ANCHORS) { setStatus("Already " + MAX_STYLE_ANCHORS + " anchors pinned (the max Gemini handles well). Unpin one first.", true); return; }
        styleAnchorIdxs.push(idx);
        setStatus("Pinned " + labelAt(idx) + ". " + styleAnchorIdxs.length + " anchor(s) in the mood board: " + styleAnchorIdxs.map(labelAt).join(", ") + ". Every Generate blends their lighting/color/mood.");
      }
      paintGallery();
    }

    // ---------- Popover menu ----------
    var openPopover = null;
    function closePopover() {
      if (openPopover) { openPopover.parentNode && openPopover.parentNode.removeChild(openPopover); openPopover = null; }
    }
    // Bubble phase + containment check: clicks INSIDE the popover (rename input,
    // menu items) must not close it. A capture-phase listener here would fire
    // before the popover's own handlers and close it on every interior click.
    document.addEventListener("click", function (e) {
      if (openPopover && !openPopover.contains(e.target)) closePopover();
    });

    function showTileMenu(idx, tile) {
      closePopover();
      var im = history[idx];
      var pop = document.createElement("div");
      pop.className = "popover";
      pop.addEventListener("click", function (e) { e.stopPropagation(); });

      function item(labelText, fn) {
        var b = document.createElement("button");
        b.type = "button";
        b.textContent = labelText;
        b.addEventListener("click", function () { closePopover(); fn(); });
        pop.appendChild(b);
      }

      item("Set as refine base", function () { selectBase(idx); });
      var pinned = styleAnchorIdxs.indexOf(idx) >= 0;
      item(pinned ? "Unpin style anchor" : "Pin style anchor", function () { togglePin(idx); });
      item("Rename\\u2026", function () { showRenameInPopover(idx, tile); });
      if (JOBTREAD_ENABLED) item(im.jt ? "Saved to " + im.jt.jobNumber + " \\u2014 save again\\u2026" : "Save to JobTread\\u2026", function () { startSave(idx, tile); });
      item("Upscale to 4K (~$0.24)", function () { upscaleIndex(idx); });
      item("Download", function () { downloadIndex(idx); });
      item("Open full size", function () { openFullSize(idx); });
      item("Preview + compare", function () { openPreview(idx); });

      tile.appendChild(pop);
      positionPopover(pop, tile);
      openPopover = pop;
    }

    function showRenameInPopover(idx, tile) {
      closePopover();
      var pop = document.createElement("div");
      pop.className = "popover";
      pop.addEventListener("click", function (e) { e.stopPropagation(); });
      var row = document.createElement("div");
      row.className = "rename-row";
      var inp = document.createElement("input");
      inp.type = "text";
      inp.value = history[idx].label;
      inp.placeholder = "New label";
      var save = document.createElement("button");
      save.className = "mini";
      save.textContent = "Save";
      var cancel = document.createElement("button");
      cancel.className = "mini secondary";
      cancel.textContent = "Cancel";
      save.addEventListener("click", function () { doRename(idx, inp.value); closePopover(); });
      cancel.addEventListener("click", function () { closePopover(); });
      inp.addEventListener("keydown", function (e) { if (e.key === "Enter") { doRename(idx, inp.value); closePopover(); } else if (e.key === "Escape") { closePopover(); } });
      row.appendChild(inp); row.appendChild(save); row.appendChild(cancel);
      pop.appendChild(row);
      tile.appendChild(pop);
      positionPopover(pop, tile);
      openPopover = pop;
      try { inp.focus(); inp.select(); } catch (e) {}
    }

    function positionPopover(pop, tile) {
      // Anchor near the top-right of the tile (below the menu button).
      pop.style.top = "34px";
      pop.style.right = "6px";
    }

    // ---------- Gallery painting ----------
    function paintGallery() {
      clearGallery();
      // Rebuild: insert tiles before any skeleton loaders (skeletons stay at the end).
      var firstSkel = galleryEl.querySelector(".skel-loader");
      for (var i = 0; i < history.length; i++) {
        (function (idx) {
          var im = history[idx];
          var tile = document.createElement("div");
          var cls = "tile";
          if (idx === baseIndex) cls += " sel";
          if (idx === previewIndex) cls += " previewing";
          tile.className = cls;

          var img = makeImg(im);
          img.title = "Click to preview";
          img.addEventListener("click", function () {
            if (comparePickMode) { pickComparePartner(idx); return; }
            openPreview(idx);
          });

          var lab = document.createElement("span");
          lab.className = "label";
          lab.textContent = im.label + (idx === baseIndex ? " \\u2022 base" : "");

          var menuBtn = document.createElement("button");
          menuBtn.type = "button";
          menuBtn.className = "menubtn";
          menuBtn.textContent = "\\u2026";
          menuBtn.title = "Actions";
          menuBtn.addEventListener("click", function (e) { e.stopPropagation(); showTileMenu(idx, tile); });

          tile.appendChild(img);
          tile.appendChild(lab);
          if (styleAnchorIdxs.indexOf(idx) >= 0) {
            var pb = document.createElement("span");
            pb.className = "pinbadge";
            pb.textContent = "\\uD83D\\uDCCC";
            pb.style.left = "auto";
            pb.style.right = "40px";
            tile.appendChild(pb);
          }
          tile.appendChild(menuBtn);
          if (im.jt) {
            var sb = document.createElement("span");
            sb.className = "savedbadge";
            sb.textContent = "\\u2713 " + im.jt.jobNumber;
            sb.title = "In JobTread: " + im.jt.fileName;
            tile.appendChild(sb);
          }

          if (firstSkel) galleryEl.insertBefore(tile, firstSkel);
          else galleryEl.appendChild(tile);
        })(i);
      }
    }

    // ---------- Compare partner selection ----------
    function autoComparePartner(idx) {
      // Most recent "source" tile before idx, else most recent other render.
      for (var i = history.length - 1; i >= 0; i--) {
        if (i === idx) continue;
        if (history[i].kind === "source") return i;
      }
      return -1;
    }
    function pickComparePartner(idx) {
      comparePickMode = false;
      document.getElementById("comparePicking").classList.remove("show");
      if (idx === previewIndex) { setStatus("Pick a different tile to compare."); comparePickMode = true; document.getElementById("comparePicking").classList.add("show"); return; }
      comparePartner = idx;
      compareOff = false;
      openPreview(previewIndex);
    }

    // ---------- Preview pane ----------
    var previewEl = document.getElementById("preview");
    var previewTitleEl = document.getElementById("previewTitle");
    var previewStageEl = document.getElementById("previewStage");
    var previewPromptEl = document.getElementById("previewPrompt");
    var previewActionsEl = document.getElementById("previewActions");
    var previewSaveEl = document.getElementById("previewSave");
    var previewRenameEl = document.getElementById("previewRename");
    var previewRenameInput = document.getElementById("previewRenameInput");

    document.getElementById("previewClose").addEventListener("click", closePreview);
    function closePreview() {
      previewEl.classList.remove("open");
      previewIndex = -1;
      comparePartner = -1;
      comparePickMode = false;
      document.getElementById("comparePicking").classList.remove("show");
      paintGallery();
    }

    function clearNode(n) { while (n.firstChild) n.removeChild(n.firstChild); }

    function partnerIndex() {
      if (compareOff) return -1;
      if (comparePartner >= 0 && comparePartner < history.length && comparePartner !== previewIndex) return comparePartner;
      return autoComparePartner(previewIndex);
    }

    function buildSlider(beforeIm, afterIm) {
      var cmp = document.createElement("div");
      cmp.className = "cmp";
      var base = makeImg(afterIm); base.className = "cmp-base";
      cmp.appendChild(base);
      var afterWrap = document.createElement("div");
      afterWrap.className = "after-wrap";
      var beforeImg = makeImg(beforeIm);
      afterWrap.appendChild(beforeImg);
      cmp.appendChild(afterWrap);
      var divider = document.createElement("div");
      divider.className = "divider";
      cmp.appendChild(divider);
      var labL = document.createElement("span"); labL.className = "cmp-lab left"; labL.textContent = beforeIm.label; cmp.appendChild(labL);
      var labR = document.createElement("span"); labR.className = "cmp-lab right"; labR.textContent = afterIm.label; cmp.appendChild(labR);

      var pct = comparePct;
      function apply() {
        afterWrap.style.width = pct + "%";
        divider.style.left = pct + "%";
      }
      // Pin the clipped image to the pane's full pixel width so moving the
      // divider reveals it in place instead of rescaling it.
      function sizeInner() {
        var w = cmp.clientWidth;
        if (w > 0) beforeImg.style.width = w + "px";
      }
      base.addEventListener("load", sizeInner);
      beforeImg.addEventListener("load", sizeInner);
      if (typeof ResizeObserver === "function") {
        try { new ResizeObserver(sizeInner).observe(cmp); } catch (er) {}
      }
      setTimeout(sizeInner, 0);
      apply();
      var dragging = false;
      function setFromClient(clientX) {
        var rect = cmp.getBoundingClientRect();
        if (rect.width <= 0) return;
        var p = ((clientX - rect.left) / rect.width) * 100;
        pct = Math.max(0, Math.min(100, p));
        comparePct = pct;
        apply();
      }
      cmp.addEventListener("pointerdown", function (e) { dragging = true; try { cmp.setPointerCapture(e.pointerId); } catch (er) {} setFromClient(e.clientX); });
      cmp.addEventListener("pointermove", function (e) { if (dragging) setFromClient(e.clientX); });
      cmp.addEventListener("pointerup", function () { dragging = false; });
      cmp.addEventListener("pointercancel", function () { dragging = false; });
      return cmp;
    }

    function buildSideBySide(beforeIm, afterIm) {
      var wrap = document.createElement("div");
      wrap.className = "cmp-side";
      [beforeIm, afterIm].forEach(function (im) {
        var fig = document.createElement("figure");
        var img = makeImg(im);
        var cap = document.createElement("figcaption");
        cap.textContent = im.label;
        fig.appendChild(img); fig.appendChild(cap);
        wrap.appendChild(fig);
      });
      return wrap;
    }

    function openPreview(idx) {
      if (idx < 0 || idx >= history.length) return;
      previewIndex = idx;
      var im = history[idx];
      previewEl.classList.add("open");
      previewTitleEl.textContent = im.label;
      previewRenameEl.classList.remove("open");

      clearNode(previewStageEl);
      var partner = partnerIndex();
      if (partner >= 0) {
        if (compareView === "side") previewStageEl.appendChild(buildSideBySide(history[partner], im));
        else previewStageEl.appendChild(buildSlider(history[partner], im));
      } else {
        var big = makeImg(im); big.className = "single"; previewStageEl.appendChild(big);
      }

      // Archived prompts can include internal preambles (edit-mask instructions
      // etc.) — show only the user's instruction, and keep it short.
      var displayPrompt = im.prompt || "";
      var uiMark = displayPrompt.indexOf("User instruction: ");
      if (uiMark >= 0) displayPrompt = displayPrompt.slice(uiMark + "User instruction: ".length);
      if (displayPrompt.length > 240) displayPrompt = displayPrompt.slice(0, 240) + "\\u2026";
      previewPromptEl.textContent = (displayPrompt ? ("Prompt: " + displayPrompt) : "") +
        (im.jt ? (displayPrompt ? "\\n" : "") + "In JobTread: " + im.jt.fileName + " (" + im.jt.jobNumber + ")" : "");

      // Action buttons
      clearNode(previewActionsEl);
      function act(labelText, primary, fn) {
        var b = document.createElement("button");
        if (primary) b.className = "primary";
        b.textContent = labelText;
        b.addEventListener("click", fn);
        previewActionsEl.appendChild(b);
        return b;
      }
      act("Open full size", false, function () { openFullSize(idx); });
      act("Download", false, function () { downloadIndex(idx); });
      act("Set as refine base", true, function () { selectBase(idx); });
      var upBtn = act("Upscale 4K", false, function () { upscaleIndex(idx); });
      if (!im.url) upBtn.disabled = true;
      act("Rename", false, function () {
        previewRenameEl.classList.toggle("open");
        if (previewRenameEl.classList.contains("open")) { previewRenameInput.value = im.label; try { previewRenameInput.focus(); previewRenameInput.select(); } catch (e) {} }
      });
      // stopPropagation: the document-level "click outside closes the popover"
      // handler would otherwise close the form in the same click that opened it.
      if (JOBTREAD_ENABLED) {
        var saveBtn = act(im.jt ? "Save again" : "Save to JobTread", false, function (e) { e.stopPropagation(); startSave(idx, previewSaveEl); });
        if (!im.filename) saveBtn.disabled = true;
      }
      if (im.jt && im.jt.jobId) {
        act("Open in JobTread", false, function () {
          if (app && typeof app.openLink === "function") app.openLink({ url: jobFilesUrl(im.jt.jobId) }).catch(function () {});
        });
      }
      act("Compare\\u2026", false, function () {
        comparePickMode = true;
        document.getElementById("comparePicking").classList.add("show");
        setStatus("Compare mode: click another tile to pick the comparison partner.");
      });
      if (partner >= 0) {
        act(compareView === "side" ? "Slider view" : "Side-by-side", false, function () {
          compareView = compareView === "side" ? "slider" : "side";
          openPreview(idx);
        });
        act(compareView === "side" ? "Export side-by-side" : "Export compare", false, exportCompare);
        act("Single view", false, function () {
          compareOff = true;
          comparePartner = -1;
          openPreview(idx);
        });
      }
      paintGallery();
    }

    document.getElementById("previewRenameSave").addEventListener("click", function () {
      if (previewIndex >= 0) doRename(previewIndex, previewRenameInput.value);
      previewRenameEl.classList.remove("open");
    });
    document.getElementById("previewRenameCancel").addEventListener("click", function () { previewRenameEl.classList.remove("open"); });
    previewRenameInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { if (previewIndex >= 0) doRename(previewIndex, previewRenameInput.value); previewRenameEl.classList.remove("open"); }
      else if (e.key === "Escape") { previewRenameEl.classList.remove("open"); }
    });

    // ---------- Textarea autosize ----------
    function autosize(el) {
      if (!el) return;
      el.style.height = "auto";
      var max = parseInt(getComputedStyle(el).maxHeight, 10) || 9999;
      el.style.height = Math.min(el.scrollHeight, max) + "px";
    }

    function prefillPrompt(prompt) {
      if (!prompt) return;
      var instrEl = document.getElementById("instruction");
      if (!instrEl) return;
      instrEl.value = prompt;
      autosize(instrEl);
      setStatus("Prompt queued from chat \\u2014 click \\uD83D\\uDCCE Reference to upload your image, then press Generate.");
      try { instrEl.focus(); } catch (e) {}
    }

    // ---------- Result rendering ----------
    function render(result, sourceKind) {
      var sc = (result && result.structuredContent) ? result.structuredContent : {};

      // Follow the mode the server ran in ("room" or "general"), so refinements
      // stay in the same mode. "raw"/"natural" results leave the selector alone.
      if (sc.stylePreset === "general") modeSel.value = "general";
      else if (sc.stylePreset === "room") modeSel.value = "room";

      // Chat handoff: propose_render delivered a prompt to pre-fill.
      if (sc.action === "propose" && typeof sc.prompt === "string") {
        prefillPrompt(sc.prompt);
        if (noteEl) noteEl.textContent = "";
        return;
      }

      // Normal generate/upscale result: image content blocks + paired archived URLs.
      var imgs = [];
      var txt = "";
      if (result && result.content) {
        for (var i = 0; i < result.content.length; i++) {
          var c = result.content[i];
          if (c.type === "image" && c.data) imgs.push({ data: c.data, mimeType: c.mimeType || "image/png" });
          // First text block only: the summary. Later blocks (the render-URL list) are for Claude.
          else if (c.type === "text" && c.text && !txt) txt = c.text;
        }
      }
      if (!imgs.length) {
        var meta = (result && result._meta) ? result._meta : {};
        imgs = meta.images || sc.images || [];
      }

      clearSkeletons();

      var newUrls = Array.isArray(sc.archivedUrls) ? sc.archivedUrls : [];
      var newFiles = Array.isArray(sc.archivedFilenames) ? sc.archivedFilenames : [];
      var promptUsed = typeof sc.prompt === "string" ? sc.prompt : undefined;
      var lastIdx = -1;
      for (var k = 0; k < imgs.length; k++) {
        lastIdx = pushRender(imgs[k].data, imgs[k].mimeType || "image/png", newUrls[k] || null, promptUsed, newFiles[k] || null);
      }
      if (lastIdx >= 0) baseIndex = lastIdx;

      // Track session cost.
      var modelUsed = sourceKind === "upscale" ? "upscale" : (sc.model || "flash");
      if (imgs.length) addCost(sc, modelUsed, sc.imageCount || imgs.length);

      paintGallery();
      noteEl.textContent = txt;
      if (history.length) {
        setStatus(history.length + " version(s) \\u2014 click any image to open the large preview.");
      } else {
        setStatus("No image in result.", true);
      }
    }

    // ---------- Reference upload (client-side resize) ----------
    // Downscale a chosen file to <=2048px JPEG base64. Shared by the main
    // reference uploader and the area-editor's product-reference uploader.
    function downscaleFileToRef(f, cb) {
      var url = URL.createObjectURL(f);
      var img = new Image();
      img.onload = function () {
        var maxSide = 2048;
        var w = img.naturalWidth, h = img.naturalHeight;
        var s = Math.min(1, maxSide / Math.max(w, h));
        var nw = Math.max(1, Math.round(w * s));
        var nh = Math.max(1, Math.round(h * s));
        var canvas = document.createElement("canvas");
        canvas.width = nw; canvas.height = nh;
        var ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, nw, nh);
        var dataUrl = canvas.toDataURL("image/jpeg", 0.85);
        URL.revokeObjectURL(url);
        var comma = dataUrl.indexOf(",");
        var b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
        cb(null, { data: b64, mimeType: "image/jpeg", w: nw, h: nh });
      };
      img.onerror = function () { URL.revokeObjectURL(url); cb(new Error("read failed")); };
      img.src = url;
    }
    function loadReferenceFile(f) {
      if (!f) { pendingRef = null; refName.textContent = ""; return; }
      refName.textContent = "Loading " + f.name + "\\u2026";
      downscaleFileToRef(f, function (err, ref) {
        if (err) {
          pendingRef = null;
          refName.textContent = "Could not read " + (f.name || "that file") + " as an image.";
          return;
        }
        pendingRef = { data: ref.data, mimeType: ref.mimeType };
        // Switch to pro when a reference is picked, unless the user already chose.
        if (!userTouchedModel) modelSel.value = "pro";
        var kb = Math.round(ref.data.length * 3 / 4 / 1024);
        refName.textContent = "Reference: " + (f.name || "pasted image") + " \\u2014 " + ref.w + "\\u00d7" + ref.h + ", " + kb + " KB. Describe the change and press Generate.";
      });
    }
    refFile.addEventListener("change", function () {
      var f = refFile.files && refFile.files[0];
      loadReferenceFile(f);
    });

    // ---------- App wiring ----------
    var app = new App({ name: "Nano Banana Viewer", version: "0.2.0" }, {});
    app.ontoolresult = function (r) {
      var sc = (r && r.structuredContent) ? r.structuredContent : {};
      var kind = sc.source === "upscale" ? "upscale" : "generate";
      render(r, kind);
    };
    app.ontoolinput = function (input) {
      try {
        var args = (input && (input.arguments || input.params || input)) || {};
        if (typeof args.prompt === "string" && args.prompt.length > 0) {
          var instrEl = document.getElementById("instruction");
          if (instrEl && !instrEl.value) prefillPrompt(args.prompt);
        }
      } catch (e) {}
    };

    modelSel.addEventListener("change", function () { userTouchedModel = true; });

    // Reveal the variation-axes input when >1 variation.
    variationsSel.addEventListener("change", function () {
      var v = parseInt(variationsSel.value, 10) || 1;
      if (v > 1) variationAxesEl.classList.add("show");
      else variationAxesEl.classList.remove("show");
    });

    // ---------- Textareas: autosize + Enter-to-submit ----------
    (function wireTextareas() {
      var refineForm = document.getElementById("refine");
      [document.getElementById("instruction"), document.getElementById("editInstruction")].forEach(function (el) {
        if (!el) return;
        el.addEventListener("input", function () { autosize(el); });
        el.addEventListener("keydown", function (e) {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (el.id === "instruction") {
              if (typeof refineForm.requestSubmit === "function") refineForm.requestSubmit();
              else document.getElementById("refineBtn").click();
            } else if (el.id === "editInstruction") {
              document.getElementById("applyEdit").click();
            }
          }
        });
        autosize(el);
      });
    })();

    // ---------- Generate ----------
    document.getElementById("refine").addEventListener("submit", function (e) {
      e.preventDefault();
      if (inFlight) return;
      var instruction = document.getElementById("instruction").value.trim();
      if (!instruction) { setStatus("Type a description first.", true); return; }
      var variations = parseInt(variationsSel.value, 10) || 1;
      var model = modelSel.value === "pro" ? "pro" : "flash";
      var args = { prompt: instruction, model: model };
      var isRefinement = false;

      if (pendingRef) {
        // Fresh generation from an uploaded reference: inline base64. No style_preset.
        args.reference_images = [{ data: pendingRef.data, mime_type: pendingRef.mimeType }];
        pushSource(pendingRef.data, pendingRef.mimeType);
        paintGallery();
      } else if (baseIndex >= 0) {
        // Refinement from an existing render base.
        isRefinement = true;
        var b = history[baseIndex];
        if (b.url) {
          args.reference_image_urls = [b.url];
        } else if (b.data) {
          args.reference_images = [{ data: b.data, mime_type: b.mimeType || "image/png" }];
        }
      }
      // style_preset discipline: General mode always sends "general". Room mode:
      // refinements from a render base send "raw"; fresh (upload or pure text)
      // omit it (server defaults to "room").
      if (modeSel.value === "general") args.style_preset = "general";
      else if (isRefinement) args.style_preset = "raw";

      if (variations > 1) {
        args.batch_count = variations;
        var axes = variationAxesEl.value.trim();
        if (axes) args.variation_axes = axes;
      }
      addJobArgs(args);
      addProductArgs(args);

      // Pinned style anchors (mood board).
      if (styleAnchorIdxs.length > 0) {
        var anchorUrls = styleAnchorIdxs.map(function (i) { return history[i].url; }).filter(function (u) { return !!u; });
        if (anchorUrls.length > 0) args.style_reference_urls = anchorUrls;
      }

      var estEach = model === "pro" ? COST_PRO : COST_FLASH;
      var est = (estEach * variations).toFixed(2);
      var batchHint = variations > 1 ? variations + " variations" : "1 variation";
      var prodHint = selChosen.length ? " with " + selChosen.length + " product" + (selChosen.length > 1 ? "s" : "") : "";
      setStatus("Generating " + batchHint + prodHint + " (" + model + ", \\u2248$" + est + ")\\u2026 ~30\\u201360s");

      showSkeletons(variations);
      setFormDisabled(true);
      app.callServerTool({ name: "generate_render_interactive", arguments: args }, { timeout: 180000 })
        .then(function (r) {
          render(r, "generate");
          pendingRef = null; refName.textContent = ""; refFile.value = "";
        })
        .catch(function (err) { clearSkeletons(); setStatus("Generate failed: " + (err && err.message ? err.message : err), true); })
        .then(function () { setFormDisabled(false); });
    });

    // ---------- Area editor ----------
    var editor = document.getElementById("editor");
    var editBase = document.getElementById("editBase");
    var editOverlay = document.getElementById("editOverlay");
    var brushSizeEl = document.getElementById("brushSize");
    var clearMaskBtn = document.getElementById("clearMask");
    var applyEditBtn = document.getElementById("applyEdit");
    var cancelEditBtn = document.getElementById("cancelEdit");
    var editInstructionEl = document.getElementById("editInstruction");
    var fillModeEl = document.getElementById("fillMode");
    var editRefFileEl = document.getElementById("editRefFile");
    var editRefNameEl = document.getElementById("editRefName");
    var editRef = null;          // product photo to drop into the masked area {data, mimeType}
    var editSrcImg = null;       // full-resolution base the editor was opened on (stitch target)
    var editSrcIndex = -1;
    var drawing = false;

    function clearEditRef() {
      editRef = null;
      if (editRefNameEl) editRefNameEl.textContent = "";
      if (editRefFileEl) editRefFileEl.value = "";
    }
    editRefFileEl.addEventListener("change", function () {
      var f = editRefFileEl.files && editRefFileEl.files[0];
      if (!f) { clearEditRef(); return; }
      editRefNameEl.textContent = "Loading " + f.name + "\\u2026";
      downscaleFileToRef(f, function (err, ref) {
        if (err) { editRef = null; editRefNameEl.textContent = "Could not read that image."; return; }
        editRef = { data: ref.data, mimeType: ref.mimeType };
        var kb = Math.round(ref.data.length * 3 / 4 / 1024);
        editRefNameEl.textContent = "Area reference: " + (f.name || "image") + " \\u2014 " + ref.w + "\\u00d7" + ref.h + ", " + kb + " KB. The item in this photo will be installed in the red area.";
      });
    });

    function floodFillRed(canvas, x, y) {
      var w = canvas.width, h = canvas.height;
      if (x < 0 || x >= w || y < 0 || y >= h) return;
      var ctx = canvas.getContext("2d");
      var imgData = ctx.getImageData(0, 0, w, h);
      var px = imgData.data;
      var seed = (y * w + x) * 4;
      if (px[seed + 3] !== 0) return;
      var fR = 255, fG = 40, fB = 40, fA = 140;
      function matches(i) { return px[i + 3] === 0; }
      var stack = [[x, y]];
      while (stack.length) {
        var node = stack.pop();
        var cx = node[0], cy = node[1];
        var lx = cx;
        while (lx >= 0 && matches((cy * w + lx) * 4)) lx--;
        lx++;
        var spanAbove = false, spanBelow = false;
        while (lx < w && matches((cy * w + lx) * 4)) {
          var i = (cy * w + lx) * 4;
          px[i] = fR; px[i + 1] = fG; px[i + 2] = fB; px[i + 3] = fA;
          var above = cy > 0 && matches(((cy - 1) * w + lx) * 4);
          var below = cy < h - 1 && matches(((cy + 1) * w + lx) * 4);
          if (!spanAbove && above) { stack.push([lx, cy - 1]); spanAbove = true; }
          else if (spanAbove && !above) { spanAbove = false; }
          if (!spanBelow && below) { stack.push([lx, cy + 1]); spanBelow = true; }
          else if (spanBelow && !below) { spanBelow = false; }
          lx++;
        }
      }
      ctx.putImageData(imgData, 0, 0);
    }

    function openEditor() {
      if (baseIndex < 0) {
        setStatus("Generate a render first, then set a tile as base and press Edit area.", true);
        return;
      }
      var im = history[baseIndex];
      var img = makeImg(im);
      img.onload = function () {
        var maxW = 900;
        var s = Math.min(1, maxW / img.naturalWidth);
        var w = Math.round(img.naturalWidth * s);
        var h = Math.round(img.naturalHeight * s);
        editBase.width = w; editBase.height = h;
        editOverlay.width = w; editOverlay.height = h;
        try { editBase.getContext("2d").drawImage(img, 0, 0, w, h); } catch (e) {}
        editSrcImg = img;
        editSrcIndex = baseIndex;
        editOverlay.getContext("2d").clearRect(0, 0, w, h);
        clearEditRef();
        editor.classList.add("open");
        editInstructionEl.focus();
        setStatus("Editing " + labelAt(baseIndex) + " \\u2014 paint the area to change, then Apply.");
      };
      img.onerror = function () { setStatus("Couldn't load the base image for editing.", true); };
    }
    function closeEditor() { editor.classList.remove("open"); clearEditRef(); }
    editBtnEl.addEventListener("click", openEditor);
    cancelEditBtn.addEventListener("click", closeEditor);

    function getPos(e) {
      var rect = editOverlay.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) * (editOverlay.width / rect.width),
        y: (e.clientY - rect.top) * (editOverlay.height / rect.height),
      };
    }
    function strokeStart(e) {
      var p = getPos(e);
      if (fillModeEl && fillModeEl.checked) { floodFillRed(editOverlay, Math.floor(p.x), Math.floor(p.y)); return; }
      drawing = true;
      try { editOverlay.setPointerCapture(e.pointerId); } catch (err) {}
      var ctx = editOverlay.getContext("2d");
      ctx.strokeStyle = "rgba(255, 40, 40, 0.55)";
      ctx.lineWidth = parseInt(brushSizeEl.value, 10) || 28;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
    }
    function strokeMove(e) {
      if (!drawing) return;
      var p = getPos(e);
      var ctx = editOverlay.getContext("2d");
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    function strokeEnd() { drawing = false; }
    editOverlay.addEventListener("pointerdown", strokeStart);
    editOverlay.addEventListener("pointermove", strokeMove);
    editOverlay.addEventListener("pointerup", strokeEnd);
    editOverlay.addEventListener("pointerleave", strokeEnd);
    editOverlay.addEventListener("pointercancel", strokeEnd);

    clearMaskBtn.addEventListener("click", function () {
      editOverlay.getContext("2d").clearRect(0, 0, editOverlay.width, editOverlay.height);
    });

    // ---------- Area edit: crop -> edit -> stitch back ----------
    // The model only sees a crop around the painted area (so the area fills most
    // of the frame and can't be missed), and its result is pasted back into the
    // full-resolution base through a feathered mask, so pixels outside the area
    // cannot change. An outline counts as everything inside it.
    var EDIT_RATIOS = [[1, 1], [4, 3], [3, 4], [3, 2], [2, 3], [16, 9], [9, 16], [5, 4], [4, 5], [21, 9]];

    function makeCanvas(w, h) { var c = document.createElement("canvas"); c.width = w; c.height = h; return c; }

    // Painted pixels plus anything they enclose. Returns null when nothing is painted.
    function buildEditMask() {
      var w = editOverlay.width, h = editOverlay.height;
      var src = editOverlay.getContext("2d").getImageData(0, 0, w, h).data;
      var painted = new Uint8Array(w * h);
      var any = false;
      for (var i = 0; i < w * h; i++) if (src[i * 4 + 3] > 20) { painted[i] = 1; any = true; }
      if (!any) return null;
      // Flood the unpainted area from the image border; whatever it can't reach is enclosed.
      var outside = new Uint8Array(w * h);
      var stack = [];
      function seed(x, y) { var k = y * w + x; if (!painted[k] && !outside[k]) { outside[k] = 1; stack.push(k); } }
      for (var x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
      for (var y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }
      while (stack.length) {
        var k2 = stack.pop(), kx = k2 % w, ky = (k2 - kx) / w;
        if (kx > 0) seed(kx - 1, ky);
        if (kx < w - 1) seed(kx + 1, ky);
        if (ky > 0) seed(kx, ky - 1);
        if (ky < h - 1) seed(kx, ky + 1);
      }
      var mask = new Uint8Array(w * h);
      var minX = w, minY = h, maxX = -1, maxY = -1;
      for (var j = 0; j < w * h; j++) {
        if (outside[j]) continue;
        mask[j] = 1;
        var mx = j % w, my = (j - mx) / w;
        if (mx < minX) minX = mx;
        if (mx > maxX) maxX = mx;
        if (my < minY) minY = my;
        if (my > maxY) maxY = my;
      }
      return { mask: mask, w: w, h: h, minX: minX, minY: minY, maxX: maxX, maxY: maxY };
    }
    function maskToCanvas(m) {
      var c = makeCanvas(m.w, m.h);
      var ctx = c.getContext("2d");
      var id = ctx.createImageData(m.w, m.h);
      for (var i = 0; i < m.mask.length; i++) {
        if (!m.mask[i]) continue;
        id.data[i * 4] = 255; id.data[i * 4 + 1] = 255; id.data[i * 4 + 2] = 255; id.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(id, 0, 0);
      return c;
    }
    function closestRatio(w, h) {
      var best = EDIT_RATIOS[0], bestErr = 1e9;
      EDIT_RATIOS.forEach(function (r) {
        var e = Math.abs(Math.log((w / h) / (r[0] / r[1])));
        if (e < bestErr) { bestErr = e; best = r; }
      });
      return best;
    }
    // Crop (full-res px) around the area with context, snapped to an aspect ratio
    // the model can output so the edited crop maps back 1:1.
    function editCropRect(m, natW, natH) {
      var s = natW / m.w;
      var bx = m.minX * s, by = m.minY * s, bw = (m.maxX - m.minX + 1) * s, bh = (m.maxY - m.minY + 1) * s;
      var cw = Math.min(natW, Math.max(bw * 1.6, 640));
      var ch = Math.min(natH, Math.max(bh * 1.6, 640));
      var r = closestRatio(cw, ch), ar = r[0] / r[1];
      if (cw / ch < ar) cw = ch * ar; else ch = cw / ar;
      if (cw > natW) { cw = natW; ch = cw / ar; }
      if (ch > natH) { ch = natH; cw = ch * ar; }
      var cx = Math.max(0, Math.min(natW - cw, bx + bw / 2 - cw / 2));
      var cy = Math.max(0, Math.min(natH - ch, by + bh / 2 - ch / 2));
      var fits = cx <= bx && cy <= by && cx + cw >= bx + bw && cy + ch >= by + bh;
      if (!fits) {
        // Area too big for a snapped crop: edit the whole image instead.
        var whole = closestRatio(natW, natH);
        return { x: 0, y: 0, w: natW, h: natH, ratio: whole[0] + ":" + whole[1], s: s };
      }
      return { x: Math.round(cx), y: Math.round(cy), w: Math.round(cw), h: Math.round(ch), ratio: r[0] + ":" + r[1], s: s };
    }
    // Mask for the crop, grown slightly and blurred so the pasted edit blends in.
    function featheredCropMask(maskCanvas, rect) {
      // Narrow on purpose: a wide blend mixed old and new pixels into a visible
      // ghost wherever the edit differs (a faded baseboard, see-through dresser).
      var feather = Math.max(3, Math.round(Math.max(rect.w, rect.h) * 0.005));
      var grown = makeCanvas(rect.w, rect.h);
      var gctx = grown.getContext("2d");
      var sx = rect.x / rect.s, sy = rect.y / rect.s, sw = rect.w / rect.s, sh = rect.h / rect.s;
      for (var dx = -1; dx <= 1; dx++) {
        for (var dy = -1; dy <= 1; dy++) {
          gctx.drawImage(maskCanvas, sx, sy, sw, sh, dx * feather, dy * feather, rect.w, rect.h);
        }
      }
      var out = makeCanvas(rect.w, rect.h);
      var octx = out.getContext("2d");
      try { octx.filter = "blur(" + feather + "px)"; } catch (e) {}
      octx.drawImage(grown, 0, 0);
      return out;
    }
    function uploadBlob(blob) {
      var upHeaders = { "content-type": "image/jpeg" };
      if (UPLOAD_TOKEN && UPLOAD_TOKEN.indexOf("__") !== 0) upHeaders["x-upload-token"] = UPLOAD_TOKEN;
      return fetch(WORKER_ORIGIN + "/upload", { method: "POST", body: blob, headers: upHeaders })
        .then(function (r) { if (!r.ok) return r.text().then(function (t) { throw new Error(r.status + " " + t); }); return r.json(); });
    }

    applyEditBtn.addEventListener("click", function () {
      if (inFlight) return;
      var instruction = editInstructionEl.value.trim();
      if (!instruction && !editRef) {
        setStatus("Describe the change, or attach an area reference photo first.", true);
        editInstructionEl.focus();
        return;
      }
      var m = buildEditMask();
      if (!m) { setStatus("Paint over or outline the area to change first.", true); return; }
      var src = editSrcImg;
      var base = history[editSrcIndex];
      if (!src || !base) { setStatus("Couldn't find the image being edited — close the editor and try again.", true); return; }
      var natW = src.naturalWidth, natH = src.naturalHeight;
      var rect = editCropRect(m, natW, natH);
      var maskCanvas = maskToCanvas(m);

      // What the model sees: the crop (at most 1600px on the long side) twice —
      // IMAGE 1 clean, so it can see the trim, legs, and edges under the mark, and
      // IMAGE 2 with the area tinted red (filled, never just an outline). With the
      // tint alone the model couldn't see a baseboard under the red and repainted
      // it as floor (2026-10-26).
      var outScale = Math.min(1, 1600 / Math.max(rect.w, rect.h));
      var ow = Math.round(rect.w * outScale), oh = Math.round(rect.h * outScale);
      var clean = makeCanvas(ow, oh);
      var marked = makeCanvas(ow, oh);
      var tint = makeCanvas(ow, oh);
      var tctx = tint.getContext("2d");
      var cleanB64, markedB64;
      try {
        clean.getContext("2d").drawImage(src, rect.x, rect.y, rect.w, rect.h, 0, 0, ow, oh);
        var mctx = marked.getContext("2d");
        mctx.drawImage(clean, 0, 0);
        tctx.drawImage(maskCanvas, rect.x / rect.s, rect.y / rect.s, rect.w / rect.s, rect.h / rect.s, 0, 0, ow, oh);
        tctx.globalCompositeOperation = "source-in";
        tctx.fillStyle = "rgba(255, 40, 40, 0.5)";
        tctx.fillRect(0, 0, ow, oh);
        mctx.drawImage(tint, 0, 0);
        var cleanUrl = clean.toDataURL("image/jpeg", 0.92);
        var markedUrl = marked.toDataURL("image/jpeg", 0.92);
        cleanB64 = cleanUrl.slice(cleanUrl.indexOf(",") + 1);
        markedB64 = markedUrl.slice(markedUrl.indexOf(",") + 1);
      } catch (e) {
        setStatus("Couldn't read the image being edited (cross-origin). Set a freshly generated render as base and retry.", true);
        return;
      }

      var setup =
        "IMAGE 1 is a clean photo. IMAGE 2 is the SAME photo with a RED tint marking the area to edit. " +
        "Output the edited version of IMAGE 1 (never the red tint). " +
        "These are a close-up crop of a larger photo and your result is pasted back into it, so keep the framing, zoom, perspective, and position of everything exactly the same \\u2014 do not zoom, crop, shift, or re-frame. " +
        "The red mark is approximate and may overlap neighboring things \\u2014 baseboards and trim, furniture and its legs, walls, rugs, doors, cabinets. Change ONLY what the instruction names; everything else inside the mark keeps exactly the shape, color, and detail it has in IMAGE 1. ";
      var refs = [{ data: cleanB64, mime_type: "image/jpeg" }, { data: markedB64, mime_type: "image/jpeg" }];
      var editPrompt;
      if (editRef) {
        refs.push({ data: editRef.data, mime_type: editRef.mimeType });
        editPrompt =
          "You will edit a photograph using three images. " + setup +
          "IMAGE 3 is a product reference photo. " +
          "Install the EXACT item shown in IMAGE 3 in the marked area: reproduce its specific model, shape, proportions, materials, color, and finish faithfully \\u2014 do not substitute a generic look-alike. " +
          "Fit it naturally to the scene: match the room's perspective, scale, mounting position, and the direction/quality/color of the existing light, and add realistic contact shadows and reflections. " +
          "Do not add windows or any other opening. Produce a clean photorealistic result with no visible mask." +
          (instruction ? "\\n\\nAdditional instruction: " + instruction : "");
      } else {
        editPrompt =
          "You will edit a photograph using two images. " + setup +
          "Make the change described below in the marked area \\u2014 the change must be clearly visible:\\n" +
          "- If it says to REMOVE, delete, hide, or take out something: remove it entirely and fill the space with what would naturally be behind it, matching the surrounding materials, lighting, perspective, and depth (a removed window becomes solid wall).\\n" +
          "- If it says to CHANGE, replace, recolor, swap, or upgrade: change that surface or object in the marked area to match the description, keeping its geometry.\\n" +
          "Do not add windows or any other opening. Produce a clean photorealistic result with no visible mask.\\n\\n" +
          "User instruction: " + instruction;
      }

      var args = {
        prompt: editPrompt,
        model: "pro",
        reference_images: refs,
        reference_mode: "style",
        // 'general' = neutral "REFERENCE IMAGE n" labels; the room labels told the
        // model to preserve everything in each image, which fights an edit.
        style_preset: "general",
        aspect_ratio: rect.ratio,
        skip_archive: true,
      };
      addJobArgs(args);
      addProductArgs(args);

      closeEditor();
      setStatus("Applying area edit (pro)… ~30–60s");
      showSkeletons(1);
      setFormDisabled(true);
      applyEditBtn.disabled = true;
      var sc = null;
      function done(msg, isErr) {
        clearSkeletons();
        setFormDisabled(false);
        applyEditBtn.disabled = false;
        if (msg) setStatus(msg, isErr);
      }
      app.callServerTool({ name: "generate_render_interactive", arguments: args }, { timeout: 180000 })
        .then(function (r) {
          sc = (r && r.structuredContent) ? r.structuredContent : {};
          var part = null, txt = "";
          (r && r.content ? r.content : []).forEach(function (c) {
            if (c.type === "image" && c.data && !part) part = c;
            else if (c.type === "text" && c.text && !txt) txt = c.text;
          });
          if (!part) throw new Error(txt || "the model returned no image");
          return new Promise(function (resolve, reject) {
            var out = new Image();
            out.onload = function () { resolve(out); };
            out.onerror = function () { reject(new Error("couldn't read the edited image")); };
            out.src = "data:" + (part.mimeType || "image/png") + ";base64," + part.data;
          });
        })
        .then(function (outImg) {
          // Stitch: full-res base, plus the edited crop only where the mask is.
          var full = makeCanvas(natW, natH);
          var fctx = full.getContext("2d");
          fctx.drawImage(src, 0, 0, natW, natH);
          var patch = makeCanvas(rect.w, rect.h);
          var pctx = patch.getContext("2d");
          pctx.drawImage(outImg, 0, 0, rect.w, rect.h);
          pctx.globalCompositeOperation = "destination-in";
          pctx.drawImage(featheredCropMask(maskCanvas, rect), 0, 0);
          fctx.drawImage(patch, rect.x, rect.y);
          return new Promise(function (resolve) { full.toBlob(resolve, "image/jpeg", 0.92); });
        })
        .then(function (blob) {
          if (!blob) throw new Error("couldn't build the final image");
          return uploadBlob(blob);
        })
        .then(function (up) {
          var store = { image_url: up.url, prompt: instruction || "Area edit with product reference" };
          if (base.url) store.edited_from = base.url;
          addJobArgs(store);
          return app.callServerTool({ name: "store_edited_render", arguments: store }, { timeout: 30000 });
        })
        .then(function (r) {
          var st = (r && r.structuredContent) ? r.structuredContent : {};
          var url = st.archivedUrls && st.archivedUrls[0];
          if (!url) throw new Error((r && r.content && r.content[0] && r.content[0].text) || "couldn't store the edit");
          var idx = pushRender(null, "image/jpeg", url, instruction, st.archivedFilenames[0]);
          baseIndex = idx;
          addCost(sc, "pro", 1);
          paintGallery();
          done("Area edit applied — only the painted area changed. It's the new base for further edits.");
        })
        .catch(function (err) { done("Edit failed: " + (err && err.message ? err.message : err), true); });
    });

    // ---------- Drag-and-drop + paste reference ----------
    var dragDepth = 0;
    function hasFiles(e) {
      if (!e.dataTransfer) return false;
      var types = e.dataTransfer.types;
      if (!types) return false;
      for (var i = 0; i < types.length; i++) if (types[i] === "Files") return true;
      return false;
    }
    window.addEventListener("dragenter", function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth += 1;
      wrapEl.classList.add("dragging");
    });
    window.addEventListener("dragover", function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
    });
    window.addEventListener("dragleave", function (e) {
      dragDepth -= 1;
      if (dragDepth <= 0) { dragDepth = 0; wrapEl.classList.remove("dragging"); }
    });
    window.addEventListener("drop", function (e) {
      dragDepth = 0;
      wrapEl.classList.remove("dragging");
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      var f = files[0];
      if (f.type && f.type.indexOf("image") === 0) { e.preventDefault(); loadReferenceFile(f); }
    });
    window.addEventListener("paste", function (e) {
      var cd = e.clipboardData;
      if (!cd) return;
      var file = null;
      if (cd.files && cd.files.length) {
        for (var i = 0; i < cd.files.length; i++) { if (cd.files[i].type.indexOf("image") === 0) { file = cd.files[i]; break; } }
      }
      if (!file && cd.items) {
        for (var j = 0; j < cd.items.length; j++) {
          if (cd.items[j].kind === "file" && cd.items[j].type.indexOf("image") === 0) { file = cd.items[j].getAsFile(); break; }
        }
      }
      if (file) { e.preventDefault(); loadReferenceFile(file); }
    });

    // ---------- Export sheet ----------
    exportBtnEl.addEventListener("click", function () {
      if (inFlight) return;
      var picks = [];
      for (var i = history.length - 1; i >= 0 && picks.length < 8; i--) {
        if (history[i].kind === "render" || history[i].kind === "restored") picks.push(i);
      }
      if (!picks.length) { setStatus("No renders to export yet.", true); return; }

      setStatus("Composing export sheet\\u2026");
      // Load all images (with crossOrigin) before drawing.
      var loaded = [];
      var pending = picks.length;
      var failed = false;
      picks.forEach(function (idx, order) {
        var im = history[idx];
        var img = makeImg(im);
        img.onload = function () { loaded[order] = { img: img, label: im.label }; if (--pending === 0 && !failed) drawSheet(loaded); };
        img.onerror = function () { failed = true; if (--pending === 0) setStatus("Export failed: an image couldn't load.", true); };
      });

      function drawSheet(items) {
        items = items.filter(function (x) { return x; });
        if (!items.length) { setStatus("Export failed: no images loaded.", true); return; }
        var cols = items.length === 1 ? 1 : 2;
        var rows = Math.ceil(items.length / cols);
        var cellW = 720, pad = 24, capH = 34, headerH = 64;
        // Determine a uniform cell height from the tallest image at cellW width.
        var cellH = 0;
        for (var i = 0; i < items.length; i++) {
          var iw = items[i].img.naturalWidth || 16, ih = items[i].img.naturalHeight || 9;
          var h = Math.round((cellW - pad) * (ih / iw));
          if (h > cellH) cellH = h;
        }
        if (cellH <= 0) cellH = 405;
        var canvasW = cols * cellW + pad;
        var canvasH = headerH + rows * (cellH + capH + pad) + pad;
        var canvas = document.createElement("canvas");
        canvas.width = canvasW; canvas.height = canvasH;
        var ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvasW, canvasH);

        var jt = jobTagEl.value.trim();
        var headerLabel = jt || new Date().toLocaleDateString();
        ctx.fillStyle = "#1a1a1a";
        ctx.font = "600 26px ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
        ctx.textBaseline = "top";
        ctx.fillText("Render options \\u2014 " + headerLabel, pad, 20);

        for (var k = 0; k < items.length; k++) {
          var col = k % cols, row = Math.floor(k / cols);
          var x = pad + col * cellW;
          var y = headerH + row * (cellH + capH + pad);
          var iw2 = items[k].img.naturalWidth || 16, ih2 = items[k].img.naturalHeight || 9;
          var drawW = cellW - pad;
          var drawH = Math.round(drawW * (ih2 / iw2));
          if (drawH > cellH) { drawH = cellH; drawW = Math.round(cellH * (iw2 / ih2)); }
          var ox = x + Math.round(((cellW - pad) - drawW) / 2);
          try { ctx.drawImage(items[k].img, ox, y, drawW, drawH); } catch (e) { setStatus("Export failed: canvas tainted (cross-origin image).", true); return; }
          ctx.fillStyle = "#1a1a1a";
          ctx.font = "500 18px ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
          ctx.fillText(items[k].label, x, y + cellH + 6);
        }

        uploadCanvasAndDownload(canvas, "Export sheet");
      }
    });

    // ---------- Export helpers (sheet + compare) ----------
    // Sandboxed iframes can't download data: URLs, so upload the JPEG to /upload
    // and open the stored copy with ?dl=1.
    function uploadCanvasAndDownload(canvas, what) {
      canvas.toBlob(function (blob) {
        if (!blob) { setStatus("Export failed: couldn't build the image.", true); return; }
        var upHeaders = { "content-type": "image/jpeg" };
        if (UPLOAD_TOKEN && UPLOAD_TOKEN.indexOf("__") !== 0) upHeaders["x-upload-token"] = UPLOAD_TOKEN;
        fetch(WORKER_ORIGIN + "/upload", { method: "POST", body: blob, headers: upHeaders })
          .then(function (r) { if (!r.ok) return r.text().then(function (t) { throw new Error(r.status + " " + t); }); return r.json(); })
          .then(function (j) {
            setStatus(what + " ready \\u2014 opening download.");
            if (app && typeof app.openLink === "function") app.openLink({ url: j.url + "?dl=1" }).catch(function () {});
          })
          .catch(function (err) { setStatus(what + " upload failed: " + (err && err.message ? err.message : err), true); });
      }, "image/jpeg", 0.92);
    }
    // Draw img to fill (x,y,w,h), cropping overflow — same as CSS object-fit:cover.
    function drawCover(ctx, img, x, y, w, h) {
      var iw = img.naturalWidth || w, ih = img.naturalHeight || h;
      var scale = Math.max(w / iw, h / ih);
      var sw = w / scale, sh = h / scale;
      ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
    }
    function drawTag(ctx, textStr, x, y, alignRight, size) {
      ctx.font = "600 " + size + "px ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
      var padX = Math.round(size * 0.55), padY = Math.round(size * 0.35);
      var w = ctx.measureText(textStr).width + padX * 2, h = size + padY * 2;
      var left = alignRight ? x - w : x;
      ctx.fillStyle = "rgba(0,0,0,0.62)";
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(left, y, w, h, Math.round(size * 0.35)); else ctx.rect(left, y, w, h);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.textBaseline = "top";
      ctx.fillText(textStr, left + padX, y + padY);
    }

    // Export exactly what the compare shows: the slider split at its current
    // position (before on the left, after on the right), or the side-by-side pair.
    function exportCompare() {
      var partner = partnerIndex();
      if (previewIndex < 0 || partner < 0) { setStatus("Open a compare first (Preview \\u2192 Compare\\u2026).", true); return; }
      var beforeIm = history[partner], afterIm = history[previewIndex];
      var before = makeImg(beforeIm), after = makeImg(afterIm);
      var pending = 2, failed = false;
      setStatus("Composing compare image\\u2026");
      function done() {
        if (--pending > 0) return;
        if (failed) { setStatus("Export failed: an image couldn't load.", true); return; }
        try { compareView === "side" ? drawSide() : drawSlider(); }
        catch (e) { setStatus("Export failed: canvas tainted (cross-origin image).", true); }
      }
      before.onload = done; after.onload = done;
      before.onerror = function () { failed = true; done(); };
      after.onerror = function () { failed = true; done(); };

      function drawSlider() {
        var W = after.naturalWidth || 1600, H = after.naturalHeight || 900;
        var canvas = document.createElement("canvas");
        canvas.width = W; canvas.height = H;
        var ctx = canvas.getContext("2d");
        ctx.drawImage(after, 0, 0, W, H);
        var splitX = Math.round(W * comparePct / 100);
        if (splitX > 0) {
          ctx.save();
          ctx.beginPath(); ctx.rect(0, 0, splitX, H); ctx.clip();
          drawCover(ctx, before, 0, 0, W, H);
          ctx.restore();
        }
        var lineW = Math.max(3, Math.round(W / 400));
        ctx.fillStyle = "#f5b301";
        ctx.fillRect(splitX - lineW / 2, 0, lineW, H);
        var r = Math.max(12, Math.round(W / 70));
        ctx.beginPath(); ctx.arc(splitX, H / 2, r, 0, Math.PI * 2); ctx.fill();
        var size = Math.max(16, Math.round(W / 60)), m = Math.round(size * 0.8);
        if (comparePct > 8) drawTag(ctx, beforeIm.label, m, m, false, size);
        if (comparePct < 92) drawTag(ctx, afterIm.label, W - m, m, true, size);
        uploadCanvasAndDownload(canvas, "Compare image");
      }

      function drawSide() {
        // Both panels at the same height (the taller source's, capped) so the pair lines up.
        var H = Math.min(Math.max(before.naturalHeight || 900, after.naturalHeight || 900), 2000);
        var wB = Math.round(H * (before.naturalWidth || 16) / (before.naturalHeight || 9));
        var wA = Math.round(H * (after.naturalWidth || 16) / (after.naturalHeight || 9));
        var gap = Math.round(H / 40), capH = Math.round(H / 14), pad = gap;
        var canvas = document.createElement("canvas");
        canvas.width = pad + wB + gap + wA + pad;
        canvas.height = pad + H + capH;
        var ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(before, pad, pad, wB, H);
        ctx.drawImage(after, pad + wB + gap, pad, wA, H);
        ctx.fillStyle = "#1a1a1a";
        ctx.font = "600 " + Math.round(capH * 0.45) + "px ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(beforeIm.label, pad + wB / 2, pad + H + capH / 2);
        ctx.fillText(afterIm.label, pad + wB + gap + wA / 2, pad + H + capH / 2);
        uploadCanvasAndDownload(canvas, "Side-by-side image");
      }
    }

    // ---------- Gallery restore on connect ----------
    function restoreGallery() {
      if (history.length) return Promise.resolve();
      if (!app || typeof app.callServerTool !== "function") return Promise.resolve();
      var args = { limit: 12 };
      addJobArgs(args);
      return app.callServerTool({ name: "list_renders", arguments: args }, { timeout: 30000 })
        .then(function (r) {
          var sc = (r && r.structuredContent) ? r.structuredContent : {};
          var renders = Array.isArray(sc.renders) ? sc.renders : [];
          if (!renders.length) return;
          // Oldest-first so r1, r2... numbering reads naturally.
          var ordered = renders.slice().reverse();
          for (var i = 0; i < ordered.length; i++) {
            var it = ordered[i] || {};
            restoreCounter += 1;
            history.push({
              url: it.url || undefined,
              mimeType: "image/jpeg",
              label: it.label || ("r" + restoreCounter),
              kind: "restored",
              filename: it.filename || undefined,
              prompt: it.prompt || undefined,
              jt: it.jtSavedJobNumber ? { jobId: it.jtSavedJobId || null, jobNumber: it.jtSavedJobNumber, fileName: it.jtFileName || "" } : undefined,
            });
          }
          paintGallery();
          setStatus(history.length + " render(s) restored from your library \\u2014 click any to preview.");
        })
        .catch(function () { /* older server / no tool — swallow silently */ });
    }

    // ---------- Connect ----------
    app.connect()
      .then(function () {
        loadJobs();
        return restoreGallery();
      })
      .then(function () {
        if (!history.length) setStatus("Connected. Generate a render to see it here.");
      })
      .catch(function (err) { setStatus("Widget connect failed: " + (err && err.message ? err.message : err), true); });
  </script>
</body>
</html>`
