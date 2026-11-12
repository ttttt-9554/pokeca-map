import {readFile, rename, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {
  extract, lotteryPageRequest, supportedUrl, STARBOX_HOST, GEO_HOST, RAKUTEN_BOOKS_HOST
} from '../supabase/functions/lottery-individual-fetch/extract.mjs';

const catalogPath = 'other_lottery_public.json';
const maxPageBytes = 2_000_000;
const retryInterval = 24 * 60 * 60 * 1000;

async function fetchPage(url) {
  const {url: source, headers} = lotteryPageRequest(url);
  const response = await fetch(source, {
    redirect: 'manual',
    headers,
    signal: AbortSignal.timeout(12_000)
  });
  if ([GEO_HOST, RAKUTEN_BOOKS_HOST].includes(source.hostname) && [403, 429].includes(response.status)) {
    await response.body?.cancel();
    const error = new Error(source.hostname + ' lottery page denied access');
    error.status = response.status;
    throw error;
  }
  if (!response.ok || !/text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type') || '') ||
      Number(response.headers.get('content-length') || 0) > maxPageBytes || !response.body) {
    await response.body?.cancel();
    return '';
  }
  const decoder = new TextDecoder();
  let html = '';
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxPageBytes) return '';
    html += decoder.decode(chunk, {stream: true});
  }
  return html + decoder.decode();
}

async function enrichSite(items, host, source, load, now) {
  const checkedAt = source + '_checked_at';
  const verifiedAt = source + '_verified_at';
  const lastError = source + '_last_error';
  const rakutenBooks = host === RAKUTEN_BOOKS_HOST;
  const checkLimit = rakutenBooks ? 12 : 4;
  const retryAfter = rakutenBooks ? 60 * 60 * 1000 : retryInterval;
  let checked = 0;
  for (const item of items) {
    if (checked >= checkLimit) break;
    const url = item.url;
    if (typeof url !== 'string' || !supportedUrl(url) || new URL(url).hostname !== host ||
        item[verifiedAt] || now - Date.parse(item[checkedAt]) < retryAfter) continue;
    item[checkedAt] = now.toISOString();
    checked += 1;

    let page;
    try {
      page = await load(url);
    } catch (error) {
      if ((host === GEO_HOST || rakutenBooks) && [403, 429].includes(error?.status)) {
        item[lastError] = 'source_access_denied';
        break;
      }
      continue;
    }
    if (!page) continue;
    const {product_type: productType, ...fields} = extract(page, url);
    if (!fields.event_title || !fields.application_start_at || !fields.application_end_at) continue;
    // Rakuten Books reuses the product URL between lottery rounds.
    if (rakutenBooks && Date.parse(fields.application_end_at) <= Date.parse(item.discord_posted_at)) continue;
    Object.assign(item, fields, {
      official_event_title: fields.event_title,
      event_title_provisional: false,
      external_url_unverified: false,
      [verifiedAt]: now.toISOString()
    });
    if (host === GEO_HOST || rakutenBooks) delete item[lastError];
    if (productType) item.pokemon_map_type = productType;
  }
  return checked;
}

export function enrichCloudPass(catalog, load = fetchPage, now = new Date()) {
  return enrichSite(catalog.items, 'cloud-pass.jp', 'cloud_pass', load, now);
}

function newestFirst(items) {
  const posted = item => Date.parse(item.discord_posted_at || item.first_detected_at || '') || 0;
  return [...items].sort((a, b) => posted(b) - posted(a));
}

export function enrichStarbox(catalog, load = fetchPage, now = new Date()) {
  return enrichSite(newestFirst(catalog.items), STARBOX_HOST, 'starbox', load, now);
}

export function enrichGeo(catalog, load = fetchPage, now = new Date()) {
  if (catalog.items.some(item => item.geo_last_error === 'source_access_denied' &&
      now - Date.parse(item.geo_checked_at) < retryInterval)) return 0;
  return enrichSite(newestFirst(catalog.items), GEO_HOST, 'geo', load, now);
}

export function enrichRakutenBooks(catalog, load = fetchPage, now = new Date()) {
  if (catalog.items.some(item => item.rakuten_books_last_error === 'source_access_denied' &&
      now - Date.parse(item.rakuten_books_checked_at) < retryInterval)) return 0;
  return enrichSite(newestFirst(catalog.items), RAKUTEN_BOOKS_HOST, 'rakuten_books', load, now);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  // Keep the existing collector entry point for the shared Edge parsers.
  const [cloudChecked, starboxChecked, geoChecked, rakutenChecked] = await Promise.all([
    enrichCloudPass(catalog), enrichStarbox(catalog), enrichGeo(catalog), enrichRakutenBooks(catalog)
  ]);
  if (cloudChecked || starboxChecked || geoChecked || rakutenChecked) {
    const tempPath = catalogPath + '.tmp';
    await writeFile(tempPath, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
    await rename(tempPath, catalogPath);
  }
  console.log('Cloud Pass pages checked:', cloudChecked);
  console.log('Starbox lottery pages checked:', starboxChecked);
  console.log('GEO lottery pages checked:', geoChecked);
  console.log('Rakuten Books lottery pages checked:', rakutenChecked);
}
