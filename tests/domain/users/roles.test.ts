import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROLE,
  USER_ROLES,
  canManageUsers,
  isAdmin,
  parseRole,
} from "@/lib/domain/users/roles";

describe("parseRole", () => {
  it("accepts the known roles", () => {
    for (const role of USER_ROLES) {
      expect(parseRole(role)).toBe(role);
    }
  });

  it("degrades anything unrecognised to the LEAST privileged role", () => {
    // The direction of this failure is the whole point. A role column holding
    // a typo, or a hand-crafted request body, must never resolve to "admin".
    for (const raw of [undefined, null, "", "Admin", "ADMIN", "superuser", "owner"]) {
      expect(parseRole(raw), String(raw)).toBe(DEFAULT_ROLE);
    }
    expect(DEFAULT_ROLE).toBe("member");
  });
});

describe("isAdmin / canManageUsers", () => {
  it("is true only for the exact admin role", () => {
    expect(isAdmin("admin")).toBe(true);
    expect(canManageUsers("admin")).toBe(true);
  });

  it("is false for members, unknown values and nothing at all", () => {
    for (const raw of ["member", "Admin", "", undefined, null, "root"]) {
      expect(isAdmin(raw), String(raw)).toBe(false);
      expect(canManageUsers(raw), String(raw)).toBe(false);
    }
  });
});
