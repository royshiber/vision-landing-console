#!/usr/bin/env python3
"""Idempotent extlinux.conf edits for the OV9281 overlay.

UEFI ignores an OVERLAYS line on a label that has no FDT line. jetson-io
writes a new JetsonIO label with both. These helpers do the same when
jetson-io is not installed, and remove that label on uninstall.
"""

import argparse
import sys
import tempfile


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


def _set_default(lines, label):
    for i, line in enumerate(lines):
        body = _strip_comment(line).strip()
        if body.upper().startswith("DEFAULT "):
            indent = _indent_of(line)
            lines[i] = f"{indent}DEFAULT {label}"
            return
    lines.insert(0, f"DEFAULT {label}")


def _stanza_field(lines, start, end, key):
    key = key.upper()
    for i in range(start + 1, end):
        body = _strip_comment(lines[i]).strip()
        parts = body.split(None, 1)
        if parts and parts[0].upper() == key:
            return parts[1] if len(parts) == 2 else ""
    return None


def _copy_boot_lines(lines, start, end, indent):
    kept = []
    for key in ("MENU", "LINUX", "INITRD", "APPEND"):
        if key == "MENU":
            for i in range(start + 1, end):
                body = _strip_comment(lines[i]).strip()
                if body.upper().startswith("MENU LABEL"):
                    kept.append(f"{indent}{body}")
                    break
            continue
        value = _stanza_field(lines, start, end, key)
        if value is not None:
            kept.append(f"{indent}{key} {value}")
    return kept


def jetsonio_ready(text, dtbo, label="JetsonIO"):
    lines = text.splitlines()
    if _default_label(lines) != label:
        return False
    bounds = [b for b in _stanza_bounds(lines) if b[2] == label]
    if not bounds:
        return False
    start, end, _name = bounds[0]
    fdt = _stanza_field(lines, start, end, "FDT")
    overlays = _stanza_field(lines, start, end, "OVERLAYS")
    if not fdt:
        return False
    return dtbo in _split_paths(overlays or "")


def add_jetsonio(text, dtbo, fdt, label="JetsonIO", source="primary"):
    if jetsonio_ready(text, dtbo, label):
        return text if text.endswith("\n") else text + "\n"
    lines = text.splitlines()
    bounds = _stanza_bounds(lines)
    src = [b for b in bounds if b[2] == source]
    if not src:
        raise SystemExit(f"extlinux.conf has no LABEL {source}")
    src_start, src_end, _name = src[0]
    indent = _stanza_indent(lines, src_start, src_end)
    block = [f"LABEL {label}"]
    block.extend(_copy_boot_lines(lines, src_start, src_end, indent))
    block.append(f"{indent}FDT {fdt}")
    block.append(f"{indent}OVERLAYS {dtbo}")
    existing = [b for b in bounds if b[2] == label]
    if existing:
        start, end, _name = existing[0]
        lines[start:end] = block + [""]
    else:
        if lines and lines[-1].strip():
            lines.append("")
        lines.extend(block)
        lines.append("")
    _set_default(lines, label)
    out = "\n".join(lines)
    if not out.endswith("\n"):
        out += "\n"
    return out


def remove_jetsonio(text, dtbo, label="JetsonIO", restore="primary"):
    lines = text.splitlines()
    default_before = _default_label(lines)
    bounds = _stanza_bounds(lines)
    existing = [b for b in bounds if b[2] == label]
    removed_label = False
    if existing:
        start, end, _name = existing[0]
        while end < len(lines) and lines[end].strip() == "":
            end += 1
        del lines[start:end]
        removed_label = True
    stripped = remove_overlay("\n".join(lines) + ("\n" if text.endswith("\n") or lines else "\n"), dtbo)
    lines = stripped.splitlines()
    if removed_label or default_before == label:
        if any(b[2] == restore for b in _stanza_bounds(lines)):
            _set_default(lines, restore)
    out = "\n".join(lines)
    if out and not out.endswith("\n"):
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

    fdt = "/boot/dtb/kernel_tegra234-p3768-0000+p3767-0005-nv-super.dtb"
    stray = add_overlay(sample, dtbo)
    if jetsonio_ready(stray, dtbo):
        raise SystemExit("OVERLAYS without FDT must not count as JetsonIO")
    # install.sh strips the ignored primary line, then adds the new label.
    # add_jetsonio itself must not copy that OVERLAYS line into JetsonIO.
    kept = add_jetsonio(stray, dtbo, fdt)
    if kept.split("LABEL JetsonIO", 1)[1].count(dtbo) != 1:
        raise SystemExit(f"JetsonIO copied the primary OVERLAYS line:\n{kept}")
    created = add_jetsonio(remove_overlay(stray, dtbo), dtbo, fdt)
    if not jetsonio_ready(created, dtbo):
        raise SystemExit(f"add_jetsonio did not produce a bootable label:\n{created}")
    if "DEFAULT JetsonIO" not in created.split("LABEL", 1)[0]:
        raise SystemExit("DEFAULT was not switched to JetsonIO")
    primary = created.split("LABEL JetsonIO", 1)[0]
    if dtbo in primary:
        raise SystemExit(f"primary still lists the dtbo:\n{created}")
    jetson = created.split("LABEL JetsonIO", 1)[1]
    for needle in (f"FDT {fdt}", f"OVERLAYS {dtbo}", "LINUX /boot/Image", "APPEND ${cbootargs}"):
        if needle not in jetson:
            raise SystemExit(f"JetsonIO stanza missing {needle}:\n{created}")
    if "LABEL backup" not in created or "OVERLAYS /boot/other.dtbo" not in created:
        raise SystemExit("add_jetsonio touched the backup stanza")
    if add_jetsonio(created, dtbo, fdt) != created:
        raise SystemExit("add_jetsonio is not idempotent")

    # The board today: jetson-io label plus the ignored primary OVERLAYS line.
    board = (
        "TIMEOUT 30\n"
        "DEFAULT JetsonIO\n"
        "\n"
        "LABEL primary\n"
        "\tMENU LABEL primary kernel\n"
        "\tLINUX /boot/Image\n"
        "\tINITRD /boot/initrd\n"
        "\tAPPEND ${cbootargs} root=/dev/mmcblk0p1\n"
        f"\tOVERLAYS {dtbo}\n"
        "\n"
        "LABEL JetsonIO\n"
        "\tMENU LABEL Custom Header Config: <CSI Camera OV9281-A>\n"
        "\tLINUX /boot/Image\n"
        "\tINITRD /boot/initrd\n"
        "\tAPPEND ${cbootargs} root=/dev/mmcblk0p1\n"
        f"\tFDT {fdt}\n"
        f"\tOVERLAYS {dtbo}\n"
    )
    if not jetsonio_ready(board, dtbo):
        raise SystemExit("current board extlinux was not recognised")
    reverted = remove_jetsonio(board, dtbo)
    if "LABEL JetsonIO" in reverted or dtbo in reverted:
        raise SystemExit(f"remove_jetsonio left the label or the dtbo:\n{reverted}")
    if "DEFAULT primary" not in reverted:
        raise SystemExit("remove_jetsonio did not restore DEFAULT primary")
    if "LINUX /boot/Image" not in reverted or "INITRD /boot/initrd" not in reverted:
        raise SystemExit("remove_jetsonio dropped the primary boot files")
    if remove_jetsonio(reverted, dtbo) != reverted:
        raise SystemExit("remove_jetsonio is not idempotent")
    untouched = (
        "DEFAULT backup\n"
        "\n"
        "LABEL primary\n"
        "\tLINUX /boot/Image\n"
        "\n"
        "LABEL backup\n"
        "\tLINUX /boot/Image.backup\n"
    )
    if remove_jetsonio(untouched, dtbo) != untouched:
        raise SystemExit("remove_jetsonio rewrote a file that was not ours")

    with tempfile.TemporaryDirectory() as tmp:
        path = tmp + "/extlinux.conf"
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(sample)
        if main(["has-jetsonio", "--file", path, "--dtbo", dtbo]) != 1:
            raise SystemExit("has-jetsonio should fail before the label exists")
        if main(["add-jetsonio", "--file", path, "--dtbo", dtbo, "--fdt", fdt]) != 0:
            raise SystemExit("add-jetsonio cli failed")
        if main(["has-jetsonio", "--file", path, "--dtbo", dtbo]) != 0:
            raise SystemExit("has-jetsonio should pass after add-jetsonio")
        if main(["add-jetsonio", "--file", path, "--dtbo", dtbo, "--fdt", fdt]) != 0:
            raise SystemExit("second add-jetsonio cli failed")
        with open(path, encoding="utf-8") as fh:
            written = fh.read()
        if written.count("LABEL JetsonIO") != 1 or written.count(dtbo) != 1:
            raise SystemExit(f"cli add duplicated the label:\n{written}")
        if main(["remove-jetsonio", "--file", path, "--dtbo", dtbo]) != 0:
            raise SystemExit("remove-jetsonio cli failed")
        with open(path, encoding="utf-8") as fh:
            written = fh.read()
        if "LABEL JetsonIO" in written or dtbo in written or "DEFAULT primary" not in written:
            raise SystemExit(f"cli remove did not restore primary:\n{written}")
    print("extlinux_overlay self-test ok")


def main(argv):
    parser = argparse.ArgumentParser(description="edit extlinux for the OV9281 overlay")
    parser.add_argument(
        "action",
        nargs="?",
        choices=("add", "remove", "has-jetsonio", "add-jetsonio", "remove-jetsonio"),
    )
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--file")
    parser.add_argument("--dtbo")
    parser.add_argument("--fdt")
    parser.add_argument("--label")
    args = parser.parse_args(argv)
    if args.self_test:
        _self_test()
        return 0
    if args.action not in ("add", "remove", "has-jetsonio", "add-jetsonio", "remove-jetsonio"):
        parser.error("an action is required")
    if not args.file or not args.dtbo:
        parser.error("--file and --dtbo are required")
    with open(args.file, "r", encoding="utf-8") as fh:
        text = fh.read()
    label = args.label or "JetsonIO"
    if args.action == "has-jetsonio":
        return 0 if jetsonio_ready(text, args.dtbo, label=label) else 1
    if args.action == "add-jetsonio":
        if not args.fdt:
            parser.error("add-jetsonio needs --fdt")
        updated = add_jetsonio(text, args.dtbo, args.fdt, label=label)
    elif args.action == "remove-jetsonio":
        updated = remove_jetsonio(text, args.dtbo, label=label)
    elif args.action == "add":
        updated = add_overlay(text, args.dtbo, label=args.label)
    else:
        updated = remove_overlay(text, args.dtbo)
    if updated != text:
        with open(args.file, "w", encoding="utf-8") as fh:
            fh.write(updated)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
