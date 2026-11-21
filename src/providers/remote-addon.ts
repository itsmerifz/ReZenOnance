import type { Config } from '../config.js';
import type { QobuzProvider, QobuzStream, QobuzTrack, Quality } from '../types.js';
import { UpstreamError } from './http.js';

type RecordValue = Record<string, unknown>;

export class RemoteAddonProvider implements QobuzProvider {
  constructor(private readonly config: Config, private readonly configuredBaseUrl?: string) {}

  async search(query: string, quality: Quality, atmos?: string): Promise<QobuzTrack[]> {
    const body = await this.request('/search', { q: query, quality, ...(atmos ? { atmos } : {}) });
    const items = isRecord(body) && Array.isArray(body.tracks) ? body.tracks : Array.isArray(body) ? body : [];
    return items.filter(isRecord).map(toTrack).filter((track): track is QobuzTrack => track !== null);
  }

  async getStream(trackId: string, quality: Quality, atmos?: string): Promise<QobuzStream | null> {
    if (!trackId || trackId === '.' || trackId === '..') return null;
    const body = await this.request(`/stream/${encodeURIComponent(trackId)}`, { quality, ...(atmos ? { atmos } : {}) });
    return toAddonStream(body);
  }

  private async request(path: string, params: Record<string, string>): Promise<unknown> {
    const base = this.configuredBaseUrl ?? this.config.deezerBaseUrl ?? 'https://dzr.tabs-vs-spaces.wtf';
    const url = new URL(path.replace(/^\/+/, ''), base.endsWith('/') ? base : `${base}/`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    const maxAttempts = Math.max(this.config.upstreamRetries ?? 1, 2);
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.max(this.config.requestTimeoutMs, 10000));
      try {
        const response = await fetch(url, {
          headers: {
            accept: 'application/json',
            'user-agent': 'BitChord-Addon/1.0',
          },
          signal: controller.signal,
        });

        if (response.status === 404) return null;
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          const err = new UpstreamError(502, 'Remote provider returned invalid JSON');
          lastError = err;
          if (attempt >= maxAttempts) throw err;
          await delay(backoffWithJitter(attempt));
          continue;
        }

        if (!response.ok) {
          const status = response.status;
          const retryable = isRetryableStatus(status);
          const err = new UpstreamError(retryable ? 502 : status === 404 ? 404 : 400, 'Remote provider request failed');
          lastError = err;
          if (!retryable || attempt >= maxAttempts) throw err;
          await delay(backoffWithJitter(attempt));
          continue;
        }

        return body;
      } catch (error) {
        lastError = error;
        if (error instanceof UpstreamError) {
          if (error.status !== 502 || attempt >= maxAttempts) throw error;
        } else if (attempt >= maxAttempts) {
          throw new UpstreamError(502, 'Remote provider request failed');
        }
        await delay(backoffWithJitter(attempt));
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError instanceof UpstreamError ? lastError : new UpstreamError(502, 'Remote provider request failed');
  }
}

export function toAddonStream(body: unknown): QobuzStream | null {
  if (!isRecord(body) || typeof body.url !== 'string' || !/^https:\/\//i.test(body.url)) return null;
  return {
    url: body.url,
    format: stringValue(body.format),
    quality: stringValue(body.quality),
    codec: stringValue(body.codec),
    container: stringValue(body.container),
    manifest: body.manifest === 'none' || body.manifest === 'hls' || body.manifest === 'dash' ? body.manifest : undefined,
    encrypted: body.encrypted === undefined ? undefined : body.encrypted !== false,
    sampleRate: typeof body.sampleRate === 'number' ? body.sampleRate : undefined,
    bitDepth: typeof body.bitDepth === 'number' ? body.bitDepth : undefined,
    bitrate: typeof body.bitrate === 'number' ? body.bitrate : undefined,
    audioMode: stringValue(body.audioMode),
  };
}

function toTrack(raw: RecordValue): QobuzTrack | null {
  const id = raw.id ?? raw.upstreamId ?? raw.trackId;
  const title = raw.title;
  if ((typeof id !== 'number' && typeof id !== 'string') || typeof title !== 'string' || !title.trim()) return null;
  const artist = typeof raw.artist === 'string' ? raw.artist : isRecord(raw.artist) && typeof raw.artist.name === 'string' ? raw.artist.name : undefined;
  const album = typeof raw.album === 'string' ? raw.album : isRecord(raw.album) && typeof raw.album.title === 'string' ? raw.album.title : undefined;
  const format = typeof raw.format === 'string' ? raw.format : undefined;
  const audioQuality = typeof raw.audioQuality === 'string' ? raw.audioQuality : typeof raw.quality === 'string' ? raw.quality : undefined;
  return {
    upstreamId: String(id),
    title: title.trim(),
    artist,
    album,
    duration: typeof raw.duration === 'number' ? raw.duration : undefined,
    artworkURL: stringValue(raw.artworkURL) ?? stringValue(raw.albumArtworkURL) ?? stringValue(raw.artwork),
    format,
    audioQuality,
    audioMode: stringValue(raw.audioMode),
    audioModes: Array.isArray(raw.audioModes) ? raw.audioModes.filter((mode): mode is string => typeof mode === 'string') : undefined,
    atmos: typeof raw.atmos === 'boolean' ? raw.atmos : undefined,
  };
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function backoffWithJitter(attempt: number): number {
  return 200 * (2 ** attempt) + Math.floor(Math.random() * 100);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is RecordValue { return typeof value === 'object' && value !== null; }
function stringValue(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
