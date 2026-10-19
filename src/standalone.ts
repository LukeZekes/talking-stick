// Entry of the compiled standalone binary (bun build --compile). The mode is
// marked before the CLI module loads, so it never mistakes itself for a
// directly executed script and runs twice.
import { markStandalone } from "./standalone-mode.js";

markStandalone();
const { runCliMain } = await import("./cli.js");
await runCliMain();
