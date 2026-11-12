// 쿠키 결제 (토스페이먼츠). 결제를 열 때 배포한다 — docs/PAYMENTS.md 참고.
// 아직 배포하지 않은 상태로 두며, TOSS_SECRET_KEY 가 없으면 모든 요청을 거절한다.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "POST 요청만 지원해요." });

  const secretKey = Deno.env.get("TOSS_SECRET_KEY") ?? "";
  if (!secretKey) return reply(503, { error: "결제 기능은 준비 중이에요." });

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const authorization = req.headers.get("Authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) return reply(401, { error: "로그인해 주세요." });
  const authClient = createClient(url, anonKey, { auth: { persistSession: false } });
  const { data: authData } = await authClient.auth.getUser(token);
  if (!authData?.user) return reply(401, { error: "로그인 세션을 확인할 수 없어요." });
  const userId = authData.user.id;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  let body: Record<string, any>;
  try { body = await req.json(); } catch { return reply(400, { error: "요청 형식이 올바르지 않아요." }); }

  try {
    // 1) 주문 만들기: 가격은 반드시 DB의 상품 정보로 정한다 (브라우저가 보낸 금액은 믿지 않음)
    if (body.action === "create_order") {
      const { data: pkg } = await admin.from("cookie_packages").select("id,cookies,bonus,price_krw").eq("id", String(body.packageId ?? "")).eq("active", true).maybeSingle();
      if (!pkg) return reply(404, { error: "상품을 찾을 수 없어요." });
      const { data: order, error } = await admin.from("cookie_orders").insert({
        user_id: userId, package_id: pkg.id, cookies: pkg.cookies + pkg.bonus, amount_krw: pkg.price_krw, provider: "toss",
      }).select("id, amount_krw, cookies").single();
      if (error) throw error;
      return reply(200, { orderId: order.id, amount: order.amount_krw, orderName: "쿠키 " + order.cookies.toLocaleString() + "개", customerKey: userId });
    }

    // 2) 결제 승인: successUrl 로 돌아온 paymentKey · orderId · amount 를 검증한 뒤 토스에 승인 요청
    if (body.action === "confirm") {
      const orderId = String(body.orderId ?? "");
      const paymentKey = String(body.paymentKey ?? "");
      const amount = Number(body.amount);
      const { data: order } = await admin.from("cookie_orders").select("id,user_id,amount_krw,status").eq("id", orderId).maybeSingle();
      if (!order || order.user_id !== userId) return reply(404, { error: "주문을 찾을 수 없어요." });
      if (order.status === "paid") {
        const { data: c } = await admin.from("user_credits").select("balance").eq("user_id", userId).maybeSingle();
        return reply(200, { credits: c?.balance ?? 0, alreadyPaid: true });
      }
      if (order.status !== "pending" || order.amount_krw !== amount) return reply(400, { error: "결제 금액이 주문과 달라요." });

      const res = await fetch("https://api.tosspayments.com/v1/payments/confirm", {
        method: "POST",
        headers: { "Authorization": "Basic " + btoa(secretKey + ":"), "Content-Type": "application/json", "Idempotency-Key": orderId },
        body: JSON.stringify({ paymentKey, orderId, amount }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        await admin.from("cookie_orders").update({ status: "failed" }).eq("id", orderId).eq("status", "pending");
        return reply(400, { error: result?.message || "결제를 승인하지 못했어요." });
      }
      const { data: granted, error } = await admin.rpc("grant_purchased_cookies", { p_order_id: orderId, p_provider: "toss", p_payment_key: paymentKey });
      if (error) throw error;
      return reply(200, { credits: Number(granted?.balance ?? 0) });
    }

    return reply(400, { error: "알 수 없는 요청이에요." });
  } catch (e) {
    console.error("cookie-payments error:", e instanceof Error ? e.message : e);
    return reply(500, { error: "결제를 처리하지 못했어요. 결제가 됐는데 쿠키가 안 들어왔다면 문의해 주세요." });
  }
});
