// Phone layout for the admin pages (see /css/admin-mobile.css): adds the
// menu button to the top bar and opens/closes the sidebar as a drawer.
(function () {
  function init() {
    var body = document.body;
    var sidebar = document.querySelector(".fb-sidebar");
    if (!sidebar || document.querySelector(".fb-menu-toggle")) return;

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "fb-menu-toggle";
    btn.setAttribute("aria-label", "Open menu");
    btn.setAttribute("aria-expanded", "false");
    btn.textContent = "☰";

    var topbar = document.querySelector(".fb-topbar");
    if (topbar) {
      topbar.insertBefore(btn, topbar.firstChild);
    } else {
      // Pages without a top bar get a minimal one so the menu is reachable.
      var main = document.querySelector(".fb-main") || body;
      var bar = document.createElement("header");
      bar.className = "fb-topbar";
      bar.appendChild(btn);
      var title = document.createElement("h1");
      title.textContent = document.title.split("|")[0].trim();
      bar.appendChild(title);
      main.insertBefore(bar, main.firstChild);
    }

    var backdrop = document.createElement("div");
    backdrop.className = "fb-nav-backdrop";
    body.appendChild(backdrop);

    function setOpen(open) {
      body.classList.toggle("fb-nav-open", open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    }

    btn.addEventListener("click", function () {
      setOpen(!body.classList.contains("fb-nav-open"));
    });
    backdrop.addEventListener("click", function () { setOpen(false); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") setOpen(false);
    });
    sidebar.addEventListener("click", function (e) {
      if (e.target.closest("a")) setOpen(false);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
