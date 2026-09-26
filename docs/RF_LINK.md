# RF link (ground radio on the laptop)

The air unit of the MicoAir LR900A plugs into a spare flight-controller telemetry port. It does not plug into the Jetson. The ground unit is a CP2102 USB-UART on the Windows laptop. The console opens that COM port. ArduPilot routes MAVLink between the radio port and the Jetson port the companion already owns.

This feature does not write flight-controller parameters. Set the ports yourself before using RF.

## Ports to set

The Jetson stays on SERIAL4 (Matek TX3/RX3):

- `SERIAL4_PROTOCOL` = 2 (MAVLink2)
- `SERIAL4_BAUD` = 921 (921600)

GPS stays on SERIAL3. Do not move it.

The spare radio port is SERIAL1 (TELEM1), unless that port is already in use. Then use the free telemetry port and the matching `SERIALn_*` names.

- `SERIAL1_PROTOCOL` = 2 (MAVLink2)
- `SERIAL1_BAUD` = 57 (57600)

Both ports must be MAVLink. Any other protocol on the radio port stops routing to the Jetson.

Do not change `SR1_*` from this feature. The console asks for a low rate at runtime with `MAV_CMD_SET_MESSAGE_INTERVAL` (position and GPS at 1 Hz, attitude at 2 Hz). That is not a parameter write.

## What is routed

The companion announces component 191 on SERIAL4. The console sends only these `COMMAND_LONG` values to that component:

- 42001 uplink on or off (Wi-Fi or cellular)
- 42002 gimbal rate, zoom, or lock (the same SIYI actions as the gimbal pad)
- 42003 tracking start or stop, which the companion rejects

Flight commands stay on the existing allowlist to the autopilot. They are not added here.
