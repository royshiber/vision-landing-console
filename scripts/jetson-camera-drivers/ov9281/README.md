# OV9281 on Jetson Orin Nano CAM0 (JetPack 7 / L4T 39)

Out-of-tree tegracam driver for an OmniVision OV9281 (1MP, global shutter, mono, 2-lane MIPI). Arducam does not ship a driver for L4T 39.x. This pack builds `nv_ov9281.ko` against the kernel headers already on the board and a CAM0 overlay shaped like NVIDIA's `tegra234-p3767-camera-p3768-imx219-A.dtbo`.

Target board: **p3767-0000 + p3768** (Orin Nano devkit), JetPack 7 / L4T 39.2.1, kernel `6.8.12-1021-tegra`.

This pack does not send flight commands, write a flight controller, or apply / restart Companion.

## Argus does not process mono

This prebuilt `tegra-camera.ko` rejects `pixel_phase = "y"` (`Unsupported pixel format`, then `tegracam register failed (-22)`). The overlay therefore declares every mode as bayer RAW10 with `pixel_phase = "rggb"` and `csi_pixel_bit_depth = "10"`. `sensor_common` turns that into `bayer_rggb10`, and `camera_common` maps it to `MEDIA_BUS_FMT_SRGGB10_1X10`. The CSI payload is still mono. Userspace reads pixelformat `RG10` (10-bit samples in 16-bit little-endian words) and treats each sample as luminance.

There is no 8-bit mode. `sensor_common` has no `bayer_*8` string, so a second mode with depth 8 fails probe the same way `y` did. `MEDIA_BUS_FMT_SRGGB8_1X8` stays in the driver for the day that string exists. Do not add an 8-bit mode to the overlay until then.

**Do not use `nvarguscamerasrc`, Argus, or `VLC_CAM1_DEVICE=csi:N`.** Those paths need the ISP, and the ISP does not process this sensor. Capture with V4L2 on `/dev/video0`.

| sensor_mode | size | format declared to tegra-camera | v4l2 pixelformat |
|---|---|---|---|
| 0 | 1280x800 | bayer RAW10 rggb | `RG10` |
| 1 | 1280x720 | bayer RAW10 rggb | `RG10` |

Default is mode 0 at 60 fps. Gain, exposure, and frame rate are the usual tegracam controls (`gain`, `exposure`, `frame_rate`, `sensor_mode`).

## Wiring

- Plug the module into the **CAM0** socket (the connector NVIDIA's imx219-A overlay enables), not CAM1.
- The devkit sockets are 15-pin. Many Arducam OV9281 boards are 22-pin. Use a 22-pin to 15-pin adapter, pin 1 to pin 1 (the white triangle / contact side). A reversed cable will not probe.
- The link is **2-lane MIPI**. Do not force a 4-lane overlay.
- I2C address in the overlay is **0x60** (7-bit). That is the usual Arducam / mainline address. An 8-bit address of `0xC0` is the same device.
- Reset is CAM0_PWDN, main GPIO H.6, the same pin as the stock imx219-A overlay (`reset-gpios`, `GPIO_ACTIVE_HIGH`). The driver holds it low, enables the 24 MHz clock, then drives it high before the chip-id read. The overlay does not hog CAM0_PWDN, because a hog would make `gpio_request` fail. CAM1_PWDN stays hogged low.
- The sensor clock is BPMP `EXTPERIPH1`, with `clock-names = "extperiph1", "pllp_grtba"` and `mclk = "extperiph1"`. The stock imx219-A overlay has no `clocks` property. `mclk` alone makes `devm_clk_get("extperiph1")` return `-ENOENT` (`-2`), which is the `no clock extperiph1` line. The names above are the tegra234 camera-node pair (the p3785 camera dtsi) so the clock lookup succeeds.

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

`verify.sh` checks dmesg for `chip id 0x9281`, lists `/dev/video0` formats, captures 10 frames at 1280x800 (`RG10`, then `RGGB`), writes `/tmp/ov9281-verify/frame0.png`, and prints `mean` and `stddev`. `RG10` is 10-bit mono in 16-bit little-endian words. `RGGB` is only tried as an 8-bit fallback; this overlay does not register an 8-bit mode.

- `classification varied` — pixels are not a flat field.
- `classification black` — mean near 0 and stddev near 0. Lens cap, no light, or the CSI port is not delivering samples.
- `classification flat` — stuck at one non-zero code. Often a clock or lane problem.

Remove the module, delete label JetsonIO, and set DEFAULT back to primary:

```bash
sudo ./uninstall.sh
sudo reboot
```

`install.sh` copies the dtbo to `/boot` and applies it by name through jetson-io:

```bash
python3 /opt/nvidia/jetson-io/config-by-hardware.py -n 2="Camera OV9281-A"
```

Header `2` is `Jetson 22pin CSI Connector` on the Orin Nano devkit. The script reads `config-by-hardware.py -l` and picks the header whose name contains `22pin` and `CSI`. `OV9281_CSI_HEADER` overrides that number. jetson-io creates label `JetsonIO` with `FDT` plus `OVERLAYS`, sets `DEFAULT JetsonIO`, and leaves `primary` alone. An `OVERLAYS` line on `primary` with no `FDT` is ignored by UEFI; `install.sh` removes that line before it applies the label.

If `/opt/nvidia/jetson-io/config-by-hardware.py` is missing, `install.sh` writes the same `JetsonIO` label itself. The `FDT` path comes from `/proc/device-tree/nvidia,dtsfilename` (`kernel_<name>.dtb` under `/boot/dtb`), then from the p3767-0005 super dtb if that file is present. `OV9281_FDT` overrides it. If jetson-io exists and the command fails, install exits non-zero and does not fall back.

`uninstall.sh` sets `DEFAULT primary`, deletes label `JetsonIO`, and strips this dtbo from every `OVERLAYS` line. That is the state jetson-io left on a board that was installed by hand. It does not copy `extlinux.conf.ov9281.bak` back over the live file.

Both scripts are idempotent. They exit non-zero if they are not root, not a Jetson, or a copy / `depmod` / extlinux edit fails. The first-install snapshot is `/boot/extlinux/extlinux.conf.ov9281.bak`. Uninstall deletes that snapshot after the label is gone.

Manual capture:

```bash
v4l2-ctl -d /dev/video0 --list-formats-ext
v4l2-ctl -d /dev/video0 --set-ctrl=sensor_mode=0,bypass_mode=0
v4l2-ctl -d /dev/video0 --set-fmt-video=width=1280,height=800,pixelformat=RG10 \
  --stream-mmap --stream-count=10 --stream-to=/tmp/ov9281.raw
python3 frame_stats.py /tmp/ov9281.raw --width 1280 --height 800 \
  --pixelformat RG10 --png /tmp/ov9281.png
```

720p is `sensor_mode=1` with `height=720`, still `RG10`. The samples are mono even though the fourcc says RGGB.

## Troubleshooting

**Wrong I2C address.** dmesg shows `chip id read failed` with an errno, or `i2cdetect -r` on the camera mux bus is empty at `0x60` after a probe that powered the sensor. An empty scan while the probe never released reset is expected: CAM0_PWDN stays low and the module is unpowered. Some boards answer at `0x70` (or `0x10` if the straps were copied from an IMX219). Change `reg = <0x60>` in the overlay, rebuild, reinstall, reboot. Find the mux bus with `i2cdetect -l` and scan it only after dmesg shows `power on for chip-id`.

**No sensor power or clock.** Probe logs `clock extperiph1 lookup failed`, `mclk before chip-id read failed`, or `chip id read failed (N)` with the I2C errno. A successful read logs `ov9281 chip id 0x9281 at i2c addr 0x60`. The driver enables EXTPERIPH1 at 24 MHz, holds CAM0_PWDN low, then drives it high before that read. `i2cdetect -r` on bus 9 showing nothing at `0x60` after a failed probe that never got past `tegracam register failed` does not mean the sensor is absent. Check the adapter orientation if the id read itself returns an errno.

**Camera-mux GPIO.** CAM0 is `cam_i2cmux/i2c@0`, selected by AON GPIO CC.3. If the mux stays on the other channel, the sensor is invisible and CAM1's bus is the one that answers. dmesg from `i2c-mux-gpio` or a probe on `i2c@1` means the hog / mux gpio is wrong. Do not point the sensor node at `i2c@1` unless the module is physically in CAM1; use the C-port macros instead and move the reset gpio to CAM1_PWDN.

**Probe ok, capture times out.** The chip id path is I2C. Frames are CSI. The port-index does not match the socket. Compare with the stock imx219-A dtbo (command above) and edit the two macros. Also try `lane_polarity = "0"`.

**`/dev/video0` missing but the chip id is in dmesg.** The tegracam platform matches `devname` / `sysfs-device-tree`. The i2c bus number in `devname = "ov9281 9-0060"` can differ. Read the client name from dmesg (`ov9281 10-0060` or similar) and set `devname` to that exact string. The sysfs path must match the node that actually probed.

**Black PNG with a good probe.** Port, lanes, or `discontinuous_clk`. The driver sets MIPI register `0x4800` to `0x20` (gated clock) to match `discontinuous_clk = "yes"`. If you switch the DT to `"no"`, also change that register to `0x00`.

**`Unsupported pixel format` / `Failed to read mode0 image props`.** The overlay still has `pixel_phase = "y"`, or an 8-bit mode. This `tegra-camera.ko` only accepts bayer 10/12/14. Rebuild and reinstall this overlay (`pixel_phase = "rggb"`, depth 10) and reboot. Do not rebuild `tegra-camera.ko`.

**Overlay installed but no `ov9281` node and no `i2c-9`.** `extlinux.conf` has `OVERLAYS` on `primary` and no `FDT` line. UEFI ignores that. `grep -n -E 'DEFAULT|LABEL|FDT|OVERLAYS' /boot/extlinux/extlinux.conf` should show `DEFAULT JetsonIO` and, under `LABEL JetsonIO`, both an `FDT` line and the ov9281 dtbo. Re-run `sudo ./install.sh` and reboot. `sudo ./uninstall.sh` puts `DEFAULT` back on `primary` and deletes `JetsonIO`.

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

## nvidia/conftest.h

`camera_common.h` includes `nvidia/conftest.h`. That file is not installed on the Jetson. `build.sh` generates it before compiling the module, using NVIDIA's own conftest Makefile and `conftest.sh` vendored unmodified from the public L4T 39.2.1 tree:

https://gitlab.com/nvidia/nv-tegra/linux-nv-oot/-/tree/e71bacb7c611f880c5f341263967f13de54de3a9/scripts/conftest

Commit `e71bacb7c611f880c5f341263967f13de54de3a9` on branch `l4t/l4t-r39.2.1`. The copy lives in `third_party/nvidia-oot-conftest/`. The script runs it against `/lib/modules/$(uname -r)/build` so the `NV_*` feature macros follow this kernel. The generated header is `out/nvidia-conftest/nvidia/conftest.h`, and the module compile adds that parent directory to the include path. Do not hand-edit the generated header.

After the link, `build.sh` checks that `modinfo` vermagic's kernel release equals `uname -r`, and that every undefined symbol from `nm -u` is in the kernel `Module.symvers` or `/usr/src/nvidia/nvidia-public/Module.symvers`. Either mismatch fails the build.
