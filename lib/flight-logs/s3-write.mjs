/**
 * S3 multipart writer. Same signer as the read-only client.
 * The console calls this only when AIRVIX_GCS_LOG_UPLOAD is on.
 */
import {
  canonicalQuery,
  canonicalUri,
  createS3Client,
  encodeRfc3986,
  normalizeHost,
  sha256Hex,
  signAwsRequest,
} from './s3-client.mjs';

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function parseUploadId(xml) {
  const m = String(xml || '').match(/<UploadId>([\s\S]*?)<\/UploadId>/);
  return m ? decodeXml(m[1]).trim() : null;
}

export function completeMultipartXml(parts) {
  const items = (parts || [])
    .slice()
    .sort((a, b) => a.partNumber - b.partNumber)
    .map((p) => `<Part><PartNumber>${Number(p.partNumber)}</PartNumber><ETag>&quot;${String(p.etag).replace(/"/g, '')}&quot;</ETag></Part>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload>${items}</CompleteMultipartUpload>`;
}

function objectUri(bucket, key) {
  return `/${bucket}/${String(key).split('/').map((s) => encodeRfc3986(s)).join('/')}`;
}

export function createS3Writer({
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
  const reader = createS3Client({
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    fetchImpl,
    now,
  });

  function amzNow() {
    return now().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  }

  async function signed(method, uri, { query = {}, body = null, contentType } = {}) {
    const amzDate = amzNow();
    const payload = body == null
      ? Buffer.alloc(0)
      : (Buffer.isBuffer(body) ? body : Buffer.from(body));
    const headers = {};
    if (contentType) headers['content-type'] = contentType;
    const signedReq = signAwsRequest({
      method,
      host,
      uri,
      query,
      headers,
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
    const wire = { authorization: signedReq.authorization };
    for (const [name, value] of Object.entries(signedReq.headers)) wire[name] = value;
    const res = await fetchImpl(url, {
      method,
      headers: wire,
      body: payload.length ? payload : undefined,
    });
    return res;
  }

  return {
    reader,
    async createMultipartUpload(key) {
      const uri = objectUri(bucket, key);
      const res = await signed('POST', uri, { query: { uploads: '' } });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`multipart start failed ${res.status}`);
        err.status = res.status;
        throw err;
      }
      const uploadId = parseUploadId(text);
      if (!uploadId) throw new Error('multipart start missing upload id');
      return { uploadId };
    },
    async uploadPart(key, { uploadId, partNumber, body }) {
      const uri = objectUri(bucket, key);
      const res = await signed('PUT', uri, {
        query: { partNumber: String(partNumber), uploadId },
        body,
      });
      if (!res.ok) {
        const err = new Error(`part failed ${res.status}`);
        err.status = res.status;
        throw err;
      }
      const etag = String(res.headers.get('etag') || '').replace(/"/g, '');
      if (!etag) throw new Error('part missing etag');
      return { etag };
    },
    async completeMultipartUpload(key, { uploadId, parts }) {
      const uri = objectUri(bucket, key);
      const xml = completeMultipartXml(parts);
      const res = await signed('POST', uri, {
        query: { uploadId },
        body: xml,
        contentType: 'application/xml',
      });
      if (!res.ok) {
        const err = new Error(`complete failed ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return { ok: true };
    },
    listObjectsV2(opts) {
      return reader.listObjectsV2(opts);
    },
    getObject(key) {
      return reader.getObject(key);
    },
  };
}
