import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PublicTrack, QobuzStream, QobuzTrack } from './types.js';

const DEFAULT_ID_SECRET = 'qobuz-bitchord-id-secret-v1';
export const MAX_PUBLIC_ID_LENGTH = 518;

const manifestFormats = new Map<string, QobuzStream['manifest']>([
  ['mpd', 'dash'], ['dash', 'dash'], ['m3u8', 'hls'], ['hls', 'hls'],
]);
const directFormats: ReadonlyMap<string, Pick<QobuzStream, 'codec' | 'container'>> = new Map([
  ['flac', { codec: 'flac', container: 'flac' }],
  ['mp3', { codec: 'mp3', container: 'mp3' }],
  ['aac', { codec: 'aac', container: 'adts' }],
  ['alac', { codec: 'alac', container: 'mp4' }],
  ['m4a', { container: 'mp4' }],
  ['mp4', { container: 'mp4' }],
  ['wav', { container: 'wav' }],
  ['ogg', { container: 'ogg' }],
]);

export function publicId(track: QobuzTrack, secret = DEFAULT_ID_SECRET): string {
  const encoded = Buffer.from(track.upstreamId, 'utf8').toString('base64url');
  const signature = sign(encoded, secret);
  return `qobuz_${encoded}_${signature}`;
}

export function upstreamIdFromPublicId(id: string, secret = DEFAULT_ID_SECRET): string | undefined {
  if (id.length > MAX_PUBLIC_ID_LENGTH) return undefined;
  const match = /^qobuz_([A-Za-z0-9_-]+)_([A-Za-z0-9_-]{16})$/.exec(id);
  if (!match) return undefined;
  const [encoded, supplied] = [match[1], match[2]];
  const expected = sign(encoded, secret);
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  try {
    const upstreamId = Buffer.from(encoded, 'base64url').toString('utf8');
    return upstreamId.trim() || undefined;
  } catch { return undefined; }
}

export function normalizeTrack(track: QobuzTrack, secret?: string): PublicTrack {
  const id = publicId(track, secret);
  if (id.length > MAX_PUBLIC_ID_LENGTH || !track.upstreamId.trim() || !track.title.trim()) {
    throw new Error('provider returned an unusable track');
  }
  return {
    id, title: track.title.trim(),
    artist: track.artist?.trim() || undefined, album: track.album?.trim() || undefined,
    duration: Number.isFinite(track.duration) && (track.duration as number) >= 0 ? track.duration : undefined,
    artworkURL: absoluteUrl(track.artworkURL), format: track.format?.toLowerCase(),
    audioQuality: track.audioQuality?.trim(), audioMode: track.audioMode, audioModes: track.audioModes, atmos: track.atmos,
  };
}

export function streamResponse(stream: QobuzStream): QobuzStream {
  if (!/^https:\/\//i.test(stream.url)) throw new Error('stream URL must be absolute HTTPS');
  const url = new URL(stream.url);
  if (url.protocol !== 'https:' || url.username || url.password || (stream.encrypted !== undefined && stream.encrypted !== false)) {
    throw new Error('stream is not an openable HTTPS rendition');
  }

  const extension = /\.([a-z0-9]+)$/i.exec(url.pathname)?.[1].toLowerCase();
  const declaredFormat = label(stream.format)?.toLowerCase();
  const manifest = stream.manifest ?? manifestFormats.get(declaredFormat ?? '') ?? manifestFormats.get(extension ?? '') ?? 'none';
  if (!['none', 'hls', 'dash'].includes(manifest)) throw new Error('unsupported manifest type');

  const format = declaredFormat ?? (manifest !== 'none' ? manifest : undefined)
    ?? (directFormats.has(extension ?? '') ? extension : undefined);
  const direct = manifest === 'none' ? directFormats.get(format ?? '') : undefined;
  return {
    url: stream.url,
    format,
    quality: label(stream.quality),
    codec: label(stream.codec)?.toLowerCase() ?? direct?.codec,
    container: label(stream.container)?.toLowerCase() ?? direct?.container,
    manifest,
    encrypted: false,
    sampleRate: positiveNumber(stream.sampleRate),
    bitDepth: Number.isInteger(stream.bitDepth) ? positiveNumber(stream.bitDepth) : undefined,
    bitrate: positiveNumber(stream.bitrate),
    audioMode: label(stream.audioMode),
  };
}

function label(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function sign(encoded: string, secret: string): string {
  return createHmac('sha256', secret || DEFAULT_ID_SECRET).update(encoded).digest('base64url').slice(0, 16);
}

function absoluteUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); return url.protocol === 'https:' ? url.toString() : undefined; } catch { return undefined; }
}
