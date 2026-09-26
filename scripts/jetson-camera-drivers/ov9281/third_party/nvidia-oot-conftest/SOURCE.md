# NVIDIA OOT conftest (vendored, unmodified)

Pinned to the public Jetson Linux 39.2.1 sources, the same L4T release as
kernel `6.8.12-1021-tegra`. `build.sh` copies these files and runs NVIDIA's
Makefile on the Jetson. It does not hand-write `NV_*` macros.

- Repository: https://gitlab.com/nvidia/nv-tegra/linux-nv-oot.git
- Branch: `l4t/l4t-r39.2.1`
- Commit: `e71bacb7c611f880c5f341263967f13de54de3a9`
- Tree: https://gitlab.com/nvidia/nv-tegra/linux-nv-oot/-/tree/e71bacb7c611f880c5f341263967f13de54de3a9/scripts/conftest
- Files: `Makefile`, `conftest.sh`, `conftest.h` (the template). `BUILD.bazel` is not required to generate the header.

`sha256sum -c checksums.txt` from this directory must succeed. `build.sh --self-test` checks that.
