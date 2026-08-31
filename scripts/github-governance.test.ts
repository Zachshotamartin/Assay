import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const settingsDirectory = fileURLToPath(new URL("../.github/settings/", import.meta.url));

async function setting(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(`${settingsDirectory}/${name}.json`, "utf8")) as Record<
    string,
    unknown
  >;
}

describe("GitHub governance payloads", () => {
  it("records exact protected-main checks and review rules", async () => {
    const value = await setting("branch-protection");
    const checks = value["required_status_checks"] as {
      readonly strict: boolean;
      readonly checks: readonly { readonly context: string; readonly app_id: number }[];
    };
    const reviews = value["required_pull_request_reviews"] as {
      readonly required_approving_review_count: number;
      readonly dismiss_stale_reviews: boolean;
    };

    expect(checks.strict).toBe(true);
    expect(checks.checks).toEqual(
      [
        "typecheck",
        "lint-docs",
        "unit-property",
        "arch-boundaries",
        "e2e-simulated",
        "store-core"
      ].map((context) => ({
        context,
        app_id: 15368
      }))
    );
    expect(value["enforce_admins"]).toBe(true);
    expect(reviews.required_approving_review_count).toBe(1);
    expect(reviews.dismiss_stale_reviews).toBe(true);
    expect(value["required_conversation_resolution"]).toBe(true);
    expect(value["allow_force_pushes"]).toBe(false);
    expect(value["allow_deletions"]).toBe(false);
  });

  it("records least-privilege Actions settings", async () => {
    await expect(setting("actions-permissions")).resolves.toMatchObject({
      enabled: true,
      allowed_actions: "selected",
      sha_pinning_required: true
    });
    await expect(setting("selected-actions")).resolves.toEqual({
      github_owned_allowed: true,
      verified_allowed: false,
      patterns_allowed: []
    });
    await expect(setting("workflow-permissions")).resolves.toEqual({
      default_workflow_permissions: "read",
      can_approve_pull_request_reviews: false
    });
  });

  it("records a separately approved release environment", async () => {
    await expect(setting("release-environment")).resolves.toEqual({
      wait_timer: 0,
      prevent_self_review: false,
      reviewers: [{ type: "User", id: 98801571 }]
    });
  });

  it("records immutable v* tag rules", async () => {
    await expect(setting("version-tag-ruleset")).resolves.toMatchObject({
      name: "protect-version-tags",
      target: "tag",
      enforcement: "active",
      bypass_actors: [],
      conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } }
    });
  });
});
