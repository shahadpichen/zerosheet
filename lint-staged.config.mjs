export default {
  "*.{ts,tsx,js,mjs,cjs}": [
    "prettier --write",
    "eslint --fix --max-warnings=0",
  ],
  "*.{json,jsonc,md,yaml,yml,css,html}": "prettier --write",
};
