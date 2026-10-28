import test from "node:test";
import assert from "node:assert/strict";
import { checkRecordingSupport } from "@/lib/recording/codecs";

type AnyGlobal = Record<string, unknown>;

function withGlobals(globals: AnyGlobal, fn: () => void) {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
      enumerable: true,
    });
  }
  try {
    fn();
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as AnyGlobal)[key];
    }
  }
}

function fakeEnv({ screen, camera, codec }: {
  screen: boolean;
  camera: boolean;
  codec: boolean;
}) {
  class FakeMediaRecorder {
    static isTypeSupported(mime: string): boolean {
      return codec && mime.startsWith("video/webm");
    }
  }

  const mediaDevices: AnyGlobal = {};
  if (screen) mediaDevices.getDisplayMedia = async () => new MediaStream();
  if (camera) mediaDevices.getUserMedia = async () => new MediaStream();

  return {
    MediaRecorder: FakeMediaRecorder,
    navigator: { mediaDevices },
    window: { isSecureContext: true },
  };
}

test("screen capture present → fully supported", () => {
  withGlobals(fakeEnv({ screen: true, camera: true, codec: true }), () => {
    const support = checkRecordingSupport();
    assert.equal(support.supported, true);
    assert.equal(support.screenSupported, true);
  });
});

test("screen capture missing → still supported via camera fallback", () => {
  withGlobals(fakeEnv({ screen: false, camera: true, codec: true }), () => {
    const support = checkRecordingSupport();
    assert.equal(support.supported, true);
    assert.equal(support.screenSupported, false);
  });
});

test("no capture APIs at all → unsupported with a reason", () => {
  withGlobals(fakeEnv({ screen: false, camera: false, codec: true }), () => {
    const support = checkRecordingSupport();
    assert.equal(support.supported, false);
    assert.equal(support.screenSupported, false);
    assert.match(support.reason ?? "", /neither screen nor camera/i);
  });
});

test("capture APIs but no codec → unsupported", () => {
  withGlobals(fakeEnv({ screen: true, camera: true, codec: false }), () => {
    const support = checkRecordingSupport();
    assert.equal(support.supported, false);
    assert.match(support.reason ?? "", /codec/i);
  });
});
