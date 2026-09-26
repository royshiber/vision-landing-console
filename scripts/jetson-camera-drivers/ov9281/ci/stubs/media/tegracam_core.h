/* SPDX-License-Identifier: GPL-2.0 */
/* Compile-test stand-in for NVIDIA tegracam_core.h / camera_common.h.
 * Field paths match the nv_imx219 / nv_imx708 call pattern. Layout is not
 * ABI; the Jetson build includes the real headers instead of this file.
 */
#ifndef _AIRVIX_STUB_TEGRACAM_CORE_H
#define _AIRVIX_STUB_TEGRACAM_CORE_H

#include <linux/types.h>
#include <linux/videodev2.h>

#include <media/v4l2-subdev.h>
#include <media/tegracam_utils.h>

struct regulator;
struct clk;
struct regmap;
struct regmap_config;
struct i2c_client;
struct device;

enum {
	SWITCH_OFF = 0,
	SWITCH_ON = 1,
};

struct camera_common_power_rail {
	struct regulator *dvdd;
	struct regulator *avdd;
	struct regulator *iovdd;
	struct clk *mclk;
	unsigned int reset_gpio;
	int state;
};

struct camera_common_regulators {
	const char *avdd;
	const char *iovdd;
	const char *dvdd;
};

struct camera_common_power_rail;

struct camera_common_pdata {
	unsigned int reset_gpio;
	const char *mclk_name;
	const char *parentclk_name;
	bool has_eeprom;
	struct camera_common_regulators regulators;
	int (*power_on)(struct camera_common_power_rail *pw);
	int (*power_off)(struct camera_common_power_rail *pw);
};

struct sensor_signal_properties {
	struct {
		u64 val;
	} pixel_clock;
};

struct sensor_image_properties {
	u32 line_length;
};

struct sensor_control_properties {
	u32 gain_factor;
	u32 framerate_factor;
	u32 exposure_factor;
};

struct sensor_mode_properties {
	struct sensor_signal_properties signal_properties;
	struct sensor_image_properties image_properties;
	struct sensor_control_properties control_properties;
};

struct camera_common_data {
	struct device *dev;
	struct regmap *regmap;
	struct v4l2_subdev subdev;
	struct camera_common_power_rail *power;
	struct camera_common_pdata *pdata;
	struct {
		struct sensor_mode_properties *sensor_modes;
	} sensor_props;
	int mode;
	int mode_prop_idx;
	void *priv;
};

struct camera_common_frmfmt {
	struct v4l2_frmsize_discrete size;
	const int *framerates;
	int num_framerates;
	bool hdr_en;
	int mode;
};

struct tegracam_device;

struct camera_common_sensor_ops {
	int numfrmfmts;
	const struct camera_common_frmfmt *frmfmt_table;
	int (*power_on)(struct camera_common_data *s_data);
	int (*power_off)(struct camera_common_data *s_data);
	int (*write_reg)(struct camera_common_data *s_data, u16 addr, u8 val);
	int (*read_reg)(struct camera_common_data *s_data, u16 addr, u8 *val);
	struct camera_common_pdata *(*parse_dt)(struct tegracam_device *tc_dev);
	int (*power_get)(struct tegracam_device *tc_dev);
	int (*power_put)(struct tegracam_device *tc_dev);
	int (*set_mode)(struct tegracam_device *tc_dev);
	int (*start_streaming)(struct tegracam_device *tc_dev);
	int (*stop_streaming)(struct tegracam_device *tc_dev);
};

struct tegracam_ctrl_ops {
	u32 numctrls;
	const u32 *ctrl_cid_list;
	int (*set_gain)(struct tegracam_device *tc_dev, s64 val);
	int (*set_exposure)(struct tegracam_device *tc_dev, s64 val);
	int (*set_frame_rate)(struct tegracam_device *tc_dev, s64 val);
	int (*set_group_hold)(struct tegracam_device *tc_dev, bool val);
};

struct tegracam_device {
	struct i2c_client *client;
	struct device *dev;
	struct camera_common_data *s_data;
	struct regmap_config *dev_regmap_config;
	struct camera_common_sensor_ops *sensor_ops;
	const struct v4l2_subdev_internal_ops *v4l2sd_internal_ops;
	struct tegracam_ctrl_ops *tcctrl_ops;
	char name[32];
	void *priv;
};

int tegracam_device_register(struct tegracam_device *tc_dev);
void tegracam_device_unregister(struct tegracam_device *tc_dev);
int tegracam_v4l2subdev_register(struct tegracam_device *tc_dev, bool is_default);
void tegracam_v4l2subdev_unregister(struct tegracam_device *tc_dev);
void tegracam_set_privdata(struct tegracam_device *tc_dev, void *priv);
void *tegracam_get_privdata(struct tegracam_device *tc_dev);
struct camera_common_data *to_camera_common_data(struct device *dev);

int camera_common_regulator_get(struct device *dev, struct regulator **reg,
				const char *supply);
int camera_common_mclk_enable(struct camera_common_data *s_data);
void camera_common_mclk_disable(struct camera_common_data *s_data);

#endif
