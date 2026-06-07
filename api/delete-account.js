const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.APP_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });

  // ── Auth ──────────────────────────────────────────────────────────
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Non authentifié.' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Vérifie le token
  const { data: { user }, error: userError } = await sb.auth.getUser(token);
  if (userError || !user) return res.status(401).json({ error: 'Token invalide.' });

  const userId = user.id;

  try {
    // 1. Supprime les messages liés aux matchs de l'utilisateur
    const { data: userMatches } = await sb
      .from('matches')
      .select('id')
      .or(`user1_id.eq.${userId},user2_id.eq.${userId}`);

    if (userMatches && userMatches.length > 0) {
      const matchIds = userMatches.map(m => m.id);
      await sb.from('messages').delete().in('match_id', matchIds);
      await sb.from('agreements').delete().in('match_id', matchIds);
    }

    // 2. Supprime les swipes
    await sb.from('swipes').delete().or(`swiper_id.eq.${userId},swiped_id.eq.${userId}`);

    // 3. Supprime les matchs
    await sb.from('matches').delete().or(`user1_id.eq.${userId},user2_id.eq.${userId}`);

    // 4. Supprime le profil
    await sb.from('profiles').delete().eq('id', userId);

    // 5. Supprime l'utilisateur Auth (droit à l'effacement RGPD)
    const { error: deleteError } = await sb.auth.admin.deleteUser(userId);
    if (deleteError) throw new Error('Erreur suppression auth : ' + deleteError.message);

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('delete-account error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
