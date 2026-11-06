import {applicationTime, canonicalExternalLotteryUrl} from './external-lottery-scan.mjs';
import {lotteryDeadlineChannel, postLotteryDeadlineMessage} from './lottery-deadline-channel.mjs';

const LIVEPOCKET_URL = /^https:\/\/livepocket\.jp\/e\/[A-Za-z0-9_-]{4,64}\/?$/;
const titles = {
  morning: '📅 本日が応募締切の抽選',
  one_hour: '⏰ 応募締切まで約1時間',
  both: '⏰ 本日が応募締切・締切まで約1時間'
};
const formatDeadline = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
const text = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

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
    const deadline = applicationTime(text(item.application_end_at));
    result.push({
      event_url: eventUrl, identity, origin,
      event_title: text(item.event_title_provisional ? item.product_name : item.event_title || item.product_name),
      store_name: text(item.stores?.[0]?.name || item.store_name),
      deadline: Number.isFinite(deadline) ? new Date(deadline).toISOString() : null,
      unavailable: item.manual_page_unavailable === true,
      famima_verified: Boolean(item.famima_verified_at)
    });
  }
  return result;
}

function discordLabel(value, max) {
  return text(value).slice(0, max).replace(/[\\*_~|\[\]()<>#\x60]/g, '\\$&');
}

export function deadlineDiscordMessages(jobs, appUrl) {
  const result = [];
  for (const [kind, title] of Object.entries(titles)) {
    const header = '**' + title + '**（日本時間）\n';
    let content = header, batch = [];
    for (const job of jobs.filter(job => job.reminder === kind)) {
      const name = discordLabel(job.event_title, 125) || '抽選カード';
      const store = discordLabel(job.store_name, 64);
      const url = /^https?:\/\/[^\s<>"]{4,650}$/i.test(job.event_url) ? job.event_url : appUrl;
      const link = url.replace(/\(/g, '%28').replace(/\)/g, '%29');
      const line = '- [' + name + '](' + link + ')' +
        (store ? '（' + store + '）' : '') + '  ·  ' +
        formatDeadline.format(new Date(job.deadline)) + ' 締切\n';
      if (content.length + line.length > 1900 && batch.length) {
        result.push({content, jobs: batch});
        content = header;
        batch = [];
      }
      content += line;
      batch.push(job);
    }
    if (batch.length) result.push({content, jobs: batch});
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

export async function scanLotteryDeadlineAlerts(supabase, catalogs, settings, appUrl) {
  if (!settings.botToken || !settings.newLotteryWebhook) return {configured: false};
  const [livepocket, external] = await Promise.allSettled([catalogs.livepocket, catalogs.external]);
  const p_catalog = [
    ...publishedCards(livepocket.value, 'livepocket'),
    ...publishedCards(external.value, 'external')
  ];
  const {data, error} = await supabase.rpc('lottery_claim_deadline_discord_alerts', {p_catalog});
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
  const messages = deadlineDiscordMessages(active, appUrl);
  for (const [index, batch] of messages.entries()) {
    try {
      await postLotteryDeadlineMessage(destination.channel.id, settings.botToken, {
        content: batch.content, allowed_mentions: {parse: []}, flags: 4,
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
