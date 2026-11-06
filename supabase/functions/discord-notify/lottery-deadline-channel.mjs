const DISCORD_API = 'https://discord.com/api/v10';
const CHANNEL_NAME = '抽選締切アラート';
const isDiscordId = id => typeof id === 'string' && /^\d{17,20}$/.test(id);

async function discordRequest(url, label, botToken, init = {}) {
  const headers = new Headers(init.headers);
  if (botToken) headers.set('Authorization', 'Bot ' + botToken);
  if (init.body) headers.set('Content-Type', 'application/json');
  let response;
  try {
    response = await fetch(url, {
      ...init, headers, redirect: 'error', signal: AbortSignal.timeout(7000)
    });
  } catch {
    throw Error(label + ' could not reach Discord');
  }
  if (!response.ok) throw Error(label + ': Discord HTTP ' + response.status);
  return response;
}

async function discordData(path, label, botToken, init) {
  return (await discordRequest(DISCORD_API + path, label, botToken, init)).json();
}

export async function lotteryDeadlineChannel(settings, allowCreate = false) {
  const {botToken, newLotteryWebhook} = settings;
  if (!botToken || !newLotteryWebhook) throw Error('Lottery deadline channel credentials are missing');
  let sourceUrl;
  try { sourceUrl = new URL(newLotteryWebhook); } catch { throw Error('Invalid new lottery webhook'); }
  if (sourceUrl.origin !== 'https://discord.com' && sourceUrl.origin !== 'https://discordapp.com')
    throw Error('Invalid new lottery webhook host');
  if (sourceUrl.username || sourceUrl.password ||
      !/^\/api\/(?:v\d+\/)?webhooks\/\d{17,20}\/[a-z0-9_-]+$/i.test(sourceUrl.pathname))
    throw Error('Invalid new lottery webhook path');
  const source = await (await discordRequest(sourceUrl.origin + sourceUrl.pathname, 'New lottery channel lookup')).json();
  const guildId = source.guild_id;
  if (!isDiscordId(guildId) || !isDiscordId(source.channel_id))
    throw Error('New lottery channel could not be identified');
  const channels = await discordData('/guilds/' + guildId + '/channels', 'Lottery channels lookup', botToken);
  const original = channels.find(channel => channel.id === source.channel_id);
  if (!original) throw Error('New lottery channel is unavailable to the bot');
  const matches = channels.filter(channel => channel.name === CHANNEL_NAME);
  if (matches.length) {
    const channel = matches[0];
    if (matches.length !== 1 || channel.type !== 0 || channel.id === source.channel_id || !isDiscordId(channel.id))
      throw Error('Lottery deadline channel name is ambiguous');
    return {guildId, channel, created: false};
  }
  if (!allowCreate) throw Error('Lottery deadline channel is missing');

  // Keep the same category and audience as the existing alert channel.
  const channel = await discordData('/guilds/' + guildId + '/channels', 'Lottery deadline channel creation', botToken, {
    method: 'POST',
    headers: {'X-Audit-Log-Reason': 'Toreca%20Radar%20lottery%20deadline%20alerts'},
    body: JSON.stringify({
      name: CHANNEL_NAME, type: 0, parent_id: original.parent_id ?? null,
      permission_overwrites: original.permission_overwrites ?? [],
      topic: 'トレカレーダーの抽選締切通知（締切日の朝7時・締切1時間前、日本時間）'
    })
  });
  if (!isDiscordId(channel.id) || channel.id === source.channel_id)
    throw Error('Lottery deadline channel creation could not be verified');
  return {guildId, channel, created: true};
}

function channelPermissions(channel, guildId, roles, member, userId) {
  const memberRoles = new Set(member.roles);
  let permissions = roles.reduce((bits, role) => role.id === guildId || memberRoles.has(role.id)
    ? bits | BigInt(role.permissions) : bits, 0n);
  if (permissions & (1n << 3n)) return permissions | (1n << 10n) | (1n << 11n);
  const overwrites = channel.permission_overwrites ?? [];
  const apply = (bits, rows) => {
    let allow = 0n, deny = 0n;
    for (const row of rows) {
      allow |= BigInt(row.allow);
      deny |= BigInt(row.deny);
    }
    return (bits & ~deny) | allow;
  };
  permissions = apply(permissions, overwrites.filter(row => row.type === 0 && row.id === guildId));
  permissions = apply(permissions, overwrites.filter(row => row.type === 0 && memberRoles.has(row.id)));
  return apply(permissions, overwrites.filter(row => row.type === 1 && row.id === userId));
}

export async function setupLotteryDeadlineChannel(settings) {
  const {channel, guildId, created} = await lotteryDeadlineChannel(settings, true);
  const {botToken} = settings;
  const [bot, roles] = await Promise.all([
    discordData('/users/@me', 'Lottery deadline bot lookup', botToken),
    discordData('/guilds/' + guildId + '/roles', 'Lottery deadline bot roles lookup', botToken)
  ]);
  if (!isDiscordId(bot.id)) throw Error('Lottery deadline bot could not be identified');
  const member = await discordData('/guilds/' + guildId + '/members/' + bot.id, 'Lottery deadline bot membership lookup', botToken);
  const permissions = channelPermissions(channel, guildId, roles, member, bot.id);
  const required = (1n << 10n) | (1n << 11n);
  return {
    ready: (permissions & required) === required,
    created, channel_id: channel.id, guild_id: guildId, bot_name: bot.global_name || bot.username
  };
}

export async function postLotteryDeadlineMessage(channelId, botToken, message) {
  if (!isDiscordId(channelId)) throw Error('Invalid lottery deadline channel');
  const response = await discordRequest(DISCORD_API + '/channels/' + channelId + '/messages',
    'Lottery deadline delivery', botToken, {method: 'POST', body: JSON.stringify(message)});
  await response.body?.cancel().catch(() => {});
}
