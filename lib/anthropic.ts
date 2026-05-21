import Anthropic from "@anthropic-ai/sdk";

const apiKey = process.env.ANTHROPIC_API_KEY;

if (!apiKey) {
  throw new Error("Missing ANTHROPIC_API_KEY in .env.local");
}

export const anthropic = new Anthropic({ apiKey });

export const CHAT_MODEL = "claude-sonnet-4-20250514";
