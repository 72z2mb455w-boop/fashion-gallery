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
  if (!beeKey) return res.status(500).json({ error: "SCRAPINGBEE_API_KEY not set — add it in Vercel environment variables" });

  try {
    // STEP 1: Single Claude call — identify brands, category, and collection URLs
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
          content: `Given this fashion search request: "${prompt}"

Return a JSON array of collection page URLs to scrape — one per brand.
Use the brand's official website collection/category page that matches the request.

Examples:
- "graphic tees from Celine" → https://www.celine.com/en-us/women/ready-to-wear/t-shirts-and-sweatshirts/
- "shoes from Loewe" → https://www.loewe.com/int/en/women/shoes/
- "outerwear from Jacquemus" → https://www.jacquemus.com/en_gb/jackets-and-coats/
- "dresses from The Row" → https://www.therow.com/en-us/women/clothing/dresses/
- "knitwear from Bottega Veneta" → https://www.bottegaveneta.com/en-gb/clothing/knitwear/

Return ONLY a JSON array like:
[
  {"brand": "Celine", "url": "https://..."},
  {"brand": "Loewe", "url": "https://..."}
]

No markdown, no explanation. Raw JSON array only.`
        }]
      })
    });

    const d1 = await r1.json();
    if (d1.error) throw new Error(d1.error.message);

    const urlText = (d1.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    const brandUrls = parseJson(urlText);
    if (!brandUrls || brandUrls.length === 0) throw new Error("Could not identify brands or collection pages from your prompt.");

    // STEP 2: For each brand URL, use ScrapingBee to render the page and extract products
    const allProducts = [];

    await Promise.all(brandUrls.map(async ({ brand, url }) => {
      try {
        // ScrapingBee renders the page with a real Chrome browser
        // extract_rules pulls product data directly from the rendered DOM
        const beeUrl = "https://app.scrapingbee.com/api/v1/?" + new URLSearchParams({
          api_key: beeKey,
          url: url,
          render_js: "true",
          wait: "3000", // wait 3s for JS to load images
          extract_rules: JSON.stringify({
            products: {
              selector: "a[href]",
              type: "list",
              output: {
                name: "img @alt",
                image: "img @src",
                link: "@href"
              }
            }
          })
        });

        const beeRes = await fetch(beeUrl);
        const beeText = await beeRes.text();

        let beeData;
        try { beeData = JSON.parse(beeText); } catch {
          console.error("ScrapingBee non-JSON response:", beeText.slice(0, 200));
          throw new Error("ScrapingBee returned invalid response");
        }

        if (!beeRes.ok) {
          throw new Error(`ScrapingBee error: ${beeData.message || beeRes.status}`);
        }

        // Filter extracted items to only real product images
        const items = (beeData.products || []).filter(item => {
          if (!item.image || !item.name || !item.link) return false;
          if (!item.image.startsWith("http")) return false;
          // Skip tiny tracking pixels, SVGs, logos
          if (item.image.includes(".svg")) return false;
          if (item.image.includes("logo")) return false;
          if (item.image.includes("icon")) return false;
          if (item.name.length < 3) return false;
          return true;
        });

        // Deduplicate by image URL, take first 8
        const seen = new Set();
        const unique = [];
        for (const item of items) {
          const key = item.image;
          if (!seen.has(key)) {
            seen.add(key);
            // Make relative links absolute
            const productUrl = item.link.startsWith("http")
              ? item.link
              : new URL(item.link, url).href;
            unique.push({
              brand,
              name: item.name.trim(),
              imageUrl: item.image,
              productUrl
            });
          }
          if (unique.length >= 8) break;
        }

        allProducts.push(...unique);

      } catch (e) {
        console.error(`Failed to scrape ${brand}:`, e.message);
        // Don't fail the whole request — just skip this brand
        allProducts.push({
          brand,
          name: `Could not load ${brand} products`,
          imageUrl: null,
          productUrl: url,
          error: e.message
        });
      }
    }));

    if (allProducts.length === 0) {
      return res.status(422).json({ error: "No products found. The brands' websites may be blocking scraping." });
    }

    res.json({ products: allProducts, brandUrls });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
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
