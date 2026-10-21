import { listHerdrAgents, type HerdrRunner } from "../herdr.js";
import { openPaneSession } from "../pane-backend.js";
import { createSystemStartTimeReader, findHerdrAgentForMember, proveMemberInPane, type StartTimeReader } from "../launch-identity.js";
import type { RoomMember } from "../types.js";

// A Codex TUI started with --no-daemon owns its turn locally. The shared
// app-server cannot interrupt that turn, but Herdr can send Escape to the
// exact pane after session and process proof. Other Codex sessions retain the
// app-server interrupt path. Inside tmux the same proof runs through tmux.
export function interruptCodexHerdr(
  member: RoomMember,
  runner: HerdrRunner = boundedPaneRunner(member),
  readStartTime: StartTimeReader = createSystemStartTimeReader()
): "sent" | "idle" | "unavailable" | "unconfirmed" {
  try {
    const agent = findHerdrAgentForMember(member, listHerdrAgents(runner));
    if (!agent || agent.agent !== "codex" ||
        !proveMemberInPane(member, agent, "codex", { runner, readStartTime }).confirmed) {
      return "unavailable";
    }
    // tmux reports no status; Escape at an idle composer is harmless.
    if (agent.status !== null && agent.status !== "working") return "idle";
    // Status can change after this check; Escape may reach an idle composer.
    // A failed call may also have delivered the key, so do not retry through
    // another transport and report the result as uncertain.
    try {
      runner(["pane", "send-keys", agent.pane_id, "esc"]);
      return "sent";
    } catch {
      return "unconfirmed";
    }
  } catch {
    return "unavailable";
  }
}

function boundedPaneRunner(member: RoomMember): HerdrRunner {
  const run = openPaneSession(process.env, { readMembers: () => [member] }).runner;
  return (args) => run(args, { timeoutMs: 1_500 });
}
