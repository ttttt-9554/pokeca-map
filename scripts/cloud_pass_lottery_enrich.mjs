import {readFile, rename, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {extract, supportedUrl, STARBOX_HOST} from '../supabase/functions/lottery-individual-fetch/extract.mjs';

const catalogPath = 'other_lottery_public.json';
const maxPageBytes = 2_000_000;
const retryInterval = 24 * 60 * 60 * 1000;

async function fetchPage(url) {
  const response = await fetch(url, {
    redirect: 'manual',
    headers: {'User-Agent': 'TorecaRadar/1.0', Accept: 'text/html,application/xhtml+xml'},
    signal: AbortSignal.timeout(12_000)
  });
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
  let checked = 0;
  for (const item of items) {
    if (checked >= 4) break;
    const url = item.url;
    if (typeof url !== 'string' || !supportedUrl(url) || new URL(url).hostname !== host ||
        item[verifiedAt] || now - Date.parse(item[checkedAt]) < retryInterval) continue;
    item[checkedAt] = now.toISOString();
    checked += 1;

    let page;
    try {
      page = await load(url);
    } catch {
      continue;
    }
    if (!page) continue;
    const {product_type: productType, ...fields} = extract(page, url);
    if (!fields.event_title || !fields.application_start_at || !fields.application_end_at) continue;
    Object.assign(item, fields, {
      official_event_title: fields.event_title,
      event_title_provisional: false,
      external_url_unverified: false,
      [verifiedAt]: now.toISOString()
    });
    if (productType) item.pokemon_map_type = productType;
  }
  return checked;
}

export function enrichCloudPass(catalog, load = fetchPage, now = new Date()) {
  return enrichSite(catalog.items, 'cloud-pass.jp', 'cloud_pass', load, now);
}

export function enrichStarbox(catalog, load = fetchPage, now = new Date()) {
  const posted = item => Date.parse(item.discord_posted_at || item.first_detected_at || '') || 0;
  const newestFirst = [...catalog.items].sort((a, b) => posted(b) - posted(a));
  return enrichSite(newestFirst, STARBOX_HOST, 'starbox', load, now);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  // Keep the existing collector entry point for the shared Edge parsers.
  const [cloudChecked, starboxChecked] = await Promise.all([enrichCloudPass(catalog), enrichStarbox(catalog)]);
  if (cloudChecked || starboxChecked) {
    const tempPath = catalogPath + '.tmp';
    await writeFile(tempPath, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
    await rename(tempPath, catalogPath);
  }
  console.log('Cloud Pass pages checked:', cloudChecked);
  console.log('Starbox lottery pages checked:', starboxChecked);
}
