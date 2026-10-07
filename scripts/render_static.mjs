import fs from "node:fs";
import vm from "node:vm";
import { PUBLIC_PAGE_PATHS } from "../src/site_seo.js";

const root = new URL("../", import.meta.url);
const read = path => fs.readFileSync(new URL(path, root), "utf8");
const sandbox = vm.createContext({
  HTMLElement: class { getAttribute(name) { return this.attributes[name]; } },
  customElements: { get() {}, define() {} }
});
sandbox.window = sandbox;
for (const path of ["app_ja.js", "component/shared_component.js", "component/header_component.js", "component/footer_component.js"]) {
  vm.runInContext(read(`public/js/${path}`), sandbox);
}
const copy = sandbox.appJa.strings;

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function component(name, page) {
  const instance = vm.runInContext(`new ${name}()`, sandbox);
  instance.attributes = { "active-page": page };
  instance.render();
  return instance.innerHTML.trim();
}

function staticCopy(html) {
  html = html.replace(/<([a-z][\w-]*)\b([^>]*\bdata-app-ja="([^"]+)"[^>]*)>[\s\S]*?<\/\1>/g, (_, tag, attrs, path) => {
    const text = sandbox.appJa.text(path);
    if (text === path) throw new Error(`Unknown copy key: ${path}`);
    return `<${tag}${attrs}>${escapeHtml(text)}</${tag}>`;
  });
  return html.replace(/<[^>]+\bdata-app-ja-attr="([^"]+)"[^>]*>/g, (tag, bindings) => {
    for (const pair of bindings.split(",")) {
      const [attribute, path] = pair.split(":");
      const value = escapeHtml(sandbox.appJa.attribute(path, attribute));
      const pattern = new RegExp(`(\\s${attribute}=")[^"]*"`);
      tag = pattern.test(tag) ? tag.replace(pattern, (_, prefix) => `${prefix}${value}"`) : tag.replace(/\s*\/?>$/, ending => ` ${attribute}="${value}"${ending}`);
    }
    return tag;
  });
}

function formatHtmlText(html) {
  const protectedBlocks = [];
  html = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, block => {
    const placeholder = `KISHINPROTECTEDBLOCK${protectedBlocks.length}END`;
    protectedBlocks.push(block);
    return placeholder;
  });
  html = html.split(/(<[^>]*>)/g).map((part, index) => index % 2 ? part : sandbox.appJa.format(part)).join("");
  return html.replace(/KISHINPROTECTEDBLOCK(\d+)END/g, (_, index) => protectedBlocks[Number(index)]);
}

function schema(path, title, description) {
  const home = PUBLIC_PAGE_PATHS[0];
  const clinicId = `${home}#clinic`;
  const websiteId = `${home}#website`;
  const page = {
    "@type": "WebPage", "@id": `${path}#webpage`, url: path, name: title,
    description, inLanguage: "ja", isPartOf: { "@id": websiteId }, about: { "@id": clinicId }
  };
  const graph = [page];
  if (path === home) {
    graph.push({
      "@type": "WebSite", "@id": websiteId, url: home, name: copy.shopName,
      inLanguage: "ja", publisher: { "@id": clinicId }
    }, {
      "@type": "MedicalBusiness", "@id": clinicId, url: home, name: copy.shopName,
      description: copy.pageMeta.homeDescription,
      telephone: "+81-70-8573-8131", email: copy.email,
      logo: "/assets/yomon_mark.svg", image: "/assets/og-image.png",
      address: {
        "@type": "PostalAddress", streetAddress: "小名浜諏訪町22-3", addressLocality: "いわき市",
        addressRegion: "福島県", postalCode: "971-8161", addressCountry: "JP"
      },
      geo: { "@type": "GeoCoordinates", latitude: 36.953184, longitude: 140.905356 },
      openingHoursSpecification: [{
        "@type": "OpeningHoursSpecification",
        dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Saturday", "Sunday"],
        opens: "09:00", closes: "00:00"
      }, {
        "@type": "OpeningHoursSpecification", dayOfWeek: "Friday", opens: "00:00", closes: "00:00"
      }],
      priceRange: "JPY 6,000~9,000", currenciesAccepted: "JPY", paymentAccepted: "Cash",
      sameAs: [copy.homePage.instagramHref],
      employee: { "@type": "Person", name: copy.directorName.split("(")[0], jobTitle: copy.directorRole },
      hasOfferCatalog: {
        "@type": "OfferCatalog", name: "施術料金", itemListElement: [
          ["firstVisit", 7000], ["followup60", 6000], ["followup90", 9000]
        ].map(([key, price]) => ({
          "@type": "Offer", price, priceCurrency: "JPY",
          url: PUBLIC_PAGE_PATHS[2], itemOffered: { "@type": "Service", name: copy.menus[key] }
        }))
      }
    });
  } else {
    graph.push({
      "@type": "BreadcrumbList", itemListElement: [
        { "@type": "ListItem", position: 1, name: "ホーム", item: home },
        { "@type": "ListItem", position: 2, name: title.split("|")[0], item: path }
      ]
    });
  }
  return { "@context": "https://schema.org", "@graph": graph };
}

function metadata(html, path, key) {
  const title = sandbox.appJa.text(`pageMeta.${key}Title`);
  const description = sandbox.appJa.text(`pageMeta.${key}Description`);
  const meta = `  <link rel="canonical" href="${path}" />
  <meta name="robots" content="index, follow, max-image-preview:large" />
  <meta property="og:type" content="website" />
  <meta property="og:locale" content="ja_JP" />
  <meta property="og:site_name" content="${escapeHtml(copy.shopName)}" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:url" content="${path}" />
  <meta property="og:image" content="/assets/og-image.png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="よもん はりきゅう治療院 - いわき市小名浜の鍼灸院" />
  <meta name="twitter:card" content="summary_large_image" />
  <script type="application/ld+json" data-site-schema>
${JSON.stringify(schema(path, title, description), null, 2).replaceAll("<", "\\u003c")}
  </script>`;
  html = html.replace(/\s*<(?:link rel="canonical"|meta (?:property="og:[^"]+"|name="(?:robots|twitter:card)"))[^>]*>/g, "");
  html = html.replace(/\s*<script type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/g, "");
  return html.replace(/\s*(<link rel="icon")/, `\n${meta}\n  $1`);
}

const check = process.argv.includes("--check");
let changed = 0;
const pages = [
  ...PUBLIC_PAGE_PATHS.map(path => [`public${path}.html`, path.split("/").at(-1).replace("_page", "")]),
  ["public/page/customer_page/reservation_complete_page.html", "reservation"],
  ["public/page/admin/admin_page.html", "admin"]
];
for (const [path, page] of pages) {
  const source = read(path);
  let html = source.replace(/<site-(header|footer)\b[^>]*>[\s\S]*?<\/site-\1>/g, (_, kind) => {
    const name = kind === "header" ? "SiteHeader" : "SiteFooter";
    return `<site-${kind} active-page="${page}" data-rendered="true">\n${component(name, page)}\n  </site-${kind}>`;
  });
  html = formatHtmlText(staticCopy(html));
  html = html.replace(/(href="(?:\.\.\/customer_page\/)?[\w]+_page)\.html(?=["#?])/g, "$1");
  const publicPath = `/${path.replace(/^public\//, "").replace(/\.html$/, "")}`;
  if (PUBLIC_PAGE_PATHS.includes(publicPath)) html = metadata(html, publicPath, page);
  html = html.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  if (html !== source) {
    changed++;
    if (!check) fs.writeFileSync(new URL(path, root), html);
  }
}
if (check && changed) {
  console.error(`Static HTML is out of date (${changed} pages). Run npm run build:static.`);
  process.exitCode = 1;
} else {
  console.log(`${check ? "Checked" : "Rendered"} ${pages.length} pages; ${changed} updated.`);
}
