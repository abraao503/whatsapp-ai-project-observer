import { createHmac, timingSafeEqual } from 'node:crypto';

export function secureEquals(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export function verifyWahaHmac(rawBody: Buffer, signature: string, algorithm: string, secret: string): boolean {
  if (!secret || algorithm.toLowerCase() !== 'sha512' || !/^[a-f\d]{128}$/i.test(signature)) {
    return false;
  }
  const expected = createHmac('sha512', secret).update(rawBody).digest('hex');
  return secureEquals(expected.toLowerCase(), signature.toLowerCase());
}
