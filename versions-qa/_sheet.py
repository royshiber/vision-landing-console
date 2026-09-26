
import json, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
items = json.loads(Path(sys.argv[1]).read_text())
states = ["normal","no-companion","confirm","progress","failed"]
views = ["1024x576","1280x720","1366x768","1440x900","1920x1080","360x740"]
cell_w, label_h, pad = 280, 28, 8
thumbs = {}
for item in items:
    im = Image.open(item["file"]).convert("RGB")
    ratio = cell_w / im.width
    thumbs[(item["state"], item["viewport"])] = im.resize((cell_w, max(1, int(im.height * ratio))), Image.Resampling.LANCZOS)
row_h = {}
for state in states:
    heights = [thumbs[(state, view)].height for view in views if (state, view) in thumbs]
    if not heights:
        continue
    row_h[state] = max(heights)
states = [state for state in states if state in row_h]
width = pad + len(views) * (cell_w + pad)
height = pad + label_h + sum(label_h + row_h[s] + pad for s in states)
sheet = Image.new("RGB", (width, height), (246, 244, 239))
draw = ImageDraw.Draw(sheet)
font = ImageFont.load_default()
for i, view in enumerate(views):
    draw.text((pad + i * (cell_w + pad), 6), view, fill=(20, 20, 20), font=font)
y = pad + label_h
for state in states:
    draw.text((pad, y), state, fill=(20, 20, 20), font=font)
    y += label_h
    for i, view in enumerate(views):
        im = thumbs.get((state, view))
        if im is None:
            continue
        x = pad + i * (cell_w + pad)
        sheet.paste(im, (x, y))
    y += row_h[state] + pad
out = Path(sys.argv[2])
sheet.save(out, "PNG")
print(out)
