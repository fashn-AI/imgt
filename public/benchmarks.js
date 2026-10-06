import { latencyRows, latencyNote } from "./benchmark-data.js";

const environment = document.querySelector("#environment");
const workload = document.querySelector("#workload");
const chart = document.querySelector("#latency-chart");
const namespace = "http://www.w3.org/2000/svg";

function updateLatency() {
  const rows = latencyRows(environment.value, workload.value);
  const maximum = Math.max(0.001, ...rows.map((row) => row.value ?? 0)) * 1.05;
  chart.replaceChildren(
    ...rows.map((row) => {
      const element = document.createElement("div");
      element.className = `chart-row${row.recommended ? " recommended" : ""}${row.id === "vercel" ? " vercel" : ""}`;
      const label = document.createElement("span");
      label.className = "chart-label";
      label.textContent = row.name;
      const detail = document.createElement("small");
      detail.textContent = row.detail;
      label.append(detail);
      const svg = document.createElementNS(namespace, "svg");
      svg.setAttribute("viewBox", "0 0 1000 24");
      svg.setAttribute("preserveAspectRatio", "none");
      svg.setAttribute("aria-hidden", "true");
      const bar = document.createElementNS(namespace, "rect");
      bar.setAttribute("width", String(((row.value ?? 0) / maximum) * 1000));
      bar.setAttribute("height", "24");
      bar.setAttribute("rx", "2");
      svg.append(bar);
      const value = document.createElement("span");
      value.className = "chart-value";
      value.textContent =
        row.value === null ? row.emptyLabel : `${row.value.toFixed(3)} s`;
      const status = document.createElement("small");
      status.textContent = row.status;
      value.append(status);
      element.append(label, svg, value);
      return element;
    }),
  );
  document.querySelector("#latency-note").textContent = latencyNote(
    environment.value,
    workload.value,
  );
}
environment.addEventListener("change", updateLatency);
workload.addEventListener("change", updateLatency);
