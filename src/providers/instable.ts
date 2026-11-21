import type { Config } from '../config.js';
import type { QobuzProvider, QobuzStream, QobuzTrack, Quality } from '../types.js';
import { UpstreamError } from './http.js';

type RecordValue = Record<string, unknown>;

export class InstableProvider implements QobuzProvider {
  constructor(private readonly config: Config) {}

  async search(query: string, _quality: Quality): Promise<QobuzTrack[]> {
    const body = await this.request('/api/search', { q: query });
    const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
    const items = data && isRecord(data.tracks) && Array.isArray(data.tracks.items) ? data.tracks.items : [];
    return items.filter(isRecord).map(toTrack).filter((track): track is QobuzTrack => track !== null);
  }

  async getStream(trackId: string, quality: Quality): Promise<QobuzStream | null> {
    const cleanId = trackId.includes(':') ? trackId.slice(trackId.lastIndexOf(':') + 1) : trackId;
    if (!/^[A-Za-z0-9_-]+$/.test(cleanId)) return null;
    const body = await this.request(`/api/player/stream/${encodeURIComponent(cleanId)}`, { quality: qualityId(quality) });
    if (!isRecord(body) || typeof body.url !== 'string' || !/^https:\/\//i.test(body.url)) return null;
    return {
      url: body.url,
      format: mimeFormat(body.mimeType),
      quality: typeof body.quality === 'string' ? body.quality : undefined,
      encrypted: false,
      sampleRate: typeof body.sampleRate === 'number' ? body.sampleRate : undefined,
      bitDepth: typeof body.bitDepth === 'number' ? body.bitDepth : undefined,
      bitrate: typeof body.bitrate === 'number' ? body.bitrate : undefined,
    };
  }

  private async request(path: string, params: Record<string, string>): Promise<unknown> {
    const base = this.config.instableBaseUrl ?? 'https://arcod.xyz';
    const url = new URL(path.replace(/^\/+/, ''), base.endsWith('/') ? base : `${base}/`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    let lastError: unknown;
    const maxAttempts = Math.max(this.config.upstreamRetries ?? 1, 2);
    for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.max(this.config.requestTimeoutMs, 15000));
      try {
        const response = await fetch(url, {
          headers: {
            accept: 'application/json',
            'accept-language': 'en-US,en;q=0.9',
            'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
            referer: `${base.replace(/\/$/, '')}/`,
            origin: base.replace(/\/$/, ''),
          },
          signal: controller.signal,
        });
        let body: unknown;
        try { body = await response.json(); } catch { throw new UpstreamError(502, 'Instable returned invalid JSON'); }
        if (!response.ok) {
          const error = new UpstreamError(retryable(response.status) ? 502 : response.status === 404 ? 404 : 400, 'Instable request failed');
          if (!retryable(response.status) || attempt >= maxAttempts) throw error;
          lastError = error;
        } else if (isRecord(body) && body.success === false) {
          throw new UpstreamError(502, 'Instable request failed');
        } else return body;
      } catch (error) {
        lastError = error;
        if (error instanceof UpstreamError) {
          if (error.status !== 502 || attempt >= maxAttempts) throw error;
        }
      } finally { clearTimeout(timeout); }
      if (attempt < maxAttempts) {
        await delay(200 * (2 ** attempt) + Math.floor(Math.random() * 100));
      }
    }
    throw lastError instanceof UpstreamError ? lastError : new UpstreamError(502, 'Instable request failed');
  }
}

function toTrack(raw: RecordValue): QobuzTrack | null {
  const id = raw.id;
  const title = raw.title;
  if ((typeof id !== 'number' && typeof id !== 'string') || typeof title !== 'string' || !title.trim()) return null;
  const performer = isRecord(raw.performer) ? raw.performer : undefined;
  const album = isRecord(raw.album) ? raw.album : undefined;
  const image = album && isRecord(album.image) ? album.image : undefined;
  return {
    upstreamId: String(id),
    title: title.trim(),
    artist: performer && typeof performer.name === 'string' ? performer.name : undefined,
    album: album && typeof album.title === 'string' ? album.title : undefined,
    duration: typeof raw.duration === 'number' ? raw.duration : undefined,
    artworkURL: image && typeof image.large === 'string' ? image.large : undefined,
    format: typeof raw.maximum_bit_depth === 'number' ? 'flac' : undefined,
    audioQuality: typeof raw.maximum_bit_depth === 'number' ? 'LOSSLESS' : undefined,
  };
}

function qualityId(quality: Quality): string { return quality === 'LOSSLESS' ? '27' : '5'; }
function mimeFormat(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  switch (value.split(';', 1)[0].trim().toLowerCase()) {
    case 'audio/flac':
    case 'audio/x-flac': return 'flac';
    case 'audio/mpeg': return 'mp3';
    case 'audio/aac': return 'aac';
    case 'audio/mp4': return 'mp4';
    case 'application/dash+xml': return 'dash';
    case 'application/vnd.apple.mpegurl':
    case 'application/x-mpegurl': return 'hls';
    default: return undefined;
  }
}
function isRecord(value: unknown): value is RecordValue { return typeof value === 'object' && value !== null; }
function retryable(status: number): boolean { return status === 408 || status === 425 || status === 429 || status >= 500; }
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
