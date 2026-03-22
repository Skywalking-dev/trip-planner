// POST /api/chat — Anthropic streaming proxy
// Vercel serverless function (Node 18+)

const SYSTEM_PROMPT = `Eres un asistente de viaje conciso. Ayudas a planificar un viaje por Europa dentro de un presupuesto específico.

## Contexto del viaje

**Presupuesto disponible:** €1,450–1,680 para transporte intra-Europa + gastos de vida
**Fechas:** 9 de mayo – 12 de junio (34 días)
**Cumpleaños:** 31 de mayo en Barcelona

**Estructura fija:**
- Roma: 2 noches
- Milán: 5 noches (gratis con amigos)
- Destino libre: ~12 noches pagadas
- Barcelona: 15 noches (gratis con familia)

## Destinos posibles (precios reales Google Flights, mayo 2026)

| Destino | Código | Desde FCO | Desde Milán (BGY/MXP) | Hacia BCN | Costo diario |
|---------|--------|-----------|----------------------|-----------|--------------|
| Dubrovnik | DBV | €15 | €20 (BGY) | €127 | €45–65/día |
| Malta | MLA | €15 | €66 (BGY) | €50 | €40–58/día |
| Tirana | TIA | €28 | €15 (BGY) | €73 | €30–40/día |
| Budapest | BUD | €34 | €25 (MXP) | €42 | €35–50/día |
| Sofía | SOF | €60 | €15 (BGY) | €30 | €28–38/día |
| Atenas | ATH | €79 | €68 (MXP) | €74 | €40–55/día |
| Estambul | IST | €102 | — | €75 | €35–50/día |

## Rutas top evaluadas

1. Milán → Budapest → Belgrado → Sofía → BCN (€67 vuelos, ~€597 total estimado)
2. Milán → Sofía → Skopje → Tirana → BCN (€88 vuelos, ~€590 total estimado)
3. Milán → Atenas + islas → BCN (€142 vuelos, ~€692 total estimado)

## Instrucciones

- Responde siempre en español neutro latinoamericano (sin voseo argentino)
- Sé conciso y directo — el usuario quiere decisiones, no descripciones turísticas
- Cuando sugieras destinos, incluye el código IATA entre paréntesis (ej: Budapest (BUD)) para que el mapa interactivo los pueda resaltar
- Ayuda a comparar rutas dentro del presupuesto, considerando vuelos + alojamiento + días
- Si el usuario pregunta por costos, usa los datos reales de la tabla
- Prioriza opciones que dejen margen de seguridad en el presupuesto`;

// In-memory rate limiter: IP → { count, resetAt }
const rateLimitMap = new Map();
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60 * 1000;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }

  if (entry.count >= RATE_LIMIT) {
    return false;
  }

  entry.count += 1;
  return true;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // API key guard
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  }

  // Rate limiting
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: "Rate limit exceeded. Max 20 requests per minute." });
  }

  // Parse body
  let messages;
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    messages = body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error("Invalid messages");
    }
  } catch {
    return res.status(400).json({ error: "Invalid request body. Expected { messages: [...] }" });
  }

  // Proxy to Anthropic with streaming
  let anthropicRes;
  try {
    anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages,
        stream: true,
      }),
    });
  } catch (err) {
    return res.status(502).json({ error: "Failed to reach Anthropic API", detail: err.message });
  }

  if (!anthropicRes.ok) {
    const errorText = await anthropicRes.text();
    return res.status(anthropicRes.status).json({
      error: "Anthropic API error",
      detail: errorText,
    });
  }

  // Stream SSE to client
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const reader = anthropicRes.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      res.write(chunk);
    }
  } catch (err) {
    // Client likely disconnected — not an error worth logging
  } finally {
    res.end();
  }
}
