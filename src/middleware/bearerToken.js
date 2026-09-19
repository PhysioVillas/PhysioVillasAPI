import { timingSafeEqual } from 'node:crypto';

function hasExpectedBearerToken(request, token) {
  const authorization = request.get('authorization');
  const expected = `Bearer ${token}`;

  if (typeof authorization !== 'string') {
    return false;
  }

  const actualBuffer = Buffer.from(authorization);
  const expectedBuffer = Buffer.from(expected);

  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

export { hasExpectedBearerToken };
