import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeProjectsDir } from "../src/paths.js";

describe("claudeProjectsDir", () => {
  it("defaults to ~/.claude/projects", () => {
    expect(claudeProjectsDir({})).toBe(join(homedir(), ".claude", "projects"));
  });
  it("follows Claude Code's CLAUDE_CONFIG_DIR", () => {
    expect(claudeProjectsDir({ CLAUDE_CONFIG_DIR: "/work/claude" })).toBe("/work/claude/projects");
  });
  it("lets CLAUDE_PROJECTS_DIR point at the folder directly", () => {
    expect(claudeProjectsDir({ CLAUDE_CONFIG_DIR: "/work/claude", CLAUDE_PROJECTS_DIR: "/elsewhere" })).toBe("/elsewhere");
  });
});
