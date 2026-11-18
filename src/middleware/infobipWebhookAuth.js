import { createHmac, timingSafeEqual } from 'node:crypto';
import { hasExpectedBearerToken } from './bearerToken.js';

const HMAC_ALGORITHMS = Object.freeze({
  HMAC_MD5: 'md5',
  HMAC_SHA_1: 'sha1',
  HMAC_SHA_224: 'sha224',
  HMAC_SHA_256: 'sha256',
  HMAC_SHA_384: 'sha384',
  HMAC_SHA_512: 'sha512',
});

function normalizeAlgorithm(algorithm) {
  const normalized = typeof algorithm === 'string' ? algorithm.trim().toUpperCase() : '';
  const nodeAlgorithm = HMAC_ALGORITHMS[normalized];

  if (nodeAlgorithm === undefined) {
    throw new TypeError('Unsupported Infobip webhook HMAC algorithm.');
  }

  return { normalized, nodeAlgorithm };
}

function verifyInfobipWebhookSignature({ rawBody, signature, secret, algorithm = 'HMAC_SHA_256' } = {}) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0 || typeof secret !== 'string' || secret.length === 0 || typeof signature !== 'string') {
    return false;
  }

  let resolvedAlgorithm;
  try {
    resolvedAlgorithm = normalizeAlgorithm(algorithm);
  } catch {
    return false;
  }
  const { normalized, nodeAlgorithm } = resolvedAlgorithm;
  const candidates = new Set([normalized, nodeAlgorithm]);
  let supplied = signature.trim();
  const separator = supplied.indexOf('=');

  if (separator !== -1) {
    const prefix = supplied.slice(0, separator).toUpperCase();
    if (!candidates.has(prefix)) return false;
    supplied = supplied.slice(separator + 1);
  }

  if (!/^[\da-f]+$/i.test(supplied) || supplied.length % 2 !== 0) return false;

  const providedDigest = Buffer.from(supplied, 'hex');
  const expectedDigest = createHmac(nodeAlgorithm, secret).update(rawBody).digest();

  return providedDigest.length === expectedDigest.length && timingSafeEqual(providedDigest, expectedDigest);
}

function isAuthenticatedInfobipWebhook(request, { webhookToken, hmacSecret, hmacAlgorithm } = {}) {
  // When HMAC is configured, it is the required provider authentication
  // mechanism. A legacy bearer token must not downgrade a bad/missing signature.
  if (typeof hmacSecret === 'string' && hmacSecret.length > 0) {
    const signature = request.get?.('X-Hub-Signature') ?? request.headers?.['x-hub-signature'];
    return verifyInfobipWebhookSignature({
      rawBody: request.rawBody,
      signature,
      secret: hmacSecret,
      algorithm: hmacAlgorithm,
    });
  }

  return hasExpectedBearerToken(request, webhookToken);
}

export { HMAC_ALGORITHMS, isAuthenticatedInfobipWebhook, verifyInfobipWebhookSignature };
