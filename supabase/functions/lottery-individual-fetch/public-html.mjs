export async function readPublicHtml(response) {
  if (!response.ok || !/text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type') || '') ||
      Number(response.headers.get('content-length') || 0) > 2000000 || !response.body) {
    await response.body?.cancel();
    throw Error('Public HTML unavailable');
  }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let html = '', size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2000000) { await reader.cancel(); throw Error('Public HTML too large'); }
      html += decoder.decode(value, {stream: true});
    }
  } finally { reader.releaseLock(); }
  return html + decoder.decode();
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
