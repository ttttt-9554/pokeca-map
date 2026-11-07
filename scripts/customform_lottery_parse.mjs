import {extract, supportedUrl} from '../supabase/functions/lottery-individual-fetch/extract.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const {html, url} = JSON.parse(input);
if (typeof html !== 'string' || html.length > 2_000_000 || !supportedUrl(url) ||
    new URL(url).hostname !== 'customform.jp') throw Error('Invalid CustomForm page');
process.stdout.write(JSON.stringify(extract(html, url)));
