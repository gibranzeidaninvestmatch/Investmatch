const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const PLANS = {
  entrepreneur: process.env.PRICE_ENTREPRENEUR,
  investisseur: process.env.PRICE_INVESTISSEUR,
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: 'STRIPE_SECRET_KEY manquante.' });
  if (!process.env.APP_URL) return res.status(500).json({ error: 'APP_URL manquante.' });

  try {
    const { plan, userId, userEmail } = req.body;
    if (!plan || !userId || !userEmail) return res.status(400).json({ error: 'plan, userId et userEmail sont requis.' });

    const priceId = PLANS[plan];
    if (!priceId) return res.status(400).json({ error: 'Plan invalide. Utilisez entrepreneur ou investisseur.' });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: userEmail,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { userId, plan },
      success_url: `${process.env.APP_URL}?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL}?payment=cancelled`,
      locale: 'fr',
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('create-checkout error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
