const KEYS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
] as const;

export function logEnvStatus(tag: string) {
  const status = Object.fromEntries(
    KEYS.map((k) => {
      const v = process.env[k];
      return [
        k,
        v
          ? { present: true, length: v.length, preview: v.slice(0, 6) + "…" }
          : { present: false },
      ];
    })
  );
  console.log(`[${tag}] env status`, status);
}

export function missingEnvVars(): string[] {
  return KEYS.filter((k) => !process.env[k]);
}
