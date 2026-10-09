import { afterEach, describe, expect, it, vi } from "vitest";
import { e2eStubBlob, e2eStubModels } from "./mode";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("e2e mode flags", () => {
  it("are on only when set to 1 outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SASHA_E2E_STUB_MODELS", "1");
    vi.stubEnv("SASHA_E2E_STUB_BLOB", "1");
    expect(e2eStubModels()).toBe(true);
    expect(e2eStubBlob()).toBe(true);
    vi.stubEnv("SASHA_E2E_STUB_MODELS", "true");
    vi.stubEnv("SASHA_E2E_STUB_BLOB", "");
    expect(e2eStubModels()).toBe(false);
    expect(e2eStubBlob()).toBe(false);
  });

  it("are ignored in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SASHA_E2E_STUB_MODELS", "1");
    vi.stubEnv("SASHA_E2E_STUB_BLOB", "1");
    expect(e2eStubModels()).toBe(false);
    expect(e2eStubBlob()).toBe(false);
  });

  it("are off by default", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SASHA_E2E_STUB_MODELS", undefined);
    vi.stubEnv("SASHA_E2E_STUB_BLOB", undefined);
    expect(e2eStubModels()).toBe(false);
    expect(e2eStubBlob()).toBe(false);
  });
});
