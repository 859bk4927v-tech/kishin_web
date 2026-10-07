// Web Component responsible for rendering the always-visible site navigation.
class SiteHeader extends HTMLElement {
  static callsToAction = {
    home: { label: appJa.strings.actions.book, href: "reservation_page.html" },
    price: { label: appJa.strings.actions.book, href: "reservation_page.html" },
    treatment: { label: appJa.strings.actions.book, href: "reservation_page.html" },
    reservation: { label: appJa.strings.actions.call, href: appJa.strings.phoneHref },
    admin: null
  };

  connectedCallback() {
    if (this.dataset.rendered !== "true") this.render();
    this.dataset.rendered = "true";
  }

  render() {
    this.activePage = this.getAttribute("active-page");
    const currentPage = SiteNavigation.pages.some(([key]) => key === this.activePage) ? this.activePage : "";
    const cta = SiteHeader.callsToAction[currentPage || this.activePage] || null;
    const links = SiteNavigation.pages.map(([key, label, href]) => {
      const active = key === currentPage;
      const currentAttribute = active ? ' class="is-active" aria-current="page"' : "";
      return `<li><a href="${SiteNavigation.pageHref(this.activePage, href)}"${currentAttribute}>${label}</a></li>`;
    }).join("");

    this.innerHTML = `
      <header class="site-header" id="siteHeader">
        <div class="container header-inner">
          <a class="brand" href="${SiteNavigation.homeHref(this.activePage)}" aria-label="${appJa.strings.actions.clinicHome}">
            <img class="brand-logo" src="../../assets/yomon_mark.svg" alt="" width="69" height="70" />
            <span class="brand-copy">
              <span class="brand-name">${appJa.strings.shopName}</span>
              <span class="brand-sub">${appJa.strings.headerDescription}</span>
            </span>
          </a>
          <nav class="global-nav" id="globalNav" aria-label="${appJa.strings.actions.mainNavigation}"><ul>${links}</ul></nav>
          ${cta ? `<a class="btn btn-primary nav-cta" href="${cta.href}">${cta.label}</a>` : ""}
        </div>
      </header>`;
  }

}

if (!customElements.get("site-header")) customElements.define("site-header", SiteHeader);
