import {googleFormUrl, googleFormFields, formNoticeFields, fetchGoogleForm, GoogleFormAccessError,
  dateRange, dateStamp} from './google-forms.mjs';
import {bodyLines, readPublicText, section, stripInactive} from './public-html.mjs';

// A reviewed form can be paired with its organizer's public announcement.
// Pairings belong to a specific form ID and post, never inferred from a product or store alone.
const reviewedForms = new Map([
  ['https://docs.google.com/forms/d/e/1FAIpQLSfv31yN4OSSFYE1uozMEx-5KwVQwweQKkwigH7u_11hFqDS_A/viewform', {
    reviewedOn: '2026-11-21',
    postUrl: 'https://x.com/CloveBase/status/2123748209030029746',
    title: '【CloveBase秋葉原店】ポケモンカードゲーム MEGA拡張パック「ハドウシーカー」抽選販売申し込みフォーム',
    // Lottery notice transcribed from the supplied form screen. No responses or account details.
    description: [
      '◆対象商品◆', 'ポケモンカードゲーム MEGA 拡張パック「ハドウシーカー」',
      '受付期間：11/20(金)21:00～11/22(日)21:00まで',
      '当選発表日：11/23(月)より 当選された方には順次当選発表メールをお送りいたします。',
      '発売日：11/27(金)', '受取期日：11/29(日)まで',
      '営業時間：11/27・11/28・11/29は13:00～18:00までの営業となります',
      '発売日より3日以内にご来店して購入頂ける方'
    ].join('\n')
  }]
]);

async function loadOfficialPost(postUrl) {
  const endpoint = new URL('https://publish.x.com/oembed');
  endpoint.searchParams.set('url', postUrl);
  endpoint.searchParams.set('omit_script', 'true');
  const response = await fetch(endpoint, {method: 'GET', redirect: 'manual', credentials: 'omit',
    headers: {Accept: 'application/json', 'User-Agent': 'TorecaRadar/1.0'}, signal: AbortSignal.timeout(6000)});
  return JSON.parse(await readPublicText(response, /^application\/json(?:;|$)/i, 65536));
}

function officialApplicationPeriod(post, notice, product) {
  const identity = value => typeof value === 'string' ? value.replace(/^https:\/\/twitter\.com\//, 'https://x.com/') : '';
  if (identity(post?.url) !== notice.postUrl || identity(post?.author_url) !== notice.postUrl.split('/status/')[0] ||
      typeof post.html !== 'string' || !product) return null;
  const quote = section(stripInactive(post.html), 'blockquote', 'twitter-tweet');
  const lines = bodyLines(section(quote, 'p'));
  const subject = lines.join('').replace(/\s/g, '');
  if (!subject.includes(product.normalize('NFKC').replace(/\s/g, '')) || /抽選(?:販売)?(?:の)?(?:中止|延期)/.test(subject))
    return null;
  const ranges = lines.map(line => line.match(/^(?:⏰\ufe0f?\s*)?【(?:抽選|応募|受付)期間】\s*(.+)$/)?.[1]).filter(Boolean);
  if (ranges.length !== 1) return null;
  const days = dateRange(ranges[0], notice.reviewedOn);
  if (days.length !== 2 || !/^(?:まで)?[。.]?$/.test(days[1].rest)) return null;
  return {application_start_at: dateStamp(days[0]), application_end_at: dateStamp(days[1])};
}

export async function readGoogleLottery(source, {load = fetchGoogleForm, loadPost = loadOfficialPost,
  parse = googleFormFields, referenceDate = new Date().toISOString()} = {}) {
  try {
    const page = await load(source);
    return {url: page.url, fields: parse(page.html, page.url, {referenceDate})};
  } catch (error) {
    if (!(error instanceof GoogleFormAccessError)) throw error;
    const url = googleFormUrl(error.url);
    const requested = googleFormUrl(source);
    if (!requested || (new URL(requested).hostname === 'docs.google.com' && requested !== url)) throw error;
    const notice = reviewedForms.get(url);
    if (!notice) throw error;
    const fields = formNoticeFields(notice.title, notice.description, [], notice.reviewedOn);
    const post = await loadPost(notice.postUrl).catch(() => null);
    const interval = officialApplicationPeriod(post, notice, fields.product_name);
    if (interval) Object.assign(fields, interval);
    return {url, fields, access: error.code, reviewedOn: notice.reviewedOn,
      postUrl: notice.postUrl, evidence: interval ? 'official_post_and_form_screen' : 'form_screen'};
  }
}
