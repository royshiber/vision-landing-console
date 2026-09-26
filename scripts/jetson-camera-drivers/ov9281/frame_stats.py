#!/usr/bin/env python3
"""Print mean and stddev of one OV9281 frame and write an 8-bit PNG.

Y10 / Y10  frames are little-endian 16-bit samples with 10 valid bits.
GREY frames are 8-bit. A flat black capture (mean near 0, stddev near 0)
is printed as classification black so a dead sensor is obvious.
"""

import argparse
import struct
import sys
import zlib

import numpy as np


def _chunk(tag, data):
    crc = zlib.crc32(tag + data) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)


def write_png_gray8(path, image):
    height, width = image.shape
    raw = b"".join(b"\x00" + image[y].tobytes() for y in range(height))
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", ihdr)
        + _chunk(b"IDAT", zlib.compress(raw, 9))
        + _chunk(b"IEND", b"")
    )
    with open(path, "wb") as fh:
        fh.write(png)


def decode_frame(buf, pixelformat):
    fmt = pixelformat.strip().upper()
    if fmt in ("Y10", "Y10 ", "GREY10", "Y16"):
        samples = np.frombuffer(buf, dtype="<u2")
        return np.bitwise_and(samples, 0x03FF).astype(np.float64), 10
    if fmt in ("GREY", "GRAY", "Y8"):
        return np.frombuffer(buf, dtype=np.uint8).astype(np.float64), 8
    raise SystemExit(f"unsupported pixelformat {pixelformat}")


def main(argv):
    parser = argparse.ArgumentParser(description="OV9281 frame mean/stddev and PNG")
    parser.add_argument("raw")
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=800)
    parser.add_argument("--pixelformat", default="Y10")
    parser.add_argument("--png", required=True)
    parser.add_argument("--frame", type=int, default=0)
    args = parser.parse_args(argv)

    fmt = args.pixelformat.strip().upper()
    if fmt in ("Y10", "Y10 ", "GREY10", "Y16"):
        frame_bytes = args.width * args.height * 2
    elif fmt in ("GREY", "GRAY", "Y8"):
        frame_bytes = args.width * args.height
    else:
        raise SystemExit(f"unsupported pixelformat {args.pixelformat}")

    with open(args.raw, "rb") as fh:
        data = fh.read()
    need = frame_bytes * (args.frame + 1)
    if len(data) < need:
        raise SystemExit(f"short capture: {len(data)} bytes, need {need}")

    buf = data[args.frame * frame_bytes : (args.frame + 1) * frame_bytes]
    samples, bits = decode_frame(buf, args.pixelformat)
    if samples.size != args.width * args.height:
        raise SystemExit("frame size does not match width*height")

    mean = float(samples.mean())
    stddev = float(samples.std())
    if bits == 10:
        preview = (samples.astype(np.uint16) >> 2).astype(np.uint8)
    else:
        preview = samples.astype(np.uint8)
    write_png_gray8(args.png, preview.reshape(args.height, args.width))

    if stddev < 0.5 and mean < 1.0:
        classification = "black"
    elif stddev < 0.5:
        classification = "flat"
    else:
        classification = "varied"

    print(f"mean {mean:.4f}")
    print(f"stddev {stddev:.4f}")
    print(f"classification {classification}")
    print(f"png {args.png}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
