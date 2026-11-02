#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element() {
  const handlers = {};
  return {
    textContent: '', disabled: false, children: [], handlers,
    addEventListener(name, fn) { handlers[name] = fn; },
    replaceChildren(...children) { this.children = children; }
  };
}

(async () => {
  const panel = element(), fold = element();
  fold.open = true;
  panel.closest = () => fold;
  const nodes = {
    adminLoginUsersPanel: panel,
    adminLoginUsersCount: element(),
    adminLoginUsersStatus: element(),
    adminLoginUsersList: element(),
    adminLoginUsersReload: element(),
    devView: { classList: { contains: name => name === 'active' } }
  };
  const document = {
    visibilityState: 'visible',
    getElementById: id => nodes[id] || null,
    createElement: element,
    addEventListener() {}
  };
  const window = {};
  let dev = false, user = '', calls = 0, resolveRequest;
  let response = () => Promise.resolve({ data: [], error: null });
  const client = { rpc(name) {
    assert.equal(name, 'toreca_admin_logged_in_users_v1');
    ++calls;
    return response();
  } };
  const source = fs.readFileSync(path.join(__dirname, '..', 'admin_login_users_v1.js'), 'utf8');
  vm.runInNewContext(source, { document, window, setInterval() {} }, { timeout: 1000 });
  const module = window.TorecaAdminLoginUsers;
  module.init({ isDev: () => dev, getUserId: () => user, getClient: () => client });
  assert.equal(await module.refresh(true), false);
  assert.equal(calls, 0, 'A non-admin must never request the list');

  dev = true; user = 'developer';
  response = () => Promise.resolve({ data: [
    { display_name: '山田' }, { display_name: '<img src=x onerror=alert(1)>' },
    { display_name: '山田' }
  ], error: null });
  module.onAuthChanged();
  assert.equal(await module.refresh(), true);
  assert.equal(calls, 1);
  assert.equal(nodes.adminLoginUsersCount.textContent, '3人');
  assert.equal(nodes.adminLoginUsersList.children.length, 3);
  assert(nodes.adminLoginUsersList.children.some(child => child.textContent === '<img src=x onerror=alert(1)>'));
  assert.equal(await module.refresh(), true);
  assert.equal(calls, 1, 'Normal refresh is throttled');

  response = () => new Promise(resolve => { resolveRequest = resolve; });
  const pending = module.refresh(true);
  await Promise.resolve();
  assert.equal(calls, 2);
  dev = false; user = '';
  module.onAuthChanged();
  assert.equal(nodes.adminLoginUsersList.children.length, 0);
  assert.equal(nodes.adminLoginUsersCount.textContent, '');
  resolveRequest({ data: [{ display_name: '表示してはいけない名前' }], error: null });
  assert.equal(await pending, false);
  assert.equal(nodes.adminLoginUsersList.children.length, 0, 'An in-flight request cannot restore names after logout');
  assert.equal(await module.refresh(true), false);
  assert.equal(calls, 2);

  dev = true; user = 'developer';
  response = () => Promise.resolve({ data: [{ display_name: '前回の名前' }], error: null });
  module.onAuthChanged();
  assert.equal(await module.refresh(), true);
  assert.equal(nodes.adminLoginUsersList.children.length, 1);
  response = () => { throw new Error('offline'); };
  assert.equal(await module.refresh(true), false);
  assert.match(nodes.adminLoginUsersStatus.textContent, /取得できません/);
  assert.equal(nodes.adminLoginUsersList.children.length, 0, 'A failed refresh cannot leave a stale login list');
  assert.equal(nodes.adminLoginUsersCount.textContent, '');
  assert.equal(nodes.adminLoginUsersReload.disabled, false);
  console.log('Administrator login list: access, rendering, refresh and sign-out verified');
})().catch(error => { console.error(error); process.exitCode = 1; });
