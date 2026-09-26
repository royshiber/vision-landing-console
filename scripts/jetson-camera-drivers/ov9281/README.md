# OV9281 on Jetson Orin Nano CAM0 (JetPack 7 / L4T 39)

Out-of-tree tegracam driver for an OmniVision OV9281 (1MP, global shutter, mono, 2-lane MIPI). Arducam does not ship a driver for L4T 39.x. This pack builds `nv_ov9281.ko` against the kernel headers already on the board and a CAM0 overlay shaped like NVIDIA's `tegra234-p3767-camera-p3768-imx219-A.dtbo`.

Target board: **p3767-0000 + p3768** (Orin Nano devkit), JetPack 7 / L4T 39.2.1, kernel `6.8.12-1021-tegra`.

This pack does not send flight commands, write a flight controller, or apply / restart Companion.

## Argus does not process mono

The overlay sets `mode_type = "bayer"` and `pixel_phase = "y"` so the VI will accept a mono stream. That is a placeholder, not a Bayer pattern. **Do not use `nvarguscamerasrc`, Argus, or `VLC_CAM1_DEVICE=csi:N`.** Those paths need the ISP, and the ISP does not process this sensor. Capture with V4L2 on `/dev/video0`.

| sensor_mode | size | format | v4l2 pixelformat |
|---|---|---|---|
| 0 | 1280x800 | RAW10 | `Y10` |
| 1 | 1280x720 | RAW10 | `Y10` |
| 2 | 1280x800 | RAW8 | `GREY` |
| 3 | 1280x720 | RAW8 | `GREY` |

Default is mode 0 at 60 fps. Gain, exposure, and frame rate are the usual tegracam controls (`gain`, `exposure`, `frame_rate`, `sensor_mode`).

## Wiring

- Plug the module into the **CAM0** socket (the connector NVIDIA's imx219-A overlay enables), not CAM1.
- The devkit sockets are 15-pin. Many Arducam OV9281 boards are 22-pin. Use a 22-pin to 15-pin adapter, pin 1 to pin 1 (the white triangle / contact side). A reversed cable will not probe.
- The link is **2-lane MIPI**. Do not force a 4-lane overlay.
- I2C address in the overlay is **0x60** (7-bit). That is the usual Arducam / mainline address. An 8-bit address of `0xC0` is the same device.
- Reset is CAM0_PWDN, main GPIO H.6, driven high to run. The camera I2C mux select is AON GPIO CC.3, which chooses `i2c@0` for CAM0.

## Which CSI port

On this carrier the imx219-A / CAM0 binding is:

```
port-index = <1>;
tegra_sinterface = "serial_b";
```

CSI `serial_a` (port-index 0) is not wired to a camera socket on Orin Nano. Confirm against the stock overlay before changing it:

```bash
dtc -I dtb -O dts /boot/tegra234-p3767-camera-p3768-imx219-A.dtbo | grep -E 'port-index|tegra_sinterface'
```

If that stock overlay uses a different pair, edit both macros at the top of `tegra234-p3767-camera-p3768-ov9281-A.dts` and rebuild. They must change together.

| socket | macros |
|---|---|
| CAM0, imx219-A on current p3768 trees | `serial_b` / `1` (this overlay) |
| the other socket (imx219-C) | `serial_c` / `2` |
| not connected on this devkit | `serial_a` / `0` |

`lane_polarity = "6"` matches the devkit CAM connector pin swap used by the imx219 overlays. If the picture is mirrored lane-to-lane noise, try `"0"`.

## How to tell an Arducam module

- Silkscreen or the FPC often says Arducam, UC-xxx, or B0331 / B0333. The sensor is still an OV9281.
- After the mux is selected, `i2cdetect` shows **0x60** and no sensor EEPROM at `0x50` (an IMX219 shows `0x10` plus `0x50`).
- Probe prints `chip id 0x9281`. OV9281 and OV9282 share that id; the mainline `ov9282` driver treats them as the same register map.
- A Waveshare or other OV9281 can use the same chip and the same address with a different flex pinout. If the chip id never appears, the adapter or the reset pinout is the first thing to check, not the register table.

## Commands on the Jetson

From this directory, after the module is plugged into CAM0:

```bash
sudo apt-get install -y build-essential device-tree-compiler v4l-utils python3-numpy
sudo ./build.sh
sudo ./install.sh
sudo reboot
```

After reboot:

```bash
sudo ./verify.sh
```

`verify.sh` checks dmesg for `chip id 0x9281`, lists `/dev/video0` formats, captures 10 frames at 1280x800 (`Y10`, then `GREY`), writes `/tmp/ov9281-verify/frame0.png`, and prints `mean` and `stddev`.

- `classification varied` — pixels are not a flat field.
- `classification black` — mean near 0 and stddev near 0. Lens cap, no light, or the CSI port is not delivering samples.
- `classification flat` — stuck at one non-zero code. Often a clock or lane problem.

Remove everything (extlinux returns to the snapshot taken at first install):

```bash
sudo ./uninstall.sh
sudo reboot
```

`install.sh` and `uninstall.sh` are idempotent. They exit non-zero if they are not root, not a Jetson, or a copy / `depmod` / extlinux edit fails. `config-by-hardware.py` is not used to apply the overlay: on 39.x it only lists NVIDIA's own cameras. The script edits the default label's `OVERLAYS` line and leaves every other label alone. The first-install backup is `/boot/extlinux/extlinux.conf.ov9281.bak`.

Manual capture, if you want a different mode:

```bash
v4l2-ctl -d /dev/video0 --list-formats-ext
v4l2-ctl -d /dev/video0 --set-ctrl=sensor_mode=0,bypass_mode=0
v4l2-ctl -d /dev/video0 --set-fmt-video=width=1280,height=800,pixelformat=Y10 \
  --stream-mmap --stream-count=10 --stream-to=/tmp/ov9281.raw
python3 frame_stats.py /tmp/ov9281.raw --width 1280 --height 800 \
  --pixelformat Y10 --png /tmp/ov9281.png
```

720p RAW10 is `sensor_mode=1` with `height=720`. RAW8 modes are `sensor_mode=2` or `3` and `pixelformat=GREY`.

## Troubleshooting

**Wrong I2C address.** dmesg shows `ov9281` probe with an I2C error, or `i2cdetect` on the camera mux bus is empty at `0x60`. Some boards answer at `0x70` (or `0x10` if the straps were copied from an IMX219). Change `reg = <0x60>` in the overlay, rebuild, reinstall, reboot. Find the mux bus with `i2cdetect -l` and scan it only after the overlay is applied.

**No sensor power or clock.** Chip-id read times out (`chip id read failed`). The CSI connector supplies 3.3 V / 1.8 V when the camera stack is up; a dark LED on the module or a missing 24 MHz clock looks the same on I2C. `mclk = "extperiph1"` asks the driver for the CAM0 clock. Modules with their own oscillator still probe if that clock get fails (the driver logs it and continues). If both the Jetson clock and a local oscillator are absent, the id read fails. Check the adapter orientation and that CAM0_PWDN (H.6) is the reset pin the module uses.

**Camera-mux GPIO.** CAM0 is `cam_i2cmux/i2c@0`, selected by AON GPIO CC.3. If the mux stays on the other channel, the sensor is invisible and CAM1's bus is the one that answers. dmesg from `i2c-mux-gpio` or a probe on `i2c@1` means the hog / mux gpio is wrong. Do not point the sensor node at `i2c@1` unless the module is physically in CAM1; use the C-port macros instead and move the reset gpio to CAM1_PWDN.

**Probe ok, capture times out.** The chip id path is I2C. Frames are CSI. The port-index does not match the socket. Compare with the stock imx219-A dtbo (command above) and edit the two macros. Also try `lane_polarity = "0"`.

**`/dev/video0` missing but the chip id is in dmesg.** The tegracam platform matches `devname` / `sysfs-device-tree`. The i2c bus number in `devname = "ov9281 9-0060"` can differ. Read the client name from dmesg (`ov9281 10-0060` or similar) and set `devname` to that exact string. The sysfs path must match the node that actually probed.

**Black PNG with a good probe.** Port, lanes, or `discontinuous_clk`. The driver sets MIPI register `0x4800` to `0x20` (gated clock) to match `discontinuous_clk = "yes"`. If you switch the DT to `"no"`, also change that register to `0x00`.

**Pixel phase rejected.** If the VI logs an unsupported `pixel_phase`, set `pixel_phase = "rggb"` as the Bayer placeholder. The samples are still mono. Argus will still not display them correctly; stay on V4L2.

## Files

| file | role |
|---|---|
| `nv_ov9281.c` | tegracam driver, chip id `0x9281`, modes above |
| `tegra234-p3767-camera-p3768-ov9281-A.dts` | CAM0 overlay |
| `build.sh` | module + `dtc` on the Jetson |
| `install.sh` / `uninstall.sh` | extlinux, `/lib/modules`, `/boot` |
| `verify.sh` / `frame_stats.py` | 10 frames, PNG, mean, stddev |
| `compile-test.sh` | host build against mainline 6.8 with stub tegracam headers |

`compile-test.sh` does not replace `build.sh` on the board. The 6.8 tegra headers and `Module.symvers` are only on the Jetson.
