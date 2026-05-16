import type { Writable } from "node:stream";
import type {
  ContentBlock,
  OutboundControlResponse,
  OutboundJson,
  OutboundUserMessage,
} from "./Events";

/* NDJSON writer for the Claude Code subprocess's stdin. Each call serializes one JSON
   object on its own line, matching the `--input-format stream-json` wire format. */
export class InputWriter {
  constructor(private stdin: Writable) {}

  send(message: OutboundJson) {
    if (!this.stdin.writable) {
      throw new Error("Claude subprocess stdin is no longer writable");
    }
    this.stdin.write(`${JSON.stringify(message)}\n`);
  }

  sendUserText(text: string, sessionId?: string) {
    const message: OutboundUserMessage = {
      type: "user",
      session_id: sessionId,
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
    };
    this.send(message);
  }

  sendUserContent(blocks: ContentBlock[], sessionId?: string) {
    const message: OutboundUserMessage = {
      type: "user",
      session_id: sessionId,
      message: { role: "user", content: blocks },
      parent_tool_use_id: null,
    };
    this.send(message);
  }

  /* Approval: pass `updatedInput` (the tool input the request was made with,
     possibly modified by the UI). Required by the Agent SDK schema. */
  sendApproval(requestId: string, updatedInput: Record<string, unknown>) {
    const response: OutboundControlResponse = {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: { behavior: "allow", updatedInput },
      },
    };
    this.send(response);
  }

  sendDenial(requestId: string, message?: string) {
    const response: OutboundControlResponse = {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: { behavior: "deny", message },
      },
    };
    this.send(response);
  }

  closeStdin() {
    if (this.stdin.writable) this.stdin.end();
  }
}
