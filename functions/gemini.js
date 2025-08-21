// functions/gemini.js

// A simple in-memory store for rate limiting.
const RATE_LIMIT_STORE = new Map();
const RATE_LIMIT_MAX_REQUESTS = 20; // Max requests per user
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // per 1 minute

export default {
  async fetch(request, env) {
    // Only allow POST requests
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // --- Rate Limiting ---
    const userIp = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
    const now = Date.now();
    const userRequests = (RATE_LIMIT_STORE.get(userIp) || []).filter(
      (timestamp) => timestamp > now - RATE_LIMIT_WINDOW_MS
    );

    if (userRequests.length >= RATE_LIMIT_MAX_REQUESTS) {
      return new Response('Too many requests. Please try again later.', { status: 429 });
    }
    RATE_LIMIT_STORE.set(userIp, [...userRequests, now]);

    // --- Input Validation & Security ---
    const GEMINI_API_KEY = env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return new Response('API key is not configured on the server.', { status: 500 });
    }

    let body;
    try {
      body = await request.json();
      if (JSON.stringify(body).length > 5000) {
          return new Response('Request payload is too large.', { status: 413 });
      }
    } catch (error) {
      return new Response('Invalid JSON in request body.', { status: 400 });
    }

    const { prompt, base64ImageData, imageType } = body;

    if (!prompt) {
      return new Response('Prompt is required.', { status: 400 });
    }

    // --- Call Gemini API ---
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${GEMINI_API_KEY}`;

    const parts = [{ text: prompt }];
    if (base64ImageData && imageType) {
      parts.push({
        inlineData: {
          mimeType: imageType,
          data: base64ImageData,
        },
      });
    }

    const requestPayload = {
      contents: [{ role: 'user', parts: parts }],
    };

    try {
      const geminiResponse = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestPayload),
      });

      if (!geminiResponse.ok) {
          const errorBody = await geminiResponse.json();
          console.error('Gemini API Error:', errorBody);
          return new Response(JSON.stringify(errorBody), { status: geminiResponse.status });
      }

      const data = await geminiResponse.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      
      // --- Structured Output ---
      const structuredResponse = {
          likelyIssues: [],
          confidence: 'N/A',
          nextSteps: 'No specific steps provided.',
          prevention: 'No prevention tips provided.',
          disclaimer: 'This is an AI-generated diagnosis and may not be accurate. Consult a professional for serious issues.'
      };

      const diagnosisMatch = text.match(/\*\*Diagnosis:\*\*\s*([\s\S]*?)(?=\*\*Cause:\*\*|\*\*Solution:\*\*|$)/i);
      const causeMatch = text.match(/\*\*Cause:\*\*\s*([\s\S]*?)(?=\*\*Solution:\*\*|$)/i);
      const solutionMatch = text.match(/\*\*Solution:\*\*\s*([\s\S]*?)(?=\*\*Prevention:\*\*|$)/i);

      if (diagnosisMatch) structuredResponse.likelyIssues.push(diagnosisMatch[1].trim());
      if (causeMatch) structuredResponse.likelyIssues.push(`Cause: ${causeMatch[1].trim()}`);
      if (solutionMatch) structuredResponse.nextSteps = solutionMatch[1].trim();
      
      return new Response(JSON.stringify(structuredResponse), {
        headers: { 'Content-Type': 'application/json' },
      });

    } catch (error) {
      console.error('Cloudflare Worker error:', error);
      return new Response('An internal server error occurred.', { status: 500 });
    }
  },
};
