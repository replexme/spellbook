import { createRoot } from "react-dom/client";
import "../src/design-system/tokens.css";
import "../src/design-system/base.css";
import "../src/design-system/components.css";
import "../src/design-system/patterns.css";
import { NativeWorkspace } from "../src/components/native-workspace";
createRoot(document.getElementById("root")!).render(
  <NativeWorkspace launch={(window as any).__spellbookLaunch} />,
);
