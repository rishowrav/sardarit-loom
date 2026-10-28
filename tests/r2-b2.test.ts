import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { presignGet, partCount } from "@/lib/r2";

// Separate test file (separate worker process) because getServerEnv() is
// memoised per process — here we exercise the Backblaze B2-style settings.
before(() => {
  process.env.R2_ENDPOINT = "https://s3.us-west-004.backblazeb2.com";
  process.env.R2_REGION = "us-west-004";
  process.env.R2_FORCE_PATH_STYLE = "true";
  process.env.R2_ACCESS_KEY_ID = "b2-key-id";
  process.env.R2_SECRET_ACCESS_KEY = "b2-app-key";
  process.env.R2_BUCKET = "sardarit-loom";
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://dummy.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "dummy-anon-key";
  // R2_ACCOUNT_ID intentionally absent: endpoint must be enough on its own.
  delete process.env.R2_ACCOUNT_ID;
});

describe("Backblaze B2-style configuration", () => {
  it("signs path-style URLs against an explicit S3 endpoint", async () => {
    const url = new URL(await presignGet("recordings/abc/v.webm", { expiresIn: 600 }));
    assert.equal(url.protocol, "https:");
    assert.equal(url.host, "s3.us-west-004.backblazeb2.com");
    // forcePathStyle=true → bucket is the first path segment, not a subdomain.
    assert.equal(url.pathname, "/sardarit-loom/recordings/abc/v.webm");
    assert.match(url.searchParams.get("X-Amz-Signature") ?? "", /^[0-9a-f]{64}$/);
  });

  it("uses the real region in the SigV4 credential scope", async () => {
    const url = new URL(await presignGet("recordings/abc/v.webm", { expiresIn: 600 }));
    assert.match(
      url.searchParams.get("X-Amz-Credential") ?? "",
      /b2-key-id\/\d{8}\/us-west-004\/s3\/aws4_request/,
    );
    assert.equal(url.searchParams.get("X-Amz-Expires"), "600");
  });

  it("keeps multipart part math unchanged for B2", () => {
    const chunk = 8 * 1024 * 1024;
    assert.equal(partCount(9 * 1024 * 1024, chunk), 2);
  });
});
