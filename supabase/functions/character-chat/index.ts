import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return reply(405, { error: "POST 요청만 지원해요." });

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !anonKey || !serviceKey) return reply(500, { error: "서버 설정이 완전하지 않아요." });

  const authorization = req.headers.get("Authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) return reply(401, { error: "로그인해 주세요." });

  const authClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: authorization } } });
  const { data: authData, error: authError } = await authClient.auth.getUser(token);
  if (authError || !authData.user) return reply(401, { error: "로그인 세션을 확인할 수 없어요." });
  const userId = authData.user.id;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  let body: Record<string, any>;
  try { body = await req.json(); } catch { return reply(400, { error: "요청 형식이 올바르지 않아요." }); }

  async function ensureCredits() {
    let result = await admin.from("user_credits").select("balance").eq("user_id", userId).maybeSingle();
    if (result.error) throw result.error;
    if (!result.data) {
      const inserted = await admin.from("user_credits").insert({ user_id: userId, balance: 100 });
      if (inserted.error && inserted.error.code !== "23505") throw inserted.error;
      result = await admin.from("user_credits").select("balance").eq("user_id", userId).single();
      if (result.error) throw result.error;
    }
    return Number(result.data.balance);
  }

  try {
    const startingBalance = await ensureCredits();
    if (body.action === "balance") return reply(200, { credits: startingBalance });

    const character = body.character ?? {};
    const messages = Array.isArray(body.messages) ? body.messages.slice(-40) : [];
    const requestedModel = String(body.model ?? "auto");
    if (!messages.length || !messages.some((m: any) => m?.role === "user")) return reply(400, { error: "대화 내용을 입력해 주세요." });
    if (messages.some((m: any) => typeof m?.content !== "string" && typeof m?.text !== "string")) return reply(400, { error: "대화 형식이 올바르지 않아요." });

    const model = ["groq", "gemini", "openai-compatible"].includes(requestedModel) ? requestedModel : "groq";
    const requestId = crypto.randomUUID();
    let chargedBalance: number;
    const charged = await admin.rpc("change_user_credits", { p_user_id: userId, p_delta: -1, p_model: model, p_request_id: requestId });
    if (charged.error) {
      if (String(charged.error.message ?? "").includes("INSUFFICIENT_CREDITS")) return reply(402, { error: "크레딧이 부족해요. 충전 기능이 준비되면 다시 이용할 수 있어요.", credits: 0 });
      console.error("Credit deduction failed:", charged.error.message);
      return reply(500, { error: "크레딧을 확인하지 못했어요." });
    }
    chargedBalance = Number(charged.data);

    const promptParts = [
      "너는 사용자가 만든 캐릭터를 연기하는 대화형 AI다. 캐릭터 설정을 우선하며, 사용자의 메시지에 자연스럽게 답한다.",
      "캐릭터 이름: " + String(character.name ?? "캐릭터").slice(0, 100),
      "캐릭터 설명: " + String(character.description ?? "").slice(0, 4000),
      "캐릭터 프롬프트: " + String(character.prompt ?? "").slice(0, 10000),
      "템플릿: " + String(character.template ?? "1:1"),
      "프롤로그: " + String(character.prologue ?? "").slice(0, 1000),
      "시작 설정: " + JSON.stringify(Array.isArray(character.startSettings) ? character.startSettings.slice(0, 20) : []).slice(0, 8000),
      "키워드북: " + JSON.stringify(Array.isArray(character.keywordBook) ? character.keywordBook.slice(0, 50) : []).slice(0, 10000),
      "이미지 에셋 설명: " + JSON.stringify(Array.isArray(character.assets) ? character.assets.map((a: any) => ({ name: a.name, situation: a.situation })).slice(0, 30) : []).slice(0, 4000),
      "설정과 대화의 연속성을 지키고, 설정에 없는 사실은 확정적으로 만들지 않는다. 사용자가 요청한 문체를 따르며 불필요한 메타 발언은 하지 않는다.",
    ];
    const systemPrompt = promptParts.join("\n\n");
    const chatMessages = messages.map((m: any) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: String(m.content ?? m.text ?? "").slice(0, 5000),
    })).filter((m: any) => m.content.length > 0);
    let answer = "";

    try {
      if (model === "groq") {
        const key = Deno.env.get("GROQ_API_KEY");
        if (!key) throw new Error("MISSING_PROVIDER_KEY");
        const modelName = Deno.env.get("GROQ_MODEL") ?? "llama-3.3-70b-versatile";
        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
          body: JSON.stringify({ model: modelName, messages: [{ role: "system", content: systemPrompt }, ...chatMessages], temperature: 0.85, max_tokens: 1200 }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(res.status === 429 ? "PROVIDER_RATE_LIMIT" : "PROVIDER_REQUEST_FAILED");
        answer = String(data.choices?.[0]?.message?.content ?? "").trim();
      } else if (model === "gemini") {
        const key = Deno.env.get("GOOGLE_GEMINI_API_KEY");
        if (!key) throw new Error("MISSING_PROVIDER_KEY");
        const modelName = Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash";
        const contents = chatMessages.map((m: any) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
        const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(modelName) + ":generateContent", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({ systemInstruction: { parts: [{ text: systemPrompt }] }, contents, generationConfig: { temperature: 0.85, maxOutputTokens: 1200 } }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(res.status === 429 ? "PROVIDER_RATE_LIMIT" : "PROVIDER_REQUEST_FAILED");
        answer = (data.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("").trim();
      } else {
        const key = Deno.env.get("OPENAI_API_KEY");
        if (!key) throw new Error("MISSING_PROVIDER_KEY");
        const base = (Deno.env.get("OPENAI_BASE_URL") ?? "https://api.openai.com/v1").replace(/\/+$/, "");
        const modelName = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini";
        const res = await fetch(base + "/chat/completions", {
          method: "POST",
          headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
          body: JSON.stringify({ model: modelName, messages: [{ role: "system", content: systemPrompt }, ...chatMessages], temperature: 0.85, max_tokens: 1200 }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(res.status === 429 ? "PROVIDER_RATE_LIMIT" : "PROVIDER_REQUEST_FAILED");
        answer = String(data.choices?.[0]?.message?.content ?? "").trim();
      }
      if (!answer) throw new Error("EMPTY_PROVIDER_RESPONSE");
    } catch (providerError) {
      const refund = await admin.rpc("change_user_credits", { p_user_id: userId, p_delta: 1, p_model: model, p_request_id: requestId });
      if (refund.error) console.error("Credit refund failed:", refund.error.message);
      const message = providerError instanceof Error ? providerError.message : "";
      if (message === "MISSING_PROVIDER_KEY") return reply(503, { error: "선택한 AI의 API 키가 서버에 설정되지 않았어요. 서버 관리자가 키를 등록해야 해요." });
      if (message === "PROVIDER_RATE_LIMIT") return reply(429, { error: "AI 서비스 사용량이 일시적으로 많아요. 잠시 후 다시 시도해 주세요." });
      console.error("AI provider request failed:", message);
      return reply(502, { error: "AI 서비스에서 응답을 받지 못했어요. 크레딧은 반환 처리했어요." });
    }

    return reply(200, { reply: answer, credits: chargedBalance });
  } catch (error) {
    console.error("character-chat error:", error instanceof Error ? error.message : error);
    return reply(500, { error: "서버에서 요청을 처리하지 못했어요." });
  }
});
