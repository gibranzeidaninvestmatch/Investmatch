const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // clé SERVICE (pas anon) pour bypass RLS
);

// Désactive le bodyParser de Vercel pour lire le raw body (requis par Stripe)
export const config = { api: { bodyParser: false } };

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature invalide:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  try {
    switch (event.type) {

      // ── Paiement réussi → activer Premium ──
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata?.userId;
        if (!userId) break;

        const { error } = await sb.from('profiles')
          .update({
            is_premium: true,
            premium_plan: session.metadata?.plan,
            stripe_customer_id: session.customer,
            stripe_subscription_id: session.subscription,
            premium_since: new Date().toISOString(),
          })
          .eq('id', userId);

        if (error) console.error('Supabase update error:', error);
        else console.log(`✅ Premium activé pour userId: ${userId}`);
        break;
      }

      // ── Abonnement annulé / expiré → désactiver Premium ──
      case 'customer.subscription.deleted':
      case 'invoice.payment_failed': {
        const obj = event.data.object;
        const customerId = obj.customer;

        const { error } = await sb.from('profiles')
          .update({ is_premium: false, premium_plan: null })
          .eq('stripe_customer_id', customerId);

        if (error) console.error('Supabase revoke error:', error);
        else console.log(`⚠️ Premium révoqué pour customer: ${customerId}`);
        break;
      }

      // ── Renouvellement OK ──
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        if (invoice.billing_reason === 'subscription_cycle') {
          console.log(`🔄 Renouvellement OK pour customer: ${invoice.customer}`);
        }
        break;
      }

      default:
        console.log(`Event ignoré: ${event.type}`);
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }

  return res.status(200).json({ received: true });
};
