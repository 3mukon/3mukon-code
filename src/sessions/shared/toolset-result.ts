import type { AutomationCallReceipt } from './automation';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
export function isAutomationReceipt(value: unknown): value is AutomationCallReceipt {
  const receipt = record(value);
  return (
    receipt?.schemaVersion === 1 &&
    typeof receipt.callId === 'string' &&
    receipt.callId.length > 0 &&
    receipt.callId.length <= 128
  );
}

// Call only for a registered native tool or dispatcher candidate. A parsed receipt is not authority:
// ToolsetAccess.result must validate the retained call's owner, turn, generation and canonical name
// before linking anything. Read the outer envelope, never recursively search page content, tool
// arguments or model prose for a correlation ID.
export function toolsetReceipt(
  structured: unknown,
  content: unknown,
): AutomationCallReceipt | undefined {
  let envelope = record(structured);
  if (!record(envelope?.automation)) {
    const first = Array.isArray(content) ? record(content[0]) : undefined;
    const text =
      typeof content === 'string'
        ? content
        : first?.type === 'text'
          ? first.text
          : typeof structured === 'string'
            ? structured
            : undefined;
    if (typeof text !== 'string' || text.length > 256 * 1024) return;
    try {
      envelope = record(JSON.parse(text));
    } catch {
      return;
    }
  }
  const receipt = record(envelope?.automation);
  if (
    !record(envelope?.outcome) ||
    !Array.isArray(envelope?.presentationNotices) ||
    receipt?.schemaVersion !== 1 ||
    typeof receipt.callId !== 'string' ||
    !receipt.callId ||
    receipt.callId.length > 128
  )
    return;
  return { schemaVersion: 1, callId: receipt.callId };
}

export function registeredTool(
  name: string,
  prefix: string,
  tools: readonly string[] | undefined,
): string | undefined {
  if (!name.startsWith(prefix)) return;
  const canonical = name.slice(prefix.length);
  return tools?.includes(canonical) ? canonical : undefined;
}
