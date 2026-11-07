// backend/tools/load/release-compile.k6.js
// K6 Load & Concurrency Test (Playbook B8 §8.2 / Guide Page 90)
// Measures p95 latency and verifies ZERO count or contributor leakage under concurrency.

import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  scenarios: {
    burst: {
      executor: "constant-arrival-rate",
      rate: 30,
      timeUnit: "1s",
      duration: "30s",
      preAllocatedVUs: 50,
      maxVUs: 100
    }
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<1500"]
  }
};

function sampleQuery() {
  return {
    metricId: "BOUNDARY_INTRUSION_SHARE",
    cohortRef: "tenantA-ops",
    periodStart: "2026-01-05T00:00:00Z",
    periodEnd: "2026-03-01T00:00:00Z"
  };
}

export default function () {
  const base = __ENV.BASE || "http://127.0.0.1:5000";
  const token = __ENV.TOKEN;

  const url = `${base}/api/v2/releases/query`;
  const payload = JSON.stringify(sampleQuery());
  const params = {
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      "Idempotency-Key": `k6-${__VU}-${__ITER}-${Date.now()}`
    }
  };

  const res = http.post(url, payload, params);

  check(res, {
    "status is 200 or 400": (r) => r.status === 200 || r.status === 400,
    "no count leak in body": (r) => !/\bcount\b|contributors/i.test(r.body),
    "response under 1500ms": (r) => r.timings.duration < 1500
  });

  sleep(0.1);
}

