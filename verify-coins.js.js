// api/coins/verify.js
// Called by frontend after coin purchase via Paystack
// POST /api/coins/verify
// Body: { reference, packIdx, userId }

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const COIN_PACKS = [
  { coins: 50,   bonus: 0,    priceZAR: 15  },
  { coins: 150,  bonus: 20,   priceZAR: 40  },
  { coins: 350,  bonus: 80,   priceZAR: 85  },
  { coins: 750,  bonus: 200,  priceZAR: 170 },
  { coins: 1500, bonus: 500,  priceZAR: 320 },
  { coins: 3500, bonus: 1500, priceZAR: 700 },
];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { reference, packIdx, userId } = req.body;

  if (!reference || packIdx === undefined || !userId) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const pack = COIN_PACKS[packIdx];
  if (!pack) return res.status(400).json({ error: 'Invalid pack' });

  try {
    // ── 1. Verify Paystack ───────────────────────────
    const pgRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );
    const pgData = await pgRes.json();

    if (!pgData.status || pgData.data?.status !== 'success') {
      return res.status(402).json({ error: 'Payment not successful' });
    }

    // ── 2. Prevent duplicate processing ─────────────
    const { data: existing } = await supabase
      .from('payments')
      .select('id')
      .eq('gateway_ref', reference)
      .maybeSingle();

    if (existing) return res.json({ success: true, alreadyProcessed: true });

    const totalCoins = pack.coins + pack.bonus;
    const amountZAR  = pgData.data.amount / 100;

    // ── 3. Record payment ────────────────────────────
    await supabase.from('payments').insert({
      user_id:     userId,
      gateway_ref: reference,
      type:        'coins',
      amount_zar:  amountZAR,
      status:      'success',
      coins_added: totalCoins,
      paid_at:     new Date().toISOString(),
      raw_response: pgData.data,
    });

    // ── 4. Credit coins ──────────────────────────────
    const { data: newBalance, error } = await supabase.rpc('add_coins', {
      p_user_id: userId,
      p_amount:  totalCoins,
      p_type:    'purchase',
      p_ref:     reference,
      p_note:    `Bought ${pack.coins} coins + ${pack.bonus} bonus`,
    });

    if (error) throw error;

    console.log(`✅ Coins: ${userId} — +${totalCoins} coins — R${amountZAR}`);

    res.json({ success: true, coinsAdded: totalCoins, newBalance });

  } catch (err) {
    console.error('Coin verify error:', err);
    res.status(500).json({ error: 'Failed to credit coins' });
  }
}
