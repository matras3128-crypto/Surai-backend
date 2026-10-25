export default async function handler(req, res) {
  const { lang = 'ru' } = req.query;
  const feeds = lang === 'kk'
    ? ['https://kazinform.kz/rss/kz']
    : ['https://tengrinews.kz/rss/'];
  
  const articles = [];
  for (const feed of feeds) {
    try {
      const r = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feed)}`);
      if (r.ok) {
        const d = await r.json();
        if (d.items) {
          articles.push(...d.items.slice(0, 8).map(i => ({
            title: i.title,
            description: (i.content || '').replace(/<[^>]*>/g, '').slice(0, 200),
            url: i.link,
            image: i.enclosure?.link || '',
            source: d.feed?.title || 'News',
            pubDate: i.pubDate
          })));
        }
      }
    } catch {}
  }
  res.json(articles);
}
