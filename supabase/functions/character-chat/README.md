# Cozy Chat AI backend

The `character-chat` Edge Function is deployed to the linked Supabase project. Source: `supabase/functions/character-chat/index.ts`.

## Provider secrets

Add API keys in the Supabase Dashboard's Edge Function secrets/settings area. Do not place provider keys in `index.html`.

- `GROQ_API_KEY` — enables Groq (default model: `llama-3.3-70b-versatile`)
- `GOOGLE_GEMINI_API_KEY` — enables Gemini (default model: `gemini-2.5-flash`)
- `OPENAI_API_KEY` — enables the OpenAI-compatible option (default model: `gpt-4o-mini`)

Optional model overrides: `GROQ_MODEL`, `GEMINI_MODEL`, `OPENAI_MODEL`. The OpenAI-compatible endpoint can be changed with `OPENAI_BASE_URL`.

Only configure the providers you actually intend to offer. A provider without its key returns a clear error and refunds the request credit.

## Credits

The database migrations `character_chat_credits` and `credit_balance_rpc` were applied to the connected Supabase project. A user receives 100 initial credits when their balance is first created. A successful AI response costs 1 credit. Failed provider calls attempt to refund that credit.

The balance and transaction tables are not writable by regular authenticated clients. Credit adjustments run through the server-side RPC using the Edge Function's service role. Payment/top-up integration is not implemented yet.
