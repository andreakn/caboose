import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./commands.ts";
import { applyTheme, getTheme } from "./prefs.ts";
import "./styles.css";

applyTheme(getTheme());
createRoot(document.getElementById("root")!).render(<App />);
