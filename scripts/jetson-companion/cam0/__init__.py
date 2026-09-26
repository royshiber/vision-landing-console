"""Cam0 — OV9281 global-shutter pipeline for the Jetson companion.

Output only. This package never sends MAVLink commands and never writes
flight-controller parameters. A missing camera must not stop the companion.
"""

PACKAGE_VERSION = "2.5.4"

__all__ = ["PACKAGE_VERSION"]
