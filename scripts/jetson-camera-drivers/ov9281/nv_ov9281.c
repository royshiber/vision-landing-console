// SPDX-License-Identifier: GPL-2.0
/*
 * nv_ov9281.c — OmniVision OV9281 (1MP global-shutter mono) for Jetson.
 *
 * Out-of-tree tegracam sensor driver for L4T 39.x (kernel 6.8 tegra).
 * Modelled on NVIDIA's public nv_imx219.c / the r36 nv_imx* probe path
 * (tegracam_device_register, sensor_mode, gain / exposure / frame rate).
 *
 * Register tables are the mainline Linux 6.8 ov9282 driver
 * (drivers/media/i2c/ov9282.c, GPL-2.0, Intel), which binds ovti,ov9281
 * and checks chip id 0x9281. Arducam has no L4T 39 driver; this module
 * is the replacement. It does not send flight commands.
 *
 * Argus / the ISP does not process mono. Capture is V4L2 on /dev/video0.
 */

#include <linux/clk.h>
#include <linux/delay.h>
#include <linux/gpio.h>
#include <linux/i2c.h>
#include <linux/math64.h>
#include <linux/module.h>
#include <linux/of.h>
#include <linux/of_device.h>
#include <linux/of_gpio.h>
#include <linux/regmap.h>
#include <linux/regulator/consumer.h>
#include <linux/slab.h>
#include <linux/string.h>
#include <linux/sysfs.h>
#include <linux/version.h>

#include <media/tegra_v4l2_camera.h>
#include <media/tegracam_core.h>
#include <media/tegracam_utils.h>
#include <media/v4l2-mediabus.h>

#define OV9281_CHIP_ID			0x9281
#define OV9281_REG_CHIP_ID		0x300a

#define OV9281_REG_MODE_SELECT		0x0100
#define OV9281_REG_SOFTWARE_RESET	0x0103
#define OV9281_REG_HOLD			0x3308
#define OV9281_REG_EXPOSURE		0x3500
#define OV9281_REG_AGAIN		0x3509
#define OV9281_REG_HTS			0x380c
#define OV9281_REG_VTS			0x380e
#define OV9281_REG_MIPI_CTRL00		0x4800
#define OV9281_REG_PLL_CTRL_0D		0x030d
#define OV9281_REG_ANA_CORE_2		0x3662

#define OV9281_MODE_STANDBY		0x00
#define OV9281_MODE_STREAMING		0x01
#define OV9281_PLL_RAW10		0x50
#define OV9281_PLL_RAW8			0x60
#define OV9281_ANA_RAW10		0x05
#define OV9281_ANA_RAW8			0x07
/* 0x4800 bit5 gates the clock lane. Continuous clock leaves it clear. */
#define OV9281_MIPI_CLOCK_CONTINUOUS	0x00
#define OV9281_MIPI_CLOCK_GATED		0x20

#define OV9281_TABLE_WAIT_MS		0xfffe
#define OV9281_TABLE_END		0xffff

#define OV9281_AGAIN_MIN		0x10
#define OV9281_AGAIN_MAX		0xff
#define OV9281_EXPOSURE_MIN_LINES	1
#define OV9281_EXPOSURE_OFFSET		12
/*
 * Pixel line length for the continuous MIPI clock: 1280 active + 176
 * blank. ov9282.c writes 0x380c as (width + hblank) >> 1, so the
 * register value is half of this. The non-continuous minimum is 1530
 * (hblank 250). This pack does not use that mode.
 */
#define OV9281_LINE_LENGTH		1456
#define OV9281_DEFAULT_FPS		60

#define OV9281_MODE_1280X800_RAW10	0
#define OV9281_MODE_1280X720_RAW10	1

/*
 * Link is 400 MHz DDR (800 Mbps/lane), 2 lanes, from ov9282.c.
 * RAW10 pixel rate = 400e6 * 2 * 2 / 10.
 * camera_common maps V4L2_PIX_FMT_SRGGB10 to MEDIA_BUS_FMT_SRGGB10_1X10.
 * sensor_common on this tegra-camera.ko has no bayer_*8 string, so RAW8
 * is not a registered mode. MEDIA_BUS_FMT_SRGGB8_1X8 is the table entry
 * that would match V4L2_PIX_FMT_SRGGB8 if that string is added later.
 */
#define OV9281_PIXCLK_RAW10		160000000U
#define OV9281_MBUS_RAW10		MEDIA_BUS_FMT_SRGGB10_1X10
#define OV9281_MBUS_RAW8		MEDIA_BUS_FMT_SRGGB8_1X8
#define OV9281_MCLK_HZ			24000000UL

static const u32 ctrl_cid_list[] = {
	TEGRA_CAMERA_CID_GAIN,
	TEGRA_CAMERA_CID_EXPOSURE,
	TEGRA_CAMERA_CID_FRAME_RATE,
	TEGRA_CAMERA_CID_SENSOR_MODE_ID,
};

struct ov9281 {
	struct i2c_client *i2c_client;
	struct v4l2_subdev *subdev;
	struct camera_common_data *s_data;
	struct tegracam_device *tc_dev;
	u32 frame_length;
};

struct ov9281_mode {
	u32 width;
	u32 height;
	u32 pix_clk_hz;
	u32 line_length;
	u32 min_frame_length;
	u8 bpp;
	const struct reg_8 *timing;
};

static struct regmap_config ov9281_regmap_config = {
	.reg_bits = 16,
	.val_bits = 8,
	.cache_type = REGCACHE_NONE,
#if KERNEL_VERSION(5, 4, 0) > LINUX_VERSION_CODE
	.use_single_rw = true,
#else
	.use_single_read = true,
	.use_single_write = true,
#endif
};

/*
 * Common registers from Linux v6.8 drivers/media/i2c/ov9282.c.
 * No software reset here: that would wipe the clock setup done around it.
 * 0x4800 is continuous (bit5 clear) to match line length 1456 and
 * discontinuous_clk = "no". Gating the clock on this line length makes
 * the VI force frame end on every frame (err_data 0x20000).
 */
static const struct reg_8 ov9281_common_regs[] = {
	{0x0302, 0x32},
	{0x030e, 0x02},
	{0x3001, 0x00},
	{0x3004, 0x00},
	{0x3005, 0x00},
	{0x3006, 0x04},
	{0x3011, 0x0a},
	{0x3013, 0x18},
	{0x301c, 0xf0},
	{0x3022, 0x01},
	{0x3030, 0x10},
	{0x3039, 0x32},
	{0x303a, 0x00},
	{0x3503, 0x08},
	{0x3505, 0x8c},
	{0x3507, 0x03},
	{0x3508, 0x00},
	{0x3610, 0x80},
	{0x3611, 0xa0},
	{0x3620, 0x6e},
	{0x3632, 0x56},
	{0x3633, 0x78},
	{0x3666, 0x00},
	{0x366f, 0x5a},
	{0x3680, 0x84},
	{0x3712, 0x80},
	{0x372d, 0x22},
	{0x3731, 0x80},
	{0x3732, 0x30},
	{0x377d, 0x22},
	{0x3788, 0x02},
	{0x3789, 0xa4},
	{0x378a, 0x00},
	{0x378b, 0x4a},
	{0x3799, 0x20},
	{0x3881, 0x42},
	{0x38a8, 0x02},
	{0x38a9, 0x80},
	{0x38b1, 0x00},
	{0x38c4, 0x00},
	{0x38c5, 0xc0},
	{0x38c6, 0x04},
	{0x38c7, 0x80},
	{0x3920, 0xff},
	{0x4010, 0x40},
	{0x4043, 0x40},
	{0x4307, 0x30},
	{0x4317, 0x00},
	{0x4501, 0x00},
	{0x450a, 0x08},
	{0x4601, 0x04},
	{0x470f, 0x00},
	{0x4f07, 0x00},
	{0x4800, OV9281_MIPI_CLOCK_CONTINUOUS},
	{0x5000, 0x9f},
	{0x5001, 0x00},
	{0x5e00, 0x00},
	{0x5d00, 0x07},
	{0x5d01, 0x00},
	{0x0101, 0x01},
	{0x1000, 0x03},
	{0x5a08, 0x84},
	{OV9281_TABLE_END, 0x00},
};

/* 1280x800 full array. From ov9282.c mode_1280x800_regs. */
static const struct reg_8 ov9281_timing_1280x800[] = {
	{0x3778, 0x00},
	{0x3800, 0x00},
	{0x3801, 0x00},
	{0x3802, 0x00},
	{0x3803, 0x00},
	{0x3804, 0x05},
	{0x3805, 0x0f},
	{0x3806, 0x03},
	{0x3807, 0x2f},
	{0x3808, 0x05},
	{0x3809, 0x00},
	{0x3810, 0x00},
	{0x3811, 0x08},
	{0x3812, 0x00},
	{0x3813, 0x08},
	{0x3814, 0x11},
	{0x3815, 0x11},
	{0x3820, 0x40},
	{0x3821, 0x00},
	{0x4003, 0x40},
	{0x4008, 0x04},
	{0x4009, 0x0b},
	{0x400c, 0x00},
	{0x400d, 0x07},
	{0x4507, 0x00},
	{0x4509, 0x00},
	{0x380a, 0x03},
	{0x380b, 0x20},
	{OV9281_TABLE_END, 0x00},
};

/* 1280x720, top of the 800-line array. From ov9282.c mode_1280x720_regs. */
static const struct reg_8 ov9281_timing_1280x720[] = {
	{0x3778, 0x00},
	{0x3800, 0x00},
	{0x3801, 0x00},
	{0x3802, 0x00},
	{0x3803, 0x00},
	{0x3804, 0x05},
	{0x3805, 0x0f},
	{0x3806, 0x02},
	{0x3807, 0xdf},
	{0x3808, 0x05},
	{0x3809, 0x00},
	{0x3810, 0x00},
	{0x3811, 0x08},
	{0x3812, 0x00},
	{0x3813, 0x08},
	{0x3814, 0x11},
	{0x3815, 0x11},
	{0x3820, 0x3c},
	{0x3821, 0x84},
	{0x4003, 0x40},
	{0x4008, 0x02},
	{0x4009, 0x05},
	{0x400c, 0x00},
	{0x400d, 0x03},
	{0x4507, 0x00},
	{0x4509, 0x80},
	{0x380a, 0x02},
	{0x380b, 0xd0},
	{OV9281_TABLE_END, 0x00},
};

static const struct ov9281_mode ov9281_modes[] = {
	{
		.width = 1280,
		.height = 800,
		.pix_clk_hz = OV9281_PIXCLK_RAW10,
		.line_length = OV9281_LINE_LENGTH,
		.min_frame_length = 910,
		.bpp = 10,
		.timing = ov9281_timing_1280x800,
	},
	{
		.width = 1280,
		.height = 720,
		.pix_clk_hz = OV9281_PIXCLK_RAW10,
		.line_length = OV9281_LINE_LENGTH,
		.min_frame_length = 761,
		.bpp = 10,
		.timing = ov9281_timing_1280x720,
	},
};

static const int ov9281_60fps[] = { OV9281_DEFAULT_FPS };

static const struct camera_common_frmfmt ov9281_frmfmt[] = {
	{{1280, 800}, ov9281_60fps, 1, 0, OV9281_MODE_1280X800_RAW10},
	{{1280, 720}, ov9281_60fps, 1, 0, OV9281_MODE_1280X720_RAW10},
};

static const struct of_device_id ov9281_of_match[] = {
	{ .compatible = "ovti,ov9281" },
	{ },
};
MODULE_DEVICE_TABLE(of, ov9281_of_match);

static int ov9281_read_reg(struct camera_common_data *s_data, u16 addr, u8 *val)
{
	unsigned int reg_val = 0;
	int err;

	err = regmap_read(s_data->regmap, addr, &reg_val);
	if (err)
		return err;
	*val = reg_val & 0xff;
	return 0;
}

static int ov9281_write_reg(struct camera_common_data *s_data, u16 addr, u8 val)
{
	int err;

	err = regmap_write(s_data->regmap, addr, val);
	if (err)
		dev_err(s_data->dev, "i2c write failed, 0x%04x = 0x%02x (%d)\n",
			addr, val, err);
	return err;
}

static int ov9281_write_table(struct ov9281 *priv, const struct reg_8 *table)
{
	return regmap_util_write_table_8(priv->s_data->regmap, table, NULL, 0,
					 OV9281_TABLE_WAIT_MS, OV9281_TABLE_END);
}

static const struct ov9281_mode *ov9281_current_mode(struct camera_common_data *s_data)
{
	if (s_data->mode < 0 ||
	    s_data->mode >= (int)ARRAY_SIZE(ov9281_modes))
		return NULL;
	return &ov9281_modes[s_data->mode];
}

/* Matches camera_common_color_fmts for V4L2_PIX_FMT_SRGGB10 / SRGGB8. */
static u32 ov9281_mbus_code(const struct ov9281_mode *mode)
{
	if (mode->bpp == 8)
		return OV9281_MBUS_RAW8;
	return OV9281_MBUS_RAW10;
}

static u32 ov9281_frame_length_for_fps(const struct ov9281_mode *mode, u32 fps)
{
	u32 fl;

	if (!fps)
		fps = OV9281_DEFAULT_FPS;
	fl = mode->pix_clk_hz / mode->line_length / fps;
	if (fl < mode->min_frame_length)
		fl = mode->min_frame_length;
	if (fl > 0xffff)
		fl = 0xffff;
	return fl;
}

static int ov9281_write_hts_vts(struct camera_common_data *s_data,
				const struct ov9281_mode *mode, u32 frame_length)
{
	/* 0x380c is in units of two pixels. See ov9282_set_ctrl HBLANK. */
	u32 hts_reg = mode->line_length / 2;
	int err;

	err = ov9281_write_reg(s_data, OV9281_REG_HTS, (hts_reg >> 8) & 0xff);
	if (err)
		return err;
	err = ov9281_write_reg(s_data, OV9281_REG_HTS + 1, hts_reg & 0xff);
	if (err)
		return err;
	err = ov9281_write_reg(s_data, OV9281_REG_VTS, (frame_length >> 8) & 0xff);
	if (err)
		return err;
	return ov9281_write_reg(s_data, OV9281_REG_VTS + 1, frame_length & 0xff);
}

static int ov9281_set_group_hold(struct tegracam_device *tc_dev, bool val)
{
	struct camera_common_data *s_data = tc_dev->s_data;

	return ov9281_write_reg(s_data, OV9281_REG_HOLD, val ? 1 : 0);
}

static int ov9281_set_gain(struct tegracam_device *tc_dev, s64 val)
{
	struct camera_common_data *s_data = tc_dev->s_data;
	u8 gain;

	if (val < OV9281_AGAIN_MIN)
		val = OV9281_AGAIN_MIN;
	if (val > OV9281_AGAIN_MAX)
		val = OV9281_AGAIN_MAX;
	gain = (u8)val;
	dev_dbg(s_data->dev, "analog gain code 0x%02x\n", gain);
	return ov9281_write_reg(s_data, OV9281_REG_AGAIN, gain);
}

static int ov9281_set_frame_rate(struct tegracam_device *tc_dev, s64 val)
{
	struct camera_common_data *s_data = tc_dev->s_data;
	struct ov9281 *priv = tegracam_get_privdata(tc_dev);
	const struct sensor_mode_properties *props;
	const struct ov9281_mode *mode;
	u32 factor;
	u32 fps;
	u32 frame_length;
	int err;

	mode = ov9281_current_mode(s_data);
	if (!mode)
		return -EINVAL;

	props = &s_data->sensor_props.sensor_modes[s_data->mode_prop_idx];
	factor = props->control_properties.framerate_factor;
	if (!factor)
		factor = 1000000;
	if (val <= 0)
		return -EINVAL;
	fps = (u32)div64_u64((u64)val, factor);
	if (!fps)
		fps = 1;

	if (props->signal_properties.pixel_clock.val &&
	    props->image_properties.line_length) {
		frame_length = (u32)div64_u64(props->signal_properties.pixel_clock.val *
					      (u64)factor,
					      (u64)props->image_properties.line_length *
					      (u64)val);
	} else {
		frame_length = ov9281_frame_length_for_fps(mode, fps);
	}
	if (frame_length < mode->min_frame_length)
		frame_length = mode->min_frame_length;
	if (frame_length > 0xffff)
		frame_length = 0xffff;

	dev_dbg(s_data->dev, "frame rate %u fps, VTS %u\n", fps, frame_length);
	err = ov9281_write_reg(s_data, OV9281_REG_VTS, (frame_length >> 8) & 0xff);
	if (err)
		return err;
	err = ov9281_write_reg(s_data, OV9281_REG_VTS + 1, frame_length & 0xff);
	if (err)
		return err;
	priv->frame_length = frame_length;
	return 0;
}

static int ov9281_set_exposure(struct tegracam_device *tc_dev, s64 val)
{
	struct camera_common_data *s_data = tc_dev->s_data;
	struct ov9281 *priv = tegracam_get_privdata(tc_dev);
	const struct sensor_mode_properties *props;
	const struct ov9281_mode *mode;
	u32 factor;
	u32 line_length;
	u64 pix_clk;
	u32 coarse;
	u32 limit;
	u32 packed;
	int err;

	mode = ov9281_current_mode(s_data);
	if (!mode)
		return -EINVAL;

	props = &s_data->sensor_props.sensor_modes[s_data->mode_prop_idx];
	factor = props->control_properties.exposure_factor;
	if (!factor)
		factor = 1000000;
	pix_clk = props->signal_properties.pixel_clock.val;
	line_length = props->image_properties.line_length;
	if (!pix_clk)
		pix_clk = mode->pix_clk_hz;
	if (!line_length)
		line_length = mode->line_length;
	if (val < 0)
		val = 0;

	coarse = (u32)div64_u64((u64)val * pix_clk, (u64)factor * line_length);
	if (coarse < OV9281_EXPOSURE_MIN_LINES)
		coarse = OV9281_EXPOSURE_MIN_LINES;
	limit = priv->frame_length;
	if (limit <= OV9281_EXPOSURE_OFFSET)
		limit = mode->min_frame_length;
	if (coarse > limit - OV9281_EXPOSURE_OFFSET)
		coarse = limit - OV9281_EXPOSURE_OFFSET;

	/* Mainline ov9282 writes the line count in the top 20 bits. */
	packed = coarse << 4;
	dev_dbg(s_data->dev, "exposure %lld us, coarse %u lines\n", val, coarse);
	err = ov9281_write_reg(s_data, OV9281_REG_EXPOSURE, (packed >> 16) & 0xff);
	if (err)
		return err;
	err = ov9281_write_reg(s_data, OV9281_REG_EXPOSURE + 1, (packed >> 8) & 0xff);
	if (err)
		return err;
	return ov9281_write_reg(s_data, OV9281_REG_EXPOSURE + 2, packed & 0xff);
}

static struct tegracam_ctrl_ops ov9281_ctrl_ops = {
	.numctrls = ARRAY_SIZE(ctrl_cid_list),
	.ctrl_cid_list = ctrl_cid_list,
	.set_gain = ov9281_set_gain,
	.set_exposure = ov9281_set_exposure,
	.set_frame_rate = ov9281_set_frame_rate,
	.set_group_hold = ov9281_set_group_hold,
};

static int ov9281_power_on(struct camera_common_data *s_data)
{
	struct camera_common_power_rail *pw = s_data->power;
	struct camera_common_pdata *pdata = s_data->pdata;
	struct device *dev = s_data->dev;
	int err = 0;

	if (!pw)
		return -EFAULT;
	if (pw->state == SWITCH_ON)
		return 0;

	dev_dbg(dev, "power on\n");
	if (pdata && pdata->power_on) {
		err = pdata->power_on(pw);
		if (err) {
			dev_err(dev, "platform power_on failed (%d)\n", err);
			return err;
		}
		pw->state = SWITCH_ON;
		return 0;
	}

	/*
	 * Same order as nv_imx219 on CAM0_PWDN: hold the pin low, wait,
	 * enable regulators, wait, drive the pin high, then wait before I2C.
	 * GPIO_ACTIVE_HIGH in the overlay means electrical high lets the
	 * sensor run. The caller owns the 24 MHz clock. board_setup enables
	 * it before this function so the chip-id read sees a clock.
	 * camera_common_s_power enables it after power_on and disables it
	 * on power off, so this function does not touch the clock.
	 */
	if (pw->reset_gpio)
		gpio_direction_output(pw->reset_gpio, 0);
	usleep_range(10, 20);

	if (pw->avdd) {
		err = regulator_enable(pw->avdd);
		if (err)
			goto avdd_fail;
	}
	if (pw->iovdd) {
		err = regulator_enable(pw->iovdd);
		if (err)
			goto iovdd_fail;
	}
	if (pw->dvdd) {
		err = regulator_enable(pw->dvdd);
		if (err)
			goto dvdd_fail;
	}

	usleep_range(10, 20);
	if (pw->reset_gpio)
		gpio_set_value_cansleep(pw->reset_gpio, 1);

	/* imx219 waits t4+t5+t9 after releasing reset before I2C. */
	usleep_range(10000, 10100);
	pw->state = SWITCH_ON;
	return 0;

dvdd_fail:
	if (pw->iovdd)
		regulator_disable(pw->iovdd);
iovdd_fail:
	if (pw->avdd)
		regulator_disable(pw->avdd);
avdd_fail:
	dev_err(dev, "power on failed (%d)\n", err);
	return err;
}

static int ov9281_power_off(struct camera_common_data *s_data)
{
	struct camera_common_power_rail *pw = s_data->power;
	struct camera_common_pdata *pdata = s_data->pdata;
	int err = 0;

	if (!pw)
		return -EFAULT;
	if (pw->state == SWITCH_OFF)
		return 0;

	if (pdata && pdata->power_off) {
		err = pdata->power_off(pw);
		if (err)
			return err;
		pw->state = SWITCH_OFF;
		return 0;
	}

	if (pw->reset_gpio)
		gpio_set_value_cansleep(pw->reset_gpio, 0);
	usleep_range(1000, 1500);
	if (pw->dvdd)
		regulator_disable(pw->dvdd);
	if (pw->iovdd)
		regulator_disable(pw->iovdd);
	if (pw->avdd)
		regulator_disable(pw->avdd);
	pw->state = SWITCH_OFF;
	return 0;
}

static int ov9281_power_get(struct tegracam_device *tc_dev)
{
	struct device *dev = tc_dev->dev;
	struct camera_common_data *s_data = tc_dev->s_data;
	struct camera_common_power_rail *pw = s_data->power;
	struct camera_common_pdata *pdata = s_data->pdata;
	struct clk *parent;
	int err = 0;

	if (!pdata || !pw) {
		dev_err(dev, "power rail missing\n");
		return -EFAULT;
	}

	if (pdata->mclk_name) {
		pw->mclk = devm_clk_get(dev, pdata->mclk_name);
		if (IS_ERR(pw->mclk)) {
			dev_err(dev, "clock %s lookup failed (%ld)\n",
				pdata->mclk_name, PTR_ERR(pw->mclk));
			return PTR_ERR(pw->mclk);
		}
		if (pdata->parentclk_name) {
			parent = devm_clk_get(dev, pdata->parentclk_name);
			if (IS_ERR(parent)) {
				dev_err(dev, "parent clock %s lookup failed (%ld)\n",
					pdata->parentclk_name, PTR_ERR(parent));
				return PTR_ERR(parent);
			}
			{
				int perr = clk_set_parent(pw->mclk, parent);

				if (perr)
					dev_err(dev, "clk_set_parent(%s) failed (%d)\n",
						pdata->parentclk_name, perr);
			}
		}
		dev_info(dev, "clock %s ready\n", pdata->mclk_name);
	}

	if (pdata->regulators.avdd)
		err |= camera_common_regulator_get(dev, &pw->avdd,
						   pdata->regulators.avdd);
	if (pdata->regulators.iovdd)
		err |= camera_common_regulator_get(dev, &pw->iovdd,
						   pdata->regulators.iovdd);
	if (pdata->regulators.dvdd)
		err |= camera_common_regulator_get(dev, &pw->dvdd,
						   pdata->regulators.dvdd);
	if (err) {
		dev_err(dev, "regulator get failed\n");
		return -EINVAL;
	}

	pw->reset_gpio = pdata->reset_gpio;
	if (pw->reset_gpio) {
		err = gpio_request(pw->reset_gpio, "ov9281_reset");
		if (err < 0) {
			dev_err(dev, "reset gpio %u request failed (%d)\n",
				pw->reset_gpio, err);
			pw->reset_gpio = 0;
			return err;
		}
		err = gpio_direction_output(pw->reset_gpio, 0);
		if (err < 0) {
			gpio_free(pw->reset_gpio);
			pw->reset_gpio = 0;
			return err;
		}
	}

	pw->state = SWITCH_OFF;
	return 0;
}

static int ov9281_power_put(struct tegracam_device *tc_dev)
{
	struct camera_common_data *s_data = tc_dev->s_data;
	struct camera_common_power_rail *pw = s_data->power;
	if (!pw)
		return -EFAULT;

	if (pw->dvdd)
		devm_regulator_put(pw->dvdd);
	if (pw->avdd)
		devm_regulator_put(pw->avdd);
	if (pw->iovdd)
		devm_regulator_put(pw->iovdd);
	pw->dvdd = NULL;
	pw->avdd = NULL;
	pw->iovdd = NULL;

	if (pw->reset_gpio) {
		gpio_free(pw->reset_gpio);
		pw->reset_gpio = 0;
	}
	return 0;
}

static struct camera_common_pdata *ov9281_parse_dt(struct tegracam_device *tc_dev)
{
	struct device *dev = tc_dev->dev;
	struct device_node *np = dev->of_node;
	struct camera_common_pdata *board;
	int gpio;
	int err;

	if (!np)
		return NULL;

	if (!of_match_device(ov9281_of_match, dev)) {
		dev_err(dev, "no matching compatible\n");
		return NULL;
	}

	board = devm_kzalloc(dev, sizeof(*board), GFP_KERNEL);
	if (!board)
		return NULL;

	gpio = of_get_named_gpio(np, "reset-gpios", 0);
	if (gpio == -EPROBE_DEFER)
		return ERR_PTR(-EPROBE_DEFER);
	if (gpio < 0) {
		dev_err(dev, "reset-gpios missing (%d). CAM0_PWDN is main GPIO H.6\n",
			gpio);
		return NULL;
	}
	board->reset_gpio = (unsigned int)gpio;

	err = of_property_read_string(np, "mclk", &board->mclk_name);
	if (err)
		board->mclk_name = NULL;
	err = of_property_read_string_index(np, "clock-names", 1,
					    &board->parentclk_name);
	if (err)
		board->parentclk_name = NULL;
	of_property_read_string(np, "avdd-reg", &board->regulators.avdd);
	of_property_read_string(np, "iovdd-reg", &board->regulators.iovdd);
	of_property_read_string(np, "dvdd-reg", &board->regulators.dvdd);
	board->has_eeprom = of_property_read_bool(np, "has-eeprom");
	return board;
}

static int ov9281_read_u8(struct camera_common_data *s_data, u16 reg, u8 *val)
{
	return ov9281_read_reg(s_data, reg, val);
}

/*
 * Read the window, line time, MIPI clock bit, and RAW10/RAW8 selects.
 * Called at stream start and from the ov9281_timing sysfs attribute.
 * err_data 0x20000 is CAPTURE_CHANNEL_ERROR_FORCE_FE (camrtc-capture.h
 * bit 17): VI forced frame end. A gated clock (0x4800 bit5) with a
 * 1456-pixel line, or a RAW8 datatype while VI expects RAW10, does that.
 */
static int ov9281_log_timing(struct camera_common_data *s_data, const char *when)
{
	u16 width = 0, height = 0, hts = 0, vts = 0;
	u8 mipi = 0, ana = 0, pll = 0;
	u8 b3808 = 0, b3809 = 0, b380a = 0, b380b = 0;
	u8 b380c = 0, b380d = 0, b380e = 0, b380f = 0;
	const char *clock;
	const char *format;
	int err;

	err = ov9281_read_u8(s_data, 0x3808, &b3808);
	if (!err)
		err = ov9281_read_u8(s_data, 0x3809, &b3809);
	if (!err)
		err = ov9281_read_u8(s_data, 0x380a, &b380a);
	if (!err)
		err = ov9281_read_u8(s_data, 0x380b, &b380b);
	if (!err)
		err = ov9281_read_u8(s_data, 0x380c, &b380c);
	if (!err)
		err = ov9281_read_u8(s_data, 0x380d, &b380d);
	if (!err)
		err = ov9281_read_u8(s_data, 0x380e, &b380e);
	if (!err)
		err = ov9281_read_u8(s_data, 0x380f, &b380f);
	if (!err)
		err = ov9281_read_u8(s_data, OV9281_REG_MIPI_CTRL00, &mipi);
	if (!err)
		err = ov9281_read_u8(s_data, OV9281_REG_ANA_CORE_2, &ana);
	if (!err)
		err = ov9281_read_u8(s_data, OV9281_REG_PLL_CTRL_0D, &pll);
	if (err) {
		dev_err(s_data->dev, "ov9281 timing %s read failed (%d)\n", when, err);
		return err;
	}

	width = ((u16)b3808 << 8) | b3809;
	height = ((u16)b380a << 8) | b380b;
	hts = ((u16)b380c << 8) | b380d;
	vts = ((u16)b380e << 8) | b380f;
	clock = (mipi & OV9281_MIPI_CLOCK_GATED) ? "gated" : "continuous";
	if (pll == OV9281_PLL_RAW10 && ana == OV9281_ANA_RAW10)
		format = "RAW10";
	else if (pll == OV9281_PLL_RAW8 && ana == OV9281_ANA_RAW8)
		format = "RAW8";
	else
		format = "unknown";

	dev_info(s_data->dev,
		 "ov9281 timing %s 3808=%02x 3809=%02x 380a=%02x 380b=%02x 380c=%02x 380d=%02x 380e=%02x 380f=%02x 4800=%02x 3662=%02x 030d=%02x width=%u height=%u hts_px=%u vts=%u clock=%s format=%s\n",
		 when, b3808, b3809, b380a, b380b, b380c, b380d, b380e, b380f,
		 mipi, ana, pll, width, height, (u32)hts * 2, vts, clock, format);

	if (width != 1280 || (height != 800 && height != 720) ||
	    strcmp(format, "RAW10") || (mipi & OV9281_MIPI_CLOCK_GATED) ||
	    (u32)hts * 2 != OV9281_LINE_LENGTH) {
		dev_err(s_data->dev,
			"ov9281 timing mismatch: want 1280x800 or 1280x720 RAW10 continuous line %u\n",
			OV9281_LINE_LENGTH);
	}
	return 0;
}

static ssize_t ov9281_timing_show(struct device *dev,
				   struct device_attribute *attr, char *buf)
{
	struct camera_common_data *s_data = to_camera_common_data(dev);
	u16 width = 0, height = 0, hts = 0, vts = 0;
	u8 regs[11];
	static const u16 addrs[] = {
		0x3808, 0x3809, 0x380a, 0x380b, 0x380c, 0x380d, 0x380e, 0x380f,
		0x4800, 0x3662, 0x030d,
	};
	int i;
	int err = 0;

	(void)attr;
	if (!s_data)
		return -ENODEV;
	for (i = 0; i < (int)ARRAY_SIZE(addrs); i++) {
		err = ov9281_read_u8(s_data, addrs[i], &regs[i]);
		if (err)
			return sysfs_emit(buf, "ov9281 timing read 0x%04x failed (%d)\n",
					  addrs[i], err);
	}
	width = ((u16)regs[0] << 8) | regs[1];
	height = ((u16)regs[2] << 8) | regs[3];
	hts = ((u16)regs[4] << 8) | regs[5];
	vts = ((u16)regs[6] << 8) | regs[7];
	return sysfs_emit(buf,
			  "3808=%02x 3809=%02x 380a=%02x 380b=%02x 380c=%02x 380d=%02x 380e=%02x 380f=%02x 4800=%02x 3662=%02x 030d=%02x width=%u height=%u hts_px=%u vts=%u clock=%s format=%s\n",
			  regs[0], regs[1], regs[2], regs[3], regs[4], regs[5],
			  regs[6], regs[7], regs[8], regs[9], regs[10],
			  width, height, (u32)hts * 2, vts,
			  (regs[8] & OV9281_MIPI_CLOCK_GATED) ? "gated" : "continuous",
			  (regs[10] == OV9281_PLL_RAW10 && regs[9] == OV9281_ANA_RAW10) ? "RAW10" :
			  (regs[10] == OV9281_PLL_RAW8 && regs[9] == OV9281_ANA_RAW8) ? "RAW8" :
			  "unknown");
}

static DEVICE_ATTR_RO(ov9281_timing);

static int ov9281_set_bitdepth(struct camera_common_data *s_data, u8 bpp)
{
	int err;

	if (bpp == 8) {
		err = ov9281_write_reg(s_data, OV9281_REG_PLL_CTRL_0D, OV9281_PLL_RAW8);
		if (err)
			return err;
		return ov9281_write_reg(s_data, OV9281_REG_ANA_CORE_2, OV9281_ANA_RAW8);
	}
	err = ov9281_write_reg(s_data, OV9281_REG_PLL_CTRL_0D, OV9281_PLL_RAW10);
	if (err)
		return err;
	return ov9281_write_reg(s_data, OV9281_REG_ANA_CORE_2, OV9281_ANA_RAW10);
}

static int ov9281_set_mode(struct tegracam_device *tc_dev)
{
	struct ov9281 *priv = tegracam_get_privdata(tc_dev);
	struct camera_common_data *s_data = tc_dev->s_data;
	const struct ov9281_mode *mode;
	int err;

	mode = ov9281_current_mode(s_data);
	if (!mode) {
		dev_err(tc_dev->dev, "sensor mode %d out of range\n", s_data->mode);
		return -EINVAL;
	}

	err = ov9281_write_reg(s_data, OV9281_REG_SOFTWARE_RESET, 0x01);
	if (err)
		return err;
	msleep(10);

	err = ov9281_write_table(priv, ov9281_common_regs);
	if (err) {
		dev_err(tc_dev->dev, "common registers failed (%d)\n", err);
		return err;
	}
	err = ov9281_write_table(priv, mode->timing);
	if (err) {
		dev_err(tc_dev->dev, "mode %d timing failed (%d)\n", s_data->mode, err);
		return err;
	}
	err = ov9281_set_bitdepth(s_data, mode->bpp);
	if (err)
		return err;

	priv->frame_length = ov9281_frame_length_for_fps(mode, OV9281_DEFAULT_FPS);
	err = ov9281_write_hts_vts(s_data, mode, priv->frame_length);
	if (err)
		return err;

	dev_info(tc_dev->dev, "mode %d %ux%u RAW%u VTS %u line %u mbus 0x%x\n",
		 s_data->mode, mode->width, mode->height, mode->bpp,
		 priv->frame_length, mode->line_length, ov9281_mbus_code(mode));
	ov9281_log_timing(s_data, "set_mode");
	return 0;
}

static int ov9281_start_streaming(struct tegracam_device *tc_dev)
{
	struct camera_common_data *s_data = tc_dev->s_data;

	ov9281_log_timing(s_data, "stream");
	return ov9281_write_reg(s_data, OV9281_REG_MODE_SELECT, OV9281_MODE_STREAMING);
}

static int ov9281_stop_streaming(struct tegracam_device *tc_dev)
{
	struct camera_common_data *s_data = tc_dev->s_data;

	dev_dbg(tc_dev->dev, "stop streaming\n");
	return ov9281_write_reg(s_data, OV9281_REG_MODE_SELECT, OV9281_MODE_STANDBY);
}

static struct camera_common_sensor_ops ov9281_common_ops = {
	.numfrmfmts = ARRAY_SIZE(ov9281_frmfmt),
	.frmfmt_table = ov9281_frmfmt,
	.power_on = ov9281_power_on,
	.power_off = ov9281_power_off,
	.write_reg = ov9281_write_reg,
	.read_reg = ov9281_read_reg,
	.parse_dt = ov9281_parse_dt,
	.power_get = ov9281_power_get,
	.power_put = ov9281_power_put,
	.set_mode = ov9281_set_mode,
	.start_streaming = ov9281_start_streaming,
	.stop_streaming = ov9281_stop_streaming,
};

static int ov9281_read_chip_id(struct camera_common_data *s_data, u16 *id)
{
	u8 hi = 0, lo = 0;
	int err;

	err = ov9281_read_reg(s_data, OV9281_REG_CHIP_ID, &hi);
	if (err)
		return err;
	err = ov9281_read_reg(s_data, OV9281_REG_CHIP_ID + 1, &lo);
	if (err)
		return err;
	*id = ((u16)hi << 8) | lo;
	return 0;
}

static int ov9281_enable_mclk(struct camera_common_data *s_data)
{
	struct camera_common_power_rail *pw = s_data->power;
	unsigned long rate;
	int err;

	if (!pw || !pw->mclk) {
		dev_err(s_data->dev, "mclk is not available\n");
		return -ENODEV;
	}
	rate = s_data->def_clk_freq ? s_data->def_clk_freq : OV9281_MCLK_HZ;
	err = clk_set_rate(pw->mclk, rate);
	if (err) {
		dev_err(s_data->dev, "clk_set_rate(%lu) failed (%d)\n", rate, err);
		return err;
	}
	err = clk_prepare_enable(pw->mclk);
	if (err) {
		dev_err(s_data->dev, "mclk enable failed (%d)\n", err);
		return err;
	}
	dev_info(s_data->dev, "mclk enabled at %lu Hz\n", rate);
	return 0;
}

static int ov9281_board_setup(struct ov9281 *priv)
{
	struct camera_common_data *s_data = priv->s_data;
	struct device *dev = s_data->dev;
	struct camera_common_power_rail *pw = s_data->power;
	u16 id = 0;
	int err;
	int id_err;
	bool powered = false;
	bool clock_on = false;

	err = ov9281_enable_mclk(s_data);
	if (err) {
		dev_err(dev, "mclk before chip-id read failed (%d)\n", err);
	} else {
		clock_on = true;
		dev_info(dev, "power on for chip-id (reset gpio %u)\n",
			 pw && pw->reset_gpio ? pw->reset_gpio : 0);
		err = ov9281_power_on(s_data);
		if (err)
			dev_err(dev, "power on before chip-id read failed (%d)\n", err);
		else
			powered = true;
	}

	id_err = ov9281_read_chip_id(s_data, &id);
	if (id_err) {
		dev_err(dev, "chip id read failed (%d)\n", id_err);
		if (!err)
			err = id_err;
	} else if (id != OV9281_CHIP_ID) {
		dev_err(dev, "chip id 0x%04x != 0x%04x\n", id, OV9281_CHIP_ID);
		if (!err)
			err = -ENODEV;
	} else {
		dev_info(dev, "ov9281 chip id 0x%04x at i2c addr 0x%02x\n",
			 id, priv->i2c_client->addr);
	}

	if (powered)
		ov9281_power_off(s_data);
	if (clock_on && pw && pw->mclk)
		clk_disable_unprepare(pw->mclk);
	return err;
}

static int ov9281_open(struct v4l2_subdev *sd, struct v4l2_subdev_fh *fh)
{
	struct i2c_client *client = v4l2_get_subdevdata(sd);

	(void)fh;
	dev_dbg(&client->dev, "subdev open\n");
	return 0;
}

static const struct v4l2_subdev_internal_ops ov9281_subdev_internal_ops = {
	.open = ov9281_open,
};

#if LINUX_VERSION_CODE >= KERNEL_VERSION(6, 3, 0)
static int ov9281_probe(struct i2c_client *client)
#else
static int ov9281_probe(struct i2c_client *client, const struct i2c_device_id *id)
#endif
{
	struct device *dev = &client->dev;
	struct tegracam_device *tc_dev;
	struct ov9281 *priv;
	int err;

#if LINUX_VERSION_CODE < KERNEL_VERSION(6, 3, 0)
	(void)id;
#endif
	dev_info(dev, "probing ov9281 at i2c addr 0x%02x\n", client->addr);

	if (!IS_ENABLED(CONFIG_OF) || !client->dev.of_node)
		return -EINVAL;

	priv = devm_kzalloc(dev, sizeof(*priv), GFP_KERNEL);
	if (!priv)
		return -ENOMEM;
	tc_dev = devm_kzalloc(dev, sizeof(*tc_dev), GFP_KERNEL);
	if (!tc_dev)
		return -ENOMEM;

	priv->i2c_client = client;
	tc_dev->client = client;
	tc_dev->dev = dev;
	strscpy(tc_dev->name, "ov9281", sizeof(tc_dev->name));
	tc_dev->dev_regmap_config = &ov9281_regmap_config;
	tc_dev->sensor_ops = &ov9281_common_ops;
	tc_dev->v4l2sd_internal_ops = &ov9281_subdev_internal_ops;
	tc_dev->tcctrl_ops = &ov9281_ctrl_ops;

	err = tegracam_device_register(tc_dev);
	if (err) {
		dev_err(dev, "tegracam register failed (%d)\n", err);
		return err;
	}

	priv->tc_dev = tc_dev;
	priv->s_data = tc_dev->s_data;
	priv->subdev = &tc_dev->s_data->subdev;
	tegracam_set_privdata(tc_dev, priv);

	err = ov9281_board_setup(priv);
	if (err) {
		dev_err(dev, "board setup failed (%d)\n", err);
		goto unregister;
	}

	err = tegracam_v4l2subdev_register(tc_dev, true);
	if (err) {
		dev_err(dev, "v4l2 subdev register failed (%d)\n", err);
		goto unregister;
	}

	err = device_create_file(dev, &dev_attr_ov9281_timing);
	if (err) {
		dev_err(dev, "ov9281_timing sysfs failed (%d)\n", err);
		goto unregister_subdev;
	}

	dev_info(dev, "ov9281 registered. Argus cannot process mono; use V4L2\n");
	return 0;

unregister_subdev:
	tegracam_v4l2subdev_unregister(tc_dev);
unregister:
	tegracam_device_unregister(tc_dev);
	return err;
}

#if LINUX_VERSION_CODE >= KERNEL_VERSION(6, 1, 0)
static void ov9281_remove(struct i2c_client *client)
#else
static int ov9281_remove(struct i2c_client *client)
#endif
{
	struct camera_common_data *s_data = to_camera_common_data(&client->dev);
	struct ov9281 *priv;

	if (!s_data)
#if LINUX_VERSION_CODE >= KERNEL_VERSION(6, 1, 0)
		return;
#else
		return 0;
#endif
	priv = s_data->priv;
	device_remove_file(&client->dev, &dev_attr_ov9281_timing);
	if (priv && priv->tc_dev) {
		tegracam_v4l2subdev_unregister(priv->tc_dev);
		tegracam_device_unregister(priv->tc_dev);
	}
#if LINUX_VERSION_CODE < KERNEL_VERSION(6, 1, 0)
	return 0;
#endif
}

static const struct i2c_device_id ov9281_id[] = {
	{ "ov9281", 0 },
	{ }
};
MODULE_DEVICE_TABLE(i2c, ov9281_id);

static struct i2c_driver ov9281_i2c_driver = {
	.driver = {
		.name = "ov9281",
		.owner = THIS_MODULE,
		.of_match_table = of_match_ptr(ov9281_of_match),
	},
	.probe = ov9281_probe,
	.remove = ov9281_remove,
	.id_table = ov9281_id,
};

module_i2c_driver(ov9281_i2c_driver);

MODULE_DESCRIPTION("NVIDIA tegracam driver for OmniVision OV9281 mono global shutter");
MODULE_AUTHOR("AIRVIX");
MODULE_LICENSE("GPL");
MODULE_SOFTDEP("pre: tegra-camera");
