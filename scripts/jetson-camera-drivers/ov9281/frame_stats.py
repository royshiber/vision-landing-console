#!/usr/bin/env python3
"""Print mean and stddev of one OV9281 frame and write an 8-bit PNG.

RG10 (and the Y10 alias) frames are little-endian 16-bit words. V4L2
SRGGB10 puts the 10 bits in the low end of each word. Tegra's T_R16
capture can sit higher in the word. The script picks the lowest right
shift that puts every sample in 10 bits and prints that shift.
The sensor is mono; the RGGB pattern is only how tegra-camera names
the stream. RGGB (and the GREY alias) frames are 8-bit. A flat black
capture (mean near 0, stddev near 0) is printed as classification
black so a dead sensor is obvious.
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


def _kind(pixelformat):
    fmt = pixelformat.strip().upper()
    if fmt in ("RG10", "RG10 ", "SRGGB10", "Y10", "Y10 ", "GREY10", "Y16"):
        return 10
    if fmt in ("RGGB", "SRGGB8", "GREY", "GRAY", "Y8"):
        return 8
    raise SystemExit(f"unsupported pixelformat {pixelformat}")


def detect_alignment(raw_u16, bits=10):
    """Lowest right shift whose window holds every sample.

    A word that already fits in 10 bits is shift 0 (V4L2 SRGGB10).
    A dark frame does not fill the top of that window, so this is the
    smallest shift that still keeps the highest set bit, not a guess
    that the data is left-justified in the 16-bit container.
    """
    if raw_u16.size == 0:
        return 0
    highest = int(raw_u16.max())
    shift = 0
    limit = 16 - bits
    while shift < limit and (highest >> (shift + bits)) != 0:
        shift += 1
    return shift


def decode_frame(buf, pixelformat):
    bits = _kind(pixelformat)
    if bits == 10:
        raw = np.frombuffer(buf, dtype="<u2")
        shift = detect_alignment(raw, 10)
        samples = (raw >> shift) & np.uint16(0x03FF)
        return samples.astype(np.float64), 10, shift, int(raw.min()), int(raw.max())
    samples = np.frombuffer(buf, dtype=np.uint8).astype(np.float64)
    return samples, 8, 0, int(samples.min()) if samples.size else 0, int(samples.max()) if samples.size else 0


def main(argv):
    parser = argparse.ArgumentParser(description="OV9281 frame mean/stddev and PNG")
    parser.add_argument("raw")
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=800)
    parser.add_argument("--pixelformat", default="RG10")
    parser.add_argument("--png", required=True)
    parser.add_argument("--frame", type=int, default=0)
    args = parser.parse_args(argv)

    bits = _kind(args.pixelformat)
    if bits == 10:
        frame_bytes = args.width * args.height * 2
    else:
        frame_bytes = args.width * args.height

    with open(args.raw, "rb") as fh:
        data = fh.read()
    need = frame_bytes * (args.frame + 1)
    if len(data) < need:
        raise SystemExit(f"short capture: {len(data)} bytes, need {need}")

    buf = data[args.frame * frame_bytes : (args.frame + 1) * frame_bytes]
    samples, bits, shift, raw_min, raw_max = decode_frame(buf, args.pixelformat)
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
    if bits == 10:
        print(f"alignment shift {shift}")
        print(f"raw_u16_min {raw_min}")
        print(f"raw_u16_max {raw_max}")
    print(f"png {args.png}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
