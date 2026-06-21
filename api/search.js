export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { prompt } = req.body || {};
  if (!prompt) return res.status(400).json({ error: "No prompt" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  const SYSTEM = `You are a fashion product researcher with web search. Find real products and return a JSON array.

CRITICAL - imageUrl must be a DIRECT CDN image file URL. Here are the exact formats for each retailer:

SSENSE: https://img.ssense.com/... (contains img.ssense.com)
Net-a-Porter: https://www.net-a-porter.com/variants/images/... OR https://cache.net-a-porter.com/images/...
Mr Porter: https://www.mrporter.com/variants/images/...
Mytheresa: https://www.mytheresa.com/media/...
END Clothing: https://img.endclothing.com/... OR https://cdn.endclothing.com/...
Browns Fashion: https://cdn-images.farfetch-contents.com/...
Selfridges: https://images.selfridges.com/...
MatchesFashion: https://cdn-images.farfetch-contents.com/...
LUISAVIAROMA: https://images.luisaviaroma.com/...
24S: https://media.24s.com/...
Cettire: https://cdn.cettire.com/...
Official brand sites use their own CDN (e.g. loewe.com/cdn, celine.com/on/...)

RULES:
- Search for products then look at the actual page source/images
- imageUrl MUST end in .jpg, .jpeg, .png, or .webp
- imageUrl must NOT be a product page URL - it must be a direct image file
- productUrl is the product page URL
- Find 4-6 products per brand
- If you cannot find a direct image CDN URL for a product, set imageUrl to null
- Return ONLY a raw JSON array starting with [ - no markdown, no explanation

Each item: { "brand": "", "name": "", "price": "", "imageUrl": "" or null, "productUrl": "" }`;

  try {
    const messages = [{ role: "user", content: prompt }];
    let finalText = "";

    for (let i = 0; i < 10; i++) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 4000,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          system: SYSTEM,
          messages
        })
      });

      const data = await r.json();
      if (data.error) throw new Error(data.error.message);
      messages.push({ role: "assistant", content: data.content });

      if (data.stop_reason === "end_turn") {
        finalText = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
        break;
      }

      if (data.stop_reason === "tool_use") {
        const results = (data.content || [])
          .filter(b => b.type === "tool_use")
          .map(b => ({ type: "tool_result", tool_use_id: b.id, content: "Search completed." }));
        messages.push({ role: "user", content: results });
      } else {
        finalText = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
        break;
      }
    }

    let products = parseJson(finalText);

    // Cleanup pass
    if (!products) {
      const r2 = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 4000,
          messages: [{
            role: "user",
            content: `Extract fashion products from this text. Return ONLY a JSON array with fields: brand, name, price, imageUrl, productUrl.\n\n${finalText.slice(0, 8000)}\n\nJSON array only:`
          }]
        })
      });
      const d2 = await r2.json();
      products = parseJson((d2.content || []).filter(b => b.type === "text").map(b => b.text).join("\n"));
    }

    if (!products) return res.status(422).json({ error: "No products found. Try rephrasing your search." });

    // Filter valid products and clean imageUrls
    const valid = products
      .filter(p => p && p.name && p.brand)
      .map(p => ({
        ...p,
        // Only keep imageUrl if it looks like a real CDN image URL
        imageUrl: isValidImageUrl(p.imageUrl) ? p.imageUrl : null
      }));

    res.json({ products: valid });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}

function isValidImageUrl(url) {
  if (!url || typeof url !== "string") return false;
  if (!url.startsWith("http")) return false;
  // Must end in an image extension (before any query string)
  const path = url.split("?")[0].toLowerCase();
  if (!path.match(/\.(jpg|jpeg|png|webp|gif)$/)) return false;
  // Must not be a product page (product pages don't end in image extensions but check anyway)
  return true;
}

function parseJson(text) {
  if (!text) return null;
  try { const r = JSON.parse(text.trim()); if (Array.isArray(r)) return r; } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { try { const r = JSON.parse(fenced[1].trim()); if (Array.isArray(r)) return r; } catch {} }
  const s = text.indexOf("["), e = text.lastIndexOf("]");
  if (s !== -1 && e > s) { try { const r = JSON.parse(text.slice(s, e + 1)); if (Array.isArray(r)) return r; } catch {} }
  return null;
}
