import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { PUBLIC_PAGE_PATHS, SiteSeo, publicOrigin } from "../src/site_seo.js";

const origin = "https://yomon.example";
const read = path => fs.readFileSync(new URL(`../public${path}.html`, import.meta.url), "utf8");
const env = (siteUrl = origin) => ({
  SITE_URL: siteUrl,
  ASSETS: { async fetch(request) {
    const path = new URL(request.url).pathname;
    try {
      return new Response(read(path), { headers: { "Content-Type": "text/html; charset=utf-8", ETag: "source-asset" } });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  } }
});

test("initial HTML includes clinic, symptom descriptions, menu prices and crawlable navigation without JavaScript", () => {
  const home = read(PUBLIC_PAGE_PATHS[0]);
  assert.match(home, /首・肩の痛み・眼精疲労<\/h3>/);
  assert.match(home, /妊活中のお悩みをご相談ください/);
  assert.match(home, /href="price_page"[^>]*>料金<\/a>/);
  assert.match(home, /いわき市小名浜の地域密着鍼灸院/);
  assert.match(home, /Instagram : @yomon_harikyu/);
  assert.match(home, /9:00~24:00/);
  const price = read(PUBLIC_PAGE_PATHS[2]);
  for (const amount of ["7,000", "6,000", "9,000"]) assert.ok(price.includes(amount));
  assert.ok(!/data-app-ja="[^"]+"><\//.test(home));
});

test("published pages emit one absolute canonical, social preview and valid business schema, excluding tracking queries", async () => {
  for (const path of PUBLIC_PAGE_PATHS) {
    const response = await SiteSeo.handle(new Request(`${origin}${path}?utm_source=instagram`), env());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-Robots-Tag"), null);
    assert.equal(response.headers.get("ETag"), null);
    const html = await response.text();
    assert.equal((html.match(/rel="canonical"/g) || []).length, 1);
    assert.ok(html.includes(`<link rel="canonical" href="${origin}${path}" />`));
    assert.ok(html.includes(`<meta property="og:url" content="${origin}${path}" />`));
    assert.ok(html.includes(`content="${origin}/assets/og-image.png"`));
    assert.match(html, /name="robots" content="index, follow, max-image-preview:large"/);
    const data = JSON.parse(html.match(/data-site-schema>([\s\S]*?)<\/script>/)[1]);
    assert.equal(data["@graph"][0].url, `${origin}${path}`);
    if (path === PUBLIC_PAGE_PATHS[0]) {
      const clinic = data["@graph"].find(item => item["@type"] === "MedicalBusiness");
      assert.equal(clinic.address.addressLocality, "いわき市");
      assert.deepEqual(clinic.sameAs, ["https://www.instagram.com/yomon_harikyu/"]);
      assert.equal(clinic.openingHoursSpecification[0].opens, "09:00");
      assert.equal(clinic.openingHoursSpecification[0].closes, "00:00");
      assert.equal(clinic.openingHoursSpecification[1].dayOfWeek, "Friday");
      assert.deepEqual(clinic.hasOfferCatalog.itemListElement.map(item => item.price), [7000, 6000, 9000]);
    }
  }
});

test("sitemap contains only canonical public pages that return 200, while robots advertises it", async () => {
  const response = await SiteSeo.handle(new Request(`${origin}/sitemap.xml`), env());
  const xml = await response.text();
  const locations = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1]);
  assert.deepEqual(locations, PUBLIC_PAGE_PATHS.map(path => origin + path));
  for (const location of locations) assert.equal((await SiteSeo.handle(new Request(location), env())).status, 200);
  assert.ok(!xml.includes(".html") && !xml.includes("admin") && !xml.includes("complete"));
  const robots = await (await SiteSeo.handle(new Request(`${origin}/robots.txt`), env())).text();
  assert.ok(robots.includes(`Sitemap: ${origin}/sitemap.xml`));
  assert.ok(robots.includes("Allow: /"));
  assert.ok(!robots.includes("Disallow: /\n"));
});

test("local, preview and unconfigured sites cannot be indexed even with production canonical URLs", async () => {
  for (const [requestOrigin, siteUrl] of [[origin, ""], ["http://127.0.0.1:8002", origin], ["https://preview.workers.dev", origin]]) {
    const response = await SiteSeo.handle(new Request(requestOrigin + PUBLIC_PAGE_PATHS[0]), env(siteUrl));
    assert.equal(response.headers.get("X-Robots-Tag"), "noindex, nofollow");
    assert.match(await response.text(), /name="robots" content="noindex, nofollow"/);
    const robots = await (await SiteSeo.handle(new Request(`${requestOrigin}/robots.txt`), env(siteUrl))).text();
    assert.equal(robots, "User-agent: *\nDisallow: /\n");
  }
});

test("admin, receipt and missing pages stay out of search on the production domain", async () => {
  for (const path of ["/page/admin/admin_page", "/page/customer_page/reservation_complete_page", "/page/missing"]) {
    const response = await SiteSeo.handle(new Request(origin + path), env());
    assert.equal(response.headers.get("X-Robots-Tag"), "noindex, nofollow");
    if (response.ok) assert.match(await response.text(), /name="robots" content="noindex, nofollow"/);
    else assert.equal(response.status, 404);
  }
});

test("old .html links, trailing slashes and root permanently redirect while preserving booking parameters", async () => {
  for (const path of PUBLIC_PAGE_PATHS) {
    for (const suffix of [".html", "/"]) {
      const response = await SiteSeo.handle(new Request(`${origin}${path}${suffix}?from=line`), env());
      assert.equal(response.status, 308);
      assert.equal(response.headers.get("Location"), `${origin}${path}?from=line`);
    }
  }
  for (const path of ["/", "/index.html"]) {
    const response = await SiteSeo.handle(new Request(origin + path), env());
    assert.equal(response.status, 308);
    assert.equal(response.headers.get("Location"), origin + PUBLIC_PAGE_PATHS[0]);
  }
});

test("static generation is up to date and reproducible", () => {
  execFileSync(process.execPath, ["scripts/render_static.mjs", "--check"], { cwd: new URL("../", import.meta.url) });
});

test("canonical origin requires HTTPS and no path, credentials, query or fragment", () => {
  assert.equal(publicOrigin(origin + "/"), origin);
  for (const value of ["", "broken", "http://example.com", "https://u:p@example.com", `${origin}/page`, `${origin}?x=1`, `${origin}#x`]) {
    assert.equal(publicOrigin(value), null);
  }
});
