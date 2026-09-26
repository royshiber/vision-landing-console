/**
 * In-repo signer for path-style S3. storage.googleapis.com uses GCS HMAC V4
 * (GOOG4-HMAC-SHA256, scope date/auto/storage/goog4_request, x-goog-* only).
 * Other hosts stay AWS SigV4. This module is the console reader: GET and LIST only.
 * No npm dependency. The secret never leaves this module's request signer.
 */
import crypto from 'node:crypto';

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(typeof data === 'string' ? data : data, 'utf8').digest();
}

export function isGcsHost(host) {
  const name = String(host || '').split('/')[0].split(':')[0].toLowerCase();
  return name === 'storage.googleapis.com' || name.endsWith('.storage.googleapis.com');
}

export function signingKey(secret, dateStamp, region, service, prefix = 'AWS4', terminator = 'aws4_request') {
  const kDate = hmac(`${prefix}${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, terminator);
}

export function encodeRfc3986(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function canonicalUri(pathname) {
  const raw = pathname && pathname.startsWith('/') ? pathname : `/${pathname || ''}`;
  const encoded = raw.split('/').map((seg) => encodeRfc3986(decodeURIComponentSafe(seg))).join('/');
  return encoded.startsWith('/') ? encoded : `/${encoded}`;
}

function decodeURIComponentSafe(seg) {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

export function canonicalQuery(params) {
  const entries = [];
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    entries.push([encodeRfc3986(k), encodeRfc3986(String(v))]);
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return entries.map(([k, v]) => `${k}=${v}`).join('&');
}

/**
 * @returns {{authorization: string, signature: string, canonicalRequest: string, stringToSign: string, signedHeaders: string, payloadHash: string}}
 */
export function signAwsRequest({
  method = 'GET',
  host,
  uri,
  query = {},
  headers = {},
  body = '',
  accessKeyId,
  secretAccessKey,
  region,
  service = 's3',
  amzDate,
  payloadHash,
  unsignedPayload = false,
  contentShaHeader = true,
}) {
  const gcs = isGcsHost(host);
  const dateStamp = amzDate.slice(0, 8);
  const hash = unsignedPayload ? 'UNSIGNED-PAYLOAD' : (payloadHash || sha256Hex(body || ''));
  const hdrs = {};
  for (const [k, v] of Object.entries(headers)) {
    let name = String(k).toLowerCase().trim();
    if (gcs && name.startsWith('x-amz-meta-')) name = `x-goog-meta-${name.slice('x-amz-meta-'.length)}`;
    if (gcs && name.startsWith('x-amz-')) continue;
    hdrs[name] = String(v).trim().replace(/\s+/g, ' ');
  }
  hdrs.host = host;
  const dateHeader = gcs ? 'x-goog-date' : 'x-amz-date';
  const shaHeader = gcs ? 'x-goog-content-sha256' : 'x-amz-content-sha256';
  const dateQuery = gcs ? 'X-Goog-Date' : 'X-Amz-Date';
  if (!unsignedPayload) hdrs[dateHeader] = amzDate;
  if (contentShaHeader && !unsignedPayload) hdrs[shaHeader] = hash;
  if (unsignedPayload && headers[dateHeader] === undefined && !query[dateQuery]) {
    hdrs[dateHeader] = amzDate;
  }
  const names = Object.keys(hdrs).sort();
  const canonicalHeaders = names.map((n) => `${n}:${hdrs[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    String(method || 'GET').toUpperCase(),
    canonicalUri(uri),
    canonicalQuery(query),
    canonicalHeaders,
    signedHeaders,
    hash,
  ].join('\n');
  const scopeRegion = gcs ? 'auto' : region;
  const scopeService = gcs ? 'storage' : service;
  const algorithm = gcs ? 'GOOG4-HMAC-SHA256' : 'AWS4-HMAC-SHA256';
  const prefix = gcs ? 'GOOG4' : 'AWS4';
  const terminator = gcs ? 'goog4_request' : 'aws4_request';
  const scope = `${dateStamp}/${scopeRegion}/${scopeService}/${terminator}`;
  const stringToSign = [algorithm, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(secretAccessKey, dateStamp, scopeRegion, scopeService, prefix, terminator))
    .update(stringToSign, 'utf8')
    .digest('hex');
  const authorization = `${algorithm} Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { authorization, signature, canonicalRequest, stringToSign, signedHeaders, payloadHash: hash, scope, headers: hdrs };
}

export function presignGetUrl({
  endpoint,
  bucket,
  key,
  accessKeyId,
  secretAccessKey,
  region,
  expires = 300,
  amzDate,
  service = 's3',
}) {
  const host = normalizeHost(endpoint);
  const uri = `/${bucket}/${String(key).split('/').map((s) => encodeRfc3986(s)).join('/')}`;
  const gcs = isGcsHost(host);
  const dateStamp = amzDate.slice(0, 8);
  const scope = gcs
    ? `${dateStamp}/auto/storage/goog4_request`
    : `${dateStamp}/${region}/${service}/aws4_request`;
  const query = gcs
    ? {
      'X-Goog-Algorithm': 'GOOG4-HMAC-SHA256',
      'X-Goog-Credential': `${accessKeyId}/${scope}`,
      'X-Goog-Date': amzDate,
      'X-Goog-Expires': String(expires),
      'X-Goog-SignedHeaders': 'host',
    }
    : {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${accessKeyId}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expires),
      'X-Amz-SignedHeaders': 'host',
    };
  const signed = signAwsRequest({
    method: 'GET',
    host,
    uri,
    query,
    headers: {},
    accessKeyId,
    secretAccessKey,
    region,
    service,
    amzDate,
    unsignedPayload: true,
    contentShaHeader: false,
  });
  const sigName = gcs ? 'X-Goog-Signature' : 'X-Amz-Signature';
  const qs = canonicalQuery({ ...query, [sigName]: signed.signature });
  return { url: `https://${host}${canonicalUri(uri)}?${qs}`, signature: signed.signature };
}

export function normalizeHost(endpoint) {
  return String(endpoint || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function parseListObjectsV2(xml) {
  const contents = [];
  const re = /<Contents>([\s\S]*?)<\/Contents>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const key = (block.match(/<Key>([\s\S]*?)<\/Key>/) || [])[1];
    const etag = (block.match(/<ETag>([\s\S]*?)<\/ETag>/) || [])[1];
    const size = (block.match(/<Size>([\s\S]*?)<\/Size>/) || [])[1];
    if (key) {
      contents.push({
        key: decodeXml(key),
        etag: decodeXml(etag || '').replace(/^"|"$/g, ''),
        size: Number(size || 0),
      });
    }
  }
  const prefixes = [];
  const pre = /<CommonPrefixes>[\s\S]*?<Prefix>([\s\S]*?)<\/Prefix>[\s\S]*?<\/CommonPrefixes>/g;
  while ((m = pre.exec(xml))) prefixes.push(decodeXml(m[1]));
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const token = (xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/) || [])[1] || null;
  return { contents, prefixes, truncated, nextToken: token ? decodeXml(token) : null };
}

function redact(text, secret) {
  const raw = String(text || '');
  if (!secret) return raw;
  return raw.split(secret).join('[redacted]');
}

export function createS3Client({
  endpoint,
  region,
  bucket,
  accessKeyId,
  secretAccessKey,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
} = {}) {
  const host = normalizeHost(endpoint);
  const secret = String(secretAccessKey || '');

  function amzNow() {
    return now().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  }

  async function signedFetch(method, uri, { query = {}, body = null } = {}) {
    const amzDate = amzNow();
    const payload = body ? (Buffer.isBuffer(body) ? body : Buffer.from(body)) : Buffer.alloc(0);
    const signed = signAwsRequest({
      method,
      host,
      uri,
      query,
      headers: {},
      body: payload,
      accessKeyId,
      secretAccessKey: secret,
      region,
      service: 's3',
      amzDate,
      payloadHash: sha256Hex(payload),
      contentShaHeader: true,
    });
    const qs = canonicalQuery(query);
    const url = `https://${host}${canonicalUri(uri)}${qs ? `?${qs}` : ''}`;
    const wire = { authorization: signed.authorization };
    for (const [name, value] of Object.entries(signed.headers)) wire[name] = value;
    const res = await fetchImpl(url, {
      method,
      headers: wire,
    });
    return res;
  }

  return {
    presignGet(key, expires = 300) {
      return presignGetUrl({
        endpoint: host,
        bucket,
        key,
        accessKeyId,
        secretAccessKey: secret,
        region,
        expires,
        amzDate: amzNow(),
      }).url;
    },

    async listObjectsV2({ prefix = '', delimiter = '', continuationToken } = {}) {
      const query = { 'list-type': '2', prefix };
      if (delimiter) query.delimiter = delimiter;
      if (continuationToken) query['continuation-token'] = continuationToken;
      const uri = `/${bucket}`;
      const res = await signedFetch('GET', uri, { query });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`list failed ${res.status}`);
        err.status = res.status;
        err.detail = redact(text, secret).slice(0, 300);
        throw err;
      }
      const page = parseListObjectsV2(text);
      if (page.truncated && page.nextToken) {
        const rest = await this.listObjectsV2({ prefix, delimiter, continuationToken: page.nextToken });
        return {
          contents: page.contents.concat(rest.contents),
          prefixes: page.prefixes.concat(rest.prefixes),
        };
      }
      return { contents: page.contents, prefixes: page.prefixes };
    },

    async getObject(key) {
      const uri = `/${bucket}/${String(key).split('/').map((s) => encodeRfc3986(s)).join('/')}`;
      const res = await signedFetch('GET', uri);
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`get failed ${res.status}`);
        err.status = res.status;
        err.detail = redact(text, secret).slice(0, 300);
        throw err;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const etag = String(res.headers.get('etag') || '').replace(/"/g, '');
      return { bytes: buf, etag, contentType: res.headers.get('content-type') || '' };
    },
  };
}
