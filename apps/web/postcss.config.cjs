/**
 * Vite automatically discovers this PostCSS configuration for the web app.
 * Tailwind expands the utility classes used by our shadcn components, while
 * Autoprefixer keeps the generated CSS compatible with supported browsers.
 * The CommonJS extension is intentional because this package otherwise uses
 * ESM through `"type": "module"`.
 */
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
