import {readFile, rename, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {extract, supportedUrl} from '../supabase/functions/lottery-individual-fetch/extract.mjs';

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

export async function enrichCloudPass(catalog, load = fetchPage, now = new Date()) {
  let checked = 0;
  for (const item of catalog.items) {
    if (checked >= 4) break;
    const url = item.url;
    if (typeof url !== 'string' || !supportedUrl(url) || new URL(url).hostname !== 'cloud-pass.jp' ||
        item.cloud_pass_verified_at || now - Date.parse(item.cloud_pass_checked_at) < retryInterval) continue;
    item.cloud_pass_checked_at = now.toISOString();
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
      cloud_pass_verified_at: now.toISOString()
    });
    if (productType) item.pokemon_map_type = productType;
  }
  return checked;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const checked = await enrichCloudPass(catalog);
  if (checked) {
    const tempPath = catalogPath + '.tmp';
    await writeFile(tempPath, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
    await rename(tempPath, catalogPath);
  }
  console.log('Cloud Pass pages checked:', checked);
}
