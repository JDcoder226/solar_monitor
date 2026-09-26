import React from "react";
import { createRoot } from "react-dom/client";

import App from "./App.jsx";

// Remplace le `ReactDOM.createRoot(...).render(<App />)` final de l'ancien
// code.html, qui tournait apres une compilation JSX faite dans le navigateur
// par @babel/standalone. Ici le JSX est deja compile par esbuild.
createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
