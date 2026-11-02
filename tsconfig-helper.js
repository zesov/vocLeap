import { readFileSync, writeFileSync } from "fs";
const pkg = JSON.parse(readFileSync("/home/junius/Workspace/ts/vocleap/vocleap/package.json", "utf-8"));

if (!pkg.devDependencies["@types/better-sqlite3"]) {
  pkg.devDependencies["@types/better-sqlite3"] = "^2.0.0";
}

if (!pkg.devDependencies["@types/next-pwa"]) {
  pkg.devDependencies["@types/next-pwa"] = "^5.6.0";
}

writeFileSync("/home/junius/Workspace/ts/vocleap/vocleap/package.json", JSON.stringify(pkg, null, 2));
console.log("TypeScript definitions added");