import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Listen } from "./pages/listen/Listen";
import "./styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Missing #root element");
}

const path = window.location.pathname;
const page = path === "/listen" || path.startsWith("/listen/") ? <Listen /> : <App />;

createRoot(rootElement).render(<StrictMode>{page}</StrictMode>);
