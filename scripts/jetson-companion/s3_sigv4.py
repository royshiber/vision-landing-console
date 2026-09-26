# -*- coding: utf-8 -*-
"""Stdlib AWS Signature Version 4 for path-style S3 (B2 / R2 / S3). No boto3."""

from __future__ import print_function

import hashlib
import hmac
from urllib.parse import quote

EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"


def sha256_hex(data):
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data or b"").hexdigest()


def _hmac(key, msg):
    if isinstance(key, str):
        key = key.encode("utf-8")
    if isinstance(msg, str):
        msg = msg.encode("utf-8")
    return hmac.new(key, msg, hashlib.sha256).digest()


def signing_key(secret, date_stamp, region, service):
    k_date = _hmac("AWS4" + secret, date_stamp)
    k_region = _hmac(k_date, region)
    k_service = _hmac(k_region, service)
    return _hmac(k_service, "aws4_request")


def encode_rfc3986(value):
    return quote(str(value), safe="-_.~")


def canonical_uri(pathname):
    raw = pathname if pathname and str(pathname).startswith("/") else "/" + str(pathname or "")
    parts = []
    for seg in raw.split("/"):
        if seg == "":
            parts.append("")
            continue
        try:
            from urllib.parse import unquote

            decoded = unquote(seg)
        except Exception:
            decoded = seg
        parts.append(encode_rfc3986(decoded))
    encoded = "/".join(parts)
    return encoded if encoded.startswith("/") else "/" + encoded


def canonical_query(params):
    entries = []
    for key, value in (params or {}).items():
        if value is None:
            continue
        entries.append((encode_rfc3986(key), encode_rfc3986(value)))
    entries.sort()
    return "&".join("%s=%s" % pair for pair in entries)


def sign_request(
    method,
    host,
    uri,
    access_key,
    secret,
    region,
    amz_date,
    query=None,
    headers=None,
    body=b"",
    service="s3",
    payload_hash=None,
    content_sha_header=True,
):
    if isinstance(body, str):
        body = body.encode("utf-8")
    body = body or b""
    digest = payload_hash or sha256_hex(body)
    hdrs = {}
    for key, value in (headers or {}).items():
        hdrs[str(key).lower().strip()] = " ".join(str(value).strip().split())
    hdrs["host"] = host
    hdrs["x-amz-date"] = amz_date
    if content_sha_header:
        hdrs["x-amz-content-sha256"] = digest
    names = sorted(hdrs.keys())
    canonical_headers = "".join("%s:%s\n" % (name, hdrs[name]) for name in names)
    signed_headers = ";".join(names)
    canonical = "\n".join(
        [
            str(method or "GET").upper(),
            canonical_uri(uri),
            canonical_query(query),
            canonical_headers,
            signed_headers,
            digest,
        ]
    )
    date_stamp = amz_date[:8]
    scope = "%s/%s/%s/aws4_request" % (date_stamp, region, service)
    string_to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, sha256_hex(canonical)])
    signature = hmac.new(signing_key(secret, date_stamp, region, service), string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    authorization = "AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s" % (
        access_key,
        scope,
        signed_headers,
        signature,
    )
    return {
        "authorization": authorization,
        "signature": signature,
        "canonical_request": canonical,
        "string_to_sign": string_to_sign,
        "signed_headers": signed_headers,
        "payload_hash": digest,
        "headers": hdrs,
    }


def normalize_host(endpoint):
    text = str(endpoint or "").strip()
    if text.startswith("https://"):
        text = text[len("https://") :]
    elif text.startswith("http://"):
        text = text[len("http://") :]
    return text.strip("/")


def path_style_url(endpoint, bucket, key, secure=True):
    host = normalize_host(endpoint)
    parts = [encode_rfc3986(seg) for seg in str(key).split("/") if seg != ""]
    uri = "/" + bucket.strip("/") + "/" + "/".join(parts)
    scheme = "https" if secure else "http"
    return scheme + "://" + host + uri, host, uri
