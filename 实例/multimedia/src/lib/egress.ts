export interface EgressResult {
  status: number;
  headers: Record<string, string>;
  text: string;
}

export async function fetchViaEgress(
  egressUrl: string,
  target: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  timeoutMs = 60000,
): Promise<EgressResult> {
  const res = await fetch(`${egressUrl}/fetch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      url: target,
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      ...(init.body != null ? { body: init.body } : {}),
      timeoutMs,
    }),
  });
  if (!res.ok) throw new Error(`egress ${res.status} for ${target.slice(0, 160)} body=${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as {
    status: number;
    headers?: Record<string, string>;
    body: string;
    encoding?: string;
  };
  const text = data.encoding === "base64" ? decodeBase64Utf8(data.body) : data.body;
  return { status: data.status, headers: data.headers ?? {}, text };
}

function decodeBase64Utf8(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

export interface PipeResult {
  sourceStatus: number;
  status: number;
  text: string;
}

export async function pipeViaEgress(
  egressUrl: string,
  from: string,
  to: string,
  toHeaders: Record<string, string> = {},
): Promise<PipeResult> {
  const res = await fetch(`${egressUrl}/pipe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from, to, toHeaders }),
  });
  if (!res.ok) throw new Error(`egress pipe ${res.status}`);
  const data = (await res.json()) as {
    sourceStatus: number;
    status: number;
    body: string;
    encoding?: string;
  };
  const text = data.encoding === "base64" ? decodeBase64Utf8(data.body) : data.body;
  return { sourceStatus: data.sourceStatus, status: data.status, text };
}
