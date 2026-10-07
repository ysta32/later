import { render } from "preact";
import App from "./app.tsx";
import "./styles.css";
render(<App />, document.getElementById("app")!);
if ("serviceWorker" in navigator && import.meta.url.includes("/assets/")) {
  void navigator.serviceWorker.register("/sw.js").catch(console.error);
}
