import esbuild from "esbuild";
import process from "process";

const prod = process.argv[2] === "production";

// iOS/WebKit CompressionStream can produce Git loose-object bytes that pako
// later fails to inflate with "too many length or distance symbols" inside
// isomorphic-git. Force isomorphic-git to use its bundled pako deflater by
// hiding the native stream API before bundled modules initialize.
const compressionStreamBanner = `try {
  if (typeof globalThis !== "undefined") {
    Object.defineProperty(globalThis, "CompressionStream", { value: undefined, configurable: true });
  }
} catch (_) {
  try { if (typeof globalThis !== "undefined") globalThis.CompressionStream = undefined; } catch (_) {}
}`;

esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/autocomplete", "@codemirror/collab",
    "@codemirror/commands", "@codemirror/language", "@codemirror/lint",
    "@codemirror/search", "@codemirror/state", "@codemirror/view",
    "@lezer/common", "@lezer/highlight", "@lezer/lr"],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
  banner: { js: compressionStreamBanner },
}).catch(() => process.exit(1));
