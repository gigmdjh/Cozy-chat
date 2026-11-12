# Cozy Chat AI backend

The `character-chat` Edge Function is deployed to the linked Supabase project. Source: `supabase/functions/character-chat/index.ts`.

## Provider secrets

Add API keys in the Supabase Dashboard's Edge Function secrets/settings area. Do not place provider keys in `index.html`.

- `GROQ_API_KEY` — enables Groq (default model: `llama-3.3-70b-versatile`)
- `GOOGLE_GEMINI_API_KEY` — enables Gemini (default model: `gemini-2.5-flash`)
- `OPENAI_API_KEY` — enables the OpenAI-compatible option (default model: `gpt-4o-mini`)

Optional model overrides: `GROQ_MODEL`, `GEMINI_MODEL`, `OPENAI_MODEL`. The OpenAI-compatible endpoint can be changed with `OPENAI_BASE_URL`.

Only configure the providers you actually intend to offer. A provider without its key returns a clear error and refunds the request credit.

## Database schema

All schema lives in `supabase/migrations/` and matches the remote project's migration history. `20261101000000_base_schema.sql` records tables that were first created in the SQL Editor; it is already applied remotely, so when linking the CLI run `supabase migration repair --status applied 20261101000000` once.

Like counts are served from the `character_like_counts` table, kept up to date by a trigger on `character_likes`. Who liked what is private: signed-in users can only read their own likes.

## Request options

- `stream: true` returns Server-Sent Events: `{type:"delta",text}` chunks, then `{type:"done",credits}` or `{type:"error",error}`. Without it the function returns `{reply, credits}` as before.
- `conversationKey` (the character id) loads that room's long-term memory from `conversations.memory`. After a reply, once 12+ messages have scrolled out of the 40-message window, they are summarized into `memory` in the background.
- `action: "balance"` returns `{credits, dailyClaimed}`; `action: "claim_daily"` grants the daily 100-cookie reward once per KST day.

## Moderation

Reports go to `public.reports`. Three distinct reporters automatically set `hidden = true` on a post or public character; review and un-hide from the Table Editor. Users can block others (`user_blocks`); blocked users' posts and characters are filtered client-side.

## Images

Character, asset, and profile images upload to the public `cozy-images` Storage bucket under `<user_id>/...`. Older base64 images are moved there automatically the next time their owner signs in.

## Credits (shown to users as 쿠키)

The database migrations `character_chat_credits`, `credit_balance_rpc`, and `public_character_catalog` were applied to the connected Supabase project. Public character records are stored separately so private characters are not exposed by the catalog. A user receives 100 initial credits when their balance is first created. A successful AI response costs the model base (Groq 20, OpenAI 20, Gemini 50 cookies; 1 cookie ≈ ₩1) times the output multiplier (1–5×), rounded up. New users get 1,000 cookies. Failed provider calls attempt to refund that credit.

The balance and transaction tables are not writable by regular authenticated clients. Credit adjustments run through the server-side RPC using the Edge Function's service role. Payment/top-up integration is not implemented yet.
