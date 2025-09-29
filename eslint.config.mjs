import js from "@eslint/js";
import globals from "globals";
import pluginImport from "eslint-plugin-import";
import pluginN from "eslint-plugin-n";
import pluginPromise from "eslint-plugin-promise";
import eslintConfigPrettier from "eslint-config-prettier";

const nodeFiles = ["**/*.js", "**/*.mjs", "**/*.cjs"];
const nodeLanguageOptions = {
  ecmaVersion: 2023,
  sourceType: "module",
  globals: {
    ...globals.node,
  },
};

export default [
  {
    ignores: [
      "**/node_modules/**",
      "public/**",
      "data/**",
      "prisma/data/**",
      "prisma/migrations/**",
      "prisma/schema.prisma",
      "prisma/reset.sh",
      "eslint.config.mjs",
      "package-lock.json",
    ],
  },
  js.configs.recommended,
  pluginImport.flatConfigs.recommended,
  pluginN.configs["flat/recommended"],
  pluginPromise.configs["flat/recommended"],
  eslintConfigPrettier,
  {
    files: nodeFiles,
    languageOptions: nodeLanguageOptions,
    rules: {
      "import/order": [
        "error",
        {
          groups: [
            "builtin",
            "external",
            "internal",
            "parent",
            "sibling",
            "index",
            "object",
            "type",
          ],
          "newlines-between": "always",
        },
      ],
      "n/no-missing-import": [
        "error",
        {
          tryExtensions: [".js", ".mjs", ".cjs", ".json"],
        },
      ],
      "n/no-process-exit": "off",
    },
  },
];
