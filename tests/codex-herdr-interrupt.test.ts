import { describe, expect, test } from "vitest";
import { interruptCodexHerdr } from "../src/cli/codex-herdr-interrupt.js";
import { FakeHerdr } from "./fixtures/fake-herdr.js";

describe("Codex Herdr interrupt", () => {
  test("sends Escape only for a working pane with matching session and process", () => {
    const herdr = new FakeHerdr();
    herdr.addAgent("w1:p2", "codex");
    herdr.agentStatus = "working";
    const member = herdr.members()[0];
    const readStartTime = (pid: number) => herdr.startTimes.get(pid) ?? null;
    expect(interruptCodexHerdr(member, herdr.runner, readStartTime)).toBe("sent");
    expect(herdr.calls.at(-1)).toEqual(["pane", "send-keys", "w1:p2", "esc"]);

    herdr.calls.length = 0;
    expect(interruptCodexHerdr({ ...member, harness_pid: 9999 }, herdr.runner, readStartTime)).toBe("unavailable");
    expect(herdr.calls.some((call) => call[1] === "send-keys")).toBe(false);

    herdr.calls.length = 0;
    herdr.agentStatus = "idle";
    expect(interruptCodexHerdr(member, herdr.runner, readStartTime)).toBe("idle");
    expect(herdr.calls.some((call) => call[1] === "send-keys")).toBe(false);

    // tmux reports no busy/idle status; the proven pane still gets Escape.
    herdr.calls.length = 0;
    herdr.agentStatus = null;
    expect(interruptCodexHerdr(member, herdr.runner, readStartTime)).toBe("sent");

    herdr.agentStatus = "working";
    herdr.failSendKeys = true;
    expect(interruptCodexHerdr(member, herdr.runner, readStartTime)).toBe("unconfirmed");
  });
});
