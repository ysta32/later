# Later browser extension

In Chrome, open `chrome://extensions`, enable Developer mode, choose Load unpacked, and select this directory. In Firefox, use `about:debugging` → This Firefox → Load Temporary Add-on and select `manifest.json`. Firefox uses the module background script; Chrome uses the module service worker. Firefox distribution requires signing.

Open Options, enter your server origin (default `http://localhost:4800`) and an API token, then save and approve access to that server. Settings, including the token, use browser sync storage. Use HTTPS for a remote server.

Click the toolbar icon to save and see status, use the Save to Later context menu, or press Alt+Shift+L. Page saves include the rendered DOM from your current session, including content visible after logging in. Link context menus send only the target URL for the server to fetch. Browser-internal pages cannot be captured. The badge shows ✓ or !; the popup links to Later. Browser shortcuts can be reassigned in extension settings.

Run `npm run zip -w @later/extension` to package the plain JavaScript extension; no build is required.

## Bookmarklet

Create a bookmark whose URL is the following, replacing the server and token:

```javascript
javascript:(()=>{const s=document.createElement('script');s.src='http://localhost:4800/bookmarklet.js?token='+encodeURIComponent('YOUR_API_TOKEN');document.documentElement.appendChild(s)})();
```

The bookmarklet saves rendered HTML with bearer authentication and omits cookies. A network/CORS failure opens the server's share page with just the page URL. Page CSP or mixed-content restrictions may block loading the script entirely; use the extension on those pages. Keep the bookmark private: its URL contains your API token, and bookmarklets run in the visited page's context.
