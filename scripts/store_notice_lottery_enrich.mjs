import {readFile, writeFile, rename} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {storeNoticeUrl, fetchStoreNotice, loadOfficialHtml, STORE_DIRECTORY} from '../supabase/functions/lottery-individual-fetch/store-notices.mjs';

const hour = 3600000;
const posted = row => Date.parse(row.discord_posted_at || row.first_detected_at || '') || 0;

export async function enrichStoreNotices(catalog, load = loadOfficialHtml, now = new Date()) {
  let checked = 0, updated = 0, directory;
  // Reuse one directory response for this collection pass.
  const cachedLoad = async url => {
    if (url !== STORE_DIRECTORY) return load(url);
    directory ??= load(url);
    return directory;
  };
  const items = [...catalog.items].sort((a,b) => posted(b) - posted(a));
  for (const item of items) {
    if (checked >= 8) break;
    const source = storeNoticeUrl(item.url);
    if (!source || item.manual_card_hidden || item.manual_page_unavailable) continue;
    const end = item.application_end_at || '';
    const deadline = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(end) ? end + 'T23:59:59+09:00' : end);
    if (deadline < +now || (!Number.isFinite(deadline) && posted(item) && +now-posted(item) > 14*24*hour)) continue;
    if (+now - Date.parse(item.store_notice_checked_at) < 6*hour) continue;
    item.store_notice_checked_at = now.toISOString();
    checked++;
    try {
      const fields = await fetchStoreNotice(source.href, cachedLoad);
      if (!fields.event_title || !fields.application_end_at) {
        item.store_notice_last_error = 'no_application_period';
        continue;
      }
      // A temporary directory outage must not erase already verified regions.
      const previous = new Map();
      if (item.store_notice_verified_at) {
        for (const store of item.stores || []) previous.set(store.name, store.prefecture);
      }
      for (const store of fields.stores || []) store.prefecture ||= previous.get(store.name) || '';
      if (fields.stores?.length) fields.prefecture = fields.stores.length === 1 ? fields.stores[0].prefecture : '';
      const {product_type, ...metadata} = fields;
      Object.assign(item, metadata, {official_event_title: fields.event_title, event_title_provisional: false,
        external_url_unverified: false, store_notice_verified_at: now.toISOString(), store_notice_source_url: source.href});
      if (product_type) item.pokemon_map_type = product_type;
      delete item.store_notice_last_error;
      updated++;
    } catch { item.store_notice_last_error = 'page_unavailable'; }
  }
  return {checked, updated};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = 'other_lottery_public.json';
  const catalog = JSON.parse(await readFile(path, 'utf8'));
  const result = await enrichStoreNotices(catalog);
  if (result.checked) {
    await writeFile(path + '.tmp', JSON.stringify(catalog, null, 2) + '\n', 'utf8');
    await rename(path + '.tmp', path);
  }
  console.log('Official store lottery notices:', result);
}
