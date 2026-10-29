import { getSettings, saveSettings } from "./settings.js";
export async function setTheme(theme) {
  const settings = await getSettings();
  settings.theme = ["light", "dark", "system"].includes(theme) ? theme : "system";
  await saveSettings(settings);
  window.gmmApplyTheme(settings.theme);
}
export function bindThemeToggle(button) {
  const names = { light: "ライト", dark: "ダーク", system: "システム" };
  function update() {
    const theme = document.documentElement.dataset.themePreference || "system";
    button.title = button.ariaLabel = `テーマ: ${names[theme]}（クリックで切替）`;
  }
  addEventListener("gmm-theme", update);
  update();
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const values = ["system", "light", "dark"];
      await setTheme(values[(values.indexOf(document.documentElement.dataset.themePreference) + 1) % 3]);
    } finally { button.disabled = false; }
  });
}
