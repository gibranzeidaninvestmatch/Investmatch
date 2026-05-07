const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

// CommonJS config (pas ESM) — requis par Vercel
module.exports.config = { api: { bodyParser: false } };

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

  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (err) {
    return res.status(400).json({ error: 'Impossible de lire le body.' });
  }

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

      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.payment_status !== 'paid') { console.warn('Session non payée, ignorée'); break; }
        const userId = session.metadata?.userId;
        const isValidUUID = str => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
        if (!userId || !isValidUUID(userId)) { console.warn('userId invalide dans metadata:', userId); break; }
        const { error } = await sb.from('profiles').update({
          is_premium: true,
          premium_plan: session.metadata?.plan,
          stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription,
          premium_since: new Date().toISOString(),
        }).eq('id', userId);
        if (error) { console.error('Supabase update error:', error); throw error; }
        else console.log('Premium activé pour:', userId);
        break;
      }

      case 'customer.subscription.deleted':
      case 'invoice.payment_failed': {
        const customerId = event.data.object.customer;
        const { error } = await sb.from('profiles')
          .update({ is_premium: false, premium_plan: null })
          .eq('stripe_customer_id', customerId);
        if (error) console.error('Supabase revoke error:', error);
        else console.log('Premium révoqué pour customer:', customerId);
        break;
      }

      case 'invoice.payment_succeeded':
        console.log('Renouvellement OK pour:', event.data.object.customer);
        break;

      default:
        console.log('Event ignoré:', event.type);
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }

  return res.status(200).json({ received: true });
};
