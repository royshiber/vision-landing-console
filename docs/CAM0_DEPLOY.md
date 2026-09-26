# Cam0 deploy (Jetson, companion 2.5.4)

The camera service is a thread inside `airvix-companion`. No camera must
not stop the companion. This host does not SSH to the Jetson and does not
restart the service.

## Copy

From a checkout of this repo, on the Jetson, as the user that already runs
the companion (`royshiber`):

```
install -m 755 scripts/jetson-companion/companion_agent.py "$HOME/vlc-companion/companion_agent.py"
install -m 644 scripts/jetson-companion/cam0.json "$HOME/vlc-companion/cam0.json"
rm -rf "$HOME/vlc-companion/cam0"
cp -a scripts/jetson-companion/cam0 "$HOME/vlc-companion/cam0"
```

`scripts/jetson-companion/install.sh --apply` copies the same tree when run
on a Jetson as root. Default is `--dry-run` and copies nothing.

## Packages (L4T 39 / JetPack 7)

Prefer the distro OpenCV. Check before installing:

```
python3 -c 'import cv2; print(cv2.__version__)'
dpkg -l | awk '/libopencv|python3-opencv|python3-numpy|v4l-utils|gstreamer/{print $2, $3}'
```

If OpenCV is missing, the pipeline still captures, exposes, streams JPEG,
and detects the embedded 4x4 marker. OpenCV replaces the marker decoder
with `DICT_4X4_50` and the calibration solver with `calibrateCamera` when
it imports.

```
sudo apt-get install -y v4l-utils python3-numpy
# only if the import above failed:
sudo apt-get install -y python3-opencv gstreamer1.0-tools gstreamer1.0-plugins-good
```

No pip packages are required. Do not `pip install opencv` over the system
build on L4T.

## Config

`~/vlc-companion/cam0.json` is the systemd-friendly file. The unit can set
`Environment=VLC_CAM0_CONFIG=/home/royshiber/vlc-companion/cam0.json`.

Defaults: `/dev/video0`, 1280×800, RG10, AE on, short-exposure preference
4 ms, stream 8 fps JPEG quality 55 width 640 (cellular), marker module on,
`auto_record_on_arm` false. `source` `off` disables the thread.

Restart is the existing companion unit, by hand, after the copy:

```
systemctl --user restart airvix-companion
# or, if the unit is system-wide:
sudo systemctl restart airvix-companion
curl -s http://127.0.0.1:8081/api/health
```

Expect `agentVersion` `2.5.4`.

## Hardware check

```
cd "$HOME/vlc-companion"
python3 -m cam0.verify_hardware --print-marker 7
```

Print `cam0-marker-7.png`, hold it in view, run the script again. It reports
fps, drops, AE, whether the stream answers, and detect latency. It does not
arm and does not write parameters.

Before the first stream the driver wants:

```
v4l2-ctl -d /dev/video0 --set-ctrl=sensor_mode=0,bypass_mode=0
```

The capture path sets those itself when the controls exist.

If verify reports `capture: busy`, the companion already holds the camera.
Stop it, then retry:

```
systemctl --user stop airvix-companion
python3 -m cam0.bench --seconds 5
```

`cam0.bench` prints capture fps, per-stage milliseconds, CPU percent, the JPEG
encoder (`cv2` or `numpy`), and the exposure and gain applied. JPEG is timed
on the same worker the service uses. It does not invent a frame rate.
