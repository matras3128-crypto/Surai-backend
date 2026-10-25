export default async function handler(req, res) {
  const { lang = 'ru' } = req.query;
  
  // Попытка 1: RSS
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
    } catch (e) {
      console.error('RSS error:', e.message);
    }
  }
  
  // Фоллбэк: если RSS не сработал, вернуть мок-данные
  if (!articles.length) {
    const mock = lang === 'kk' ? [
      { title: 'Қазақстан жаңалықтары', description: 'Соңғы жаңалықтар мен оқиғалар', url: 'https://kazinform.kz', source: 'Kazinform', pubDate: new Date().toISOString() },
      { title: 'Экономикалық жаңалықтар', description: 'Теңге бағамы және нарық', url: 'https://tengrinews.kz', source: 'Tengri', pubDate: new Date().toISOString() }
    ] : [
      { title: 'Новости Казахстана', description: 'Последние новости и события', url: 'https://tengrinews.kz', source: 'Tengri News', pubDate: new Date().toISOString() },
      { title: 'Экономические новости', description: 'Курс тенге и рынок', url: 'https://kazinform.kz', source: 'Kazinform', pubDate: new Date().toISOString() }
    ];
    return res.json(mock);
  }
  
  res.json(articles);
            }
