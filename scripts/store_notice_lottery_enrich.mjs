import {SEVENNET_HOST} from '../supabase/functions/lottery-individual-fetch/sevennet-fair.mjs';
import {readFile, writeFile, rename} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {storeNoticeUrl, fetchStoreNotice, loadOfficialHtml, STORE_DIRECTORY} from '../supabase/functions/lottery-individual-fetch/store-notices.mjs';
import {CENTER_HOST, CENTER_DIRECTORY, pokemonCenterDirectory, pokemonCenterNoticeUrl, centerNewsLinks} from '../supabase/functions/lottery-individual-fetch/pokemon-center.mjs';

const hour = 3600000;
const posted = row => Date.parse(row.discord_posted_at || row.first_detected_at || '') || 0;

function deadlineOf(value = '') {
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? value + 'T23:59:59.999+09:00' : value);
}

export async function enrichStoreNotices(catalog, load = loadOfficialHtml, now = new Date(), candidates = [], limit = 8) {
  let checked = 0, updated = 0;
  const directories = new Map();
  const cachedLoad = url => {
    if (url !== STORE_DIRECTORY && url !== CENTER_DIRECTORY) return load(url);
    if (!directories.has(url)) directories.set(url, load(url));
    return directories.get(url);
  };
  const items = [...catalog.items].sort((a,b) => posted(b) - posted(a));
  const known = new Set(items.map(item => storeNoticeUrl(item.url)?.href));
  const pending = new Set();
  for (const url of new Set(candidates)) {
    if (known.has(url)) continue;
    const item = {url, source_site: CENTER_HOST, first_detected_at: now.toISOString()};
    items.push(item);
    pending.add(item);
  }
  for (const item of items) {
    if (checked >= limit) break;
    const source = storeNoticeUrl(item.url);
    if (!source || item.manual_card_hidden || item.manual_page_unavailable) continue;
    const deadline = deadlineOf(item.application_end_at);
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
      if (pending.has(item) && deadlineOf(fields.application_end_at) < +now) continue;
      // A successful reread replaces details supplied by this article, including a
      // removed LINE link or a change from a fixed time to staggered notification.
      if ([CENTER_HOST, SEVENNET_HOST].includes(source.hostname)) {
        for (const key of ['application_url','delivery_start_date','store_notice_purchase_note','store_notice_result_note',
          'result_announcement_date','result_announcement_time','purchase_start_date','purchase_end_date',
          'purchase_start_time','purchase_end_time','product_name','pokemon_map_type']) delete item[key];
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
      if (pending.has(item)) catalog.items.push(item);
      updated++;
    } catch { item.store_notice_last_error = 'page_unavailable'; }
  }
  const deferred = [...pending].filter(item => !item.store_notice_checked_at).map(item => item.url);
  return deferred.length ? {checked, updated, deferred} : {checked, updated};
}

// Rotate through the domestic store indexes. Only verified, current lotteries enter
// the catalog; the existing Discord rows keep their original URL and first-seen date.
export async function collectStoreNotices(catalog, load = loadOfficialHtml, now = new Date()) {
  const prior = catalog.pokemon_center_news_scan || {};
  let directory, scanned = 0;
  const cachedLoad = url => url === CENTER_DIRECTORY ? (directory ??= load(url)) : load(url);
  const initial = !Object.keys(prior.branches || {}).length;
  const urls = new Set((prior.pending || []).filter(url => pokemonCenterNoticeUrl(url)?.href === url));
  if (!(Date.parse(prior.next_at) > +now)) {
    const byBranch = {...prior.branches};
    let next = +now + 5 * 60000;
    try {
      const branches = [...pokemonCenterDirectory(await cachedLoad(CENTER_DIRECTORY)).keys()];
      const last = branch => Date.parse(byBranch[branch] || '') || 0;
      const due = branches.filter(branch => +now - last(branch) >= hour).sort((a,b) => last(a)-last(b));
      // Establish a baseline once. Later runs visit four due stores at a time.
      const batch = due.slice(0, initial ? 32 : 4);
      for (let i = 0; i < batch.length; i += 3) {
        const group = batch.slice(i, i + 3);
        const results = await Promise.allSettled(group.map(async branch =>
          centerNewsLinks(await load(branch + 'news/'), branch, now)));
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') for (const url of result.value) urls.add(url);
          byBranch[group[index]] = now.toISOString();
          scanned++;
        });
      }
      if (branches.length && batch.length === due.length) next = Math.min(...branches.map(branch => last(branch) + hour));
    } catch { /* The next scheduled run retries the directory. */ }
    catalog.pokemon_center_news_scan = {next_at: new Date(next).toISOString(), branches: byBranch};
  }
  const previous = catalog.items.length;
  const {deferred = [], ...stats} = await enrichStoreNotices(catalog, cachedLoad, now, [...urls], initial ? 24 : 8);
  if (deferred.length || prior.pending?.length) {
    catalog.pokemon_center_news_scan = {...catalog.pokemon_center_news_scan, pending: deferred};
  }
  return {...stats, scanned, added: catalog.items.length - previous};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = 'other_lottery_public.json';
  const catalog = JSON.parse(await readFile(path, 'utf8'));
  const beforeScan = catalog.pokemon_center_news_scan;
  const result = await collectStoreNotices(catalog);
  if (result.checked || catalog.pokemon_center_news_scan !== beforeScan) {
    await writeFile(path + '.tmp', JSON.stringify(catalog, null, 2) + '\n', 'utf8');
    await rename(path + '.tmp', path);
  }
  console.log('Official store lottery notices:', result);
}
