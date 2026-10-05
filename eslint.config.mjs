import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    files: ["src/**/*.js", "data/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        window: "readonly", document: "readonly", self: "readonly",
        location: "readonly", navigator: "readonly", console: "readonly",
        setTimeout: "readonly", clearTimeout: "readonly",
        setInterval: "readonly", clearInterval: "readonly",
        requestAnimationFrame: "readonly", URL: "readonly", Blob: "readonly",
        FileReader: "readonly", Image: "readonly", XMLSerializer: "readonly",
        Worker: "readonly", CSS: "readonly", getComputedStyle: "readonly",
        URLSearchParams: "readonly", importScripts: "readonly",
        postMessage: "readonly", onmessage: "writable", module: "readonly",
        require: "readonly", DSTS_DATA: "writable",
        performance: "readonly", indexedDB: "readonly"
      }
    },
    rules: {
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
      "no-implicit-globals": "off"
    }
  },
  {
    files: ["tests/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: { require: "readonly", module: "readonly", console: "readonly", __dirname: "readonly" }
    },
    rules: {
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }]
    }
  }
];
