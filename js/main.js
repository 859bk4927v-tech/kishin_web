// Coordinates behavior shared by all pages.
class SiteApplication {
  constructor(documentRoot = document) {
    this.document = documentRoot;
    this.header = this.document.getElementById("siteHeader");
    this.year = this.document.getElementById("year");
  }

  start() {
    appJa.apply(this.document);
    this.bindHeaderScroll();
    this.updateCopyrightYear();
  }

  bindHeaderScroll() {
    if (!this.header) return;
    const updateHeader = () => this.header.classList.toggle("is-scrolled", window.scrollY > 8);
    window.addEventListener("scroll", updateHeader, { passive: true });
    updateHeader();
  }

  updateCopyrightYear() {
    if (this.year) this.year.textContent = new Date().getFullYear();
  }
}

new SiteApplication().start();
