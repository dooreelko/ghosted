#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["qrcode[pil]>=8.0"]
# ///
"""Generate a QR code PNG with a logo in the center.

Usage: scripts/make-book-qr.py URL LOGO OUTPUT

Error correction is H (~30% recoverable) so the center image does not break
scanning; the logo covers about a quarter of the code's width.
"""
import sys

import qrcode
from PIL import Image
from qrcode.constants import ERROR_CORRECT_H

LOGO_FRACTION = 0.25
BOX_SIZE = 20
BORDER = 4


def main(url: str, logo_path: str, out_path: str) -> None:
    qr = qrcode.QRCode(error_correction=ERROR_CORRECT_H, box_size=BOX_SIZE, border=BORDER)
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white").convert("RGBA")

    logo = Image.open(logo_path).convert("RGBA")
    side = int(img.width * LOGO_FRACTION)
    logo = logo.resize((side, side), Image.LANCZOS)
    pos = ((img.width - side) // 2, (img.height - side) // 2)
    # White backing keeps the logo's transparent areas from showing modules.
    img.paste(Image.new("RGBA", logo.size, "white"), pos)
    img.alpha_composite(logo, pos)

    img.convert("RGB").save(out_path)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
