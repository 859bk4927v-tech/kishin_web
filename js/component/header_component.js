// Web Component responsible for rendering and controlling the site header.
class SiteHeader extends HTMLElement {
  static callsToAction = {
    home: { label: appJa.strings.actions.book, href: "reservation_page.html" },
    price: { label: appJa.strings.actions.book, href: "reservation_page.html" },
    treatment: { label: appJa.strings.actions.book, href: "reservation_page.html" },
    reservation: { label: appJa.strings.actions.call, href: `tel:${appJa.strings.phoneLink}` },
    admin: null
  };

  connectedCallback() {
    if (this.dataset.rendered === "true") return;
    this.render();
    this.bindNavigationEvents();
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
            <img class="brand-logo" src="../../assets/yomon_logo.svg" alt="" />
            <span class="brand-copy">
              <span class="brand-name">${appJa.strings.shopName}</span>
              <span class="brand-sub">${appJa.strings.shopBrand}</span>
            </span>
          </a>
          <nav class="global-nav" id="globalNav" aria-label="${appJa.strings.actions.mainNavigation}"><ul>${links}</ul></nav>
          ${cta ? `<a class="btn btn-primary nav-cta" href="${cta.href}">${cta.label}</a>` : ""}
          <button class="nav-toggle" id="navToggle" type="button" aria-expanded="false" aria-controls="globalNav" aria-label="${appJa.strings.actions.menuOpen}">
            <span></span><span></span><span></span>
          </button>
        </div>
      </header>`;
  }

  bindNavigationEvents() {
    this.nav = this.querySelector("#globalNav");
    this.toggle = this.querySelector("#navToggle");
    this.toggle.addEventListener("click", () => this.toggleMenu());
    this.nav.querySelectorAll("a").forEach((link) => link.addEventListener("click", () => this.closeMenu()));
  }

  toggleMenu() {
    const isOpen = this.nav.classList.toggle("is-open");
    this.toggle.classList.toggle("is-open", isOpen);
    this.toggle.setAttribute("aria-expanded", String(isOpen));
    this.toggle.setAttribute("aria-label", isOpen ? appJa.strings.actions.menuClose : appJa.strings.actions.menuOpen);
  }

  closeMenu() {
    this.nav.classList.remove("is-open");
    this.toggle.classList.remove("is-open");
    this.toggle.setAttribute("aria-expanded", "false");
    this.toggle.setAttribute("aria-label", appJa.strings.actions.menuOpen);
  }
}

if (!customElements.get("site-header")) customElements.define("site-header", SiteHeader);
