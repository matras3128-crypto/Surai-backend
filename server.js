require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');

const app = express();

// Firebase Admin инициализация
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
    console.log('✅ Firebase Admin инициализирован');
  } catch (e) {
    console.error('❌ Ошибка инициализации Firebase:', e.message);
  }
}

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['http://localhost:5500'],
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Слишком много запросов, попробуйте позже' }
});
app.use('/api/', apiLimiter);

// In-memory кэш
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function cached(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.ts > CACHE_TTL) { cache.delete(key); return null; }
  return item.data;
}

function setCache(key, data) {
  if (cache.size > 500) cache.clear();
  cache.set(key, { data, ts: Date.now() });
}

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', time: Date.now() }));

// ==================== ПОИСК (Tavily прокси) ====================
app.post('/api/search', async (req, res) => {
  try {
    const { query, tab, settings = {} } = req.body;
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'Не указан запрос' });
    }

    const cacheKey = `search:${query}:${tab}:${JSON.stringify(settings)}`;
    const cachedResult = cached(cacheKey);
    if (cachedResult) return res.json(cachedResult);

    const isImages = tab === 'images';
    const body = {
      query: query.slice(0, 400),
      search_depth: isImages ? 'basic' : (settings.depth || 'basic'),
      max_results: isImages ? 30 : (settings.count || 10),
      topic: tab === 'news' ? 'news' : 'general',
      include_answer: tab === 'all' && !!settings.ai,
      include_images: isImages,
      include_image_descriptions: isImages
    };

    if (settings.time) body.time_range = settings.time;
    if (tab !== 'news' && settings.kz) body.country = 'kazakhstan';

    if (tab === 'all' && settings.ai) {
      body.include_answer_prompt = settings.lang === 'kk'
        ? 'Жауапты тек қазақ тілінде бер. Қысқа әрі нақты жауап бер. Markdown пайдаланба.'
        : 'Отвечай только на русском языке. Давай краткий и точный ответ. Не используй Markdown.';
    }

    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.TAVILY_API_KEY}`
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[Tavily Error]', response.status, errText);
      return res.status(response.status).json({ 
        error: 'Ошибка поиска', 
        code: response.status === 429 ? 'limit' : 'upstream'
      });
    }

    const data = await response.json();
    setCache(cacheKey, data);
    res.json(data);
  } catch (e) {
    console.error('[Search Error]', e.message);
    res.status(500).json({ error: 'Внутренняя ошибка сервера', code: 'internal' });
  }
});

// ==================== ЛЕНТА НОВОСТЕЙ ====================
app.get('/api/news', async (req, res) => {
  try {
    const { lang = 'ru', country = 'kz' } = req.query;
    const cacheKey = `news:${lang}:${country}`;
    const cachedResult = cached(cacheKey);
    if (cachedResult) return res.json(cachedResult);

    let articles = [];

    if (process.env.NEWSDATA_API_KEY) {
      const params = new URLSearchParams({
        apikey: process.env.NEWSDATA_API_KEY,
        language: lang === 'kk' ? 'kk' : 'ru',
        country: country,
        size: '10'
      });

      const response = await fetch(`https://newsdata.io/api/1/latest?${params}`);

      if (response.ok) {
        const data = await response.json();
        if (data.status === 'success' && data.results) {
          articles = data.results.map(a => ({
            title: a.title,
            description: a.description || a.content?.slice(0, 200) || '',
            url: a.link,
            image: a.image_url,
            source: a.source_id || 'News',
            pubDate: a.pubDate,
            category: a.category?.[0] || 'general'
          }));
        }
      }
    }

    if (!articles.length) {
      articles = await fetchFromRSS(lang);
    }

    setCache(cacheKey, articles);
    res.json(articles);
  } catch (e) {
    console.error('[News Error]', e.message);
    res.status(500).json({ error: 'Ошибка загрузки новостей' });
  }
});

async function fetchFromRSS(lang) {
  const feeds = lang === 'kk'
    ? ['https://kazinform.kz/rss/kz']
    : ['https://tengrinews.kz/rss/'];
  
  const articles = [];
  for (const feed of feeds) {
    try {
      const res = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feed)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.items) {
          articles.push(...data.items.slice(0, 5).map(i => ({
            title: i.title,
            description: (i.content || i.description || '').replace(/<[^>]*>/g, '').slice(0, 200),
            url: i.link,
            image: i.enclosure?.link || '',
            source: data.feed?.title || 'News',
            pubDate: i.pubDate
          })));
        }
      }
    } catch (e) {
      console.error('[RSS Error]', e.message);
    }
  }
  return articles.slice(0, 15);
}

// ==================== ТРЕНДЫ ====================
app.get('/api/trending', async (req, res) => {
  try {
    const { lang = 'ru' } = req.query;
    const cacheKey = `trending:${lang}`;
    const cachedResult = cached(cacheKey);
    if (cachedResult) return res.json(cachedResult);

    const trends = [];

    try {
      const res = await fetch('https://trends.google.com/trends/trendingsearches/daily/rss?geo=KZ');
      if (res.ok) {
        const text = await res.text();
        const titles = [...text.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g)];
        for (const match of titles.slice(1, 11)) {
          trends.push(match[1]);
        }
      }
    } catch (e) {
      console.error('[Trends Error]', e.message);
    }

    if (!trends.length) {
      const fallback = lang === 'kk'
        ? ['Қазақстан жаңалықтары', 'Теңге бағамы', 'Ауа райы Астана', 'Kaspi аударым', 'Электрондық үкімет']
        : ['Новости Казахстана', 'Курс тенге', 'Погода Астана', 'Kaspi перевод', 'Электронное правительство'];
      trends.push(...fallback);
    }

    setCache(cacheKey, trends);
    res.json(trends);
  } catch (e) {
    console.error('[Trending Error]', e.message);
    res.json([]);
  }
});

// ==================== GOOGLE AUTH ====================
app.post('/api/auth/google', async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'Не указан токен' });

    if (!admin.apps.length) {
      return res.status(503).json({ error: 'Firebase не настроен на сервере' });
    }

    const decoded = await admin.auth().verifyIdToken(idToken);
    const user = await admin.auth().getUser(decoded.uid);

    res.json({
      uid: user.uid,
      name: user.displayName,
      email: user.email,
      picture: user.photoURL,
      emailVerified: user.emailVerified,
      provider: 'google'
    });
  } catch (e) {
    console.error('[Auth Error]', e.message);
    res.status(401).json({ error: 'Неверный токен', code: 'invalid_token' });
  }
});

// ==================== БЫСТРЫЕ ССЫЛКИ ====================
app.get('/api/shortcuts', (req, res) => {
  const shortcuts = [
    { name: 'Kaspi.kz', url: 'https://kaspi.kz', icon: '💳', color: '#FFCC00' },
    { name: 'eGov', url: 'https://egov.kz', icon: '🏛️', color: '#0066CC' },
    { name: '2GIS', url: 'https://2gis.kz', icon: '🗺️', color: '#00A86B' },
    { name: 'Krisha', url: 'https://krisha.kz', icon: '🏠', color: '#FF6B35' },
    { name: 'Kolesa', url: 'https://kolesa.kz', icon: '🚗', color: '#E63946' },
    { name: 'YouTube', url: 'https://youtube.com', icon: '▶️', color: '#FF0000' },
    { name: 'Gmail', url: 'https://mail.google.com', icon: '📧', color: '#EA4335' }
  ];
  res.json(shortcuts);
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[Server Error]', err);
  res.status(500).json({ error: 'Внутренняя ошибка' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Surai backend запущен на порту ${PORT}`);
});