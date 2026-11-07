import {applicationTime, canonicalExternalLotteryUrl} from './external-lottery-scan.mjs';
import {lotteryDeadlineChannel, postLotteryDeadlineMessage} from './lottery-deadline-channel.mjs';

const LIVEPOCKET_URL = /^https:\/\/livepocket\.jp\/e\/[A-Za-z0-9_-]{4,64}\/?$/;
const titles = {
  morning: '📅 本日が応募締切の抽選',
  one_hour: '⏰ 応募締切まで約1時間',
  both: '⏰ 本日が応募締切・締切まで約1時間'
};
const text = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const MAX_EMBEDS = 10;
const MAX_EMBED_TEXT = 6000;

function applicationDate(value) {
  const time = applicationTime(text(value));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function publishedCards(catalog, origin) {
  if (!Array.isArray(catalog?.items)) return [];
  const result = [];
  for (const item of catalog.items) {
    const eventUrl = item?.url;
    if (typeof eventUrl !== 'string' || item.app_lottery || item.manual_card_hidden) continue;
    let identity;
    try {
      identity = origin === 'livepocket'
        ? (LIVEPOCKET_URL.test(eventUrl) ? eventUrl.replace(/\/$/, '') : '')
        : canonicalExternalLotteryUrl(eventUrl);
    } catch { continue; }
    if (!identity) continue;
    const stores = Array.isArray(item.stores) ? item.stores.slice(0, 100).map(store => ({
      name: text(store?.name), prefecture: text(store?.prefecture)
    })).filter(store => store.name) : [];
    result.push({
      event_url: eventUrl, identity, origin,
      event_title: text(item.event_title_provisional ? item.product_name : item.event_title || item.product_name),
      store_name: stores[0]?.name || text(item.store_name),
      prefecture: stores[0]?.prefecture || text(item.prefecture),
      stores,
      product_name: text(item.product_name),
      application_start_at: applicationDate(item.application_start_at),
      deadline: applicationDate(item.application_end_at),
      unavailable: item.manual_page_unavailable === true,
      famima_verified: Boolean(item.famima_verified_at)
    });
  }
  return result;
}

function embedTextLength(embed) {
  return [
    embed.title, embed.description, embed.footer?.text, embed.author?.name,
    ...(embed.fields ?? []).flatMap(field => [field.name, field.value])
  ].reduce((length, value) => length + (value?.length ?? 0), 0);
}

export function deadlineDiscordMessages(jobs, buildEmbed) {
  const result = [];
  for (const [kind, title] of Object.entries(titles)) {
    let batch = {embeds: [], jobs: []}, length = 0;
    for (const job of jobs.filter(job => job.reminder === kind)) {
      const embed = buildEmbed(job, title);
      const size = embedTextLength(embed);
      if (batch.embeds.length && (batch.embeds.length === MAX_EMBEDS || length + size > MAX_EMBED_TEXT)) {
        result.push(batch);
        batch = {embeds: [], jobs: []};
        length = 0;
      }
      batch.embeds.push(embed);
      batch.jobs.push(job);
      length += size;
    }
    if (batch.embeds.length) result.push(batch);
  }
  return result;
}

async function settle(supabase, jobs, delivered) {
  if (!jobs.length) return;
  const {error} = await supabase.rpc('lottery_settle_deadline_discord_alerts', {
    p_claims: jobs.map(({event_key, claim_no}) => ({event_key, claim_no})),
    p_delivered: delivered
  });
  if (error) throw Error('Lottery deadline settlement failed: ' + error.message);
}

async function messageNonce(jobs) {
  // Discord deduplicates short-term POST retries from the same bot.
  const keys = jobs.map(job => job.event_key).sort().join(',');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(keys));
  return Array.from(new Uint8Array(digest).slice(0, 12), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function scanLotteryDeadlineAlerts(supabase, catalogs, settings, buildEmbed) {
  if (!settings.botToken || !settings.newLotteryWebhook) return {configured: false};
  const [livepocket, external] = await Promise.allSettled([catalogs.livepocket, catalogs.external]);
  const p_catalog = [
    ...publishedCards(livepocket.value, 'livepocket'),
    ...publishedCards(external.value, 'external')
  ];
  const {data, error} = await supabase.rpc('lottery_claim_deadline_discord_embeds', {p_catalog});
  if (error) throw Error('Lottery deadline claim failed: ' + error.message);
  const jobs = data ?? [];
  if (!jobs.length) return {claimed: 0, sent: 0};

  let destination;
  try {
    destination = await lotteryDeadlineChannel(settings);
  } catch (error) {
    await settle(supabase, jobs, false);
    throw error;
  }
  let sent = 0;
  const active = jobs.filter(job => Date.parse(job.deadline) > Date.now());
  const messages = deadlineDiscordMessages(active, buildEmbed);
  for (const [index, batch] of messages.entries()) {
    try {
      await postLotteryDeadlineMessage(destination.channel.id, settings.botToken, {
        embeds: batch.embeds, allowed_mentions: {parse: []},
        nonce: await messageNonce(batch.jobs), enforce_nonce: true
      });
    } catch (error) {
      await settle(supabase, messages.slice(index).flatMap(message => message.jobs), false);
      throw error;
    }
    await settle(supabase, batch.jobs, true);
    sent += batch.jobs.length;
  }
  return {claimed: jobs.length, sent};
}
