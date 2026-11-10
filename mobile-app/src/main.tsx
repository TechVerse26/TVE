import { createRoot } from "react-dom/client";
import { setupIonicReact } from "@ionic/react";
import "@ionic/react/css/core.css";
import "@ionic/react/css/normalize.css";
import "@ionic/react/css/structure.css";
import "@ionic/react/css/typography.css";
import "@ionic/react/css/palettes/dark.class.css";
import "./ui/theme.css";
import App from "./App";
import { initNative } from "./core/native";

setupIonicReact({ mode: "md", rippleEffect: true });
void initNative();
createRoot(document.getElementById("root")!).render(<App />);
