// api/predict.js — Vercel Serverless Function
// Calls Gemini once per day, caches for all users
// Your API key lives in Vercel Environment Variables (never exposed to users)

// In-memory cache (persists for the lifetime of this function instance)
let cache = { date: null, data: null };

module.exports = async function handler(req, res) {

  // Allow browser requests (CORS)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // Check cache — if we already fetched today, return instantly
  const today = new Date().toISOString().slice(0, 10); // "2026-04-14"
  if (cache.date === today && cache.data) {
    console.log('Returning cached predictions for', today);
    return res.status(200).json({ source: 'cache', ...cache.data });
  }

  // Get API key from Vercel Environment Variables
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not set in Vercel environment variables.' });
  }

  const now    = new Date();
  const dateStr = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const dow     = now.toLocaleDateString('en-GB', { weekday: 'long' });

  const prompt = `You are a football prediction expert. Today is ${dateStr}.

Generate 18 realistic football match predictions for ${dow} fixtures across major leagues (Premier League, La Liga, Serie A, Bundesliga, Ligue 1, Championship, Champions League, Europa League, MLS, Scottish Premiership). Also provide narrative edge analysis for each match.

Respond with ONLY this JSON structure, nothing else:

{"predictions":[{"home":"Arsenal","away":"Chelsea","league":"Premier League","time":"15:00","prediction":"Home Win","confidence":72,"goals_prediction":"Over 2.5 Goals","goals_confidence":65}],"edge":[{"index":0,"edge_score":60,"edge_level":"medium","factors":[{"label":"London derby — high intensity","type":"positive"}],"verdict":"High stakes local rivalry adds narrative edge."}]}

Rules:
- prediction must be one of: Home Win, Away Win, Draw, Both Teams to Score, Home Win or Draw, Away Win or Draw
- confidence: integer 45-92
- goals_prediction: Over 2.5 Goals, Under 2.5 Goals, Over 1.5 Goals, BTTS Yes, BTTS No, or null
- goals_confidence: integer or null
- edge_level: none(0-29) low(30-49) medium(50-69) high(70-84) elite(85-100)
- factor type: positive, negative, or neutral
- One edge entry per prediction (same index)
- Use real team names from current leagues
- Return raw JSON only — no markdown, no explanation`;

  try {
    console.log('Calling Gemini for', today);
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 4096 }
        })
      }
    );

    const geminiData = await geminiRes.json();

    if (!geminiRes.ok) {
      const msg = geminiData?.error?.message || `Gemini HTTP ${geminiRes.status}`;
      console.error('Gemini error:', msg);
      return res.status(502).json({ error: msg });
    }

    const parts = geminiData?.candidates?.[0]?.content?.parts || [];
    const text  = parts.filter(p => p.text).map(p => p.text).join('');

    if (!text) {
      const reason = geminiData?.promptFeedback?.blockReason;
      return res.status(502).json({ error: `Empty response from Gemini. Block reason: ${reason || 'none'}` });
    }

    // Parse JSON from response
    const clean = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const os = clean.indexOf('{'), oe = clean.lastIndexOf('}');
    if (os === -1 || oe === -1) {
      return res.status(502).json({ error: 'Could not find JSON in Gemini response.', raw: text.slice(0, 300) });
    }

    const result = JSON.parse(clean.slice(os, oe + 1));

    if (!result.predictions || !result.predictions.length) {
      return res.status(502).json({ error: 'No predictions in Gemini response.', raw: text.slice(0, 300) });
    }

    // Save to cache
    cache = { date: today, data: result };
    console.log(`Cached ${result.predictions.length} predictions for ${today}`);

    return res.status(200).json({ source: 'fresh', ...result });

  } catch (err) {
    console.error('Server error:', err.message);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
