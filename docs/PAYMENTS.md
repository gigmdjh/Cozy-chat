# 쿠키 결제 연결 안내

결제를 뺀 나머지는 모두 준비돼 있어요. 아래 순서대로 하면 결제가 열려요.

## 이미 준비된 것

| 항목 | 위치 |
|---|---|
| 충전 상품 (가격·쿠키 수) | DB `cookie_packages` 테이블. Table Editor에서 바꾸면 사이트에 바로 반영돼요 |
| 주문 기록 | DB `cookie_orders` 테이블 |
| 쿠키 지급 (중복 지급 방지) | DB 함수 `grant_purchased_cookies` |
| 결제 서버 코드 | `supabase/functions/cookie-payments/index.ts` (아직 배포 안 함) |
| 환불 규정 | 사이트 이용약관 제10조 |
| 결제 스위치 | `index.html`의 `window.COZY_PAYMENTS.enabled` (지금은 `false`) |

## 결제를 열 때 할 일

### 1. 사업 준비 (보호자와 함께)
1. 사업자 등록 (홈택스 또는 세무서). 미성년자면 법정대리인 동의가 필요해요.
2. 통신판매업 신고 (정부24 또는 구청).
3. 토스페이먼츠 가입 후 계약. 테스트 키(`test_ck_...`, `test_sk_...`)는 가입 직후 바로 받을 수 있어요.

### 2. 서버 설정
1. Supabase 대시보드 → Edge Functions → Secrets에 `TOSS_SECRET_KEY`를 넣어요. 처음에는 `test_sk_...`로 시작하세요.
   - 시크릿 키는 절대 `index.html`에 넣지 마세요.
2. `cookie-payments` 함수를 배포해요 (Claude에게 "cookie-payments 배포해 줘"라고 하면 돼요).

### 3. 사이트 설정 (`index.html`의 cozy-v3 스크립트 아래에 추가)

```html
<script src="https://js.tosspayments.com/v2/standard"></script>
<script>
window.COZY_PAYMENTS = { enabled: true, provider: 'toss' };
const TOSS_CLIENT_KEY = 'test_ck_...'; // 클라이언트 키는 공개돼도 괜찮아요

async function callPayments(payload) {
  const { data } = await supabaseClient.auth.getSession();
  const res = await fetch(SUPABASE_URL + '/functions/v1/cookie-payments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + data.session.access_token, apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify(payload)
  });
  const body = await res.json();
  if (!res.ok) throw Error(body.error);
  return body;
}

window.startCookiePurchase = async pkg => {
  const order = await callPayments({ action: 'create_order', packageId: pkg.id });
  const payment = TossPayments(TOSS_CLIENT_KEY).payment({ customerKey: order.customerKey });
  await payment.requestPayment({
    method: 'CARD',
    amount: { currency: 'KRW', value: order.amount },
    orderId: order.orderId,
    orderName: order.orderName,
    successUrl: location.origin + location.pathname + '?pay=success',
    failUrl: location.origin + location.pathname + '?pay=fail'
  });
};

// 결제창에서 돌아왔을 때 승인 처리
(async () => {
  const q = new URLSearchParams(location.search);
  if (q.get('pay') === 'success') {
    try {
      const r = await callPayments({ action: 'confirm', paymentKey: q.get('paymentKey'), orderId: q.get('orderId'), amount: Number(q.get('amount')) });
      updateCookieUI(r.credits);
      alert('충전이 완료됐어요!');
    } catch (e) { alert(e.message) }
    history.replaceState(null, '', location.pathname);
    setPage('cookies');
  } else if (q.get('pay') === 'fail') {
    alert('결제가 취소됐거나 실패했어요: ' + (q.get('message') || ''));
    history.replaceState(null, '', location.pathname);
  }
})();
</script>
```

### 4. 화면에 사업자 정보 표시
통신판매업자는 사이트 아래쪽에 상호, 대표자, 사업자등록번호, 통신판매업 신고번호, 주소, 연락처를 표시해야 해요. `index.html`의 `<footer>`에 넣어 주세요.

### 5. 약관 업데이트
이용약관 제10조의 "현재 서비스는 결제 기능을 제공하지 않습니다" 문단을 지우고 시행일을 바꾼 뒤, 7일 전에 공지하세요.

### 6. 테스트 후 실서비스 전환
테스트 키로 결제 → 쿠키 지급 → 같은 결제를 새로고침해도 한 번만 지급되는지 확인한 뒤, `live_` 키로 바꿔요.

## 환불 처리
토스페이먼츠 상점관리자에서 결제를 취소한 뒤, Supabase에서 해당 `cookie_orders` 행의 `status`를 `refunded`로 바꾸고 쿠키를 회수하세요. 자동 환불이 필요해지면 Claude에게 요청하세요.

> 결제를 열 때 토스페이먼츠 최신 문서(https://docs.tosspayments.com)를 한 번 더 확인하세요. API가 바뀌었을 수 있어요.
