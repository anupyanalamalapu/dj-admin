export async function parseJsonResponseSafe<T>(response: Response): Promise<{ data?: T; rawText: string; error?: string }> {
  const rawText = await response.text();
  if (!rawText.trim()) {
    return { data: undefined, rawText, error: "Empty response body" };
  }

  try {
    return { data: JSON.parse(rawText) as T, rawText };
  } catch {
    return {
      data: undefined,
      rawText,
      error: "Response body was not valid JSON",
    };
  }
}
