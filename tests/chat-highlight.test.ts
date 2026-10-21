import { describe, expect, it } from "vitest";
import { highlightChatBody } from "../src/cli/chat-highlight.js";

// Marks each styled span as {code|text} so assertions stay readable.
const options = {
  paint: (code: string, text: string) => `{${code}|${text}}`,
  agent_color: (name: string) => (name.startsWith("codex") ? 78 : 1)
};
const highlight = (body: string) => highlightChatBody(body, options);

describe("highlightChatBody", () => {
  it("styles inline code, bold, urls, refs, and agent mentions", () => {
    expect(highlight("fix `setRoomRoles` **now**, see #22871 and https://x.dev/a.")).toBe(
      "fix {2|`}{38;5;180|setRoomRoles}{2|`} {2|**}{1|now}{2|**}, see {38;5;110|#22871} and {4;38;5;75|https://x.dev/a}."
    );
    expect(highlight("ping @codex and codex:fb4bbf13")).toBe(
      "ping {38;5;78|@codex} and {38;5;78|codex:fb4bbf13}"
    );
  });

  it("styles paths without catching ordinary slashes", () => {
    expect(highlight("see src/service.ts:412 and tests/roles.test.ts or ~/.config/x")).toBe(
      "see {38;5;116|src/service.ts:412} and {38;5;116|tests/roles.test.ts} or {38;5;116|~/.config/x}"
    );
    expect(highlight("this and/or that, 3.5 times, e.g. this")).toBe("this and/or that, 3.5 times, e.g. this");
  });

  it("dims structure markers and styles headings and quotes", () => {
    expect(highlight("## Plan **A**\n- first\n2. second\n> quoted")).toBe(
      "{2|##} {1|Plan }{2|**}{1|A}{2|**}\n{2|-} first\n{2|2.} second\n{2|>} {2;3|quoted}"
    );
  });

  it("colors fenced code without inline styling inside it", () => {
    expect(highlight("```sh\nnpm test **x**\n\n```\nafter `y`")).toBe(
      "{2|```sh}\n{38;5;180|npm test **x**}\n\n{2|```}\n{2|after `y`}".replace("{2|after `y`}", "after {2|`}{38;5;180|y}{2|`}")
    );
  });

  it("only adds styling: stripping SGR returns the original text", () => {
    const body = "## Plan **A**\n- `x` __y__ see #1, @codex, src/a.ts:3, https://x.dev\n> q\n```\n**raw**\n```";
    const styled = highlightChatBody(body, { paint: (code, text) => `\u001b[${code}m${text}\u001b[0m`, agent_color: () => 1 });
    expect(styled).not.toBe(body);
    expect(styled.replace(/\u001b\[[0-9;]*m/g, "")).toBe(body);
  });

  it("leaves plain prose untouched", () => {
    expect(highlight("Nothing special here.")).toBe("Nothing special here.");
  });
});
