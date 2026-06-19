// api/webhook/paystack.js
// Paystack calls this automatically on every payment event
// Set in Paystack Dashboard → Settings → Webhooks:
// URL: https://www.feba.co.za/api/webhook/paystack

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const COIN_PACKS = [
  { coins:50,  bonus:0    },{ coins:150, bonus:20   },
  { coins:350, bonus:80   },{ coins:750, bonus:200  },
  { coins:1500,bonus:500  },{ coins:3500,bonus:1500 },
];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // ── Verify Paystack signature ──────────────────────
  const hash = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(JSON.stringify(req.body))
    .digest('hex');

  if (hash !== req.headers['x-paystack-signature']) {
    console.warn('⚠️ Paystack signature mismatch');
    return res.status(401).end();
  }

  const event = req.body;
  console.log(`📨 Paystack webhook: ${event.event}`);

  try {
    if (event.event === 'charge.success') {
      const data      = event.data;
      const reference = data.reference;
      const email     = data.customer?.email;
      const amountZAR = data.amount / 100;
      const meta      = data.metadata?.custom_fields || [];

      const productField  = meta.find(f => f.variable_name === 'product')?.value || '';
      const isCoins       = productField === 'FEBA Coins';
      const plan          = meta.find(f => f.variable_name === 'plan')?.value?.toLowerCase();
      const packIdxField  = meta.find(f => f.variable_name === 'pack_idx')?.value;

      // Find user by email
      const { data: { users }, error: uErr } = await supabase.auth.admin.listUsers();
      const user = users?.find(u => u.email === email);
      if (!user) { console.warn(`User not found: ${email}`); return res.sendStatus(200); }

      const userId = user.id;

      // Check for duplicate
      const { data: dup } = await supabase
        .from('payments').select('id').eq('gateway_ref', reference).maybeSingle();
      if (dup) return res.sendStatus(200);

      if (isCoins && packIdxField !== undefined) {
        // ── Coin purchase ──────────────────────────
        const pack       = COIN_PACKS[parseInt(packIdxField)] || COIN_PACKS[1];
        const totalCoins = pack.coins + pack.bonus;

        await supabase.from('payments').insert({
          user_id: userId, gateway_ref: reference, type: 'coins',
          amount_zar: amountZAR, status: 'success',
          coins_added: totalCoins, paid_at: new Date().toISOString(),
        });

        await supabase.rpc('add_coins', {
          p_user_id: userId, p_amount: totalCoins,
          p_type: 'purchase', p_ref: reference,
          p_note: `Webhook: bought ${totalCoins} coins`,
        });

      } else if (plan) {
        // ── Subscription ───────────────────────────
        const PLAN_AMOUNTS = { starter:99, gold:199, platinum:349 };
        const expires = new Date();
        expires.setMonth(expires.getMonth() + 1);

        await supabase.from('payments').insert({
          user_id: userId, gateway_ref: reference, type: 'subscription',
          amount_zar: amountZAR, status: 'success',
          plan, paid_at: new Date().toISOString(),
        });

        await supabase.from('subscriptions').insert({
          user_id: userId, plan, status: 'active',
          amount_zar: PLAN_AMOUNTS[plan] || amountZAR,
          expires_at: expires.toISOString(),
        });
      }

      console.log(`✅ Webhook processed: ${reference} for ${email}`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(500);
  }
}
