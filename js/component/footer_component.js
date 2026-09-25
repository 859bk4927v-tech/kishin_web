// Web Component responsible for rendering the clinic footer.
class SiteFooter extends HTMLElement {
  connectedCallback() {
    if (this.dataset.rendered === "true") return;
    this.render();
    this.dataset.rendered = "true";
  }

  render() {
    this.activePage = this.getAttribute("active-page");
    const links = SiteNavigation.pages.map(([key, label, href]) => {
      const active = key === this.activePage;
      const currentAttribute = active ? ' aria-current="page"' : "";
      return `<a href="${SiteNavigation.pageHref(this.activePage, href)}"${currentAttribute}>${label}</a>`;
    }).join("");
    const copy = appJa.strings;

    this.innerHTML = `
      <footer class="site-footer">
        <div class="container">
          <div class="footer-grid">
            <div>
              <a class="brand" href="${SiteNavigation.homeHref(this.activePage)}" aria-label="${copy.actions.clinicHome}">
                <span class="brand-name">${copy.shopName}</span>
                <span class="brand-sub">${copy.shopBrand}</span>
              </a>
              <p class="footer-tagline">${copy.tagline}</p>
            </div>
            <div>
              <h2 class="footer-title">${copy.navigation.menuTitle}</h2>
              <nav class="footer-nav" aria-label="${copy.actions.footerNavigation}">${links}</nav>
            </div>
            <div>
              <h2 class="footer-title">${copy.navigation.contactTitle}</h2>
              <p class="footer-contact">
                ${copy.contactLabels.address}：${copy.address}<br />
                ${copy.contactLabels.director}：${copy.directorName}<br />
                ${copy.contactLabels.phone}：<a href="tel:${copy.phoneLink}">${copy.phone}</a><br />
                ${copy.contactLabels.email}：<a href="mailto:${copy.email}">${copy.email}</a><br />
                ${copy.contactLabels.businessHours}：${copy.businessHours}<br />
                ${copy.contactLabels.closedDays}：${copy.closedDays}
              </p>
            </div>
          </div>
          <p class="footer-copy">© <span id="year">2026</span> ${copy.copyright}</p>
        </div>
      </footer>`;
  }
}

if (!customElements.get("site-footer")) customElements.define("site-footer", SiteFooter);
