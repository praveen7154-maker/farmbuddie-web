// The Excel library (~900 KB) is needed only for Export / Import / the
// upload template - loaded on the first click instead of blocking every
// page load. Usage: const XLSX = await window.loadXlsx();
(function () {
  let loading = null;
  window.loadXlsx = function () {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (!loading) {
      loading = new Promise(function (resolve, reject) {
        const s = document.createElement("script");
        s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
        s.onload = function () { resolve(window.XLSX); };
        s.onerror = function () { loading = null; reject(new Error("Couldn't load the Excel library - check the internet connection")); };
        document.head.appendChild(s);
      });
    }
    return loading;
  };
})();
