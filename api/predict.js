// api/predict.js — Vercel Serverless Function
// Powered by Google Gemini (free tier)
// Predictions cached daily — Gemini called only ONCE per day for all users

var cache = { date: null, data: null };

module.exports = async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // Serve from cache if already fetched today
  var today = new Date().toISOString().slice(0, 10);
  if (cache.date === today && cache.data) {
    return res.status(200).json(cache.data);
  }

  var apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY not set in Vercel Environment Variables.'
    });
  }

  var now     = new Date();
  var dateStr = now.toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  var dow     = now.toLocaleDateString('en-GB', { weekday:'long' });

  var prompt = 'You are a football prediction expert. Today is ' + dateStr + '.\n\n'
    + 'Generate 18 realistic football match predictions for ' + dow + ' across Premier League, La Liga, Serie A, Bundesliga, Ligue 1, Championship, Champions League, Europa League, MLS and Scottish Premiership.\n\n'
    + 'Respond with ONLY a raw JSON object — no markdown, no text before or after. Start with { and end with }.\n\n'
    + '{"predictions":[{"home":"Arsenal","away":"Chelsea","league":"Premier League","time":"15:00","prediction":"Home Win","confidence":72,"goals_prediction":"Over 2.5 Goals","goals_confidence":65}],'
    + '"edge":[{"index":0,"edge_score":60,"edge_level":"medium","factors":[{"label":"London derby intensity","type":"positive"}],"verdict":"Derby pressure gives home side a motivation edge."}]}\n\n'
    + 'Rules for predictions:\n'
    + '- prediction: exactly one of: Home Win, Away Win, Draw, Both Teams to Score, Home Win or Draw, Away Win or Draw\n'
    + '- confidence: integer 48-91\n'
    + '- goals_prediction: Over 2.5 Goals, Under 2.5 Goals, Over 1.5 Goals, BTTS Yes, BTTS No, or null\n'
    + '- goals_confidence: integer or null\n\n'
    + 'Rules for edge:\n'
    + '- One entry per prediction, same 0-based index\n'
    + '- edge_score: 0-100\n'
    + '- edge_level: none(0-29) low(30-49) medium(50-69) high(70-84) elite(85-100)\n'
    + '- factor type: positive, negative, or neutral\n'
    + '- verdict: one sentence\n\n'
    + 'Use real team names. Return ONLY the JSON.';

  try {
    var geminiRes = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + apiKey,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 4096 }
        })
      }
    );

    var geminiData = await geminiRes.json();

    if (!geminiRes.ok) {
      var msg = (geminiData.error && geminiData.error.message) || ('HTTP ' + geminiRes.status);
      return res.status(502).json({ error: 'Gemini error: ' + msg });
    }

    var parts = geminiData.candidates
      && geminiData.candidates[0]
      && geminiData.candidates[0].content
      && geminiData.candidates[0].content.parts;

    var text = (parts || []).filter(function(p){ return p.text; }).map(function(p){ return p.text; }).join('');

    if (!text) {
      var reason = geminiData.promptFeedback && geminiData.promptFeedback.blockReason;
      return res.status(502).json({ error: 'Empty response from Gemini. Block reason: ' + (reason || 'none') });
    }

    // Parse JSON
    var clean = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    var os = clean.indexOf('{'), oe = clean.lastIndexOf('}');
    if (os === -1 || oe === -1) {
      return res.status(502).json({ error: 'Could not parse response.', raw: text.slice(0, 300) });
    }

    var result = JSON.parse(clean.slice(os, oe + 1));

    if (!result.predictions || !result.predictions.length) {
      return res.status(502).json({ error: 'No predictions found.', raw: text.slice(0, 300) });
    }

    // Cache for the day
    cache = { date: today, data: result };

    return res.status(200).json(result);

  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
};
