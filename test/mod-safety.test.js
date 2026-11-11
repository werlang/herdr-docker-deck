// Guards the failure mode `herdr-app check` cannot see: a chained element method that does not
// exist in gpui-kit.d.ts. Such a call loads fine and throws at render time, which is how
// `.shrink_0()` (real name `.flex_shrink_0()`) crashed the panel.
//
// The review showed the first version of this guard could not see camelCase typos and was
// silently skipped on a fresh clone, so it now:
//   - collects every chained call, case-sensitive (`.Shrink0()` included);
//   - accepts a name only when it is a method declared in gpui-kit.d.ts, a method defined on the
//     mod's own class (2-space indentation inside the class body), or a language builtin;
//   - fails, instead of skipping, when the generated d.ts is missing.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const modDir = path.join(root, "mods/docker-manager");
const mainPath = path.join(modDir, "main.js");
const logicPath = path.join(modDir, "docker-logic.js");
const dtsPath = path.join(modDir, "gpui-kit.d.ts");
const iconsDir = path.join(modDir, "icons");

const ALLOWED_DEAD_ASSETS = new Set(["whale.svg", "image.svg", "system.svg", "hammer.svg"]);

// Language/library methods that appear in a chain and have nothing to do with gpui-kit.
const BUILTINS = new Set([
  "map", "filter", "find", "findIndex", "findLast", "forEach", "some", "every", "reduce",
  "reduceRight", "flat", "flatMap", "join", "slice", "splice", "concat", "push", "pop", "shift",
  "unshift", "sort", "reverse", "includes", "indexOf", "lastIndexOf", "keys", "values", "entries",
  "at", "fill", "from",
  "trim", "trimStart", "trimEnd", "toLowerCase", "toUpperCase", "startsWith", "endsWith", "split",
  "replace", "replaceAll", "match", "matchAll", "search", "charAt", "charCodeAt", "codePointAt",
  "repeat", "padStart", "padEnd", "substring", "substr", "toString", "valueOf", "normalize",
  "min", "max", "floor", "ceil", "round", "abs", "pow", "sqrt", "random", "toFixed", "toPrecision",
  "parse", "stringify", "assign", "freeze", "hasOwnProperty", "isArray", "isInteger", "fromEntries",
  "now", "getTime", "toISOString", "getFullYear", "getMonth", "getDate", "getHours", "getMinutes",
  "getSeconds", "set_value",
  "add", "clear", "delete", "get", "set", "has", "then", "catch", "finally", "all", "allSettled",
  "race", "resolve", "reject",
  "test", "exec", "log", "warn", "error", "info", "debug", "localeCompare",
]);

function dtsMethodNames(source) {
  const names = new Set();
  // declaration-ish lines: `name<T>(...)`, `name(...)`, `name?: (...)`
  const decl = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>\n]*>)?\s*\??\s*[(:]/gm;
  let m;
  while ((m = decl.exec(source)) !== null) names.add(m[1]);
  return names;
}

function modMethodNames(source) {
  const names = new Set();
  // methods declared at class-member indentation, optionally async/get/set
  const decl = /^  (?:async\s+|get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = decl.exec(source)) !== null) names.add(m[1]);
  return names;
}

test("mod-safety: every chained call in main.js is a real gpui-kit, mod or language method", () => {
  assert.ok(
    fs.existsSync(dtsPath),
    "mods/docker-manager/gpui-kit.d.ts is missing: run `herdr-app check mods/docker-manager` before the tests (the guard cannot verify element methods without it)"
  );
  const main = fs.readFileSync(mainPath, "utf8");
  const dts = fs.readFileSync(dtsPath, "utf8");

  const calls = new Set();
  // (?<!\.) so a spread (`...fn(`) is not read as a method call
  const callRe = /(?<!\.)\.([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = callRe.exec(main)) !== null) calls.add(m[1]);

  const allowed = new Set([...dtsMethodNames(dts), ...modMethodNames(main), ...BUILTINS]);
  const unknown = [...calls].filter((c) => !allowed.has(c)).sort();

  assert.deepEqual(unknown, [], `invented or undeclared chained methods in main.js: ${unknown.join(", ")}`);
});

test("mod-safety: the guard catches a camelCase typo and a lowercase typo", () => {
  // Mutation proof: names that are not in the kit must be rejected whatever their case.
  const fakeDts = "  flex_shrink_0<Self>(this: Self): Self;\n  child(el: Element): this;\n";
  const allowed = new Set([...dtsMethodNames(fakeDts), ...BUILTINS]);
  for (const bad of ["shrink_0", "Shrink0", "flexShrinkZero"]) {
    assert.equal(allowed.has(bad), false, `${bad} must not be accepted as a kit method`);
  }
  assert.equal(allowed.has("flex_shrink_0"), true);
});

test("mod-safety: icons referenced from main.js exist on disk and every icon is accounted for", () => {
  const main = fs.readFileSync(mainPath, "utf8");
  const logic = fs.existsSync(logicPath) ? fs.readFileSync(logicPath, "utf8") : "";

  const referenced = new Set();
  let m;
  const direct = /mods\/docker-manager\/icons\/([A-Za-z0-9_-]+\.svg)/g;
  while ((m = direct.exec(main)) !== null) referenced.add(m[1]);
  const literal = /["'`]([A-Za-z0-9_-]+\.svg)["'`]/g;
  while ((m = literal.exec(main)) !== null) referenced.add(m[1]);
  while ((m = literal.exec(logic)) !== null) referenced.add(m[1]);
  // menu providers return the bare icon file name that the renderer prefixes with the folder
  const menuIcon = /icon:\s*["']([A-Za-z0-9_-]+\.svg)["']/g;
  while ((m = menuIcon.exec(logic)) !== null) referenced.add(m[1]);
  while ((m = menuIcon.exec(main)) !== null) referenced.add(m[1]);

  assert.ok(fs.existsSync(iconsDir), "icons directory must exist");
  const onDisk = fs.readdirSync(iconsDir).filter((f) => f.endsWith(".svg"));

  const missing = [...referenced].filter((f) => !onDisk.includes(f));
  assert.deepEqual(missing, [], `icons referenced in code but missing from disk: ${missing.join(", ")}`);

  const orphan = onDisk.filter((f) => !referenced.has(f) && !ALLOWED_DEAD_ASSETS.has(f));
  assert.deepEqual(orphan, [], `icons on disk that are neither referenced nor allowed: ${orphan.join(", ")}`);
});

test("mod-safety: menu icon names carry the .svg extension the renderer expects", () => {
  const logic = fs.readFileSync(logicPath, "utf8");
  const bare = [...logic.matchAll(/icon:\s*["']([A-Za-z0-9_-]+)["']\s*,\s*enabled/g)]
    .map((m) => m[1])
    .filter((name) => !name.endsWith(".svg"));
  assert.deepEqual(bare, [], `menu items whose icon lacks .svg (renders a blank icon): ${bare.join(", ")}`);
});
