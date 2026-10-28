import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { partCount, presignGet, presignPut, isNoSuchUpload, isNotFound } from "@/lib/r2";

const CHUNK = 8 * 1024 * 1024;

before(() => {
  // Dummy credentials — SigV4 is computed locally, no network involved.
  process.env.R2_ACCOUNT_ID ??= "dummyaccountid0000000000000000000";
  process.env.R2_ACCESS_KEY_ID ??= "dummy-access-key";
  process.env.R2_SECRET_ACCESS_KEY ??= "dummy-secret-key";
  process.env.R2_BUCKET ??= "sardarit-loom-test";
  process.env.R2_ENDPOINT ??= "https://dummyaccountid0000000000000000000.r2.cloudflarestorage.com";
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://dummy.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "dummy-anon-key";
});

describe("partCount", () => {
  it("always requests at least one part", () => {
    assert.equal(partCount(0, CHUNK), 1);
    assert.equal(partCount(1, CHUNK), 1);
  });

  it("counts exact multiples without spilling over", () => {
    assert.equal(partCount(CHUNK, CHUNK), 1);
    assert.equal(partCount(4 * CHUNK, CHUNK), 4);
  });

  it("rounds partial parts up", () => {
    assert.equal(partCount(CHUNK + 1, CHUNK), 2);
    assert.equal(partCount(30 * 1024 * 1024, CHUNK), 4);
  });
});

function parseSignedUrl(raw: string): URL {
  const url = new URL(raw);
  assert.ok(url.searchParams.get("X-Amz-Signature"), "must carry a signature");
  return url;
}

describe("presignGet", () => {
  it("signs a private GET for the exact key and bucket", async () => {
    const url = parseSignedUrl(
      await presignGet("recordings/abc/video.webm", { expiresIn: 3600 }),
    );
    assert.equal(url.protocol, "https:");
    // Virtual-hosted style: bucket becomes the first DNS label of the host.
    assert.equal(
      url.host,
      "sardarit-loom-test.dummyaccountid0000000000000000000.r2.cloudflarestorage.com",
    );
    assert.equal(url.pathname, "/recordings/abc/video.webm");
    assert.equal(url.searchParams.get("X-Amz-Expires"), "3600");
    assert.equal(url.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
    assert.match(url.searchParams.get("X-Amz-Signature") ?? "", /^[0-9a-f]{64}$/);
    assert.match(
      url.searchParams.get("X-Amz-Credential") ?? "",
      /dummy-access-key\/\d{8}\/auto\/s3\/aws4_request/,
    );
  });

  it("adds a download disposition when a filename is given", async () => {
    const url = parseSignedUrl(
      await presignGet("recordings/abc/video.webm", {
        expiresIn: 600,
        downloadFilename: "My Recording.webm",
      }),
    );
    const disposition = url.searchParams.get("response-content-disposition");
    assert.ok(disposition);
    assert.ok(disposition.includes("attachment"));
    assert.ok(disposition.includes('filename="My Recording.webm"'));
  });

  it("omits the disposition for playback links", async () => {
    const url = parseSignedUrl(
      await presignGet("recordings/abc/video.webm", { expiresIn: 600 }),
    );
    assert.equal(url.searchParams.get("response-content-disposition"), null);
  });
});

describe("presignPut", () => {
  it("signs a PUT for thumbnail uploads", async () => {
    const url = parseSignedUrl(await presignPut("recordings/abc/thumb.jpg", 900));
    assert.equal(
      url.host,
      "sardarit-loom-test.dummyaccountid0000000000000000000.r2.cloudflarestorage.com",
    );
    assert.equal(url.pathname, "/recordings/abc/thumb.jpg");
    assert.equal(url.searchParams.get("X-Amz-Expires"), "900");
  });
});

describe("error classifiers", () => {
  it("recognises expired multipart uploads", () => {
    const error = Object.assign(new Error("NoSuchUpload"), {
      name: "NoSuchUpload",
      $metadata: { httpStatusCode: 404 },
    });
    assert.equal(isNoSuchUpload(error), true);
  });

  it("recognises missing objects", () => {
    const error = Object.assign(new Error("NotFound"), {
      name: "NotFound",
      $metadata: { httpStatusCode: 404 },
    });
    assert.equal(isNotFound(error), true);
  });

  it("rejects unrelated errors", () => {
    assert.equal(isNotFound(new Error("boom")), false);
    assert.equal(isNoSuchUpload(new Error("boom")), false);
    assert.equal(isNotFound("string"), false);
    assert.equal(isNoSuchUpload(null), false);
  });
});
