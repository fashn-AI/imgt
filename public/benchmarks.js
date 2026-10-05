import { allocations, estimateCosts } from "./benchmark-costs.js";

const workloads = {
  gallery: [1.755, 2.637, 4.201, 2.996, 1.377],
  sustained: [1.148, 1.462, null, null, 1.341],
  burst: [6.525, 5.636, 15.254, 9.812, 1.508],
  cached: [0.23, 0.222, 0.467, 0.28, 0.193],
};
const currency = (value) => `$${value.toFixed(2)}`;

function updateChart(id, values, format) {
  const maximum =
    Math.max(0.001, ...values.filter((value) => value !== null)) * 1.05;
  document.querySelectorAll(`#${id} .chart-row`).forEach((row, i) => {
    row
      .querySelector("rect")
      .setAttribute("width", String(((values[i] ?? 0) / maximum) * 1000));
    row.querySelector(".chart-value").textContent =
      values[i] === null ? "Not tested" : format(values[i]);
  });
}

const workload = document.querySelector("#workload");
workload.addEventListener("change", () => {
  updateChart(
    "latency-chart",
    workloads[workload.value],
    (value) => `${value.toFixed(3)} s`,
  );
});

const form = document.querySelector("#cost-inputs");
function updateCosts() {
  const status = document.querySelector("#cost-status");
  if (!form.checkValidity()) {
    status.textContent =
      "Enter valid numbers within the field limits. The chart retains the last valid scenario.";
    return;
  }
  const values = new FormData(form);
  const scenario = Object.fromEntries(
    [...values].map(([key, value]) => [
      key,
      key === "region"
        ? value
        : key === "included"
          ? value === "true"
          : Number(value),
    ]),
  );
  if (scenario.requests < scenario.transforms) {
    status.textContent =
      "Total requests must be at least the number of fresh transforms. The chart retains the last valid scenario.";
    return;
  }
  const costs = allocations.map((allocation) =>
    estimateCosts(allocation, scenario),
  );
  updateChart(
    "cost-chart",
    [...costs.map((cost) => cost.imgtTotal), costs[0].vercelTotal],
    currency,
  );
  document.querySelectorAll("#cost-chart .chart-row").forEach((row, i) => {
    if (costs[i] && !costs[i].feasible) {
      row.querySelector("rect").setAttribute("width", "0");
      row.querySelector(".chart-value").textContent = "Over capacity";
    }
  });
  for (const row of document.querySelectorAll("#cost-breakdown tr")) {
    row.querySelectorAll("td").forEach((cell, i) => {
      cell.textContent = currency(
        row.dataset.component === "total"
          ? costs[i].imgtTotal
          : costs[i].cloudflare[row.dataset.component],
      );
    });
  }
  const adjusted = costs.filter(
    (cost) => cost.effectiveAwakePercent > scenario.awakePercent + 0.01,
  );
  status.textContent = costs.some((cost) => !cost.feasible)
    ? "At least one allocation lacks enough CPU time for this volume, even awake all month. Its price is not a viable capacity estimate."
    : adjusted.length
      ? "Some allocations need more awake time than selected to cover the modeled CPU work. Their prices use that theoretical minimum."
      : "Estimates use the selected assumptions. Smaller allocations have less uncached burst capacity.";
}
form.addEventListener("input", updateCosts);
updateCosts();
