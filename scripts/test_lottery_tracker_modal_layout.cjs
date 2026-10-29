#!/usr/bin/env node
'use strict';
// v21.139 regression: iOS lottery-management modal is scroll-safe and
// private notes always expand to show the entire content.
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..');
const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
const css=fs.readFileSync(path.join(root,'style.css'),'utf8');

const start=app.indexOf('  function lpTrackerExpandMemo(memo){');
const end=app.indexOf('\n  }\n',start);
assert(start>=0&&end>start,'Tracker auto-expand helper is required');
const resize=vm.runInNewContext(app.slice(start,end+5)+
  '\n({lpTrackerExpandMemo})',{Number,Math},{timeout:1000}).lpTrackerExpandMemo;
const field={style:{height:'74px'},scrollHeight:187};
resize(field);
assert.equal(field.style.height,'189px','Saved multiline memo expands to content');
field.scrollHeight=296;
resize(field);
assert.equal(field.style.height,'298px','Typing a longer note expands again');
field.scrollHeight=52;
resize(field);
assert.equal(field.style.height,'54px','Deleting lines shrinks the field');
field.scrollHeight=0;
resize(field);
assert.equal(field.style.height,'auto','Unmeasurable note falls back to CSS min-height');
resize(null);

assert.match(app,/memo\.addEventListener\('input',resizeMemo\)/);
assert.match(app,/resizeMemo\(\);\s*requestAnimationFrame\(\(\)=>/);
assert.match(app,/content\.scrollTop=0;\s*dlg\.scrollTop=0/);
assert.match(app,/window\.removeEventListener\('resize',onTrackerResize\)/);
assert.match(app,/id="lpTrackDialogTitle"/);
assert.match(app,/dialog\.setAttribute\('aria-labelledby','lpTrackDialogTitle'\)/);
assert.match(app,/#lpTrackerEditor\[open\]\{display:flex;flex-direction:column\}/);
assert.match(app,/#lpTrackerEditorBody\{[\s\S]{0,300}overflow-y:auto;overflow-x:hidden/);
assert.match(app,/#lpTrackerForm textarea\[name=note\]\{[\s\S]{0,200}resize:none/);
assert.match(css,/#lpTrackerEditor \.lp-track-sticky-bar\{[\s\S]{0,350}position:relative/);
assert.match(css,/#lpTrackerEditor \.lp-track-modal-title/);
assert.match(css,/#lpTrackerEditor #lpTrackerForm input\[type="datetime-local"\]/);
assert.doesNotMatch(css,/#lpTrackerEditor \.lp-track-sticky-bar\{[\s\S]{0,300}margin:-18px/);
assert.doesNotMatch(app,/#lpTrackerForm textarea\{min-height:74px;resize:vertical\}/);
console.log('Lottery tracker modal: fixed header, constrained dates, scroll reset, saved and typed memo auto-grow passed');
