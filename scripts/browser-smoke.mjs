import { writeFile } from "node:fs/promises";

const [url, outputPath, rawWidth, rawHeight, waitText] = process.argv.slice(2);
if (!url || !outputPath || !rawWidth || !rawHeight || !waitText) {
  throw new Error("Usage: browser-smoke <url> <png> <width> <height> <wait-text>");
}

const targetResponse = await fetch(
  `http://127.0.0.1:9222/json/new?${encodeURIComponent(url)}`,
  { method: "PUT" }
);
if (!targetResponse.ok) throw new Error("Chrome debugging target unavailable");
const target = await targetResponse.json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let sequence = 0;
const pending = new Map();
const failures = [];
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id) {
    const operation = pending.get(message.id);
    if (!operation) return;
    pending.delete(message.id);
    if (message.error) operation.reject(new Error(message.error.message));
    else operation.resolve(message.result);
    return;
  }
  if (message.method === "Runtime.exceptionThrown") {
    const details = message.params.exceptionDetails;
    failures.push(
      `exception:${details.exception?.description ?? details.text}`
    );
  }
  if (
    message.method === "Runtime.consoleAPICalled" &&
    ["error", "warning"].includes(message.params.type)
  ) {
    failures.push(
      `console:${message.params.type}:${message.params.args
        .map((argument) => argument.value ?? argument.description ?? argument.type)
        .join(" ")}`
    );
  }
  if (
    message.method === "Log.entryAdded" &&
    ["error", "warning"].includes(message.params.entry.level)
  ) {
    failures.push(`log:${message.params.entry.level}:${message.params.entry.text}`);
  }
  if (
    message.method === "Network.loadingFailed" &&
    !message.params.canceled
  ) {
    failures.push(`network:${message.params.errorText}`);
  }
  if (
    message.method === "Network.responseReceived" &&
    message.params.response.status >= 400
  ) {
    failures.push(
      `http:${message.params.response.status}:${message.params.response.url}`
    );
  }
});

function command(method, params = {}) {
  const id = ++sequence;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

await Promise.all([
  command("Page.enable"),
  command("Runtime.enable"),
  command("Network.enable"),
  command("Log.enable"),
  command("Accessibility.enable")
]);
await command("Emulation.setDeviceMetricsOverride", {
  width: Number(rawWidth),
  height: Number(rawHeight),
  deviceScaleFactor: 1,
  mobile: false
});
await command("Page.navigate", { url });

const deadline = Date.now() + 12_000;
let ready = false;
while (Date.now() < deadline) {
  const result = await command("Runtime.evaluate", {
    expression: `document.body?.innerText.includes(${JSON.stringify(waitText)}) === true`,
    returnByValue: true
  });
  if (result.result.value === true) {
    ready = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!ready) failures.push(`timeout:missing text ${waitText}`);

await new Promise((resolve) => setTimeout(resolve, 250));
const screenshot = await command("Page.captureScreenshot", {
  format: "png",
  captureBeyondViewport: false,
  fromSurface: true
});
await writeFile(outputPath, Buffer.from(screenshot.data, "base64"));

const accessibility = await command("Accessibility.getFullAXTree");
const namedInteractiveNodes = accessibility.nodes.filter((node) =>
  ["button", "link", "textbox", "combobox"].includes(node.role?.value)
).filter((node) => String(node.name?.value ?? "").trim().length > 0).length;
const unnamedInteractiveNodes = accessibility.nodes.filter((node) =>
  ["button", "link", "textbox", "combobox"].includes(node.role?.value)
).filter((node) => String(node.name?.value ?? "").trim().length === 0).length;

socket.close();
await fetch(`http://127.0.0.1:9222/json/close/${target.id}`);
console.log(
  JSON.stringify({
    url,
    viewport: `${rawWidth}x${rawHeight}`,
    ready,
    namedInteractiveNodes,
    unnamedInteractiveNodes,
    failures
  })
);
