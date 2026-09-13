# Cellular full-ops prep — plug-in checklist

AIRVIX cellular is a **MAVLink second path** through the Jetson (Huawei E3372 USB), same class as radio telemetry for commands and telemetry. Companion-HTTP is **not** the flight MAVLink path.

This document is the operator checklist for when the stick arrives. Software already dry-runs without hardware. Cloud Agent VMs stay dry-run and must not SSH to a Jetson.

Hebrew companion: `docs/CELLULAR_FULL_OPS.he.md`.

## Locked product

1. Radio and cellular may both be up. The operator picks which link carries commands.
2. Parameters and Jetson status/install are expected on **both** radio and cellular (via the active MAVLink command link, or Companion HTTP for Jetson status — never Companion-HTTP as the FC command path).
3. Annotated vision video is **cellular only**. Radio never satisfies video.
4. Four-row widget: סלולר / רדיו / בית·Tailscale / RC.
5. No invented “cellular up” without a modem. No invented quality %. No ARM / LAND / auto-land from this prep.

## When the modem arrives

1. **SIM** — seat a working SIM in the E3372. Do not put APN secrets in git.
2. **Antennas** — attach the stick antennas before USB power.
3. **USB** — plug the E3372 into the Jetson. First enumerate may be mass-storage; `scripts/jetson-cellular/` udev + usb_modeswitch switch it to HiLink ethernet or stick tty.
4. **Status** — on the Jetson:

```
./scripts/jetson-cellular/e3372-status.sh --dry-run
sudo ./scripts/jetson-cellular/install.sh --apply
./scripts/jetson-cellular/e3372-status.sh --write
```

Unplugged → `present: false`, `reason: modem_absent`. Plugged → `present: true` plus `iface` and `ip` only if the Huawei netdev has an address. `ip` is the USB link to the stick, not a public WAN address.

5. **Tailscale** — keep Tailscale up after the cell NIC appears so home tests and field ops share the same Companion path:

```
./scripts/jetson-cellular/tailscale-check.sh --dry-run
```

Does not ping a host and does not store an auth key. Verify from the console **רשת בית** row that the mission computer answers.

6. **MAVLink cellular** — documented bind matches console dual-link (`udp 0.0.0.0:14560`):

```
./scripts/jetson-cellular/cellular-mavlink-endpoint.sh --dry-run
```

On the console: סלולר → התחבר. If both radio and cellular are up, pick the active command link. Params READ/WRITE follow that MAVLink link (`getActiveConnection` / command-link id). Remote connect is refused while the modem is absent (unless loopback mock).

7. **Video** — annotated vision stays off until a real annotated stream exists on cellular. Radio up does not unlock video. `GET /api/links/annotated-video` stays `available: false` with `modem_absent` or `stream_absent`.

8. **Params** — with the active command link on cellular (or radio), use the existing parameter READ/WRITE APIs. This pack does not add a second write path.

9. **Remote update (readiness only)**

| Step | Meaning |
|---|---|
| Console ↔ Jetson reachable | Tailscale (home) or the same Tailscale path over cell. **רשת בית** row / Companion status. |
| Companion install | Existing `POST /api/jetson/install`. Manual. Not auto-apply / restart. |
| FC param / firmware | Still a Human Gate / ADVANCE GO. **No flash button in this PR.** |

`GET /api/links/update-readiness` is status only: `autoDeployFc: false`, `fcFirmwareHumanGate: true`.

The console **מוכנות** Status panel now shows the same honesty in-app:

- Exp#1 field checklist (`fieldPreflight` on `GET /api/vision/landing-readiness`): four link rows, cameras dry-run / absent / live, Companion, MAVLink, archive ready, Tailscale, `modem_absent` (including status-file missing), PLND observe-only, Ask GO, and explicit **blocked** rows for ARM/LAND and live nav switch.
- Staged **עדכון בקר ומחשב משימה** checklist: versions known, real link quality only, backup/rollback note, Human Gate required to flash. No flash button.

`scripts/jetson-cellular/cellular-mavlink-endpoint.sh --status` prints the documented udp `:14560` bind plus status-file honesty (`statusFileMissing` when `/run/airvix/e3372.status` is absent). It does not bind.

## Console honesty (no stick)

| Surface | Default |
|---|---|
| `probeHuaweiE3372` | `modem_absent` |
| Companion `/api/v1/status/modem` | `modem_absent` when `/run/airvix/e3372.status` is missing |
| `GET /api/links` cellular row | `modem_absent`; connect/disconnect stay on the four-row widget |
| Quality % | Only from a real CSQ / RSSI / percent. Otherwise bars stay unknown |
| Companion reachable (home) | Does **not** mark the modem present |

When Companion later reports `modem.present: true` from the Jetson status file, the console uses that report (the stick lives on the Jetson, not the console PC).

## Residual gaps (need hardware)

- Live E3372 USB, SIM registration, and WAN address.
- CSQ / real signal percent from the stick (no AT/HiLink scrape in this pack).
- Binding the cellular MAVLink UDP socket on the Jetson (documented, not started here).
- Annotated encoder egress over cell.
- Operator verify that Tailscale stays up on the cell NIC.
- Any FC firmware write — Human Gate, not this prep.

## Safety

- No flight commands.
- No Companion apply / restart.
- No automatic FC flash.
- No APN, tokens, or machine addresses in `scripts/jetson-cellular/`.
- Cloud Agent: dry-run only. Do not SSH to a Jetson.
