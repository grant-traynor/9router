import { describe, expect, it } from "vitest";

import { mapAntigravityTokens } from "../../src/lib/oauth/providerHelpers.js";

const tokens = {
  access_token: "access-token",
  refresh_token: "refresh-token",
  expires_in: 3600,
  scope: "scope",
};

describe("Antigravity OAuth project ID persistence", () => {
  it("includes a project ID returned by loadCodeAssist", () => {
    const mapped = mapAntigravityTokens(tokens, {
      userInfo: { email: "user@example.com" },
      projectId: "cloud-code-project",
    });

    expect(mapped.projectId).toBe("cloud-code-project");
  });

  it.each(["", null, undefined])(
    "omits an unavailable project ID (%s) so reconnect cannot erase the stored value",
    (projectId) => {
      const mapped = mapAntigravityTokens(tokens, {
        userInfo: { email: "user@example.com" },
        projectId,
      });

      expect(mapped).not.toHaveProperty("projectId");
    }
  );
});
