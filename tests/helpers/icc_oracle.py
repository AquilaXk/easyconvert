"""Colour oracle for tests: converts 8-bit RGB triples on stdin through an ICC profile to sRGB with littlecms
(via Pillow's ImageCms), relative colorimetric, and writes the 8-bit result to stdout. Usage: icc_oracle.py PROFILE."""
import io
import sys

from PIL import Image, ImageCms

profile = ImageCms.getOpenProfile(sys.argv[1])
srgb = ImageCms.createProfile("sRGB")
raw = sys.stdin.buffer.read()
pixels = len(raw) // 3
image = Image.frombytes("RGB", (pixels, 1), raw)
transform = ImageCms.buildTransform(profile, srgb, "RGB", "RGB", renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC)
sys.stdout.buffer.write(ImageCms.applyTransform(image, transform).tobytes())
