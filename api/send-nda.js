const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const PDFDocument = require('pdfkit');
const crypto = require('crypto');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.APP_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const resend = new Resend(process.env.RESEND_API_KEY);

  const isValidUUID = str => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

  try {
    const { matchId, entrepreneurId, investorId, type = 'nda', terms = {} } = req.body;
    if (!matchId || !entrepreneurId || !investorId) {
      return res.status(400).json({ error: 'matchId, entrepreneurId et investorId requis.' });
    }
    if (!isValidUUID(matchId) || !isValidUUID(entrepreneurId) || !isValidUUID(investorId)) {
      return res.status(400).json({ error: 'IDs invalides.' });
    }
    if (!['nda', 'ncnda'].includes(type)) {
      return res.status(400).json({ error: 'type invalide.' });
    }

    // Récupère les profils (sans email — stocké dans auth.users)
    const { data: profiles, error: profileError } = await sb.from('profiles')
      .select('id, name, user_type, sector, amount, ticket_min, ticket_max, stage')
      .in('id', [entrepreneurId, investorId]);

    if (profileError) { console.error('Supabase profiles error:', profileError); return res.status(500).json({ error: 'Erreur base de données : ' + profileError.message }); }
    const entrepreneur = profiles?.find(p => p.id === entrepreneurId);
    const investor = profiles?.find(p => p.id === investorId);
    if (!entrepreneur || !investor) return res.status(404).json({ error: 'Profils introuvables.' });

    // Récupère les emails depuis auth.users (source officielle)
    const [{ data: authUser1 }, { data: authUser2 }] = await Promise.all([
      sb.auth.admin.getUserById(entrepreneurId),
      sb.auth.admin.getUserById(investorId),
    ]);
    entrepreneur.email = authUser1?.user?.email;
    investor.email = authUser2?.user?.email;
    if (!entrepreneur.email || !investor.email) {
      return res.status(400).json({ error: 'Emails des utilisateurs introuvables.' });
    }

    const now = new Date();
    const dateStr = now.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
    const agreementId = crypto.randomUUID();

    // ── Génère le texte du contrat ──
    const ndaText = buildNDAText({ entrepreneur, investor, dateStr, agreementId, type, terms });

    // ── Hash SHA-256 du contrat ──
    const hash = crypto.createHash('sha256').update(ndaText).digest('hex');

    // ── Génère le PDF ──
    const pdfBuffer = await generatePDF({ ndaText, agreementId, hash, dateStr, type });

    // ── Stocke dans Supabase (SELECT + INSERT pour éviter doublons sans contrainte unique) ──
    const { data: existing } = await sb.from('agreements')
      .select('id').eq('match_id', matchId).eq('type', type).maybeSingle();
    if (!existing) {
      const { error: insertError } = await sb.from('agreements').insert({
        id: agreementId,
        match_id: matchId,
        entrepreneur_id: entrepreneurId,
        investor_id: investorId,
        type,
        terms,
        agreement_hash: hash,
        signed_at: now.toISOString(),
      });
      if (insertError) {
        console.error('Supabase insert error:', insertError);
        return res.status(500).json({ error: 'Erreur lors de la sauvegarde de l\'accord.' });
      }
    }

    // ── Email à l'entrepreneur ──
    await resend.emails.send({
      from: 'InvestMatch <onboarding@resend.dev>',
      to: entrepreneur.email,
      subject: type === 'nda'
        ? `Accord de confidentialité — Match avec ${investor.name}`
        : `Accord de partenariat scellé — ${investor.name}`,
      html: buildEmailHTML({ recipient: entrepreneur, other: investor, agreementId, hash, dateStr, type }),
      attachments: [{ filename: `NCNDA_InvestMatch_${agreementId.slice(0,8)}.pdf`, content: pdfBuffer.toString('base64') }],
    });

    // ── Email à l'investisseur ──
    await resend.emails.send({
      from: 'InvestMatch <onboarding@resend.dev>',
      to: investor.email,
      subject: type === 'nda'
        ? `Accord de confidentialité — Match avec ${entrepreneur.name}`
        : `Accord de partenariat scellé — ${entrepreneur.name}`,
      html: buildEmailHTML({ recipient: investor, other: entrepreneur, agreementId, hash, dateStr, type }),
      attachments: [{ filename: `NCNDA_InvestMatch_${agreementId.slice(0,8)}.pdf`, content: pdfBuffer.toString('base64') }],
    });

    return res.status(200).json({ agreementId, hash });

  } catch (err) {
    console.error('send-nda error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────
// Texte du contrat
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
  const n = parseFloat(amountStr.replace(/[^0-9.]/g, ''));
  if (isNaN(n)) return 'À calculer selon le montant final';
  let rate = n <= 500000 ? 0.03 : n <= 2000000 ? 0.02 : 0.01;
  return `${(n * rate).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })} (${rate * 100}%)`;
}

// ─────────────────────────────────────────────
// Génération PDF
// ─────────────────────────────────────────────
function generatePDF({ ndaText, agreementId, hash, dateStr, type }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 60, size: 'A4' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // En-tête
    doc.fillColor('#0B1628').rect(0, 0, doc.page.width, 80).fill();
    doc.fillColor('#C9A84C').fontSize(22).font('Helvetica-Bold')
       .text('InvestMatch', 60, 25);
    doc.fillColor('#FFFFFF').fontSize(10).font('Helvetica')
       .text(type === 'ncnda' ? 'Accord de Partenariat — NCNDA Complet' : 'Accord de Confidentialité & Non-Contournement', 60, 52);

    doc.moveDown(3);

    // Référence
    doc.fillColor('#8A9BB5').fontSize(9).font('Helvetica')
       .text(`Référence : ${agreementId}`, { align: 'right' });
    doc.fillColor('#8A9BB5').fontSize(9)
       .text(`Date : ${dateStr}`, { align: 'right' });

    doc.moveDown(1);
    doc.moveTo(60, doc.y).lineTo(535, doc.y).strokeColor('#C9A84C').lineWidth(1).stroke();
    doc.moveDown(1);

    // Corps du contrat
    const lines = ndaText.split('\n');
    lines.forEach(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('ARTICLE') || trimmed.startsWith('ENTRE') || trimmed.startsWith('SIGNATURES') || trimmed.startsWith('EMPREINTE')) {
        doc.moveDown(0.5);
        doc.fillColor('#0B1628').fontSize(10).font('Helvetica-Bold').text(trimmed);
        doc.moveDown(0.3);
      } else if (trimmed.startsWith('──')) {
        doc.moveDown(0.2);
        doc.moveTo(60, doc.y).lineTo(535, doc.y).strokeColor('#E0E0E0').lineWidth(0.5).stroke();
        doc.moveDown(0.2);
      } else if (trimmed === '') {
        doc.moveDown(0.3);
      } else {
        doc.fillColor('#333333').fontSize(9).font('Helvetica').text(trimmed, { lineGap: 2 });
      }
    });

    // Pied de page avec hash
    doc.moveDown(2);
    doc.moveTo(60, doc.y).lineTo(535, doc.y).strokeColor('#C9A84C').lineWidth(1).stroke();
    doc.moveDown(0.5);
    doc.fillColor('#8A9BB5').fontSize(7).font('Helvetica')
       .text(`Empreinte SHA-256 : ${hash}`, { align: 'center' });
    doc.fontSize(7).text('Document généré par InvestMatch — investmatch.app — Valeur juridique : droit français', { align: 'center' });

    doc.end();
  });
}

// ─────────────────────────────────────────────
// Email HTML
// ─────────────────────────────────────────────
function buildEmailHTML({ recipient, other, agreementId, hash, dateStr, type }) {
  const title = type === 'ncnda' ? 'Accord de partenariat scellé' : 'Accord de confidentialité activé';
  const intro = type === 'ncnda'
    ? `Votre accord de partenariat avec <strong>${other.name}</strong> a été scellé sur InvestMatch.`
    : `Suite à votre match avec <strong>${other.name}</strong>, un accord de confidentialité et de non-contournement est automatiquement entré en vigueur.`;

  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:'DM Sans',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:40px 20px;">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <tr><td style="background:#0B1628;padding:32px 40px;">
          <span style="font-size:24px;font-weight:700;color:#ffffff;">Invest<span style="color:#C9A84C">Match</span></span>
        </td></tr>
        <tr><td style="padding:40px;">
          <h2 style="color:#0B1628;margin:0 0 16px;">✦ ${title}</h2>
          <p style="color:#555;line-height:1.6;">${intro}</p>

          <div style="background:#f8f9fc;border-left:4px solid #C9A84C;padding:16px 20px;border-radius:4px;margin:24px 0;">
            <p style="margin:0;color:#0B1628;font-weight:600;">Détails de l'accord</p>
            <p style="margin:8px 0 0;color:#666;font-size:14px;">
              Référence : <code style="background:#eee;padding:2px 6px;border-radius:3px;">${agreementId}</code><br/>
              Date : ${dateStr}<br/>
              Parties : ${recipient.name} & ${other.name}
            </p>
          </div>

          <p style="color:#555;line-height:1.6;font-size:14px;">
            <strong>Ce que vous devez savoir :</strong><br/>
            • Toutes les informations échangées sont confidentielles pendant <strong>5 ans</strong><br/>
            • Toute transaction conclue avec ${other.name}, même hors plateforme, est soumise à la commission InvestMatch<br/>
            • En cas de contournement, une pénalité de <strong>15 000 €</strong> + commission est applicable<br/>
            • Le document PDF complet est joint à cet email
          </p>

          <div style="background:#fff8e7;border:1px solid #C9A84C;padding:12px 16px;border-radius:6px;margin:24px 0;">
            <p style="margin:0;font-size:12px;color:#888;">
              Empreinte SHA-256 :<br/>
              <code style="font-size:10px;word-break:break-all;">${hash}</code>
            </p>
          </div>

          <p style="color:#888;font-size:12px;margin-top:32px;">
            InvestMatch — Plateforme de mise en relation entrepreneurs/investisseurs<br/>
            Droit applicable : droit français — Juridiction : Tribunaux de Paris
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();
}
