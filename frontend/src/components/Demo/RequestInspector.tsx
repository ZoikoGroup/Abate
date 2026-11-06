// frontend/src/components/Demo/RequestInspector.tsx
import React, { useState } from "react";
import { type DemoInspectResult, maskToken } from "./demoApi";

interface RequestInspectorProps {
  inspection: DemoInspectResult | null;
  title?: string;
}

export const RequestInspector: React.FC<RequestInspectorProps> = ({
  inspection,
  title = "HTTP Request & Response Inspector"
}) => {
  const [copiedCurl, setCopiedCurl] = useState(false);
  const [activeTab, setActiveTab] = useState<"response" | "request" | "curl">("response");

  if (!inspection) {
    return (
      <div className="inspector-card empty">
        <div className="inspector-placeholder">
          <span className="placeholder-icon">⚡</span>
          <p>No request fired yet. Click the action button to inspect wire traffic.</p>
        </div>
      </div>
    );
  }

  const {
    method,
    url,
    requestHeaders,
    requestBody,
    status,
    statusText,
    responseHeaders,
    body,
    ms,
    requestId,
    curlCommand
  } = inspection;

  const handleCopyCurl = async () => {
    try {
      await navigator.clipboard.writeText(curlCommand);
      setCopiedCurl(true);
      setTimeout(() => setCopiedCurl(false), 2000);
    } catch {
      // Fallback
      setCopiedCurl(true);
      setTimeout(() => setCopiedCurl(false), 2000);
    }
  };

  const getStatusClass = (code: number) => {
    if (code >= 200 && code < 300) return "status-2xx";
    if (code === 409) return "status-409";
    if (code >= 400 && code < 500) return "status-4xx";
    if (code >= 500) return "status-5xx";
    return "status-err";
  };

  // Mask auth tokens in displayed request headers
  const displayHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(requestHeaders)) {
    if (k.toLowerCase() === "authorization") {
      displayHeaders[k] = v.startsWith("Bearer ")
        ? `Bearer ${maskToken(v.replace("Bearer ", ""))}`
        : maskToken(v);
    } else {
      displayHeaders[k] = v;
    }
  }

  return (
    <div className="inspector-card" aria-label={title}>
      <div className="inspector-header">
        <div className="inspector-main-meta">
          <span className={`method-badge method-${method.toLowerCase()}`}>{method}</span>
          <span className="url-badge" title={url}>{url}</span>
        </div>
        <div className="inspector-right-meta">
          <span className={`status-badge ${getStatusClass(status)}`}>
            {status} {statusText}
          </span>
          <span className="ms-badge">{ms} ms</span>
          <button
            type="button"
            className={`curl-copy-btn ${copiedCurl ? "copied" : ""}`}
            onClick={handleCopyCurl}
            title="Copy as cURL"
            aria-label="Copy cURL command to clipboard"
          >
            {copiedCurl ? "✔ Copied cURL" : "Copy as cURL"}
          </button>
        </div>
      </div>

      <div className="inspector-subbar">
        <div className="request-id-display">
          <span className="subbar-label">X-Request-Id:</span>
          <code>{requestId}</code>
        </div>
        <div className="inspector-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "response"}
            className={`itab-btn ${activeTab === "response" ? "active" : ""}`}
            onClick={() => setActiveTab("response")}
          >
            Response Body
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "request"}
            className={`itab-btn ${activeTab === "request" ? "active" : ""}`}
            onClick={() => setActiveTab("request")}
          >
            Request Headers & Body
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "curl"}
            className={`itab-btn ${activeTab === "curl" ? "active" : ""}`}
            onClick={() => setActiveTab("curl")}
          >
            cURL Syntax
          </button>
        </div>
      </div>

      <div className="inspector-body">
        {activeTab === "response" && (
          <div className="body-pane">
            <div className="pane-header">
              <span>Response Payload</span>
              <span className="content-type">{responseHeaders["content-type"] || "application/json"}</span>
            </div>
            <pre className="json-display">
              <code>{typeof body === "object" ? JSON.stringify(body, null, 2) : String(body)}</code>
            </pre>
          </div>
        )}

        {activeTab === "request" && (
          <div className="body-pane">
            <div className="headers-table-box">
              <span className="subheading">Request Headers:</span>
              <table className="mini-table">
                <tbody>
                  {Object.entries(displayHeaders).map(([k, v]) => (
                    <tr key={k}>
                      <td className="h-key">{k}</td>
                      <td className="h-val"><code>{v}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="payload-box">
              <span className="subheading">Request Body:</span>
              {requestBody !== undefined && requestBody !== null ? (
                <pre className="json-display">
                  <code>{typeof requestBody === "object" ? JSON.stringify(requestBody, null, 2) : String(requestBody)}</code>
                </pre>
              ) : (
                <p className="no-payload">No request payload sent (GET request or empty body).</p>
              )}
            </div>
          </div>
        )}

        {activeTab === "curl" && (
          <div className="body-pane">
            <div className="pane-header">
              <span>Executable Command Line:</span>
            </div>
            <pre className="curl-display">
              <code>{curlCommand}</code>
            </pre>
          </div>
        )}
      </div>
    </div>
  );
};
