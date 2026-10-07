(function () {
  function buildPayload(doc, pageLocation) {
    return {
      url: pageLocation.href,
      title: doc.title,
      html: doc.documentElement.outerHTML,
      source: "bookmarklet",
    };
  }

  if (typeof module !== "undefined" && module.exports && typeof document === "undefined") {
    module.exports = { buildPayload };
    return;
  }

  const script = document.currentScript;
  if (!script?.src) return;
  const source = new URL(script.src);
  if (!["http:", "https:"].includes(source.protocol)) return;
  const token = source.searchParams.get("token");
  const payload = buildPayload(document, location);

  function toast(message) {
    const element = document.createElement("div");
    element.textContent = message;
    element.setAttribute("role", "status");
    element.style.cssText =
      "position:fixed;right:20px;top:20px;z-index:2147483647;padding:12px 18px;background:#17202a;color:white;border-radius:8px;font:14px system-ui;max-width:320px";
    document.documentElement.appendChild(element);
    setTimeout(() => element.remove(), 5000);
  }

  if (!token) {
    toast("Later: missing API token.");
    return;
  }
  toast("Saving to Later…");
  fetch(`${source.origin}/api/articles`, {
    method: "POST",
    credentials: "omit",
    redirect: "error",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  }).then(
    (response) => {
      toast(response.ok ? "Saved to Later." : `Later: save failed (HTTP ${response.status}).`);
    },
    () => {
      const fallback = `${source.origin}/share?url=${encodeURIComponent(payload.url)}`;
      window.open(fallback, "_blank", "noopener,noreferrer");
      toast("Later: opening the share page. Allow popups if it did not open.");
    },
  );
})();
