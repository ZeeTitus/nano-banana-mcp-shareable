# Live check of the widget's crop -> edit -> stitch area-edit pipeline (same math as
# render-widget.ts). Usage:
#   python -I scripts/area-edit-test.py <base.jpg> <x0> <y0> <x1> <y1> "<instruction>" <out-prefix>
# Needs MCP_URL in the environment (see scripts/_call.mjs); costs one pro render. Needs Pillow.
import base64, io, json, math, os, subprocess, sys
from PIL import Image, ImageDraw, ImageFilter

base_path, x0, y0, x1, y1, instruction, out = sys.argv[1], *map(int, sys.argv[2:6]), sys.argv[6], sys.argv[7]
src = Image.open(base_path).convert("RGB")
W, H = src.size
RATIOS = [(1, 1), (4, 3), (3, 4), (3, 2), (2, 3), (16, 9), (9, 16), (5, 4), (4, 5), (21, 9)]

def closest(w, h):
    return min(RATIOS, key=lambda r: abs(math.log((w / h) / (r[0] / r[1]))))

bw, bh = x1 - x0, y1 - y0
cw, ch = min(W, max(bw * 1.6, 640)), min(H, max(bh * 1.6, 640))
r = closest(cw, ch); ar = r[0] / r[1]
if cw / ch < ar: cw = ch * ar
else: ch = cw / ar
if cw > W: cw, ch = W, W / ar
if ch > H: ch, cw = H, H * ar
cx = max(0, min(W - cw, x0 + bw / 2 - cw / 2)); cy = max(0, min(H - ch, y0 + bh / 2 - ch / 2))
rect = tuple(round(v) for v in (cx, cy, cw, ch)); ratio = f"{r[0]}:{r[1]}"
print("crop", rect, ratio)

mask = Image.new("L", (W, H), 0); ImageDraw.Draw(mask).rectangle([x0, y0, x1, y1], fill=255)
crop = src.crop((rect[0], rect[1], rect[0] + rect[2], rect[1] + rect[3]))
s = min(1, 1600 / max(rect[2], rect[3])); ow, oh = round(rect[2] * s), round(rect[3] * s)
crop = crop.resize((ow, oh))
m_crop = mask.crop((rect[0], rect[1], rect[0] + rect[2], rect[1] + rect[3])).resize((ow, oh))
red = Image.new("RGB", (ow, oh), (255, 40, 40))
tinted = Image.composite(Image.blend(crop, red, 0.5), crop, m_crop)
tinted.save(f"{out}-sent.jpg", quality=92)
def b64(im):
    b = io.BytesIO(); im.save(b, "JPEG", quality=92); return base64.b64encode(b.getvalue()).decode()

setup = ("IMAGE 1 is a clean photo. IMAGE 2 is the SAME photo with a RED tint marking the area to edit. "
         "Output the edited version of IMAGE 1 (never the red tint). "
         "These are a close-up crop of a larger photo and your result is pasted back into it, so keep the framing, zoom, perspective, and position of everything exactly the same — do not zoom, crop, shift, or re-frame. "
         "The red mark is approximate and may overlap neighboring things — baseboards and trim, furniture and its legs, walls, rugs, doors, cabinets. Change ONLY what the instruction names; everything else inside the mark keeps exactly the shape, color, and detail it has in IMAGE 1. ")
prompt = ("You will edit a photograph using two images. " + setup +
          "Make the change described below in the marked area — the change must be clearly visible:\n"
          "- If it says to REMOVE, delete, hide, or take out something: remove it entirely and fill the space with what would naturally be behind it, matching the surrounding materials, lighting, perspective, and depth (a removed window becomes solid wall).\n"
          "- If it says to CHANGE, replace, recolor, swap, or upgrade: change that surface or object in the marked area to match the description, keeping its geometry.\n"
          "Do not add windows or any other opening. Produce a clean photorealistic result with no visible mask.\n\n"
          "User instruction: " + instruction)
args = {"prompt": prompt, "model": "pro",
        "reference_images": [{"data": b64(crop), "mime_type": "image/jpeg"}, {"data": b64(tinted), "mime_type": "image/jpeg"}],
        "reference_mode": "style", "style_preset": "general", "aspect_ratio": ratio, "skip_archive": True}
here = os.path.dirname(os.path.abspath(__file__))
res = subprocess.run(["node", os.path.join(here, "_call.mjs"), "generate_render_interactive"], input=json.dumps(args),
                     capture_output=True, text=True, cwd=os.path.dirname(here))
if res.returncode != 0: sys.exit(res.stderr)
result = json.loads(res.stdout)
img_part = next((c for c in result["content"] if c["type"] == "image"), None)
if not img_part: sys.exit("no image: " + json.dumps(result)[:500])
edited = Image.open(io.BytesIO(base64.b64decode(img_part["data"]))).convert("RGB")
print("model returned", edited.size, "archived:", result.get("structuredContent", {}).get("archivedUrls"))
edited.save(f"{out}-model.jpg", quality=92)

# Stitch: patch = edited crop scaled to rect, kept only inside the grown + blurred mask.
feather = max(3, round(max(rect[2], rect[3]) * 0.005))
m_full = mask.crop((rect[0], rect[1], rect[0] + rect[2], rect[1] + rect[3]))
grown = m_full.filter(ImageFilter.MaxFilter(2 * feather + 1)).filter(ImageFilter.GaussianBlur(feather))
patch = edited.resize((rect[2], rect[3]))
final = src.copy(); final.paste(patch, (rect[0], rect[1]), grown)
final.save(f"{out}-final.jpg", quality=92)
print("saved", f"{out}-final.jpg")
