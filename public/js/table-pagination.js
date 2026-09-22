/* =====================================================
   FARM BUDDIE GLOBAL TABLE PAGINATION + FILTER
   (Filter enabled only for Variant, Status, Farmer ID)
===================================================== */

function initTablePagination(tableSelector, rowsPerPage = 10) {

  const table = document.querySelector(tableSelector);
  if (!table) return;

  const tbody = table.querySelector("tbody");
  let rows = Array.from(tbody.querySelectorAll("tr"));

  const paginationContainer = document.getElementById("fbPagination");
  const startSpan = document.getElementById("fbStart");
  const endSpan = document.getElementById("fbEnd");
  const totalSpan = document.getElementById("fbTotal");

  if (!paginationContainer) return;

  let currentPage = 1;
  let filteredRows = [...rows];
  let activeFilters = {};

  /* ========================
     RENDER TABLE
  ======================== */
  function renderTable() {

    rows.forEach(row => row.style.display = "none");

    const total = filteredRows.length;
    const totalPages = Math.ceil(total / rowsPerPage);

    if (currentPage > totalPages) currentPage = 1;

    const start = (currentPage - 1) * rowsPerPage;
    const end = currentPage * rowsPerPage;

    filteredRows.slice(start, end).forEach(row => {
      row.style.display = "";
    });

    startSpan.textContent = total === 0 ? 0 : start + 1;
    endSpan.textContent = Math.min(end, total);
    totalSpan.textContent = total;

    renderPagination(totalPages);
  }

  /* ========================
     RENDER PAGINATION
  ======================== */
  function renderPagination(totalPages) {

    paginationContainer.innerHTML = "";

    const prevBtn = document.createElement("button");
    prevBtn.textContent = "Prev";
    prevBtn.className = "fb-page-btn";
    prevBtn.disabled = currentPage === 1;

    prevBtn.onclick = function () {
      currentPage--;
      renderTable();
    };

    paginationContainer.appendChild(prevBtn);

    for (let i = 1; i <= totalPages; i++) {

      const btn = document.createElement("button");
      btn.textContent = i;
      btn.className = "fb-page-btn";

      if (i === currentPage) btn.classList.add("active");

      btn.onclick = function () {
        currentPage = i;
        renderTable();
      };

      paginationContainer.appendChild(btn);
    }

    const nextBtn = document.createElement("button");
    nextBtn.textContent = "Next";
    nextBtn.className = "fb-page-btn";
    nextBtn.disabled = currentPage === totalPages || totalPages === 0;

    nextBtn.onclick = function () {
      currentPage++;
      renderTable();
    };

    paginationContainer.appendChild(nextBtn);
  }

  /* ========================
     APPLY FILTERS
  ======================== */
  function applyFilters() {

    filteredRows = rows.filter(function (row) {

      return Object.keys(activeFilters).every(function (colIndex) {

        const value = activeFilters[colIndex];
        if (!value) return true;

        const cell = row.children[colIndex];
        if (!cell) return true;

        return cell.textContent.toLowerCase().includes(value);
      });

    });

    currentPage = 1;
    renderTable();
  }

  /* ========================
     CLICK EVENTS
  ======================== */
  table.addEventListener("click", function (e) {

    const icon = e.target.closest(".fb-filter-icon");

    // Open dropdown
    if (icon) {

      const wrapper = icon.closest(".fb-th-wrapper");
      const dropdown = wrapper.querySelector(".fb-filter-dropdown");
      const colIndex = icon.dataset.col;

      table.querySelectorAll(".fb-filter-dropdown")
        .forEach(d => d.style.display = "none");

      dropdown.style.display = "block";

      if (!dropdown.innerHTML) {
        dropdown.innerHTML = `
          <div class="fb-filter-box">
            <input type="text"
                   class="fb-filter-input"
                   data-col="${colIndex}"
                   placeholder="Type to filter"
                   value="${activeFilters[colIndex] || ""}">
            <div class="fb-filter-actions">
              <button class="fb-apply-filter"
                      data-col="${colIndex}">
                Apply
              </button>
              <button class="fb-clear-filter"
                      data-col="${colIndex}">
                Clear
              </button>
            </div>
          </div>
        `;
      }

      return;
    }

    // Apply filter
    if (e.target.classList.contains("fb-apply-filter")) {

      const colIndex = e.target.dataset.col;
      const input = table.querySelector(
        `.fb-filter-input[data-col="${colIndex}"]`
      );

      if (!input) return;

      const value = input.value.toLowerCase().trim();

      if (value) {
        activeFilters[colIndex] = value;
        table.querySelector(
          `.fb-filter-icon[data-col="${colIndex}"]`
        )?.classList.add("active");
      } else {
        delete activeFilters[colIndex];
        table.querySelector(
          `.fb-filter-icon[data-col="${colIndex}"]`
        )?.classList.remove("active");
      }

      applyFilters();
      e.target.closest(".fb-filter-dropdown").style.display = "none";
      return;
    }

    // Clear filter
    if (e.target.classList.contains("fb-clear-filter")) {

      const colIndex = e.target.dataset.col;

      delete activeFilters[colIndex];

      table.querySelector(
        `.fb-filter-icon[data-col="${colIndex}"]`
      )?.classList.remove("active");

      applyFilters();
      e.target.closest(".fb-filter-dropdown").style.display = "none";
      return;
    }

    // Close dropdown if clicking outside
    if (!e.target.closest(".fb-th-wrapper")) {
      table.querySelectorAll(".fb-filter-dropdown")
        .forEach(d => d.style.display = "none");
    }

  });

  renderTable();
}
