#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["qrcode[pil]>=8.0"]
# ///
"""Generate a QR code PNG with a logo in the center.

Usage: scripts/make-book-qr.py [--rounded] URL LOGO OUTPUT

--rounded draws the modules with rounded corners instead of squares.

Error correction is H (~30% recoverable) so the center image does not break
scanning; the logo covers about a quarter of the code's width.
"""
import sys

import qrcode
from PIL import Image
from qrcode.constants import ERROR_CORRECT_H
from qrcode.image.styledpil import StyledPilImage
from qrcode.image.styles.moduledrawers.pil import RoundedModuleDrawer

LOGO_FRACTION = 0.25
BOX_SIZE = 20
BORDER = 4


def main(url: str, logo_path: str, out_path: str, rounded: bool = False) -> None:
    qr = qrcode.QRCode(error_correction=ERROR_CORRECT_H, box_size=BOX_SIZE, border=BORDER)
    qr.add_data(url)
    qr.make(fit=True)
    if rounded:
        img = qr.make_image(image_factory=StyledPilImage, module_drawer=RoundedModuleDrawer())
    else:
        img = qr.make_image(fill_color="black", back_color="white")
    img = img.convert("RGBA")

    logo = Image.open(logo_path).convert("RGBA")
    side = int(img.width * LOGO_FRACTION)
    logo = logo.resize((side, side), Image.LANCZOS)
    pos = ((img.width - side) // 2, (img.height - side) // 2)
    # White backing keeps the logo's transparent areas from showing modules.
    img.paste(Image.new("RGBA", logo.size, "white"), pos)
    img.alpha_composite(logo, pos)

    img.convert("RGB").save(out_path)


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--rounded"]
    if len(args) != 3:
        sys.exit(__doc__)
    main(*args, rounded="--rounded" in sys.argv[1:])
