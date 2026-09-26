/** @type {import('tailwindcss').Config} */
// Tailwind est EPINGLE en v3.4, pas v4.
//
// Raison : le dashboard utilise la syntaxe d'arbitraire de la v3
// (`bg-[#fff3d9]`, `max-w-[1440px]`, `lg:grid-cols-[minmax(0,1.5fr)_minmax(280px,1fr)]`).
// Tailwind v4 change le modele de configuration et introduirait des regressions
// visuelles silencieuses. Epingler stabilise aussi le rendu : le CDN
// `cdn.tailwindcss.com` servait une version qui pouvait changer sans prevenir.
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      // Repris du design system (DESIGN.md) : Inter pour le texte structurel,
      // JetBrains Mono pour les sorties numeriques et les unites.
      fontFamily: {
        sans: ['"DM Sans"', "system-ui", "sans-serif"],
        mono: ['"Space Mono"', "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
