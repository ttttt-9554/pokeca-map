'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
  const {scanAndDrainLottery, scanLotteryCatalogs}=
    await import('../supabase/functions/discord-notify/lottery-scan-flow.mjs');
  const {externalLotteryNotificationEvents}=
    await import('../supabase/functions/discord-notify/external-lottery-scan.mjs');
  let drains=0,errors=0;
  const drain=async()=>{drains++;return {sent:1}};
  let result=await scanAndDrainLottery(async()=>({total:10,newlyQueued:0}),drain);
  assert.equal(drains,0);assert.equal(result.newlyQueued,0);
  result=await scanAndDrainLottery(async()=>({total:11,newlyQueued:1}),drain);
  assert.equal(drains,1);assert.equal(result.delivery.sent,1);
  result=await scanAndDrainLottery(async()=>({newlyQueued:1}),async()=>{throw Error('temporary')},()=>{errors++});
  assert.equal(result.deliveryPending,true);assert.equal(errors,1);
  await assert.rejects(scanAndDrainLottery(async()=>{throw Error('scan failed')},drain),/scan failed/);
  assert.equal(drains,1,'a failed scan must not send anything');

  const failures = [];
  const failed = () => { throw Error('temporarily unavailable'); };
  result = await scanAndDrainLottery(() => scanLotteryCatalogs({
    livepocket: failed,
    external: async () => ({total: 3, newlyQueued: 1})
  }, name => failures.push(name)), drain);
  assert.deepEqual(failures, ['livepocket']);
  assert.equal(result.newlyQueued, 1);
  assert.equal(result.delivery.sent, 1);
  assert.equal(drains, 2);
  result = await scanLotteryCatalogs({
    livepocket: async () => ({total: 10, newlyQueued: 1}),
    external: failed
  });
  assert.equal(result.newlyQueued, 1);
  assert.deepEqual(result.catalogs.external, {error: true});
  await assert.rejects(scanLotteryCatalogs({livepocket: failed, external: failed}), /No lottery catalog/);

  const confirmed = {
    url: 'https://shoplottery.e-starbox.com/lottery/entry?code=Example000',
    external_url_unverified: false,
    official_event_title: 'トレーディングカード購入権抽選',
    store_name: 'カードショップ',
    prefecture: '東京都',
    application_start_at: '2026-11-06T10:00:00+09:00',
    application_end_at: '2026-11-08T21:00:00+09:00'
  };
  const events = (...items) => externalLotteryNotificationEvents({items});
  assert.equal(events(confirmed)[0].event_url, confirmed.url);
  assert.equal(events(confirmed)[0].application_end_at, '2026-11-08T12:00:00.000Z');
  for (const change of [
    {external_url_unverified: true}, {event_title_provisional: true}, {official_event_title: ''},
    {store_name: '対象店舗未確認'}, {prefecture: '関東'}, {application_start_at: null},
    {application_end_at: null}, {application_end_at: '2026-11-31T21:00:00+09:00'},
    {application_end_at: confirmed.application_start_at}, {manual_card_hidden: true},
    {url: 'https://livepocket.jp/e/example'}
  ]) assert.equal(events({...confirmed, ...change}).length, 0, JSON.stringify(change));
  const stores = [
    {name: '東京店', prefecture: '東京都'},
    {name: '埼玉店', prefecture: '埼玉県'}
  ];
  assert.deepEqual(events({...confirmed, stores})[0].stores, stores);
  assert.equal(events({...confirmed, stores: [stores[0], {name: '埼玉店'}]}).length, 0);
  const cloud = 'https://cloud-pass.jp/pr/' + 'a'.repeat(64);
  assert.equal(events({...confirmed, url: cloud + '/'})[0].identity, cloud);
  const famima = 'https://famima-online.family.co.jp/item?itemCode=100000000001';
  assert.equal(events({...confirmed, url: famima + '&utm_source=example'})[0].identity, famima);

  const {deadlineDiscordMessages, scanLotteryDeadlineAlerts} =
    await import('../supabase/functions/discord-notify/lottery-deadline-alerts.mjs');
  const {setupLotteryDeadlineChannel} =
    await import('../supabase/functions/discord-notify/lottery-deadline-channel.mjs');
  const guild = '100000000000000001', source = '100000000000000002';
  const deadlineChannel = '100000000000000003', category = '100000000000000004';
  const bot = '100000000000000005';
  const sourcePermissions = [{id: guild, type: 0, allow: '0', deny: '1024'}];
  const fixture = {
    event_key: 'a'.repeat(32), claim_no: 1, event_url: confirmed.url,
    event_title: 'カード応募 [抽選]', store_name: '東京店', reminder: 'one_hour',
    deadline: new Date(Date.now() + 60 * 60_000).toISOString()
  };
  const buildEmbed = (job, title) => ({
    title, url: job.event_url, description: job.event_title,
    fields: [{name: '🏪 店舗', value: job.store_name}]
  });
  const batchJobs = Array.from({length: 25}, (_, index) => ({...fixture, event_key: String(index)}));
  assert.deepEqual(deadlineDiscordMessages(batchJobs, buildEmbed).map(batch => batch.embeds.length), [10, 10, 5]);
  const longBatch = deadlineDiscordMessages(batchJobs, (job, title) => ({
    ...buildEmbed(job, title), description: '抽'.repeat(1000)
  }));
  assert.equal(longBatch.reduce((n, message) => n + message.jobs.length, 0), 25);
  assert.ok(longBatch.length > 3 && longBatch.every(message => message.embeds.length <= 5));

  const settings = {
    botToken: 'test-bot',
    newLotteryWebhook: 'https://discord.com/api/webhooks/100000000000000006/example-token'
  };
  let channel, created = 0, sent = 0, settled, botPermissions = '8';
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    if (url === settings.newLotteryWebhook) {
      assert.notEqual(options.method, 'POST');
      return Response.json({guild_id: guild, channel_id: source});
    }
    assert.equal(options.headers.get('Authorization'), 'Bot test-bot');
    if (path === '/api/v10/guilds/' + guild + '/channels') {
      if (options.method === 'POST') {
        const requested = JSON.parse(options.body);
        assert.equal(requested.name, '抽選締切アラート');
        assert.equal(requested.parent_id, category);
        assert.deepEqual(requested.permission_overwrites, sourcePermissions);
        channel = {...requested, id: deadlineChannel};
        created++;
        return Response.json(channel);
      }
      return Response.json([
        {id: source, name: '新規抽選アラート', type: 0, parent_id: category, permission_overwrites: sourcePermissions},
        ...(channel ? [channel] : [])
      ]);
    }
    if (path === '/api/v10/users/@me') return Response.json({id: bot, username: 'fixture-bot'});
    if (path.endsWith('/roles')) return Response.json([{id: guild, permissions: botPermissions}]);
    if (path.endsWith('/members/' + bot)) return Response.json({roles: []});
    assert.equal(path, '/api/v10/channels/' + deadlineChannel + '/messages');
    assert.equal(options.method, 'POST');
    const message = JSON.parse(options.body);
    assert.equal(message.embeds.length, 1);
    assert.match(message.embeds[0].title, /応募締切まで約1時間/);
    assert.equal(message.embeds[0].url, confirmed.url);
    assert.equal(message.embeds[0].description, fixture.event_title);
    assert.equal(message.flags, undefined);
    assert.deepEqual(message.allowed_mentions, {parse: []});
    assert.match(message.nonce, /^[0-9a-f]{24}$/);
    assert.equal(message.enforce_nonce, true);
    sent++;
    return Response.json({id: '100000000000000007'});
  };
  try {
    const setup = await setupLotteryDeadlineChannel(settings);
    assert.equal(setup.ready, true);
    assert.equal(setup.channel_id, deadlineChannel);
    await setupLotteryDeadlineChannel(settings);
    assert.equal(created, 1);
    channel.permission_overwrites = [];
    botPermissions = '3072';
    assert.equal((await setupLotteryDeadlineChannel(settings, false)).ready, false);
    botPermissions = '19456';
    assert.equal((await setupLotteryDeadlineChannel(settings, false)).ready, true);
    const database = {
      rpc: async (name, args) => {
        if (name === 'lottery_claim_deadline_discord_embeds') {
          assert.equal(args.p_catalog.length, 1);
          assert.equal(args.p_catalog[0].event_url, confirmed.url);
          assert.equal(args.p_catalog[0].prefecture, '東京都');
          assert.equal(args.p_catalog[0].application_start_at, '2026-11-06T01:00:00.000Z');
          return {data: [fixture]};
        }
        assert.equal(name, 'lottery_settle_deadline_discord_alerts');
        settled = args;
        return {data: 1};
      }
    };
    const run = () => scanLotteryDeadlineAlerts(database, {
      livepocket: Promise.resolve({items: []}), external: Promise.resolve({items: [confirmed]})
    }, settings, buildEmbed);
    assert.deepEqual(await run(), {claimed: 1, sent: 1});
    assert.equal(settled.p_delivered, true);
    channel = null;
    await assert.rejects(run(), /deadline channel is missing/);
    assert.equal(settled.p_delivered, false);
    assert.equal(sent, 1);
    await assert.rejects(setupLotteryDeadlineChannel(settings, false), /deadline channel is missing/);
    assert.equal(created, 1);
  } finally {
    globalThis.fetch = oldFetch;
  }

  const edge=fs.readFileSync('supabase/functions/discord-notify/index.ts','utf8');
  assert.match(edge,/https:\/\/ttttt-9554\.github\.io\/pokeca-map\/livepocket_public\.json/);
  assert.match(edge,/scanAndDrainLottery\(/);
  console.log('External lottery confirmation, independent scans and separate deadline delivery passed');
})().catch(error=>{console.error(error);process.exitCode=1});
