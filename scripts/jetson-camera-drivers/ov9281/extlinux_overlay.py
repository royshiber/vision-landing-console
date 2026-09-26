#!/usr/bin/env python3
"""Idempotent OVERLAYS edits for /boot/extlinux/extlinux.conf.

Only the default LABEL (or an explicit one) gains the dtbo. Other stanzas
are left unchanged. add() is safe to run twice. remove() drops the path
from every stanza and deletes an OVERLAYS line that becomes empty.
"""

import argparse
import sys


def _strip_comment(text):
    if "#" in text:
        return text.split("#", 1)[0]
    return text


def _label_name(line):
    body = _strip_comment(line).strip()
    if body.upper().startswith("LABEL ") and len(body.split(None, 1)) == 2:
        return body.split(None, 1)[1].strip()
    return None


def _default_label(lines):
    for line in lines:
        body = _strip_comment(line).strip()
        if body.upper().startswith("DEFAULT ") and len(body.split(None, 1)) == 2:
            return body.split(None, 1)[1].strip()
    return None


def _stanza_bounds(lines):
    starts = []
    for i, line in enumerate(lines):
        if _label_name(line):
            starts.append(i)
    bounds = []
    for n, start in enumerate(starts):
        end = starts[n + 1] if n + 1 < len(starts) else len(lines)
        bounds.append((start, end, _label_name(lines[start])))
    return bounds


def _indent_of(line):
    return line[: len(line) - len(line.lstrip(" \t"))]


def _stanza_indent(lines, start, end):
    for line in lines[start + 1 : end]:
        if line.strip() and not line.lstrip().startswith("#"):
            indent = _indent_of(line)
            if indent:
                return indent
    return "\t"


def _split_paths(value):
    parts = []
    for tok in value.replace(",", " ").split():
        if tok and tok not in parts:
            parts.append(tok)
    return parts


def _join_paths(parts):
    return ",".join(parts)


def add_overlay(text, dtbo, label=None):
    newline = "\n" if text.endswith("\n") or text == "" else ""
    lines = text.splitlines()
    target = label or _default_label(lines)
    bounds = _stanza_bounds(lines)
    if not bounds:
        raise SystemExit("extlinux.conf has no LABEL stanza")
    if target is None:
        target = bounds[0][2]
    match = [b for b in bounds if b[2] == target]
    if not match:
        raise SystemExit(f"extlinux.conf has no LABEL {target}")
    start, end, _name = match[0]
    overlay_idx = None
    for i in range(start + 1, end):
        body = _strip_comment(lines[i]).strip()
        if body.upper().startswith("OVERLAYS"):
            overlay_idx = i
            break
    if overlay_idx is not None:
        raw = _strip_comment(lines[overlay_idx]).strip()
        value = raw.split(None, 1)[1] if len(raw.split(None, 1)) == 2 else ""
        paths = _split_paths(value)
        if dtbo in paths:
            return text if text.endswith("\n") else text + ("\n" if text else "")
        paths.append(dtbo)
        indent = _indent_of(lines[overlay_idx])
        lines[overlay_idx] = f"{indent}OVERLAYS {_join_paths(paths)}"
    else:
        indent = _stanza_indent(lines, start, end)
        insert_at = end
        while insert_at > start + 1 and lines[insert_at - 1].strip() == "":
            insert_at -= 1
        lines.insert(insert_at, f"{indent}OVERLAYS {dtbo}")
    out = "\n".join(lines)
    if text.endswith("\n") or newline:
        out += "\n"
    return out


def remove_overlay(text, dtbo):
    lines = text.splitlines()
    kept = []
    for line in lines:
        body = _strip_comment(line).strip()
        if body.upper().startswith("OVERLAYS"):
            raw = body
            value = raw.split(None, 1)[1] if len(raw.split(None, 1)) == 2 else ""
            paths = [p for p in _split_paths(value) if p != dtbo]
            if not paths:
                continue
            indent = _indent_of(line)
            kept.append(f"{indent}OVERLAYS {_join_paths(paths)}")
            continue
        kept.append(line)
    out = "\n".join(kept)
    if text.endswith("\n"):
        out += "\n"
    return out


def _self_test():
    sample = (
        "TIMEOUT 30\n"
        "DEFAULT primary\n"
        "\n"
        "LABEL primary\n"
        "\tMENU LABEL primary kernel\n"
        "\tLINUX /boot/Image\n"
        "\tAPPEND ${cbootargs} root=/dev/mmcblk0p1\n"
        "\n"
        "LABEL backup\n"
        "\tMENU LABEL backup\n"
        "\tLINUX /boot/Image.backup\n"
        "\tOVERLAYS /boot/other.dtbo\n"
    )
    dtbo = "/boot/tegra234-p3767-camera-p3768-ov9281-A.dtbo"
    once = add_overlay(sample, dtbo)
    twice = add_overlay(once, dtbo)
    if once != twice:
        raise SystemExit("add is not idempotent")
    if dtbo not in once.split("LABEL backup")[0]:
        raise SystemExit("dtbo missing from primary")
    if "OVERLAYS /boot/other.dtbo\n" not in once.split("LABEL backup", 1)[1]:
        raise SystemExit("backup stanza was modified")
    if once.count(dtbo) != 1:
        raise SystemExit("dtbo duplicated")
    appended = add_overlay(
        sample.replace(
            "\tAPPEND ${cbootargs} root=/dev/mmcblk0p1\n",
            "\tAPPEND ${cbootargs} root=/dev/mmcblk0p1\n\tOVERLAYS /boot/keep.dtbo\n",
        ),
        dtbo,
    )
    if "/boot/keep.dtbo," + dtbo not in appended and dtbo + ",/boot/keep.dtbo" not in appended:
        # order is existing then appended
        if "OVERLAYS /boot/keep.dtbo," + dtbo not in appended:
            raise SystemExit(f"failed to append to existing OVERLAYS:\n{appended}")
    again = add_overlay(appended, dtbo)
    if again != appended:
        raise SystemExit("second append duplicated the dtbo")
    removed = remove_overlay(again, dtbo)
    if dtbo in removed:
        raise SystemExit("remove left the dtbo in place")
    if "OVERLAYS /boot/keep.dtbo" not in removed:
        raise SystemExit("remove dropped a foreign overlay")
    if "LABEL backup" not in removed or "OVERLAYS /boot/other.dtbo" not in removed:
        raise SystemExit("remove touched the backup stanza")
    cleared = remove_overlay(once, dtbo)
    if "OVERLAYS" in cleared.split("LABEL backup")[0]:
        raise SystemExit("empty OVERLAYS line was kept")
    if remove_overlay(cleared, dtbo) != cleared:
        raise SystemExit("remove is not idempotent")
    print("extlinux_overlay self-test ok")


def main(argv):
    parser = argparse.ArgumentParser(description="edit extlinux OVERLAYS")
    parser.add_argument("action", nargs="?", choices=("add", "remove"))
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--file")
    parser.add_argument("--dtbo")
    parser.add_argument("--label")
    args = parser.parse_args(argv)
    if args.self_test:
        _self_test()
        return 0
    if args.action not in ("add", "remove"):
        parser.error("add or remove is required")
    if not args.file or not args.dtbo:
        parser.error("add/remove need --file and --dtbo")
    with open(args.file, "r", encoding="utf-8") as fh:
        text = fh.read()
    if args.action == "add":
        updated = add_overlay(text, args.dtbo, label=args.label)
    else:
        updated = remove_overlay(text, args.dtbo)
    if updated != text:
        with open(args.file, "w", encoding="utf-8") as fh:
            fh.write(updated)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
