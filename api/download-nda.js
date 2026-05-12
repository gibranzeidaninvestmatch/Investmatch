const { createClient } = require('@supabase/supabase-js');
const PDFDocument = require('pdfkit');
const crypto = require('crypto');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.APP_URL || '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { matchId } = req.query;
  if (!matchId) return res.status(400).json({ error: 'matchId requis.' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    // Récupère l'accord le plus récent pour ce match
    const { data: agreement, error: agrError } = await sb.from('agreements')
      .select('*')
      .eq('match_id', matchId)
      .order('signed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (agrError) return res.status(500).json({ error: 'Erreur base de données.' });
    if (!agreement) return res.status(404).json({ error: 'Aucun accord trouvé pour ce match.' });

    // Récupère les profils
    const { data: profiles } = await sb.from('profiles')
      .select('id, name, user_type, sector, amount, ticket_min, ticket_max, stage')
      .in('id', [agreement.entrepreneur_id, agreement.investor_id]);

    const entrepreneur = profiles?.find(p => p.id === agreement.entrepreneur_id);
    const investor = profiles?.find(p => p.id === agreement.investor_id);
    if (!entrepreneur || !investor) return res.status(404).json({ error: 'Profils introuvables.' });

    // Récupère les emails depuis auth.users
    const [{ data: authUser1 }, { data: authUser2 }] = await Promise.all([
      sb.auth.admin.getUserById(agreement.entrepreneur_id),
      sb.auth.admin.getUserById(agreement.investor_id),
    ]);
    entrepreneur.email = authUser1?.user?.email || 'confidentiel';
    investor.email = authUser2?.user?.email || 'confidentiel';

    const dateStr = new Date(agreement.signed_at).toLocaleDateString('fr-FR', {
      day: '2-digit', month: 'long', year: 'numeric'
    });
    const terms = agreement.terms || {};

    const ndaText = buildNDAText({ entrepreneur, investor, dateStr, agreementId: agreement.id, type: agreement.type, terms });
    const pdfBuffer = await generatePDF({ ndaText, agreementId: agreement.id, hash: agreement.agreement_hash, dateStr, type: agreement.type });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="NCNDA_InvestMatch_${agreement.id.slice(0,8)}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    return res.send(pdfBuffer);

  } catch (err) {
    console.error('download-nda error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────
function buildNDAText({ entrepreneur, investor, dateStr, agreementId, type, terms }) {
  const commission = computeCommission(terms.amount);
  const isFullNCNDA = type === 'ncnda';

  return `
ACCORD DE CONFIDENTIALITÉ ET DE NON-CONTOURNEMENT
${isFullNCNDA ? 'ACCORD DE PARTENARIAT — NCNDA COMPLET' : 'NDA AUTOMATIQUE — MISE EN RELATION INVESTMATCH'}

Référence : ${agreementId}
Date : ${dateStr}

ENTRE LES SOUSSIGNÉS :

Partie A (Entrepreneur) :
  Nom : ${entrepreneur.name}
  Email : ${entrepreneur.email}
  Secteur : ${entrepreneur.sector || 'Non précisé'}
  Montant recherché : ${entrepreneur.amount || 'Non précisé'}
  Stade : ${entrepreneur.stage || 'Non précisé'}

Partie B (Investisseur) :
  Nom : ${investor.name}
  Email : ${investor.email}
  Ticket d'investissement : ${investor.ticket_min || '—'} – ${investor.ticket_max || '—'}

Plateforme d'intermédiation :
  InvestMatch (ci-après "la Plateforme")
  Représentée par Gibran ZEIDAN

IL A ÉTÉ CONVENU CE QUI SUIT :

───────────────────────────────────────────────
ARTICLE 1 — OBJET
───────────────────────────────────────────────
Le présent accord régit les conditions de confidentialité et de non-contournement entre les Parties A et B, mises en relation par la Plateforme InvestMatch à la date indiquée ci-dessus.

───────────────────────────────────────────────
ARTICLE 2 — CONFIDENTIALITÉ
───────────────────────────────────────────────
Chaque partie s'engage à maintenir strictement confidentielle toute information reçue de l'autre partie dans le cadre de cette mise en relation, incluant mais sans s'y limiter : informations financières, stratégiques, commerciales, techniques ou personnelles.

Cette obligation de confidentialité s'étend à toute information échangée via la messagerie InvestMatch ou tout autre canal de communication consécutif à cette mise en relation.

Durée : 5 (cinq) ans à compter de la date de signature du présent accord.

───────────────────────────────────────────────
ARTICLE 3 — NON-CONTOURNEMENT (PROTECTION INVESTMATCH)
───────────────────────────────────────────────
3.1 Les Parties A et B reconnaissent expressément qu'InvestMatch est l'unique et exclusive source de leur mise en relation.

3.2 Les parties s'engagent à ne pas contourner, éviter ou tenter d'éviter la Plateforme InvestMatch dans le cadre de toute transaction, accord, investissement ou collaboration découlant directement ou indirectement de cette mise en relation.

3.3 Est considéré comme un acte de contournement :
  - L'échange de coordonnées personnelles suivi d'une transaction sans déclaration à InvestMatch
  - Toute transaction réalisée via un tiers interposé visant à exclure InvestMatch
  - Tout accord verbal ou écrit conclu hors plateforme sans notification à InvestMatch
  - Toute tentative de finaliser une transaction en contournant la commission due

3.4 Cette clause de non-contournement s'applique pendant une durée de 5 (cinq) ans à compter de la date du match initial.

───────────────────────────────────────────────
ARTICLE 4 — COMMISSION INVESTMATCH
───────────────────────────────────────────────
4.1 En contrepartie de la mise en relation effectuée par InvestMatch, les parties reconnaissent qu'une commission est due à la Plateforme sur tout montant investi dans le cadre ou à la suite de cette mise en relation.

4.2 Barème de commission :
  - De 0 à 500 000 € investis : 3% du montant total
  - De 500 001 € à 2 000 000 € investis : 2% du montant total
  - Au-delà de 2 000 001 € investis : 1% du montant total
${isFullNCNDA && terms.amount ? `\n4.3 Montant convenu dans le présent accord : ${terms.amount}\n  Commission estimée applicable : ${commission}` : ''}

4.4 La commission est due dans les 30 (trente) jours suivant la conclusion de tout accord de financement.

───────────────────────────────────────────────
ARTICLE 5 — CLAUSE PÉNALE
───────────────────────────────────────────────
5.1 En cas de violation du présent accord, notamment en cas de contournement de la Plateforme ou de non-paiement de la commission, la partie défaillante s'engage à payer à InvestMatch :
  - Le montant intégral de la commission due, calculé sur le montant total de la transaction
  - Une pénalité forfaitaire de 15 000 € (quinze mille euros) à titre de dommages et intérêts
  - Le remboursement de tous les frais de procédure engagés par InvestMatch pour faire valoir ses droits

5.2 Ces montants sont cumulatifs et ne constituent pas un plafond aux droits d'InvestMatch.

───────────────────────────────────────────────
ARTICLE 6 — DROIT APPLICABLE ET JURIDICTION
───────────────────────────────────────────────
Le présent accord est soumis au droit français. Tout litige sera porté devant les Tribunaux compétents de Paris, auxquels les parties attribuent compétence exclusive.
${isFullNCNDA && terms.conditions ? `\n───────────────────────────────────────────────\nARTICLE 7 — TERMES DE L'ACCORD DE PARTENARIAT\n───────────────────────────────────────────────\nMontant convenu : ${terms.amount || 'À préciser'}\nConditions particulières : ${terms.conditions}` : ''}

───────────────────────────────────────────────
SIGNATURES ÉLECTRONIQUES
───────────────────────────────────────────────
En accédant à la messagerie InvestMatch suite à ce match, les deux parties reconnaissent avoir pris connaissance du présent accord et l'accepter dans son intégralité.

Partie A (${entrepreneur.name}) — Accepté électroniquement le ${dateStr}
Partie B (${investor.name}) — Accepté électroniquement le ${dateStr}
InvestMatch — Gibran ZEIDAN — ${dateStr}

───────────────────────────────────────────────
EMPREINTE CRYPTOGRAPHIQUE
───────────────────────────────────────────────
Ce document est certifié par une empreinte SHA-256 unique garantissant son intégrité.
Toute modification ultérieure de ce document invalide cette certification.
  `.trim();
}

function computeCommission(amountStr) {
  if (!amountStr) return 'À calculer selon le montant final';
  const n = parseFloat(String(amountStr).replace(/[^0-9.]/g, ''));
  if (isNaN(n)) return 'À calculer selon le montant final';
  const rate = n <= 500000 ? 0.03 : n <= 2000000 ? 0.02 : 0.01;
  return `${(n * rate).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })} (${rate * 100}%)`;
}

function generatePDF({ ndaText, agreementId, hash, dateStr, type }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 60, size: 'A4' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fillColor('#0B1628').rect(0, 0, doc.page.width, 80).fill();
    doc.fillColor('#C9A84C').fontSize(22).font('Helvetica-Bold').text('InvestMatch', 60, 25);
    doc.fillColor('#FFFFFF').fontSize(10).font('Helvetica')
       .text(type === 'ncnda' ? 'Accord de Partenariat — NCNDA Complet' : 'Accord de Confidentialité & Non-Contournement', 60, 52);

    doc.moveDown(3);
    doc.fillColor('#8A9BB5').fontSize(9).font('Helvetica').text(`Référence : ${agreementId}`, { align: 'right' });
    doc.fillColor('#8A9BB5').fontSize(9).text(`Date : ${dateStr}`, { align: 'right' });
    doc.moveDown(1);
    doc.moveTo(60, doc.y).lineTo(535, doc.y).strokeColor('#C9A84C').lineWidth(1).stroke();
    doc.moveDown(1);

    ndaText.split('\n').forEach(line => {
      const t = line.trim();
      if (t.startsWith('ARTICLE') || t.startsWith('ENTRE') || t.startsWith('SIGNATURES') || t.startsWith('EMPREINTE')) {
        doc.moveDown(0.5);
        doc.fillColor('#0B1628').fontSize(10).font('Helvetica-Bold').text(t);
        doc.moveDown(0.3);
      } else if (t.startsWith('──')) {
        doc.moveDown(0.2);
        doc.moveTo(60, doc.y).lineTo(535, doc.y).strokeColor('#E0E0E0').lineWidth(0.5).stroke();
        doc.moveDown(0.2);
      } else if (t === '') {
        doc.moveDown(0.3);
      } else {
        doc.fillColor('#333333').fontSize(9).font('Helvetica').text(t, { lineGap: 2 });
      }
    });

    doc.moveDown(2);
    doc.moveTo(60, doc.y).lineTo(535, doc.y).strokeColor('#C9A84C').lineWidth(1).stroke();
    doc.moveDown(0.5);
    doc.fillColor('#8A9BB5').fontSize(7).font('Helvetica').text(`Empreinte SHA-256 : ${hash}`, { align: 'center' });
    doc.fontSize(7).text('Document généré par InvestMatch — investmatch.app — Valeur juridique : droit français', { align: 'center' });

    doc.end();
  });
}
