import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createBitChordAuth } from './bitchord-addon-auth.mjs';
import type { Config } from './config.js';
import type { Quality } from './types.js';

const MEDIA_TTL_SECONDS = 30 * 60;

export function createProtectedBitChordAddon(
  { hosts, publicBaseUrl, mediaSecret }: NonNullable<Config['bitChordAuth']>,
  timeoutMs: number,
) {
  const verifierOptions = {
    hosts,
    fetch: (input: string, init?: RequestInit) => fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
  };
  const auth = createBitChordAuth(verifierOptions);

  async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    reply.header('Cache-Control', 'no-store');
    const result = await auth.verifyRequest(request.raw);
    if (!result.ok) {
      const { status, headers, body } = auth.rejection(result);
      return reply.code(status).headers(headers).send(body);
    }
  }

  function sign(path: string, quality: Quality, atmos: string | undefined, expiry: string): string {
    return createHmac('sha256', mediaSecret)
      .update(JSON.stringify(['bitchord-addon-media-v1', path, quality, atmos, expiry]))
      .digest('base64url');
  }

  function mediaUrl(path: string, quality: Quality, atmos?: string): string {
    const expiry = String(Math.floor(Date.now() / 1000) + MEDIA_TTL_SECONDS);
    const url = new URL(`${publicBaseUrl}${path}`);
    url.searchParams.set('quality', quality);
    if (atmos) url.searchParams.set('atmos', atmos);
    url.searchParams.set('exp', expiry);
    url.searchParams.set('sig', sign(path, quality, atmos, expiry));
    return url.toString();
  }

  function allowsMedia(path: string, quality: Quality, atmos: string | undefined, expiry?: string, signature?: string): boolean {
    if (typeof expiry !== 'string' || !/^\d{1,12}$/.test(expiry) || Number(expiry) <= Date.now() / 1000) return false;
    if (typeof signature !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
    const expected = sign(path, quality, atmos, expiry);
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }

  return { authenticate, mediaUrl, allowsMedia };
}
