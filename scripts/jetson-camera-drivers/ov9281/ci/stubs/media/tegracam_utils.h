/* SPDX-License-Identifier: GPL-2.0 */
/* Compile-test stand-in. The Jetson build uses NVIDIA's real header. */
#ifndef _AIRVIX_STUB_TEGRACAM_UTILS_H
#define _AIRVIX_STUB_TEGRACAM_UTILS_H

struct reg_8 {
	u16 addr;
	u8 val;
};

struct regmap;

int regmap_util_write_table_8(struct regmap *regmap,
			      const struct reg_8 table[],
			      const struct reg_8 override_list[],
			      int num_override_regs,
			      u16 wait_ms_addr, u16 end_addr);

#endif
