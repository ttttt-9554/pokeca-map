(() => {
  const allowed = new Set('宮城 福島 栃木 群馬 茨城 埼玉 千葉 東京 神奈川 福岡 静岡 全国'.split(' '));
  function includesArea(value) {
    return String(value || '').split(/[・、,／/\s]+/u)
      .some(area => allowed.has(area.trim().replace(/[都県]$/u, '')));
  }
  function includesCard(card) {
    const stores = Array.isArray(card?.stores) ? card.stores : [];
    const regions = stores.map(store => store?.prefecture).filter(Boolean);
    return regions.length ? regions.some(includesArea) : includesArea(card?.prefecture);
  }
  globalThis.TorecaLotteryRegions = {includesArea, includesCard};
})();
