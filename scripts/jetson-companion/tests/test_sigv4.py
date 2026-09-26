# -*- coding: utf-8 -*-
"""AWS Signature Version 4 published vectors."""

from __future__ import print_function

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from s3_sigv4 import sign_request  # noqa: E402


class SigV4Tests(unittest.TestCase):
    def test_s3_get_object_example(self):
        signed = sign_request(
            "GET",
            "examplebucket.s3.amazonaws.com",
            "/test.txt",
            "AKIAIOSFODNN7EXAMPLE",
            "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            "us-east-1",
            "20130524T000000Z",
            headers={"Range": "bytes=0-9"},
            service="s3",
        )
        self.assertEqual(signed["signature"], "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41")

    def test_iam_list_users(self):
        signed = sign_request(
            "GET",
            "iam.amazonaws.com",
            "/",
            "AKIDEXAMPLE",
            "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
            "us-east-1",
            "20150830T123600Z",
            query={"Action": "ListUsers", "Version": "2010-05-08"},
            headers={"Content-Type": "application/x-www-form-urlencoded; charset=utf-8"},
            service="iam",
            content_sha_header=False,
        )
        self.assertEqual(signed["signature"], "5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7")

    def test_get_vanilla(self):
        signed = sign_request(
            "GET",
            "example.amazonaws.com",
            "/",
            "AKIDEXAMPLE",
            "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
            "us-east-1",
            "20150830T123600Z",
            service="service",
            content_sha_header=False,
        )
        self.assertEqual(signed["signature"], "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31")

    def test_gcs_path_style_regions(self):
        from s3_sigv4 import path_style_url

        for region in ("auto", "me-west1"):
            url, host, uri = path_style_url(
                "https://storage.googleapis.com",
                "airvix-flights",
                "v1/plane/summary.json",
                secure=True,
            )
            self.assertEqual(url, "https://storage.googleapis.com/airvix-flights/v1/plane/summary.json")
            self.assertEqual(host, "storage.googleapis.com")
            self.assertEqual(uri, "/airvix-flights/v1/plane/summary.json")
            signed = sign_request(
                "PUT",
                host,
                uri,
                "GOOG1EXAMPLE",
                "not-a-real-hmac-secret",
                region,
                "20190311T192918Z",
                headers={"Content-Type": "application/json"},
                body=b"{}",
            )
            self.assertIn("/%s/s3/aws4_request" % region, signed["authorization"])
            self.assertTrue(signed["authorization"].startswith("AWS4-HMAC-SHA256 "))
            self.assertIn("x-amz-content-sha256", signed["signed_headers"])
            self.assertNotIn("GOOG4", signed["authorization"])


if __name__ == "__main__":
    unittest.main()
