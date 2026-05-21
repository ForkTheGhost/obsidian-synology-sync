import esbuild from "esbuild";
import process from "process";

const prod = process.argv[2] === "production";

// iOS/WebKit CompressionStream/DecompressionStream can corrupt or fail Git
// loose-object deflate/inflate inside isomorphic-git. A runtime banner is not
// early enough in Obsidian mobile because WebKit's globals can still be seen by
// bundled module initialization. Patch isomorphic-git's internal feature flags
// at bundle time so its deflate/inflate helpers always use pako.
const forceIsomorphicGitPakoPlugin = {
  name: "force-isomorphic-git-pako",
  setup(build) {
    build.onLoad({ filter: /node_modules[\\/]isomorphic-git[\\/]index\.(cjs|js)$/ }, async (args) => {
      const fs = await import("fs/promises");
      let text = await fs.readFile(args.path, "utf8");
      text = text
        .replace("let supportsDecompressionStream = false;", "let supportsDecompressionStream = false;")
        .replace("if (supportsDecompressionStream === null) {", "if (false && supportsDecompressionStream === null) {")
        .replace(/async function browserInflate\(buffer\) \{[\s\S]*?\n\}/, "async function browserInflate(buffer) { return pako.inflate(buffer); }")
        .replace(/function testDecompressionStream\(\) \{[\s\S]*?\n\}/, "function testDecompressionStream() { return false; }")
        .replace("let supportsCompressionStream = null;", "let supportsCompressionStream = false;")
        .replace("if (supportsCompressionStream === null) {", "if (false && supportsCompressionStream === null) {")
        .replace(/async function browserDeflate\(buffer\) \{[\s\S]*?\n\}/, "async function browserDeflate(buffer) { return pako.deflate(buffer); }")
        .replace(/function testCompressionStream\(\) \{[\s\S]*?\n\}/, "function testCompressionStream() { return false; }");
      return { contents: text, loader: "js" };
    });
  },
};

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
  plugins: [forceIsomorphicGitPakoPlugin],
}).catch(() => process.exit(1));
