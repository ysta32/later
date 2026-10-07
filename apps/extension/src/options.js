const api = globalThis.browser ?? chrome;
const server = document.querySelector("#server");
const token = document.querySelector("#token");
const status = document.querySelector("#status");

api.storage.sync.get({ serverUrl: "http://localhost:4800", token: "" }).then(
  (settings) => {
    server.value = settings.serverUrl;
    token.value = settings.token;
  },
  () => {
    status.textContent = "Could not load settings.";
  },
);

document.querySelector("#settings").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const url = new URL(server.value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("Enter an HTTP or HTTPS server URL without credentials.");
    }
    if (!token.value.trim()) throw new Error("Enter an API token.");
    // Request directly during the user gesture, before any asynchronous storage work.
    const granted = await api.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] });
    if (!granted) throw new Error("Server access was denied. Settings were not saved.");
    await api.storage.sync.set({ serverUrl: url.origin, token: token.value.trim() });
    server.value = url.origin;
    status.textContent = "Settings saved.";
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Could not save settings.";
  }
});
