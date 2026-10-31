// Run the same component tests under preact/compat: `node --import ./test/preact-alias.ts --test …`. Every import
// of react / react-dom resolves to Preact's compat layer, exactly as a bundler alias does in the Windows build.
import { registerHooks } from "node:module";

process.env.CARTON_RUNTIME = "preact";

const alias: Record<string, string> = {
  react: "preact/compat",
  "react-dom": "preact/compat",
  "react-dom/client": "preact/compat/client",
  "react/jsx-runtime": "preact/jsx-runtime",
};

registerHooks({
  resolve(specifier, context, next) {
    const to = alias[specifier];
    return next(to ?? specifier, context);
  },
});
