import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type { Env } from "../env";

export interface TranscribeParams {
  url: string;
}

export class TranscribeFlow extends WorkflowEntrypoint<Env, TranscribeParams> {
  async run(event: WorkflowEvent<TranscribeParams>, step: WorkflowStep) {
    const target = event.payload.url;

    const fetched = await step.do("fetch-page", async () => {
      const res = await fetch(`${this.env.EGRESS_URL}/fetch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: target, method: "GET" }),
      });
      if (!res.ok) throw new Error(`egress ${res.status}`);
      const data = (await res.json()) as { status: number; proxyPort: number; body: string };
      const text = atob(data.body || "");
      return {
        status: data.status,
        proxyPort: data.proxyPort,
        length: text.length,
        head: text.slice(0, 200),
      };
    });

    return fetched;
  }
}
