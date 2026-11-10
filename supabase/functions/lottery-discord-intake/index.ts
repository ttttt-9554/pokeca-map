import {recentLotteryLinks} from './links.mjs';

// This is the channel already read by the main collector. A deployment can
// supply the same channel list as Actions through DISCORD_CHANNEL_IDS.
const defaultChannel = '1551580466266644552';
const table = 'lottery_discord_intake_v1';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'},
  });
}

async function readMessages(channel: string, bot: string) {
  const response = await fetch(`https://discord.com/api/v10/channels/${channel}/messages?limit=100`, {
    headers: {Authorization: `Bot ${bot}`},
    redirect: 'error', signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) throw new Error('Discord HTTP ' + response.status);
  const messages = await response.json();
  if (!Array.isArray(messages)) throw new Error('Invalid Discord response');
  return messages;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({error: 'Method not allowed'}, 405);
  const secret = Deno.env.get('NOTIFY_SECRET');
  if (!secret || req.headers.get('x-notify-secret') !== secret) {
    return json({error: 'Unauthorized'}, 401);
  }
  const bot = Deno.env.get('DISCORD_BOT_TOKEN');
  const base = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const channels = [...new Set((Deno.env.get('DISCORD_CHANNEL_IDS') ||
    Deno.env.get('DISCORD_CHANNEL_ID') || defaultChannel).match(/\b\d{15,22}\b/g) || [])];
  if (!bot || !base || !key || !channels.length || channels.length > 10) {
    return json({error: 'Collector configuration unavailable'}, 503);
  }

  const results = await Promise.allSettled(channels.map(channel => readMessages(channel, bot)));
  const messages = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  const failed = results.filter(result => result.status === 'rejected');
  if (failed.length === channels.length) {
    const status = String(failed[0].reason?.message || '').match(/^Discord HTTP (\d{3})$/)?.[1];
    return json({error: 'Discord collection failed', discord_status: status || null}, 503);
  }
  const links = recentLotteryLinks(messages);
  if (links.length) {
    try {
      const saved = await fetch(`${base}/rest/v1/${table}?on_conflict=url`, {
        method: 'POST',
        headers: {apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
          Prefer: 'resolution=ignore-duplicates,return=minimal'},
        body: JSON.stringify(links), redirect: 'error', signal: AbortSignal.timeout(5000),
      });
      if (!saved.ok) return json({error: 'URL save failed', database_status: saved.status}, 502);
    } catch {
      return json({error: 'URL save unavailable'}, 502);
    }
  }
  return json({channels: channels.length, failed: failed.length, scanned: messages.length, links: links.length});
});
