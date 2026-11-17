import { test } from "node:test";
import assert from "node:assert/strict";
import { assertHostVersion } from "../src/compatibility.js";

test("host compatibility allows newer V2 patches and minors instead of pinning the SDK version", () => {
  for (const version of ["2.2.6", "2.2.7", "2.3.0", "2.3.1", "2.4.0", "2.10.0", "2.3.0+build.1", "2.3.0-beta.1"])
    assert.doesNotThrow(() => assertHostVersion(version), version);
});
test("host compatibility rejects older hosts, unsupported majors, and unrecognized versions", () => {
  for (const version of ["1.9.0", "2.1.99", "2.2.5", "2.2.6-beta.1", "3.0.0", "unknown", "2.3", "2.3.0garbage"])
    assert.throws(() => assertHostVersion(version), /requires OpenCode >=2\.2\.6 <3\.0\.0/);
});
