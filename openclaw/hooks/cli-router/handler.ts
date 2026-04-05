/**
 * cli-router hook — message:sent handler
 *
 * Detects [routing: general|code|complex] tags in outbound messages,
 * calls the Claude Code CLI harness, and sends the result back.
 */

const HARNESS_BASE = "http://host.docker.internal:18795/backend-api/claude-code";
const ROUTING_REGEX = /\[routing:\s*(general|code|complex)\]\s*([\s\S]*)/;
const TIMEOUT_MS = 300_000; // 5 minutes

async function callHarness(agent: string, task: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(`${HARNESS_BASE}/cli/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: agent, message: task }),
      signal: controller.signal,
    });

    const result = await resp.json();

    if (result.ok && result.response) {
      return result.response;
    } else {
      return `执行失败：${result.error || "未知错误"}`;
    }
  } catch (err: any) {
    if (err.name === "AbortError") {
      return "任务执行超时（5分钟），请简化任务后重试。";
    }
    return `CLI 连接失败：${err.message}`;
  } finally {
    clearTimeout(timer);
  }
}

const handler = async (event: any) => {
  // Extract text from the outbound message
  const text = event.text || event.message?.text || event.content || "";

  if (typeof text !== "string") return;

  const match = text.match(ROUTING_REGEX);
  if (!match) return; // No routing tag — normal reply, skip

  const agent = match[1]; // general | code | complex
  const task = match[2].trim();

  if (!task) return; // Empty task, skip

  // Call CLI harness and push the result as a follow-up message
  const result = await callHarness(agent, task);
  event.messages.push(result);
};

export default handler;
