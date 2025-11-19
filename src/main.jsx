import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@xyflow/react/dist/style.css"

import Flow from "./Flow.jsx";

createRoot(document.getElementById("plugin-root")).render(
  <StrictMode>
    <Flow />
  </StrictMode>
);
