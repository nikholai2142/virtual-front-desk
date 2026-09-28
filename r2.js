'use strict';
/**
 * Cloudflare R2 client — S3-compatible object storage, used to persist call
 * recordings so they survive redeploys/restarts (the local-disk default,
 * used when this isn't configured, doesn't — see the README's "Call
 * recordings" section).
 *
 * No npm package needed: R2's S3-compatible API just needs AWS Signature
 * Version 4 request signing, which is HMAC-SHA256 chained over a few
 * fields — doable directly with Node's built-in `crypto`, the same way
 * turn.js and store.js call out to their own APIs with nothing but
 * `fetch`. This keeps the project's zero-dependency approach intact.
 *
 * Env vars (Render → your service → Environment):
 *   R2_ACCOUNT_ID          - Cloudflare account ID
 *   R2_ACCESS_KEY_ID       - from an R2 API token
 *   R2_SECRET_ACCESS_KEY   - from the same R2 API token
 *   R2_BUCKET              - the bucket name to store recordings in
 *
 * See the README's "Call recordings" section for the full setup, including
 * where to find/create each of these.
 *
 * Without them, server.js falls back to local disk on its own — every
 * function here is only ever called after checking `configured`.
 */

const crypto = require('crypto');

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const BUCKET = process.env.R2_BUCKET || '';
const configured = Boolean(ACCOUNT_ID && ACCESS_KEY_ID && SECRET_ACCESS_KEY && BUCKET);

const REGION = 'auto'; // R2's SigV4 region is always the literal string "auto"
const SERVICE = 's3';
const HOST = configured ? `${ACCOUNT_ID}.r2.cloudflarestorage.com` : '';

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** { amzDate: '20260922T175000Z', dateStamp: '20260922' } */
function amzDateParts(date) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function signingKey(dateStamp) {
  const kDate = hmac('AWS4' + SECRET_ACCESS_KEY, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  return hmac(kService, 'aws4_request');
}

/**
 * AWS's URI-encoding rules for canonical requests: percent-encode
 * everything except unreserved characters (RFC 3986), including the ones
 * encodeURIComponent leaves alone (!'()*) — and keep '/' literal in a
 * resource path (but not inside a query string value).
 */
function uriEncode(str, encodeSlash) {
  return encodeURIComponent(str)
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%2F/g, encodeSlash ? '%2F' : '/');
}

function canonicalUriFor(key) {
  return '/' + BUCKET + '/' + uriEncode(key, false);
}

function assertConfigured() {
  if (!configured) throw new Error('Cloudflare R2 is not configured on this server (missing env vars)');
}

/** Uploads a buffer as one object (PutObject). Throws on failure — callers decide the fallback. */
async function putObject(key, buffer, contentType) {
  assertConfigured();
  const { amzDate, dateStamp } = amzDateParts(new Date());
  const payloadHash = sha256Hex(buffer);
  const canonicalUri = canonicalUriFor(key);
  const canonicalHeaders =
    `content-type:${contentType}\n` +
    `host:${HOST}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = ['PUT', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(dateStamp), stringToSign).toString('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(`https://${HOST}${canonicalUri}`, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      'X-Amz-Content-Sha256': payloadHash,
      'X-Amz-Date': amzDate,
      Authorization: authorization,
    },
    body: buffer,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`R2 upload failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
}

/**
 * Returns a presigned GET URL (query-string auth) valid for
 * `expiresSeconds`, so the agent's browser can play a recording straight
 * from R2 without the file ever passing back through this server. Minted
 * fresh on every call — never persisted — since it expires.
 */
function getPresignedUrl(key, expiresSeconds) {
  assertConfigured();
  const { amzDate, dateStamp } = amzDateParts(new Date());
  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const canonicalUri = canonicalUriFor(key);

  const queryParams = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${ACCESS_KEY_ID}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresSeconds),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQueryString = Object.keys(queryParams)
    .sort()
    .map((k) => `${uriEncode(k, true)}=${uriEncode(queryParams[k], true)}`)
    .join('&');
  const canonicalHeaders = `host:${HOST}\n`;
  const canonicalRequest = ['GET', canonicalUri, canonicalQueryString, canonicalHeaders, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(dateStamp), stringToSign).toString('hex');

  return `https://${HOST}${canonicalUri}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}

/** Best-effort delete (e.g. cleaning up after a failed finalize) — logs and swallows errors rather than throwing. */
async function deleteObject(key) {
  if (!configured) return;
  try {
    const { amzDate, dateStamp } = amzDateParts(new Date());
    const payloadHash = sha256Hex(Buffer.alloc(0));
    const canonicalUri = canonicalUriFor(key);
    const canonicalHeaders = `host:${HOST}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = ['DELETE', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
    const signature = hmac(signingKey(dateStamp), stringToSign).toString('hex');
    const authorization = `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const res = await fetch(`https://${HOST}${canonicalUri}`, {
      method: 'DELETE',
      headers: { 'X-Amz-Content-Sha256': payloadHash, 'X-Amz-Date': amzDate, Authorization: authorization },
    });
    if (!res.ok && res.status !== 404) {
      console.error(`[r2] delete of ${key} failed (HTTP ${res.status}), non-fatal`);
    }
  } catch (err) {
    console.error('[r2] could not delete object (non-fatal):', err.message);
  }
}

function xmlUnescape(str) {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Sums the size of every object in the bucket via the S3-compatible
 * ListObjectsV2 API (paginating with continuation tokens for buckets with
 * more than 1000 objects). R2 bills storage like S3 rather than enforcing a
 * hard quota, so there's no "space left" to report — this returns actual
 * usage, which server.js compares against a free-tier reference. Throws on
 * failure — callers decide the fallback (same convention as putObject).
 */
async function getStorageSummary() {
  assertConfigured();
  let bytesUsed = 0;
  let objectCount = 0;
  let continuationToken = null;

  do {
    const queryParams = { 'list-type': '2', 'max-keys': '1000' };
    if (continuationToken) queryParams['continuation-token'] = continuationToken;

    const { amzDate, dateStamp } = amzDateParts(new Date());
    const payloadHash = sha256Hex(Buffer.alloc(0));
    const canonicalUri = '/' + BUCKET;
    const canonicalQueryString = Object.keys(queryParams)
      .sort()
      .map((k) => `${uriEncode(k, true)}=${uriEncode(queryParams[k], true)}`)
      .join('&');
    const canonicalHeaders = `host:${HOST}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = ['GET', canonicalUri, canonicalQueryString, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
    const signature = hmac(signingKey(dateStamp), stringToSign).toString('hex');
    const authorization = `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const res = await fetch(`https://${HOST}${canonicalUri}?${canonicalQueryString}`, {
      method: 'GET',
      headers: { 'X-Amz-Content-Sha256': payloadHash, 'X-Amz-Date': amzDate, Authorization: authorization },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`R2 list failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
    }
    const xml = await res.text();

    // Cheap hand-rolled parsing rather than pulling in an XML library —
    // ListObjectsV2's response is flat enough that these two regexes are
    // reliable (Size is always a plain integer; the count of <Size> tags
    // is the object count on this page).
    for (const m of xml.matchAll(/<Size>(\d+)<\/Size>/g)) {
      bytesUsed += Number(m[1]);
      objectCount += 1;
    }

    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    const tokenMatch = xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/);
    continuationToken = truncated && tokenMatch ? xmlUnescape(tokenMatch[1]) : null;
  } while (continuationToken);

  return { bytesUsed, objectCount };
}

module.exports = {
  configured,
  putObject,
  getPresignedUrl,
  deleteObject,
  getStorageSummary,
};
