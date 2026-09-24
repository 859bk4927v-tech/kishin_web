//  мобильなブラウザ向けメニュー
const navToggle = document.getElementById("navToggle");
const globalNav = document.getElementById("globalNav");

navToggle.addEventListener("click", () => {
  const isOpen = globalNav.classList.toggle("is-open");
  navToggle.classList.toggle("is-open", isOpen);
  navToggle.setAttribute("aria-expanded", String(isOpen));
  navToggle.setAttribute("aria-label", isOpen ? "メニューを閉じる" : "メニューを開く");
});

globalNav.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => {
    globalNav.classList.remove("is-open");
    navToggle.classList.remove("is-open");
    navToggle.setAttribute("aria-expanded", "false");
    navToggle.setAttribute("aria-label", "メニューを開く");
  });
});

// ヘッダーに影をつけた閉じる（スクロール時）
const header = document.getElementById("siteHeader");
const onScroll = () => header.classList.toggle("is-scrolled", window.scrollY > 8);
window.addEventListener("scroll", onScroll, { passive: true });
onScroll();

// フッターの西暦
document.getElementById("year").textContent = new Date().getFullYear();
