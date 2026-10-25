export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  
  const { query, tab, settings = {} } = req.body;
  if (!query) return res.status(400).json({ error: 'Нет запроса' });

  const body = {
    query: query.slice(0, 400),
    search_depth: tab === 'images' ? 'basic' : (settings.depth || 'basic'),
    max_results: tab === 'images' ? 30 : (settings.count || 10),
    topic: tab === 'news' ? 'news' : 'general',
    include_answer: tab === 'all' && !!settings.ai,
    include_images: tab === 'images',
    include_image_descriptions: tab === 'images'
  };

  if (settings.time) body.time_range = settings.time;
  if (tab !== 'news' && settings.kz) body.country = 'kazakhstan';

  if (tab === 'all' && settings.ai) {
    body.include_answer_prompt = settings.lang === 'kk'
      ? 'Жауапты тек қазақ тілінде бер. Қысқа әрі нақты жауап бер.'
      : 'Отвечай только на русском языке. Краткий и точный ответ.';
  }

  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.TAVILY_API_KEY}`
      },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
         }
