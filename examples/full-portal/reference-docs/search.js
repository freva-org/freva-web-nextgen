// A stand-in for a documentation generator's own search bundle. It is trusted
// same-origin code, not sanitised prose, which is exactly what static-docs-v1
// declares.
document.addEventListener("DOMContentLoaded", () => {
  const marker = document.createElement("p");
  marker.dataset.subsiteReady = "true";
  marker.textContent = "Documentation search is ready.";
  document.body.append(marker);
});

// A same-origin worker, permitted by `runtime.workers: "self"` and by nothing
// else. Declaring `none` in the policy makes the browser refuse this line.
try {
  const worker = new Worker("search-worker.js");
  worker.onmessage = (event) => {
    const marker = document.createElement("p");
    marker.dataset.subsiteWorker = String(event.data);
    document.body.append(marker);
  };
  worker.postMessage("reference");
} catch (error) {
  const marker = document.createElement("p");
  marker.dataset.subsiteWorkerError = String(error);
  document.body.append(marker);
}
