// Blocking, external initialization: cached preference is applied before styles paint.
(() => {
  const valid = value => ["light", "dark", "system"].includes(value) ? value : "system";
  const media = matchMedia("(prefers-color-scheme: dark)");
  let preference = "system";
  function apply(value) {
    preference = valid(value);
    document.documentElement.dataset.theme = preference === "system" ? (media.matches ? "dark" : "light") : preference;
    document.documentElement.dataset.themePreference = preference;
    try { localStorage.setItem("gmm-theme", preference); } catch {}
    dispatchEvent(new CustomEvent("gmm-theme", { detail: preference }));
  }
  try { apply(localStorage.getItem("gmm-theme")); } catch { apply("system"); }
  media.addEventListener("change", () => apply(preference));
  chrome.storage.local.get("settings").then(({settings}) => apply(settings?.theme));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) apply(changes.settings.newValue?.theme);
  });
  window.gmmApplyTheme = apply;
})();
