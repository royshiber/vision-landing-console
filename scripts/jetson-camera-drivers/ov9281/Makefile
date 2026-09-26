# Out-of-tree OV9281 module. On the Jetson, build.sh sets the kernel tree
# and NVIDIA's Module.symvers. compile-test.sh points NVIDIA_INCLUDE at
# ci/stubs and builds against a mainline 6.8 tree.

obj-m += nv_ov9281.o

NVIDIA_INCLUDE ?= /usr/src/nvidia/nvidia-public/include
# Parent of the generated nvidia/ directory (srctree.nvconftest).
NVIDIA_CONFTEST ?=
ccflags-y += -I$(NVIDIA_INCLUDE)
ifneq ($(NVIDIA_CONFTEST),)
ccflags-y += -I$(NVIDIA_CONFTEST)
endif

ifneq ($(COMPILE_TEST_STUBS),)
ccflags-y += -I$(COMPILE_TEST_STUBS)
endif

NV_SYMVERS := /usr/src/nvidia/nvidia-public/Module.symvers
ifneq ($(wildcard $(NV_SYMVERS)),)
KBUILD_EXTRA_SYMBOLS += $(NV_SYMVERS)
endif
