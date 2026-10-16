"""Draws stand-in camera pictures (and a short clip) for the mock Home Assistant's cameras.
  python dev/make-camera-pictures.py   (needs Pillow; ffmpeg for the clip)
"""
import os
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = Path(__file__).parent / "cameras"
OUT.mkdir(exist_ok=True)
W, H = 1280, 720


def grad(d, box, top, bottom):
    x0, y0, x1, y1 = box
    for y in range(y0, y1):
        f = (y - y0) / max(1, (y1 - y0 - 1))
        c = tuple(round(top[i] + (bottom[i] - top[i]) * f) for i in range(3))
        d.line([(x0, y), (x1, y)], fill=c)


def osd(img, label):
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 26)
    except OSError:
        font = ImageFont.load_default()
    d.text((24, 20), "2026-10-16  21:42:07", fill=(255, 255, 255), font=font, stroke_width=2, stroke_fill=(0, 0, 0))
    d.text((24, H - 50), label, fill=(255, 255, 255), font=font, stroke_width=2, stroke_fill=(0, 0, 0))


def garden():
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    grad(d, (0, 0, W, 330), (126, 168, 205), (200, 214, 222))
    grad(d, (0, 330, W, H), (92, 132, 70), (58, 92, 46))
    for x in range(0, W, 46):  # fence
        d.rectangle([x, 250, x + 38, 360], fill=(132, 98, 70), outline=(98, 72, 52))
    d.rectangle([0, 270, W, 282], fill=(110, 82, 58))
    d.ellipse([880, 90, 1160, 330], fill=(64, 104, 58))  # tree
    d.rectangle([1005, 300, 1035, 430], fill=(88, 64, 44))
    d.polygon([(120, H), (520, 430), (640, 430), (520, H)], fill=(178, 170, 156))  # path
    d.ellipse([300, 520, 420, 600], fill=(170, 66, 72))  # flowers
    d.ellipse([200, 560, 290, 620], fill=(220, 190, 80))
    return img.filter(ImageFilter.GaussianBlur(1.2))


def front_door():
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    grad(d, (0, 0, W, H), (176, 150, 132), (150, 124, 108))
    for y in range(0, H, 36):  # bricks
        off = 0 if (y // 36) % 2 else 40
        for x in range(-80 + off, W, 80):
            d.rectangle([x, y, x + 76, y + 32], outline=(130, 96, 84))
    d.rectangle([470, 90, 810, 640], fill=(40, 66, 92), outline=(30, 48, 66), width=8)  # door
    for r in [(500, 130, 780, 330), (500, 370, 780, 600)]:
        d.rectangle(r, outline=(28, 46, 64), width=6)
    d.ellipse([740, 380, 762, 402], fill=(196, 168, 92))
    d.rectangle([420, 640, 860, H], fill=(140, 138, 132))
    d.rectangle([880, 300, 960, 400], fill=(36, 36, 36))  # house number
    return img.filter(ImageFilter.GaussianBlur(1.0))


def driveway():
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    grad(d, (0, 0, W, 260), (112, 140, 168), (176, 188, 198))
    grad(d, (0, 260, W, H), (128, 128, 124), (96, 96, 94))
    d.rectangle([0, 160, W, 270], fill=(150, 120, 104))  # houses opposite
    for x in range(40, W, 200):
        d.rectangle([x, 190, x + 60, 240], fill=(70, 86, 100))
    d.rounded_rectangle([420, 380, 900, 560], 40, fill=(60, 74, 98))  # car
    d.rounded_rectangle([500, 320, 820, 410], 30, fill=(70, 86, 112))
    d.rectangle([530, 335, 790, 395], fill=(150, 176, 196))
    for cx in (520, 800):
        d.ellipse([cx - 50, 520, cx + 50, 620], fill=(24, 24, 24))
    return img.filter(ImageFilter.GaussianBlur(1.0))


def shed():
    img = Image.new("RGB", (W, H))  # night vision: black and white (made grey below)
    d = ImageDraw.Draw(img)
    grad(d, (0, 0, W, H), (40, 40, 40), (90, 90, 90))
    d.rectangle([180, 160, 640, 600], fill=(120, 120, 120), outline=(160, 160, 160), width=4)  # shed
    d.polygon([(150, 170), (410, 60), (670, 170)], fill=(100, 100, 100))
    d.rectangle([340, 330, 480, 600], fill=(70, 70, 70))
    d.ellipse([820, 360, 1100, 640], fill=(80, 80, 80))  # bush
    return img.convert("L").convert("RGB").filter(ImageFilter.GaussianBlur(1.6))


for name, fn, label in [("garden", garden, "Garden"), ("front_door", front_door, "Front door"), ("driveway", driveway, "Driveway"), ("shed", shed, "Shed")]:
    img = fn()
    osd(img, label)
    img.save(OUT / f"{name}.jpg", quality=72)
    print(OUT / f"{name}.jpg")

# a short clip, so recordings play in the app
clip = OUT / "clip.mp4"
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-loop", "1", "-i", str(OUT / "driveway.jpg"), "-t", "3", "-vf", "scale=640:360,format=yuv420p",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "32", "-movflags", "+faststart", str(clip)], check=True)
print(clip, os.path.getsize(clip))
