export function readPublicHtml(response) {
  return readPublicText(response, /text\/html|application\/xhtml\+xml/i, 2000000);
}

export async function readPublicText(response, contentType, limit) {
  if (!response.ok || !contentType.test(response.headers.get('content-type') || '') ||
      Number(response.headers.get('content-length') || 0) > limit || !response.body) {
    await response.body?.cancel();
    throw Error('Public document unavailable');
  }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = '', size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw Error('Public document too large'); }
      text += decoder.decode(value, {stream: true});
    }
  } finally { reader.releaseLock(); }
  return text + decoder.decode();
}

export const decodeHtml = text => String(text || '').replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => {
  const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1),16) : Number(n);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}).replace(/&(amp|quot|apos|lt|gt|nbsp);/gi, (_, n) =>
  ({amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' '}[n.toLowerCase()]));

export function htmlAttributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
    .map(m => [m[1].toLowerCase(),decodeHtml(m[2] ?? m[3])]));
}

export const compact = value => value.replace(/\s+/g, ' ').trim();
export const textOf = markup => compact(decodeHtml(markup.replace(/<[^>]+>/g, '')));
export const stripInactive = html => html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');

// Bound the article and body separately. The store menu and adjacent news cards
// contain unrelated products, dates and branches, including other lotteries.
export function section(html, tag, className = '') {
  const tags = new RegExp('<(/?)' + tag + '\\b([^>]*)>', 'gi');
  let depth = 0, start = 0;
  for (const match of html.matchAll(tags)) {
    if (!depth) {
      if (match[1] || (className && !(htmlAttributes(match[2]).class || '').split(/\s+/).includes(className))) continue;
      start = match.index + match[0].length;
      depth = 1;
    } else if (!match[1]) depth++;
    else if (--depth === 0) return html.slice(start, match.index);
  }
  return '';
}

export function bodyLines(body) {
  return decodeHtml(body.replace(/<br\b[^>]*>|<\/(?:div|td|p|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')).normalize('NFKC').split(/\r?\n/).map(compact).filter(Boolean);
}
