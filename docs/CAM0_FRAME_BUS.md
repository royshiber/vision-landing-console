# Cam0 frame bus

OV9281 (Cam0) capture publishes frames into a shared-memory ring. Processing
modules subscribe without copying pixels and without stalling capture.
Vision output is telemetry only. Nothing in this path sends a MAVLink
command or writes a flight-controller parameter.

## Layout

`CAM0BUS1` header, then `slots` copies of metadata plus the mono8 image and
the 10-bit code (uint16). A subscriber reads the newest sequence. Frames it
missed increment `dropped`. The publisher never waits.

| Offset | Field |
| --- | --- |
| 0 | magic `CAM0BUS1` |
| 8 | version, width, height, stride, proc stride, slot count, slot bytes, flags, meta cap |
| 48 | latest sequence (`uint64`) |

Python attaches with `FrameBus(name, create=False).attach()`. A C++ mapper
can `shm_open` the same name and cast the header.

## Module

```python
class MeanModule:
    name = "mean"

    def on_frame(self, view):
        mono = view.mono8  # aliases the ring; do not keep it
        return {"module": self.name, "frame_index": view.index, "mean": float(mono.mean())}
```

Register it on `ModuleHost`. The sample in `scripts/jetson-companion/cam0/example_module.py`
is the same shape. The marker module (`marker.py`) returns id, pixel corners,
and pose. It does not import a MAVLink sender.

Run one module out of process:

```
python3 -m cam0.worker --bus <name> --module marker --seconds 2
```

## Raw pixels

16-bit little-endian, left-justified. `value >> 4` is the 12-bit container
(0..4095). `value >> 6` is the significant 10-bit code. Preview mono8 is
`value >> 8`.

## Safety

`auto_record_on_arm` defaults to false. A missing `/dev/video0` leaves Cam0
`absent` and the companion HTTP server keeps running. Marker pose is not a
navigation source.
