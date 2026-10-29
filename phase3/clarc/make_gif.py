#!/usr/bin/env python3
"""Animate demo.json as a mock Claude Code session (left) building the diagram (right): demo.gif + demo.mp4.

Per step: the request is typed, a short pause, the clarc skill runs, a trimmed reply appears, the image crossfades.
Steps flagged skip_in_animation are left out. Needs Pillow and ffmpeg; run render.py first so the step images are current."""
import json, os, re, shutil, subprocess, tempfile
from PIL import Image, ImageDraw, ImageFont

here = os.path.dirname(os.path.abspath(__file__))
os.chdir(here)

W, H, FPS, TOTAL_S = 1400, 788, 12, 30
END_HOLD_S = 10
LEFT_W = 612
BG, PANEL, FG, DIM = (30, 30, 30), (45, 45, 48), (220, 220, 220), (140, 140, 140)
USER_BG = (58, 58, 62)
GREEN, ORANGE, BLUE = (106, 190, 120), (230, 150, 80), (120, 170, 240)
MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
SIZE, LINE_H, PAD = 16, 24, 22
font, bold, small = ImageFont.truetype(MONO, SIZE), ImageFont.truetype(BOLD, SIZE), ImageFont.truetype(MONO, 12)
RIGHT = (LEFT_W, 0, W, H)
CAPTION_H = 34

demo = json.load(open("demo.json"))
steps = [s for s in demo["steps"] if not s.get("skip_in_animation")]


def trim(text, limit=190):
    """the reply's first sentences, up to limit characters"""
    text = re.sub(r"\s+", " ", text or "").strip()
    out = ""
    for sent in re.split(r"(?<=[.!?:])\s+", text):
        if out and len(out) + len(sent) + 1 > limit:
            break
        out = f"{out} {sent}".strip()
    return out if len(out) <= limit + 60 else out[:limit].rsplit(" ", 1)[0] + "…"


def wrap(text, width_px, f=font):
    lines, cur = [], ""
    for word in text.split(" "):
        probe = f"{cur} {word}".strip()
        if f.getlength(probe) <= width_px or not cur:
            cur = probe
        else:
            lines.append(cur)
            cur = word
    return lines + [cur]


def fit(path):
    """the step image scaled into the right pane, centred on white"""
    pane = Image.new("RGB", (W - LEFT_W, H), "white")
    img = Image.open(path).convert("RGB")
    box = (W - LEFT_W - 2 * PAD, H - CAPTION_H - PAD)
    k = min(box[0] / img.width, box[1] / img.height)
    img = img.resize((max(1, int(img.width * k)), max(1, int(img.height * k))), Image.LANCZOS)
    pane.paste(img, ((pane.width - img.width) // 2, CAPTION_H + (box[1] - img.height) // 2))
    return pane


blank = Image.new("RGB", (W - LEFT_W, H), "white")
panes = [fit(s["image"]) for s in steps]

# --- timeline: a list of (kind, payload) events, each lasting `frames` frames ---
frames_for = lambda secs: max(1, round(secs * FPS))
per_step = TOTAL_S / len(steps)


def left_frame(history, live):
    """terminal pane: committed lines plus the live (partly typed) line, scrolled to the bottom"""
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.rectangle((0, 0, LEFT_W, H), fill=BG)
    d.rectangle((0, 0, LEFT_W, 30), fill=PANEL)
    d.text((PAD, 8), "claude  ~/projects/ghost", font=small, fill=DIM)
    rows = history + ([live] if live else [])
    room = (H - 30 - 2 * PAD) // LINE_H
    for i, row in enumerate(rows[-room:]):
        x, y = PAD, 30 + PAD + i * LINE_H
        if row and len(row[0]) > 3:
            d.rectangle((PAD - 10, y - 2, LEFT_W - PAD + 10, y + LINE_H - 3), fill=row[0][3])
        for text, color, f, *_ in row:
            d.text((x, y), text, font=f, fill=color)
            x += f.getlength(text)
    return img


def render(history, live, old_pane, new_pane, mix, caption):
    img = left_frame(history, live)
    pane = Image.blend(old_pane, new_pane, mix) if mix < 1 else new_pane
    img.paste(pane, (LEFT_W, 0))
    d = ImageDraw.Draw(img)
    d.rectangle((LEFT_W, 0, W, CAPTION_H), fill=(245, 245, 245))
    d.text((LEFT_W + PAD, 10), caption, font=small, fill=(80, 80, 80))
    d.line((LEFT_W, 0, LEFT_W, H), fill=(70, 70, 70))
    return img


def lines_of(text, color, prefix, f=font, bg=None):
    """wrapped rows; the prefix leads the first row, later rows are indented to match"""
    wrapped = wrap(text, LEFT_W - 2 * PAD - f.getlength(prefix) - 4, f)
    return [[((prefix if i == 0 else " " * len(prefix)) + l, color, f, *([bg] if bg else []))] for i, l in enumerate(wrapped)]


tmp = tempfile.mkdtemp(prefix="clarc-gif-")
n = 0
history, old, shown_caption = [], blank, "start"


def emit(img):
    global n
    img.save(f"{tmp}/f{n:05d}.png")
    n += 1


for i, s in enumerate(steps):
    new = panes[i]
    caption = f"step {i + 1}/{len(steps)} · {s['id'].split('-', 1)[1].replace('-', ' ')} · {s.get('crossings', 0)} crossings"
    request = s.get("user_request") or ""
    before = shown_caption
    reply = lines_of(trim(s.get("assistant_response")), FG, "● ")
    tool = [[("● ", GREEN, bold), ("Skill(clarc:clarc)", FG, font)], [("● ", GREEN, bold), ("Bash(clarc --file graph.clarc.json)", FG, font)]]

    typed = lines_of(request, FG, "> ", bg=USER_BG) if request else []
    plain = " ".join(request.split())
    secs_typing = min(1.4, len(plain) / 45) if request else 0
    secs_fixed = secs_typing + 0.4 + 0.9 + 0.8 + 0.4
    hold = max(0.5, per_step - secs_fixed)

    # typing: reveal the request character by character
    nf = frames_for(secs_typing) if request else 0
    for k in range(nf):
        shown = plain[: int(len(plain) * (k + 1) / nf)] + ("█" if k % 2 == 0 else " ")
        emit(render(history + lines_of(shown, FG, "> ", bg=USER_BG), None, old, old, 1, before))
    if typed:
        history = history + typed
    # pause, then the skill runs
    for _ in range(frames_for(0.4)):
        emit(render(history, None, old, old, 1, before))
    for k in range(frames_for(0.9)):
        dots = "." * (k % 4)
        emit(render(history + tool[: 1 + (k > 3)] , [(f"* Working{dots}", ORANGE, font)], old, old, 1, before))
    history = history + tool
    # reply appears (typed fast), image crossfades in alongside
    reveal = frames_for(0.8)
    full = trim(s.get("assistant_response"))
    for k in range(reveal):
        shown = full[: int(len(full) * (k + 1) / reveal)]
        rows = history + lines_of(shown, FG, "● ")
        emit(render(rows, None, old, new, min(1, (k + 1) / frames_for(0.4)), caption))
    history = history + reply + [[("", FG, font)]]
    for _ in range(frames_for(hold)):
        emit(render(history, None, new, new, 1, caption))
    old, shown_caption = new, caption

# the finished diagram stays up
for _ in range(frames_for(END_HOLD_S)):
    emit(render(history, None, old, old, 1, shown_caption))

# --- encode ---
out_gif, out_mp4 = "demo.gif", "demo.mp4"
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS), "-i", f"{tmp}/f%05d.png",
                "-vf", "split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4",
                "-loop", "0", out_gif], check=True)
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS), "-i", f"{tmp}/f%05d.png",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", out_mp4], check=True)
shutil.rmtree(tmp)
print(f"{n} frames, {n / FPS:.1f}s -> {out_gif} ({os.path.getsize(out_gif) // 1024} KB), {out_mp4} ({os.path.getsize(out_mp4) // 1024} KB)")
