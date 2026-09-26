/* SPDX-License-Identifier: GPL-2.0 */
/*
 * Minimal cpp header so the OV9281 overlay builds with dtc on the Jetson
 * without the full NVIDIA kernel source tree.
 *
 * GPIO numbering matches mainline include/dt-bindings/gpio/tegra234-gpio.h.
 * JETSON_COMPATIBLE_P3768 matches the string jetson-io expects on p3768.
 */
#ifndef _DT_BINDINGS_TEGRA234_P3767_0000_COMMON_H
#define _DT_BINDINGS_TEGRA234_P3767_0000_COMMON_H

#define GPIO_ACTIVE_HIGH 0
#define GPIO_ACTIVE_LOW 1

#define TEGRA234_MAIN_GPIO_PORT_A   0
#define TEGRA234_MAIN_GPIO_PORT_B   1
#define TEGRA234_MAIN_GPIO_PORT_C   2
#define TEGRA234_MAIN_GPIO_PORT_D   3
#define TEGRA234_MAIN_GPIO_PORT_E   4
#define TEGRA234_MAIN_GPIO_PORT_F   5
#define TEGRA234_MAIN_GPIO_PORT_G   6
#define TEGRA234_MAIN_GPIO_PORT_H   7
#define TEGRA234_MAIN_GPIO_PORT_I   8
#define TEGRA234_MAIN_GPIO_PORT_J   9
#define TEGRA234_MAIN_GPIO_PORT_K  10
#define TEGRA234_MAIN_GPIO_PORT_L  11
#define TEGRA234_MAIN_GPIO_PORT_M  12
#define TEGRA234_MAIN_GPIO_PORT_N  13
#define TEGRA234_MAIN_GPIO_PORT_P  14
#define TEGRA234_MAIN_GPIO_PORT_Q  15
#define TEGRA234_MAIN_GPIO_PORT_R  16
#define TEGRA234_MAIN_GPIO_PORT_X  17
#define TEGRA234_MAIN_GPIO_PORT_Y  18
#define TEGRA234_MAIN_GPIO_PORT_Z  19
#define TEGRA234_MAIN_GPIO_PORT_AC 20
#define TEGRA234_MAIN_GPIO_PORT_AD 21
#define TEGRA234_MAIN_GPIO_PORT_AE 22
#define TEGRA234_MAIN_GPIO_PORT_AF 23
#define TEGRA234_MAIN_GPIO_PORT_AG 24

#define TEGRA234_MAIN_GPIO(port, offset) \
	((TEGRA234_MAIN_GPIO_PORT_##port * 8) + offset)

#define TEGRA234_AON_GPIO_PORT_AA 0
#define TEGRA234_AON_GPIO_PORT_BB 1
#define TEGRA234_AON_GPIO_PORT_CC 2
#define TEGRA234_AON_GPIO_PORT_DD 3
#define TEGRA234_AON_GPIO_PORT_EE 4
#define TEGRA234_AON_GPIO_PORT_GG 5

#define TEGRA234_AON_GPIO(port, offset) \
	((TEGRA234_AON_GPIO_PORT_##port * 8) + offset)

/* p3768 carrier + p3767 module, same tuple NVIDIA ships for imx219-A. */
#define JETSON_COMPATIBLE_P3768 \
	"nvidia,p3768-0000+p3767-0000", "nvidia,p3767-0000", "nvidia,tegra234"

/* CAM0 reset is main GPIO H.6. The I2C mux select is AON GPIO CC.3. */
#define CAM0_PWDN	TEGRA234_MAIN_GPIO(H, 6)
#define CAM1_PWDN	TEGRA234_MAIN_GPIO(AC, 0)
#define CAM_I2C_MUX	TEGRA234_AON_GPIO(CC, 3)

#endif
