// frontend/src/components/Demo/demoApi.ts
// Universal demo API inspector client for Abate Live Demo Console

export interface DemoInspectResult<T = any> {
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  requestBody?: any;
  status: number;
  statusText: string;
  responseHeaders: Record<string, string>;
  body: T;
  ms: number;
  requestId: string;
  curlCommand: string;
  timestamp: string;
}

export interface DemoApiOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  token?: string | null;
  idempotencyKey?: string | null;
  ifMatch?: string | null;
  body?: any;
  headers?: Record<string, string>;
}

export function maskToken(token: string | null | undefined): string {
  if (!token) return "(none)";
  if (token.length <= 16) return token.slice(0, 4) + "...";
  return token.slice(0, 8) + "..." + token.slice(-6);
}

export function buildCurlCommand(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: any,
  maskAuth: boolean = false
): string {
  const parts: string[] = [`curl -X ${method} "${url}"`];

  for (const [key, value] of Object.entries(headers)) {
    if (maskAuth && key.toLowerCase() === "authorization") {
      parts.push(`  -H "${key}: Bearer <jwt-masked>"`);
    } else {
      parts.push(`  -H "${key}: ${value}"`);
    }
  }

  if (body !== undefined && body !== null) {
    const jsonStr = typeof body === "string" ? body : JSON.stringify(body);
    parts.push(`  -d '${jsonStr}'`);
  }

  return parts.join(" \\\n");
}

/**
 * Universal demoApi execution function.
 * Never throws away error bodies. Captures exact latency, headers, and payload.
 */
export async function demoApi<T = any>(
  endpoint: string,
  options: DemoApiOptions = {}
): Promise<DemoInspectResult<T>> {
  const method = options.method || (options.body ? "POST" : "GET");
  // Relative endpoint in browser will hit Vite proxy (/api -> http://127.0.0.1:5000)
  const resolvedUrl = endpoint.startsWith("http")
    ? endpoint
    : (typeof window !== "undefined" ? endpoint : `http://127.0.0.1:5000${endpoint}`);

  const reqHeaders: Record<string, string> = {
    "Accept": "application/json",
    ...(options.headers || {})
  };

  if (options.body !== undefined && options.body !== null) {
    reqHeaders["Content-Type"] = "application/json";
  }

  if (options.token) {
    reqHeaders["Authorization"] = `Bearer ${options.token}`;
  }

  if (options.idempotencyKey) {
    reqHeaders["Idempotency-Key"] = options.idempotencyKey;
  }

  if (options.ifMatch) {
    reqHeaders["If-Match"] = options.ifMatch;
  }

  const startTime = performance.now();
  let status = 0;
  let statusText = "Network Error";
  const respHeaders: Record<string, string> = {};
  let bodyData: any = null;
  let requestId = "unknown";

  try {
    const fetchInit: RequestInit = {
      method,
      headers: reqHeaders,
    };

    if (options.body !== undefined && options.body !== null) {
      fetchInit.body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await fetch(resolvedUrl, fetchInit);
    } catch (netErr: any) {
      // In case Vite proxy isn't reachable, try direct loopback
      if (!endpoint.startsWith("http")) {
        response = await fetch(`http://127.0.0.1:5000${endpoint}`, fetchInit);
      } else {
        throw netErr;
      }
    }

    const elapsedMs = Math.round(performance.now() - startTime);
    status = response.status;
    statusText = response.statusText || (status === 200 ? "OK" : `${status}`);

    response.headers.forEach((val, key) => {
      respHeaders[key.toLowerCase()] = val;
    });

    requestId = respHeaders["x-request-id"] || "req-" + Math.random().toString(36).substring(2, 9);

    const contentType = respHeaders["content-type"] || "";
    if (contentType.includes("application/json")) {
      try {
        bodyData = await response.json();
        if (bodyData && bodyData.requestId && requestId === "unknown") {
          requestId = bodyData.requestId;
        }
      } catch {
        bodyData = await response.text();
      }
    } else {
      bodyData = await response.text();
    }

    // Build reproducible cURL command
    const curlCommand = buildCurlCommand(
      typeof window !== "undefined" && !endpoint.startsWith("http")
        ? `http://localhost:5000${endpoint}`
        : resolvedUrl,
      method,
      reqHeaders,
      options.body,
      false
    );

    return {
      url: resolvedUrl,
      method,
      requestHeaders: reqHeaders,
      requestBody: options.body,
      status,
      statusText,
      responseHeaders: respHeaders,
      body: bodyData,
      ms: elapsedMs,
      requestId,
      curlCommand,
      timestamp: new Date().toISOString()
    };
  } catch (err: any) {
    const elapsedMs = Math.round(performance.now() - startTime);
    return {
      url: resolvedUrl,
      method,
      requestHeaders: reqHeaders,
      requestBody: options.body,
      status: 0,
      statusText: "Connection Failed",
      responseHeaders: {},
      body: { error: err.message || "Failed to fetch from backend" } as any,
      ms: elapsedMs,
      requestId: "offline",
      curlCommand: buildCurlCommand(resolvedUrl, method, reqHeaders, options.body, false),
      timestamp: new Date().toISOString()
    };
  }
}

