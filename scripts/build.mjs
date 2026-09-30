// Build statique du dashboard GEP MCI.
//
// Pourquoi un script plutot qu'une ligne de commande esbuild en CLI :
//   - `--define` en CLI oblige a du quoting shell fragile selon la plateforme ;
//   - esbuild ne traite pas le HTML, il faut copier index.html et config.js a la
//     main dans dist/.
// L'API JS est plus lisible et portable.
//
// Ce que ce build supprime par rapport a l'ancien code.html :
//   - @babel/standalone (~2,5 Mo) qui compilait le JSX DANS LE NAVIGATEUR ;
//   - les bundles react.development.js (~4x plus gros que les builds prod) ;
//   - cdn.tailwindcss.com, qui affiche un avertissement explicite en console.
//
// Le gain le plus important n'est pas la performance : Babel standalone exige
// `script-src 'unsafe-eval'`. Avec un bundle esbuild, vercel.json peut imposer
// `script-src 'self'`, ce qui ferme la porte a toute injection de script.

import * as esbuild from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/main.jsx"],
  bundle: true,
  outfile: "dist/assets/app.js",
  jsx: "automatic", // pas besoin d'importer React dans chaque fichier
  loader: { ".jsx": "jsx", ".js": "jsx" },
  target: ["es2020"],
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  legalComments: "none",
  define: {
    "process.env.NODE_ENV": watch ? '"development"' : '"production"',
  },
};

await mkdir("dist/assets", { recursive: true });

// config.js porte l'URL et la cle anon Supabase. Il reste HORS du bundle et
// n'est pas minifie : c'est le seul fichier que tu modifies pour pointer vers
// un autre projet Supabase, sans rebuild.
for (const file of ["index.html", "config.js"]) {
  await copyFile(file, `dist/${file}`);
}

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log("esbuild en veille (CSS non surveille : lance `npm run dev:css`)");
} else {
  await esbuild.build(options);
  console.log("Build termine -> dist/");
}
