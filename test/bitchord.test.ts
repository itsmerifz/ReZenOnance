import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { BITCHORD_AUTH_AUDIENCE, BITCHORD_AUTH_ISSUER } from '../src/bitchord-addon-auth.mjs';
import { AddonDatabase } from '../src/db.js';
import { publicId } from '../src/normalize.js';

process.env.QOBUZ_PROVIDER = 'http';
process.env.QOBUZ_API_BASE_URL = 'https://catalogue.example';
process.env.QOBUZ_SEARCH_PATH = '/search';
process.env.QOBUZ_STREAM_PATH = '/stream/{id}';
process.env.QOBUZ_ID_SECRET = 'track-id-secret-for-this-test';
process.env.BITCHORD_AUTH_HOSTS = 'addon.example';
process.env.BITCHORD_MEDIA_SECRET = 'media-signing-secret-for-this-test';
process.env.APP_BASE_URL = 'https://addon.example';
process.env.DEEZER_BASE_URL = 'https://catalogue.example/alt';
process.env.DISABLE_SUPABASE = 'true';
process.env.NODE_ENV = 'test';

const catalogueId = 'catalogue:release/opaque-id-with-colon-and-query?value=' + 'example'.repeat(8);
const trackId = publicId({ upstreamId: catalogueId, title: 'Fixture Song' }, process.env.QOBUZ_ID_SECRET);
const streamPath = '/stream/' + trackId;
const requests: { url: URL; method: string; headers: Headers }[] = [];
const issuer = generateKeyPairSync('ed25519');
const device = generateKeyPairSync('ec', { namedCurve: 'P-256' });

mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
  const url = new URL(input);
  const method = init?.method ?? 'GET';
  const headers = new Headers(init?.headers);
  requests.push({ url, method, headers });
  if (url.href === BITCHORD_AUTH_ISSUER + '/.well-known/jwks.json') {
    return Response.json({ keys: [{ ...issuer.publicKey.export({ format: 'jwk' }), kid: 'fixture' }] });
  }
  if (url.pathname === '/search') {
    const tracks = url.searchParams.get('q') === 'Fixture' ? [{
      upstreamId: catalogueId, title: 'Fixture Song', artist: 'Fixture Artist', album: 'Fixture Album', duration: 123.5,
      artworkURL: 'https://media.example/fixture.jpg',
    }] : [];
    return Response.json({ tracks });
  }
  if (url.pathname === '/alt/search') {
    return Response.json({ tracks: [{
      id: catalogueId, title: 'Fixture Atmos', albumArtworkURL: 'https://media.example/fixture.jpg',
      audioModes: ['DOLBY_ATMOS'], atmos: true,
    }] });
  }
  if (url.pathname === '/alt/stream/' + encodeURIComponent(catalogueId)) {
    return Response.json({
      url: 'https://media.example/manifest', format: 'dash', codec: 'EAC3-JOC', container: 'mp4',
      audioMode: 'DOLBY_ATMOS', encrypted: false,
    });
  }
  if (url.pathname === '/stream/' + encodeURIComponent(catalogueId)) {
    const lossy = url.searchParams.get('quality') !== 'LOSSLESS';
    return Response.json(lossy
      ? { url: 'https://media.example/play-mp3', format: 'mp3' }
      : { url: 'https://media.example/play-flac', format: 'FLAC', sampleRate: 96000, bitDepth: 24 });
  }
  if (url.hostname === 'media.example' && url.pathname === '/play-flac') {
    const mediaHeaders = { 'content-type': 'audio/flac', 'accept-ranges': 'bytes' };
    if (method === 'HEAD') return new Response(null, { headers: { ...mediaHeaders, 'content-length': '8' } });
    if (headers.get('range') === 'bytes=0-3') {
      return new Response('fLaC', {
        status: 206, headers: { ...mediaHeaders, 'content-length': '4', 'content-range': 'bytes 0-3/8' },
      });
    }
  }
  return new Response(null, { status: 404 });
});

const { app } = await import('../src/server.js');

test('BitChord search and stream work on a personal URL with an opaque track ID', async () => {
  const base = '/u/fixture';
  const search = await app.inject(base + '/search?q=Fixture&quality=lossless');
  assert.equal(search.statusCode, 200);
  assert.equal(search.headers['cache-control'], 'no-store');
  assert.equal(requests.at(-1)?.url.searchParams.has('atmos'), false);
  assert.deepEqual(search.json().tracks, [{
    id: trackId, title: 'Fixture Song', artist: 'Fixture Artist', album: 'Fixture Album', duration: 123.5,
    artworkURL: 'https://media.example/fixture.jpg',
  }]);
  assert.ok(trackId.length > 100);

  const stream = await app.inject(base + streamPath + '?quality=high&atmos=auto');
  assert.equal(stream.statusCode, 200);
  assert.deepEqual(stream.json(), {
    url: 'https://media.example/play-mp3', format: 'mp3', codec: 'mp3', container: 'mp3',
    manifest: 'none', encrypted: false,
  });
  assert.equal(requests.at(-1)?.url.searchParams.get('atmos'), 'auto');

  const redirect = await app.inject(base + streamPath + '?quality=lossless&audio=1');
  assert.equal(redirect.statusCode, 302);
  assert.equal(redirect.headers.location, base + streamPath + '/audio?quality=LOSSLESS');

  const missing = publicId({ upstreamId: 'missing', title: 'Missing' }, process.env.QOBUZ_ID_SECRET);
  assert.equal((await app.inject(base + '/stream/' + missing)).statusCode, 404);
});

test('a remote source preserves artwork, Dolby markers, and explicit manifest transport', async () => {
  const search = await app.inject('/d/search?q=Fixture&quality=lossless&atmos=auto');
  assert.equal(search.statusCode, 200);
  const [track] = search.json().tracks;
  assert.equal(track.artworkURL, 'https://media.example/fixture.jpg');
  assert.deepEqual(track.audioModes, ['DOLBY_ATMOS']);
  assert.equal(track.atmos, true);

  const stream = await app.inject('/d/stream/' + track.id + '?quality=lossless&atmos=auto');
  assert.equal(stream.statusCode, 200);
  assert.deepEqual(stream.json(), {
    url: 'https://media.example/manifest', format: 'dash', codec: 'eac3-joc', container: 'mp4',
    manifest: 'dash', encrypted: false, audioMode: 'DOLBY_ATMOS',
  });
});

test('a personal quota response tells BitChord when to retry', async (t) => {
  t.mock.method(AddonDatabase.prototype, 'recordStreamAccess', async () => ({
    allowed: false, retryAfterSeconds: 45, reason: 'Test quota',
  }));
  const denied = await app.inject('/u/fixture' + streamPath);
  assert.equal(denied.statusCode, 429);
  assert.equal(denied.headers['retry-after'], '45');
});

test('protected BitChord routes publish a manifest and require verification for JSON', async () => {
  for (const base of ['/bitchord', '/bitchord/u/fixture']) {
    const manifest = await app.inject(base + '/manifest.json');
    assert.equal(manifest.statusCode, 200);
    assert.equal(manifest.json().bitchordAuth, true);
    assert.equal(manifest.json().allowDownloads, 0);
    for (const path of ['/search?q=Fixture', streamPath]) {
      const denied = await app.inject(base + path);
      assert.equal(denied.statusCode, 401);
      assert.equal(denied.headers['cache-control'], 'no-store');
      assert.match(denied.headers['www-authenticate'] ?? '', /^BitChord .+error="missing"/);
    }
  }
  const unauthorized = await app.inject({ url: '/bitchord/search?q=Fixture', headers: {
    'x-bitchord-token': 'x.y.z', 'x-bitchord-proof': 'v1.0.x',
  } });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.json().code, 'invalid_token');
  assert.equal((await app.inject('/manifest.json')).json().bitchordAuth, undefined);
});

test('authenticated playback produces expiring audio URLs with range and HEAD support', async (t) => {
  const base = '/bitchord/u/fixture';
  const headers = credentials();
  const search = await app.inject({ url: base + '/search?q=Fixture', headers });
  assert.equal(search.statusCode, 200);
  assert.equal(search.json().tracks[0].id, trackId);

  const stream = await app.inject({ url: base + streamPath + '?quality=LOSSLESS', headers });
  assert.equal(stream.statusCode, 200);
  const descriptor = stream.json();
  assert.equal(descriptor.codec, 'flac');
  assert.equal(descriptor.sampleRate, 96000);
  assert.equal(descriptor.bitDepth, 24);
  const media = new URL(descriptor.url);
  assert.equal(media.origin, 'https://addon.example');
  assert.equal(media.pathname, base + streamPath + '/audio');
  const expiresAt = Number(media.searchParams.get('exp'));
  assert.ok(expiresAt - Date.now() / 1000 > 29 * 60);
  assert.ok(expiresAt - Date.now() / 1000 <= 30 * 60);
  const path = media.pathname + media.search;

  const head = await app.inject({ method: 'HEAD', url: path });
  assert.equal(head.statusCode, 200);
  assert.equal(head.headers['content-length'], '8');
  assert.equal(head.body, '');

  const part = await app.inject({ url: path, headers: { range: 'bytes=0-3' } });
  assert.equal(part.statusCode, 206);
  assert.equal(part.headers['content-range'], 'bytes 0-3/8');
  assert.equal(part.headers['content-type'], 'audio/flac');
  assert.equal(part.body, 'fLaC');
  assert.equal(requests.at(-1)?.headers.has('x-bitchord-token'), false);

  const untrustedPath = path.replace('/u/fixture/', '/u/other/');
  assert.equal((await app.inject(untrustedPath)).statusCode, 403);
  media.searchParams.set('quality', 'HIGH');
  assert.equal((await app.inject(media.pathname + media.search)).statusCode, 403);

  t.mock.method(Date, 'now', () => (expiresAt + 1) * 1000);
  assert.equal((await app.inject(path)).statusCode, 403);
});

test.after(async () => {
  await app.close();
  mock.restoreAll();
});

function credentials() {
  const now = Date.now();
  const encodedHeader = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'fixture' })).toString('base64url');
  const claims = {
    iss: BITCHORD_AUTH_ISSUER,
    aud: BITCHORD_AUTH_AUDIENCE,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 3600,
    cnf: { jwk: device.publicKey.export({ format: 'jwk' }) },
  };
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const payload = encodedHeader + '.' + encodedClaims;
  const token = payload + '.' + sign(null, Buffer.from(payload), issuer.privateKey).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('base64url');
  const message = ['bitchord-addon-proof/v1', 'addon.example', now, tokenHash].join('\n');
  const proof = sign('sha256', Buffer.from(message), { key: device.privateKey, dsaEncoding: 'ieee-p1363' });
  return { 'x-bitchord-token': token, 'x-bitchord-proof': 'v1.' + now + '.' + proof.toString('base64url') };
}
