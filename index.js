// VixSrc Stremio addon for Vercel
// Needs one environment variable: TMDB_KEY (free TMDB v3 API key)

const VIX = 'https://vixsrc.to';

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Referer': VIX + '/',
};

const MANIFEST = {
  id: 'community.vixsrc.personal',
  version: '1.0.0',
  name: 'VixSrc Personal',
  description: 'Direct VixSrc streams, English audio set as default.',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
};

function send(res, status, body, type = 'application/json', cache = 'max-age=60') {
  res.statusCode = status;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', cache);
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

module.exports = async (req, res) => {
  const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
  const parsed = new URL(req.url, origin);
  const q = parsed.searchParams;
  const pathname = q.get('p') ? '/' + q.get('p') : parsed.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (pathname === '/manifest.json') return send(res, 200, MANIFEST);

  // Stremio asks for streams here: /stream/movie/tt0111161.json
  const sm = pathname.match(/^\/stream\/(movie|series)\/(.+)\.json$/);
  if (sm) {
    try {
      return send(res, 200, await handleStream(sm[1], decodeURIComponent(sm[2]), origin));
    } catch (e) {
      return send(res, 200, { streams: [] });
    }
  }

  // Debug page for your browser: /debug/movie/tt0111161 or /debug/series/tt0944947:1:1
  const dm = pathname.match(/^\/debug\/(movie|series)\/(.+)$/);
  if (dm) {
    try {
      const out = await handleStream(dm[1], decodeURIComponent(dm[2]), origin);
      return send(res, 200, JSON.stringify(out, null, 2), 'text/plain; charset=utf-8', 'no-store');
    } catch (e) {
      return send(
        res,
        500,
        'ERROR: ' + (e && e.message ? e.message : String(e)),
        'text/plain; charset=utf-8',
        'no-store'
      );
    }
  }

  // Playlist with English audio set as default
  if (pathname === '/play.m3u8') return handlePlay(q.get('u'), res);

  return send(
    res,
    200,
    'VixSrc addon is running. Install via /manifest.json',
    'text/plain; charset=utf-8'
  );
};

async function handleStream(type, rawId, origin) {
  const key = process.env.TMDB_KEY;
  if (!key) throw new Error('TMDB_KEY environment variable is missing');

  const [imdbId, season, episode] = rawId.split(':');
  const kind = type === 'movie' ? 'movie' : 'tv';
  if (kind === 'tv' && !(season && episode)) throw new Error('Missing season/episode');

  const tmdbId = await toTmdbId(kind, imdbId, key);
  const direct = await getPlaylistUrl(kind, tmdbId, season, episode);

  return {
    streams: [
      {
        name: 'VixSrc',
        title: 'English default\nHLS via addon',
        url: `${origin}/play.m3u8?u=${encodeURIComponent(direct)}`,
      },
      {
        name: 'VixSrc',
        title: 'Direct (Italian default)\nHLS',
        url: direct,
      },
    ],
  };
}

async function toTmdbId(kind, imdbId, key) {
  const r = await fetch(
    `https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id&api_key=${key}`
  );
  if (!r.ok) throw new Error('TMDB lookup failed: ' + r.status);
  const j = await r.json();
  const hit = kind === 'movie' ? j.movie_results?.[0] : j.tv_results?.[0];
  if (!hit) throw new Error('TMDB has no match for ' + imdbId);
  return hit.id;
}

async function getPlaylistUrl(kind, tmdbId, season, episode) {
  const apiPath =
    kind === 'movie' ? `/api/movie/${tmdbId}` : `/api/tv/${tmdbId}/${season}/${episode}`;

  const api = await fetch(VIX + apiPath, { headers: HEADERS });
  if (!api.ok) throw new Error('VixSrc API ' + api.status + ' for ' + apiPath);
  const data = await api.json();
  if (!data.src) throw new Error('VixSrc API returned no src');

  const page = await fetch(new URL(data.src, VIX).href, { headers: HEADERS });
  if (!page.ok) throw new Error('VixSrc embed page ' + page.status);
  const html = await page.text();

  const token = html.match(/'token':\s*'([^']+)'/)?.[1];
  const expires = html.match(/'expires':\s*'([^']+)'/)?.[1];
  const base = html.match(/url:\s*'(https?:[^']+)'/)?.[1];
  if (!token || !expires || !base) {
    throw new Error('Could not find token/expires/url in embed page');
  }

  const playlist = new URL(base);
  playlist.searchParams.set('token', token);
  playlist.searchParams.set('expires', expires);
  playlist.searchParams.set('h', '1');
  return playlist.href;
}

async function handlePlay(raw, res) {
  if (!raw) return send(res, 400, 'missing u', 'text/plain');

  let target;
  try {
    target = new URL(raw);
  } catch (e) {
    return send(res, 400, 'bad url', 'text/plain');
  }

  // Only proxy VixSrc, never turn this into an open proxy
  if (!/(^|\.)vixsrc\.to$/.test(target.hostname)) {
    return send(res, 403, 'forbidden', 'text/plain');
  }

  const r = await fetch(target.href, { headers: HEADERS });
  if (!r.ok) return send(res, 502, 'upstream ' + r.status, 'text/plain');

  const text = await r.text();
  return send(res, 200, preferEnglish(text, target.href), 'application/vnd.apple.mpegurl', 'no-store');
}

// Makes English the default audio track and turns relative links into absolute ones
function preferEnglish(text, base) {
  const lines = text.split(/\r?\n/);
  const isAudio = (l) => l.startsWith('#EXT-X-MEDIA:TYPE=AUDIO');
  const isEng = (l) => /LANGUAGE="eng?"/i.test(l);
  const hasEnglish = lines.some((l) => isAudio(l) && isEng(l));

  return lines
    .map((line) => {
      if (!line) return line;

      if (line.startsWith('#')) {
        let out = line;
        if (hasEnglish && isAudio(out)) {
          const eng = isEng(out);
          out = out
            .replace(/DEFAULT=(YES|NO)/, `DEFAULT=${eng ? 'YES' : 'NO'}`)
            .replace(/AUTOSELECT=(YES|NO)/, `AUTOSELECT=${eng ? 'YES' : 'NO'}`);
        }
        return out.replace(/URI="([^"]+)"/, (_, u) => `URI="${new URL(u, base).href}"`);
      }

      return new URL(line, base).href;
    })
    .join('\n');
}
