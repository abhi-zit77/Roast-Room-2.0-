import globals from "globals";

export default [
  { ignores: ["app/public/vendor/**", ".roast-room/**", "node_modules/**"] },
  { files: ["app/**/*.{mjs,js}"], rules: {
    "no-undef": "error",
    "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
    "no-unreachable": "error",
    "no-dupe-keys": "error",
    "no-constant-binary-expression": "error",
  } },
  { files: ["app/**/*.mjs"], languageOptions: { globals: globals.node } },
  { files: ["app/public/**/*.js"], languageOptions: { globals: globals.browser } },
];
