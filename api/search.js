export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { prompt } = req.body || {};
  if (!prompt) return res.status(400).json({ error: "No prompt" });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const beeKey = process.env.SCRAPINGBEE_API_KEY;

  if (!anthropicKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });
  if (!beeKey) return res.status(500).json({ error: "SCRAPINGBEE_API_KEY not set" });

  try {
    // STEP 1: Claude identifies collection URLs for each brand
    const r1 = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: [{
          role: "user",
          content: `Given this fashion search: "${prompt}"

Identify each brand and the exact collection page URL on their official site that matches the category requested.

Return ONLY a raw JSON array:
[{"brand":"Celine","url":"https://www.celine.com/en-us/women/ready-to-wear/t-shirts-and-sweatshirts/"},...]

Use real, working collection page URLs you know from training data.
No markdown, no explanation.`
        }]
      })
    });

    const d1 = await r1.json();
    if (d1.error) throw new Error(d1.error.message);
    const urlText = (d1.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    const brandUrls = parseJson(urlText);
    if (!brandUrls || brandUrls.length === 0) throw new Error("Could not identify brands from your prompt.");

    // STEP 2: ScrapingBee renders each page, then Claude extracts products from the HTML
    const allProducts = [];

    await Promise.all(brandUrls.map(async ({ brand, url }) => {
      try {
        // Fetch fully rendered HTML via ScrapingBee
        const params = new URLSearchParams({
          api_key: beeKey,
          url: url,
          render_js: "true",
          wait: "4000",
          block_ads: "true",
          block_resources: "false"
        });

        const beeRes = await fetch(`https://app.scrapingbee.com/api/v1/?${params}`);

        if (!beeRes.ok) {
          const errText = await beeRes.text();
          throw new Error(`ScrapingBee ${beeRes.status}: ${errText.slice(0, 200)}`);
        }

        const html = await beeRes.text();

        if (html.length < 500) {
          throw new Error(`Page returned empty or blocked (${html.length} bytes)`);
        }

        // Extract just the relevant parts of the HTML to save tokens
        // Look for JSON-LD product data, og:image, and img tags
        const trimmedHtml = extractRelevantHtml(html, url);

        // STEP 3: Claude reads the HTML and extracts products
        const r2 = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": anthropicKey,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: 2000,
            messages: [{
              role: "user",
              content: `Extract fashion products from this rendered HTML of ${brand}'s website (${url}).

Find product listings with their names and image URLs. Images will be in <img> tags, background-image CSS, or JSON-LD data.

Return ONLY a JSON array (max 8 items):
[{"name":"Product Name","imageUrl":"https://...jpg","productUrl":"https://...","price":"£000"}]

Rules:
- imageUrl must be a full https:// URL ending in .jpg .jpeg .png or .webp
- productUrl must be a full https:// URL to the product page
- If relative URLs, make them absolute using base: ${new URL(url).origin}
- Skip navigation, banners, logos — only actual product images
- If no products found return []

HTML:
${trimmedHtml}`
            }]
          })
        });

        const d2 = await r2.json();
        if (d2.error) throw new Error(d2.error.message);

        const productText = (d2.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
        const products = parseJson(productText);

        if (products && products.length > 0) {
          products.forEach(p => {
            if (p.name && (p.imageUrl || p.productUrl)) {
              allProducts.push({
                brand,
                name: p.name,
                imageUrl: p.imageUrl || null,
                productUrl: p.productUrl || url,
                price: p.price || null
              });
            }
          });
        } else {
          throw new Error("No products found on page — site may require login or block scraping");
        }

      } catch (e) {
        console.error(`${brand} failed:`, e.message);
        allProducts.push({
          brand,
          name: `${brand} — ${e.message}`,
          imageUrl: null,
          productUrl: url,
          error: true
        });
      }
    }));

    const valid = allProducts.filter(p => !p.error);
    if (valid.length === 0) {
      const errors = allProducts.map(p => `${p.brand}: ${p.name}`).join("; ");
      return res.status(422).json({ error: `Could not load products. ${errors}` });
    }

    res.json({ products: allProducts, brandUrls });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}

function extractRelevantHtml(html, url) {
  // Extract the most useful parts to reduce token usage:
  // 1. JSON-LD product schema
  // 2. All img tags with src
  // 3. All anchor tags with href that look like products
  // Limit to 15000 chars

  const parts = [];

  // JSON-LD schemas (often contain full product data)
  const jsonLdMatches = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi) || [];
  jsonLdMatches.forEach(m => parts.push(m));

  // Meta og:image
  const ogImages = html.match(/<meta[^>]*og:image[^>]*>/gi) || [];
  ogImages.forEach(m => parts.push(m));

  // All img tags
  const imgs = html.match(/<img[^>]+>/gi) || [];
  imgs.slice(0, 100).forEach(m => parts.push(m));

  // Anchor tags that look like product links
  const anchors = html.match(/<a[^>]+href="[^"]*(?:product|item|p\/|\/en\/)[^"]*"[^>]*>[\s\S]{0,200}<\/a>/gi) || [];
  anchors.slice(0, 50).forEach(m => parts.push(m));

  const combined = parts.join("\n").slice(0, 15000);
  return combined || html.slice(0, 15000);
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
