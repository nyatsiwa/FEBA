// api/payments/verify.js
// Called by frontend after Paystack subscription payment completes
// POST /api/payments/verify
// Body: { reference, plan, userId }

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // service_role key — bypasses RLS
);

const PLAN_AMOUNTS = { starter: 99, gold: 199, platinum: 349 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { reference, plan, userId } = req.body;

  if (!reference || !plan || !userId) {
    return res.status(400).json({ error: 'Missing reference, plan or userId' });
  }
  if (!PLAN_AMOUNTS[plan]) {
    return res.status(400).json({ error: 'Invalid plan' });
  }

  try {
    // ── 1. Verify with Paystack ──────────────────────
    const pgRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );
    const pgData = await pgRes.json();

    if (!pgData.status || pgData.data?.status !== 'success') {
      return res.status(402).json({ error: 'Payment not successful', detail: pgData.data?.status });
    }

    const amountZAR = pgData.data.amount / 100;

    // ── 2. Check not already processed ──────────────
    const { data: existing } = await supabase
      .from('payments')
      .select('id')
      .eq('gateway_ref', reference)
      .maybeSingle();

    if (existing) {
      return res.json({ success: true, alreadyProcessed: true });
    }

    // ── 3. Record payment ────────────────────────────
    await supabase.from('payments').insert({
      user_id:     userId,
      gateway_ref: reference,
      type:        'subscription',
      amount_zar:  amountZAR,
      status:      'success',
      plan,
      paid_at:     new Date().toISOString(),
      raw_response: pgData.data,
    });

    // ── 4. Activate subscription ─────────────────────
    const expires = new Date();
    expires.setMonth(expires.getMonth() + 1);

    await supabase.from('subscriptions').insert({
      user_id:    userId,
      plan,
      status:     'active',
      amount_zar: PLAN_AMOUNTS[plan],
      expires_at: expires.toISOString(),
    });

    // ── 5. Bonus coins for subscribers ───────────────
    const bonusCoins = plan === 'platinum' ? 500 : plan === 'gold' ? 200 : 50;
    await supabase.rpc('add_coins', {
      p_user_id: userId,
      p_amount:  bonusCoins,
      p_type:    'bonus',
      p_note:    `${plan} plan subscription bonus`,
    });

    console.log(`✅ Subscription: ${userId} — ${plan} — R${amountZAR}`);

    res.json({
      success:    true,
      plan,
      expiresAt:  expires.toISOString(),
      bonusCoins,
    });

  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
}
