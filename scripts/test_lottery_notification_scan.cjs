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

  const edge=fs.readFileSync('supabase/functions/discord-notify/index.ts','utf8');
  assert.match(edge,/https:\/\/ttttt-9554\.github\.io\/pokeca-map\/livepocket_public\.json/);
  assert.match(edge,/scanAndDrainLottery\(/);
  console.log('External lottery confirmation, independent catalog scans and immediate queue drain passed');
})().catch(error=>{console.error(error);process.exitCode=1});
