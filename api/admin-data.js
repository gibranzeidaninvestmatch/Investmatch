const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.APP_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // ── Auth ──────────────────────────────────────────────────────────
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Non authentifié.' });

  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return res.status(503).json({ error: 'ADMIN_EMAIL non configuré.' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Vérifie le token et récupère l'email
  const { data: { user }, error: userError } = await sb.auth.getUser(token);
  if (userError || !user) return res.status(401).json({ error: 'Token invalide.' });
  if (user.email !== adminEmail) return res.status(403).json({ error: 'Accès refusé.' });

  // ── Données ───────────────────────────────────────────────────────
  try {
    // 1. Tous les profils
    const { data: profiles, error: profilesErr } = await sb
      .from('profiles')
      .select('id, name, user_type, location, is_premium, created_at')
      .order('created_at', { ascending: false });
    if (profilesErr) throw new Error('profiles: ' + profilesErr.message);

    // 2. Tous les matchs
    const { data: matches, error: matchesErr } = await sb
      .from('matches')
      .select('id, user1_id, user2_id, created_at')
      .order('created_at', { ascending: false });
    if (matchesErr) throw new Error('matches: ' + matchesErr.message);

    // 3. Tous les accords
    const { data: agreements, error: agreementsErr } = await sb
      .from('agreements')
      .select('id, match_id, entrepreneur_id, investor_id, type, terms, signed_at, entrepreneur_signed, investor_signed, created_at')
      .order('created_at', { ascending: false });
    if (agreementsErr) throw new Error('agreements: ' + agreementsErr.message);

    // 4. Emails depuis auth.users (un seul appel listUsers)
    const { data: { users: authUsers } } = await sb.auth.admin.listUsers({ perPage: 1000 });
    const emailMap = {};
    (authUsers || []).forEach(u => { emailMap[u.id] = u.email; });

    // 5. Enrichissement des profils
    const enrichedProfiles = (profiles || []).map(p => ({
      ...p,
      email: emailMap[p.id] || '—',
    }));

    // 6. Enrichissement des matchs (noms des parties)
    const allProfileIds = [...new Set((matches || []).flatMap(m => [m.user1_id, m.user2_id]))];
    const profileMap = {};
    (profiles || []).forEach(p => { profileMap[p.id] = p; });

    const enrichedMatches = (matches || []).map(m => {
      const agr = (agreements || []).find(a => a.match_id === m.id);
      return {
        ...m,
        name1: profileMap[m.user1_id]?.name || '—',
        type1: profileMap[m.user1_id]?.user_type || '—',
        name2: profileMap[m.user2_id]?.name || '—',
        type2: profileMap[m.user2_id]?.user_type || '—',
        agreementStatus: !agr
          ? 'none'
          : (agr.entrepreneur_signed && agr.investor_signed)
            ? 'signed'
            : 'pending',
      };
    });

    // 7. Enrichissement des accords
    const enrichedAgreements = (agreements || [])
      .filter(a => a.entrepreneur_signed && a.investor_signed) // seulement les signés
      .map(a => ({
        ...a,
        entrepreneurName: profileMap[a.entrepreneur_id]?.name || '—',
        investorName: profileMap[a.investor_id]?.name || '—',
        commissionAmount: computeCommission(a.terms?.amount),
        commissionStr: computeCommissionStr(a.terms?.amount),
      }));

    // 8. Stats globales
    const signed   = (agreements || []).filter(a => a.entrepreneur_signed && a.investor_signed);
    const pending  = (agreements || []).filter(a => !(a.entrepreneur_signed && a.investor_signed));
    const totalCommission = signed.reduce((acc, a) => acc + (computeCommission(a.terms?.amount) || 0), 0);

    return res.status(200).json({
      stats: {
        totalUsers:      (profiles || []).length,
        entrepreneurs:   (profiles || []).filter(p => p.user_type === 'entrepreneur').length,
        investors:       (profiles || []).filter(p => p.user_type === 'investisseur').length,
        premium:         (profiles || []).filter(p => p.is_premium).length,
        totalMatches:    (matches || []).length,
        signedAgreements:  signed.length,
        pendingAgreements: pending.length,
        totalCommission,
      },
      profiles: enrichedProfiles.slice(0, 50),
      matches:  enrichedMatches.slice(0, 50),
      agreements: enrichedAgreements,
      generatedAt: new Date().toISOString(),
    });

  } catch (err) {
    console.error('admin-data error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

function computeCommission(amountStr) {
  if (!amountStr) return null;
  const n = parseFloat(String(amountStr).replace(/[^0-9.]/g, ''));
  if (isNaN(n) || n <= 0) return null;
  const rate = n <= 500000 ? 0.03 : n <= 2000000 ? 0.02 : 0.01;
  return Math.round(n * rate * 100) / 100;
}

function computeCommissionStr(amountStr) {
  const c = computeCommission(amountStr);
  if (c === null) return null;
  return c.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
}
