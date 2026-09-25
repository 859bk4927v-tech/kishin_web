// Provides shared navigation data and URL rules for site components.
class SiteNavigation {
  static pages = [
    ["home", appJa.strings.navigation.home, "home_page.html"],
    ["price", appJa.strings.navigation.price, "price_page.html"],
    ["treatment", appJa.strings.navigation.treatment, "treatment_page.html"],
    ["reservation", appJa.strings.navigation.reservation, "reservation_page.html"]
  ];

  static pageHref(activePage, href) {
    return activePage === "admin" ? `../customer_page/${href}` : href;
  }

  static homeHref(activePage) {
    return activePage === "admin" ? "../customer_page/home_page.html" : "home_page.html";
  }
}
