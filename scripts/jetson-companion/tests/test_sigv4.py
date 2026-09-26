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
            self.assertIn("/auto/storage/goog4_request", signed["authorization"])
            self.assertNotIn("/s3/aws4_request", signed["authorization"])
            self.assertTrue(signed["authorization"].startswith("GOOG4-HMAC-SHA256 "))
            self.assertIn("x-goog-content-sha256", signed["signed_headers"])
            self.assertNotIn("x-amz-", signed["signed_headers"])
            for name in signed["headers"]:
                self.assertFalse(str(name).lower().startswith("x-amz-"))

    def test_gcs_hmac_matches_documented_goog4_derivation(self):
        """Google's HMAC V4 steps (signatures doc): GOOG4 prefix, date/auto/storage/goog4_request.

        The published page shows the canonical-request shape with x-amz headers and an RSA
        string-to-sign. This vector uses that same shape with x-goog headers and the HMAC
        derivation, computed here without calling sign_request.
        """
        import hashlib
        import hmac

        secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
        amz_date = "20190301T190859Z"
        scope = "20190301/auto/storage/goog4_request"
        canonical = "\n".join([
            "GET",
            "/example-bucket/tabby.jpeg",
            "",
            "\n".join([
                "host:storage.googleapis.com",
                "x-goog-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                "x-goog-date:20190301T190859Z",
                "",
            ]),
            "host;x-goog-content-sha256;x-goog-date",
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        ])

        def mac(key, msg):
            if isinstance(key, str):
                key = key.encode("utf-8")
            if isinstance(msg, str):
                msg = msg.encode("utf-8")
            return hmac.new(key, msg, hashlib.sha256).digest()

        hashed = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        string_to_sign = "\n".join(["GOOG4-HMAC-SHA256", amz_date, scope, hashed])
        key = mac("GOOG4" + secret, "20190301")
        key = mac(key, "auto")
        key = mac(key, "storage")
        key = mac(key, "goog4_request")
        expected = hmac.new(key, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
        self.assertEqual(expected, "f3a63605da392b4fabe0b746170b83facf06afdc935abbff04fa37db0a1cac1e")
        signed = sign_request(
            "GET",
            "storage.googleapis.com",
            "/example-bucket/tabby.jpeg",
            "GOOG1EXAMPLE",
            secret,
            "me-west1",
            amz_date,
            service="s3",
        )
        self.assertEqual(signed["signature"], expected)
        self.assertEqual(signed["canonical_request"], canonical)
        self.assertTrue(signed["authorization"].startswith("GOOG4-HMAC-SHA256 "))
        self.assertIn("/auto/storage/goog4_request", signed["authorization"])
        for name in signed["headers"]:
            self.assertFalse(str(name).lower().startswith("x-amz-"))


if __name__ == "__main__":
    unittest.main()
