export function safeJsonParse(s: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(s);
    return typeof parsed === "object" && parsed !== null &&
        !Array.isArray(parsed)
      ? parsed
      : { raw_arguments: s };
  } catch {
    return { raw_arguments: s };
  }
}
