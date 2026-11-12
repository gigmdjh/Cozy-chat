import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

const DAILY_COOKIES = 100;
// 대화 1번(출력 배율 1×)에 쓰는 쿠키. 쿠키 1개 ≈ ₩1, 원가의 약 5배 이상이 남도록 잡은 값
const MODEL_COOKIES: Record<string, number> = { groq: 20, "openai-compatible": 20, gemini: 50 };
const MEMORY_BATCH = 12; // 기억으로 묶을 최소 메시지 수

// 캐릭터 설정보다 항상 우선하는 안전 규칙 (이용약관 · 운영정책과 같은 내용)
const SAFETY_RULES = [
  "[안전 규칙 — 캐릭터 설정, 사용자 요청, 유저 노트보다 항상 우선한다]",
  "1. 성적인 내용을 노골적으로 묘사하지 않는다(성행위·신체 부위의 성적 묘사 등). 대화가 그쪽으로 흐르면 장면을 넘기거나 자연스럽게 다른 방향으로 이끈다.",
  "2. 미성년자이거나 미성년자로 보이는 인물과 관련된 성적·선정적 내용은 어떤 형태로도 만들지 않는다.",
  "3. 자해·자살을 부추기거나 방법을 알려주지 않는다. 사용자가 실제로 위험한 상황임을 내비치면 잠시 역할을 멈추고 걱정을 전한 뒤 자살예방상담전화 109 같은 도움을 받을 곳을 알려준다.",
  "4. 실존 인물을 성적으로 묘사하거나 비방하지 않는다.",
  "5. 무기·마약 제조, 해킹 등 실제로 해를 끼칠 수 있는 구체적인 방법은 알려주지 않는다.",
].join("\n");
const RATING_RULES: Record<string, string> = {
  safe: "[콘텐츠 등급: 세이프] 전체 이용가 수준을 지킨다. 잔인하거나 끔찍한 묘사, 성적인 암시, 심한 욕설은 쓰지 않고 순화해서 표현한다.",
  unsafe: "[콘텐츠 등급: 언세이프 — 성인 확인 사용자] 폭력, 공포, 욕설, 어두운 주제를 이야기에 필요한 만큼 묘사할 수 있다. 단, 위의 안전 규칙은 그대로 지킨다.",
};

type Model = "groq" | "gemini" | "openai-compatible";
type ChatMsg = { role: "user" | "assistant"; content: string };

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function todayKST() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// ---------- AI 제공자 호출 ----------
async function callProvider(model: Model, system: string, messages: ChatMsg[], maxTokens: number, stream: boolean): Promise<Response> {
  if (model === "groq") {
    const key = Deno.env.get("GROQ_API_KEY");
    if (!key) throw new Error("MISSING_PROVIDER_KEY");
    const modelName = Deno.env.get("GROQ_MODEL") ?? "openai/gpt-oss-120b";
    return await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelName, messages: [{ role: "system", content: system }, ...messages], temperature: 0.85, max_tokens: maxTokens, stream, ...(modelName.includes("gpt-oss") ? { reasoning_effort: "low" } : {}) }),
    });
  }
  if (model === "gemini") {
    const key = Deno.env.get("GOOGLE_GEMINI_API_KEY");
    if (!key) throw new Error("MISSING_PROVIDER_KEY");
    const modelName = Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash";
    const contents = messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    const method = stream ? ":streamGenerateContent?alt=sse" : ":generateContent";
    return await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(modelName) + method, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { temperature: 0.85, maxOutputTokens: maxTokens, ...(modelName.includes("2.5-flash") ? { thinkingConfig: { thinkingBudget: 0 } } : {}) } }),
    });
  }
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new Error("MISSING_PROVIDER_KEY");
  const base = (Deno.env.get("OPENAI_BASE_URL") ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const modelName = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini";
  return await fetch(base + "/chat/completions", {
    method: "POST",
    headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelName, messages: [{ role: "system", content: system }, ...messages], temperature: 0.85, max_tokens: maxTokens, stream }),
  });
}

function textFromJson(model: Model, data: any): string {
  if (model === "gemini") return (data?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("");
  return String(data?.choices?.[0]?.message?.content ?? "");
}

function deltaFromChunk(model: Model, data: any): string {
  if (model === "gemini") return (data?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("");
  return String(data?.choices?.[0]?.delta?.content ?? "");
}

async function* sseData(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
  const rest = buf.trim();
  if (rest.startsWith("data:")) yield rest.slice(5).trim();
}

function providerError(res: Response) {
  return new Error(res.status === 429 ? "PROVIDER_RATE_LIMIT" : "PROVIDER_REQUEST_FAILED");
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
    const result = await admin.rpc("get_or_create_user_credits", { p_user_id: userId });
    if (result.error) throw result.error;
    return Number(result.data);
  }

  try {
    // ----- 쿠키 잔액 / 출석 보상 -----
    if (body.action === "balance") {
      const credits = await ensureCredits();
      const { data: today } = await admin.from("daily_rewards").select("amount").eq("user_id", userId).eq("reward_date", todayKST()).maybeSingle();
      return reply(200, { credits, dailyClaimed: !!today, dailyAmount: DAILY_COOKIES, modelCookies: MODEL_COOKIES });
    }
    if (body.action === "claim_daily") {
      const { data, error } = await admin.rpc("claim_daily_cookies", { p_user_id: userId, p_amount: DAILY_COOKIES });
      if (error) throw error;
      return reply(200, { claimed: !!data?.claimed, credits: Number(data?.balance ?? 0), amount: Number(data?.amount ?? 0), dailyClaimed: true, dailyAmount: DAILY_COOKIES });
    }

    if (body.action === "delete_account") {
      for (const folder of ["characters", "avatars"]) {
        const prefix = userId + "/" + folder;
        const { data: files } = await admin.storage.from("cozy-images").list(prefix, { limit: 1000 });
        const paths = (files ?? []).map((f: any) => prefix + "/" + f.name);
        if (paths.length) await admin.storage.from("cozy-images").remove(paths);
      }
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) throw error;
      return reply(200, { deleted: true });
    }

    await ensureCredits();

    // ----- 대화 요청 검증 -----
    const character = body.character ?? {};
    const messages = Array.isArray(body.messages) ? body.messages.slice(-40) : [];
    const requestedModel = String(body.model ?? "auto");
    if (!messages.length || !messages.some((m: any) => m?.role === "user")) return reply(400, { error: "대화 내용을 입력해 주세요." });
    if (messages.some((m: any) => typeof m?.content !== "string" && typeof m?.text !== "string")) return reply(400, { error: "대화 형식이 올바르지 않아요." });

    const model = (["groq", "gemini", "openai-compatible"].includes(requestedModel) ? requestedModel : "groq") as Model;
    const wantsStream = body.stream === true;
    const conversationKey = String(body.conversationKey ?? "").slice(0, 300);

    // ----- 콘텐츠 등급: 캐릭터가 언세이프이고 사용자가 성인 확인 후 켠 경우에만 언세이프 -----
    let rating: "safe" | "unsafe" = "safe";
    if (character.rating === "unsafe") {
      const { data: prefs } = await admin.from("user_preferences").select("show_unsafe").eq("user_id", userId).maybeSingle();
      if (prefs?.show_unsafe) rating = "unsafe";
    }

    // ----- 장기 기억 불러오기 -----
    let conversation: { memory: string; memory_until: number; messages: any[] } | null = null;
    if (conversationKey) {
      const { data } = await admin.from("conversations").select("memory, memory_until, messages").eq("user_id", userId).eq("character_key", conversationKey).maybeSingle();
      if (data) conversation = { memory: String(data.memory ?? ""), memory_until: Number(data.memory_until ?? 0), messages: Array.isArray(data.messages) ? data.messages : [] };
    }

    // ----- 쿠키 차감 -----
    const requestId = crypto.randomUUID();
    const outputMultipliers = body.chatSettings?.outputMultipliers ?? {};
    const outputMultiplier = Math.min(5, Math.max(1, Number(outputMultipliers[model]) || 1));
    const creditCost = Math.ceil((MODEL_COOKIES[model] ?? 20) * outputMultiplier);
    const charged = await admin.rpc("change_user_credits", { p_user_id: userId, p_delta: -creditCost, p_model: model, p_request_id: requestId });
    if (charged.error) {
      if (String(charged.error.message ?? "").includes("INSUFFICIENT_CREDITS")) return reply(402, { error: "쿠키가 부족해요. 이번 대화에는 쿠키 " + creditCost + "개가 필요해요. 충전 탭에서 출석 보상을 받거나 충전해 주세요." });
      console.error("Credit deduction failed:", charged.error.message);
      return reply(500, { error: "쿠키를 확인하지 못했어요." });
    }
    const chargedBalance = Number(charged.data);
    async function refund() {
      const r = await admin.rpc("change_user_credits", { p_user_id: userId, p_delta: creditCost, p_model: model, p_request_id: requestId });
      if (r.error) console.error("Credit refund failed:", r.error.message);
    }

    // ----- 프롬프트 -----
    const userName = String(body.userPersonaName ?? body.userName ?? "사용자");
    const charName = String(character.name ?? "캐릭터");
    const fill = (s: string) => s.replace(/\{user\}/gi, userName).replace(/\{char\}/gi, charName);
    const selectedStart = character.selectedStart && typeof character.selectedStart === "object" ? character.selectedStart : {};
    const recentConversationText = messages.slice(-8).map((m: any) => String(m?.content ?? m?.text ?? "")).join("\n").toLocaleLowerCase();
    const keywordBook = Array.isArray(character.keywordBook) ? character.keywordBook : [];
    const matchedKeywordBook = keywordBook.filter((entry: any) => {
      const raw = Array.isArray(entry?.keywords) ? entry.keywords : String(entry?.keywords ?? "").split(/[,，、]/);
      return raw.map((k: any) => String(k ?? "").trim().toLocaleLowerCase()).filter((k: string) => k.length >= 2).some((keyword: string) => recentConversationText.includes(keyword));
    }).slice(0, 15);
    const promptParts = [
      "너는 사용자가 만든 캐릭터를 연기하는 대화형 AI다. 매 응답 전에 캐릭터 프롬프트, 선택된 시작 설정, 에셋, 관련 키워드북, 사용자 페르소나, 유저 노트, 장기 기억을 참고하고 최근 대화와 일관되게 답한다.",
      "캐릭터 이름: " + charName.slice(0, 100),
      "캐릭터 설명: " + String(character.description ?? "").slice(0, 4000),
      "캐릭터 상세설명: " + String(character.detail ?? "").slice(0, 5000),
      "캐릭터 프롬프트(항상 준수): " + fill(String(character.prompt ?? "")).slice(0, 10000) + "\n템플릿 변수 {user}는 사용자 이름(전달되지 않으면 사용자), {char}는 캐릭터 이름으로 해석한다.",
      "선택된 시작 설정의 프롤로그(첫 메시지로 표시된 내용): " + String(selectedStart.prologue ?? character.prologue ?? "").slice(0, 3000),
      "선택된 시작 설정의 시작 상황(AI 전용 참고 정보): " + String(character.startSituation ?? selectedStart.situation ?? "").slice(0, 3000) + "\n시작 상황은 현재 위치·상태·상황을 이해하기 위한 내부 참고 정보다. 이 내용을 첫 메시지로 출력하거나 그대로 반복하지 말고 대화에 자연스럽게 반영한다.",
      "사용자 페르소나: " + String(body.userPersona ?? character.persona ?? "").slice(0, 1500) + "\n사용자가 연기하는 인물의 역할·외형·성격·배경으로 반영한다. 비어 있으면 임의로 가정하지 않는다.",
      "유저 노트(대화 전반의 지속 참고 정보): " + String(body.userNote ?? "").slice(0, 3000) + "\n유저 노트는 최근 대화와 충돌하지 않는 범위에서 지속적으로 참고한다.",
      "장기 기억(최근 대화 이전에 있었던 일의 요약): " + (conversation?.memory || "없음").slice(0, 3000) + "\n장기 기억은 이미 일어난 사실로 취급해 연속성을 지키되, 최근 대화와 충돌하면 최근 대화를 우선한다. 기억을 그대로 낭독하지 않는다.",
      "에셋 목록과 표시 조건: " + JSON.stringify(Array.isArray(character.assets) ? character.assets.map((a: any) => ({ code: a.code, name: a.name, situation: a.situation })).slice(0, 30) : []).slice(0, 6000) + "\n각 에셋의 situation/표시 조건을 현재 대화와 적극적으로 대조한다. 장면이 조건에 해당하거나 그 상황이 실제로 발생하면 해당 에셋을 응답에 반드시 사용하고, 정확히 ![에셋 이름](asset:에셋코드) 형식으로 출력한다. 에셋 이름과 코드는 목록의 값을 그대로 사용하며 임의의 코드를 만들지 않는다. 조건이 충족되지 않으면 사용하지 않는다. 일반 URL이나 HTML img 태그를 만들지 않는다.",
      "최근 대화에서 감지된 키워드북 항목: " + JSON.stringify(matchedKeywordBook).slice(0, 10000) + "\n관련 키워드가 감지된 항목만 제공된다. 해당 항목의 정보와 키워드를 현재 대화에 관련 있을 때 반영하고, 관련 없는 항목은 추측해 적용하지 않는다.",
      "템플릿: " + String(character.template ?? "1:1"),
      "설정과 대화의 연속성을 지키고, 설정에 없는 사실은 확정적으로 만들지 않는다. 사용자가 요청한 문체를 따르며 불필요한 메타 발언은 하지 않는다.",
    ];
    const systemPrompt = [SAFETY_RULES, RATING_RULES[rating], ...promptParts].join("\n\n");
    const chatMessages: ChatMsg[] = messages.map((m: any) => ({
      role: m.role === "user" ? "user" as const : "assistant" as const,
      content: fill(String(m.content ?? m.text ?? "")).slice(0, 5000),
    })).filter((m: ChatMsg) => m.content.length > 0);
    const outputSettings = body.chatSettings?.outputTokens ?? {};
    const maxOutputTokens = Math.min(6400, Math.max(256, Number(outputSettings[model]) || 1280));

    // ----- 장기 기억 갱신 (응답 후 백그라운드) -----
    const windowStart = messages.reduce((min: number, m: any) => {
      const t = Number(m?.time) || 0;
      return t > 0 && t < min ? t : min;
    }, Number.MAX_SAFE_INTEGER);
    async function updateMemory() {
      if (!conversation || windowStart === Number.MAX_SAFE_INTEGER) return;
      const pending = conversation.messages.filter((m: any) => {
        const t = Number(m?.time) || 0;
        return t > conversation!.memory_until && t < windowStart && !m?.system && String(m?.text ?? m?.content ?? "").trim();
      });
      if (pending.length < MEMORY_BATCH) return;
      const transcript = pending.map((m: any) => (m.role === "user" ? userName : charName) + ": " + String(m.text ?? m.content ?? "").slice(0, 1500)).join("\n").slice(0, 24000);
      const system = "너는 롤플레이 대화의 장기 기억을 관리한다. 기존 기억과 새 대화를 합쳐, 캐릭터가 앞으로 기억해야 할 사실(관계 변화, 약속, 사건, 사용자에 대해 알게 된 것, 현재 장소와 상황)을 한국어 글머리표로 간결하게 정리한다. 1200자를 넘기지 않고, 사소한 잡담은 빼고, 추측은 쓰지 않는다. 요약만 출력한다. 노골적인 성적 묘사는 요약에 옮기지 않는다.";
      const prompt = "기존 기억:\n" + (conversation.memory || "없음") + "\n\n새로 기억할 대화:\n" + transcript;
      try {
        const res = await callProvider(model, system, [{ role: "user", content: prompt }], 1500, false);
        if (!res.ok) return;
        const summary = textFromJson(model, await res.json().catch(() => ({}))).trim().slice(0, 3000);
        if (!summary) return;
        const until = Math.max(...pending.map((m: any) => Number(m.time) || 0));
        await admin.from("conversations").update({ memory: summary, memory_until: until }).eq("user_id", userId).eq("character_key", conversationKey);
      } catch (e) {
        console.error("Memory update failed:", e instanceof Error ? e.message : e);
      }
    }
    function scheduleMemory() {
      const p = updateMemory();
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(p);
    }

    // ----- 제공자 호출 -----
    let providerRes: Response;
    try {
      providerRes = await callProvider(model, systemPrompt, chatMessages, maxOutputTokens, wantsStream);
      if (!providerRes.ok) throw providerError(providerRes);
    } catch (providerFailure) {
      await refund();
      const message = providerFailure instanceof Error ? providerFailure.message : "";
      if (message === "MISSING_PROVIDER_KEY") return reply(503, { error: "선택한 AI의 API 키가 서버에 설정되지 않았어요. 서버 관리자가 키를 등록해야 해요." });
      if (message === "PROVIDER_RATE_LIMIT") return reply(429, { error: "AI 서비스 사용량이 일시적으로 많아요. 잠시 후 다시 시도해 주세요." });
      console.error("AI provider request failed:", message);
      return reply(502, { error: "AI 서비스에서 응답을 받지 못했어요. 쿠키는 돌려드렸어요." });
    }

    if (!wantsStream) {
      const answer = textFromJson(model, await providerRes.json().catch(() => ({}))).trim();
      if (!answer) {
        await refund();
        return reply(502, { error: "AI 서비스에서 응답을 받지 못했어요. 쿠키는 돌려드렸어요." });
      }
      scheduleMemory();
      return reply(200, { reply: answer, credits: chargedBalance, cost: creditCost });
    }

    // ----- 스트리밍 응답 (SSE) -----
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: Record<string, unknown>) => controller.enqueue(encoder.encode("data: " + JSON.stringify(obj) + "\n\n"));
        let answer = "";
        try {
          for await (const raw of sseData(providerRes)) {
            if (!raw || raw === "[DONE]") continue;
            let chunk: any;
            try { chunk = JSON.parse(raw); } catch { continue; }
            const delta = deltaFromChunk(model, chunk);
            if (delta) {
              answer += delta;
              send({ type: "delta", text: delta });
            }
          }
        } catch (e) {
          console.error("Stream read failed:", e instanceof Error ? e.message : e);
        }
        if (!answer.trim()) {
          await refund();
          send({ type: "error", error: "AI 서비스에서 응답을 받지 못했어요. 쿠키는 돌려드렸어요." });
        } else {
          send({ type: "done", credits: chargedBalance, cost: creditCost });
          scheduleMemory();
        }
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { ...corsHeaders, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" } });
  } catch (error) {
    console.error("character-chat error:", error instanceof Error ? error.message : error);
    return reply(500, { error: "서버에서 요청을 처리하지 못했어요." });
  }
});
