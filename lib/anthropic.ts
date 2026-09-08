import Anthropic from "@anthropic-ai/sdk";

let cached: Anthropic | null = null;

export const CHAT_MODEL = "claude-opus-5";

// Both call sites are short, well-scoped tasks over retrieved context, so we
// run at low effort: less thinking, faster first token, lower spend.
export const EFFORT = "low" as const;

export function getAnthropic(): Anthropic {
  if (cached) return cached;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to your Vercel project's Environment Variables."
    );
  }
  cached = new Anthropic({ apiKey });
  return cached;
}
