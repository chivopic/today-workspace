import fs from "node:fs";
import path from "node:path";

const versionName = process.env.VERSION_NAME;
const versionCode = process.env.VERSION_CODE;
const gradlePath = path.resolve("android/app/build.gradle");

if (!versionName || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(versionName)) {
  throw new Error(`Invalid VERSION_NAME: ${versionName || "<empty>"}`);
}
if (!versionCode || !/^\d+$/.test(versionCode) || Number(versionCode) < 1) {
  throw new Error(`Invalid VERSION_CODE: ${versionCode || "<empty>"}`);
}
if (!fs.existsSync(gradlePath)) {
  throw new Error(`Android Gradle file not found: ${gradlePath}`);
}

let source = fs.readFileSync(gradlePath, "utf8");

function replaceOnce(pattern, replacement, label) {
  if (!pattern.test(source)) throw new Error(`Unable to find ${label} in android/app/build.gradle`);
  source = source.replace(pattern, replacement);
}

replaceOnce(/versionCode\s+\d+/, `versionCode ${versionCode}`, "versionCode");
replaceOnce(/versionName\s+["'][^"']+["']/, `versionName "${versionName}"`, "versionName");

if (!source.includes("keystorePropertiesFile")) {
  const prelude = `def keystoreProperties = new Properties()\ndef keystorePropertiesFile = rootProject.file("keystore.properties")\nif (keystorePropertiesFile.exists()) {\n    keystoreProperties.load(new FileInputStream(keystorePropertiesFile))\n}\n\n`;
  source = prelude + source;
}

if (!source.includes("signingConfigs {\n        release")) {
  replaceOnce(/\n\s*buildTypes\s*\{/, `\n    signingConfigs {\n        release {\n            if (keystorePropertiesFile.exists()) {\n                storeFile file(keystoreProperties["storeFile"])\n                storePassword keystoreProperties["storePassword"]\n                keyAlias keystoreProperties["keyAlias"]\n                keyPassword keystoreProperties["keyPassword"]\n            }\n        }\n    }\n\n    buildTypes {`, "buildTypes block");
}

if (!source.includes("signingConfig signingConfigs.release")) {
  replaceOnce(/(buildTypes\s*\{\s*release\s*\{)/, `$1\n            if (keystorePropertiesFile.exists()) signingConfig signingConfigs.release`, "release buildType");
}

fs.writeFileSync(gradlePath, source);
console.log(`Configured Android release ${versionName} (${versionCode}).`);
