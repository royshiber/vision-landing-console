"""CP2102 radio forwarder: by-id only, off by default, survives unplug."""

import os
import pty
import select
import tty
import unittest

from rf_forwarder import RfForwarder, is_cp2102_name, resolve_cp2102


CP2102 = "usb-Silicon_Labs_CP2102_USB_to_UART_Bridge_0001-if00-port0"
LR900 = "usb-MicoAir_LR900A_CP2102_915-if00-port0"


class ResolveTests(unittest.TestCase):
    def test_ignores_modem_and_ttyusb(self):
        self.assertFalse(is_cp2102_name("ttyUSB0"))
        self.assertFalse(is_cp2102_name("usb-HUAWEI_E3372_Modem-if00"))
        self.assertIsNone(resolve_cp2102([
            "ttyUSB0",
            "ttyUSB1",
            "usb-HUAWEI_E3372_Modem-if02",
        ]))
        picked = resolve_cp2102(["ttyUSB2", "usb-HUAWEI_E3372_CP2102_fake", CP2102, LR900])
        self.assertTrue(picked.endswith(LR900))
        self.assertNotIn("ttyUSB", picked)

    def test_off_by_default_does_not_open(self):
        opened = []
        fwd = RfForwarder(
            enabled=False,
            baud=57600,
            list_names=lambda: [CP2102],
            open_serial=lambda path, baud: opened.append((path, baud)),
        )
        fwd.poll_once()
        self.assertEqual(opened, [])
        st = fwd.status()
        self.assertTrue(st["present"])
        self.assertFalse(st["enabled"])
        self.assertEqual(st["baud"], 57600)
        self.assertEqual(st["rx_bytes"], 0)
        self.assertIsNone(st["last_packet_age"])

    def test_virtual_pair_forwards_and_survives_replug(self):
        master, slave = pty.openpty()
        tty.setraw(master)
        slave_name = os.ttyname(slave)
        present = {"on": True}

        class Port:
            def __init__(self):
                self.fd = os.open(slave_name, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
                tty.setraw(self.fd)

            def read(self, n):
                ready, _, _ = select.select([self.fd], [], [], 0.05)
                if not ready:
                    return b""
                return os.read(self.fd, n)

            def write(self, data):
                os.write(self.fd, data)

            def close(self):
                os.close(self.fd)

        to_fc = []

        def open_serial(path, baud):
            self.assertIn("CP2102", path)
            self.assertNotIn("ttyUSB", path)
            self.assertEqual(baud, 57600)
            return Port()

        fwd = RfForwarder(
            enabled=True,
            baud=57600,
            list_names=lambda: [CP2102] if present["on"] else [],
            open_serial=open_serial,
            write_fc=lambda data: to_fc.append(bytes(data)) or True,
        )
        fwd.poll_once()
        os.write(master, b"\xfehello")
        fwd.poll_once()
        self.assertEqual(to_fc, [b"\xfehello"])
        fwd.on_fc_bytes(b"\xfdback")
        got = b""
        for _ in range(10):
            ready, _, _ = select.select([master], [], [], 0.05)
            if ready:
                got += os.read(master, 64)
            if got:
                break
        self.assertEqual(got, b"\xfdback")
        st = fwd.status()
        self.assertGreater(st["rx_bytes"], 0)
        self.assertGreater(st["tx_bytes"], 0)
        self.assertIsNotNone(st["last_packet_age"])
        present["on"] = False
        fwd.poll_once()
        self.assertFalse(fwd.status()["present"])
        present["on"] = True
        to_fc.clear()
        fwd.poll_once()
        os.write(master, b"\xfeagain")
        fwd.poll_once()
        self.assertEqual(to_fc, [b"\xfeagain"])
        self.assertTrue(fwd.status()["present"])
        os.close(master)
        os.close(slave)


if __name__ == "__main__":
    unittest.main()
