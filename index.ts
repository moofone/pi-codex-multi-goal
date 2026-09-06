import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerMultiGoal } from "./src/runtime.js";

export default function (pi: ExtensionAPI): void {
  registerMultiGoal(pi);
}
