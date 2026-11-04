import assert from "node:assert/strict";
import test from "node:test";
import { describeError, failureResponse, ImageError } from "../src/http";

test("unexpected failures log the error name, message and platform flags", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "error", (line: string) => logged.push(line));
  const cause = Object.assign(new Error("Network connection lost."), {
    retryable: true,
    remote: true,
  });

  const response = failureResponse(cause);

  assert.equal(response.status, 500);
  assert.equal(await response.text(), "image request failed");
  assert.equal(logged.length, 1);
  const entry = JSON.parse(logged[0]);
  assert.equal(entry.event, "image_request_failed");
  assert.equal(entry.error.name, "Error");
  assert.equal(entry.error.message, "Network connection lost.");
  assert.equal(entry.error.retryable, true);
  assert.equal(entry.error.remote, true);
  assert.equal(entry.error.overloaded, undefined);
  assert.match(entry.error.stack, /Network connection lost/);
});

test("expected image errors return their status without logging", async (t) => {
  const logged: unknown[] = [];
  t.mock.method(console, "error", (line: unknown) => logged.push(line));

  const response = failureResponse(new ImageError("too large", 413));

  assert.equal(response.status, 413);
  assert.equal(logged.length, 0);
});

test("error descriptions include nested causes and non-error values", () => {
  const error = new TypeError("upload failed", {
    cause: new Error("connection reset"),
  });
  const details = describeError(error);
  assert.equal(details.name, "TypeError");
  assert.equal(details.cause?.message, "connection reset");
  assert.deepEqual(describeError("plain failure"), {
    message: "plain failure",
  });
});
