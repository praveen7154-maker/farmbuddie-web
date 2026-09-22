/* =====================================================
   HR CONNECT MAIN NAVIGATION
===================================================== */

document.addEventListener("DOMContentLoaded", () => {

  const cards = document.querySelectorAll("[data-route]");

  cards.forEach(card => {
    card.addEventListener("click", () => {

      const page = card.dataset.route;

      if (!page) return;

      window.location.href = `/admin/hr/${page}.html`;

    });
  });

});
