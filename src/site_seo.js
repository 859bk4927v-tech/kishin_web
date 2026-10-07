export const PUBLIC_PAGE_PATHS = [
  "/page/customer_page/home_page",
  "/page/customer_page/treatment_page",
  "/page/customer_page/price_page",
  "/page/customer_page/reservation_page"
];

const PRIVATE_PAGE_PATHS = [
  "/page/customer_page/reservation_complete_page",
  "/page/admin/admin_page"
];

export function publicOrigin(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function absoluteSchema(value, origin) {
  if (Array.isArray(value)) return value.map(item => absoluteSchema(item, origin));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, absoluteSchema(item, origin)]));
  }
  return typeof value === "string" && value.startsWith("/") ? `${origin}${value}` : value;
}

// Only marked metadata in our generated HTML is replaced; visible copy is untouched.
export function renderSeoHtml(html, origin, pathname, indexable) {
  const canonical = `${origin}${pathname}`;
  return html
    .replace(/<link rel="canonical" href="[^"]*"\s*\/>/, `<link rel="canonical" href="${escapeXml(canonical)}" />`)
    .replace(/<meta property="og:url" content="[^"]*"\s*\/>/, `<meta property="og:url" content="${escapeXml(canonical)}" />`)
    .replace(/<meta property="og:image" content="[^"]*"\s*\/>/, `<meta property="og:image" content="${escapeXml(origin)}/assets/og-image.png" />`)
    .replace(/<meta name="robots" content="[^"]*"\s*\/>/, `<meta name="robots" content="${indexable ? "index, follow, max-image-preview:large" : "noindex, nofollow"}" />`)
    .replace(/(<script type="application\/ld\+json" data-site-schema>)([\s\S]*?)(<\/script>)/g, (_, start, json, end) => {
      const schema = absoluteSchema(JSON.parse(json), origin);
      return `${start}\n${JSON.stringify(schema).replaceAll("<", "\\u003c")}\n${end}`;
    });
}

export class SiteSeo {
  static async handle(request, env) {
    const url = new URL(request.url);
    const configuredOrigin = publicOrigin(env.SITE_URL);
    const origin = configuredOrigin || url.origin;
    const published = configuredOrigin === url.origin;
    const headers = {
      "Cache-Control": "public, max-age=3600",
      ...(!published ? { "X-Robots-Tag": "noindex, nofollow" } : {})
    };

    if (url.pathname === "/robots.txt") {
      const rules = published
        ? `User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${origin}/sitemap.xml\n`
        : "User-agent: *\nDisallow: /\n";
      return new Response(rules, { headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });
    }
    if (url.pathname === "/sitemap.xml") {
      const entries = PUBLIC_PAGE_PATHS.map(path => `  <url><loc>${escapeXml(origin + path)}</loc></url>`).join("\n");
      return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`, {
        headers: { ...headers, "Content-Type": "application/xml; charset=utf-8" }
      });
    }

    const pathname = url.pathname.replace(/\.html\/?$/, "").replace(/\/$/, "");
    if (["", "/index"].includes(pathname)) {
      url.pathname = PUBLIC_PAGE_PATHS[0];
      return Response.redirect(url.href, 308);
    }
    const knownPage = [...PUBLIC_PAGE_PATHS, ...PRIVATE_PAGE_PATHS].includes(pathname);
    if (knownPage && pathname !== url.pathname) {
      url.pathname = pathname;
      return Response.redirect(url.href, 308);
    }

    const response = await env.ASSETS.fetch(request);
    const indexable = published && PUBLIC_PAGE_PATHS.includes(pathname);
    const resultHeaders = new Headers(response.headers);
    if (!indexable || !response.ok) resultHeaders.set("X-Robots-Tag", "noindex, nofollow");
    if (!knownPage || response.status !== 200 || !response.headers.get("Content-Type")?.includes("text/html")) {
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: resultHeaders });
    }
    // A response transformed for one host must not reuse the source asset validator.
    resultHeaders.delete("Content-Length");
    resultHeaders.delete("ETag");
    resultHeaders.delete("Last-Modified");
    resultHeaders.set("Cache-Control", "public, max-age=0, must-revalidate");
    const html = renderSeoHtml(await response.text(), origin, pathname, indexable);
    return new Response(html, { headers: resultHeaders });
  }
}
