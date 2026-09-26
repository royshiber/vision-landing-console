/* SPDX-License-Identifier: GPL-2.0 */
/* Compile-test stand-in. The Jetson build uses NVIDIA's real header. */
#ifndef _AIRVIX_STUB_TEGRA_V4L2_CAMERA_H
#define _AIRVIX_STUB_TEGRA_V4L2_CAMERA_H

enum {
	TEGRA_CAMERA_CID_GAIN = 0x009a2000,
	TEGRA_CAMERA_CID_EXPOSURE,
	TEGRA_CAMERA_CID_FRAME_RATE,
	TEGRA_CAMERA_CID_SENSOR_MODE_ID,
};

#endif
