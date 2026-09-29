"""One-page checkerboard for printing at 100% scale.

9 by 6 inner corners are 10 by 7 squares. At 25 mm the board is 250 by 175 mm,
so the page is A4 landscape.
"""

from __future__ import annotations

from pathlib import Path

INNER_COLS = 9
INNER_ROWS = 6
SQUARE_MM = 25
PT_PER_MM = 72.0 / 25.4


def _page():
    squares_x = INNER_COLS + 1
    squares_y = INNER_ROWS + 1
    sq = SQUARE_MM * PT_PER_MM
    board_w = squares_x * sq
    board_h = squares_y * sq
    page_w = 841.89
    page_h = 595.28
    x0 = (page_w - board_w) / 2.0
    y0 = (page_h - board_h) / 2.0 + 8
    ops = ["0 0 0 rg"]
    for row in range(squares_y):
        for col in range(squares_x):
            if (row + col) % 2 == 0:
                continue
            x = x0 + col * sq
            y = y0 + row * sq
            ops.append(f"{x:.2f} {y:.2f} {sq:.2f} {sq:.2f} re f")
    ops.append("BT /F1 11 Tf 36 18 Td (AIRVIX  9x6 inner corners  25 mm squares  print at 100 percent) Tj ET")
    stream = "\n".join(ops).encode("ascii")
    objects = []
    objects.append(b"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n")
    objects.append(
        f"2 0 obj << /Type /Pages /Count 1 /Kids [3 0 R] >> endobj\n".encode("ascii")
    )
    objects.append(
        (
            "3 0 obj << /Type /Page /Parent 2 0 R "
            f"/MediaBox [0 0 {page_w:.2f} {page_h:.2f}] "
            "/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n"
        ).encode("ascii")
    )
    objects.append(
        f"4 0 obj << /Length {len(stream)} >> stream\n".encode("ascii")
        + stream
        + b"\nendstream endobj\n"
    )
    objects.append(b"5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n")
    out = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for obj in objects:
        offsets.append(len(out))
        out.extend(obj)
    xref = len(out)
    out.extend(f"xref\n0 {len(offsets)}\n".encode("ascii"))
    out.extend(b"0000000000 65535 f \n")
    for off in offsets[1:]:
        out.extend(f"{off:010d} 00000 n \n".encode("ascii"))
    out.extend(
        f"trailer << /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode("ascii")
    )
    return bytes(out)


def write_board_pdf(path):
    dest = Path(path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(_page())
    return dest


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[3]
    print(write_board_pdf(root / "docs" / "calibration-board.pdf"))
