export const RECENT_MS = 2 * 60 * 60 * 1000;

const linkPattern = /https?:\/\/[^\s<>"'\u3000]+/gi;
const excludedHosts = [
  'x.com', 'twitter.com', 't.co', 'fxtwitter.com', 'vxtwitter.com', 'fixupx.com',
  'ttttt-9554.github.io', 'discord.com', 'discordapp.com', 'discordapp.net', 'discord.gg',
];

function lotteryLink(raw) {
  const value = raw.replace(/[.,;:!?)）】\]}>。]+$/u, '');
  if (value.length < 12 || new TextEncoder().encode(value).length > 2000 ||
      /[\\\s\u0000-\u001f]/.test(value)) return '';
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/\.$/, '');
    if (url.username || url.password || !['', '80', '443'].includes(url.port) ||
        !/^([a-z0-9-]+\.)+[a-z0-9-]+$/.test(host) || !/[a-z]$/.test(host) ||
        /\.(local|localhost|internal)$/.test(host) ||
        excludedHosts.some(blocked => host === blocked || host.endsWith('.' + blocked))) return '';
    if (host === 'livepocket.jp' || host === 'www.livepocket.jp') {
      const event = url.pathname.match(/^\/e\/([a-zA-Z0-9_-]{4,64})\/?$/);
      return event ? 'https://livepocket.jp/e/' + event[1] : '';
    }
    return value;
  } catch {
    return '';
  }
}

export function recentLotteryLinks(messages, now = Date.now()) {
  const links = new Map();
  for (const message of messages) {
    const posted = Date.parse(message?.timestamp);
    if (!Number.isFinite(posted) || posted < now - RECENT_MS || posted > now + 60000) continue;
    const blocks = [message.content];
    for (const embed of message.embeds || []) {
      if (!embed) continue;
      blocks.push(embed.url, embed.description);
      for (const field of embed.fields || []) blocks.push(field?.value);
    }
    for (const block of blocks) {
      if (typeof block !== 'string') continue;
      for (const raw of block.match(linkPattern) || []) {
        const url = lotteryLink(raw);
        if (url && (!links.has(url) || posted < links.get(url))) links.set(url, posted);
      }
    }
  }
  return [...links].sort((a, b) => b[1] - a[1]).slice(0, 200)
    .map(([url, posted]) => ({url, discord_posted_at: new Date(posted).toISOString()}));
}
