const api = globalThis.browser ?? chrome;
const status = document.querySelector("#status");
const open = document.querySelector("#open");
document.querySelector("#options").addEventListener("click", () => api.runtime.openOptionsPage());
api.runtime.sendMessage({ type: "save-active" }).then(
  (result) => {
    status.textContent = result.message;
    if (result.url) {
      open.href = result.url;
      open.hidden = false;
    }
  },
  () => {
    status.textContent = "Could not save this page. Check Options and try again.";
  },
);
