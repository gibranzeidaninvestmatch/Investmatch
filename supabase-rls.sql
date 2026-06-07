-- ═══════════════════════════════════════════════════════════════════
-- InvestMatch — Row Level Security (RLS) complet
-- À exécuter dans Supabase > SQL Editor
-- ═══════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────
-- 1. TABLE : profiles
-- ─────────────────────────────────────────
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Tout utilisateur authentifié peut lire tous les profils (nécessaire pour le discover)
CREATE POLICY "profiles_select_authenticated"
  ON profiles FOR SELECT
  TO authenticated
  USING (true);

-- Chaque utilisateur ne peut modifier QUE son propre profil
CREATE POLICY "profiles_update_own"
  ON profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- Chaque utilisateur peut créer son propre profil (setup initial)
CREATE POLICY "profiles_insert_own"
  ON profiles FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = id);

-- Seul l'utilisateur (ou le service role via API) peut supprimer son profil
CREATE POLICY "profiles_delete_own"
  ON profiles FOR DELETE
  TO authenticated
  USING (auth.uid() = id);

-- ─────────────────────────────────────────
-- 2. TABLE : swipes
-- ─────────────────────────────────────────
ALTER TABLE swipes ENABLE ROW LEVEL SECURITY;

-- Un utilisateur ne voit que ses propres swipes
CREATE POLICY "swipes_select_own"
  ON swipes FOR SELECT
  TO authenticated
  USING (auth.uid() = swiper_id);

-- Un utilisateur ne peut créer que ses propres swipes
CREATE POLICY "swipes_insert_own"
  ON swipes FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = swiper_id);

-- Un utilisateur peut supprimer uniquement ses propres swipes
CREATE POLICY "swipes_delete_own"
  ON swipes FOR DELETE
  TO authenticated
  USING (auth.uid() = swiper_id);

-- ─────────────────────────────────────────
-- 3. TABLE : matches
-- ─────────────────────────────────────────
ALTER TABLE matches ENABLE ROW LEVEL SECURITY;

-- Un utilisateur ne voit que les matchs où il est impliqué
CREATE POLICY "matches_select_participant"
  ON matches FOR SELECT
  TO authenticated
  USING (auth.uid() = user1_id OR auth.uid() = user2_id);

-- Les matchs sont créés par des triggers/service role, pas directement par les clients
-- Si vous créez des matchs côté client, ajoutez :
-- CREATE POLICY "matches_insert_participant"
--   ON matches FOR INSERT
--   TO authenticated
--   WITH CHECK (auth.uid() = user1_id OR auth.uid() = user2_id);

-- ─────────────────────────────────────────
-- 4. TABLE : messages
-- ─────────────────────────────────────────
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Un utilisateur ne voit que les messages des matchs où il participe
CREATE POLICY "messages_select_participant"
  ON messages FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM matches m
      WHERE m.id = match_id
        AND (m.user1_id = auth.uid() OR m.user2_id = auth.uid())
    )
  );

-- Un utilisateur ne peut envoyer que ses propres messages
CREATE POLICY "messages_insert_own"
  ON messages FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = sender_id
    AND EXISTS (
      SELECT 1 FROM matches m
      WHERE m.id = match_id
        AND (m.user1_id = auth.uid() OR m.user2_id = auth.uid())
    )
  );

-- ─────────────────────────────────────────
-- 5. TABLE : agreements
-- ─────────────────────────────────────────
ALTER TABLE agreements ENABLE ROW LEVEL SECURITY;

-- Un utilisateur ne voit que les accords où il est partie
CREATE POLICY "agreements_select_participant"
  ON agreements FOR SELECT
  TO authenticated
  USING (auth.uid() = entrepreneur_id OR auth.uid() = investor_id);

-- Un utilisateur peut créer un accord uniquement s'il est l'une des parties
CREATE POLICY "agreements_insert_participant"
  ON agreements FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = entrepreneur_id OR auth.uid() = investor_id);

-- Un utilisateur peut mettre à jour un accord uniquement s'il est l'une des parties
-- (pour signer, par exemple)
CREATE POLICY "agreements_update_participant"
  ON agreements FOR UPDATE
  TO authenticated
  USING (auth.uid() = entrepreneur_id OR auth.uid() = investor_id)
  WITH CHECK (auth.uid() = entrepreneur_id OR auth.uid() = investor_id);

-- ─────────────────────────────────────────
-- NOTES
-- ─────────────────────────────────────────
-- • Les fonctions serverless (api/*.js) utilisent SUPABASE_SERVICE_KEY
--   qui bypasse le RLS — elles ont accès total par conception.
-- • Le client frontend utilise SUPABASE_ANON_KEY et est donc soumis au RLS.
-- • Vérifiez que vos tables ont bien une colonne "id" référençant auth.users(id)
--   pour profiles, et les colonnes *_id pour les autres tables.
-- • Si une policy échoue lors de la création (déjà existante), supprimez-la d'abord :
--   DROP POLICY IF EXISTS "nom_de_la_policy" ON nom_table;
